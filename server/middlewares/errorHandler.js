const logger = require("../utils/logger");

// Central error handler. Customers never see stack traces, secrets, or
// internal paths (see spec section 36) — admins can check server logs.
function notFoundHandler(req, res) {
  res.status(404).json({ status: false, message: "Route not found" });
}

function errorHandler(err, req, res, _next) {
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
