const IntegrationSettings = require("../models/IntegrationSettings");
const integrationService = require("../services/integration.service");
const klikqrisService = require("../services/klikqris.service");
const fonnteService = require("../services/fonnte.service");
const resendService = require("../services/resend.service");
const r2Service = require("../services/r2.service");
const notificationService = require("../services/notification.service");
const discordService = require("../services/discord.service");
const diagnostics = require("../services/diagnostics.service");
const asyncHandler = require("../utils/asyncHandler");
const { AppError } = require("../middlewares/errorHandler");
const { emitEvent } = require("../services/socket.service");

// ADMIN — status dots for KlikQRIS / Fonnte / Resend / R2 (never returns secrets).
const getStatus = asyncHandler(async (req, res) => {
  const summary = await integrationService.getIntegrationStatusSummary();
  res.json({ status: true, data: summary });
});

const updateKlikQris = asyncHandler(async (req, res) => {
  const { apiKey, merchantId, mode, enabled } = req.body;
  await integrationService.updateKlikQrisCredentials({ apiKey, merchantId, mode, enabled });
  emitEvent("integration:updated", { provider: "klikqris" });
  const summary = await integrationService.getIntegrationStatusSummary();
  res.json({ status: true, message: "Konfigurasi KlikQRIS disimpan.", data: summary.klikqris });
});

const updateFonnte = asyncHandler(async (req, res) => {
  const { token, enabled } = req.body;
  await integrationService.updateFonnteCredentials({ token, enabled });
  emitEvent("integration:updated", { provider: "fonnte" });
  const summary = await integrationService.getIntegrationStatusSummary();
  res.json({ status: true, message: "Konfigurasi Fonnte disimpan.", data: summary.fonnte });
});

const updateResend = asyncHandler(async (req, res) => {
  const { apiKey, fromEmail, fromName, replyTo, enabled } = req.body;
  await integrationService.updateResendCredentials({ apiKey, fromEmail, fromName, replyTo, enabled });
  emitEvent("integration:updated", { provider: "resend" });
  const summary = await integrationService.getIntegrationStatusSummary();
  res.json({ status: true, message: "Konfigurasi Resend disimpan.", data: summary.resend });
});

const testKlikQris = asyncHandler(async (req, res) => {
  const result = await klikqrisService.testConnection();
  const settings = await IntegrationSettings.getSingleton();
  settings.klikqris.lastTestStatus = result.success ? "success" : "error";
  settings.klikqris.lastTestAt = new Date();
  settings.klikqris.lastTestMessage = result.message;
  await settings.save();
  emitEvent("integration:updated", { provider: "klikqris" });
  res.json({ status: result.success, message: result.message });
});

const testFonnte = asyncHandler(async (req, res) => {
  const { testTarget } = req.body;
  const result = await fonnteService.testConnection(testTarget);
  const settings = await IntegrationSettings.getSingleton();
  settings.fonnte.lastTestStatus = result.success ? "success" : "error";
  settings.fonnte.lastTestAt = new Date();
  settings.fonnte.lastTestMessage = result.message;
  await settings.save();
  emitEvent("integration:updated", { provider: "fonnte" });
  res.json({ status: result.success, message: result.message });
});

const testResend = asyncHandler(async (req, res) => {
  const { testTo } = req.body;
  const result = await resendService.testConnection(testTo);
  const settings = await IntegrationSettings.getSingleton();
  settings.resend.lastTestStatus = result.success ? "success" : "error";
  settings.resend.lastTestAt = new Date();
  settings.resend.lastTestMessage = result.message;
  await settings.save();
  emitEvent("integration:updated", { provider: "resend" });
  res.json({ status: result.success, message: result.message });
});

// ADMIN — status verifikasi domain Resend (SPF/DKIM/DMARC) apa adanya dari
// Resend, untuk menjawab "kenapa masih masuk Spam?" dengan data asli, bukan
// dugaan (spec 3 & 9). Tidak pernah mengarang record DNS.
const getResendDomainStatus = asyncHandler(async (req, res) => {
  const result = await resendService.getDomainStatus();
  res.json({ status: result.success, message: result.message, data: result });
});

