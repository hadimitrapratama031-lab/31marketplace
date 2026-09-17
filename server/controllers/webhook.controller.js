const NotificationLog = require("../models/NotificationLog");
const asyncHandler = require("../utils/asyncHandler");
const { verifySvixSignature } = require("../utils/svix");
const { emitEvent } = require("../services/socket.service");
const logger = require("../utils/logger");

// Resend event `type` -> our internal deliveryStatus + log label (spec 6).
const EVENT_MAP = {
  "email.delivered": { deliveryStatus: "delivered", label: "EMAIL_DELIVERED" },
  "email.bounced": { deliveryStatus: "bounced", label: "EMAIL_BOUNCED" },
  "email.complained": { deliveryStatus: "complained", label: "EMAIL_COMPLAINT" },
  "email.delivery_delayed": { deliveryStatus: "delayed", label: "EMAIL_DELAYED" },
};

/**
 * Resend webhook — melaporkan apa yang SEBENARNYA terjadi setelah email
 * diterima antrean (delivered ke mailbox penerima, bounced, atau ditandai
 * spam/complained oleh penerima). Inilah yang menutup celah "API accepted ≠
 * Gmail inbox" (spec 12 & 31): status "sent" di NotificationLog hanya berarti
 * Resend menerima permintaannya, deliveryStatus di sini yang membuktikan
 * hasil sesungguhnya.
 *
 * Endpoint ini publik (Resend yang memanggil), jadi keasliannya HARUS
 * diverifikasi lewat signature Svix sebelum data apa pun dipercaya — bukan
 * lewat asumsi bahwa endpoint tersembunyi.
 */
const resendWebhook = asyncHandler(async (req, res) => {
  const secret = process.env.RESEND_WEBHOOK_SECRET;
  if (!secret) {
    // Belum dikonfigurasi di server ini — jangan pernah memproses payload
    // yang tidak bisa diverifikasi, tapi tetap balas 200 supaya Resend tidak
    // menganggap endpoint ini rusak dan menghentikan percobaan berikutnya
    // begitu admin mengisi secretnya.
    logger.warn("[Webhook][resend] RESEND_WEBHOOK_SECRET belum diset — event diabaikan tanpa diverifikasi");
    return res.status(200).json({ status: true, ignored: true });
  }

  const id = req.headers["svix-id"];
  const timestamp = req.headers["svix-timestamp"];
  const signature = req.headers["svix-signature"];

  const valid = verifySvixSignature({ secret, id, timestamp, signatureHeader: signature, rawBody: req.rawBody });
  if (!valid) {
    logger.error("[Webhook][resend] signature tidak valid — kemungkinan webhook palsu");
    return res.status(401).json({ status: false, message: "Invalid signature" });
  }

  const event = req.body || {};
  const mapped = EVENT_MAP[event.type];
  const messageId = event.data && event.data.email_id;

  if (!mapped || !messageId) {
    // Event lain (mis. email.sent, email.opened, email.clicked) diterima
    // dan dibalas 200, tapi tidak ada state di NotificationLog untuk itu.
    return res.status(200).json({ status: true, ignored: true });
  }

  const log = await NotificationLog.findOneAndUpdate(
    { resendMessageId: messageId },
    { $set: { deliveryStatus: mapped.deliveryStatus, deliveryStatusAt: new Date() } },
    { new: true }
  );

  if (!log) {
    logger.warn("[Webhook][resend] event untuk message id yang tidak dikenal", { messageId, type: event.type });
    return res.status(200).json({ status: true, ignored: true });
  }

  logger.info(`[Notification] ${mapped.label}`, {
    orderId: String(log.orderId),
    orderCode: log.orderCode,
    recipient: log.recipient,
    resendMessageId: messageId,
  });

  emitEvent("notification:log", {
    id: String(log._id),
    orderId: String(log.orderId),
    orderCode: log.orderCode,
    event: log.event,
    channel: log.channel,
    status: log.status,
    deliveryStatus: log.deliveryStatus,
    recipient: log.recipient,
  });

  res.status(200).json({ status: true });
});

module.exports = { resendWebhook };
