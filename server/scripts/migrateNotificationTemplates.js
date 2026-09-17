/**
 * Migrasi satu kali untuk `integrationsettings.templates`.
 *
 * MASALAH YANG DIPERBAIKI
 * Skema IntegrationSettings dulu menanam teks template versi lama sebagai
 * `default:`. Dokumen singleton dibuat otomatis pada boot pertama, jadi teks
 * itu ikut tersimpan ke database. Akibatnya setiap field template selalu
 * "terisi", dan pemilih template membacanya sebagai "admin sudah menulis
 * template sendiri" — sehingga template bawaan yang baru tidak pernah dipakai
 * walaupun filenya sudah ada di server.
 *
 * Script ini mengosongkan field yang isinya PERSIS sama dengan salah satu
 * default lama. Template yang benar-benar ditulis admin tidak disentuh sama
 * sekali: kalau isinya berbeda satu karakter pun, field itu dibiarkan.
 *
 * Setelah dikosongkan, runtime otomatis memakai template bawaan dari
 * services/template.service.js.
 *
 * Aman dijalankan lebih dari sekali.
 *
 * Pakai:
 *   node server/scripts/migrateNotificationTemplates.js
 *   node server/scripts/migrateNotificationTemplates.js --dry-run
 */
require("dotenv").config();
const mongoose = require("mongoose");
const { LEGACY_TEMPLATES } = require("../services/template.service");

const DRY_RUN = process.argv.includes("--dry-run");
const EVENTS = ["orderCreated", "paymentSuccess", "paymentFailed", "paymentExpired"];

function isLegacy(value) {
  return typeof value === "string" && LEGACY_TEMPLATES.has(value.trim());
}

async function run() {
  const uri = process.env.MONGODB_URI;
  if (!uri) {
    console.error("MONGODB_URI tidak diset (.env).");
    process.exit(1);
  }

  await mongoose.connect(uri);
  // Driver native, bukan model Mongoose: dokumen harus dibaca apa adanya,
  // tanpa default skema ikut disisipkan saat hydrate.
  const col = mongoose.connection.collection("integrationsettings");

  const docs = await col.find({}).toArray();
  if (!docs.length) {
    console.log("Tidak ada dokumen integrationsettings — tidak ada yang dimigrasikan.");
    await mongoose.disconnect();
    return;
  }

  // Lebih dari satu dokumen berarti runtime bisa mengambil versi yang salah.
  // Tidak dihapus otomatis — penghapusan data harus keputusan Anda.
  if (docs.length > 1) {
    console.warn(`PERINGATAN: ada ${docs.length} dokumen integrationsettings.`);
    console.warn("getSingleton() memakai { singletonKey: 'main' }; dokumen lain diabaikan runtime.");
    console.warn("_id yang ada:", docs.map((d) => String(d._id)).join(", "));
  }

  let cleared = 0;
  let kept = 0;

  for (const doc of docs) {
    const tpl = doc.templates || {};
    const unset = {};

    for (const ev of EVENTS) {
      const wa = tpl.whatsapp && tpl.whatsapp[ev];
      if (isLegacy(wa)) {
        unset[`templates.whatsapp.${ev}`] = "";
        cleared += 1;
        console.log(`  [kosongkan] whatsapp.${ev}`);
      } else if (wa && String(wa).trim()) {
        kept += 1;
        console.log(`  [pertahankan] whatsapp.${ev} — ditulis admin, tidak disentuh`);
      }

      const mail = (tpl.email && tpl.email[ev]) || {};
      for (const field of ["subject", "html"]) {
        const value = mail[field];
        if (isLegacy(value)) {
          unset[`templates.email.${ev}.${field}`] = "";
          cleared += 1;
          console.log(`  [kosongkan] email.${ev}.${field}`);
        } else if (value && String(value).trim()) {
          kept += 1;
          console.log(`  [pertahankan] email.${ev}.${field} — ditulis admin, tidak disentuh`);
        }
      }
    }

    if (Object.keys(unset).length && !DRY_RUN) {
      // $set "" dan bukan $unset: field yang hilang sama sekali akan diisi
      // ulang oleh default skema saat dokumen di-hydrate Mongoose.
      const patch = {};
      for (const key of Object.keys(unset)) patch[key] = "";
      await col.updateOne({ _id: doc._id }, { $set: patch });
    }
  }

  console.log("");
  console.log(DRY_RUN ? "DRY RUN — tidak ada yang diubah." : "Migrasi selesai.");
  console.log(`  field dikosongkan : ${cleared}`);
  console.log(`  field dipertahankan: ${kept}`);
  if (cleared) {
    console.log("");
    console.log("Verifikasi: buka Admin Web > Integrasi > Template, tekan 'Pratinjau template aktif'.");
    console.log("Sumber setiap channel harus terbaca 'Bawaan'.");
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("Migrasi gagal:", err.message);
  process.exit(1);
});
