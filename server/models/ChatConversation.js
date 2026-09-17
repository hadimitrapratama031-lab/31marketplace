const mongoose = require("mongoose");

/**
 * Satu thread percakapan Live Chat. Marketplace dan Admin Web memakai dokumen
 * YANG SAMA — tidak ada dua sistem chat terpisah.
 *
 * IDENTITAS — ANONIM
 * ------------------
 * Percakapan tidak ditautkan ke akun apa pun. Kuncinya adalah `sessionId`
 * acak yang DITERBITKAN SERVER (crypto.randomBytes) dan dikirim ke browser
 * sebagai JWT bertanda `typ: "chat"`.
 *
 * Server yang membuat ID-nya, bukan browser, karena ID ini satu-satunya kunci
 * ke isi percakapan: ID acak buatan frontend bisa diketik atau ditebak, dan
 * siapa pun yang mengirim ObjectId orang lain akan bisa membaca thread orang
 * itu. Nama dan kontak di bawah murni catatan tampilan untuk admin — tidak
 * pernah menentukan hak akses.
 *
 * TTL
 * ---
 * `expiresAt` selalu = expiry pesan terbaru di thread ini (createdAt + 24 jam).
 * Jadi thread ikut hilang setelah pesan terakhirnya kedaluwarsa, dan setiap
 * pesan baru memperpanjangnya — pesan baru tidak pernah ikut terhapus hanya
 * karena pesan lama di thread yang sama sudah expired.
 */
const ChatConversationSchema = new mongoose.Schema(
  {
    sessionId: { type: String, required: true, unique: true, index: true },

    displayName: { type: String, default: "Pengunjung" },
    contactEmail: { type: String, default: "" },
    contactWhatsapp: { type: String, default: "" },

    lastMessageAt: { type: Date, default: Date.now, index: true },
    lastMessagePreview: { type: String, default: "" },
    lastMessageSender: { type: String, enum: ["customer", "admin", ""], default: "" },

    unreadForAdmin: { type: Number, default: 0 },
    unreadForCustomer: { type: Number, default: 0 },
    messageCount: { type: Number, default: 0 },

    // Jejak ringan untuk admin: dari halaman mana chat dimulai.
    startedFrom: { type: String, default: "" },

    expiresAt: { type: Date, required: true },
  },
  { timestamps: true }
);

// TTL MongoDB: dokumen dihapus begitu expiresAt lewat (expireAfterSeconds: 0).
ChatConversationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
ChatConversationSchema.index({ lastMessageAt: -1 });

module.exports = mongoose.model("ChatConversation", ChatConversationSchema);
