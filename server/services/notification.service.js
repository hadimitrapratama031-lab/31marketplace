const IntegrationSettings = require("../models/IntegrationSettings");
const NotificationLog = require("../models/NotificationLog");
const WebsiteSettings = require("../models/WebsiteSettings");
const Transaction = require("../models/Transaction");
const fonnte = require("./fonnte.service");
const resend = require("./resend.service");
const { emitEvent } = require("./socket.service");
const templates = require("./template.service");
const { isValidWhatsApp, isValidEmail } = require("../utils/phone");
const logger = require("../utils/logger");

/**
 * Notification Service — satu-satunya jalur keluar untuk WhatsApp & Email.
 *
 *   Event → Build Template → Validate Recipient → Send → Save Delivery Result → Log
 *
 * Empat event yang didukung: orderCreated, paymentSuccess, paymentFailed,
 * paymentExpired. Tiap event punya dua channel dengan status masing-masing;
 * satu channel gagal tidak pernah membuat channel lain ikut dianggap gagal,
 * dan tidak pernah membuat channel yang sudah sukses dikirim ulang.
 */

const SUPPORTED_EVENTS = ["orderCreated", "paymentSuccess", "paymentFailed", "paymentExpired"];

// Tiga percobaan, lalu berhenti. Tidak ada retry tak terbatas (spec 5).
const MAX_ATTEMPTS = 3;
const BACKOFF_MS = [2000, 6000];
// Baris berstatus "sending" yang lebih tua dari ini dianggap yatim (proses
// sebelumnya mati/restart di tengah jalan) dan boleh di-claim ulang.
const STALE_CLAIM_MS = 2 * 60 * 1000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------ idempotency */

/**
 * Meng-claim slot (orderId, event, channel) SEBELUM provider dipanggil.
 *
 * Ini inti perbaikannya: versi lama membaca "sudah terkirim?" lalu mengirim
 * lalu menulis hasilnya — tiga langkah terpisah, sehingga webhook kedua yang
 * masuk di antara langkah 1 dan 3 ikut lolos dan WhatsApp benar-benar terkirim
 * dua kali. Di sini penulisannya atomic: unique index (orderId, event,
 * channel) yang menolak claim kedua, bukan pengecekan di memori.
 */
