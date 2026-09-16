const axios = require("axios");
const { getResendConfig } = require("./integration.service");
const { isValidEmail } = require("../utils/phone");
const logger = require("../utils/logger");

// Resend API: POST https://api.resend.com/emails
// Header: Authorization: Bearer <api_key>
//
// Low-level sender: only requires apiKey/fromEmail to be present. Whether
// Resend is "enabled" for automatic order notifications is a SEPARATE
// concern (see sendEmail below) — Test Email must keep working even before
// the admin flips the Enabled switch on.
async function sendEmailRaw({ apiKey, fromEmail, fromName, to, subject, html }) {
  try {
    const response = await axios.post(
      "https://api.resend.com/emails",
      {
        from: `${fromName || "Store"} <${fromEmail}>`,
        to: [to],
        subject,
        html,
      },
      {
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );

    logger.info("Resend email sent", { to, id: response.data?.id });
    return { success: true, response: response.data };
  } catch (err) {
    const providerMessage = err.response?.data?.message;
    logger.error("Resend send failed", { to, message: providerMessage || err.message });
    return { success: false, message: providerMessage ? `Resend menolak permintaan: ${providerMessage}` : "Gagal mengirim email." };
  }
}

// Used for real order notifications — respects the Enabled toggle so admin
// can turn email notifications off without deleting the API key.
async function sendEmail({ to, subject, html }) {
  const cfg = await getResendConfig();
  if (!cfg.enabled) {
    logger.warn("Resend not enabled/configured, skipping email send", { to });
    return { success: false, message: "Resend belum diaktifkan/dikonfigurasi." };
  }
  return sendEmailRaw({ apiKey: cfg.apiKey, fromEmail: cfg.fromEmail, fromName: cfg.fromName, to, subject, html });
}

// Used by the "Test Email" button — only requires apiKey + fromEmail to be
// saved, regardless of the Enabled toggle, so credentials can be verified first.
async function testConnection(testTo) {
  const cfg = await getResendConfig();
  if (!cfg.apiKey || !cfg.fromEmail) {
    return { success: false, message: "API key / From email belum diisi." };
  }
  if (!testTo || !isValidEmail(testTo)) {
    return { success: false, message: "Email tujuan test tidak valid." };
  }
  const result = await sendEmailRaw({
    apiKey: cfg.apiKey,
    fromEmail: cfg.fromEmail,
    fromName: cfg.fromName,
    to: testTo,
    subject: "Test Koneksi Resend",
    html: "<p>Test koneksi Resend dari Admin Web berhasil ✅</p>",
  });
  return result.success
    ? { success: true, message: "Email test berhasil dikirim." }
    : { success: false, message: result.message || "Gagal mengirim email test." };
}

module.exports = { sendEmail, testConnection };
