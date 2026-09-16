const Admin = require("../models/Admin");
const asyncHandler = require("../utils/asyncHandler");
const { AppError } = require("../middlewares/errorHandler");

// ADMIN (superadmin only) — manage other admin accounts.
const list = asyncHandler(async (req, res) => {
  const admins = await Admin.find().sort({ createdAt: 1 });
  res.json({ status: true, data: admins });
});

const create = asyncHandler(async (req, res) => {
  const { name, email, password, role } = req.body;
  if (!name || !email || !password || password.length < 8) {
    throw new AppError("Nama, email, dan password (min. 8 karakter) wajib diisi.", 400);
  }
  const exists = await Admin.findOne({ email: email.toLowerCase().trim() });
  if (exists) throw new AppError("Email sudah terdaftar.", 409);

  const passwordHash = await Admin.hashPassword(password);
  const admin = await Admin.create({ name, email: email.toLowerCase().trim(), passwordHash, role: role || "admin" });
  res.status(201).json({ status: true, data: admin });
});

const updateActive = asyncHandler(async (req, res) => {
  const { active } = req.body;
  const admin = await Admin.findByIdAndUpdate(req.params.id, { active }, { new: true });
  if (!admin) throw new AppError("Admin tidak ditemukan.", 404);
  res.json({ status: true, data: admin });
});

module.exports = { list, create, updateActive };