async function claimSlot({ orderId, orderCode, event, channel, recipient }) {
  const staleBefore = new Date(Date.now() - STALE_CLAIM_MS);
  try {
    const doc = await NotificationLog.findOneAndUpdate(
      {
        orderId,
        event,
        channel,
        permanentFailure: { $ne: true },
        $or: [{ status: { $in: ["pending", "failed"] } }, { status: "sending", claimedAt: { $lt: staleBefore } }],
      },
      {
        // orderId/event/channel tidak boleh ikut di sini: MongoDB sudah
        // menurunkannya dari bagian equality query saat upsert, dan menulis
        // ulang akan ditolak sebagai conflicting path.
        $setOnInsert: { orderCode: orderCode || "" },
        $set: { status: "sending", claimedAt: new Date(), recipient: recipient || "" },
        $inc: { attempts: 1 },
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );
    return { claimed: true, doc };
  } catch (err) {
    if (err && err.code === 11000) {
      // Slot sudah dipegang: sudah "sent", sedang "sending" oleh proses lain,
      // atau sudah gagal permanen. Tidak ada yang perlu dikerjakan.
      const existing = await NotificationLog.findOne({ orderId, event, channel });
      return { claimed: false, doc: existing };
    }
    throw err;
  }
}

async function finish(logDoc, patch) {
  const updated = await NotificationLog.findByIdAndUpdate(logDoc._id, { $set: patch }, { new: true });
  if (updated) {
    // Admin Web ikut hidup lewat Socket.IO existing — tidak ada kanal realtime baru.
    emitEvent("notification:log", {
      id: String(updated._id),
      orderId: String(updated.orderId),
      orderCode: updated.orderCode,
      event: updated.event,
      channel: updated.channel,
      status: updated.status,
      recipient: updated.recipient,
      attempts: updated.attempts,
      error: updated.error,
      sentAt: updated.sentAt,
    });
  }
  return updated;
}

/* ---------------------------------------------------------------- logging */

function logDelivery({ orderId, orderCode, event, channel, recipient, status, attempts, error }) {
  const meta = { orderId: String(orderId), orderCode, type: event, channel, recipient, status, attempts };
  if (error) meta.error = error;
  // Tidak pernah memuat token/API key — hanya identitas order, tujuan, dan hasil.
  if (status === "SENT") logger.info("[Notification]", meta);
  else if (status === "SKIPPED") logger.warn("[Notification]", meta);
  else logger.error("[Notification]", meta);
}

/* --------------------------------------------------------------- delivery */

/**
 * Mengirim satu channel dengan retry terbatas, lalu menyimpan hasil
 * sebenarnya. Tidak pernah mengembalikan sukses kecuali provider benar-benar
 * mengonfirmasinya (spec 31).
 */
async function deliverChannel({ order, event, channel, recipient, send }) {
  const base = { orderId: order._id, orderCode: order.orderCode, event, channel, recipient };

  // Validasi tujuan dilakukan SEBELUM slot di-claim: penerima yang tidak valid
  // adalah kesalahan data order, bukan kegagalan pengiriman yang perlu dicatat
  // sebagai percobaan.
  const recipientValid = channel === "whatsapp" ? isValidWhatsApp(recipient) : isValidEmail(recipient);
  if (!recipientValid) {
    const error = `Tujuan ${channel} tidak valid: ${recipient || "(kosong)"}`;
    const claim = await claimSlot(base);
    if (claim.claimed) {
      await finish(claim.doc, { status: "failed", permanentFailure: true, error, failedAt: new Date() });
    }
    logDelivery({ ...base, status: "FAILED", attempts: claim.doc ? claim.doc.attempts : 0, error });
    return { channel, status: "FAILED", error };
  }

  const claim = await claimSlot(base);
  if (!claim.claimed) {
    const existing = claim.doc;
    const reason = existing && existing.status === "sent" ? "sudah terkirim sebelumnya" : "sedang diproses / gagal permanen";
    logger.info("[Notification] dilewati (idempotency)", { ...base, reason, status: existing ? existing.status : "unknown" });
    return { channel, status: existing && existing.status === "sent" ? "SENT" : "SKIPPED", skipped: true };
  }

  const logDoc = claim.doc;
  const startingAttempts = logDoc.attempts; // sudah termasuk percobaan ini
  let last = null;

  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
    last = await send();

    if (last.success) {
      const attempts = startingAttempts + attempt - 1;
      await finish(logDoc, {
        status: "sent",
        sentAt: new Date(),
        attempts,
        error: "",
        providerResponse: last.response,
        permanentFailure: false,
      });
      logDelivery({ ...base, status: "SENT", attempts });
      return { channel, status: "SENT" };
    }

    // Kredensial/tujuan salah: mengulang hanya menghasilkan kegagalan yang
    // sama, jadi berhenti di sini dan tandai permanen.
    if (last.permanent) break;
    if (attempt < MAX_ATTEMPTS) {
      logger.warn("[Notification] percobaan gagal, akan diulang", { ...base, attempt, reason: last.message });
      await sleep(BACKOFF_MS[attempt - 1] || BACKOFF_MS[BACKOFF_MS.length - 1]);
    }
  }

  const attempts = startingAttempts + (last && last.permanent ? 0 : MAX_ATTEMPTS - 1);
  const error = (last && last.message) || "Pengiriman gagal tanpa keterangan dari provider.";
  await finish(logDoc, {
    status: "failed",
    failedAt: new Date(),
    attempts,
    error,
    providerResponse: last && last.response,
    // Channel yang dimatikan admin bukan kegagalan permanen — begitu
    // dinyalakan lagi, retry manual harus bisa jalan.
    permanentFailure: Boolean(last && last.permanent && !last.disabled),
  });
  logDelivery({ ...base, status: "FAILED", attempts, error });
  return { channel, status: "FAILED", error };
}

