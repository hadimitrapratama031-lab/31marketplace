const mongoose = require("mongoose");
const Order = require("../models/Order");
const Transaction = require("../models/Transaction");
const Product = require("../models/Product");
const Customer = require("../models/Customer");
const NotificationLog = require("../models/NotificationLog");
const asyncHandler = require("../utils/asyncHandler");
const { AppError } = require("../middlewares/errorHandler");
const { generateOrderCode } = require("../utils/orderCode");
const { normalizeWhatsApp, isValidWhatsApp, isValidEmail } = require("../utils/phone");
const { emitEvent } = require("../services/socket.service");
const { resolveAssetUrl } = require("../utils/assetUrl");
const klikqris = require("../services/klikqris.service");
const notificationService = require("../services/notification.service");
const orderFeed = require("../services/orderFeed.service");
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

  const product = await Product.findById(productId).populate("categoryId", "name");
  if (!product || product.status !== "active") {
    throw new AppError("Produk tidak tersedia.", 404);
  }
  if (product.stock < qty) {
    throw new AppError("Stok produk tidak mencukupi.", 400);
  }

  const price = product.price; // source of truth, never trust frontend
  // KlikQRIS requires an Integer amount — round defensively here too, not
  // just inside the KlikQRIS client, so the Order/Transaction records store
  // the exact same whole-rupiah figure that was actually charged.
  const total = Math.round(price * qty);
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
    product: {
      productId: product._id,
      name: product.name,
      price,
      image: product.image,
      category: (product.categoryId && product.categoryId.name) || "",
      slug: product.slug || "",
    },
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

  // Dibaca dari resolusi konfigurasi yang sama dengan yang barusan menentukan
  // baseUrl transaksi di atas, lalu dibekukan di dokumen Transaction. Ini yang
  // nanti dipakai laporan keuntungan untuk membuang transaksi sandbox — bukan
  // pola order_id, dan bukan mode integrasi "saat laporan dibuka".
  const environment = await klikqris.getMode();

  const transaction = await Transaction.create({
    transactionId: order.orderCode,
    orderId: order._id,
    paymentGateway: "KLIKQRIS",
    environment,
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

  // Dipanggil SETELAH order dan transaction benar-benar tersimpan, sehingga
  // template punya batas waktu pembayaran dan link bayar yang asli. Antre di
  // latar belakang: pembeli tidak perlu menunggu dua panggilan provider
  // (Fonnte + Resend) sebelum halaman pembayaran terbuka, dan kegagalan
  // pengiriman tidak boleh menggagalkan checkout yang sudah sah. Jaminan
  // terkirimnya ada di NotificationLog, bukan di request ini.
  notificationService.queueOrderEvent(order, "orderCreated", { transaction });

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
            status: transaction.status,
            method: transaction.paymentGateway === "KLIKQRIS" ? "QRIS" : transaction.paymentGateway,
            paidAt: transaction.paidAt,
          }
        : null,
    },
  });
});

// PUBLIC — bahan tampilan pertama Floating Order Success di Marketplace.
// Hanya order yang pembayarannya benar-benar SUCCESS, dan sudah dipangkas oleh
// orderFeed.toPublicOrder(): tanpa email, nomor WhatsApp, atau kode order.
// Setelah muat pertama, kartu berikutnya datang lewat Socket.IO, bukan polling.
const recentSuccess = asyncHandler(async (req, res) => {
  const orders = await orderFeed.recentSuccessfulOrders({ limit: req.query.limit, withinHours: 72 });
  res.json({ status: true, data: orders });
});

