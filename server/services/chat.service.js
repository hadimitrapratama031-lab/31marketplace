/**
 * Live Chat — logika bersama Marketplace dan Admin Web.
 *
 * Prinsip yang dipegang di seluruh file ini:
 *   1. MongoDB adalah source of truth. Socket.IO hanya mengantar salinan dari
 *      apa yang SUDAH tersimpan, tidak pernah menjadi tempat pesan "hidup".
 *   2. Pesan disimpan dulu, baru disiarkan, baru Discord dicoba. Kegagalan
 *      Discord tidak pernah membatalkan pesan pelanggan.
 *   3. Tidak ada kredensial (token bot, secret R2, URI database) yang pernah
 *      menyentuh payload yang dikirim ke browser.
 */

const crypto = require("crypto");
const jwt = require("jsonwebtoken");
const ChatConversation = require("../models/ChatConversation");
const ChatMessage = require("../models/ChatMessage");
const IntegrationSettings = require("../models/IntegrationSettings");
const WebsiteSettings = require("../models/WebsiteSettings");
const discordService = require("./discord.service");
const { emitToAdmins, emitToConversation } = require("./socket.service");
const { toEmailSafeUrl } = require("../utils/assetUrl");
const logger = require("../utils/logger");

const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000; // spec: expiresAt = createdAt + 24 jam
const CHAT_TOKEN_TTL = "30d";
const MAX_TEXT_LENGTH = 2000;
const PREVIEW_LENGTH = 120;

/* ------------------------------------------------------------------ waktu */

function expiryFrom(createdAt) {
  return new Date(new Date(createdAt).getTime() + MESSAGE_TTL_MS);
}

/** Filter "belum kedaluwarsa" yang dipakai SETIAP query baca pesan. */
function liveFilter(extra = {}) {
  return { ...extra, expiresAt: { $gt: new Date() } };
}

/* -------------------------------------------------------------- identitas */

function issueChatToken(conversation) {
  return jwt.sign(
    { sub: conversation._id.toString(), sid: conversation.sessionId, typ: "chat" },
    process.env.JWT_SECRET,
    { expiresIn: CHAT_TOKEN_TTL }
  );
}

function verifyChatToken(token) {
  if (!token || typeof token !== "string") return null;
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.typ !== "chat" || !decoded.sub) return null;
    return { conversationId: String(decoded.sub), sessionId: decoded.sid };
  } catch {
    return null;
  }
}

/* -------------------------------------------------------------- sanitasi */

/**
 * Pesan disimpan sebagai TEKS BIASA — tidak pernah HTML.
 *
 * Perlindungan XSS yang sebenarnya ada di sisi render: Marketplace dan Admin
 * Web memasang isi pesan lewat textContent / escapeHTML, tidak pernah lewat
 * innerHTML mentah. Yang dilakukan di sini adalah membuang karakter kontrol
 * (termasuk zero-width yang sering dipakai menyelundupkan payload) dan
 * membatasi panjang, supaya satu pesan tidak bisa membanjiri UI atau DM.
 */
function sanitizeText(raw) {
  return String(raw === undefined || raw === null ? "" : raw)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200D\uFEFF]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\n{4,}/g, "\n\n\n")
    .trim()
    .slice(0, MAX_TEXT_LENGTH);
}

function sanitizeName(raw, fallback = "Pengunjung") {
  const clean = sanitizeText(raw).replace(/\s+/g, " ").slice(0, 60);
  return clean || fallback;
}

function previewOf(message) {
  if (message.text) return message.text.replace(/\s+/g, " ").slice(0, PREVIEW_LENGTH);
  if (message.attachment && message.attachment.url) return "📷 Foto";
  return "";
}

/* ------------------------------------------------------ bentuk untuk klien */

/**
 * Bentuk pesan yang boleh keluar ke browser. Dipakai untuk Marketplace DAN
 * Admin Web supaya tidak ada dua bentuk payload yang bisa berbeda diam-diam.
 * `discord` hanya diikutkan untuk admin — pelanggan tidak perlu (dan tidak
 * boleh) tahu status notifikasi internal toko.
 */
