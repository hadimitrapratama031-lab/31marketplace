/**
 * Batas waktu pembayaran Marketplace: 10 MENIT, dihitung dari saat transaksi
 * dibuat, dan disimpan sebagai timestamp absolut di Transaction.expiredAt.
 *
 * KENAPA ADA FILE INI
 * -------------------
 * Sebelumnya expiredAt diambil apa adanya dari `expired_at` milik KlikQRIS.
 * Dua akibatnya:
 *   1. Kalau gateway tidak mengirim field itu (atau mengirim tanggal yang tidak
 *      bisa diparse), `expiredAt` menjadi undefined — countdown di halaman
 *      pembayaran tidak muncul sama sekali, dan sweeper kedaluwarsa melewati
 *      transaksi itu karena querynya menyaring `expiredAt: { $ne: null }`.
 *      Transaksi seperti itu menggantung PENDING selamanya.
 *   2. Kalau gateway memberi tenggat lebih panjang (umumnya jauh lebih dari 10
 *      menit), batas waktu toko ikut molor — padahal stok ditahan selama order
 *      masih PENDING.
 *
 * Jadi tenggat toko dihitung sendiri, dan tenggat gateway hanya dipakai kalau
 * ia LEBIH CEPAT. Menetapkan tenggat lebih lama dari gateway tidak ada gunanya:
 * QRIS-nya sendiri sudah tidak bisa dibayar.
 *
 * Semua yang ditampilkan ke pembeli (countdown) dan semua yang mengubah status
 * (sweeper, refresh, pembacaan order) membaca timestamp yang SATU ini, bukan
 * menghitung sendiri dari Date.now() di masing-masing tempat.
 */

const PAYMENT_WINDOW_MINUTES = 10;
const PAYMENT_WINDOW_MS = PAYMENT_WINDOW_MINUTES * 60 * 1000;

/**
 * @param {string|Date|undefined} gatewayExpiry nilai expired_at dari provider
 * @param {Date} [from] titik mulai; default sekarang
 * @returns {Date} tenggat yang benar-benar berlaku
 */
function resolvePaymentExpiry(gatewayExpiry, from) {
  const start = from instanceof Date && !Number.isNaN(from.getTime()) ? from : new Date();
  const storeDeadline = new Date(start.getTime() + PAYMENT_WINDOW_MS);

  if (!gatewayExpiry) return storeDeadline;

  const parsed = new Date(gatewayExpiry);
  if (Number.isNaN(parsed.getTime())) return storeDeadline;

  return parsed < storeDeadline ? parsed : storeDeadline;
}

/** true kalau tenggat sudah benar-benar lewat menurut jam server. */
function isExpired(expiredAt, now) {
  if (!expiredAt) return false;
  const deadline = expiredAt instanceof Date ? expiredAt : new Date(expiredAt);
  if (Number.isNaN(deadline.getTime())) return false;
  return deadline.getTime() <= (now ? now.getTime() : Date.now());
}

module.exports = { PAYMENT_WINDOW_MINUTES, PAYMENT_WINDOW_MS, resolvePaymentExpiry, isExpired };
