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

// Live Chat. Tiga batas terpisah karena bobotnya berbeda: membuat sesi baru
// itu murah untuk penyerang tapi bikin sampah thread, upload foto memakai
// bandwidth + kuota R2, sedangkan mengetik pesan harus tetap terasa lancar
// untuk pembeli yang memang sedang bertanya. Batas per percakapan ada
// terpisah di chat.controller (assertNotFlooding) supaya satu sesi tidak bisa
// membanjiri admin dari banyak IP sekaligus.
const chatSessionLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: false, message: "Terlalu banyak sesi chat baru. Coba lagi nanti." },
});

const chatMessageLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: false, message: "Terlalu banyak pesan. Tunggu sebentar." },
});

const chatUploadLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  limit: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { status: false, message: "Terlalu banyak upload foto. Coba lagi beberapa menit lagi." },
});

const publicApiLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 120,
  standardHeaders: true,
  legacyHeaders: false,
});

module.exports = {
  authLimiter,
  checkoutLimiter,
  lookupLimiter,
  chatSessionLimiter,
  chatMessageLimiter,
  chatUploadLimiter,
  publicApiLimiter,
};
