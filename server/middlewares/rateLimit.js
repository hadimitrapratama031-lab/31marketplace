const rateLimit = require("express-rate-limit");

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: false, message: "Terlalu banyak percobaan. Coba lagi nanti." },
});

const checkoutLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: false, message: "Terlalu banyak percobaan checkout. Coba lagi nanti." },
});

// Cek Pesanan menerima email dan membalas "ada / tidak ada". Tanpa batas, itu
// jadi cara memeriksa alamat mana saja yang pernah berbelanja di sini.
const lookupLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: false, message: "Terlalu banyak pencarian pesanan. Coba lagi beberapa menit lagi." },
});

const publicApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = { authLimiter, checkoutLimiter, lookupLimiter, publicApiLimiter };
