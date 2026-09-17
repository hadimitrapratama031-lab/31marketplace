/**
 * Discord — channel notifikasi ketiga, khusus PAYMENT_SUCCESS.
 *
 * Bentuk hasilnya sengaja SAMA PERSIS dengan fonnte.service.js dan
 * resend.service.js ({ success, permanent, message, response, httpStatus })
 * supaya notification.service bisa memakainya lewat deliverChannel() yang
 * sudah ada — idempotency, retry terbatas, NotificationLog, dan Socket.IO-nya
 * ikut apa adanya. Tidak ada service notifikasi kedua, tidak ada bot kedua.
 *
 * Kredensial tidak pernah disimpan di MongoDB dan tidak pernah dikirim ke
 * frontend: token bot hanya dibaca dari ENV di sisi server.
 *
 * Dua mode, keduanya memakai REST API Discord (tanpa gateway/websocket,
 * jadi tidak ada proses bot yang harus hidup terus):
 *   1. Bot   — DISCORD_BOT_TOKEN + DISCORD_CHANNEL_ID
 *   2. Webhook — DISCORD_WEBHOOK_URL (dipakai kalau bot tidak dikonfigurasi)
 */

const axios = require("axios");
const logger = require("../utils/logger");

const TIMEOUT_MS = 15000;
const API_BASE = "https://discord.com/api/v10";

// Warna dari template Discord existing yang diberikan (color: 4321431 =
// #41F097). Dipertahankan apa adanya, bukan didekati dengan warna lain.
const ACCENT_SUCCESS = 4321431;

function getConfig() {
  const botToken = String(process.env.DISCORD_BOT_TOKEN || "").trim();
  const channelId = String(process.env.DISCORD_CHANNEL_ID || "").trim();
  const webhookUrl = String(process.env.DISCORD_WEBHOOK_URL || "").trim();

  const mode = botToken && channelId ? "bot" : webhookUrl ? "webhook" : null;
  return { botToken, channelId, webhookUrl, mode, configured: Boolean(mode) };
}

function classifyTransportError(err) {
  const httpStatus = err.response && err.response.status;
  const code = err.code || "";
  const providerMessage = err.response && err.response.data && err.response.data.message;

  if (["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"].includes(code)) {
    return { permanent: false, message: `Discord tidak dapat dihubungi (${code}).`, httpStatus: null };
  }
  if (!httpStatus) {
    return { permanent: false, message: `Discord tidak dapat dihubungi: ${err.message}`, httpStatus: null };
  }
  if (httpStatus >= 500) {
    return { permanent: false, message: `Discord mengembalikan error server (HTTP ${httpStatus}).`, httpStatus };
  }
  if (httpStatus === 429) {
    return { permanent: false, message: "Discord membatasi jumlah permintaan (HTTP 429).", httpStatus };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return {
      permanent: true,
      message: `Discord menolak kredensial (HTTP ${httpStatus}). Periksa DISCORD_BOT_TOKEN dan izin bot di channel tujuan.`,
      httpStatus,
    };
  }
  if (httpStatus === 404) {
    return {
      permanent: true,
      message: "Channel Discord tidak ditemukan. Periksa DISCORD_CHANNEL_ID / DISCORD_WEBHOOK_URL.",
      httpStatus,
    };
  }
  return {
    permanent: true,
    message: providerMessage ? `Discord menolak permintaan: ${providerMessage}` : `Discord menolak permintaan (HTTP ${httpStatus}).`,
    httpStatus,
  };
}

