/**
 * Migrasi satu kali untuk koleksi `notificationlogs`.
 *
 * Skema lama memakai index unik PARSIAL:
 *   { orderId, channel, event } unique, partialFilterExpression { status: "sent" }
 * Index itu hanya mengunci baris yang sudah "sent", sehingga slot pengiriman
 * tidak bisa di-claim SEBELUM provider dipanggil — dan itulah yang membuat
 * webhook ganda sempat mengirim WhatsApp dua kali.
 *
 * Skema baru memakai index unik penuh:
 *   { orderId, event, channel } unique
 *
 * Script ini:
 *   1. menghapus index parsial lama (kalau masih ada),
 *   2. mengisi field baru pada baris lama (orderCode, attempts, recipient),
 *   3. membiarkan Mongoose membuat index baru saat aplikasi start.
 *
 * Aman dijalankan lebih dari sekali.
 *
 * Pakai:
 *   node server/scripts/migrateNotificationLog.js
 */
require("dotenv").config();
const mongoose = require("mongoose");

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI tidak diset (.env).");
    process.exit(1);
  }

  await mongoose.connect(uri);
  const col = mongoose.connection.collection("notificationlogs");

  // 1. Hapus index parsial lama.
  const indexes = await col.indexes();
  for (const idx of indexes) {
    if (idx.unique && idx.partialFilterExpression && idx.partialFilterExpression.status === "sent") {
      await col.dropIndex(idx.name);
      console.log("Index parsial lama dihapus:", idx.name);
    }
  }

  // 2. Baris lama hanya punya status "sent"/"failed" tanpa attempts/recipient.
  //    Diisi seadanya supaya tabel Riwayat Pengiriman tidak menampilkan
  //    kolom kosong untuk data historis.
  const filled = await col.updateMany(
    { attempts: { $exists: false } },
    { $set: { attempts: 1, recipient: "", error: "", permanentFailure: false } }
  );
  console.log("Baris lama dilengkapi:", filled.modifiedCount);

  // 3. orderCode diambil dari koleksi orders supaya log bisa dicari tanpa join.
  const missing = await col.find({ $or: [{ orderCode: { $exists: false } }, { orderCode: "" }] }).toArray();
  let backfilled = 0;
  for (const row of missing) {
    const order = await mongoose.connection.collection("orders").findOne({ _id: row.orderId });
    if (order && order.orderCode) {
      await col.updateOne({ _id: row._id }, { $set: { orderCode: order.orderCode } });
      backfilled += 1;
    }
  }
  console.log("orderCode diisi ulang:", backfilled);

  // 4. Baris berstatus "sending" yang tertinggal dari proses yang mati
  //    dikembalikan ke "failed" agar bisa di-retry, bukan menggantung.
  const stuck = await col.updateMany(
    { status: "sending" },
    { $set: { status: "failed", error: "Proses pengiriman terputus sebelum migrasi." } }
  );
  if (stuck.modifiedCount) console.log('Baris "sending" yang menggantung direset:', stuck.modifiedCount);

  console.log("Migrasi selesai. Index baru dibuat otomatis saat server start.");
  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("Migrasi gagal:", err.message);
  process.exit(1);
});
