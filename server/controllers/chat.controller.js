const mongoose = require("mongoose");
const ChatMessage = require("../models/ChatMessage");
const chatService = require("../services/chat.service");
const r2Service = require("../services/r2.service");
const { sniffImageMime } = require("../middlewares/chatUpload");
const asyncHandler = require("../utils/asyncHandler");
const { AppError } = require("../middlewares/errorHandler");
const logger = require("../utils/logger");

/* =========================================================================
   OTORISASI
   Satu pintu masuk untuk sisi pelanggan: token chat yang ditandatangani
   server. Tidak ada endpoint pelanggan yang menerima conversationId dari body
   atau query — kalau ada, siapa pun bisa mengetik ObjectId orang lain dan
   membaca percakapannya. conversationId SELALU diambil dari isi token.
   ========================================================================= */
async function requireChatSession(req) {
  const header = req.headers["x-chat-token"] || "";
  const token = Array.isArray(header) ? header[0] : String(header || "").trim();
  const claims = chatService.verifyChatToken(token);
  if (!claims) throw new AppError("Sesi chat tidak valid. Mulai percakapan baru.", 401);

  const conversation = await chatService.getConversationById(claims.conversationId);
  // Sesi yang percakapannya sudah kedaluwarsa (TTL 24 jam) diperlakukan sama
  // seperti sesi yang tidak pernah ada.
  if (!conversation || conversation.sessionId !== claims.sessionId) {
    throw new AppError("Sesi chat sudah berakhir. Mulai percakapan baru.", 401);
  }
  return conversation;
}

/* =========================================================================
   ANTI-SPAM
   Rate limit HTTP membatasi per IP; ini membatasi per percakapan, supaya satu
   sesi tidak bisa membanjiri Admin Web (dan DM Discord) dari banyak IP.
   ========================================================================= */
const BURST_WINDOW_MS = 60 * 1000;
const BURST_LIMIT = 20;

async function assertNotFlooding(conversationId) {
  const since = new Date(Date.now() - BURST_WINDOW_MS);
  const recent = await ChatMessage.countDocuments({
    conversationId,
    sender: "customer",
    createdAt: { $gte: since },
  });
  if (recent >= BURST_LIMIT) {
    throw new AppError("Terlalu banyak pesan dalam satu menit. Tunggu sebentar sebelum mengirim lagi.", 429);
  }
}

/* =========================================================================
   MARKETPLACE (pelanggan)
   ========================================================================= */

// Membuka sesi chat. Ini yang menggantikan "anonymous random ID": ID sesi
// dibuat dan ditandatangani server, bukan dikarang browser.
const startSession = asyncHandler(async (req, res) => {
  const { name, email, whatsapp, startedFrom } = req.body || {};
  const conversation = await chatService.createConversation({ name, email, whatsapp, startedFrom });

  res.status(201).json({
    status: true,
    data: {
      token: chatService.issueChatToken(conversation),
      conversation: chatService.toPublicConversation(conversation),
      messages: [],
    },
  });
});

// Memuat ulang thread. Dipanggil saat panel dibuka dan setelah reconnect,
// sehingga pesan yang terlewat selagi socket putus tetap muncul — database,
// bukan Socket.IO, yang menentukan isi percakapan.
const getSession = asyncHandler(async (req, res) => {
  const conversation = await requireChatSession(req);
  const messages = await chatService.listMessages(conversation._id);

  res.json({
    status: true,
    data: {
      conversation: chatService.toPublicConversation(conversation),
      messages: messages.map((m) => chatService.toPublicMessage(m)),
    },
  });
});

const sendMessage = asyncHandler(async (req, res) => {
  const conversation = await requireChatSession(req);
  await assertNotFlooding(conversation._id);

  const { text, clientMessageId } = req.body || {};
  const { message, duplicate } = await chatService.appendMessage({
    conversation,
    sender: "customer",
    text,
    clientMessageId,
    senderName: conversation.displayName,
  });

  // Simpan -> realtime (di dalam appendMessage) -> baru Discord. Kalau DM
  // gagal, pesan ini tetap tersimpan dan tetap sampai ke Admin Web.
  if (!duplicate) chatService.queueDiscordNotification(message._id);

  res.status(duplicate ? 200 : 201).json({ status: true, data: chatService.toPublicMessage(message) });
});