function toPublicMessage(message, { forAdmin = false } = {}) {
  const attachment =
    message.attachment && message.attachment.url
      ? {
          url: message.attachment.url,
          mime: message.attachment.mime,
          size: message.attachment.size,
          name: message.attachment.name,
        }
      : null;

  const base = {
    id: String(message._id),
    conversationId: String(message.conversationId),
    clientMessageId: message.clientMessageId || null,
    sender: message.sender,
    senderName: message.senderName || "",
    text: message.text || "",
    attachment,
    createdAt: message.createdAt,
    expiresAt: message.expiresAt,
    readByAdminAt: message.readByAdminAt || null,
    readByCustomerAt: message.readByCustomerAt || null,
  };

  if (forAdmin && message.discord) {
    base.discord = {
      status: message.discord.status,
      message: message.discord.message || "",
      attempts: message.discord.attempts || 0,
    };
  }
  return base;
}

function toPublicConversation(conversation) {
  return {
    id: String(conversation._id),
    displayName: conversation.displayName,
    contactEmail: conversation.contactEmail || "",
    contactWhatsapp: conversation.contactWhatsapp || "",
    lastMessageAt: conversation.lastMessageAt,
    lastMessagePreview: conversation.lastMessagePreview || "",
    lastMessageSender: conversation.lastMessageSender || "",
    unreadForAdmin: conversation.unreadForAdmin || 0,
    unreadForCustomer: conversation.unreadForCustomer || 0,
    messageCount: conversation.messageCount || 0,
    startedFrom: conversation.startedFrom || "",
    expiresAt: conversation.expiresAt,
    createdAt: conversation.createdAt,
  };
}

/* ---------------------------------------------------------- percakapan */

/**
 * Membuat sesi chat baru — ANONIM.
 *
 * Tidak ada penautan ke akun/Customer mana pun: satu sesi chat berdiri
 * sendiri. `sessionId` acak dibuat SERVER dengan crypto.randomBytes lalu
 * dikembalikan sebagai JWT bertanda tangan.
 *
 * Kenapa server yang membuatnya, bukan browser: ID ini adalah satu-satunya
 * kunci ke isi percakapan. ID acak buatan frontend bisa diketik/ditebak siapa
 * saja, dan siapa pun yang mengirim ObjectId orang lain akan bisa membaca
 * thread orang itu. Sifatnya tetap anonim — tidak ada identitas yang disimpan
 * selain nama panggilan yang ditulis sendiri oleh pengunjung.
 */
async function createConversation({ name, email, whatsapp, startedFrom }) {
  const displayName = sanitizeName(name);
  // Kontak bersifat opsional dan murni catatan untuk admin; tidak pernah
  // dipakai sebagai kunci akses percakapan.
  const contactEmail = sanitizeText(email).toLowerCase().slice(0, 120);
  const contactWhatsapp = sanitizeText(whatsapp).slice(0, 25);

  const now = new Date();
  const conversation = await ChatConversation.create({
    sessionId: crypto.randomBytes(24).toString("hex"),
    displayName,
    contactEmail,
    contactWhatsapp,
    lastMessageAt: now,
    expiresAt: expiryFrom(now),
    startedFrom: sanitizeText(startedFrom).slice(0, 120),
  });

  return conversation;
}

async function getConversationById(conversationId) {
  if (!conversationId) return null;
  return ChatConversation.findById(conversationId);
}

/** Pesan yang masih hidup di satu thread, urut naik berdasarkan createdAt. */
async function listMessages(conversationId, { limit = 100 } = {}) {
  const messages = await ChatMessage.find(liveFilter({ conversationId }))
    .sort({ createdAt: 1 })
    .limit(Math.min(Math.max(Number(limit) || 100, 1), 200))
    .lean();
  return messages;
}

/* ------------------------------------------------------------ kirim pesan */