const testR2 = asyncHandler(async (req, res) => {
  const result = await r2Service.testConnection();
  const settings = await IntegrationSettings.getSingleton();
  settings.r2.lastTestStatus = result.success ? "success" : "error";
  settings.r2.lastTestAt = new Date();
  settings.r2.lastTestMessage = result.message;
  await settings.save();
  emitEvent("integration:updated", { provider: "r2" });
  res.json({ status: result.success, message: result.message });
});

const updateNotifications = asyncHandler(async (req, res) => {
  const settings = await IntegrationSettings.getSingleton();
  const { whatsappEnabled, emailEnabled, events } = req.body;
  if (whatsappEnabled !== undefined) settings.notifications.whatsappEnabled = whatsappEnabled;
  if (emailEnabled !== undefined) settings.notifications.emailEnabled = emailEnabled;
  if (events) settings.notifications.events = { ...settings.notifications.events.toObject(), ...events };
  await settings.save();
  emitEvent("notification:updated", {});
  res.json({ status: true, data: settings.notifications });
});

const getTemplates = asyncHandler(async (req, res) => {
  const settings = await IntegrationSettings.getSingleton();
  res.json({ status: true, data: settings.templates });
});

const updateTemplates = asyncHandler(async (req, res) => {
  const settings = await IntegrationSettings.getSingleton();
  const { whatsapp, email } = req.body;
  if (whatsapp) settings.templates.whatsapp = { ...settings.templates.whatsapp.toObject(), ...whatsapp };
  if (email) {
    const currentEmail = settings.templates.email.toObject();
    for (const key of Object.keys(email)) {
      currentEmail[key] = { ...currentEmail[key], ...email[key] };
    }
    settings.templates.email = currentEmail;
  }
  await settings.save();
  emitEvent("notification:updated", {});
  res.json({ status: true, data: settings.templates });
});

// ADMIN — riwayat pengiriman notifikasi. Memakai NotificationLog existing
// (yang memang sudah jadi kunci idempotency), bukan koleksi log baru.
const listNotificationLogs = asyncHandler(async (req, res) => {
  const { orderCode, event, channel, status, page, limit } = req.query;
  const result = await notificationService.listLogs({ orderCode, event, channel, status, page, limit });
  res.json({ status: true, data: result.rows, pagination: result.pagination });
});

// ADMIN — kirim ulang SATU channel yang gagal. Channel lain pada event yang
// sama tidak ikut dikirim ulang, termasuk yang sudah berhasil.
const retryNotification = asyncHandler(async (req, res) => {
  const result = await notificationService.retryLog(req.params.id);
  res.status(result.success ? 200 : 400).json({ status: result.success, message: result.message, data: result.data });
});

// ADMIN — merender keempat event tanpa mengirim apa pun, lewat resolver yang
// sama dengan pengiriman sungguhan. Dipakai untuk memverifikasi template mana
// yang aktif di runtime setelah migrasi.
const previewNotificationTemplates = asyncHandler(async (req, res) => {
  const data = await notificationService.previewTemplates(req.query.orderCode);
  res.json({ status: true, data });
});

/**
 * Menelusuri gambar email dari Admin Web → MongoDB → template → HTML → uji
 * akses dari internet. Read-only: tidak mengubah setting maupun template.
 */
const auditEmailAssets = asyncHandler(async (req, res) => {
  const data = await diagnostics.auditEmailAssets(req.query.orderCode);
  res.json({ status: true, data });
});

// Audit penyebab Spam dari sisi aplikasi/provider — tanpa menyentuh template.
const auditDeliverability = asyncHandler(async (req, res) => {
  const data = await diagnostics.auditDeliverability();
  res.json({ status: true, data });
});

const getDiscordStatus = asyncHandler(async (req, res) => {
  res.json({ status: true, data: discordService.getStatus() });
});

