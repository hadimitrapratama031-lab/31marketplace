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
      mode: { type: String, enum: ["production", "sandbox"], default: "production" },
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

    templates: {
      whatsapp: {
        orderCreated: {
          type: String,
          default: "Halo {{customer_name}}, order {{order_code}} untuk {{product_name}} sudah dibuat. Total: {{total}}.",
        },
        paymentSuccess: {
          type: String,
          default:
            "Pembayaran berhasil! Order {{order_code}} ({{product_name}}) sebesar {{total}} sudah kami terima. Terima kasih sudah belanja di {{store_name}}.",
        },
        paymentFailed: {
          type: String,
          default: "Pembayaran untuk order {{order_code}} gagal diproses. Silakan coba lagi atau hubungi admin {{store_name}}.",
        },
        paymentExpired: {
          type: String,
          default: "Waktu pembayaran untuk order {{order_code}} telah habis. Silakan lakukan order ulang di {{store_name}}.",
        },
      },
      email: {
        orderCreated: {
          subject: { type: String, default: "Order {{order_code}} Diterima — {{store_name}}" },
          html: {
            type: String,
            default:
              "<p>Halo {{customer_name}},</p><p>Order <b>{{order_code}}</b> untuk <b>{{product_name}}</b> x{{quantity}} sudah kami terima. Total: <b>{{total}}</b>.</p><p>Status: {{payment_status}}</p>",
          },
        },
        paymentSuccess: {
          subject: { type: String, default: "Pembayaran Berhasil — {{order_code}}" },
          html: {
            type: String,
            default:
              "<p>Halo {{customer_name}},</p><p>Pembayaran order <b>{{order_code}}</b> sebesar <b>{{total}}</b> telah berhasil. Terima kasih sudah berbelanja di {{store_name}}!</p>",
          },
        },
        paymentFailed: {
          subject: { type: String, default: "Pembayaran Gagal — {{order_code}}" },
          html: {
            type: String,
            default: "<p>Halo {{customer_name}},</p><p>Pembayaran order <b>{{order_code}}</b> gagal diproses. Silakan coba lagi.</p>",
          },
        },
        paymentExpired: {
          subject: { type: String, default: "Order Kedaluwarsa — {{order_code}}" },
          html: {
            type: String,
            default: "<p>Halo {{customer_name}},</p><p>Waktu pembayaran order <b>{{order_code}}</b> telah habis.</p>",
          },
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
