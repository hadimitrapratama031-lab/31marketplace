const { Server } = require("socket.io");
const jwt = require("jsonwebtoken");
const logger = require("../utils/logger");

let io = null;

const ADMIN_ROOM = "admin";
const chatRoom = (conversationId) => `chat:${conversationId}`;

/**
 * Socket.IO tunggal untuk seluruh sistem.
 *
 * Dua jenis siaran, sengaja dibedakan:
 *
 *   emitEvent()   — siaran GLOBAL ke semua koneksi. Dipakai event publik yang
 *                   memang boleh dilihat siapa saja (stok, perubahan settings,
 *                   floating order yang datanya sudah disamarkan).
 *   emitToRoom()  — siaran TERBATAS ke satu room. Wajib untuk Live Chat: isi
 *                   percakapan hanya boleh sampai ke pemilik percakapan itu
 *                   dan ke admin. Kalau chat ikut io.emit(), setiap pengunjung
 *                   Marketplace akan menerima pesan pelanggan lain.
 *
 * Masuk room TIDAK bisa diminta begitu saja: klien harus mengirim token yang
 * ditandatangani server (JWT chat untuk pelanggan, JWT admin untuk Admin Web).
 * Tanpa verifikasi ini, siapa pun bisa emit "chat:auth" dengan ObjectId tebakan
 * lalu menguping thread orang lain.
 */
function initSocket(httpServer, allowedOrigins) {
  io = new Server(httpServer, {
    cors: {
      origin: allowedOrigins,
      credentials: true,
    },
  });

  io.on("connection", (socket) => {
    logger.info("Socket connected", { socketId: socket.id });

    // --- Pelanggan Marketplace bergabung ke thread miliknya sendiri ---
    // Klien memanggil ini setiap kali "connect" (termasuk setelah reconnect),
    // jadi keanggotaan room tidak pernah hilang diam-diam.
    socket.on("chat:auth", (payload, ack) => {
      const result = verifyChatToken(payload && payload.token);
      if (!result.ok) {
        if (typeof ack === "function") ack({ ok: false, message: "Sesi chat tidak valid." });
        return;
      }
      // Satu socket hanya memegang satu thread: keluar dari room chat lama
      // sebelum masuk yang baru, supaya sesi yang sudah di-reset tidak terus
      // menerima pesan thread sebelumnya.
      leaveChatRooms(socket);
      socket.join(chatRoom(result.conversationId));
      socket.data.conversationId = result.conversationId;
      if (typeof ack === "function") ack({ ok: true, conversationId: result.conversationId });
    });

    socket.on("chat:leave", () => {
      leaveChatRooms(socket);
      socket.data.conversationId = null;
    });

    // --- Admin Web bergabung ke room admin ---
    socket.on("admin:auth", (payload, ack) => {
      const result = verifyAdminToken(payload && payload.token);
      if (!result.ok) {
        if (typeof ack === "function") ack({ ok: false, message: "Sesi admin tidak valid." });
        return;
      }
      socket.join(ADMIN_ROOM);
      socket.data.adminId = result.adminId;
      if (typeof ack === "function") ack({ ok: true });
    });

    socket.on("disconnect", (reason) => {
      logger.info("Socket disconnected", { socketId: socket.id, reason });
    });
  });

  return io;
}

function leaveChatRooms(socket) {
  for (const room of Array.from(socket.rooms)) {
    if (typeof room === "string" && room.startsWith("chat:")) socket.leave(room);
  }
}

// JWT chat ditandai `typ: "chat"` supaya token admin tidak pernah bisa dipakai
// sebagai token chat (dan sebaliknya), walau keduanya ditandatangani dengan
// JWT_SECRET yang sama.
function verifyChatToken(token) {
  if (!token || typeof token !== "string") return { ok: false };
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    if (decoded.typ !== "chat" || !decoded.sub) return { ok: false };
    return { ok: true, conversationId: String(decoded.sub), sessionId: decoded.sid };
  } catch {
    return { ok: false };
  }
}

function verifyAdminToken(token) {
  if (!token || typeof token !== "string") return { ok: false };
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    // Token admin tidak punya `typ`; token chat punya. Tolak yang bertanda chat.
    if (decoded.typ === "chat" || !decoded.sub) return { ok: false };
    return { ok: true, adminId: String(decoded.sub), role: decoded.role };
  } catch {
    return { ok: false };
  }
}

// Emit only AFTER the DB write that backs this event has already succeeded.
// If the DB write failed, callers must NOT call this (spec section 17/18).
function emitEvent(eventName, payload) {
  if (!io) {
    logger.warn("Socket.IO not initialized, skipping emit", { eventName });
    return;
  }
  io.emit(eventName, payload);
}

function emitToRoom(room, eventName, payload) {
  if (!io) {
    logger.warn("Socket.IO not initialized, skipping room emit", { eventName, room });
    return;
  }
  io.to(room).emit(eventName, payload);
}

function emitToAdmins(eventName, payload) {
  emitToRoom(ADMIN_ROOM, eventName, payload);
}

function emitToConversation(conversationId, eventName, payload) {
  emitToRoom(chatRoom(conversationId), eventName, payload);
}

function getIO() {
  return io;
}

module.exports = {
  initSocket,
  emitEvent,
  emitToRoom,
  emitToAdmins,
  emitToConversation,
  getIO,
  ADMIN_ROOM,
  chatRoom,
};
