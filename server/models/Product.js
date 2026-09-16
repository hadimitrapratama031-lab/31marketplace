const mongoose = require("mongoose");

const ProductSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: "Category", required: true, index: true },
    description: { type: String, default: "" },
    image: { type: String, default: "" }, // R2 public URL
    imageKey: { type: String, default: "" }, // R2 object key (for deletion/replacement)
    price: { type: Number, required: true, min: 0 }, // source of truth price (IDR)
    stock: { type: Number, required: true, min: 0, default: 0 },
    sold: { type: Number, required: true, min: 0, default: 0 },
    status: { type: String, enum: ["active", "inactive"], default: "active", index: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true }
);

ProductSchema.index({ categoryId: 1, status: 1 });

module.exports = mongoose.model("Product", ProductSchema);
