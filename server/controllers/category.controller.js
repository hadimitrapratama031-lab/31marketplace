const Category = require("../models/Category");
const Product = require("../models/Product");
const asyncHandler = require("../utils/asyncHandler");
const { AppError } = require("../middlewares/errorHandler");
const { emitEvent } = require("../services/socket.service");

function slugify(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// PUBLIC
const listPublic = asyncHandler(async (req, res) => {
  const categories = await Category.find({ status: "active" }).sort({ sortOrder: 1, createdAt: 1 });
  res.json({ status: true, data: categories });
});

// ADMIN
const listAdmin = asyncHandler(async (req, res) => {
  const categories = await Category.find().sort({ sortOrder: 1, createdAt: 1 });
  res.json({ status: true, data: categories });
});

const create = asyncHandler(async (req, res) => {
  const { name, icon, description, status, sortOrder } = req.body;
  if (!name) throw new AppError("Nama kategori wajib diisi.", 400);

  let slug = slugify(name);
  const exists = await Category.findOne({ slug });
  if (exists) slug = `${slug}-${Date.now().toString(36)}`;

  const category = await Category.create({
    name,
    slug,
    icon: icon || "",
    description: description || "",
    status: status || "active",
    sortOrder: sortOrder || 0,
  });

  emitEvent("categories:updated", { action: "created", category });
  res.status(201).json({ status: true, data: category });
});

const update = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const category = await Category.findById(id);
  if (!category) throw new AppError("Kategori tidak ditemukan.", 404);

  const { name, icon, description, status, sortOrder } = req.body;
  if (name && name !== category.name) {
    category.name = name;
  }
  if (icon !== undefined) category.icon = icon;
  if (description !== undefined) category.description = description;
  if (status !== undefined) category.status = status;
  if (sortOrder !== undefined) category.sortOrder = sortOrder;

  await category.save();
  emitEvent("categories:updated", { action: "updated", category });
  res.json({ status: true, data: category });
});

const remove = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const inUse = await Product.exists({ categoryId: id });
  if (inUse) throw new AppError("Kategori masih dipakai oleh produk. Hapus/ubah produk terlebih dahulu.", 400);

  const category = await Category.findByIdAndDelete(id);
  if (!category) throw new AppError("Kategori tidak ditemukan.", 404);

  emitEvent("categories:updated", { action: "deleted", categoryId: id });
  res.json({ status: true, message: "Kategori dihapus." });
});

module.exports = { listPublic, listAdmin, create, update, remove };