/* ------------------------------------------------------------------ entry */

/**
 * Titik masuk tunggal untuk keempat event.
 * `order` harus SUDAH tersimpan dengan status finalnya — notifikasi tidak
 * boleh dipanggil sebelum state pembayaran benar-benar berubah di database
 * (spec 27).
 */
async function notifyOrderEvent(order, eventKey, opts = {}) {
  if (!order || !order._id) {
    logger.error("[Notification] dipanggil tanpa order valid", { event: eventKey });
    return { event: eventKey, results: [] };
  }
  if (!SUPPORTED_EVENTS.includes(eventKey)) {
    logger.warn("[Notification] event tidak dikenal, dilewati", { orderCode: order.orderCode, event: eventKey });
    return { event: eventKey, results: [] };
  }

  const [integrationSettings, websiteSettings, transaction] = await Promise.all([
    IntegrationSettings.getSingleton(),
    WebsiteSettings.getSingleton(),
    opts.transaction !== undefined ? Promise.resolve(opts.transaction) : Transaction.findOne({ orderId: order._id }),
  ]);

  if (!integrationSettings.notifications.events[eventKey]) {
    logger.warn("[Notification] event dinonaktifkan di Admin Web", { orderCode: order.orderCode, event: eventKey });
    return { event: eventKey, results: [], disabled: true };
  }

  // Konteks dibangun sekali; WhatsApp dan Email membaca data yang sama —
  // nomor admin, link Discord, logo, dan gambar produk semuanya berasal dari
  // WebsiteSettings (Admin Web), tidak ada yang di-hardcode.
  const ctx = templates.buildContext({ event: eventKey, order, transaction, settings: websiteSettings });
  const results = [];

  if (integrationSettings.notifications.whatsappEnabled) {
    const message = templates.buildWhatsApp(ctx, integrationSettings.templates.whatsapp[eventKey]);
    results.push(
      await deliverChannel({
        order,
        event: eventKey,
        channel: "whatsapp",
        recipient: ctx.customerWhatsApp,
        send: () => fonnte.sendWhatsApp(ctx.customerWhatsApp, message),
      })
    );
  } else {
    logDelivery({ orderId: order._id, orderCode: order.orderCode, event: eventKey, channel: "whatsapp", recipient: ctx.customerWhatsApp, status: "SKIPPED", attempts: 0, error: "WhatsApp dinonaktifkan di Admin Web" });
    results.push({ channel: "whatsapp", status: "SKIPPED" });
  }

  if (integrationSettings.notifications.emailEnabled) {
    const mail = templates.buildEmail(ctx, integrationSettings.templates.email[eventKey]);
    results.push(
      await deliverChannel({
        order,
        event: eventKey,
        channel: "email",
        recipient: ctx.customerEmail,
        send: () => resend.sendEmail({ to: ctx.customerEmail, subject: mail.subject, html: mail.html }),
      })
    );
  } else {
    logDelivery({ orderId: order._id, orderCode: order.orderCode, event: eventKey, channel: "email", recipient: ctx.customerEmail, status: "SKIPPED", attempts: 0, error: "Email dinonaktifkan di Admin Web" });
    results.push({ channel: "email", status: "SKIPPED" });
  }

  return { event: eventKey, orderCode: order.orderCode, results };
}

/**
 * Versi "kirim di latar belakang" untuk jalur request yang tidak boleh
 * menunggu provider: webhook KlikQRIS harus membalas 200 secepatnya, kalau
 * tidak gateway menganggapnya gagal dan mengirim ulang webhook — yang justru
 * memperbanyak duplikat. Jaminan pengirimannya ada di NotificationLog, bukan
 * di lamanya request digantung.
 */