// ADMIN — full order list with filters, real data from MongoDB.
const listAdmin = asyncHandler(async (req, res) => {
  const { status, paymentStatus, q, page = 1, limit = 25 } = req.query;
  const filter = {};
  if (status) filter.status = status;
  if (paymentStatus) filter.paymentStatus = paymentStatus;

  // Pencarian dipindahkan ke database. Sebelumnya Admin Web menyaring array
  // halaman yang sedang tampil, sehingga mencari order yang kebetulan ada di
  // halaman 7 selalu berakhir "tidak ditemukan".
  if (q && String(q).trim()) {
    const rx = new RegExp(String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [
      { orderCode: rx },
      { "customer.name": rx },
      { "customer.email": rx },
      { "customer.whatsapp": rx },
      { "product.name": rx },
    ];
  }

  const pageNum = Math.max(1, Number(page));
  const limitNum = Math.min(100, Math.max(1, Number(limit)));

  const [orders, total] = await Promise.all([
    Order.find(filter)
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum),
    Order.countDocuments(filter),
  ]);

  res.json({
    status: true,
    data: orders,
    pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.max(1, Math.ceil(total / limitNum)) },
  });
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

/* --------------------------------------------------- Cek Pesanan by email */

// Satu normalisasi untuk keduanya: penyimpanan (createOrder) dan pencarian.
// Kalau keduanya tidak memakai fungsi yang sama, "Budi@Mail.com " dengan spasi
// di ujung akan tersimpan tapi tidak pernah ketemu lagi.
function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

// Bentuk ringkas satu order untuk daftar hasil pencarian. Tidak pernah memuat
// kredensial, API key, token, signature, atau payload gateway mentah.
function toPublicSummary(order, transaction) {
  return {
    orderCode: order.orderCode,
    product: {
      name: order.product.name,
      image: resolveAssetUrl(order.product.image, "cekpesanan: order.product.image"),
      slug: order.product.slug || "",
    },
    quantity: order.quantity,
    total: transaction && transaction.totalAmount ? transaction.totalAmount : order.total,
    paymentMethod: transaction ? (transaction.paymentGateway === "KLIKQRIS" ? "QRIS" : transaction.paymentGateway) : "",
    status: order.status,
    paymentStatus: order.paymentStatus,
    createdAt: order.createdAt,
  };
}

// Order ID selalu disimpan dalam huruf kapital (generateOrderCode), jadi
// pencariannya tidak boleh case-sensitive terhadap apa yang diketik pembeli.
// Perbandingannya tetap EXACT — bukan regex, bukan prefix — sehingga "ORD-" saja
// tidak pernah membuka pesanan siapa pun.
function normalizeOrderCode(value) {
  return String(value || "").trim().toUpperCase();
}

// Sebuah string dianggap email hanya kalau benar-benar berbentuk email.
// Order ID tidak pernah mengandung "@", jadi pemisahan ini tidak ambigu dan
// pembeli cukup punya SATU kolom pencarian.
function looksLikeEmail(value) {
  return String(value || "").includes("@");
}

// "budi.santoso@gmail.com" -> "bud•••@gmail.com".
// Dipakai saat pesanan dibuka HANYA dengan Order ID: brief meminta email
// ditampilkan, tapi Order ID tercetak di halaman sukses, email notifikasi, dan
// riwayat browser — menampilkan alamat lengkapnya berarti siapa pun yang pernah
// melihat satu Order ID bisa memanen email pemiliknya.
function maskEmail(email) {
  const raw = String(email || "");
  const at = raw.indexOf("@");
  if (at < 1) return "";
  const name = raw.slice(0, at);
  const domain = raw.slice(at);
  const head = name.slice(0, Math.min(3, name.length));
  return head + "•••" + domain;
}

// Satu bentuk detail untuk semua jalur (email + Order ID, atau Order ID saja),
// sehingga UI tidak perlu tahu lewat mana pesanan itu ditemukan.
// Tidak pernah memuat signature, kredensial, atau payload gateway mentah.
function toPublicDetail(order, transaction, { revealEmail }) {
  return {
    orderCode: order.orderCode,
    customerName: order.customer.name || "",
    customerEmail: revealEmail ? order.customer.email : maskEmail(order.customer.email),
    emailMasked: !revealEmail,
    product: {
      name: order.product.name,
      image: resolveAssetUrl(order.product.image, "cekpesanan: order.product.image"),
      slug: order.product.slug || "",
      category: order.product.category || "",
    },
    quantity: order.quantity,
    price: order.product.price,
    total: transaction && transaction.totalAmount ? transaction.totalAmount : order.total,
    paymentMethod: transaction ? (transaction.paymentGateway === "KLIKQRIS" ? "QRIS" : transaction.paymentGateway) : "",
    status: order.status,
    paymentStatus: order.paymentStatus,
    createdAt: order.createdAt,
    paidAt: transaction ? transaction.paidAt || null : null,
    expiredAt: transaction ? transaction.expiredAt || null : null,
    // Link bayar hanya relevan (dan hanya aman) selama pesanan masih PENDING.
    payUrl: transaction && transaction.status === "PENDING" ? transaction.directUrl || transaction.qrisUrl || "" : "",
    qrisUrl: transaction && transaction.status === "PENDING" ? transaction.qrisUrl || "" : "",
  };
}

/**
 * POST /api/orders/search — SATU pintu untuk halaman Cek Pesanan.
 *
 * AKAR MASALAH yang diperbaiki di sini: halaman Cek Pesanan hanya punya satu
 * kolom bertipe email dan memvalidasinya sebagai email, sementara yang dipegang
 * pembeli setelah checkout adalah Order ID (dicetak di halaman sukses, email,
 * dan WhatsApp). Mengetik Order ID selalu berakhir "Format email tidak valid",
 * dan endpoint publik yang bisa mencari berdasarkan Order ID
 * (GET /orders/track/:orderCode) tidak pernah dipanggil halaman itu.
 *
 * Body menerima:
 *   { query }                 -> email ATAU Order ID, dideteksi dari isinya
 *   { query, email }          -> Order ID + email, dicocokkan keduanya
 *   { email } / { orderCode } -> bentuk eksplisit, untuk pemanggil lain
 *
 * Hasil:
 *   mode "email" -> { orders: [...] }  daftar seluruh pesanan atas email itu
 *   mode "order" -> { order: {...} }   detail satu pesanan
 */
const searchOrders = asyncHandler(async (req, res) => {
  const body = req.body || {};
  const raw = String(body.query || "").trim();
  const explicitEmail = normalizeEmail(body.email);
  const explicitCode = normalizeOrderCode(body.orderCode);

  // Apa yang diketik di kolom utama menentukan jalurnya; kolom email opsional
  // hanya menambah pembuktian kepemilikan, tidak pernah mengubah jalur.
  const queryIsEmail = raw && looksLikeEmail(raw);
  const email = queryIsEmail ? normalizeEmail(raw) : explicitEmail;
  const orderCode = queryIsEmail ? explicitCode : normalizeOrderCode(raw) || explicitCode;

  if (!email && !orderCode) {
    throw new AppError("Masukkan Order ID atau email yang dipakai saat checkout.", 400);
  }

  /* ---- Jalur 1: Order ID (dengan atau tanpa email) ---- */
  if (orderCode) {
    if (email && !isValidEmail(email)) throw new AppError("Format email tidak valid.", 400);

    // Filter exact. Kalau email ikut dikirim, ia jadi syarat tambahan —
    // bukan pengganti — sehingga kombinasi Order ID + email tetap didukung.
    const filter = { orderCode };
    if (email) filter["customer.email"] = email;

    const order = await Order.findOne(filter);
    // Pesan yang sama untuk "tidak ada" dan "bukan milik email ini": kalau
    // dibedakan, endpoint ini jadi alat untuk menebak Order ID mana yang valid.
    if (!order) {
      throw new AppError(
        email
          ? "Pesanan tidak ditemukan untuk Order ID dan email tersebut."
          : "Pesanan tidak ditemukan. Periksa kembali Order ID kamu.",
        404
      );
    }

    const transaction = await Transaction.findOne({ orderId: order._id });
    return res.json({
      status: true,
      data: { mode: "order", order: toPublicDetail(order, transaction, { revealEmail: Boolean(email) }) },
    });
  }

  /* ---- Jalur 2: email saja -> daftar pesanan ---- */
  if (!isValidEmail(email)) throw new AppError("Format email tidak valid.", 400);

  const orders = await Order.find({ "customer.email": email }).sort({ createdAt: -1 }).limit(50).lean();

  const transactions = orders.length
    ? await Transaction.find({ orderId: { $in: orders.map((o) => o._id) } })
        .select("orderId paymentGateway totalAmount")
        .lean()
    : [];
  const txByOrder = new Map(transactions.map((t) => [String(t.orderId), t]));

  res.json({
    status: true,
    data: {
      mode: "email",
      email,
      orders: orders.map((order) => toPublicSummary(order, txByOrder.get(String(order._id)))),
    },
  });
});

/**
 * POST /api/orders/lookup — mencari pesanan berdasarkan EMAIL pembeli.
 *
 * POST, bukan GET: alamat email tidak boleh berakhir di query string yang
 * ikut tercatat di access log Railway, riwayat browser, dan header Referer.
 *
 * MongoDB adalah satu-satunya sumber kebenaran di sini — halaman Cek Pesanan
 * tidak lagi bergantung pada apa pun yang tersimpan di LocalStorage.
 */
const lookupByEmail = asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body && req.body.email);
  if (!isValidEmail(email)) throw new AppError("Format email tidak valid.", 400);

  const orders = await Order.find({ "customer.email": email }).sort({ createdAt: -1 }).limit(50).lean();

  // Satu query untuk semua transaksi, bukan satu query per order.
  const transactions = orders.length
    ? await Transaction.find({ orderId: { $in: orders.map((o) => o._id) } })
        .select("orderId paymentGateway totalAmount")
        .lean()
    : [];
  const txByOrder = new Map(transactions.map((t) => [String(t.orderId), t]));

  res.json({
    status: true,
    data: {
      email,
      orders: orders.map((order) => toPublicSummary(order, txByOrder.get(String(order._id)))),
    },
  });
});

