const FAQ = require("../models/FAQ");
const asyncHandler = require("../utils/asyncHandler");
const { AppError } = require("../middlewares/errorHandler");
const { emitEvent } = require("../services/socket.service");

const listPublic = asyncHandler(async (req, res) => {
  const faqs = await FAQ.find({ enabled: true }).sort({ sortOrder: 1, createdAt: 1 });
  res.json({ status: true, data: faqs });
});

const listAdmin = asyncHandler(async (req, res) => {
  const faqs = await FAQ.find().sort({ sortOrder: 1, createdAt: 1 });
  res.json({ status: true, data: faqs });
});

const create = asyncHandler(async (req, res) => {
  const { question, answer, enabled, sortOrder } = req.body;
  if (!question || !answer) throw new AppError("Pertanyaan dan jawaban wajib diisi.", 400);
  const faq = await FAQ.create({ question, answer, enabled: enabled !== false, sortOrder: sortOrder || 0 });
  emitEvent("faq:updated", { action: "created", faq });
  res.status(201).json({ status: true, data: faq });
});

const update = asyncHandler(async (req, res) => {
  const faq = await FAQ.findById(req.params.id);
  if (!faq) throw new AppError("FAQ tidak ditemukan.", 404);
  const { question, answer, enabled, sortOrder } = req.body;
  if (question !== undefined) faq.question = question;
  if (answer !== undefined) faq.answer = answer;
  if (enabled !== undefined) faq.enabled = enabled;
  if (sortOrder !== undefined) faq.sortOrder = sortOrder;
  await faq.save();
  emitEvent("faq:updated", { action: "updated", faq });
  res.json({ status: true, data: faq });
});

const remove = asyncHandler(async (req, res) => {
  const faq = await FAQ.findByIdAndDelete(req.params.id);
  if (!faq) throw new AppError("FAQ tidak ditemukan.", 404);
  emitEvent("faq:updated", { action: "deleted", faqId: req.params.id });
  res.json({ status: true, message: "FAQ dihapus." });
});

module.exports = { listPublic, listAdmin, create, update, remove };
