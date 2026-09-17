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

    // `home.hero` is the Marketplace Home hero, edited in Admin Web under
    // Marketplace > Halaman depan. The five flat fields above it are the
    // original (pre-hero) shape and are kept so older documents and any code
    // still reading settings.home.heading keep working; the Marketplace
    // prefers `hero.*` and falls back to them. Nothing here is hardcoded in
    // the frontend, including the slide counter, which is derived from the
    // number of enabled slides.
    home: {
      heading: { type: String, default: "" },
      subtitle: { type: String, default: "" },
      description: { type: String, default: "" },
      ctaText: { type: String, default: "" },
      ctaLink: { type: String, default: "" },

      hero: {
        eyebrow: {
          text: { type: String, default: "" },
          enabled: { type: Boolean, default: true },
        },
        // Three separate lines instead of one string: the admin decides where
        // the heading breaks, and `accentText` marks the words that take the
        // accent colour, so emphasis never has to be hardcoded in the markup.
        heading: {
          line1: { type: String, default: "" },
          line2: { type: String, default: "" },
          line3: { type: String, default: "" },
          accentText: { type: String, default: "" },
          accentColor: { type: String, default: "" },
        },
        description: { type: String, default: "" },
        primaryButton: {
          enabled: { type: Boolean, default: true },
          text: { type: String, default: "" },
          url: { type: String, default: "" },
        },
        secondaryButton: {
          enabled: { type: Boolean, default: true },
          text: { type: String, default: "" },
          url: { type: String, default: "" },
        },
        // Single artwork. Used when no slide is enabled; uploaded through the
        // existing /api/settings/admin/upload endpoint, so the file lives in
        // Cloudflare R2 and only its URL is stored here.
        image: {
          url: { type: String, default: "" },
          alt: { type: String, default: "" },
        },
        // Corner captions drawn over the artwork. Top-right is left empty by
        // default so the automatic NN / NN slide counter shows there instead.
        overlay: {
          enabled: { type: Boolean, default: true },
          topLeft: { type: String, default: "" },
          topRight: { type: String, default: "" },
          bottomLeft: { type: String, default: "" },
          bottomRight: { type: String, default: "" },
        },
        slides: [
          {
            image: { type: String, default: "" },
            alt: { type: String, default: "" },
            enabled: { type: Boolean, default: true },
            sortOrder: { type: Number, default: 0 },
            topLeft: { type: String, default: "" },
            topRight: { type: String, default: "" },
            bottomLeft: { type: String, default: "" },
            bottomRight: { type: String, default: "" },
          },
        ],
        autoplay: {
          enabled: { type: Boolean, default: true },
          intervalMs: { type: Number, default: 6000 },
        },
      },
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

    // Global background for every Marketplace page. `secondary` is the one
    // companion colour that sits opposite the purple in the ambient layer;
    // `intensity` and `animationIntensity` are 0-100 and are handed to CSS as
    // plain multipliers, so there is no second animation system to maintain.
    background: {
      mode: { type: String, enum: ["solid", "gradient", "image"], default: "gradient" },
      solidColor: { type: String, default: "#fbfaff" },
      secondary: { type: String, default: "#f3a8c9" },
      gradient: { type: String, default: "" },
      image: { type: String, default: "" },
      overlay: { type: String, default: "" },
      intensity: { type: Number, default: 100, min: 0, max: 100 },
      animationIntensity: { type: Number, default: 100, min: 0, max: 100 },
      animationEnabled: { type: Boolean, default: true },
      ambientEffectsEnabled: { type: Boolean, default: true },
    },

    theme: {
      primary: { type: String, default: "#6d3bee" },
      secondary: { type: String, default: "#7d54f0" },
      accent: { type: String, default: "#b97706" },
      buttonColor: { type: String, default: "#6d3bee" },
      textColor: { type: String, default: "#17122a" },
      backgroundColor: { type: String, default: "#fbfaff" },
      borderColor: { type: String, default: "#ebe4ff" },
    },

    typography: {
      fontFamily: { type: String, default: "Plus Jakarta Sans" },
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
