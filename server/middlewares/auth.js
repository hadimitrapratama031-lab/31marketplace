const jwt = require("jsonwebtoken");
const Admin = require("../models/Admin");
const asyncHandler = require("../utils/asyncHandler");

// Protects Admin Web API routes. Expects "Authorization: Bearer <jwt>".
const requireAdminAuth = asyncHandler(async (req, res, next) => {
  const header = req.headers.authorization || "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : null;

  if (!token) {
    return res.status(401).json({ status: false, message: "Unauthorized: missing token" });
  }

  let decoded;
  try {
    decoded = jwt.verify(token, process.env.JWT_SECRET);
  } catch (err) {
    return res.status(401).json({ status: false, message: "Unauthorized: invalid or expired token" });
  }

  const admin = await Admin.findById(decoded.sub);
  if (!admin || !admin.active) {
    return res.status(401).json({ status: false, message: "Unauthorized: account not found or disabled" });
  }

  req.admin = admin;
  next();
});

function requireRole(...roles) {
  return (req, res, next) => {
    if (!req.admin || !roles.includes(req.admin.role)) {
      return res.status(403).json({ status: false, message: "Forbidden" });
    }
    next();
  };
}

module.exports = { requireAdminAuth, requireRole };