/**
 * Menyimpan satu pesan lalu menyiarkannya. Urutannya persis seperti spec:
 *
 *     simpan ke MongoDB  ->  Socket.IO (thread + admin)  ->  coba Discord
 *
 * Idempotency: `clientMessageId` unik per conversation di level index database.
 * Kalau klien mengirim ulang pesan yang sama setelah reconnect, pesan lama
 * yang dikembalikan — bukan pesan kedua, dan Discord tidak dikirim dua kali.
 */
async function appendMessage({
  conversation,
  sender,
  text,
  attachment,
  clientMessageId,
  adminId,
  senderName,
}) {
  const cleanText = sanitizeText(text);
  const hasAttachment = Boolean(attachment && attachment.url);

  if (!cleanText && !hasAttachment) {
    const err = new Error("Pesan kosong.");
    err.statusCode = 400;
    throw err;
  }

  const key = sanitizeText(clientMessageId).slice(0, 80) || null;

  if (key) {
    const existing = await ChatMessage.findOne(liveFilter({ conversationId: conversation._id, clientMessageId: key }));
    if (existing) {
      // Retry dari klien yang sama. Kembalikan yang sudah ada tanpa menyiarkan
      // atau mengirim DM ulang.
      return { message: existing, duplicate: true };
    }
  }

  const now = new Date();
  let message;
  try {
    message = await ChatMessage.create({
      conversationId: conversation._id,
      clientMessageId: key,
      sender,
      adminId: adminId || null,
      senderName: sanitizeName(senderName, sender === "admin" ? "Admin" : conversation.displayName),
      text: cleanText,
      attachment: hasAttachment ? attachment : undefined,
      readByAdminAt: sender === "admin" ? now : null,
      readByCustomerAt: sender === "customer" ? now : null,
      discord: { status: sender === "customer" ? "pending" : "skipped" },
      expiresAt: expiryFrom(now),
    });
  } catch (err) {
    // Balapan antara dua request dengan clientMessageId yang sama: index unik
    // menolak yang kedua. Itu justru hasil yang benar — ambil yang sudah ada.
    if (err && err.code === 11000 && key) {
      const existing = await ChatMessage.findOne({ conversationId: conversation._id, clientMessageId: key });
      if (existing) return { message: existing, duplicate: true };
    }
    throw err;
  }

  // Thread mengikuti pesan terbaru, termasuk masa berlakunya: pesan baru
  // memperpanjang thread, sehingga pesan lama yang expired tidak ikut
  // menyeret pesan baru.
  const inc = sender === "customer" ? { unreadForAdmin: 1, messageCount: 1 } : { unreadForCustomer: 1, messageCount: 1 };
  await ChatConversation.updateOne(
    { _id: conversation._id },
    {
      $set: {
        lastMessageAt: message.createdAt,
        lastMessagePreview: previewOf(message),
        lastMessageSender: sender,
        expiresAt: message.expiresAt,
      },
      $inc: inc,
    }
  );

  const fresh = await ChatConversation.findById(conversation._id).lean();

  // --- siaran realtime (hanya ke pemilik thread + admin) ---
  emitToConversation(conversation._id, "chat:message", toPublicMessage(message));
  emitToAdmins("chat:message", toPublicMessage(message, { forAdmin: true }));
  if (fresh) emitToAdmins("chat:conversation", toPublicConversation(fresh));

  return { message, duplicate: false, conversation: fresh };
}

/* ----------------------------------------------------------- baca / unread */

async function markReadByAdmin(conversationId) {
  const now = new Date();
  await ChatMessage.updateMany(
    liveFilter({ conversationId, sender: "customer", readByAdminAt: null }),
    { $set: { readByAdminAt: now } }
  );
  await ChatConversation.updateOne({ _id: conversationId }, { $set: { unreadForAdmin: 0 } });

  emitToConversation(conversationId, "chat:read", { conversationId: String(conversationId), by: "admin", at: now });
  const fresh = await ChatConversation.findById(conversationId).lean();
  if (fresh) emitToAdmins("chat:conversation", toPublicConversation(fresh));
  return fresh;
}

