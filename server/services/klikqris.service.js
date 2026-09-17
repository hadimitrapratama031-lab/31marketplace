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

/**
 * Turns a raw axios failure into (a) a full diagnostic log entry and (b) a
 * safe, specific message for the caller. This is the actual root cause of
 * "Gagal menghubungi payment gateway" showing up for every failure: axios
 * throws on ANY problem — a genuine network/timeout failure, but *also* any
 * non-2xx response (bad API key, malformed payload, wrong merchant ID, a 5xx
 * from KlikQRIS itself) — and the previous code collapsed all of them into
 * one generic string, discarding the HTTP status and gateway response body
 * that would show which of those it actually was.
 *
 * err.config (and err.request) are NEVER logged here: axios attaches the
 * outgoing request there, headers included, which is exactly where
 * x-api-key lives. Only err.response (the gateway's OWN reply) and err.code
 * (a network-level errno, not a secret) are read.
 */
function describeGatewayFailure(err, endpoint) {
  if (err.response) {
    // The gateway was reached and answered — the request itself was rejected.
    const httpStatus = err.response.status;
    const body = err.response.data;
    const gatewayMessage = (body && typeof body === "object" && (body.message || body.error)) || undefined;

    logger.error("KlikQRIS rejected the request", {
      endpoint,
      httpStatus,
      gatewayMessage,
      // Truncated: enough to diagnose (error code, validation field, etc.)
      // without flooding logs if KlikQRIS ever returns an HTML error page.
      body: typeof body === "string" ? body.slice(0, 500) : JSON.stringify(body || {}).slice(0, 500),
    });

    if (httpStatus === 401 || httpStatus === 403) {
      return { message: "Payment gateway menolak kredensial. Periksa API key dan Merchant ID KlikQRIS di Admin Web.", statusCode: 502 };
    }
    if (httpStatus === 400 || httpStatus === 422) {
      return { message: gatewayMessage || "Payment gateway menolak data transaksi yang dikirim.", statusCode: 502 };
    }
    if (httpStatus >= 500) {
      return { message: "Payment gateway sedang bermasalah di sisi mereka. Coba lagi sebentar lagi.", statusCode: 502 };
    }
    return { message: gatewayMessage || `Payment gateway menolak permintaan (HTTP ${httpStatus}).`, statusCode: 502 };
  }

  // No response at all — a real connectivity failure, not a rejected request.
  const code = err.code || "";
  logger.error("Cannot reach KlikQRIS", { endpoint, code, message: err.message });

  if (code === "ECONNABORTED") {
    return { message: "Gagal menghubungi payment gateway: waktu tunggu habis. Silakan coba lagi.", statusCode: 504 };
  }
  if (["ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN"].includes(code)) {
    return { message: "Gagal menghubungi payment gateway: server tidak bisa menjangkau KlikQRIS.", statusCode: 502 };
  }
  return { message: "Gagal menghubungi payment gateway. Silakan coba lagi.", statusCode: 502 };
}

async function createTransaction({ orderId, amount, keterangan }) {
  const cfg = await getKlikQrisConfig();
  if (!cfg.enabled) {
    throw new AppError("KlikQRIS belum diaktifkan/dikonfigurasi. Hubungi admin.", 503);
  }

  const endpoint = `${cfg.baseUrl}/qris/create`;

  try {
    const response = await axios.post(
      endpoint,
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
      logger.error("KlikQRIS create returned status:false", {
        endpoint,
        httpStatus: response.status,
        gatewayMessage: response.data?.message,
      });
      throw new AppError(response.data?.message || "Gagal membuat transaksi KlikQRIS.", 502);
    }

    return response.data.data;
  } catch (err) {
    if (err instanceof AppError) throw err;
    const { message, statusCode } = describeGatewayFailure(err, endpoint);
    throw new AppError(message, statusCode);
  }
}

async function checkStatus(orderId) {
  const cfg = await getKlikQrisConfig();
  if (!cfg.enabled) {
    throw new AppError("KlikQRIS belum diaktifkan/dikonfigurasi.", 503);
  }

  const endpoint = `${cfg.baseUrl}/qris/status/${encodeURIComponent(orderId)}`;

  try {
    const response = await axios.get(endpoint, {
      headers: {
        "x-api-key": cfg.apiKey,
        id_merchant: cfg.merchantId,
      },
      timeout: 15000,
    });

    if (!response.data || response.data.status !== true) {
      logger.error("KlikQRIS status check returned status:false", {
        endpoint,
        httpStatus: response.status,
        gatewayMessage: response.data?.message,
      });
      throw new AppError(response.data?.message || "Gagal mengambil status transaksi.", 502);
    }

    return response.data.data;
  } catch (err) {
    if (err instanceof AppError) throw err;
    const { message, statusCode } = describeGatewayFailure(err, endpoint);
    throw new AppError(message.replace("menghubungi payment gateway", "mengambil status pembayaran"), statusCode);
  }
}

async function testConnection() {
  const cfg = await getKlikQrisConfig();
  if (!cfg.apiKey || !cfg.merchantId) {
    return { success: false, message: "API key / Merchant ID belum diisi." };
  }

  const endpoint = `${cfg.baseUrl}/qris/history`;

  try {
    // Lightweight, side-effect-free connectivity check.
    const response = await axios.get(endpoint, {
      headers: { "x-api-key": cfg.apiKey, id_merchant: cfg.merchantId },
      timeout: 15000,
    });
    if (response.data && response.data.status === true) {
      return { success: true, message: "Berhasil terhubung ke KlikQRIS." };
    }
    logger.error("KlikQRIS test connection returned status:false", {
      endpoint,
      httpStatus: response.status,
      gatewayMessage: response.data?.message,
    });
    return { success: false, message: response.data?.message || "Kredensial ditolak oleh KlikQRIS." };
  } catch (err) {
    const { message } = describeGatewayFailure(err, endpoint);
    return { success: false, message };
  }
}

module.exports = { createTransaction, checkStatus, testConnection };
