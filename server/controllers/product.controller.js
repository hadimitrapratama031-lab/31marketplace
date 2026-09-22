const mongoose = require("mongoose");
const Product = require("../models/Product");
const Category = require("../models/Category");
const asyncHandler = require("../utils/asyncHandler");
const { AppError } = require("../middlewares/errorHandler");
const { emitEvent } = require("../services/socket.service");
const r2Service = require("../services/r2.service");
const redeemCodeService = require("../services/redeemCode.service");
const logger = require("../utils/logger");

/* ---------------------------------------------------------- gambar produk */

const ALLOWED_PRODUCT_MIMES = ["image/png", "image/jpeg", "image/webp"];
const MAX_ADDITIONAL_IMAGES = 5;

// Route produk sekarang memakai upload.fields() supaya bisa menerima gambar
// utama DAN gambar tambahan dalam satu submit. Helper ini menjaga controller
// tetap bekerja untuk keduanya: req.file (single) maupun req.files (fields),
// sehingga pemanggil lama yang hanya mengirim "image" tidak berubah perilakunya.
function mainImageFile(req) {
  if (req.file) return req.file;
  return (req.files && req.files.image && req.files.image[0]) || null;
}

function additionalImageFiles(req) {
  return (req.files && req.files.additionalImages) || [];
}

function assertProductImage(file) {
  if (!ALLOWED_PRODUCT_MIMES.includes(file.mimetype)) {
    throw new AppError("Gambar produk hanya boleh PNG, JPG, atau WEBP.", 400);
  }
}

// Mengunggah beberapa file sekaligus. Kalau salah satu gagal, yang sudah
// terlanjur naik dibersihkan lagi — jangan meninggalkan objek yatim di R2
// hanya karena file ketiga bermasalah.
async function uploadAdditional(files) {
  const uploaded = [];
  try {
    for (const file of files) {
      assertProductImage(file);
      const result = await r2Service.uploadBuffer(file.buffer, file.originalname, file.mimetype, "products");
      uploaded.push({ url: result.url, key: result.key });
    }
    return uploaded;
  } catch (err) {
    await Promise.all(uploaded.map((img) => r2Service.deleteObject(img.key).catch(() => {})));
    throw err;
  }
}

// Daftar gambar tambahan yang MASIH dipertahankan admin, dikirim form sebagai
// JSON string berisi key-nya. Dicocokkan dengan isi database, bukan dipercaya
// apa adanya: frontend tidak boleh bisa menyisipkan URL sembarangan ke produk.
function resolveKeptImages(product, rawKeep) {
  if (rawKeep === undefined) return product.additionalImages || []; // field tidak dikirim = tidak diubah

  let keys;
  try {
    keys = JSON.parse(rawKeep);
  } catch {
    throw new AppError("Daftar gambar tambahan tidak valid.", 400);
  }
  if (!Array.isArray(keys)) throw new AppError("Daftar gambar tambahan tidak valid.", 400);

  const wanted = new Set(keys.map(String));
  return (product.additionalImages || []).filter((img) => wanted.has(String(img.key)));
}

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
/**
 * ADMIN — daftar produk.
 *
 * Pagination bersifat OPT-IN: tanpa `page`, endpoint ini tetap membalas
 * seluruh produk persis seperti sebelumnya. Itu disengaja supaya pemanggil
 * lama (skrip, integrasi) tidak ikut berubah perilakunya hanya karena halaman
 * Produk sekarang meminta 25 baris.
 *
 * `sort` dibatasi ke daftar kolom yang dikenal — nilai dari query tidak pernah
 * masuk ke objek sort apa adanya, supaya tidak bisa dipakai menyusun query
 * yang tidak diinginkan.
 */
const SORTS = {
  order: { sortOrder: 1, createdAt: -1 },
  newest: { createdAt: -1 },
  sold: { sold: -1, createdAt: -1 },
  stock: { stock: 1, createdAt: -1 },
};