async function markReadByCustomer(conversationId) {
  const now = new Date();
  await ChatMessage.updateMany(
    liveFilter({ conversationId, sender: "admin", readByCustomerAt: null }),
    { $set: { readByCustomerAt: now } }
  );
  await ChatConversation.updateOne({ _id: conversationId }, { $set: { unreadForCustomer: 0 } });

  emitToAdmins("chat:read", { conversationId: String(conversationId), by: "customer", at: now });
  return true;
}

/* ------------------------------------------------------- daftar untuk admin */

async function listConversationsForAdmin({ page = 1, limit = 30, query = "" } = {}) {
  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(60, Math.max(1, Number(limit) || 30));

  // Thread yang seluruh pesannya sudah kedaluwarsa tidak ditampilkan, walau
  // dokumennya baru akan dihapus TTL beberapa saat lagi.
  const filter = { expiresAt: { $gt: new Date() } };
  const clean = sanitizeText(query).slice(0, 60);
  if (clean) {
    const safe = clean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    filter.$or = [{ displayName: new RegExp(safe, "i") }, { contactEmail: new RegExp(safe, "i") }];
  }

  const [rows, total] = await Promise.all([
    ChatConversation.find(filter)
      .sort({ lastMessageAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .lean(),
    ChatConversation.countDocuments(filter),
  ]);

  return {
    conversations: rows.map(toPublicConversation),
    pagination: { page: pageNum, limit: limitNum, total },
    totalUnread: rows.reduce((sum, row) => sum + (row.unreadForAdmin || 0), 0),
  };
}

/** Jumlah thread yang punya pesan belum dibaca — untuk badge rail Admin Web. */
async function unreadSummaryForAdmin() {
  const rows = await ChatConversation.find({ expiresAt: { $gt: new Date() }, unreadForAdmin: { $gt: 0 } })
    .select("unreadForAdmin")
    .lean();
  return {
    conversations: rows.length,
    messages: rows.reduce((sum, row) => sum + (row.unreadForAdmin || 0), 0),
  };
}

/* ------------------------------------------------------- notifikasi Discord */

async function getLiveChatNotificationConfig() {
  const settings = await IntegrationSettings.getSingleton();
  const liveChat = settings.liveChat || {};
  // ENV dipakai sebagai nilai awal kalau admin belum pernah mengisi form —
  // supaya deploy yang sudah menaruh ID di Railway tetap jalan tanpa klik.
  const adminUserId = String(liveChat.adminDiscordUserId || process.env.DISCORD_ADMIN_USER_ID || "").trim();
  return {
    enabled: liveChat.discordEnabled !== false && Boolean(adminUserId),
    adminUserId,
    settings,
  };
}

/** URL Admin Web untuk membuka Live Chat — hanya kalau memang dikonfigurasi. */
function adminChatUrl() {
  const base = process.env.ADMIN_URL || process.env.CLIENT_URL || process.env.SERVER_PUBLIC_URL || "";
  if (!base) return "";
  try {
    return `${new URL(String(base).trim()).origin}/admin/#livechat`;
  } catch {
    return "";
  }
}

/**
 * Kirim DM Discord untuk satu pesan customer.
 *
 * Dipanggil SETELAH pesan tersimpan dan sudah disiarkan, dan tidak pernah
 * di-await oleh request pelanggan: DM yang lambat atau gagal tidak boleh
 * menahan (apalagi membatalkan) pesan yang sudah sah.
 *
 * Retry dibatasi 3 percobaan dan HANYA untuk kegagalan sementara (timeout,
 * 5xx, rate limit). Kesalahan permanen — ID salah, DM ditutup, token tidak
 * valid — berhenti di percobaan pertama; mengulanginya tidak akan pernah
 * berhasil dan hanya membuat rate limit Discord makin ketat.
 */
async function dispatchDiscordNotification(messageId) {
  const message = await ChatMessage.findById(messageId);
  if (!message || message.sender !== "customer") return;
  // Idempotency: satu pesan hanya pernah memicu satu DM.
  if (message.discord && ["sent", "failed", "skipped"].includes(message.discord.status) && message.discord.attempts > 0) {
    return;
  }

  const config = await getLiveChatNotificationConfig();
  if (!config.enabled) {
    message.discord = { status: "skipped", attempts: 0, message: "Notifikasi Discord Live Chat nonaktif.", at: new Date() };
    await message.save();
    return;
  }

  const conversation = await ChatConversation.findById(message.conversationId).lean();
  let storeName = "Live Chat";
  let storeLogo = "";
  try {
    const website = await WebsiteSettings.getSingleton();
    storeName = (website.general && website.general.storeName) || storeName;
    storeLogo = (website.general && website.general.logo) || "";
  } catch {
    /* branding tidak wajib untuk notifikasi */
  }

  const ctx = {
    storeName,
    storeLogo: storeLogo ? toEmailSafeUrl(storeLogo) : "",
    customerName: (conversation && conversation.displayName) || message.senderName || "Pengunjung",
    // ID percakapan, bukan email/WhatsApp: cukup untuk admin membuka thread
    // yang benar tanpa memindahkan data kontak pelanggan ke Discord.
    userId: conversation ? String(conversation._id) : "—",
    text: message.text,
    hasImage: Boolean(message.attachment && message.attachment.url),
    imageUrl: message.attachment && message.attachment.url ? toEmailSafeUrl(message.attachment.url) : "",
    time: new Date(message.createdAt).toLocaleString("id-ID", {
      dateStyle: "medium",
      timeStyle: "short",
      timeZone: "Asia/Jakarta",
    }),
    openUrl: adminChatUrl(),
  };

  const MAX_ATTEMPTS = 3;
  let attempts = 0;
  let last = null;

  while (attempts < MAX_ATTEMPTS) {
    attempts += 1;
    last = await discordService.sendLiveChatDM(config.adminUserId, ctx);
    if (last.success || last.permanent) break;
    // Jeda singkat dan bertambah, bukan retry tanpa batas.
    await new Promise((resolve) => setTimeout(resolve, 1200 * attempts));
  }

  message.discord = {
    status: last && last.success ? "sent" : "failed",
    attempts,
    message: last && last.success ? "" : (last && last.message) || "DM Discord gagal.",
    messageId: (last && last.messageId) || "",
    at: new Date(),
  };
  await message.save();

  if (!message.discord.status || message.discord.status === "failed") {
    logger.warn("DM Discord Live Chat gagal", { messageId: String(message._id), reason: message.discord.message });
  }

  // Admin Web menampilkan status pengiriman ini apa adanya, jadi kegagalan
  // Discord terlihat sebagai kegagalan notifikasi — bukan sebagai chat hilang.
  emitToAdmins("chat:discord", {
    messageId: String(message._id),
    conversationId: String(message.conversationId),
    status: message.discord.status,
    message: message.discord.message,
  });
}

/** Menjalankan DM di latar belakang tanpa pernah melempar ke request pemanggil. */
function queueDiscordNotification(messageId) {
  setImmediate(() => {
    dispatchDiscordNotification(messageId).catch((err) => {
      logger.error("Notifikasi Discord Live Chat error", { messageId: String(messageId), message: err.message });
    });
  });
}

module.exports = {
  MESSAGE_TTL_MS,
  liveFilter,
  expiryFrom,
  issueChatToken,
  verifyChatToken,
  sanitizeText,
  sanitizeName,
  createConversation,
  getConversationById,
  listMessages,
  appendMessage,
  markReadByAdmin,
  markReadByCustomer,
  listConversationsForAdmin,
  unreadSummaryForAdmin,
  toPublicMessage,
  toPublicConversation,
  getLiveChatNotificationConfig,
  dispatchDiscordNotification,
  queueDiscordNotification,
  adminChatUrl,
};