const uploadPhoto = asyncHandler(async (req, res) => {
  const conversation = await requireChatSession(req);
  await assertNotFlooding(conversation._id);

  if (!req.file) throw new AppError("Tidak ada foto yang diunggah.", 400);

  const sniffed = sniffImageMime(req.file.buffer);
  if (!sniffed || sniffed !== req.file.mimetype) {
    throw new AppError("File ini bukan foto yang valid.", 400);
  }

  // Upload ke Cloudflare R2 lewat service existing. Kredensial R2 hanya ada di
  // server; browser tidak pernah menyentuh bucket secara langsung.
  const uploaded = await r2Service.uploadBuffer(req.file.buffer, req.file.originalname, sniffed, "livechat");

  if (!/^https:\/\//i.test(uploaded.url)) {
    // R2_PUBLIC_URL yang salah konfigurasi akan menghasilkan URL non-HTTPS;
    // lebih baik gagal jelas daripada menyimpan link yang diblokir browser.
    logger.error("URL R2 bukan HTTPS", { key: uploaded.key });
    throw new AppError("Penyimpanan foto belum dikonfigurasi dengan benar.", 502);
  }

  const { message, duplicate } = await chatService.appendMessage({
    conversation,
    sender: "customer",
    text: req.body.text,
    clientMessageId: req.body.clientMessageId,
    senderName: conversation.displayName,
    attachment: {
      url: uploaded.url,
      key: uploaded.key,
      mime: sniffed,
      size: req.file.size,
      name: String(req.file.originalname || "foto").slice(0, 80),
    },
  });

  if (!duplicate) chatService.queueDiscordNotification(message._id);

  res.status(201).json({ status: true, data: chatService.toPublicMessage(message) });
});

const markRead = asyncHandler(async (req, res) => {
  const conversation = await requireChatSession(req);
  await chatService.markReadByCustomer(conversation._id);
  res.json({ status: true });
});

/* =========================================================================
   ADMIN WEB
   Seluruh route di bawah sudah dilindungi requireAdminAuth di router.
   ========================================================================= */

const listConversations = asyncHandler(async (req, res) => {
  const result = await chatService.listConversationsForAdmin({
    page: req.query.page,
    limit: req.query.limit,
    query: req.query.q,
  });
  res.json({ status: true, data: result.conversations, pagination: result.pagination, unread: result.totalUnread });
});

const getUnreadSummary = asyncHandler(async (req, res) => {
  res.json({ status: true, data: await chatService.unreadSummaryForAdmin() });
});

async function adminConversation(req) {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) throw new AppError("Percakapan tidak valid.", 400);
  const conversation = await chatService.getConversationById(id);
  if (!conversation) throw new AppError("Percakapan tidak ditemukan atau sudah kedaluwarsa.", 404);
  return conversation;
}

const getConversationMessages = asyncHandler(async (req, res) => {
  const conversation = await adminConversation(req);
  const messages = await chatService.listMessages(conversation._id, { limit: 200 });
  res.json({
    status: true,
    data: {
      conversation: chatService.toPublicConversation(conversation),
      messages: messages.map((m) => chatService.toPublicMessage(m, { forAdmin: true })),
    },
  });
});

const replyMessage = asyncHandler(async (req, res) => {
  const conversation = await adminConversation(req);
  const { message } = await chatService.appendMessage({
    conversation,
    sender: "admin",
    text: req.body.text,
    clientMessageId: req.body.clientMessageId,
    adminId: req.admin._id,
    senderName: req.admin.name,
  });
  res.status(201).json({ status: true, data: chatService.toPublicMessage(message, { forAdmin: true }) });
});

const replyPhoto = asyncHandler(async (req, res) => {
  const conversation = await adminConversation(req);
  if (!req.file) throw new AppError("Tidak ada foto yang diunggah.", 400);

  const sniffed = sniffImageMime(req.file.buffer);
  if (!sniffed || sniffed !== req.file.mimetype) throw new AppError("File ini bukan foto yang valid.", 400);

  const uploaded = await r2Service.uploadBuffer(req.file.buffer, req.file.originalname, sniffed, "livechat");

  const { message } = await chatService.appendMessage({
    conversation,
    sender: "admin",
    text: req.body.text,
    clientMessageId: req.body.clientMessageId,
    adminId: req.admin._id,
    senderName: req.admin.name,
    attachment: {
      url: uploaded.url,
      key: uploaded.key,
      mime: sniffed,
      size: req.file.size,
      name: String(req.file.originalname || "foto").slice(0, 80),
    },
  });

  res.status(201).json({ status: true, data: chatService.toPublicMessage(message, { forAdmin: true }) });
});

const markConversationRead = asyncHandler(async (req, res) => {
  const conversation = await adminConversation(req);
  const fresh = await chatService.markReadByAdmin(conversation._id);
  res.json({ status: true, data: fresh ? chatService.toPublicConversation(fresh) : null });
});

module.exports = {
  startSession,
  getSession,
  sendMessage,
  uploadPhoto,
  markRead,
  listConversations,
  getUnreadSummary,
  getConversationMessages,
  replyMessage,
  replyPhoto,
  markConversationRead,
};
