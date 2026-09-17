const IntegrationSettings = require("../models/IntegrationSettings");
const integrationService = require("../services/integration.service");
const klikqrisService = require("../services/klikqris.service");
const fonnteService = require("../services/fonnte.service");
const resendService = require("../services/resend.service");
const r2Service = require("../services/r2.service");
const notificationService = require("../services/notification.service");
const asyncHandler = require("../utils/asyncHandler");
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
  const { apiKey, fromEmail, fromName, enabled } = req.body;
  await integrationService.updateResendCredentials({ apiKey, fromEmail, fromName, enabled });
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

module.exports = {
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
