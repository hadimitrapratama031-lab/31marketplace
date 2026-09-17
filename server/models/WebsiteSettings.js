const mongoose = require("mongoose");

/**
 * Singleton document (single row, _id fixed) holding every configurable
 * part of the Marketplace frontend: general, navbar, home, statistics,
 * highlights, contact, footer, background, theme, typography.
 * Products/Categories/FAQ/Ratings are their own collections (CRUD lists).
 */
const WebsiteSettingsSchema = new mongoose.Schema(
  {
    singletonKey: { type: String, default: "main", unique: true },

    general: {
      storeName: { type: String, default: "My Store" },
      description: { type: String, default: "" },
      logo: { type: String, default: "" },
      favicon: { type: String, default: "" },
      websiteStatus: { type: String, enum: ["online", "maintenance"], default: "online" },
      copyright: { type: String, default: "" },
    },

    navbar: {
      items: [
        {
          label: { type: String, default: "" },
          route: { type: String, default: "" },
          icon: { type: String, default: "" },
          enabled: { type: Boolean, default: true },
          sortOrder: { type: Number, default: 0 },
        },
      ],
      cekPesananLabel: { type: String, default: "Cek Pesanan" },
    },

    home: {
      heading: { type: String, default: "" },
      subtitle: { type: String, default: "" },
      description: { type: String, default: "" },
      ctaText: { type: String, default: "" },
      ctaLink: { type: String, default: "" },
    },

    statistics: {
      totalProdukTerjualVisible: { type: Boolean, default: true },
      averageRatingVisible: { type: Boolean, default: true },
      totalBuyerVisible: { type: Boolean, default: true },
      totalProdukVisible: { type: Boolean, default: true },
      successfulOrdersVisible: { type: Boolean, default: true },
      supportLabel: { type: String, default: "Support 24/7" },
      order: [{ type: String }],
    },

    highlights: [
      {
        icon: { type: String, default: "" },
        title: { type: String, default: "" },
        description: { type: String, default: "" },
        enabled: { type: Boolean, default: true },
        sortOrder: { type: Number, default: 0 },
      },
    ],

    // WhatsApp and Discord are two independent contact channels, each with
    // its own admin-uploaded icon — NOT a shared `logo` field. Keeping them
    // as nested objects (rather than flat `whatsapp`/`discordUrl` strings)
    // is what lets Order Success and the Marketplace contact section render
    // each channel's own logo instead of a hardcoded "WA"/"DC" badge.
    // Legacy flat documents are normalized by
    // server/scripts/migrateContactSettings.js — run it once after deploying
    // this schema change if the local/production DB already has contact data.
    contact: {
      whatsapp: {
        number: { type: String, default: "" }, // digits only; wa.me link is built from this
        icon: { type: String, default: "" }, // R2 URL of the admin-uploaded WhatsApp logo
      },
      discord: {
        url: { type: String, default: "" },
        icon: { type: String, default: "" }, // R2 URL of the admin-uploaded Discord logo
      },
      title: { type: String, default: "Butuh Bantuan?" },
      description: { type: String, default: "" },
      buttonText: { type: String, default: "Hubungi Kami" },
      enabled: { type: Boolean, default: true },
    },

    footer: {
      logo: { type: String, default: "" },
      description: { type: String, default: "" },
      copyright: { type: String, default: "" },
      links: [{ label: String, url: String }],
      social: [{ platform: String, url: String }],
    },

    background: {
      mode: { type: String, enum: ["solid", "gradient", "image"], default: "gradient" },
      solidColor: { type: String, default: "#faf9ff" },
      gradient: { type: String, default: "" },
      image: { type: String, default: "" },
      overlay: { type: String, default: "" },
      animationEnabled: { type: Boolean, default: true },
      ambientEffectsEnabled: { type: Boolean, default: true },
    },

    theme: {
      primary: { type: String, default: "#7c3aed" },
      secondary: { type: String, default: "#a78bfa" },
      accent: { type: String, default: "#f4b400" },
      buttonColor: { type: String, default: "#7c3aed" },
      textColor: { type: String, default: "#211b31" },
      backgroundColor: { type: String, default: "#faf9ff" },
      borderColor: { type: String, default: "#e5e0f7" },
    },

    typography: {
      fontFamily: { type: String, default: "Inter" },
      baseSize: { type: String, default: "16px" },
      headingWeight: { type: String, default: "700" },
    },
  },
  { timestamps: true }
);

WebsiteSettingsSchema.statics.getSingleton = async function getSingleton() {
  let doc = await this.findOne({ singletonKey: "main" });
  if (!doc) {
    doc = await this.create({ singletonKey: "main" });
  }
  return doc;
};

module.exports = mongoose.model("WebsiteSettings", WebsiteSettingsSchema);
