const Order = require("../models/Order");
const Transaction = require("../models/Transaction");
const asyncHandler = require("../utils/asyncHandler");
const { AppError } = require("../middlewares/errorHandler");

/* ============================================================================
   KEUNTUNGAN PER BULAN — backend sebagai satu-satunya sumber kebenaran.

   Semua angka di halaman ini keluar dari aggregation MongoDB di file ini.
   Admin Web tidak pernah menjumlahkan sendiri dari baris yang kebetulan sudah
   ter-load: halaman dipotong 25 baris, jadi menjumlahkan di frontend akan
   menghasilkan "total" yang berubah-ubah mengikuti halaman yang dibuka.

   TIGA FILTER YANG MENENTUKAN SEBUAH ORDER IKUT DIHITUNG
   ------------------------------------------------------
   1. Rentang waktu  : startOfMonth <= createdAt < startOfNextMonth, dihitung
                       pada timezone toko (APP_TZ / TZ, default Asia/Jakarta).
   2. Status         : hanya PAID / COMPLETED dengan paymentStatus SUCCESS.
                       PENDING, FAILED, EXPIRED, CANCELLED tidak pernah masuk.
   3. Environment    : hanya transaksi production. Transaksi sandbox KlikQRIS
                       dikecualikan lewat Transaction.environment, bukan lewat
                       pola order_id.

   SOAL "KEUNTUNGAN"
   -----------------
   Schema project ini TIDAK punya harga modal, harga beli, biaya produk, fee,
   margin, atau field profit — Product hanya punya `price`, dan Order hanya
   membekukan `price` + `total`. Jadi keuntungan tidak dikarang di sini:
   `costAvailable: false` dikirim apa adanya, dan Admin Web menampilkan
   "Data modal belum tersedia" di tempat angka keuntungan.

   Pendapatan yang dipakai adalah Order.total (harga jual × qty), BUKAN
   Transaction.totalAmount. totalAmount memuat kode unik yang ditambahkan
   KlikQRIS untuk pencocokan pembayaran; itu bukan pendapatan toko.
   ========================================================================= */

// Timezone toko. Dipakai baik untuk menghitung batas bulan maupun untuk
// mengelompokkan grafik harian, supaya transaksi jam 23:30 WIB pada tanggal 30
// tidak pernah jatuh ke bulan berikutnya karena selisih UTC.
function storeTimeZone() {
  return process.env.APP_TZ || process.env.TZ || "Asia/Jakarta";
}

/**
 * Awal bulan pada timezone toko, dikembalikan sebagai Date UTC yang benar.
 *
 * Kenapa tidak `new Date(year, month - 1, 1)`: konstruktor itu memakai timezone
 * PROSES. Di Railway proses berjalan pada UTC, jadi "1 September 00:00" versi
 * server sebenarnya "1 September 07:00 WIB" — dan seluruh transaksi antara jam
 * 00:00–07:00 WIB tanggal 1 hilang dari laporan bulan itu (masuk ke bulan
 * sebelumnya). Offset dihitung dari data timezone asli, jadi tetap benar untuk
 * zona apa pun dan tidak perlu di-hardcode +7.
 */
function startOfMonthUTC(year, month, timeZone) {
  const naive = Date.UTC(year, month - 1, 1, 0, 0, 0);
  const offsetMs = timeZoneOffsetMs(new Date(naive), timeZone);
  // Koreksi dua langkah: offset bisa berbeda di sekitar peralihan DST, dan
  // hasil langkah pertama sudah cukup dekat untuk mengambil offset yang tepat.
  const firstPass = new Date(naive - offsetMs);
  return new Date(naive - timeZoneOffsetMs(firstPass, timeZone));
}