const listAdmin = asyncHandler(async (req, res) => {
  const { page, limit = 25, q, categoryId, status, sort = "order" } = req.query;

  const filter = {};
  if (status === "active" || status === "inactive") filter.status = status;
  if (categoryId && mongoose.isValidObjectId(categoryId)) filter.categoryId = categoryId;
  if (q && String(q).trim()) {
    const rx = new RegExp(String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ name: rx }, { slug: rx }];
  }

  const order = SORTS[sort] || SORTS.order;

  // Menempelkan Total/Available/Sold redeem code ke tiap produk yang
  // orderSystem-nya REDEEM_CODE, satu aggregate untuk seluruh halaman —
  // bukan satu query per baris (spec 5: "Stock harus berasal dari database
  // asli", bukan angka hardcode).
  async function withRedeemStats(products) {
    const redeemIds = products.filter((p) => p.orderSystem === "REDEEM_CODE").map((p) => p._id);
    if (!redeemIds.length) return products;
    const statsMap = await redeemCodeService.getStatsMany(redeemIds);
    return products.map((p) => {
      const obj = p.toObject();
      if (p.orderSystem === "REDEEM_CODE") {
        obj.redeemStats = statsMap.get(String(p._id)) || { total: 0, available: 0, sold: 0 };
      }
      return obj;
    });
  }

  // Tanpa `page`: perilaku lama, seluruh hasil.
  if (page === undefined) {
    const products = await Product.find(filter).sort(order).populate("categoryId", "name slug");
    return res.json({ status: true, data: await withRedeemStats(products) });
  }

  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(100, Math.max(1, Number(limit) || 25));

  const [products, total] = await Promise.all([
    Product.find(filter)
      .sort(order)
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .populate("categoryId", "name slug"),
    Product.countDocuments(filter),
  ]);

  res.json({
    status: true,
    data: await withRedeemStats(products),
    pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.max(1, Math.ceil(total / limitNum)) },
  });
});

// ADMIN — satu produk berdasarkan id. Dipakai modal edit supaya halaman Produk
// tidak perlu menyimpan seluruh katalog di memori hanya untuk membuka satu form.
const getAdminById = asyncHandler(async (req, res) => {
  if (!mongoose.isValidObjectId(req.params.id)) throw new AppError("Produk tidak valid.", 400);
  const product = await Product.findById(req.params.id).populate("categoryId", "name slug");
  if (!product) throw new AppError("Produk tidak ditemukan.", 404);
  const obj = product.toObject();
  if (product.orderSystem === "REDEEM_CODE") {
    obj.redeemStats = await redeemCodeService.getStats(product._id);
  }
  res.json({ status: true, data: obj });
});

const ORDER_SYSTEMS = ["MANUAL", "REDEEM_CODE"];

