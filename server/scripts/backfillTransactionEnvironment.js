/**
 * Menandai dokumen Transaction lama yang dibuat sebelum field `environment`
 * ada.
 *
 * KENAPA PERLU DIJALANKAN MANUAL
 * ------------------------------
 * Transaksi lama tidak menyimpan mode provider apa pun, jadi tidak ada cara
 * yang jujur untuk menebaknya dari data — dan laporan keuntungan memang tidak
 * boleh menebak. Yang dilakukan script ini hanya menulis nilai yang ADMIN
 * tentukan sendiri lewat argumen, untuk rentang tanggal yang admin tentukan
 * sendiri. Tanpa dijalankan, semua transaksi lama dianggap production (sama
 * seperti default schema), sehingga laporan tidak berubah diam-diam.
 *
 * Contoh:
 *   # lihat dulu apa yang akan berubah, tanpa menulis apa pun
 *   node server/scripts/backfillTransactionEnvironment.js --mode=sandbox --before=2026-09-01 --dry-run
 *
 *   # tandai semua transaksi sebelum 1 September 2026 sebagai sandbox
 *   node server/scripts/backfillTransactionEnvironment.js --mode=sandbox --before=2026-09-01
 *
 *   # tandai satu order tertentu
 *   node server/scripts/backfillTransactionEnvironment.js --mode=sandbox --order=ORD-20260916-8F3K2C
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { connectDB } = require("../config/db");
const Transaction = require("../models/Transaction");

function arg(name) {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split("=").slice(1).join("=") : null;
}

async function main() {
  const mode = (arg("mode") || "").toLowerCase();
  if (mode !== "sandbox" && mode !== "production") {
    console.error("Wajib: --mode=sandbox atau --mode=production");
    process.exit(1);
  }

  const before = arg("before");
  const after = arg("after");
  const order = arg("order");
  const dryRun = process.argv.includes("--dry-run");

  const filter = {};
  if (order) {
    filter.transactionId = order.trim().toUpperCase();
  } else {
    // Tanpa --order, wajib ada batas waktu: menandai SELURUH koleksi sekaligus
    // hampir selalu bukan yang dimaksud, dan tidak bisa dibatalkan.
    if (!before && !after) {
      console.error("Wajib salah satu: --order=<ORDER_ID>, --before=YYYY-MM-DD, atau --after=YYYY-MM-DD");
      process.exit(1);
    }
    filter.createdAt = {};
    if (before) filter.createdAt.$lt = new Date(before);
    if (after) filter.createdAt.$gte = new Date(after);
  }

  await connectDB();

  const affected = await Transaction.countDocuments(filter);
  console.log(`Cocok dengan filter: ${affected} transaksi -> environment="${mode}"`);

  if (dryRun) {
    const sample = await Transaction.find(filter).select("transactionId createdAt environment").limit(10).lean();
    sample.forEach((t) => console.log(`  ${t.transactionId}  ${t.createdAt.toISOString()}  (${t.environment || "-"})`));
    console.log("Dry run — tidak ada yang ditulis.");
  } else {
    const res = await Transaction.updateMany(filter, { $set: { environment: mode } });
    console.log(`Selesai. ${res.modifiedCount} dokumen diperbarui.`);
  }

  await mongoose.connection.close();
}

main().catch((err) => {
  console.error("Gagal:", err.message);
  process.exit(1);
});
