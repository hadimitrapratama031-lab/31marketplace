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
    // Gambar tambahan, maksimal 5, OPSIONAL. Bentuknya sengaja mengikuti
    // pasangan image/imageKey yang sudah dipakai gambar utama: `url` untuk
    // ditampilkan, `key` untuk dihapus dari R2. Tidak ada base64 yang disimpan
    // di MongoDB — isi file selalu ada di R2, dokumen ini hanya menyimpan
    // rujukannya.
    //
    // Produk lama tidak punya field ini sama sekali; `default: []` membuatnya
    // terbaca sebagai array kosong tanpa migrasi apa pun, dan Marketplace tetap
    // menampilkan gambar utamanya seperti biasa.
    additionalImages: {
      type: [
        {
          _id: false,
          url: { type: String, default: "" },
          key: { type: String, default: "" },
        },
      ],
      default: [],
      validate: {
        // Batasnya ditegakkan di schema juga, bukan hanya di controller: apa
        // pun jalur yang menulis produk tidak bisa melewati lima.
        validator: (value) => !value || value.length <= 5,
        message: "Gambar tambahan maksimal 5.",
      },
    },
    price: { type: Number, required: true, min: 0 }, // source of truth price (IDR)
    // Untuk orderSystem "MANUAL": stok diisi manual oleh admin, seperti
    // sebelumnya. Untuk "REDEEM_CODE": angka ini adalah JUMLAH REDEEM CODE
    // BERSTATUS AVAILABLE milik produk ini, dijaga tetap sinkron oleh
    // services/redeemCode.service.js setiap kali restock atau klaim terjadi.
    // Sengaja memakai field yang SAMA (bukan field baru) supaya checkout,
    // validasi stok, tampilan Marketplace, dan kolom Stok di Admin Web yang
    // sudah ada — yang semuanya membaca `stock` — otomatis bekerja untuk
    // kedua sistem order tanpa perlu diubah satu baris pun.
    stock: { type: Number, required: true, min: 0, default: 0 },
    sold: { type: Number, required: true, min: 0, default: 0 },
    status: { type: String, enum: ["active", "inactive"], default: "active", index: true },
    sortOrder: { type: Number, default: 0 },
    // Sistem order produk ini. Default "MANUAL" berarti produk LAMA yang
    // belum punya field ini sama sekali otomatis terbaca sebagai sistem lama
    // (Mongoose menerapkan default ini saat hydrate dokumen dari MongoDB,
    // bukan hanya saat dokumen baru dibuat) — tidak perlu migrasi apa pun,
    // persis pola yang sudah dipakai `additionalImages` di atas.
    orderSystem: {
      type: String,
      enum: ["MANUAL", "REDEEM_CODE"],
      default: "MANUAL",
      index: true,
    },
    // Hanya relevan kalau orderSystem = "REDEEM_CODE". Ditampilkan ke
    // customer di halaman transaksi & WhatsApp SETELAH pembayaran SUCCESS.
    // Dibaca LIVE dari sini (bukan disalin ke Order) supaya kalau admin
    // membetulkan instruksinya, order lama maupun baru sama-sama melihat
    // versi terbaru.
    redeemInstructions: { type: String, default: "" },
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
