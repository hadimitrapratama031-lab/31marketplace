/**
 * Floating Order Success — bentuk publik dari order yang BENAR-BENAR berhasil.
 *
 * Satu-satunya sumber datanya adalah dokumen Order di MongoDB. Tidak ada
 * customer palsu, tidak ada produk contoh, tidak ada angka acak: kalau tidak
 * ada order yang lunas, notifikasinya memang tidak muncul.
 *
 * APA YANG DIBUANG SEBELUM DISIARKAN
 * ----------------------------------
 * Payload ini disiarkan ke SEMUA pengunjung, jadi isinya dipangkas sampai ke
 * yang aman dilihat publik:
 *
 *   dibuang  email, nomor WhatsApp, customerId, orderCode
 *   disamar  nama pembeli -> nama depan + inisial ("Hadi Saputra" -> "Hadi S.")
 *   dipakai  nama produk, gambar produk, slug, total, waktu bayar
 *
 * `orderCode` sengaja tidak ikut: endpoint publik GET /api/orders/track/:code
 * membalas detail order lengkap untuk siapa pun yang tahu kodenya, jadi
 * menyiarkan kode itu ke seluruh pengunjung sama dengan membocorkan pesanan
 * orang lain. Untuk kebutuhan dedupe di browser dipakai `id` hasil hash HMAC
 * yang stabil tapi tidak bisa dibalik jadi kode order.
 */

const crypto = require("crypto");
const Order = require("../models/Order");
const logger = require("../utils/logger");

const SUCCESS_PAYMENT_STATUS = "SUCCESS";
const SUCCESS_ORDER_STATUS = ["PAID", "COMPLETED"];

/** ID publik yang stabil per order, tapi tidak bisa dikembalikan jadi orderCode. */
function publicId(orderId) {
  const secret = process.env.JWT_SECRET || "order-feed";
  return crypto.createHmac("sha256", secret).update(`orderfeed:${orderId}`).digest("hex").slice(0, 16);
}

/**
 * Nama yang aman ditampilkan. Nama belakang dipotong jadi inisial supaya
 * social proof tetap terasa nyata tanpa memajang identitas penuh pembeli.
 */
function safeDisplayName(raw) {
  const clean = String(raw || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return "Pembeli";

  const parts = clean.split(" ").filter(Boolean);
  const first = parts[0].slice(0, 20);
  if (parts.length === 1) return first;
  const initial = parts[parts.length - 1].charAt(0).toUpperCase();
  return `${first} ${initial}.`;
}

/** Order (dokumen atau lean object) -> payload publik floating order. */
function toPublicOrder(order) {
  if (!order) return null;
  const product = order.product || {};
  return {
    id: publicId(order._id),
    customerName: safeDisplayName(order.customer && order.customer.name),
    productName: product.name || "Produk",
    productImage: product.image || "",
    productSlug: product.slug || "",
    quantity: Number(order.quantity) || 1,
    // Harga transaksi yang sebenarnya dibayar, bukan harga katalog hari ini.
    total: Number(order.total) || 0,
    status: "SUCCESS",
    paidAt: order.paidAt || order.updatedAt || order.createdAt,
  };
}

/** True hanya untuk order yang pembayarannya sudah benar-benar terverifikasi. */
function isSuccessful(order) {
  if (!order) return false;
  return order.paymentStatus === SUCCESS_PAYMENT_STATUS && SUCCESS_ORDER_STATUS.includes(order.status);
}

/**
 * Order sukses yang sudah ada, untuk mengisi antrean carousel saat Marketplace
 * dibuka — bukan cuma order yang kebetulan terjadi selagi halaman terbuka.
 *
 * Ini tetap data asli. Kartunya menampilkan waktu relatif ("2 jam lalu") supaya
 * order lama tidak menyamar sebagai pembelian yang baru saja terjadi.
 */
async function recentSuccessfulOrders({ limit = 20, withinHours = 720 } = {}) {
  const since = new Date(Date.now() - withinHours * 60 * 60 * 1000);

  try {
    const orders = await Order.find({
      paymentStatus: SUCCESS_PAYMENT_STATUS,
      status: { $in: SUCCESS_ORDER_STATUS },
      updatedAt: { $gte: since },
    })
      .sort({ updatedAt: -1 })
      .limit(Math.min(Math.max(Number(limit) || 20, 1), 30))
      .select("customer.name product quantity total status paymentStatus createdAt updatedAt")
      .lean();

    return orders.map(toPublicOrder).filter(Boolean);
  } catch (err) {
    logger.error("Gagal membaca riwayat order sukses", { message: err.message });
    return [];
  }
}

module.exports = {
  toPublicOrder,
  isSuccessful,
  safeDisplayName,
  recentSuccessfulOrders,
  publicId,
};
