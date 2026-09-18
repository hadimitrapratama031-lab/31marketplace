const jwt = require("jsonwebtoken");
const Admin = require("../models/Admin");
const asyncHandler = require("../utils/asyncHandler");
const { SESSION_IDLE_TIMEOUT_MS } = require("../config/session");

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

  // Idle timeout divalidasi di backend juga (spec: "jangan hanya
  // mengandalkan JavaScript frontend") — token JWT sendiri hanya
  // membatasi umur ABSOLUT (SESSION_MAX_AGE), bukan idle. Setiap request
  // API terautentikasi dianggap aktivitas nyata (Admin Web tidak melakukan
  // polling REST di background — realtime sepenuhnya lewat Socket.IO, yang
  // tidak melewati middleware ini), jadi aman dipakai sebagai penanda.
  if (admin.lastActivityAt && Date.now() - admin.lastActivityAt.getTime() > SESSION_IDLE_TIMEOUT_MS) {
    return res.status(401).json({ status: false, message: "Unauthorized: session idle timeout" });
  }

  req.admin = admin;
  // Fire-and-forget — tidak memperlambat response, dan kegagalan tulis di
  // sini tidak boleh menggagalkan request yang sedang berjalan.
  Admin.updateOne({ _id: admin._id }, { $set: { lastActivityAt: new Date() } }).catch(() => {});
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
