const Product = require("../models/Product");
const Category = require("../models/Category");
const asyncHandler = require("../utils/asyncHandler");
const { AppError } = require("../middlewares/errorHandler");
const { emitEvent } = require("../services/socket.service");
const r2Service = require("../services/r2.service");

function slugify(text) {
  return String(text)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

// PUBLIC — never leaks internal fields, no fake data, MongoDB is the source of truth.
const listPublic = asyncHandler(async (req, res) => {
  const { category } = req.query;
  const filter = { status: "active" };
  if (category) {
    const cat = await Category.findOne({ slug: category, status: "active" });
    if (!cat) return res.json({ status: true, data: [] });
    filter.categoryId = cat._id;
  }
  const products = await Product.find(filter).sort({ sortOrder: 1, createdAt: -1 }).populate("categoryId", "name slug");
  res.json({ status: true, data: products });
});

const getPublicBySlug = asyncHandler(async (req, res) => {
  const product = await Product.findOne({ slug: req.params.slug, status: "active" }).populate("categoryId", "name slug");
  if (!product) throw new AppError("Produk tidak ditemukan.", 404);
  res.json({ status: true, data: product });
});

// ADMIN
const listAdmin = asyncHandler(async (req, res) => {
  const products = await Product.find().sort({ sortOrder: 1, createdAt: -1 }).populate("categoryId", "name slug");
  res.json({ status: true, data: products });
});

const create = asyncHandler(async (req, res) => {
  const { name, categoryId, description, price, stock, status, sortOrder } = req.body;
  if (!name || !categoryId || price === undefined || stock === undefined) {
    throw new AppError("Nama, kategori, harga, dan stok wajib diisi.", 400);
  }
  const category = await Category.findById(categoryId);
  if (!category) throw new AppError("Kategori tidak ditemukan.", 400);

  let slug = slugify(name);
  const exists = await Product.findOne({ slug });
  if (exists) slug = `${slug}-${Date.now().toString(36)}`;

  let image = "";
  let imageKey = "";
  if (req.file) {
    const uploaded = await r2Service.uploadBuffer(req.file.buffer, req.file.originalname, req.file.mimetype, "products");
    image = uploaded.url;
    imageKey = uploaded.key;
  }

  const product = await Product.create({
    name,
    slug,
    categoryId,
    description: description || "",
    image,
    imageKey,
    price: Number(price),
    stock: Number(stock),
    sold: 0,
    status: status || "active",
    sortOrder: sortOrder || 0,
  });

  emitEvent("product:created", { product });
  emitEvent("products:updated", { action: "created", productId: product._id });
  res.status(201).json({ status: true, data: product });
});

const update = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const product = await Product.findById(id);
  if (!product) throw new AppError("Produk tidak ditemukan.", 404);

  const { name, categoryId, description, price, stock, status, sortOrder } = req.body;
  if (categoryId) {
    const category = await Category.findById(categoryId);
    if (!category) throw new AppError("Kategori tidak ditemukan.", 400);
    product.categoryId = categoryId;
  }
  if (name !== undefined) product.name = name;
  if (description !== undefined) product.description = description;
  if (price !== undefined) product.price = Number(price);
  if (stock !== undefined) product.stock = Number(stock);
  if (status !== undefined) product.status = status;
  if (sortOrder !== undefined) product.sortOrder = sortOrder;

  if (req.file) {
    const oldKey = product.imageKey;
    const uploaded = await r2Service.uploadBuffer(req.file.buffer, req.file.originalname, req.file.mimetype, "products");
    product.image = uploaded.url;
    product.imageKey = uploaded.key;
    if (oldKey) await r2Service.deleteObject(oldKey);
  }

  await product.save();
  emitEvent("product:updated", { product });
  emitEvent("products:updated", { action: "updated", productId: product._id });
  emitEvent("stock:updated", { productId: product._id, stock: product.stock });
  res.json({ status: true, data: product });
});

const remove = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const product = await Product.findByIdAndDelete(id);
  if (!product) throw new AppError("Produk tidak ditemukan.", 404);
  if (product.imageKey) await r2Service.deleteObject(product.imageKey);

  emitEvent("product:deleted", { productId: id });
  emitEvent("products:updated", { action: "deleted", productId: id });
  res.json({ status: true, message: "Produk dihapus." });
});

module.exports = { listPublic, getPublicBySlug, listAdmin, create, update, remove };
