const mongoose = require("mongoose");

/**
 * Singleton document for integrations that ARE safe/useful to configure from
 * Admin Web. True infrastructure secrets (MongoDB URI, JWT secret,
 * ENCRYPTION_SECRET) intentionally stay in Railway environment variables and
 * are never stored here (see section 15/16 of the spec).
 *
 * Any secret fields below are stored AES-256-GCM encrypted (utils/crypto.js)
 * and are never returned to the frontend in plaintext — only masked previews.
 */
const IntegrationSettingsSchema = new mongoose.Schema(
  {
    singletonKey: { type: String, default: "main", unique: true },

    klikqris: {
      enabled: { type: Boolean, default: false },
      // No default: an unset mode must be falsy so ENV's KLIKQRIS_MODE can
      // take effect (see getKlikQrisConfig). A stored default here would
      // silently outrank ENV even when no admin ever touched this setting —
      // that mismatch is what let a sandbox API key hit the production
      // endpoint (KlikQRIS then rejects it, surfacing as a gateway failure).
      mode: { type: String, enum: ["production", "sandbox", null], default: null },
      // encrypted values; never sent to frontend as plaintext
      apiKeyEncrypted: { type: String, default: null },
      merchantIdEncrypted: { type: String, default: null },
      lastTestStatus: { type: String, enum: ["untested", "success", "error"], default: "untested" },
      lastTestAt: { type: Date },
      lastTestMessage: { type: String, default: "" },
    },

    fonnte: {
      enabled: { type: Boolean, default: false },
      tokenEncrypted: { type: String, default: null },
      lastTestStatus: { type: String, enum: ["untested", "success", "error"], default: "untested" },
      lastTestAt: { type: Date },
      lastTestMessage: { type: String, default: "" },
    },

    resend: {
      enabled: { type: Boolean, default: false },
      apiKeyEncrypted: { type: String, default: null },
      fromEmail: { type: String, default: "" },
      fromName: { type: String, default: "" },
      lastTestStatus: { type: String, enum: ["untested", "success", "error"], default: "untested" },
      lastTestAt: { type: Date },
      lastTestMessage: { type: String, default: "" },
    },

    r2: {
      // secrets for R2 stay in Railway ENV only (needed at boot to init S3 client);
      // this just reflects whether ENV is present, for the status dot in Admin Web.
      lastTestStatus: { type: String, enum: ["untested", "success", "error"], default: "untested" },
      lastTestAt: { type: Date },
      lastTestMessage: { type: String, default: "" },
    },

    notifications: {
      whatsappEnabled: { type: Boolean, default: true },
      emailEnabled: { type: Boolean, default: true },
      events: {
        orderCreated: { type: Boolean, default: true },
        paymentPending: { type: Boolean, default: true },
        paymentSuccess: { type: Boolean, default: true },
        paymentFailed: { type: Boolean, default: true },
        paymentExpired: { type: Boolean, default: true },
        orderCompleted: { type: Boolean, default: false },
      },
    },

    // Template kustom opsional. KOSONG = pakai template bawaan dari
    // services/template.service.js.
    //
    // Field-field ini DULU punya `default:` berisi teks satu baris. Karena
    // dokumen singleton dibuat otomatis pada boot pertama, default itu ikut
    // tersimpan ke database — sehingga setiap field selalu "terisi", dan
    // pemilih template membacanya sebagai "admin sudah menulis sendiri".
    // Itulah sebabnya template baru tidak pernah terpakai walau filenya ada.
    // Defaultnya sekarang string kosong; jalankan
    // `npm run migrate:templates` untuk membersihkan dokumen lama.
    templates: {
      whatsapp: {
        orderCreated: { type: String, default: "" },
        paymentSuccess: { type: String, default: "" },
        paymentFailed: { type: String, default: "" },
        paymentExpired: { type: String, default: "" },
      },
      email: {
        orderCreated: {
          subject: { type: String, default: "" },
          html: { type: String, default: "" },
        },
        paymentSuccess: {
          subject: { type: String, default: "" },
          html: { type: String, default: "" },
        },
        paymentFailed: {
          subject: { type: String, default: "" },
          html: { type: String, default: "" },
        },
        paymentExpired: {
          subject: { type: String, default: "" },
          html: { type: String, default: "" },
        },
      },
    },
  },
  { timestamps: true }
);

IntegrationSettingsSchema.statics.getSingleton = async function getSingleton() {
  let doc = await this.findOne({ singletonKey: "main" });
  if (!doc) {
    doc = await this.create({ singletonKey: "main" });
  }
  return doc;
};

module.exports = mongoose.model("IntegrationSettings", IntegrationSettingsSchema);