// Discord memotong nilai field yang terlalu panjang dan menolak embed yang
// melebihi batasnya — dipangkas di sini supaya nama produk yang panjang tidak
// pernah menggagalkan pengiriman.
function clamp(value, max) {
  const text = String(value === undefined || value === null ? "" : value).trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function field(name, value, inline = true) {
  const clean = clamp(value, 1024);
  if (!clean) return null;
  return { name: clamp(name, 256), value: clean, inline };
}

/**
 * Embed PAYMENT_SUCCESS.
 *
 * Bentuk/struktur mengikuti template Discord Embed existing apa adanya:
 * author + icon toko, judul sebagai heading markdown di description (bukan
 * field "title" bawaan Discord), enam field yang sama dengan label & emoji
 * yang sama ("Costumer" memang begitu ejaannya di template asal), lalu
 * Image/Banner besar di bagian bawah embed — BUKAN thumbnail kecil — supaya
 * tiap product punya banner sendiri sesuai spec (bukan lagi ikon pojok kecil
 * seperti sebelumnya).
 *
 * Dibangun dari `ctx` yang SAMA dengan email dan WhatsApp (lihat
 * template.service.buildContext), jadi angka, status, dan waktunya tidak
 * mungkin berbeda antar channel. `ctx.productImage` berasal dari snapshot
 * gambar produk pada order tersebut (dengan fallback ke gambar produk yang
 * hidup sekarang kalau snapshotnya tidak valid — lihat
 * notification.service.resolveProductImageFallback), jadi tidak pernah
 * gambar produk lain atau gambar default/placeholder.
 */
function buildPaymentSuccessEmbed(ctx) {
  const storeName = clamp(ctx.storeName || "Store", 256);
  // Sudah lewat proxy domain toko sendiri (lihat template.service.buildContext)
  // — tidak diproses ulang di sini supaya tidak ada dua tempat yang menentukan
  // URL final.
  const logoUrl = ctx.logoUrl || "";
  const productImage = ctx.productImage || "";

  const fields = [
    field("👤 Costumer", ctx.customerName, false),
    field("🛒 Product", ctx.quantity > 1 ? `${ctx.productName} x${ctx.quantity}` : ctx.productName, false),
    field("🆔 Order", ctx.orderCode, false),
    field("💰 Price", ctx.total, false),
    field("⌚ Payment Time", ctx.paidAt || ctx.orderedAt, false),
    field("📄 Status", ctx.statusLabel, false),
  ].filter(Boolean);

  const embed = {
    author: logoUrl ? { name: storeName, icon_url: logoUrl } : { name: storeName },
    description: "# :white_check_mark: Pembayaran Berhasil\n",
    color: ACCENT_SUCCESS,
    fields,
    timestamp: new Date().toISOString(),
    footer: logoUrl ? { text: storeName, icon_url: logoUrl } : { text: storeName },
  };

  // Image/Banner — bukan thumbnail — dan selalu gambar PRODUCT dari order ini.
  if (productImage) embed.image = { url: productImage };

  return embed;
}

async function postEmbed(embed) {
  const cfg = getConfig();
  if (!cfg.configured) {
    return {
      success: false,
      permanent: true,
      disabled: true,
      message:
        "Discord belum dikonfigurasi. Isi DISCORD_BOT_TOKEN + DISCORD_CHANNEL_ID (atau DISCORD_WEBHOOK_URL) di Railway ENV.",
    };
  }

  const payload = { embeds: [embed], allowed_mentions: { parse: [] } };

  try {
    let response;
    if (cfg.mode === "bot") {
      response = await axios.post(`${API_BASE}/channels/${cfg.channelId}/messages`, payload, {
        headers: { Authorization: `Bot ${cfg.botToken}`, "Content-Type": "application/json" },
        timeout: TIMEOUT_MS,
      });
    } else {
      // ?wait=true membuat Discord membalas dengan objek pesan yang benar-benar
      // dibuat. Tanpa itu jawabannya 204 tanpa isi, dan "terkirim" hanya
      // asumsi — notification.service hanya boleh menandai sent kalau provider
      // benar-benar mengonfirmasinya.
      response = await axios.post(`${cfg.webhookUrl}?wait=true`, payload, {
        headers: { "Content-Type": "application/json" },
        timeout: TIMEOUT_MS,
      });
    }

    const id = response.data && response.data.id;
    if (!id) {
      return {
        success: false,
        permanent: false,
        message: "Discord membalas tanpa id pesan — pengiriman tidak terkonfirmasi.",
        response: response.data,
        httpStatus: response.status,
      };
    }

    logger.info("Discord embed terkirim", { mode: cfg.mode, messageId: id });
    return { success: true, permanent: false, message: "", response: { id, mode: cfg.mode }, httpStatus: response.status };
  } catch (err) {
    const classified = classifyTransportError(err);
    // Token tidak pernah ikut ke log.
    logger.error("Discord send failed", { mode: cfg.mode, httpStatus: classified.httpStatus, reason: classified.message });
    return { success: false, ...classified };
  }
}

/** Dipakai notification.service untuk event paymentSuccess. */
async function sendPaymentSuccess(ctx) {
  return postEmbed(buildPaymentSuccessEmbed(ctx));
}

/** Tombol "Test Discord" di Admin Web. */
async function testConnection() {
  const cfg = getConfig();
  if (!cfg.configured) {
    return {
      success: false,
      message: "Discord belum dikonfigurasi (DISCORD_BOT_TOKEN + DISCORD_CHANNEL_ID atau DISCORD_WEBHOOK_URL kosong).",
    };
  }
  const result = await postEmbed({
    title: "Test koneksi Discord",
    description: "Notifikasi Discord dari Admin Web berhasil terhubung ke channel ini.",
    color: ACCENT_SUCCESS,
    timestamp: new Date().toISOString(),
  });
  return result.success
    ? { success: true, message: `Pesan test terkirim lewat mode ${cfg.mode}.` }
    : { success: false, message: result.message || "Gagal mengirim pesan test ke Discord." };
}

/** Status tanpa rahasia, untuk dashboard integrasi Admin Web. */
function getStatus() {
  const cfg = getConfig();
  return {
    configured: cfg.configured,
    mode: cfg.mode,
    channelId: cfg.mode === "bot" ? cfg.channelId : null,
    // URL webhook memuat token di dalam path — tidak pernah dikirim ke frontend.
    webhookConfigured: Boolean(cfg.webhookUrl),
  };
}

module.exports = {
  sendPaymentSuccess,
  buildPaymentSuccessEmbed,
  testConnection,
  getStatus,
  getConfig,
};