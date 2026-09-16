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

module.exports = { getR2Client, isR2Configured };
