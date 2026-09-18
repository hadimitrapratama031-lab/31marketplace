/**
 * Memindahkan seluruh URL gambar yang sudah tersimpan di MongoDB dari domain
 * R2 lama (biasanya "pub-xxxx.r2.dev") ke domain publik R2 yang baru
 * (Custom Domain di Cloudflare, mis. "cdn.31store.site").
 *
 * KENAPA SCRIPT INI PERLU
 * ------------------------
 * R2_PUBLIC_URL di server/config/r2.js + server/services/r2.service.js
 * sudah menjadi SATU-SATUNYA source of truth untuk URL upload BARU — ganti
 * env var itu saja sudah cukup untuk produk/aset yang diupload setelah
 * perubahan. Tapi produk & pengaturan yang sudah ada menyimpan URL LENGKAP
 * (bukan cuma key R2), jadi mereka tetap menunjuk ke domain lama sampai
 * ditulis ulang secara eksplisit. Tanpa script ini, hanya upload baru yang
 * "sembuh" — gambar lama tetap pakai domain r2.dev yang tidak boleh dipakai
 * di production.
 *
 * Menyentuh setiap collection yang diketahui menyimpan URL gambar/asset R2:
 * Product (image, additionalImages[].url), WebsiteSettings (semua field
 * logo/icon/image bersarang, termasuk array highlights/navbar/hero.slides),
 * Category (icon), Rating (avatar). Hanya string yang PERSIS berawalan
 * --from yang diubah; field lain (URL Discord, path relatif, string kosong)
 * tidak disentuh sama sekali.
 *
 * Pemakaian:
 *   # lihat dulu apa yang akan berubah, tanpa menulis apa pun
 *   node server/scripts/migrateR2PublicDomain.js --from=https://pub-xxxx.r2.dev --to=https://cdn.31store.site --dry-run
 *
 *   # jalankan sungguhan
 *   node server/scripts/migrateR2PublicDomain.js --from=https://pub-xxxx.r2.dev --to=https://cdn.31store.site
 *
 * Setelah dijalankan, update R2_PUBLIC_URL di Railway ke --to (kalau belum),
 * lalu redeploy agar upload baru juga memakai domain yang sama.
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { connectDB } = require("../config/db");
const Product = require("../models/Product");
const WebsiteSettings = require("../models/WebsiteSettings");
const Category = require("../models/Category");
const Rating = require("../models/Rating");

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : null;
}

// Menulis ulang string apa pun di dalam sebuah value (objek/array/string
// bersarang berapa pun dalamnya) yang berawalan `from` menjadi `to` +
// sisanya. Generik supaya tidak perlu mendaftar setiap path field secara
// manual (rawan lupa satu field saat schema berubah) — cukup aman karena
// hanya STRING yang cocok prefix persis yang tersentuh.
function rewriteDeep(value, from, to, stats) {
  if (typeof value === "string") {
    if (value.startsWith(from)) {
      stats.matched += 1;
      return to + value.slice(from.length);
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => rewriteDeep(item, from, to, stats));
  }
  if (value && typeof value === "object") {
    // Dokumen Mongoose punya banyak internal (_id, $__, dll) — hanya jalan
    // di atas plain object hasil .toObject()/.lean(), jadi ini aman.
    const out = {};
    for (const [key, val] of Object.entries(value)) {
      out[key] = rewriteDeep(val, from, to, stats);
    }
    return out;
  }
  return value;
}

async function migrateCollection(Model, label) {
  const docs = await Model.find({}).lean();
  let changedDocs = 0;
  const stats = { matched: 0 };
  const samples = [];

  for (const doc of docs) {
    const localStats = { matched: 0 };
    const rewritten = rewriteDeep(doc, GLOBAL.from, GLOBAL.to, localStats);
    if (localStats.matched > 0) {
      changedDocs += 1;
      stats.matched += localStats.matched;
      if (samples.length < 5) samples.push({ id: doc._id, fields: localStats.matched });
      if (!GLOBAL.dryRun) {
        // $set seluruh dokumen (minus _id) — lebih sederhana dan tidak error-
        // prone dibanding menyusun path $set per field bersarang secara manual.
        const { _id, ...rest } = rewritten;
        await Model.updateOne({ _id }, { $set: rest });
      }
    }
  }

  console.log(
    `${label}: ${docs.length} dokumen diperiksa, ${changedDocs} dokumen berubah, ${stats.matched} URL diganti.`
  );
  samples.forEach((s) => console.log(`  contoh _id=${s.id} (${s.fields} field diganti)`));
}

const GLOBAL = {};

async function main() {
  const from = arg("from");
  const to = arg("to");
  const dryRun = process.argv.includes("--dry-run");

  if (!from || !to) {
    console.error("Wajib: --from=<URL R2 lama> --to=<URL R2/custom domain baru>");
    console.error(
      "Contoh: node server/scripts/migrateR2PublicDomain.js --from=https://pub-xxxx.r2.dev --to=https://cdn.31store.site --dry-run"
    );
    process.exit(1);
  }

  GLOBAL.from = from.replace(/\/+$/, "");
  GLOBAL.to = to.replace(/\/+$/, "");
  GLOBAL.dryRun = dryRun;

  if (GLOBAL.from === GLOBAL.to) {
    console.error("--from dan --to sama — tidak ada yang perlu diganti.");
    process.exit(1);
  }

  await connectDB();

  console.log(`Mode: ${dryRun ? "DRY RUN (tidak menulis apa pun)" : "TULIS PERUBAHAN"}`);
  console.log(`Mengganti "${GLOBAL.from}" -> "${GLOBAL.to}"\n`);

  await migrateCollection(Product, "Product");
  await migrateCollection(WebsiteSettings, "WebsiteSettings");
  await migrateCollection(Category, "Category");
  await migrateCollection(Rating, "Rating");

  if (dryRun) console.log("\nDry run selesai — tidak ada dokumen yang benar-benar ditulis.");
  else console.log("\nSelesai.");

  await mongoose.connection.close();
}

main().catch((err) => {
  console.error("Gagal:", err.message);
  process.exit(1);
});