// Selisih (ms) antara waktu dinding di `timeZone` dan UTC pada saat `date`.
function timeZoneOffsetMs(date, timeZone) {
  const dtf = new Intl.DateTimeFormat("en-US", {
    timeZone,
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
  const parts = dtf.formatToParts(date).reduce((acc, p) => {
    if (p.type !== "literal") acc[p.type] = Number(p.value);
    return acc;
  }, {});
  const asUTC = Date.UTC(parts.year, parts.month - 1, parts.day, parts.hour % 24, parts.minute, parts.second);
  return asUTC - date.getTime();
}

// Status yang dianggap "uang benar-benar masuk". Sengaja dicocokkan keduanya
// (status order DAN status pembayaran) supaya order yang statusnya sempat
// diubah manual tanpa pembayaran sukses tidak ikut terhitung.
const PAID_ORDER_STATUS = ["PAID", "COMPLETED"];
const PAID_PAYMENT_STATUS = ["SUCCESS"];

/**
 * Sub-pipeline pembeda production vs sandbox.
 *
 * Dokumen Transaction yang dibuat SEBELUM field `environment` ada tidak
 * memilikinya sama sekali. `$ifNull` memperlakukannya sebagai "production",
 * sama seperti default schema — jadi laporan tidak tiba-tiba kosong setelah
 * deploy. Untuk menandai transaksi sandbox lama, jalankan sekali:
 *   node server/scripts/backfillTransactionEnvironment.js
 *
 * Order tanpa Transaction sama sekali (pembuatan QRIS gagal) tidak mungkin
 * berstatus PAID, jadi $unwind tanpa preserveNull tidak membuang pendapatan
 * apa pun yang sah.
 */
function environmentStages() {
  return [
    {
      $lookup: {
        from: Transaction.collection.name,
        localField: "_id",
        foreignField: "orderId",
        as: "tx",
      },
    },
    { $unwind: { path: "$tx", preserveNullAndEmptyArrays: true } },
    {
      $addFields: {
        environment: { $ifNull: ["$tx.environment", "production"] },
      },
    },
    { $match: { environment: "production" } },
  ];
}

function monthMatch(start, end) {
  return {
    createdAt: { $gte: start, $lt: end },
    status: { $in: PAID_ORDER_STATUS },
    paymentStatus: { $in: PAID_PAYMENT_STATUS },
  };
}

/**
 * GET /api/orders/admin/profit?month=9&year=2026&page=1&limit=25
 *
 * Membaca, tidak pernah menulis. Mengganti filter bulan hanya mengubah rentang
 * $match — tidak ada satu pun operasi hapus di jalur ini, jadi data bulan lain
 * tetap utuh dan bisa dibuka lagi kapan saja.
 */
const monthlyProfit = asyncHandler(async (req, res) => {
  const now = new Date();
  const tz = storeTimeZone();

  const month = Number(req.query.month) || now.getMonth() + 1;
  const year = Number(req.query.year) || now.getFullYear();
  if (month < 1 || month > 12) throw new AppError("Bulan tidak valid.", 400);
  if (year < 2000 || year > 2100) throw new AppError("Tahun tidak valid.", 400);

  const page = Math.max(1, Number(req.query.page) || 1);
  const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 25));

  const start = startOfMonthUTC(year, month, tz);
  const end = startOfMonthUTC(month === 12 ? year + 1 : year, month === 12 ? 1 : month + 1, tz);

  const baseStages = [{ $match: monthMatch(start, end) }, ...environmentStages()];

  const [summaryAgg, rows, countAgg, years] = await Promise.all([
    Order.aggregate([
      ...baseStages,
      {
        $group: {
          _id: null,
          totalTransactions: { $sum: 1 },
          totalItems: { $sum: "$quantity" },
          totalRevenue: { $sum: "$total" },
        },
      },
    ]),
    Order.aggregate([
      ...baseStages,
      { $sort: { createdAt: -1 } },
      { $skip: (page - 1) * limit },
      { $limit: limit },
      {
        $project: {
          orderCode: 1,
          createdAt: 1,
          quantity: 1,
          total: 1,
          status: 1,
          paymentStatus: 1,
          "customer.name": 1,
          "customer.email": 1,
          "product.name": 1,
          paymentMethod: { $ifNull: ["$tx.paymentGateway", ""] },
          paidAt: "$tx.paidAt",
        },
      },
    ]),
    Order.aggregate([...baseStages, { $count: "total" }]),
    // Tahun mana saja yang benar-benar punya transaksi production sukses —
    // dipakai mengisi dropdown Tahun, supaya admin tidak bisa memilih tahun
    // yang memang tidak punya data sama sekali.
    Order.aggregate([
      {
        $match: {
          status: { $in: PAID_ORDER_STATUS },
          paymentStatus: { $in: PAID_PAYMENT_STATUS },
        },
      },
      ...environmentStages(),
      { $group: { _id: { $year: { date: "$createdAt", timezone: tz } } } },
      { $sort: { _id: -1 } },
    ]),
  ]);

  const summary = summaryAgg[0] || { totalTransactions: 0, totalItems: 0, totalRevenue: 0 };
  const total = countAgg[0] ? countAgg[0].total : 0;

  res.json({
    status: true,
    data: {
      period: { month, year, start, end, timeZone: tz },
      summary: {
        totalTransactions: summary.totalTransactions,
        totalItems: summary.totalItems,
        totalRevenue: summary.totalRevenue,
        // Tidak ada field modal/biaya/fee di schema mana pun, jadi keuntungan
        // tidak dihitung dari angka karangan. Admin Web menampilkan
        // "Data modal belum tersedia" saat flag ini false.
        costAvailable: false,
        totalProfit: null,
        marginPercent: null,
      },
      availableYears: years.map((y) => y._id).filter(Boolean),
      transactions: rows.map((row) => ({
        orderCode: row.orderCode,
        createdAt: row.createdAt,
        paidAt: row.paidAt || null,
        customerName: (row.customer && row.customer.name) || "",
        customerEmail: (row.customer && row.customer.email) || "",
        productName: (row.product && row.product.name) || "",
        quantity: row.quantity,
        revenue: row.total,
        profit: null,
        status: row.status,
        paymentStatus: row.paymentStatus,
        paymentMethod: row.paymentMethod === "KLIKQRIS" ? "QRIS" : row.paymentMethod || "",
      })),
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.max(1, Math.ceil(total / limit)),
      },
    },
  });
});

module.exports = { monthlyProfit };