/**
 * Konfigurasi notifikasi Live Chat.
 *
 * Balasannya sengaja tidak pernah memuat token bot; yang dikirim hanya status
 * ("bot terpasang atau belum") supaya Admin Web bisa menjelaskan kenapa DM
 * tidak bisa aktif tanpa membocorkan kredensial apa pun.
 */
const getLiveChat = asyncHandler(async (req, res) => {
  const settings = await IntegrationSettings.getSingleton();
  const live = settings.liveChat || {};
  const discord = discordService.getStatus();
  res.json({
    status: true,
    data: {
      discordEnabled: Boolean(live.discordEnabled),
      adminDiscordUserId: live.adminDiscordUserId || "",
      // Nilai ENV dipakai sebagai cadangan kalau admin belum pernah mengisi form.
      envAdminUserId: Boolean(String(process.env.DISCORD_ADMIN_USER_ID || "").trim()),
      lastTestStatus: live.lastTestStatus || "untested",
      lastTestAt: live.lastTestAt || null,
      lastTestMessage: live.lastTestMessage || "",
      bot: {
        configured: discord.configured,
        mode: discord.mode,
        // DM hanya bisa lewat bot; webhook channel tidak mendukung DM sama sekali.
        dmCapable: discord.dmCapable,
      },
    },
  });
});

const updateLiveChat = asyncHandler(async (req, res) => {
  const settings = await IntegrationSettings.getSingleton();
  const { discordEnabled, adminDiscordUserId } = req.body || {};

  if (adminDiscordUserId !== undefined) {
    const clean = String(adminDiscordUserId || "").trim();
    // Snowflake Discord selalu numerik. Menolak di sini lebih baik daripada
    // menyimpan nilai yang pasti gagal saat DM dikirim.
    if (clean && !/^\d{5,25}$/.test(clean)) {
      throw new AppError("Discord User ID harus berupa angka (Developer Mode > Copy User ID).", 400);
    }
    settings.liveChat.adminDiscordUserId = clean;
  }
  if (discordEnabled !== undefined) settings.liveChat.discordEnabled = Boolean(discordEnabled);

  await settings.save();
  emitEvent("integration:updated", { provider: "livechat" });
  res.json({ status: true, message: "Konfigurasi notifikasi Live Chat disimpan." });
});

const testLiveChat = asyncHandler(async (req, res) => {
  const settings = await IntegrationSettings.getSingleton();
  const target =
    String(req.body && req.body.adminDiscordUserId ? req.body.adminDiscordUserId : "").trim() ||
    settings.liveChat.adminDiscordUserId ||
    String(process.env.DISCORD_ADMIN_USER_ID || "").trim();

  let storeName = "Live Chat";
  try {
    const website = await require("../models/WebsiteSettings").getSingleton();
    storeName = (website.general && website.general.storeName) || storeName;
  } catch {
    /* branding tidak wajib untuk test */
  }

  const result = await discordService.testLiveChatDM(target, storeName);

  settings.liveChat.lastTestStatus = result.success ? "success" : "error";
  settings.liveChat.lastTestAt = new Date();
  settings.liveChat.lastTestMessage = result.message;
  await settings.save();
  emitEvent("integration:updated", { provider: "livechat" });

  res.status(result.success ? 200 : 400).json({ status: result.success, message: result.message });
});

const testDiscord = asyncHandler(async (req, res) => {
  const result = await discordService.testConnection();
  res.status(result.success ? 200 : 400).json({ status: result.success, message: result.message });
});

module.exports = {
  auditEmailAssets,
  auditDeliverability,
  getDiscordStatus,
  testDiscord,
  getLiveChat,
  updateLiveChat,
  testLiveChat,
  previewNotificationTemplates,
  listNotificationLogs,
  retryNotification,
  getStatus,
  updateKlikQris,
  updateFonnte,
  updateResend,
  testKlikQris,
  testFonnte,
  testResend,
  getResendDomainStatus,
  testR2,
  updateNotifications,
  getTemplates,
  updateTemplates,
};
