const Order = require("../models/Order");
const Transaction = require("../models/Transaction");
const Product = require("../models/Product");
const asyncHandler = require("../utils/asyncHandler");
const { AppError } = require("../middlewares/errorHandler");
const { emitEvent } = require("../services/socket.service");
const klikqris = require("../services/klikqris.service");
const notificationService = require("../services/notification.service");
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

  const eventKey =
    newStatus === "PAID" ? "paymentSuccess" : newStatus === "FAILED" ? "paymentFailed" : newStatus === "EXPIRED" ? "paymentExpired" : null;
  if (eventKey) {
    await notificationService.notifyOrderEvent(order, eventKey).catch((err) =>
      logger.error("Notification failed after payment status change", { orderCode, message: err.message })
    );
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

module.exports = { klikqrisWebhook, refreshStatus };
