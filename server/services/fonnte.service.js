const axios = require("axios");
const { getFonnteConfig } = require("./integration.service");
const { normalizeWhatsApp } = require("../utils/phone");
const logger = require("../utils/logger");

// Fonnte API: POST https://api.fonnte.com/send
// Header: Authorization: <token>
// Body (form): target=<62xxxx>, message=<text>
//
// Low-level sender: only requires a token to be present. Whether Fonnte is
// "enabled" for automatic order notifications is a SEPARATE concern (see
// sendWhatsApp below) — Test WhatsApp must keep working even before the
// admin flips the Enabled switch on, otherwise there is no way to verify a
// freshly-pasted token before committing to it.
async function sendWhatsAppRaw(token, target, message) {
  const normalizedTarget = normalizeWhatsApp(target) || target;
  try {
    const params = new URLSearchParams();
    params.append("target", normalizedTarget);
    params.append("message", message);

    const response = await axios.post("https://api.fonnte.com/send", params, {
      headers: {
        Authorization: token,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      timeout: 15000,
    });

    if (response.data && response.data.status === true) {
      logger.info("Fonnte message sent", { target: normalizedTarget });
      return { success: true, response: response.data };
    }

    logger.warn("Fonnte send returned non-success", { target: normalizedTarget, response: response.data });
    return { success: false, message: response.data?.reason || "Gagal mengirim WhatsApp.", response: response.data };
  } catch (err) {
    logger.error("Fonnte send failed", { target: normalizedTarget, message: err.response?.data?.reason || err.message });
    return { success: false, message: "Gagal menghubungi Fonnte. Periksa token dan koneksi." };
  }
}

// Used for real order notifications — respects the Enabled toggle so admin
// can turn WhatsApp notifications off without deleting the token.
async function sendWhatsApp(target, message) {
  const cfg = await getFonnteConfig();
  if (!cfg.enabled) {
    logger.warn("Fonnte not enabled/configured, skipping WhatsApp send", { target });
    return { success: false, message: "Fonnte belum diaktifkan/dikonfigurasi." };
  }
  return sendWhatsAppRaw(cfg.token, target, message);
}

// Used by the "Test WhatsApp" button — only requires a token to be saved,
// regardless of the Enabled toggle, so credentials can be verified first.
async function testConnection(testTarget) {
  const cfg = await getFonnteConfig();
  if (!cfg.token) {
    return { success: false, message: "Token Fonnte belum diisi." };
  }
  if (!testTarget) {
    return { success: false, message: "Nomor tujuan test tidak boleh kosong." };
  }
  if (!normalizeWhatsApp(testTarget)) {
    return { success: false, message: "Format nomor WhatsApp tidak valid." };
  }
  const result = await sendWhatsAppRaw(cfg.token, testTarget, "Test koneksi Fonnte dari Admin Web berhasil ✅");
  return result.success
    ? { success: true, message: "Pesan test berhasil dikirim." }
    : { success: false, message: result.message || "Gagal mengirim pesan test." };
}

module.exports = { sendWhatsApp, testConnection };
