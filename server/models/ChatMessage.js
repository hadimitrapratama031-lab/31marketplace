const mongoose = require("mongoose");

const MESSAGE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Satu pesan Live Chat. Database adalah source of truth — Socket.IO hanya
 * mengantar salinan dari apa yang SUDAH tersimpan di sini.
 *
 * KEDALUWARSA 24 JAM (spec "AUTO DELETE 24 JAM")
 * ---------------------------------------------
 * `expiresAt = createdAt + 24 jam`, dihitung per pesan — bukan "hapus semua
 * saat tengah malam". Dua lapis, karena TTL monitor MongoDB berjalan tiap ~60
 * detik dan tidak presisi ke detik:
 *
 *   1. Index TTL di bawah benar-benar MENGHAPUS dokumennya dari database.
 *   2. Semua query baca memfilter `expiresAt: { $gt: now }`, jadi pesan yang
 *      sudah lewat 24 jam tidak pernah ikut terkirim ke Marketplace maupun
 *      Admin Web walau penghapusan fisiknya baru terjadi semenit kemudian.
 *
 * IDEMPOTENCY (spec "MESSAGE ID / IDEMPOTENCY")
 * --------------------------------------------
 * Pengirim menyertakan `clientMessageId` sekali per pesan. Index unik parsial
 * di bawah membuat retry/reconnect yang mengirim ulang pesan yang sama ditolak
 * di level database — bukan sekadar dicek di memori, yang akan bocor begitu
 * ada dua instance server.
 */
const ChatMessageSchema = new mongoose.Schema(
  {
    conversationId: { type: mongoose.Schema.Types.ObjectId, ref: "ChatConversation", required: true, index: true },

    // Kunci idempotency dari pengirim. null = tidak dikirim (tetap diterima).
    clientMessageId: { type: String, default: null },

    sender: { type: String, enum: ["customer", "admin"], required: true },
    adminId: { type: mongoose.Schema.Types.ObjectId, ref: "Admin", default: null },
    senderName: { type: String, default: "" },

    text: { type: String, default: "" },

    attachment: {
      url: { type: String, default: "" },
      key: { type: String, default: "" },
      mime: { type: String, default: "" },
      size: { type: Number, default: 0 },
      name: { type: String, default: "" },
    },

    readByAdminAt: { type: Date, default: null },
    readByCustomerAt: { type: Date, default: null },

    // Status pengiriman DM Discord untuk pesan ini. Kegagalan di sini tidak
    // pernah membatalkan pesan yang sudah tersimpan (spec "NOTIFICATION
    // FAILURE") — hanya dicatat supaya admin tahu kenapa DM tidak sampai.
    discord: {
      status: { type: String, enum: ["skipped", "pending", "sent", "failed"], default: "skipped" },
      attempts: { type: Number, default: 0 },
      message: { type: String, default: "" },
      messageId: { type: String, default: "" },
      at: { type: Date, default: null },
    },

    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

ChatMessageSchema.index({ conversationId: 1, createdAt: 1 });
ChatMessageSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });

// Unik HANYA untuk pesan yang benar-benar membawa clientMessageId; pesan tanpa
// kunci (null) tidak saling bentrok.
ChatMessageSchema.index(
  { conversationId: 1, clientMessageId: 1 },
  { unique: true, partialFilterExpression: { clientMessageId: { $type: "string" } } }
);

ChatMessageSchema.statics.TTL_MS = MESSAGE_TTL_MS;

module.exports = mongoose.model("ChatMessage", ChatMessageSchema);
module.exports.MESSAGE_TTL_MS = MESSAGE_TTL_MS;
