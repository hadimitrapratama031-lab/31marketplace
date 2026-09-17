const mongoose = require("mongoose");
const Order = require("../models/Order");
const Transaction = require("../models/Transaction");
const Product = require("../models/Product");
const asyncHandler = require("../utils/asyncHandler");
const { AppError } = require("../middlewares/errorHandler");
const { emitEvent } = require("../services/socket.service");
const klikqris = require("../services/klikqris.service");
const notificationService = require("../services/notification.service");
const orderFeed = require("../services/orderFeed.service");
const logger = require("../utils/logger");

// Maps KlikQRIS transaction status -> our internal Order/Transaction status.
function mapKlikQrisStatus(kqStatus) {
  const normalized = String(kqStatus || "").toUpperCase();
  if (normalized === "SUCCESS" || normalized === "PAID") return "PAID";
  if (normalized === "EXPIRED") return "EXPIRED";
  if (normalized === "FAILED") return "FAILED";
  if (normalized === "CANCELLED") return "CANCELLED";
  return "PENDING";
}

/**
 * Applies a payment status transition to Order + Transaction atomically-ish,
 * with full idempotency: if the transaction is already in a terminal state
 * that matches, nothing happens twice (no double stock decrement, no double
 * notification) — see spec sections 23 & 24.
 */
async function applyPaymentStatus({ orderCode, newStatus, paidAt }) {
  const transaction = await Transaction.findOne({ transactionId: orderCode });
  if (!transaction) {
    logger.warn("Webhook received for unknown transaction", { orderCode });
    return { handled: false };
  }

  const order = await Order.findById(transaction.orderId);
  if (!order) {
    logger.warn("Webhook received for transaction with missing order", { orderCode });
    return { handled: false };
  }

  // Idempotency guard: if already in this terminal status, do nothing further.
  if (transaction.status === newStatus) {
    logger.info("Duplicate webhook ignored (status unchanged)", { orderCode, status: newStatus });
    return { handled: true, order, transaction, duplicate: true };
  }
  // Never downgrade a terminal SUCCESS status.
  if (transaction.status === "SUCCESS") {
    logger.info("Webhook ignored: transaction already SUCCESS", { orderCode });
    return { handled: true, order, transaction, duplicate: true };
  }

  // Dicatat SEBELUM status diubah: dipakai di bawah untuk tahu apakah order ini
  // perlu dicabut dari Floating Order Success.
  const wasSuccessful = orderFeed.isSuccessful(order);

  transaction.status = newStatus === "PAID" ? "SUCCESS" : newStatus;
  if (paidAt) transaction.paidAt = new Date(paidAt);
  await transaction.save();

  order.paymentStatus = newStatus === "PAID" ? "SUCCESS" : newStatus;

  if (newStatus === "PAID") {
    order.status = "PAID";

    // Atomic stock decrement — only if enough stock remains, never below zero.
    const updatedProduct = await Product.findOneAndUpdate(
      { _id: order.product.productId, stock: { $gte: order.quantity } },
      { $inc: { stock: -order.quantity, sold: order.quantity } },
      { new: true }
    );

    if (!updatedProduct) {
      logger.error("Insufficient stock at payment success — needs manual admin review", {
        orderCode,
        productId: String(order.product.productId),
      });
    } else {
      emitEvent("stock:updated", { productId: updatedProduct._id, stock: updatedProduct.stock, sold: updatedProduct.sold });
    }
  } else if (["FAILED", "EXPIRED", "CANCELLED"].includes(newStatus)) {
    order.status = newStatus;
  }

  await order.save();

  emitEvent("order:updated", { orderId: order._id, orderCode: order.orderCode, status: order.status });
  emitEvent("payment:updated", { orderCode: order.orderCode, paymentStatus: order.paymentStatus });

  // Floating Order Success di Marketplace. Disiarkan HANYA di sini — setelah
  // order tersimpan dengan paymentStatus SUCCESS — sehingga yang muncul di
  // halaman pengunjung tidak mungkin order pending, gagal, atau kedaluwarsa.
  // Penjaga duplikat ada di atas (status tidak berubah -> return lebih awal),
  // jadi webhook yang dikirim ulang KlikQRIS tidak memunculkan kartu kedua.
  if (orderFeed.isSuccessful(order)) {
    emitEvent("order:success:public", orderFeed.toPublicOrder(order));
  } else if (wasSuccessful) {
    // Order yang tadinya sukses lalu tidak lagi memenuhi syarat harus keluar
    // dari antrean di semua browser yang sedang terbuka. Yang dikirim hanya id
    // publiknya — payload ini pun tidak pernah memuat kode order.
    emitEvent("order:success:revoked", { id: orderFeed.publicId(order._id) });
  }

  const eventKey =
    newStatus === "PAID" ? "paymentSuccess" : newStatus === "FAILED" ? "paymentFailed" : newStatus === "EXPIRED" ? "paymentExpired" : null;
  if (eventKey) {
    // Diantre, bukan di-await: webhook KlikQRIS harus dibalas 200 secepatnya.
    // Menunggu Fonnte + Resend (masing-masing sampai 20 detik, plus retry) di
    // dalam request webhook membuat gateway menganggap webhook gagal dan
    // mengirimnya ulang — justru memperbanyak duplikat yang ingin dihindari.
    // Status pembayaran sudah tersimpan di atas, jadi notifikasi ini bekerja
    // dari state yang sudah final, dan idempotency-nya dijaga NotificationLog.
    notificationService.queueOrderEvent(order, eventKey, { transaction });
  }

  return { handled: true, order, transaction, duplicate: false };
}

