const axios = require("axios");
const { getResendConfig } = require("./integration.service");
const logger = require("../utils/logger");

// Resend API: POST https://api.resend.com/emails
// Header: Authorization: Bearer <api_key>
async function sendEmail({ to, subject, html }) {
  const cfg = await getResendConfig();
  if (!cfg.enabled) {
    logger.warn("Resend not enabled/configured, skipping email send", { to });
    return { success: false, message: "Resend belum dikonfigurasi." };
  }

  try {
    const response = await axios.post(
      "https://api.resend.com/emails",
      {
        from: `${cfg.fromName || "Store"} <${cfg.fromEmail}>`,
        to: [to],
        subject,
        html,
      },
      {
        headers: {
          Authorization: `Bearer ${cfg.apiKey}`,
          "Content-Type": "application/json",
        },
        timeout: 15000,
      }
    );

    logger.info("Resend email sent", { to, id: response.data?.id });
    return { success: true, response: response.data };
  } catch (err) {
    logger.error("Resend send failed", { to, message: err.response?.data?.message || err.message });
    return { success: false, message: "Gagal mengirim email." };
  }
}

async function testConnection(testTo) {
  const cfg = await getResendConfig();
  if (!cfg.apiKey || !cfg.fromEmail) {
    return { success: false, message: "API key / From email belum diisi." };
  }
  if (!testTo) {
    return { success: false, message: "Email tujuan test tidak boleh kosong." };
  }
  const result = await sendEmail({
    to: testTo,
    subject: "Test Koneksi Resend",
    html: "<p>Test koneksi Resend dari Admin Web berhasil ✅</p>",
  });
  return result.success
    ? { success: true, message: "Email test berhasil dikirim." }
    : { success: false, message: result.message || "Gagal mengirim email test." };
}

module.exports = { sendEmail, testConnection };
