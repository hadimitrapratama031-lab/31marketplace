const IntegrationSettings = require("../models/IntegrationSettings");
const { encrypt, decrypt, maskSecret } = require("../utils/crypto");

// Credentials can either be configured from Admin Web (stored encrypted in
// MongoDB) or via Railway ENV variables. DB value wins when present,
// otherwise we fall back to ENV so the system still works right after
// deployment before an admin opens the settings page.

// Copy-pasted credentials (from Admin Web or Railway's env editor) very
// commonly pick up a trailing newline/space, or — for env vars — surrounding
// quotes typed literally into the value box. KlikQRIS's API validates
// id_merchant/api key format strictly, so an otherwise-correct credential
// with invisible extra characters is rejected outright (422/401) with no
// obvious visual difference in Admin Web's masked preview. Normalize once,
// here, so every caller gets a clean value regardless of source.
function cleanCredential(value) {
  if (!value) return value;
  return String(value).trim().replace(/^["']|["']$/g, "");
}

async function getKlikQrisConfig() {
  const settings = await IntegrationSettings.getSingleton();
  const kq = settings.klikqris;
  const apiKey = cleanCredential(kq.apiKeyEncrypted ? decrypt(kq.apiKeyEncrypted) : process.env.KLIKQRIS_API_KEY);
  const merchantId = cleanCredential(
    kq.merchantIdEncrypted ? decrypt(kq.merchantIdEncrypted) : process.env.KLIKQRIS_MERCHANT_ID
  );

  // `mode` is only ever written by updateKlikQrisCredentials(), in the same
  // save as apiKey/merchantId — there is no other code path that sets it. So
  // if an admin has never saved either of those from Admin Web, any value
  // sitting in `kq.mode` (including a leftover "production" from an older
  // schema default that auto-created this document on first boot) was never
  // an intentional choice, and must not outrank KLIKQRIS_MODE from ENV. This
  // is what previously sent a sandbox API key to the production endpoint —
  // KlikQRIS correctly rejects that combination, which is what surfaced as
  // "gagal menghubungi payment gateway".
  const adminConfiguredKlikQris = Boolean(kq.apiKeyEncrypted || kq.merchantIdEncrypted);
  const storedMode = adminConfiguredKlikQris ? kq.mode : null;
  // Normalize casing — ENV values (KLIKQRIS_MODE=Sandbox etc.) are user-typed
  // and easy to get wrong-cased, which would otherwise silently fall through
  // to the production base URL while using a sandbox key.
  const mode = String(storedMode || process.env.KLIKQRIS_MODE || "production").toLowerCase();
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
  if (apiKey) settings.klikqris.apiKeyEncrypted = encrypt(cleanCredential(apiKey));
  if (merchantId) settings.klikqris.merchantIdEncrypted = encrypt(cleanCredential(merchantId));
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
  // Effective mode, not the raw stored field: a document created before an
  // admin ever visited this page can hold a leftover value that ENV is
  // actually overriding at request time (see getKlikQrisConfig). Showing the
  // raw field here would tell the admin the opposite of what's really live.
  const kqEffective = await getKlikQrisConfig();

  return {
    klikqris: {
      configured: kqConfigured,
      enabled: settings.klikqris.enabled,
      mode: kqEffective.mode,
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