// KlikQRIS webhook — fires on SUCCESS(PAID) or EXPIRED. Must respond 200 OK.
const klikqrisWebhook = asyncHandler(async (req, res) => {
  const payload = req.body || {};
  // KlikQRIS PG mode payload uses top-level order_id/status/signature.
  // MY PG mode wraps it in { status, message, data: { order_id, status, signature, ... } }.
  const data = payload.data || payload;
  const orderCode = data.order_id;
  const incomingSignature = data.signature;
  const kqStatus = data.status;

  if (!orderCode) {
    logger.warn("Webhook missing order_id", { payload });
    return res.status(200).json({ status: true, message: "ignored: missing order_id" });
  }

  const transaction = await Transaction.findOne({ transactionId: orderCode });
  if (!transaction) {
    logger.warn("Webhook for unknown order_id", { orderCode });
    return res.status(200).json({ status: true, message: "ignored: unknown order" });
  }

  // Double security: validate signature matches the one issued at creation time.
  if (transaction.signature && incomingSignature && transaction.signature !== incomingSignature) {
    logger.error("Webhook signature mismatch — possible fake webhook", { orderCode });
    return res.status(200).json({ status: false, message: "signature mismatch" });
  }

  transaction.rawWebhookPayloads.push(payload);
  await transaction.save();

  const newStatus = mapKlikQrisStatus(kqStatus);
  await applyPaymentStatus({ orderCode, newStatus, paidAt: data.payment_date });

  // KlikQRIS requires HTTP 200 to stop retrying.
  res.status(200).json({ status: true, message: "ok" });
});

// Manual refresh: re-checks status directly with KlikQRIS (spec section: GET Check Status Manual).
const refreshStatus = asyncHandler(async (req, res) => {
  const { orderCode } = req.params;
  const transaction = await Transaction.findOne({ transactionId: orderCode });
  if (!transaction) throw new AppError("Transaksi tidak ditemukan.", 404);

  if (transaction.status !== "PENDING") {
    return res.json({ status: true, data: { status: transaction.status } });
  }

  const kqData = await klikqris.checkStatus(orderCode);
  const newStatus = mapKlikQrisStatus(kqData.status);
  if (newStatus !== "PENDING") {
    await applyPaymentStatus({ orderCode, newStatus, paidAt: kqData.paid_at });
  }

  res.json({ status: true, data: { status: newStatus } });
});

/**
 * Menutup transaksi yang sudah lewat batas waktu.
 *
 * Tanpa ini, PAYMENT_EXPIRED praktis tidak pernah terkirim: satu-satunya
 * pemicunya adalah webhook EXPIRED dari KlikQRIS atau pembeli yang kebetulan
 * membuka lagi halaman pembayaran. Pembeli yang menutup tab setelah checkout
 * — kasus yang paling umum — tidak pernah menerima apa pun.
 *
 * Ini bukan sistem notifikasi kedua: ia hanya memanggil applyPaymentStatus()
 * yang sama, sehingga status, Socket.IO, dan idempotency-nya identik dengan
 * jalur webhook.
 */
