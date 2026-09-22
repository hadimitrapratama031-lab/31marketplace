const mongoose = require("mongoose");
const RedeemCode = require("../models/RedeemCode");
const Product = require("../models/Product");
const logger = require("../utils/logger");
const { emitEvent } = require("./socket.service");

/**
 * Redeem Code Service — satu-satunya jalur tulis/baca untuk koleksi
 * RedeemCode. Semua controller (product, payment, order) memanggil lewat
 * sini supaya aturan "hanya sekali pakai" dan "stok selalu dari database
 * asli" tidak bisa dilanggar dari jalur lain.
 */

// Batas aman satu kali restock. Mencegah body raksasa (ratusan ribu baris)
// membekukan request tunggal atau membanjiri insertMany sekaligus.
const MAX_BULK_CODES = 2000;

function badRequest(message) {
  const err = new Error(message);
  err.statusCode = 400;
  return err;
}

// Memisahkan paste banyak code sekaligus berdasarkan baris (spec 3). Baris
// kosong/whitespace dibuang — "code kosong tidak boleh disimpan".
function parseCodes(raw) {
  return String(raw || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

async function getStats(productId) {
  const rows = await RedeemCode.aggregate([
    { $match: { productId: new mongoose.Types.ObjectId(productId) } },
    { $group: { _id: "$status", count: { $sum: 1 } } },
  ]);
  const byStatus = rows.reduce((acc, row) => Object.assign(acc, { [row._id]: row.count }), {});
  const available = byStatus.AVAILABLE || 0;
  const sold = byStatus.SOLD || 0;
  return { total: available + sold, available, sold };
}

// Versi banyak-produk-sekaligus untuk daftar produk Admin Web — satu
// aggregate untuk seluruh halaman, bukan satu query per baris produk.
async function getStatsMany(productIds) {
  const map = new Map();
  const ids = (productIds || []).filter(Boolean).map(String);
  if (!ids.length) return map;

  const rows = await RedeemCode.aggregate([
    { $match: { productId: { $in: ids.map((id) => new mongoose.Types.ObjectId(id)) } } },
    { $group: { _id: { productId: "$productId", status: "$status" }, count: { $sum: 1 } } },
  ]);

  for (const row of rows) {
    const key = String(row._id.productId);
    const entry = map.get(key) || { total: 0, available: 0, sold: 0 };
    entry.total += row.count;
    if (row._id.status === "AVAILABLE") entry.available += row.count;
    if (row._id.status === "SOLD") entry.sold += row.count;
    map.set(key, entry);
  }
  return map;
}

/**
 * Restock: menambah banyak redeem code sekaligus untuk satu produk.
 * Validasi (spec 3): kosong dibuang, duplikat ditolak (per produk, lewat
 * unique index — bukan hanya dicek di memori), batas aman jumlah per-batch.
 *
 * `insertMany(..., { ordered:false })` sengaja dipakai supaya SATU baris
 * duplikat/tidak valid tidak menggagalkan seluruh restock — dokumen yang sah
 * tetap tersimpan, dan yang gagal dilaporkan balik ke admin sebagai
 * "dilewati" (bukan silently lost, bukan juga menghentikan semuanya).
 */
async function restock(productId, rawCodes) {
  if (!mongoose.isValidObjectId(productId)) throw badRequest("Produk tidak valid.");
  const product = await Product.findById(productId);
  if (!product) throw badRequest("Produk tidak ditemukan.");
  if (product.orderSystem !== "REDEEM_CODE") {
    throw badRequest("Produk ini tidak memakai sistem Automatic Redeem Code.");
  }

  const parsed = parseCodes(rawCodes);
  if (!parsed.length) throw badRequest("Tidak ada kode yang valid untuk disimpan.");
  if (parsed.length > MAX_BULK_CODES) {
    throw badRequest(`Maksimal ${MAX_BULK_CODES} kode per restock. Bagi menjadi beberapa kali restock.`);
  }

  // Dedupe DI DALAM batch yang sama dulu — kalau tidak, insertMany akan
  // menganggapnya sebagai "gagal karena duplikat" terhadap dirinya sendiri.
  const uniqueInBatch = Array.from(new Set(parsed));
  const duplicateInBatch = parsed.length - uniqueInBatch.length;

  const docs = uniqueInBatch.map((code) => ({ productId: product._id, code, status: "AVAILABLE" }));

  let insertedCount = 0;
  try {
    const result = await RedeemCode.insertMany(docs, { ordered: false });
    insertedCount = result.length;
  } catch (err) {
    // Dengan ordered:false, Mongo tetap menyisipkan semua dokumen yang valid
    // dan hanya melaporkan yang gagal lewat err.writeErrors (biasanya kode
    // yang sudah ada sebelumnya di produk ini, ditolak oleh unique index).
    if (err && Array.isArray(err.writeErrors)) {
      insertedCount = uniqueInBatch.length - err.writeErrors.length;
    } else if (err && err.code === 11000) {
      insertedCount = 0;
    } else {
      throw err;
    }
  }

  const skippedDuplicate = uniqueInBatch.length - insertedCount;

  if (insertedCount > 0) {
    // `stock` produk = jumlah code AVAILABLE. Field yang SAMA yang sudah
    // dipakai checkout & Marketplace — tidak ada state kedua yang perlu
    // disinkronkan secara terpisah, jadi tidak mungkin drift.
    await Product.updateOne({ _id: product._id }, { $inc: { stock: insertedCount } });
  }

  const stats = await getStats(product._id);
  const updatedProduct = await Product.findById(product._id).select("stock sold");

  // Realtime lewat Socket.IO yang SUDAH ADA (spec 9) — tidak ada kanal baru.
  emitEvent("redeem:stock:updated", { productId: String(product._id), ...stats });
  if (updatedProduct) {
    emitEvent("stock:updated", { productId: updatedProduct._id, stock: updatedProduct.stock, sold: updatedProduct.sold });
  }

  logger.info("Redeem code restock", {
    productId: String(product._id),
    inserted: insertedCount,
    skippedDuplicateInBatch: duplicateInBatch,
    skippedDuplicateExisting: skippedDuplicate,
  });

  return {
    inserted: insertedCount,
    skipped: duplicateInBatch + skippedDuplicate,
    stats,
  };
}

/**
 * Klaim N code AVAILABLE (N = order.quantity) untuk satu order, dipanggil
 * HANYA dari payment.controller.js applyPaymentStatus() setelah pembayaran
 * SUCCESS dan SETELAH stok produk berhasil didekremen (spec 4 & 10).
 *
 * Race-safety: setiap klaim adalah SATU findOneAndUpdate({status:AVAILABLE})
 * -> SOLD. MongoDB menjamin operasi ini atomic per dokumen di level storage
 * engine, jadi dua order yang checkout bersamaan untuk produk yang sama
 * TIDAK MUNGKIN sama-sama mendapatkan dokumen RedeemCode yang sama — siapa
 * pun yang permintaannya sampai lebih dulu ke MongoDB akan "menang", dan
 * request kedua otomatis mendapat dokumen AVAILABLE berikutnya (atau null
 * kalau sudah habis). Tidak ada lock terpisah yang perlu dikelola manual.
 *
 * Idempotency terhadap webhook yang dikirim ulang BUKAN tanggung jawab
 * fungsi ini — itu sudah dijamin oleh applyPaymentStatus() di
 * payment.controller.js, yang menolak memproses transaksi yang statusnya
 * tidak berubah atau sudah SUCCESS sebelum fungsi ini pernah dipanggil.
 */
async function claimCodesForOrder(order, product) {
  const qty = Math.max(1, Number(order.quantity) || 1);
  const claimed = [];

  for (let i = 0; i < qty; i += 1) {
    // sort createdAt:1 -> FIFO: code yang paling lama masuk stok yang
    // terjual lebih dulu.
    // eslint-disable-next-line no-await-in-loop
    const doc = await RedeemCode.findOneAndUpdate(
      { productId: product._id, status: "AVAILABLE" },
      {
        $set: {
          status: "SOLD",
          orderId: order._id,
          customerId: order.customerId || null,
          soldAt: new Date(),
        },
      },
      { new: true, sort: { createdAt: 1 } }
    );
    if (!doc) break; // Stok code sudah habis — seharusnya tidak terjadi kalau stok tersinkron.
    claimed.push(doc);
  }

  const stats = await getStats(product._id);
  emitEvent("redeem:stock:updated", { productId: String(product._id), ...stats });

  const shortfall = qty - claimed.length;
  if (shortfall > 0) {
    logger.error("Redeem code claim shortfall — stok produk dan koleksi RedeemCode tidak sinkron", {
      orderCode: order.orderCode,
      productId: String(product._id),
      requested: qty,
      claimed: claimed.length,
      shortfall,
    });
  }

  return { claimed, shortfall };
}

// Dipakai halaman transaksi customer & notifikasi WhatsApp/Email — HANYA
// code milik order ini (ownership sudah divalidasi pemanggil lewat
// email/orderCode sebelum sampai ke sini, lihat order.controller.js).
async function getCodesForOrder(orderId) {
  const rows = await RedeemCode.find({ orderId }).sort({ soldAt: 1 }).select("code -_id").lean();
  return rows.map((r) => r.code);
}

// ADMIN — "Redeem Code Terjual" (spec 6). Hanya code berstatus SOLD, tidak
// pernah menampilkan code yang belum terjual.
async function listSold({ productId, q, page = 1, limit = 25 } = {}) {
  const filter = { status: "SOLD" };
  if (productId && mongoose.isValidObjectId(productId)) filter.productId = productId;
  if (q && String(q).trim()) {
    const rx = new RegExp(String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.code = rx;
  }

  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(100, Math.max(1, Number(limit) || 25));

  const [rows, total] = await Promise.all([
    RedeemCode.find(filter)
      .sort({ soldAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .populate("productId", "name")
      .populate({ path: "orderId", select: "orderCode customer" })
      .lean(),
    RedeemCode.countDocuments(filter),
  ]);

  return {
    rows: rows.map((r) => ({
      id: String(r._id),
      code: r.code,
      productId: r.productId ? String(r.productId._id) : "",
      productName: r.productId ? r.productId.name : "(produk dihapus)",
      orderId: r.orderId ? String(r.orderId._id) : "",
      orderCode: r.orderId ? r.orderId.orderCode : "",
      customerName: r.orderId && r.orderId.customer ? r.orderId.customer.name || r.orderId.customer.email : "",
      soldAt: r.soldAt,
    })),
    pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.max(1, Math.ceil(total / limitNum)) },
  };
}

module.exports = {
  MAX_BULK_CODES,
  parseCodes,
  getStats,
  getStatsMany,
  restock,
  claimCodesForOrder,
  getCodesForOrder,
  listSold,
};
