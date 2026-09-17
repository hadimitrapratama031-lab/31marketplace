const mongoose = require("mongoose");

const RatingSchema = new mongoose.Schema(
  {
    user: { type: String, required: true, trim: true },
    avatar: { type: String, default: "" },
    rating: { type: Number, required: true, min: 1, max: 5 },
    review: { type: String, required: true, trim: true },
    productId: { type: mongoose.Schema.Types.ObjectId, ref: "Product" },
    status: { type: String, enum: ["pending", "approved", "hidden"], default: "pending", index: true },
  },
  { timestamps: true }
);

// Daftar review Admin Web selalu terurut terbaru dan sering difilter status.
RatingSchema.index({ status: 1, createdAt: -1 });
RatingSchema.index({ createdAt: -1 });

module.exports = mongoose.model("Rating", RatingSchema);
