const IntegrationSettings = require("../models/IntegrationSettings");
const { encrypt, decrypt, maskSecret } = require("../utils/crypto");

// Credentials can either be configured from Admin Web (stored encrypted in
// MongoDB) or via Railway ENV variables. DB value wins when present,
// otherwise we fall back to ENV so the system still works right after
// deployment before an admin opens the settings page.

async function getKlikQrisConfig() {
  const settings = await IntegrationSettings.getSingleton();
  const kq = settings.klikqris;
  const apiKey = kq.apiKeyEncrypted ? decrypt(kq.apiKeyEncrypted) : process.env.KLIKQRIS_API_KEY;
  const merchantId = kq.merchantIdEncrypted ? decrypt(kq.merchantIdEncrypted) : process.env.KLIKQRIS_MERCHANT_ID;
  // Normalize casing — ENV values (KLIKQRIS_MODE=Sandbox etc.) are user-typed
  // and easy to get wrong-cased, which would otherwise silently fall through
  // to the production base URL while using a sandbox key.
  const mode = String(kq.mode || process.env.KLIKQRIS_MODE || "production").toLowerCase();
  const baseUrl =
    mode === "sandbox" ? "https://klikqris.com/api/sandbox" : process.env.KLIKQRIS_BASE_URL || "https://klikqris.com/api";

  return {
    enabled: Boolean(kq.enabled) && Boolean(apiKey) && Boolean(merchantId),
    apiKey,
    merchantId,
    mode,
    baseUrl,
    webhookUrl: process.env.KLIKQRIS_WEBHOOK_URL,
  };
}

async function getFonnteConfig() {
  const settings = await IntegrationSettings.getSingleton();
  const fn = settings.fonnte;
  const token = fn.tokenEncrypted ? decrypt(fn.tokenEncrypted) : process.env.FONNTE_TOKEN;
  return { enabled: Boolean(fn.enabled) && Boolean(token), token };
}

async function getResendConfig() {
  const settings = await IntegrationSettings.getSingleton();
  const rs = settings.resend;
  const apiKey = rs.apiKeyEncrypted ? decrypt(rs.apiKeyEncrypted) : process.env.RESEND_API_KEY;
  const fromEmail = rs.fromEmail || process.env.RESEND_FROM_EMAIL;
  const fromName = rs.fromName || process.env.RESEND_FROM_NAME;
  return { enabled: Boolean(rs.enabled) && Boolean(apiKey), apiKey, fromEmail, fromName };
}

async function updateKlikQrisCredentials({ apiKey, merchantId, mode, enabled }) {
  const settings = await IntegrationSettings.getSingleton();
  if (apiKey) settings.klikqris.apiKeyEncrypted = encrypt(apiKey);
  if (merchantId) settings.klikqris.merchantIdEncrypted = encrypt(merchantId);
  if (mode) settings.klikqris.mode = mode;
  if (typeof enabled === "boolean") settings.klikqris.enabled = enabled;
  await settings.save();
  return settings;
}

async function updateFonnteCredentials({ token, enabled }) {
  const settings = await IntegrationSettings.getSingleton();
  if (token) settings.fonnte.tokenEncrypted = encrypt(token);
  if (typeof enabled === "boolean") settings.fonnte.enabled = enabled;
  await settings.save();
  return settings;
}

async function updateResendCredentials({ apiKey, fromEmail, fromName, enabled }) {
  const settings = await IntegrationSettings.getSingleton();
  if (apiKey) settings.resend.apiKeyEncrypted = encrypt(apiKey);
  if (fromEmail) settings.resend.fromEmail = fromEmail;
  if (fromName) settings.resend.fromName = fromName;
  if (typeof enabled === "boolean") settings.resend.enabled = enabled;
  await settings.save();
  return settings;
}

// Builds a safe (no secrets) status object for Admin Web's integration dashboard.
async function getIntegrationStatusSummary() {
  const settings = await IntegrationSettings.getSingleton();
  const { isR2Configured } = require("../config/r2");

  const kqConfigured = Boolean(settings.klikqris.apiKeyEncrypted || process.env.KLIKQRIS_API_KEY);
  const fnConfigured = Boolean(settings.fonnte.tokenEncrypted || process.env.FONNTE_TOKEN);
  const rsConfigured = Boolean(settings.resend.apiKeyEncrypted || process.env.RESEND_API_KEY);

  return {
    klikqris: {
      configured: kqConfigured,
      enabled: settings.klikqris.enabled,
      mode: settings.klikqris.mode,
      apiKeyMasked: settings.klikqris.apiKeyEncrypted ? maskSecret(decrypt(settings.klikqris.apiKeyEncrypted)) : null,
      lastTestStatus: settings.klikqris.lastTestStatus,
      lastTestAt: settings.klikqris.lastTestAt,
      lastTestMessage: settings.klikqris.lastTestMessage,
    },
    fonnte: {
      configured: fnConfigured,
      enabled: settings.fonnte.enabled,
      tokenMasked: settings.fonnte.tokenEncrypted ? maskSecret(decrypt(settings.fonnte.tokenEncrypted)) : null,
      lastTestStatus: settings.fonnte.lastTestStatus,
      lastTestAt: settings.fonnte.lastTestAt,
      lastTestMessage: settings.fonnte.lastTestMessage,
    },
    resend: {
      configured: rsConfigured,
      enabled: settings.resend.enabled,
      apiKeyMasked: settings.resend.apiKeyEncrypted ? maskSecret(decrypt(settings.resend.apiKeyEncrypted)) : null,
      fromEmail: settings.resend.fromEmail || process.env.RESEND_FROM_EMAIL || null,
      fromName: settings.resend.fromName || process.env.RESEND_FROM_NAME || null,
      lastTestStatus: settings.resend.lastTestStatus,
      lastTestAt: settings.resend.lastTestAt,
      lastTestMessage: settings.resend.lastTestMessage,
    },
    r2: {
      configured: isR2Configured(),
      lastTestStatus: settings.r2.lastTestStatus,
      lastTestAt: settings.r2.lastTestAt,
      lastTestMessage: settings.r2.lastTestMessage,
    },
    notifications: settings.notifications,
  };
}

module.exports = {
  getKlikQrisConfig,
  getFonnteConfig,
  getResendConfig,
  updateKlikQrisCredentials,
  updateFonnteCredentials,
  updateResendCredentials,
  getIntegrationStatusSummary,
};
