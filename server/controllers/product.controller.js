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
  const { name, categoryId, description, shortDescription, price, stock, status, sortOrder } = req.body;
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
  let uploadedImage = null;
  if (req.file) {
    const allowedProductMimes = ["image/png", "image/jpeg", "image/webp"];
    if (!allowedProductMimes.includes(req.file.mimetype)) {
      throw new AppError("Gambar produk hanya boleh PNG, JPG, atau WEBP.", 400);
    }
    uploadedImage = await r2Service.uploadBuffer(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
      "products"
    );
    image = uploadedImage.url;
    imageKey = uploadedImage.key;
  }

  let product;
  try {
    product = await Product.create({
    name,
    slug,
    categoryId,
    description: description || "",
    shortDescription: shortDescription || "",
    image,
    imageKey,
    price: Number(price),
    stock: Number(stock),
    sold: 0,
    status: status || "active",
    sortOrder: sortOrder || 0,
    });
  } catch (err) {
    // Do not leave an orphaned R2 object when MongoDB rejects the product.
    if (uploadedImage?.key) await r2Service.deleteObject(uploadedImage.key);
    throw err;
  }

  emitEvent("product:created", { product });
  emitEvent("products:updated", { action: "created", productId: product._id });
  res.status(201).json({ status: true, data: product });
});

const update = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const product = await Product.findById(id);
  if (!product) throw new AppError("Produk tidak ditemukan.", 404);

  const { name, categoryId, description, shortDescription, price, stock, status, sortOrder, removeImage } = req.body;
  if (categoryId) {
    const category = await Category.findById(categoryId);
    if (!category) throw new AppError("Kategori tidak ditemukan.", 400);
    product.categoryId = categoryId;
  }
  if (name !== undefined) product.name = name;
  if (description !== undefined) product.description = description;
  if (shortDescription !== undefined) product.shortDescription = shortDescription;
  if (price !== undefined) product.price = Number(price);
  if (stock !== undefined) product.stock = Number(stock);
  if (status !== undefined) product.status = status;
  if (sortOrder !== undefined) product.sortOrder = sortOrder;

  let replacementKey = "";
  const oldKey = product.imageKey;
  if (req.file) {
    const allowedProductMimes = ["image/png", "image/jpeg", "image/webp"];
    if (!allowedProductMimes.includes(req.file.mimetype)) {
      throw new AppError("Gambar produk hanya boleh PNG, JPG, atau WEBP.", 400);
    }
    // Upload first. The old object is kept until MongoDB has saved the new URL.
    const uploaded = await r2Service.uploadBuffer(
      req.file.buffer,
      req.file.originalname,
      req.file.mimetype,
      "products"
    );
    replacementKey = uploaded.key;
    product.image = uploaded.url;
    product.imageKey = uploaded.key;
  } else if (removeImage === "true" || removeImage === true) {
    // Hapus gambar tanpa mengganti (tombol "Hapus" di form Edit Produk).
    product.image = "";
    product.imageKey = "";
  }

  try {
    await product.save();
  } catch (err) {
    if (replacementKey) await r2Service.deleteObject(replacementKey);
    throw err;
  }

  // Delete the old object only after the DB points at the replacement.
  if (oldKey && (replacementKey || removeImage === "true" || removeImage === true) && oldKey !== product.imageKey) {
    await r2Service.deleteObject(oldKey);
  }

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
