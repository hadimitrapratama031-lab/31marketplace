const axios = require("axios");
const { getKlikQrisConfig } = require("./integration.service");
const { AppError } = require("../middlewares/errorHandler");
const logger = require("../utils/logger");

/**
 * KlikQRIS integration, implemented strictly per official docs:
 * https://klikqris.com/dokumentasi-api
 *
 * Auth headers on every request: x-api-key, id_merchant
 * Base URL (production): https://klikqris.com/api
 * Base URL (sandbox):     https://klikqris.com/api/sandbox
 *
 * POST /qris/create              -> create a dynamic QRIS transaction
 * GET  /qris/status/{order_id}   -> manual status check
 * GET  /qris/history?page=       -> paginated transaction history
 * Webhook payload (POST to KLIKQRIS_WEBHOOK_URL) fires on SUCCESS or EXPIRED,
 * includes a `signature` that must match the `signature` returned by /qris/create.
 */

async function createTransaction({ orderId, amount, keterangan }) {
  const cfg = await getKlikQrisConfig();
  if (!cfg.enabled) {
    throw new AppError("KlikQRIS belum diaktifkan/dikonfigurasi. Hubungi admin.", 503);
  }

  try {
    const response = await axios.post(
      `${cfg.baseUrl}/qris/create`,
      {
        order_id: orderId,
        id_merchant: cfg.merchantId,
        amount,
        keterangan,
        callback_url: cfg.webhookUrl,
      },
      {
        headers: {
          "Content-Type": "application/json",
          "x-api-key": cfg.apiKey,
          id_merchant: cfg.merchantId,
        },
        timeout: 15000,
      }
    );

    if (!response.data || response.data.status !== true) {
      throw new AppError(response.data?.message || "Gagal membuat transaksi KlikQRIS.", 502);
    }

    return response.data.data;
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error("KlikQRIS create transaction failed", { message: err.message });
    throw new AppError("Gagal menghubungi payment gateway. Silakan coba lagi.", 502);
  }
}

async function checkStatus(orderId) {
  const cfg = await getKlikQrisConfig();
  if (!cfg.enabled) {
    throw new AppError("KlikQRIS belum diaktifkan/dikonfigurasi.", 503);
  }

  try {
    const response = await axios.get(`${cfg.baseUrl}/qris/status/${encodeURIComponent(orderId)}`, {
      headers: {
        "x-api-key": cfg.apiKey,
        id_merchant: cfg.merchantId,
      },
      timeout: 15000,
    });

    if (!response.data || response.data.status !== true) {
      throw new AppError(response.data?.message || "Gagal mengambil status transaksi.", 502);
    }

    return response.data.data;
  } catch (err) {
    if (err instanceof AppError) throw err;
    logger.error("KlikQRIS check status failed", { message: err.message });
    throw new AppError("Gagal mengambil status pembayaran. Silakan coba lagi.", 502);
  }
}

async function testConnection() {
  try {
    const cfg = await getKlikQrisConfig();
    if (!cfg.apiKey || !cfg.merchantId) {
      return { success: false, message: "API key / Merchant ID belum diisi." };
    }
    // Use the history endpoint as a lightweight, side-effect-free connectivity check.
    const response = await axios.get(`${cfg.baseUrl}/qris/history`, {
      headers: { "x-api-key": cfg.apiKey, id_merchant: cfg.merchantId },
      timeout: 15000,
    });
    if (response.data && response.data.status === true) {
      return { success: true, message: "Berhasil terhubung ke KlikQRIS." };
    }
    return { success: false, message: response.data?.message || "Kredensial ditolak oleh KlikQRIS." };
  } catch (err) {
    return { success: false, message: "Gagal terhubung ke KlikQRIS. Periksa API key dan Merchant ID." };
  }
}

module.exports = { createTransaction, checkStatus, testConnection };
