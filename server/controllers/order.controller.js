const mongoose = require("mongoose");
const Order = require("../models/Order");
const Transaction = require("../models/Transaction");
const Product = require("../models/Product");
const Customer = require("../models/Customer");
const asyncHandler = require("../utils/asyncHandler");
const { AppError } = require("../middlewares/errorHandler");
const { generateOrderCode } = require("../utils/orderCode");
const { normalizeWhatsApp, isValidWhatsApp, isValidEmail } = require("../utils/phone");
const { emitEvent } = require("../services/socket.service");
const klikqris = require("../services/klikqris.service");
const notificationService = require("../services/notification.service");
const logger = require("../utils/logger");

// PUBLIC — Customer checkout.
// Frontend may only send productId, quantity, name, email, whatsapp.
// Price/name/stock/category/status are ALWAYS re-read from MongoDB here (spec section 9).
const createOrder = asyncHandler(async (req, res) => {
  const { productId, quantity, name, email, whatsapp } = req.body;

  if (!productId || !mongoose.isValidObjectId(productId)) {
    throw new AppError("Produk tidak valid.", 400);
  }
  const qty = Number(quantity) || 1;
  if (qty < 1) throw new AppError("Jumlah pembelian tidak valid.", 400);

  if (!isValidEmail(email)) throw new AppError("Format email tidak valid.", 400);
  if (!isValidWhatsApp(whatsapp)) throw new AppError("Format nomor WhatsApp tidak valid.", 400);
  const normalizedWhatsApp = normalizeWhatsApp(whatsapp);

  const product = await Product.findById(productId);
  if (!product || product.status !== "active") {
    throw new AppError("Produk tidak tersedia.", 404);
  }
  if (product.stock < qty) {
    throw new AppError("Stok produk tidak mencukupi.", 400);
  }

  const price = product.price; // source of truth, never trust frontend
  const total = price * qty;
  const orderCode = generateOrderCode();

  const customer = await Customer.findOneAndUpdate(
    { email: email.toLowerCase().trim() },
    {
      $set: { name: name || "", whatsapp: normalizedWhatsApp },
      $inc: { totalOrders: 1 },
    },
    { upsert: true, new: true, setDefaultsOnInsert: true }
  );

  const order = await Order.create({
    orderCode,
    customer: { name: name || "", email: email.toLowerCase().trim(), whatsapp: normalizedWhatsApp },
    customerId: customer._id,
    product: { productId: product._id, name: product.name, price, image: product.image },
    quantity: qty,
    total,
    status: "PENDING",
    paymentStatus: "PENDING",
  });

  emitEvent("order:created", { orderId: order._id, orderCode: order.orderCode });

  // Create KlikQRIS transaction using orderCode as external order_id.
  let kqData;
  try {
    kqData = await klikqris.createTransaction({
      orderId: order.orderCode,
      amount: total,
      keterangan: `Pembayaran ${product.name} x${qty} - ${order.orderCode}`,
    });
  } catch (err) {
    // Keep the order as PENDING so admin can retry payment creation; surface a clean error.
    // The real HTTP status / gateway response body is already logged inside
    // klikqris.service.js at the point the failure happened — this just
    // records which order it was for for cross-referencing.
    logger.error("Failed to create KlikQRIS transaction for order", {
      orderCode: order.orderCode,
      statusCode: err.statusCode,
      message: err.message,
    });
    throw err;
  }

  const transaction = await Transaction.create({
    transactionId: order.orderCode,
    orderId: order._id,
    paymentGateway: "KLIKQRIS",
    externalPaymentId: kqData.order_id,
    amount: total,
    totalAmount: Number(kqData.total_amount),
    qrisUrl: kqData.qris_url || "",
    directUrl: kqData.redirect_url || kqData.direct_url || "",
    signature: kqData.signature || "",
    status: "PENDING",
    expiredAt: kqData.expired_at ? new Date(kqData.expired_at) : undefined,
    rawCreateResponse: kqData,
  });

  await notificationService.notifyOrderEvent(order, "orderCreated").catch((err) =>
    logger.error("orderCreated notification failed", { orderCode: order.orderCode, message: err.message })
  );

  res.status(201).json({
    status: true,
    data: {
      order,
      payment: {
        orderId: transaction.transactionId,
        amount: transaction.amount,
        totalAmount: transaction.totalAmount,
        qrisUrl: transaction.qrisUrl,
        directUrl: transaction.directUrl,
        expiredAt: transaction.expiredAt,
        signature: transaction.signature,
        status: transaction.status,
      },
    },
  });
});