const create = asyncHandler(async (req, res) => {
  const { name, categoryId, description, shortDescription, price, stock, status, sortOrder, redeemInstructions, redeemCodes } =
    req.body;
  // "orderSystem" hanya dikirim saat admin memilih "Sistem Baru" di popup
  // pemilihan (lihat admin/admin.js openOrderSystemModal). Tanpa field ini —
  // termasuk seluruh pemanggil lama — produk otomatis MANUAL, flow lama
  // (spec 13: backward compatibility).
  const orderSystem = ORDER_SYSTEMS.includes(req.body.orderSystem) ? req.body.orderSystem : "MANUAL";
  const isRedeemSystem = orderSystem === "REDEEM_CODE";

  if (!name || !categoryId || price === undefined || (!isRedeemSystem && stock === undefined)) {
    throw new AppError("Nama, kategori, harga, dan stok wajib diisi.", 400);
  }
  if (isRedeemSystem && !String(redeemInstructions || "").trim()) {
    throw new AppError("Cara Redeem wajib diisi untuk produk dengan Automatic Redeem Code.", 400);
  }
  const category = await Category.findById(categoryId);
  if (!category) throw new AppError("Kategori tidak ditemukan.", 400);

  let slug = slugify(name);
  const exists = await Product.findOne({ slug });
  if (exists) slug = `${slug}-${Date.now().toString(36)}`;

  let image = "";
  let imageKey = "";
  let uploadedImage = null;
  const mainFile = mainImageFile(req);
  if (mainFile) {
    assertProductImage(mainFile);
    uploadedImage = await r2Service.uploadBuffer(mainFile.buffer, mainFile.originalname, mainFile.mimetype, "products");
    image = uploadedImage.url;
    imageKey = uploadedImage.key;
  }

  const extraFiles = additionalImageFiles(req);
  if (extraFiles.length > MAX_ADDITIONAL_IMAGES) {
    throw new AppError(`Gambar tambahan maksimal ${MAX_ADDITIONAL_IMAGES}.`, 400);
  }
  let additionalImages = [];
  try {
    additionalImages = await uploadAdditional(extraFiles);
  } catch (err) {
    if (uploadedImage?.key) await r2Service.deleteObject(uploadedImage.key).catch(() => {});
    throw err;
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
    additionalImages,
    price: Number(price),
    // Untuk REDEEM_CODE, stok BUKAN angka yang diketik admin — dihitung dari
    // jumlah redeem code yang benar-benar tersimpan di bawah (restock awal).
    // Mulai dari 0 dan disinkronkan oleh redeemCodeService.restock().
    stock: isRedeemSystem ? 0 : Number(stock),
    sold: 0,
    status: status || "active",
    sortOrder: sortOrder || 0,
    orderSystem,
    redeemInstructions: isRedeemSystem ? String(redeemInstructions || "").trim() : "",
    });
  } catch (err) {
    // Do not leave an orphaned R2 object when MongoDB rejects the product.
    if (uploadedImage?.key) await r2Service.deleteObject(uploadedImage.key).catch(() => {});
    await Promise.all(additionalImages.map((img) => r2Service.deleteObject(img.key).catch(() => {})));
    throw err;
  }

  // Restock awal opsional: admin boleh langsung paste code saat Add Product,
  // atau menambahkannya nanti lewat "+ Restock Code" (spec 3 & 5).
  let redeemResult = null;
  if (isRedeemSystem && String(redeemCodes || "").trim()) {
    try {
      redeemResult = await redeemCodeService.restock(product._id, redeemCodes);
      product = await Product.findById(product._id); // re-read: stock sudah disinkronkan
    } catch (err) {
      // Produk sudah tersimpan; kegagalan restock awal tidak boleh membuang
      // produk yang sudah valid — admin tinggal restock ulang dari form Edit.
      logger.error("Restock awal redeem code gagal saat Add Product", { productId: String(product._id), message: err.message });
    }
  }

  emitEvent("product:created", { product });
  emitEvent("products:updated", { action: "created", productId: product._id });
  res.status(201).json({ status: true, data: product, redeemRestock: redeemResult });
});

