// Satu sumber tunggal untuk durasi session Admin Web — dipakai oleh
// auth.controller.js (JWT expiresIn = batas absolut) dan
// middlewares/auth.js (validasi idle timeout di backend, bukan hanya
// frontend). Selaras dengan admin/session.js di sisi client.
//
// Kalau nanti nilainya perlu berubah, ubah DI SINI SAJA — jangan menulis
// angka 2 jam di banyak file (spec).
const SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000; // batas absolut sejak login
const SESSION_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // tanpa aktivitas nyata

module.exports = { SESSION_MAX_AGE_MS, SESSION_IDLE_TIMEOUT_MS };
