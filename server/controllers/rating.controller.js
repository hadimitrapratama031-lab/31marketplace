const Rating = require("../models/Rating");
const asyncHandler = require("../utils/asyncHandler");
const { AppError } = require("../middlewares/errorHandler");
const { emitEvent } = require("../services/socket.service");
const r2Service = require("../services/r2.service");

// PUBLIC — customers can submit a rating (goes to "pending" for moderation).
const create = asyncHandler(async (req, res) => {
  const { user, rating, review, productId } = req.body;
  if (!user || !rating || !review) throw new AppError("Nama, rating, dan review wajib diisi.", 400);
  const ratingNum = Number(rating);
  if (ratingNum < 1 || ratingNum > 5) throw new AppError("Rating harus antara 1-5.", 400);

  let avatar = "";
  if (req.file) {
    const uploaded = await r2Service.uploadBuffer(req.file.buffer, req.file.originalname, req.file.mimetype, "avatars");
    avatar = uploaded.url;
  }

  const doc = await Rating.create({ user, rating: ratingNum, review, productId: productId || undefined, avatar, status: "pending" });
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
