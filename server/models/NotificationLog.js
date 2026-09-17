const mongoose = require("mongoose");

/**
 * Satu baris per (orderId, event, channel) — inilah idempotency key dari
 * spec 6. Baris ini bukan sekadar catatan: baris ini adalah KUNCI yang
 * di-claim sebelum provider dipanggil, sehingga webhook yang datang dua kali
 * tidak pernah menghasilkan dua WhatsApp/Email.
 *
 * Karena kuncinya per-channel, WhatsApp yang gagal bisa di-retry sendiri
 * tanpa ikut mengirim ulang Email yang sudah sukses.
 */
const NotificationLogSchema = new mongoose.Schema(
  {
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", required: true, index: true },
    orderCode: { type: String, default: "", index: true }, // dibawa ikut supaya log bisa dibaca admin tanpa join
    channel: { type: String, enum: ["whatsapp", "email"], required: true },
    event: {
      type: String,
      enum: ["orderCreated", "paymentPending", "paymentSuccess", "paymentFailed", "paymentExpired", "orderCompleted"],
      required: true,
    },

    // pending  : sudah tercatat, belum pernah dicoba
    // sending  : sedang dikirim (dipakai untuk mencegah dua proses mengirim bersamaan)
    // sent     : provider benar-benar mengonfirmasi terkirim
    // failed   : sudah mentok (permanen, atau habis percobaan retry)
    status: { type: String, enum: ["pending", "sending", "sent", "failed"], default: "pending", index: true },

    recipient: { type: String, default: "" }, // nomor WA / alamat email tujuan
    // "builtin" = template bawaan template.service.js, "custom" = template
    // yang ditulis admin. Disimpan supaya pertanyaan "runtime pakai template
    // yang mana?" bisa dijawab dari data, bukan dari menebak isi pesan.
    templateSource: { type: String, enum: ["builtin", "custom", ""], default: "" },
    attempts: { type: Number, default: 0 },
    // true = error permanen (nomor/email/kredensial salah). Tidak di-retry,
    // karena mengulanginya hanya menghasilkan kegagalan yang sama (spec 5).
    permanentFailure: { type: Boolean, default: false },
    error: { type: String, default: "" },
    providerResponse: { type: mongoose.Schema.Types.Mixed },
    claimedAt: { type: Date },
    sentAt: { type: Date },
    failedAt: { type: Date },
  },
  { timestamps: true }
);

// Unique TANPA partial filter: satu baris untuk satu (order, event, channel)
// apa pun statusnya. Versi lama memakai partialFilterExpression {status:"sent"},
// yang membuat claim-before-send tidak mungkin — pengecekan "sudah terkirim?"
// dan pengirimannya jadi dua langkah terpisah yang bisa disisipi webhook kedua.
NotificationLogSchema.index({ orderId: 1, event: 1, channel: 1 }, { unique: true });
NotificationLogSchema.index({ createdAt: -1 });

module.exports = mongoose.model("NotificationLog", NotificationLogSchema);
