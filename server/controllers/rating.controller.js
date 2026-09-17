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
const listAdmin = asyncHandler(async (req, res) => {
  const { status } = req.query;
  const filter = status ? { status } : {};
  const ratings = await Rating.find(filter).sort({ createdAt: -1 });
  res.json({ status: true, data: ratings });
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