/**
 * POST /api/orders/detail — detail satu pesanan.
 *
 * Email ikut dikirim dan DICOCOKKAN dengan pemilik order. Tanpa itu, siapa pun
 * yang menebak kode order bisa membaca email dan riwayat pembelian orang lain;
 * kode order saja bukan rahasia — ia tercetak di halaman sukses dan di email.
 */
const getPublicDetail = asyncHandler(async (req, res) => {
  const email = normalizeEmail(req.body && req.body.email);
  const orderCode = String((req.body && req.body.orderCode) || "").trim().toUpperCase();
  if (!isValidEmail(email)) throw new AppError("Format email tidak valid.", 400);
  if (!orderCode) throw new AppError("Kode order wajib diisi.", 400);

  const order = await Order.findOne({ orderCode, "customer.email": email });
  // Pesan yang sama untuk "tidak ada" dan "bukan milik email ini" — kalau
  // dibedakan, endpoint ini jadi alat untuk menebak kode order mana yang valid.
  if (!order) throw new AppError("Pesanan tidak ditemukan untuk email tersebut.", 404);

  const transaction = await Transaction.findOne({ orderId: order._id });

  res.json({
    status: true,
    data: {
      orderCode: order.orderCode,
      customerEmail: order.customer.email,
      product: {
        name: order.product.name,
        image: resolveAssetUrl(order.product.image, "cekpesanan: order.product.image"),
        slug: order.product.slug || "",
        category: order.product.category || "",
      },
      quantity: order.quantity,
      price: order.product.price,
      total: transaction && transaction.totalAmount ? transaction.totalAmount : order.total,
      paymentMethod: transaction ? (transaction.paymentGateway === "KLIKQRIS" ? "QRIS" : transaction.paymentGateway) : "",
      status: order.status,
      paymentStatus: order.paymentStatus,
      createdAt: order.createdAt,
      paidAt: transaction ? transaction.paidAt || null : null,
      expiredAt: transaction ? transaction.expiredAt || null : null,
      // Link bayar hanya relevan (dan hanya aman) selama pesanan masih PENDING.
      // signature, rawCreateResponse, dan payload webhook tidak pernah keluar.
      payUrl: transaction && transaction.status === "PENDING" ? transaction.directUrl || transaction.qrisUrl || "" : "",
      qrisUrl: transaction && transaction.status === "PENDING" ? transaction.qrisUrl || "" : "",
    },
  });
});

