const axios = require("axios");
const { getFonnteConfig } = require("./integration.service");
const { normalizeWhatsApp, isValidWhatsApp } = require("../utils/phone");
const logger = require("../utils/logger");

// Fonnte API: POST https://api.fonnte.com/send
// Header: Authorization: <token>
// Body (form): target=<62xxxx>, message=<text>
//
// Semua fungsi di sini mengembalikan bentuk hasil yang sama:
//   { success, permanent, message, response, httpStatus }
// `permanent` menentukan boleh-tidaknya di-retry: token salah atau nomor
// tidak valid akan gagal lagi dengan cara yang persis sama, jadi mengulang
// hanya membuang kuota (spec 5).

const TIMEOUT_MS = 20000;

// Error jaringan/timeout/5xx = sementara. 401/403 (token) dan 4xx lain yang
// menolak isi permintaan = permanen.
function classifyTransportError(err) {
  const httpStatus = err.response && err.response.status;
  const code = err.code || "";

  if (["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"].includes(code)) {
    return { permanent: false, message: `Fonnte tidak dapat dihubungi (${code}).`, httpStatus: null };
  }
  if (!httpStatus) {
    return { permanent: false, message: `Fonnte tidak dapat dihubungi: ${err.message}`, httpStatus: null };
  }
  if (httpStatus >= 500) {
    return { permanent: false, message: `Fonnte mengembalikan error server (HTTP ${httpStatus}).`, httpStatus };
  }
  if (httpStatus === 429) {
    return { permanent: false, message: "Fonnte membatasi jumlah permintaan (HTTP 429).", httpStatus };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return { permanent: true, message: "Token Fonnte ditolak (HTTP " + httpStatus + "). Periksa token di Admin Web.", httpStatus };
  }
  const reason = err.response && err.response.data && err.response.data.reason;
  return { permanent: true, message: reason ? `Fonnte menolak permintaan: ${reason}` : `Fonnte menolak permintaan (HTTP ${httpStatus}).`, httpStatus };
}

// Fonnte bisa membalas HTTP 200 tapi TIDAK mengirim apa pun. Status HTTP saja
// tidak pernah cukup — `status` harus true DAN harus ada id pesan yang
// dihasilkan, kalau tidak pesan tidak masuk antrean pengiriman (spec 26).
function interpretFonnteBody(body, httpStatus) {
  if (!body || typeof body !== "object") {
    return { success: false, permanent: false, message: "Balasan Fonnte tidak dapat dibaca.", response: body, httpStatus };
  }
  if (body.status !== true) {
    const reason = body.reason || body.detail || "Fonnte menolak pengiriman.";
    // Nomor yang tidak terdaftar/salah format tidak akan pernah berhasil
    // walau dicoba seribu kali.
    const permanent = /invalid|not registered|tidak valid|format|target/i.test(String(reason));
    return { success: false, permanent, message: `Fonnte: ${reason}`, response: body, httpStatus };
  }
  const ids = Array.isArray(body.id) ? body.id : body.id ? [body.id] : [];
  if (ids.length === 0) {
    return {
      success: false,
      permanent: false,
      message: `Fonnte membalas sukses tanpa id pesan${body.detail ? ` (${body.detail})` : ""} — pesan tidak masuk antrean.`,
      response: body,
      httpStatus,
    };
  }
  return { success: true, permanent: false, message: "", response: body, httpStatus };
}

// Pengirim level bawah: hanya butuh token. Apakah Fonnte "enabled" untuk
// notifikasi otomatis adalah urusan terpisah (lihat sendWhatsApp) — tombol
// Test WhatsApp harus tetap bisa dipakai untuk memverifikasi token baru
// sebelum switch Enabled dinyalakan.
async function sendWhatsAppRaw(token, target, message) {
  const normalizedTarget = normalizeWhatsApp(target) || String(target || "");

  if (!token) {
    return { success: false, permanent: true, message: "Token Fonnte belum dikonfigurasi." };
  }
  if (!isValidWhatsApp(target)) {
    return { success: false, permanent: true, message: `Nomor WhatsApp tujuan tidak valid: ${normalizedTarget || "(kosong)"}` };
  }
  if (!message || !String(message).trim()) {
    return { success: false, permanent: true, message: "Isi pesan WhatsApp kosong." };
  }

  try {
    const params = new URLSearchParams();
    params.append("target", normalizedTarget);
    params.append("message", message);

    const response = await axios.post("https://api.fonnte.com/send", params, {
      headers: { Authorization: token, "Content-Type": "application/x-www-form-urlencoded" },
      timeout: TIMEOUT_MS,
      // Body error milik Fonnte lebih informatif daripada exception axios,
      // jadi status <500 ditangani sebagai hasil, bukan lemparan.
      validateStatus: (s) => s >= 200 && s < 500,
    });

    const result = interpretFonnteBody(response.data, response.status);
    if (result.success) {
      logger.info("Fonnte message accepted", { target: normalizedTarget, httpStatus: response.status });
    } else {
      logger.warn("Fonnte send rejected", { target: normalizedTarget, httpStatus: response.status, reason: result.message });
    }
    return result;
  } catch (err) {
    const classified = classifyTransportError(err);
    logger.error("Fonnte send failed", { target: normalizedTarget, httpStatus: classified.httpStatus, reason: classified.message });
    return { success: false, ...classified };
  }
}

// Dipakai untuk notifikasi order sungguhan — menghormati toggle Enabled agar
// admin bisa mematikan notifikasi WhatsApp tanpa menghapus token.
async function sendWhatsApp(target, message) {
  const cfg = await getFonnteConfig();
  if (!cfg.enabled) {
    return { success: false, permanent: true, disabled: true, message: "Fonnte belum diaktifkan/dikonfigurasi." };
  }
  return sendWhatsAppRaw(cfg.token, target, message);
}

// Dipakai tombol "Test WhatsApp" — cukup token tersimpan, tanpa melihat
// toggle Enabled, supaya kredensial bisa diverifikasi lebih dulu.
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
  const result = await sendWhatsAppRaw(cfg.token, testTarget, "Test koneksi Fonnte dari Admin Web berhasil.");
  return result.success
    ? { success: true, message: "Pesan test berhasil dikirim." }
    : { success: false, message: result.message || "Gagal mengirim pesan test." };
}

module.exports = { sendWhatsApp, sendWhatsAppRaw, testConnection };
