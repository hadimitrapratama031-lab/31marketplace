const mongoose = require("mongoose");
const Rating = require("../models/Rating");
const Product = require("../models/Product");
const asyncHandler = require("../utils/asyncHandler");
const { AppError } = require("../middlewares/errorHandler");
const { emitEvent } = require("../services/socket.service");
const r2Service = require("../services/r2.service");

// PUBLIC — customers can submit a rating (goes to "pending" for moderation).
const create = asyncHandler(async (req, res) => {
  const { user, rating, review, productId } = req.body;

  const userName = String(user || "").trim();
  const reviewText = String(review || "").trim();

  if (!userName || !rating || !reviewText) throw new AppError("Nama, rating, dan review wajib diisi.", 400);
  if (userName.length > 80) throw new AppError("Nama maksimal 80 karakter.", 400);
  if (reviewText.length < 5) throw new AppError("Review minimal 5 karakter.", 400);
  if (reviewText.length > 1000) throw new AppError("Review maksimal 1000 karakter.", 400);

  const ratingNum = Number(rating);
  if (!Number.isFinite(ratingNum) || ratingNum < 1 || ratingNum > 5) throw new AppError("Rating harus antara 1-5.", 400);

  let resolvedProductId;
  if (productId) {
    if (!mongoose.Types.ObjectId.isValid(productId)) throw new AppError("Produk tidak valid.", 400);
    const product = await Product.findById(productId);
    if (!product) throw new AppError("Produk tidak ditemukan.", 404);
    resolvedProductId = product._id;
  }

  let avatar = "";
  if (req.file) {
    const uploaded = await r2Service.uploadBuffer(req.file.buffer, req.file.originalname, req.file.mimetype, "avatars");
    avatar = uploaded.url;
  }

  // Sanitize is limited to trimming/length here — the review is HTML-escaped
  // by every renderer (home, rating page, Admin Web) at display time, so raw
  // markup in the stored text can never execute.
  const doc = await Rating.create({
    user: userName,
    rating: ratingNum,
    review: reviewText,
    productId: resolvedProductId,
    avatar,
    status: "pending",
  });

  // The write has already succeeded at this point, so it's now safe to notify
  // Admin Web (new item in the moderation queue) over the existing socket —
  // this was previously missing, which is why new reviews never showed up
  // for admins without a manual refresh.
  emitEvent("rating:updated", { action: "created", rating: doc });

  res.status(201).json({ status: true, message: "Terima kasih! Review Anda menunggu moderasi.", data: doc });
});

// PUBLIC — only approved ratings shown on marketplace.
const listPublic = asyncHandler(async (req, res) => {
  const ratings = await Rating.find({ status: "approved" }).sort({ createdAt: -1 }).limit(50);
  res.json({ status: true, data: ratings });
});

// ADMIN
/**
 * ADMIN — daftar review.
 *
 * `distribution` dihitung dengan agregasi atas SELURUH review approved, bukan
 * atas halaman yang sedang tampil. Sebelumnya grafik sebaran bintang dihitung
 * dari array yang sudah tersaring status, jadi angkanya ikut berubah begitu
 * admin memfilter "pending" — sekarang grafiknya selalu menggambarkan data
 * yang sama dengan kartu rata-rata di sebelahnya.
 */
const listAdmin = asyncHandler(async (req, res) => {
  const { status, page, limit = 25, q } = req.query;

  const filter = {};
  if (status) filter.status = status;
  if (q && String(q).trim()) {
    const rx = new RegExp(String(q).trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
    filter.$or = [{ user: rx }, { review: rx }];
  }

  const distributionAgg = await Rating.aggregate([
    { $match: { status: "approved" } },
    { $group: { _id: { $round: ["$rating", 0] }, count: { $sum: 1 } } },
  ]);
  const distribution = [5, 4, 3, 2, 1].map((n) => ({
    rating: n,
    count: (distributionAgg.find((row) => Number(row._id) === n) || {}).count || 0,
  }));

  if (page === undefined) {
    const ratings = await Rating.find(filter).sort({ createdAt: -1 }).populate("productId", "name slug");
    return res.json({ status: true, data: ratings, distribution });
  }

  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(100, Math.max(1, Number(limit) || 25));

  const [ratings, total, pending] = await Promise.all([
    Rating.find(filter)
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      .populate("productId", "name slug"),
    Rating.countDocuments(filter),
    Rating.countDocuments({ status: "pending" }),
  ]);

  res.json({
    status: true,
    data: ratings,
    distribution,
    // Badge "menunggu moderasi" harus menghitung seluruh review pending, bukan
    // hanya yang kebetulan ada di halaman ini.
    pendingTotal: pending,
    pagination: { page: pageNum, limit: limitNum, total, totalPages: Math.max(1, Math.ceil(total / limitNum)) },
  });
});

const updateStatus = asyncHandler(async (req, res) => {
  const { status } = req.body;
  if (!["pending", "approved", "hidden"].includes(status)) throw new AppError("Status tidak valid.", 400);
  const rating = await Rating.findByIdAndUpdate(req.params.id, { status }, { new: true });
  if (!rating) throw new AppError("Rating tidak ditemukan.", 404);
  emitEvent("rating:updated", { action: "statusChanged", rating });
  emitEvent("statistics:updated", {});
  res.json({ status: true, data: rating });
});

const remove = asyncHandler(async (req, res) => {
  const rating = await Rating.findByIdAndDelete(req.params.id);
  if (!rating) throw new AppError("Rating tidak ditemukan.", 404);
  emitEvent("rating:updated", { action: "deleted", ratingId: req.params.id });
  emitEvent("statistics:updated", {});
  res.json({ status: true, message: "Rating dihapus." });
});

module.exports = { create, listPublic, listAdmin, updateStatus, remove };
