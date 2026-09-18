const { S3Client } = require("@aws-sdk/client-s3");

// R2_PUBLIC_URL wajib ikut dicek: tanpa ini, uploadBuffer() tetap "berhasil"
// mengunggah file ke bucket tapi menghasilkan URL rusak (contoh: "/products/xxx.png"
// tanpa domain sama sekali), sehingga produk tersimpan tapi gambarnya tidak pernah
// bisa tampil di Admin Web maupun Marketplace — terlihat seperti "gambar kosong"
// padahal sebenarnya konfigurasi R2 belum lengkap. Lebih baik gagal jelas di sini.
function isR2Configured() {
  return Boolean(
    process.env.R2_ACCOUNT_ID &&
      process.env.R2_ACCESS_KEY_ID &&
      process.env.R2_SECRET_ACCESS_KEY &&
      process.env.R2_BUCKET_NAME &&
      process.env.R2_PUBLIC_URL
  );
}

function getR2Client() {
  if (!isR2Configured()) return null;
  return new S3Client({
    region: "auto",
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

// ROOT CAUSE (lihat laporan audit gambar September 2026): "pub-xxxx.r2.dev"
// adalah hostname PREVIEW/DEV bawaan Cloudflare, bukan domain produksi.
// Cloudflare sendiri menyatakan hostname ini "not intended for production
// usage" — punya rate limit variabel (throttle/429 setelah ratusan
// request/detik, tanpa cache di edge Cloudflare) dan sudah pernah dilaporkan
// diblokir oleh ISP tertentu di beberapa negara. Efeknya persis seperti yang
// dilaporkan: gambar tampil normal di satu PC/koneksi (trafik rendah, ISP
// yang tidak memblokir) tapi gagal untuk sebagian user lain (ISP berbeda,
// atau saat banyak request bersamaan kena throttle) — BUKAN masalah cache
// browser. Perbaikan produksi: pasang Custom Domain di Cloudflare R2
// (dashboard R2 > bucket > Settings > Public Access > Connect Domain), lalu
// arahkan R2_PUBLIC_URL ke domain itu. Lihat juga
// server/scripts/migrateR2PublicDomain.js untuk memindahkan URL yang sudah
// tersimpan di MongoDB.
function isR2DevPreviewUrl(url) {
  try {
    return /(^|\.)r2\.dev$/i.test(new URL(String(url)).hostname);
  } catch {
    return false;
  }
}

module.exports = { getR2Client, isR2Configured, isR2DevPreviewUrl };