// PUBLIC — Cek Pesanan lookup by orderCode.
const getByOrderCode = asyncHandler(async (req, res) => {
  const order = await Order.findOne({ orderCode: req.params.orderCode.trim().toUpperCase() });
  if (!order) throw new AppError("Order tidak ditemukan. Periksa kembali kode order Anda.", 404);
  const transaction = await Transaction.findOne({ orderId: order._id });
  res.json({
    status: true,
    data: {
      orderCode: order.orderCode,
      product: order.product,
      quantity: order.quantity,
      total: order.total,
      status: order.status,
      paymentStatus: order.paymentStatus,
      createdAt: order.createdAt,
      payment: transaction
        ? {
            qrisUrl: transaction.status === "PENDING" ? transaction.qrisUrl : null,
            directUrl: transaction.directUrl,
            expiredAt: transaction.expiredAt,
            totalAmount: transaction.totalAmount,
          }
        : null,
    },
  });
});

// ADMIN — full order list with filters, real data from MongoDB.
const listAdmin = asyncHandler(async (req, res) => {
  const { status, paymentStatus, page = 1, limit = 30 } = req.query;
  const filter = {};
  if (status) filter.status = status;
  if (paymentStatus) filter.paymentStatus = paymentStatus;

  const pageNum = Math.max(1, Number(page));
  const limitNum = Math.min(100, Math.max(1, Number(limit)));

  const [orders, total] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum),
    Order.countDocuments(filter),
  ]);

  res.json({ status: true, data: orders, pagination: { page: pageNum, limit: limitNum, total } });
});

// ADMIN — dashboard aggregates. Every number (including the month-over-month
// delta and the 7-day mini chart) is computed from real Order documents.
const summaryAdmin = asyncHandler(async (req, res) => {
  const now = new Date();
  const startThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startPrevMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const startOf7Days = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 6);

  const sumPaid = (extraMatch = {}) =>
    Order.aggregate([
      { $match: { status: "PAID", ...extraMatch } },
      { $group: { _id: null, revenue: { $sum: "$total" }, count: { $sum: 1 } } },
    ]);

  const [allTime, thisMonth, prevMonth, statusCounts, ordersThisMonth, ordersPrevMonth, dailyAgg, pendingCount] =
    await Promise.all([
      sumPaid(),
      sumPaid({ createdAt: { $gte: startThisMonth } }),
      sumPaid({ createdAt: { $gte: startPrevMonth, $lt: startThisMonth } }),
      Order.aggregate([{ $group: { _id: "$status", count: { $sum: 1 } } }]),
      Order.countDocuments({ createdAt: { $gte: startThisMonth } }),
      Order.countDocuments({ createdAt: { $gte: startPrevMonth, $lt: startThisMonth } }),
      Order.aggregate([
        { $match: { status: "PAID", createdAt: { $gte: startOf7Days } } },
        {
          $group: {
            _id: { $dateToString: { format: "%Y-%m-%d", date: "$createdAt", timezone: process.env.TZ || "Asia/Jakarta" } },
            revenue: { $sum: "$total" },
          },
        },
      ]),
      Order.countDocuments({ paymentStatus: "PENDING" }),
    ]);

  const byStatus = statusCounts.reduce((acc, row) => ({ ...acc, [row._id]: row.count }), {});
  const totalOrders = statusCounts.reduce((acc, row) => acc + row.count, 0);

  const revenueThisMonth = thisMonth[0]?.revenue || 0;
  const revenuePrevMonth = prevMonth[0]?.revenue || 0;
  const revenueDelta = revenuePrevMonth > 0 ? ((revenueThisMonth - revenuePrevMonth) / revenuePrevMonth) * 100 : null;
  const ordersDelta = ordersPrevMonth > 0 ? ((ordersThisMonth - ordersPrevMonth) / ordersPrevMonth) * 100 : null;

  // Build a dense 7-day series so the chart has no gaps.
  const dailyMap = dailyAgg.reduce((acc, row) => ({ ...acc, [row._id]: row.revenue }), {});
  const daily = [];
  for (let i = 6; i >= 0; i -= 1) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    daily.push({ date: key, revenue: dailyMap[key] || 0 });
  }

  res.json({
    status: true,
    data: {
      totalRevenue: allTime[0]?.revenue || 0,
      paidOrders: allTime[0]?.count || 0,
      totalOrders,
      byStatus,
      pendingPayments: pendingCount,
      revenueThisMonth,
      revenuePrevMonth,
      revenueDeltaPercent: revenueDelta === null ? null : Number(revenueDelta.toFixed(1)),
      ordersThisMonth,
      ordersPrevMonth,
      ordersDeltaPercent: ordersDelta === null ? null : Number(ordersDelta.toFixed(1)),
      daily,
    },
  });
});

const getAdminById = asyncHandler(async (req, res) => {
  const order = await Order.findById(req.params.id);
  if (!order) throw new AppError("Order tidak ditemukan.", 404);
  const transaction = await Transaction.findOne({ orderId: order._id });
  res.json({ status: true, data: { order, transaction } });
});

module.exports = { createOrder, getByOrderCode, listAdmin, summaryAdmin, getAdminById };