async function sweepExpiredPayments() {
  const now = new Date();
  const stale = await Transaction.find({ status: "PENDING", expiredAt: { $ne: null, $lt: now } })
    .select("transactionId")
    .limit(50)
    .lean();

  for (const tx of stale) {
    try {
      await applyPaymentStatus({ orderCode: tx.transactionId, newStatus: "EXPIRED" });
      logger.info("Transaksi kedaluwarsa ditutup oleh sweeper", { orderCode: tx.transactionId });
    } catch (err) {
      logger.error("Gagal menutup transaksi kedaluwarsa", { orderCode: tx.transactionId, message: err.message });
    }
  }
  return stale.length;
}

// Interval, bukan cron eksternal, supaya tidak ada layanan baru yang harus
// di-deploy. `unref()` menjaga proses tetap bisa keluar dengan bersih.
function startExpirySweeper(intervalMs = 5 * 60 * 1000) {
  const timer = setInterval(() => {
    sweepExpiredPayments().catch((err) => logger.error("Expiry sweeper gagal", { message: err.message }));
  }, intervalMs);
  if (typeof timer.unref === "function") timer.unref();
  logger.info("Expiry sweeper aktif", { intervalMs });
  return timer;
}

/* --------------------------------------------- ADMIN: hapus & reset payment

   ARAH RELASINYA SATU JALUR: Transaction.orderId -> Order.
   Order sendiri tidak menyimpan referensi ke Transaction; halaman Cek Pesanan,
   Order Success, dan detail admin semuanya mencari transaksi lewat
   Transaction.findOne({ orderId }) dan sudah menangani hasil null (tampil
   "Order ini belum punya transaksi pembayaran yang tercatat").

   Jadi menghapus Payment TIDAK menghapus Order-nya: catatan penjualan dan
   status pembayaran yang sudah final tetap ada di Order untuk audit — persis
   aturan di brief #15 ("jika Delete Order harus mempertahankan Payment untuk
   audit: pertahankan"), dibaca dari arah sebaliknya. Yang hilang hanya detail
   gateway: QRIS, signature, nominal unik, dan payload webhook.

   Konsekuensinya disebutkan di modal konfirmasi: order yang pembayarannya
   dihapus tidak bisa lagi di-refresh statusnya lewat /payments/:orderCode/
   refresh, karena jalur itu mencari berdasarkan transactionId.              */

// ADMIN — DELETE /api/payments/admin/:id
// Menerima _id Transaction ATAU _id Order, karena tabel Pembayaran di Admin
// Web memang menampilkan satu baris per order. Tidak menerima nama collection,
// filter, atau query apa pun dari frontend.
const deletePaymentAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) throw new AppError("ID pembayaran tidak valid.", 400);

  const transaction = (await Transaction.findById(id)) || (await Transaction.findOne({ orderId: id }));
  if (!transaction) throw new AppError("Data pembayaran tidak ditemukan untuk baris ini.", 404);

  const orderCode = transaction.transactionId;
  await Transaction.deleteOne({ _id: transaction._id });

  logger.warn("Data pembayaran dihapus permanen oleh admin", {
    orderCode,
    adminId: String(req.admin._id),
    adminEmail: req.admin.email,
  });

  emitEvent("payment:deleted", { transactionId: String(transaction._id), orderId: String(transaction.orderId), orderCode });

  res.json({ status: true, message: `Pembayaran ${orderCode} dihapus.`, data: { deleted: 1 } });
});

// ADMIN — DELETE /api/payments/admin/reset
// Menghapus SELURUH dokumen Transaction, bukan hanya yang sedang tampil.
const resetPaymentsAdmin = asyncHandler(async (req, res) => {
  const result = await Transaction.deleteMany({});
  const deleted = result.deletedCount || 0;

  logger.warn("SELURUH data pembayaran direset oleh admin", {
    adminId: String(req.admin._id),
    adminEmail: req.admin.email,
    deleted,
  });

  emitEvent("payments:reset", { deleted });

  res.json({
    status: true,
    message: deleted ? `${deleted} data pembayaran dihapus.` : "Tidak ada data pembayaran untuk dihapus.",
    data: { deleted },
  });
});

module.exports = {
  klikqrisWebhook,
  refreshStatus,
  sweepExpiredPayments,
  startExpirySweeper,
  deletePaymentAdmin,
  resetPaymentsAdmin,
};