/* ------------------------------------------------- ADMIN: hapus & reset order

   RELASI YANG DIPERIKSA SEBELUM MENGHAPUS (brief #11 & #15)
   ---------------------------------------------------------
   Yang menunjuk ke Order:
     Transaction.orderId     -> required: true   (satu order = satu transaksi)
     NotificationLog.orderId -> required: true   (kunci idempotensi per event)
   Yang TIDAK menunjuk ke Order:
     Customer  -> hanya dirujuk order lewat customerId, bukan sebaliknya
     Rating    -> berdiri sendiri, tidak punya referensi order
     Product   -> hanya di-snapshot ke dalam order

   Karena kedua referensi itu `required`, membiarkannya hidup setelah ordernya
   hilang menghasilkan dokumen yang skemanya sendiri menyatakan tidak valid —
   orphan yang tidak bisa dibaca, tidak bisa di-retry, dan ikut terhitung di
   halaman log notifikasi. Jadi keduanya ikut dihapus dalam operasi yang sama.

   Stok TIDAK dikembalikan: menghapus catatan penjualan bukan pembatalan
   penjualan, dan produk digital yang sudah dikirim tidak kembali ke stok.
   Ini disebutkan eksplisit di modal konfirmasi Admin Web.                     */

// Dipakai dua-duanya (hapus satu & reset semua) supaya aturan relasinya hanya
// ada di satu tempat dan tidak bisa berbeda antara kedua jalur.
async function purgeOrders(orderIds) {
  if (!orderIds.length) return { orders: 0, transactions: 0, notificationLogs: 0 };

  const [tx, logs, del] = await Promise.all([
    Transaction.deleteMany({ orderId: { $in: orderIds } }),
    NotificationLog.deleteMany({ orderId: { $in: orderIds } }),
    Order.deleteMany({ _id: { $in: orderIds } }),
  ]);

  return {
    orders: del.deletedCount || 0,
    transactions: tx.deletedCount || 0,
    notificationLogs: logs.deletedCount || 0,
  };
}

