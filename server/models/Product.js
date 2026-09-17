const mongoose = require("mongoose");

const ProductSchema = new mongoose.Schema(
  {
    name: { type: String, required: true, trim: true },
    slug: { type: String, required: true, unique: true, lowercase: true, trim: true, index: true },
    categoryId: { type: mongoose.Schema.Types.ObjectId, ref: "Category", required: true, index: true },
    // Full description: the source of truth for "Tentang produk" on the
    // detail page. Never truncated by the frontend.
    description: { type: String, default: "" },
    // Short description: the admin-authored summary shown in the buy panel.
    // Optional — when left blank, the Marketplace falls back to an excerpt
    // of `description` so older products still render sensibly until an
    // admin fills this in.
    shortDescription: { type: String, default: "", trim: true, maxlength: 220 },
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
// Menopang urutan & filter daftar Produk di Admin Web. Tanpa ini, setiap
// pindah halaman memaksa MongoDB mengurutkan seluruh koleksi di memori.
ProductSchema.index({ sortOrder: 1, createdAt: -1 });
ProductSchema.index({ sold: -1 });
ProductSchema.index({ stock: 1 });

module.exports = mongoose.model("Product", ProductSchema);
