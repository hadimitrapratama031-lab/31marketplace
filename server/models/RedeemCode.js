const mongoose = require("mongoose");

/**
 * Satu dokumen = SATU redeem code untuk SATU produk dengan orderSystem
 * "REDEEM_CODE" (lihat models/Product.js). Ini adalah satu-satunya sumber
 * kebenaran untuk redeem code — tidak pernah disimpan di frontend maupun
 * localStorage (spec 4).
 *
 * Keamanan "hanya bisa dipakai satu kali" ditegakkan lewat DUA lapis:
 *   1. Transisi status yang HANYA bisa terjadi lewat satu findOneAndUpdate
 *      atomic yang mensyaratkan status masih AVAILABLE (lihat
 *      services/redeemCode.service.js claimCodesForOrder) — dua request yang
 *      berbarengan tidak mungkin sama-sama "menang" atas dokumen yang sama,
 *      karena MongoDB menjamin satu findOneAndUpdate per dokumen berjalan
 *      atomic di level storage engine.
 *   2. Field `orderId` + `soldAt` hanya pernah ditulis SEKALI, di operasi
 *      atomic yang sama — tidak ada jalur kode lain yang menuliskannya.
 */
const RedeemCodeSchema = new mongoose.Schema(
  {
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product", required: true, index: true },
    code: { type: String, required: true, trim: true },
    status: { type: String, enum: ["AVAILABLE", "SOLD"], default: "AVAILABLE", index: true },
    // Diisi HANYA saat status berubah jadi SOLD, dalam operasi atomic yang sama.
    // index dideklarasikan lewat RedeemCodeSchema.index({ orderId: 1 }) di
    // bawah (bukan index:true di sini) — dua-duanya bikin index yang sama
    // persis, dan mendeklarasikan keduanya cuma memicu warning duplicate
    // index dari Mongoose tanpa manfaat tambahan.
    orderId: { type: mongoose.Schema.Types.ObjectId, ref: "Order", default: null },
    customerId: { type: mongoose.Schema.Types.ObjectId, ref: "Customer", default: null },
    soldAt: { type: Date, default: null },
  },
  { timestamps: true }
);

// Unique PER PRODUK, bukan global: dua produk berbeda boleh kebetulan punya
// string code yang sama (mis. admin restock dari vendor yang sama untuk dua
// produk berbeda), tapi satu produk tidak boleh punya code kembar — itulah
// unit "duplicate" yang dimaksud spec 3 (validasi restock per-produk).
RedeemCodeSchema.index({ productId: 1, code: 1 }, { unique: true });
// Menopang klaim atomic (productId + status AVAILABLE, urut FIFO oleh createdAt)
// dan perhitungan stok (Total/Available/Sold) tanpa full collection scan.
RedeemCodeSchema.index({ productId: 1, status: 1, createdAt: 1 });
// Menopang "Redeem Code Terjual" (lookup by order) dan halaman transaksi
// customer (RedeemCode.find({ orderId })).
RedeemCodeSchema.index({ orderId: 1 });

module.exports = mongoose.model("RedeemCode", RedeemCodeSchema);
