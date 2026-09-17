/**
 * One-time migration: old WebsiteSettings.contact shape
 *   { whatsapp: "6281234...", discordUrl: "https://discord.gg/...", logo: "https://<r2>/..." }
 * -> new shape
 *   { whatsapp: { number: "6281234...", icon: "" }, discord: { url: "https://discord.gg/...", icon: "" } }
 *
 * The single old `logo` field was shared between WhatsApp and Discord, so it
 * cannot be safely split automatically — it is intentionally NOT copied into
 * either channel's `icon`. Admin just needs to re-upload each logo once from
 * Admin Web > Setting Kontak after running this script.
 *
 * Talks to the `websitesettings` collection directly with the native MongoDB
 * driver (not the Mongoose model) so it works no matter which shape — old or
 * new — is currently on disk, and is safe to run more than once.
 *
 * Usage:
 *   node server/scripts/migrateContactSettings.js
 * (reads MONGODB_URI from .env, same as the app)
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
  const col = mongoose.connection.collection("websitesettings");

  const doc = await col.findOne({ singletonKey: "main" });
  if (!doc) {
    console.log("Tidak ada dokumen settings (singletonKey: 'main') — tidak ada yang dimigrasikan.");
    await mongoose.disconnect();
    return;
  }

  const contact = doc.contact || {};
  const alreadyMigrated =
    contact.whatsapp && typeof contact.whatsapp === "object" && !Array.isArray(contact.whatsapp);

  if (alreadyMigrated) {
    console.log("contact sudah dalam format baru (whatsapp/discord bertipe object) — tidak ada yang diubah.");
    await mongoose.disconnect();
    return;
  }

  const oldWhatsapp = typeof contact.whatsapp === "string" ? contact.whatsapp : "";
  const oldDiscordUrl = typeof contact.discordUrl === "string" ? contact.discordUrl : "";
  const oldLogo = typeof contact.logo === "string" ? contact.logo : "";

  const newContact = {
    ...contact,
    whatsapp: { number: oldWhatsapp, icon: "" },
    discord: { url: oldDiscordUrl, icon: "" },
  };
  delete newContact.discordUrl;
  delete newContact.logo;

  await col.updateOne({ _id: doc._id }, { $set: { contact: newContact } });

  console.log("Migrasi selesai.");
  console.log("  whatsapp.number  <-", JSON.stringify(oldWhatsapp));
  console.log("  discord.url      <-", JSON.stringify(oldDiscordUrl));
  if (oldLogo) {
    console.log(
      "  logo lama (" + oldLogo + ") TIDAK disalin ke whatsapp.icon/discord.icon (dulu satu logo dipakai bersama)."
    );
    console.log("  Silakan upload ulang logo WhatsApp dan Discord secara terpisah dari Admin Web > Setting Kontak.");
  }

  await mongoose.disconnect();
}

run().catch((err) => {
  console.error("Migrasi gagal:", err.message);
  process.exit(1);
});
