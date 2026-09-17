// Domain gratisan (Gmail/Yahoo/Outlook/dkk.) tidak pernah boleh dipakai
// sebagai alamat "From" toko: domain ini tidak bisa diautentikasi
// (SPF/DKIM/DMARC) atas nama toko di Resend, dan "From: toko@gmail.com" yang
// dikirim lewat server Resend selalu terlihat seperti spoofing bagi mail
// server penerima — salah satu penyebab paling umum email transaksional
// masuk folder Spam. Dipakai bersama oleh resend.service.js (saat mengirim)
// dan integration.service.js (saat admin menyimpan konfigurasi), jadi hanya
// didefinisikan satu kali di sini.
const FREEMAIL_DOMAINS = new Set([
  "gmail.com",
  "googlemail.com",
  "yahoo.com",
  "yahoo.co.id",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "icloud.com",
  "aol.com",
  "protonmail.com",
  "proton.me",
]);

function isFreemailAddress(email) {
  const domain = String(email || "").split("@")[1];
  return Boolean(domain) && FREEMAIL_DOMAINS.has(domain.toLowerCase());
}

module.exports = { FREEMAIL_DOMAINS, isFreemailAddress };