// ADMIN — DELETE /api/orders/admin/:id
const deleteAdmin = asyncHandler(async (req, res) => {
  const { id } = req.params;
  if (!mongoose.isValidObjectId(id)) throw new AppError("ID order tidak valid.", 400);

  const order = await Order.findById(id);
  if (!order) throw new AppError("Order tidak ditemukan.", 404);

  const removed = await purgeOrders([order._id]);

  logger.warn("Order dihapus permanen oleh admin", {
    orderCode: order.orderCode,
    adminId: String(req.admin._id),
    adminEmail: req.admin.email,
    removed,
  });

  // Disiarkan SETELAH penghapusan benar-benar selesai, memakai Socket.IO yang
  // sudah ada — bukan sistem realtime baru.
  emitEvent("order:deleted", { orderId: String(order._id), orderCode: order.orderCode });

  // Kalau order ini sedang tampil di Floating Order Success pengunjung
  // Marketplace, kartunya ikut ditarik. Tanpa ini, order yang sudah tidak ada
  // di database tetap berputar di browser yang kebetulan sedang terbuka
  // sampai halamannya dimuat ulang.
  if (orderFeed.isSuccessful(order)) {
    emitEvent("order:success:revoked", { id: orderFeed.publicId(order._id) });
  }

  res.json({ status: true, message: `Pesanan ${order.orderCode} dihapus.`, data: removed });
});

// ADMIN — DELETE /api/orders/admin/reset
// Menghapus SELURUH order di database, bukan hanya yang sedang tampil di
// halaman Admin Web. Tidak menerima nama collection atau filter apa pun dari
// frontend: cakupannya ditentukan di sini, tetap.
const resetAllAdmin = asyncHandler(async (req, res) => {
  // status/paymentStatus ikut diambil supaya kartu Floating Order Success yang
  // sedang berputar di browser pengunjung bisa ditarik satu per satu di bawah.
  const docs = await Order.find().select("_id status paymentStatus").lean();
  const removed = await purgeOrders(docs.map((o) => o._id));

  logger.warn("SELURUH pesanan direset oleh admin", {
    adminId: String(req.admin._id),
    adminEmail: req.admin.email,
    removed,
  });

  emitEvent("orders:reset", { deleted: removed.orders });

  docs.filter((o) => orderFeed.isSuccessful(o)).forEach((o) => {
    emitEvent("order:success:revoked", { id: orderFeed.publicId(o._id) });
  });

  res.json({
    status: true,
    message: removed.orders ? `${removed.orders} pesanan dihapus.` : "Tidak ada pesanan untuk dihapus.",
    data: removed,
  });
});

module.exports = {
  createOrder,
  getByOrderCode,
  searchOrders,
  lookupByEmail,
  getPublicDetail,
  recentSuccess,
  listAdmin,
  summaryAdmin,
  getAdminById,
  deleteAdmin,
  resetAllAdmin,
};
