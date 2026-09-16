const WebsiteSettings = require("../models/WebsiteSettings");
const asyncHandler = require("../utils/asyncHandler");
const { emitEvent } = require("../services/socket.service");
const r2Service = require("../services/r2.service");

const SECTION_EVENT_MAP = {
  general: "website:settings:updated",
  navbar: "navbar:updated",
  home: "home:updated",
  statistics: "statistics:updated",
  highlights: "home:updated",
  contact: "contact:updated",
  footer: "website:settings:updated",
  background: "website:settings:updated",
  theme: "website:settings:updated",
  typography: "website:settings:updated",
};

// PUBLIC — Marketplace initial load fetches this once, then relies on Socket.IO.
const getPublic = asyncHandler(async (req, res) => {
  const settings = await WebsiteSettings.getSingleton();
  res.json({ status: true, data: settings });
});

// ADMIN — same payload, admin panel also needs full settings to edit.
const getAdmin = asyncHandler(async (req, res) => {
  const settings = await WebsiteSettings.getSingleton();
  res.json({ status: true, data: settings });
});

// ADMIN — generic PATCH per section: body = { section: 'general', data: {...} }
const updateSection = asyncHandler(async (req, res) => {
  const { section } = req.params;
  const settings = await WebsiteSettings.getSingleton();

  if (!(section in settings.toObject())) {
    return res.status(400).json({ status: false, message: "Section tidak dikenali." });
  }

  const current = settings[section];
  const currentPlain = current && typeof current.toObject === "function" ? current.toObject() : current;

  if (Array.isArray(currentPlain)) {
    // Array sections (e.g. `highlights`) are replaced wholesale — a shallow
    // object spread would turn the array into {0:..,1:..} and corrupt the doc.
    const incoming = Array.isArray(req.body) ? req.body : req.body.items;
    if (!Array.isArray(incoming)) {
      return res.status(400).json({ status: false, message: "Section ini membutuhkan array." });
    }
    settings[section] = incoming;
  } else {
    settings[section] = { ...currentPlain, ...req.body };
  }

  await settings.save();

  const eventName = SECTION_EVENT_MAP[section] || "website:settings:updated";
  emitEvent(eventName, { section, data: settings[section] });
  emitEvent("website:settings:updated", { section });

  res.json({ status: true, data: settings });
});

// ADMIN — upload an asset (logo/favicon/background/etc) and store its URL into a given settings path.
const uploadAsset = asyncHandler(async (req, res) => {
  if (!req.file) return res.status(400).json({ status: false, message: "File tidak ditemukan." });
  const { folder = "settings" } = req.body;
  const uploaded = await r2Service.uploadBuffer(req.file.buffer, req.file.originalname, req.file.mimetype, folder);
  res.json({ status: true, data: uploaded });
});

module.exports = { getPublic, getAdmin, updateSection, uploadAsset };
