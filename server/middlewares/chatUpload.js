const multer = require("multer");

/**
 * Upload foto Live Chat.
 *
 * Sengaja TERPISAH dari middlewares/upload.js yang dipakai katalog: upload
 * admin boleh menerima SVG dan ICO, chat tidak. SVG adalah dokumen XML yang
 * bisa memuat <script>, jadi file SVG yang diunggah pengunjung lalu dibuka
 * langsung di tab baru akan dieksekusi di domain toko. Chat hanya menerima
 * format raster.
 */
const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const MAX_BYTES = 5 * 1024 * 1024; // 5MB, sama dengan batas upload katalog

const chatUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_BYTES, files: 1 },
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      return cb(new Error("Tipe file tidak didukung. Kirim foto JPG, PNG, WEBP, atau GIF."));
    }
    // Ekstensi dicek juga supaya nama file tidak dipakai menyamarkan isi.
    if (!/\.(jpe?g|png|webp|gif)$/i.test(file.originalname || "")) {
      return cb(new Error("Ekstensi file tidak didukung. Kirim foto JPG, PNG, WEBP, atau GIF."));
    }
    cb(null, true);
  },
});

/**
 * Header Content-Type dan nama file keduanya berasal dari klien, jadi keduanya
 * bisa dipalsukan. Ini memeriksa byte pertama file: kalau isinya bukan gambar
 * raster sungguhan (mis. HTML atau skrip yang di-rename jadi .png), file
 * ditolak sebelum satu byte pun sampai ke R2.
 */
function sniffImageMime(buffer) {
  if (!buffer || buffer.length < 12) return null;

  if (buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.slice(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.slice(0, 6).toString("ascii") === "GIF87a" || buffer.slice(0, 6).toString("ascii") === "GIF89a") return "image/gif";
  if (buffer.slice(0, 4).toString("ascii") === "RIFF" && buffer.slice(8, 12).toString("ascii") === "WEBP") return "image/webp";

  return null;
}

module.exports = { chatUpload, sniffImageMime, ALLOWED_MIME, MAX_BYTES };
