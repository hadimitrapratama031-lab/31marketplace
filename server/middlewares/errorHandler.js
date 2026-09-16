const logger = require("../utils/logger");

// Central error handler. Customers never see stack traces, secrets, or
// internal paths (see spec section 36) — admins can check server logs.
function notFoundHandler(req, res) {
  res.status(404).json({ status: false, message: "Route not found" });
}

function errorHandler(err, req, res, _next) {
  // Multer (file upload) errors — both MulterError (e.g. file too large) and
  // the plain Error thrown from our fileFilter (unsupported mime type) —
  // are client mistakes, not server failures. Without this they fall through
  // to statusCode 500 and the real reason ("Tipe file tidak didukung...",
  // "File terlalu besar...") gets replaced by a generic message below,
  // making R2 upload failures look like a broken server instead of a bad file.
  if (err.name === "MulterError") {
    err.statusCode = 400;
    if (err.code === "LIMIT_FILE_SIZE") err.message = "Ukuran file terlalu besar. Maksimal 5MB.";
  } else if (/tipe file tidak didukung/i.test(err.message || "")) {
    err.statusCode = 400;
  }

  const statusCode = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;

  logger.error("Request failed", {
    path: req.originalUrl,
    method: req.method,
    statusCode,
    message: err.message,
  });

  const safeMessage =
    statusCode === 500 ? "Terjadi kesalahan pada server. Silakan coba lagi nanti." : err.message || "Request failed";

  res.status(statusCode).json({ status: false, message: safeMessage });
}

class AppError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.statusCode = statusCode;
  }
}

module.exports = { notFoundHandler, errorHandler, AppError };
