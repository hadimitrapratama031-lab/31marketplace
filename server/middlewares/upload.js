const multer = require("multer");

const storage = multer.memoryStorage();

const ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/svg+xml", "image/x-icon"];

const upload = multer({
  storage,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5MB
  fileFilter: (req, file, cb) => {
    if (!ALLOWED_MIME.includes(file.mimetype)) {
      return cb(new Error("Tipe file tidak didukung. Gunakan JPG, PNG, WEBP, GIF, atau SVG."));
    }
    cb(null, true);
  },
});

module.exports = upload;