const update = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const product = await Product.findById(id);
  if (!product) throw new AppError("Produk tidak ditemukan.", 404);

  const {
    name,
    categoryId,
    description,
    shortDescription,
    price,
    stock,
    status,
    sortOrder,
    removeImage,
    keepAdditionalImages,
    redeemInstructions,
  } = req.body;
  if (categoryId) {
    const category = await Category.findById(categoryId);
    if (!category) throw new AppError("Kategori tidak ditemukan.", 400);
    product.categoryId = categoryId;
  }
  if (name !== undefined) product.name = name;
  if (description !== undefined) product.description = description;
  if (shortDescription !== undefined) product.shortDescription = shortDescription;
  if (price !== undefined) product.price = Number(price);
  // `orderSystem` TIDAK PERNAH diubah lewat edit — pilihannya dikunci saat
  // Add Product (spec 11). Kalau boleh diganti di sini, hubungan produk
  // dengan koleksi RedeemCode yang sudah ada (termasuk code yang sudah
  // SOLD) bisa jadi tidak konsisten dengan tampilannya.
  if (product.orderSystem === "REDEEM_CODE") {
    // Stok produk REDEEM_CODE hanya boleh berubah lewat restock/klaim code —
    // nilai `stock` dari form Edit (yang untuk produk ini memang tidak
    // menampilkan input stok manual) diabaikan supaya tidak pernah menyimpang
    // dari jumlah code AVAILABLE yang sebenarnya.
    if (redeemInstructions !== undefined) product.redeemInstructions = String(redeemInstructions || "").trim();
  } else if (stock !== undefined) {
    product.stock = Number(stock);
  }
  if (status !== undefined) product.status = status;
  if (sortOrder !== undefined) product.sortOrder = sortOrder;

  let replacementKey = "";
  const oldKey = product.imageKey;
  const mainFile = mainImageFile(req);
  if (mainFile) {
    assertProductImage(mainFile);
    // Upload first. The old object is kept until MongoDB has saved the new URL.
    const uploaded = await r2Service.uploadBuffer(mainFile.buffer, mainFile.originalname, mainFile.mimetype, "products");
    replacementKey = uploaded.key;
    product.image = uploaded.url;
    product.imageKey = uploaded.key;
  } else if (removeImage === "true" || removeImage === true) {
    // Hapus gambar tanpa mengganti (tombol "Hapus" di form Edit Produk).
    product.image = "";
    product.imageKey = "";
  }

  /* ---- gambar tambahan ----
     Urutannya disengaja: hitung apa yang dipertahankan, unggah yang baru,
     SIMPAN ke MongoDB, baru hapus objek R2 yang sudah tidak dirujuk. Kalau
     penghapusan dilakukan lebih dulu dan penyimpanan gagal, produk kehilangan
     gambar yang sebenarnya masih dipakai — dan file itu tidak bisa dikembalikan. */
  const keptImages = resolveKeptImages(product, keepAdditionalImages);
  const newFiles = additionalImageFiles(req);

  if (keptImages.length + newFiles.length > MAX_ADDITIONAL_IMAGES) {
    if (replacementKey) await r2Service.deleteObject(replacementKey).catch(() => {});
    throw new AppError(`Gambar tambahan maksimal ${MAX_ADDITIONAL_IMAGES}.`, 400);
  }

  let uploadedExtra = [];
  try {
    uploadedExtra = await uploadAdditional(newFiles);
  } catch (err) {
    if (replacementKey) await r2Service.deleteObject(replacementKey).catch(() => {});
    throw err;
  }

  // Objek lama yang tidak lagi ada di daftar simpan — dihapus setelah save.
  const keptKeys = new Set(keptImages.map((img) => String(img.key)));
  const orphanKeys = (product.additionalImages || [])
    .map((img) => String(img.key))
    .filter((key) => key && !keptKeys.has(key));

  product.additionalImages = [...keptImages, ...uploadedExtra];

  try {
    await product.save();
  } catch (err) {
    if (replacementKey) await r2Service.deleteObject(replacementKey).catch(() => {});
    await Promise.all(uploadedExtra.map((img) => r2Service.deleteObject(img.key).catch(() => {})));
    throw err;
  }

  // Delete the old object only after the DB points at the replacement.
  if (oldKey && (replacementKey || removeImage === "true" || removeImage === true) && oldKey !== product.imageKey) {
    await r2Service.deleteObject(oldKey).catch(() => {});
  }
  await Promise.all(orphanKeys.map((key) => r2Service.deleteObject(key).catch(() => {})));

  emitEvent("product:updated", { product });
  emitEvent("products:updated", { action: "updated", productId: product._id });
  emitEvent("stock:updated", { productId: product._id, stock: product.stock });
  res.json({ status: true, data: product });
});

const remove = asyncHandler(async (req, res) => {
  const { id } = req.params;
  const product = await Product.findById(id);
  if (!product) throw new AppError("Produk tidak ditemukan.", 404);

  // Redeem code TIDAK IKUT DIHAPUS (spec 11): code yang sudah SOLD tetap
  // tercatat sebagai histori untuk "Redeem Code Terjual", dan code AVAILABLE
  // yang tersisa tidak hilang — hanya jadi tidak terhubung ke produk yang
  // tampil di katalog lagi. Admin diberi tahu jumlahnya di pesan respons.
  let orphanedAvailable = 0;
  if (product.orderSystem === "REDEEM_CODE") {
    const s = await redeemCodeService.getStats(product._id);
    orphanedAvailable = s.available;
  }

  await Product.deleteOne({ _id: id });
  if (product.imageKey) await r2Service.deleteObject(product.imageKey).catch(() => {});
  // Gambar tambahannya ikut dibersihkan — tanpa ini setiap produk yang dihapus
  // meninggalkan sampai lima objek yatim di R2 yang tidak dirujuk apa pun lagi.
  await Promise.all((product.additionalImages || []).map((img) => r2Service.deleteObject(img.key).catch(() => {})));

  emitEvent("product:deleted", { productId: id });
  emitEvent("products:updated", { action: "deleted", productId: id });

  res.json({
    status: true,
    message:
      "Produk dihapus." +
      (orphanedAvailable
        ? ` ${orphanedAvailable} redeem code yang belum terjual tetap tersimpan di database (tidak ikut terhapus).`
        : ""),
  });
});

module.exports = {
  getAdminById, listPublic, getPublicBySlug, listAdmin, create, update, remove };
