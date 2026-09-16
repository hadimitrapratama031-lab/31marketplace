const axios = require("axios");
const { getFonnteConfig } = require("./integration.service");
const logger = require("../utils/logger");

// Fonnte API: POST https://api.fonnte.com/send
// Header: Authorization: <token>
// Body (form): target=<62xxxx>, message=<text>
async function sendWhatsApp(target, message) {
  const cfg = await getFonnteConfig();
  if (!cfg.enabled) {
    logger.warn("Fonnte not enabled/configured, skipping WhatsApp send", { target });
    return { success: false, message: "Fonnte belum dikonfigurasi." };
  }

  try {
    const params = new URLSearchParams();
    params.append("target", target);
    params.append("message", message);

    const response = await axios.post("https://api.fonnte.com/send", params, {
      headers: {
        Authorization: cfg.token,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      timeout: 15000,
    });

    if (response.data && response.data.status === true) {
      logger.info("Fonnte message sent", { target });
      return { success: true, response: response.data };
    }

    logger.warn("Fonnte send returned non-success", { target, response: response.data });
    return { success: false, message: response.data?.reason || "Gagal mengirim WhatsApp.", response: response.data };
  } catch (err) {
    logger.error("Fonnte send failed", { target, message: err.message });
    return { success: false, message: "Gagal menghubungi Fonnte." };
  }
}

async function testConnection(testTarget) {
  const cfg = await getFonnteConfig();
  if (!cfg.token) {
    return { success: false, message: "Token Fonnte belum diisi." };
  }
  if (!testTarget) {
    return { success: false, message: "Nomor tujuan test tidak boleh kosong." };
  }
  const result = await sendWhatsApp(testTarget, "Test koneksi Fonnte dari Admin Web berhasil ✅");
  return result.success
    ? { success: true, message: "Pesan test berhasil dikirim." }
    : { success: false, message: result.message || "Gagal mengirim pesan test." };
}

module.exports = { sendWhatsApp, testConnection };