function queueOrderEvent(order, eventKey, opts = {}) {
  setImmediate(() => {
    notifyOrderEvent(order, eventKey, opts).catch((err) =>
      logger.error("[Notification] gagal total di luar dugaan", {
        orderCode: order && order.orderCode,
        event: eventKey,
        message: err.message,
      })
    );
  });
}

/* ------------------------------------------------------- admin operations */

async function listLogs({ orderCode, event, channel, status, page = 1, limit = 30 } = {}) {
  const filter = {};
  if (orderCode) filter.orderCode = String(orderCode).trim().toUpperCase();
  if (event) filter.event = event;
  if (channel) filter.channel = channel;
  if (status) filter.status = status;

  const pageNum = Math.max(1, Number(page) || 1);
  const limitNum = Math.min(100, Math.max(1, Number(limit) || 30));

  const [rows, total] = await Promise.all([
    NotificationLog.find(filter)
      .sort({ createdAt: -1 })
      .skip((pageNum - 1) * limitNum)
      .limit(limitNum)
      // providerResponse mentah tidak ikut dikirim ke Admin Web: isinya bisa
      // memuat payload provider apa adanya dan tidak menambah nilai di tabel.
      .select("-providerResponse")
      .lean(),
    NotificationLog.countDocuments(filter),
  ]);

  return { rows, pagination: { page: pageNum, limit: limitNum, total } };
}

/**
 * Retry manual dari Admin Web untuk SATU baris log. Hanya channel itu yang
 * dikirim ulang — channel lain di event yang sama tidak disentuh (spec 6).
 */
async function retryLog(logId) {
  const Order = require("../models/Order");
  const log = await NotificationLog.findById(logId);
  if (!log) return { success: false, message: "Log notifikasi tidak ditemukan." };
  if (log.status === "sent") return { success: false, message: "Notifikasi ini sudah terkirim — tidak dikirim ulang." };

  const order = await Order.findById(log.orderId);
  if (!order) return { success: false, message: "Order untuk log ini sudah tidak ada." };

  // Retry manual adalah keputusan sadar admin, jadi tanda "gagal permanen"
  // dibuka supaya claim berikutnya bisa masuk — misalnya setelah token Fonnte
  // atau nomor pelanggan diperbaiki.
  await NotificationLog.findByIdAndUpdate(log._id, { $set: { permanentFailure: false, status: "failed" } });

  const settings = await IntegrationSettings.getSingleton();
  const websiteSettings = await WebsiteSettings.getSingleton();
  const transaction = await Transaction.findOne({ orderId: order._id });
  const ctx = templates.buildContext({ event: log.event, order, transaction, settings: websiteSettings });

  const result =
    log.channel === "whatsapp"
      ? await deliverChannel({
          order,
          event: log.event,
          channel: "whatsapp",
          recipient: ctx.customerWhatsApp,
          send: () => fonnte.sendWhatsApp(ctx.customerWhatsApp, templates.buildWhatsApp(ctx, settings.templates.whatsapp[log.event])),
        })
      : await deliverChannel({
          order,
          event: log.event,
          channel: "email",
          recipient: ctx.customerEmail,
          send: () => {
            const mail = templates.buildEmail(ctx, settings.templates.email[log.event]);
            return resend.sendEmail({ to: ctx.customerEmail, subject: mail.subject, html: mail.html });
          },
        });

  return {
    success: result.status === "SENT",
    message: result.status === "SENT" ? "Notifikasi berhasil dikirim ulang." : result.error || "Pengiriman ulang gagal.",
    data: result,
  };
}

/** Ringkasan status pengiriman satu order, untuk detail order di Admin Web. */
async function getOrderDeliveryStatus(orderId) {
  const rows = await NotificationLog.find({ orderId }).select("-providerResponse").lean();
  return rows;
}

module.exports = {
  notifyOrderEvent,
  queueOrderEvent,
  listLogs,
  retryLog,
  getOrderDeliveryStatus,
  SUPPORTED_EVENTS,
};
