const jwt = require("jsonwebtoken");
const Admin = require("../models/Admin");
const asyncHandler = require("../utils/asyncHandler");
const { AppError } = require("../middlewares/errorHandler");
const { isValidEmail } = require("../utils/phone");
const logger = require("../utils/logger");
const { SESSION_MAX_AGE_MS } = require("../config/session");

function signToken(admin) {
  // Batas absolut session (spec: SESSION_MAX_AGE = 2 jam) — jwt.verify di
  // requireAdminAuth otomatis menolak token begitu klaim exp ini terlewati,
  // tidak ada logika expiry terpisah yang perlu ditulis ulang.
  return jwt.sign({ sub: admin._id.toString(), role: admin.role }, process.env.JWT_SECRET, {
    expiresIn: Math.floor(SESSION_MAX_AGE_MS / 1000),
  });
}

const login = asyncHandler(async (req, res) => {
  const { email, password } = req.body;
  if (!isValidEmail(email) || !password) {
    throw new AppError("Email dan password wajib diisi dengan benar.", 400);
  }

  const admin = await Admin.findOne({ email: email.toLowerCase().trim() });
  if (!admin || !admin.active) {
    throw new AppError("Email atau password salah.", 401);
  }

  const match = await admin.comparePassword(password);
  if (!match) {
    throw new AppError("Email atau password salah.", 401);
  }

  admin.lastLoginAt = new Date();
  admin.lastActivityAt = new Date();
  await admin.save();

  const token = signToken(admin);
  logger.info("Admin login success", { adminId: admin._id.toString() });

  res.json({ status: true, message: "Login berhasil", data: { token, admin } });
});

const me = asyncHandler(async (req, res) => {
  res.json({ status: true, data: { admin: req.admin } });
});

const changePassword = asyncHandler(async (req, res) => {
  const { currentPassword, newPassword } = req.body;
  if (!currentPassword || !newPassword || newPassword.length < 8) {
    throw new AppError("Password baru minimal 8 karakter.", 400);
  }
  const admin = await Admin.findById(req.admin._id);
  const match = await admin.comparePassword(currentPassword);
  if (!match) throw new AppError("Password lama salah.", 401);

  admin.passwordHash = await Admin.hashPassword(newPassword);
  await admin.save();
  res.json({ status: true, message: "Password berhasil diubah." });
});

module.exports = { login, me, changePassword };
