const IntegrationSettings = require("../models/IntegrationSettings");
const NotificationLog = require("../models/NotificationLog");
const WebsiteSettings = require("../models/WebsiteSettings");
const Transaction = require("../models/Transaction");
const Product = require("../models/Product");
const fonnte = require("./fonnte.service");
const resend = require("./resend.service");
const discord = require("./discord.service");
const { inspectAssetUrl } = require("../utils/assetUrl");
const { emitEvent } = require("./socket.service");
const templates = require("./template.service");
const { embedContextImages } = require("./emailInlineImages.service");
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

/**
 * Jejak DEBUG opsional: menunjukkan template mana yang dipilih untuk tiap
 * channel, lengkap dengan potongan awal isinya. Dimatikan secara default dan
 * dinyalakan lewat env NOTIF_DEBUG=1 — cukup untuk memverifikasi setelah
 * deploy tanpa membanjiri log produksi selamanya.
 *
 * Tidak pernah memuat token, API key, atau kredensial apa pun: hanya identitas
 * order dan isi pesan yang memang dikirim ke pelanggan.
 */
function debugTemplate({ order, event, channel, source, preview }) {
  if (process.env.NOTIF_DEBUG !== "1") return;
  logger.info("[Notification][debug] template terpilih", {
    orderId: String(order._id),
    orderCode: order.orderCode,
    type: event,
    channel,
    template: source,
    preview: String(preview || "").slice(0, 120).replace(/\n/g, " | "),
  });
}

function logDelivery({ orderId, orderCode, event, channel, recipient, status, attempts, error, templateSource }) {
  const meta = { orderId: String(orderId), orderCode, type: event, channel, recipient, status, attempts };
  if (templateSource) meta.template = templateSource;
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
async function deliverChannel({ order, event, channel, recipient, templateSource, send }) {
  const base = { orderId: order._id, orderCode: order.orderCode, event, channel, recipient };
  const logBase = { ...base, templateSource };

  // Validasi tujuan dilakukan SEBELUM slot di-claim: penerima yang tidak valid
  // adalah kesalahan data order, bukan kegagalan pengiriman yang perlu dicatat
  // sebagai percobaan.
  // Discord tidak punya "alamat pembeli": tujuannya adalah channel server toko
  // yang dikonfigurasi lewat ENV, jadi yang divalidasi adalah keberadaan
  // konfigurasi itu, bukan format nomor/email.
  const recipientValid =
    channel === "whatsapp" ? isValidWhatsApp(recipient) : channel === "discord" ? Boolean(recipient) : isValidEmail(recipient);
  if (!recipientValid) {
    const error =
      channel === "discord"
        ? "Channel Discord belum dikonfigurasi (DISCORD_BOT_TOKEN + DISCORD_CHANNEL_ID atau DISCORD_WEBHOOK_URL kosong)."
        : `Tujuan ${channel} tidak valid: ${recipient || "(kosong)"}`;
    const claim = await claimSlot(base);
    if (claim.claimed) {
      await finish(claim.doc, { status: "failed", permanentFailure: true, error, failedAt: new Date() });
    }
    logDelivery({ ...logBase, status: "FAILED", attempts: claim.doc ? claim.doc.attempts : 0, error });
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
      // Resend mengembalikan { id } saat email diterima antrean — dipakai
      // webhook (routes/webhook.routes.js) untuk mencocokkan event
      // delivered/bounced/complained ke baris log ini nantinya.
      const resendMessageId = channel === "email" && last.response && last.response.id ? last.response.id : undefined;
      await finish(logDoc, {
        status: "sent",
        sentAt: new Date(),
        attempts,
        error: "",
        providerResponse: last.response,
        permanentFailure: false,
        templateSource: templateSource || "",
        ...(resendMessageId ? { resendMessageId } : {}),
      });
      logDelivery({ ...logBase, status: "SENT", attempts });
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
    templateSource: templateSource || "",
    // Channel yang dimatikan admin bukan kegagalan permanen — begitu
    // dinyalakan lagi, retry manual harus bisa jalan.
    permanentFailure: Boolean(last && last.permanent && !last.disabled),
  });
  logDelivery({ ...logBase, status: "FAILED", attempts, error });
  return { channel, status: "FAILED", error };
}

/* ------------------------------------------------------------------ asset */

/**
 * Order menyimpan SNAPSHOT gambar produk saat checkout. Itu benar untuk harga
 * dan nama (riwayat tidak boleh berubah), tapi untuk gambar ia jadi masalah:
 * order yang dibuat ketika R2_PUBLIC_URL masih salah menyimpan URL yang tidak
 * bisa dimuat selamanya, walau gambar produknya sendiri sudah dibetulkan.
 *
 * Jadi: snapshot tetap yang utama, dan HANYA kalau snapshot itu terbukti tidak
 * bisa dipakai, gambar produk yang hidup sekarang dibaca dari koleksi Product.
 * Tidak ada gambar baru yang dikarang — sumbernya tetap aset yang sama yang
 * sudah diunggah admin.
 */
async function resolveProductImageFallback(order) {
  const snapshot = inspectAssetUrl(order.product && order.product.image);
  if (snapshot.ok) return "";

  const productId = order.product && order.product.productId;
  if (!productId) return "";
  try {
    const live = await Product.findById(productId).select("image").lean();
    const fallback = (live && live.image) || "";
    if (fallback) {
      logger.info("[Notification] gambar produk diambil dari Product (snapshot order tidak bisa dipakai)", {
        orderCode: order.orderCode,
        reason: snapshot.reason,
      });
    }
    return fallback;
  } catch (err) {
    logger.warn("[Notification] gagal membaca gambar produk terkini", { orderCode: order.orderCode, message: err.message });
    return "";
  }
}

/**
 * Menyiapkan payload email SIAP KIRIM: subject/html/text dari resolver
 * template (tidak berubah), plus lampiran CID untuk gambar (lihat
 * emailInlineImages.service.js).
 *
 * PENTING: `ctx` di sini SELALU salinan dangkal dari ctx asli, bukan ctx
 * yang sama dengan yang dipakai WhatsApp/Discord. embedContextImages()
 * menulis ulang ctx.logoUrl / ctx.productImage / ctx.waIcon / ctx.discordIcon
 * menjadi "cid:..." SUPAYA HTML email merujuk ke lampirannya — tapi
 * discord.service.js membaca ctx.logoUrl dan ctx.productImage yang SAMA
 * untuk embed Discord, dan Discord butuh URL asli (bot Discord yang
 * mengambil gambarnya sendiri dari internet, bukan lampiran email). Kalau
 * fungsi ini menulis ke ctx asli, notifikasi Discord akan ikut rusak
 * (icon_url/thumbnail jadi string "cid:..." yang bukan URL). Cloning di sini
 * membuat itu mustahil terjadi secara struktural, bukan sekadar "diingat".
 */
async function buildEmailPayload(baseCtx, customTemplate, orderCode) {
  const emailCtx = { ...baseCtx };
  const attachments = await embedContextImages(emailCtx, { orderCode });
  const mail = templates.resolveEmail(emailCtx, customTemplate);
  return { mail, attachments };
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
  const productImageFallback = await resolveProductImageFallback(order);
  const ctx = templates.buildContext({ event: eventKey, order, transaction, settings: websiteSettings, productImageFallback });
  const results = [];

  if (integrationSettings.notifications.whatsappEnabled) {
    const wa = templates.resolveWhatsApp(ctx, integrationSettings.templates.whatsapp[eventKey]);
    debugTemplate({ order, event: eventKey, channel: "whatsapp", source: wa.source, preview: wa.text });
    results.push(
      await deliverChannel({
        order,
        event: eventKey,
        channel: "whatsapp",
        recipient: ctx.customerWhatsApp,
        templateSource: wa.source,
        send: () => fonnte.sendWhatsApp(ctx.customerWhatsApp, wa.text),
      })
    );
  } else {
    logDelivery({ orderId: order._id, orderCode: order.orderCode, event: eventKey, channel: "whatsapp", recipient: ctx.customerWhatsApp, status: "SKIPPED", attempts: 0, error: "WhatsApp dinonaktifkan di Admin Web" });
    results.push({ channel: "whatsapp", status: "SKIPPED" });
  }

  if (integrationSettings.notifications.emailEnabled) {
    const { mail, attachments } = await buildEmailPayload(ctx, integrationSettings.templates.email[eventKey], order.orderCode);
    debugTemplate({ order, event: eventKey, channel: "email", source: mail.source, preview: mail.subject });
    results.push(
      await deliverChannel({
        order,
        event: eventKey,
        channel: "email",
        recipient: ctx.customerEmail,
        templateSource: mail.source,
        send: () =>
          resend.sendEmail({
            to: ctx.customerEmail,
            subject: mail.subject,
            html: mail.html,
            text: mail.text,
            entityRef: order.orderCode,
            attachments,
          }),
      })
    );
  } else {
    logDelivery({ orderId: order._id, orderCode: order.orderCode, event: eventKey, channel: "email", recipient: ctx.customerEmail, status: "SKIPPED", attempts: 0, error: "Email dinonaktifkan di Admin Web" });
    results.push({ channel: "email", status: "SKIPPED" });
  }

  // Discord: HANYA paymentSuccess. Batasnya ditulis di sini, satu baris, bukan
  // disebar sebagai pengecekan di beberapa tempat — orderCreated,
  // paymentFailed, dan paymentExpired tidak pernah sampai ke Discord.
  if (eventKey === "paymentSuccess") {
    const discordCfg = discord.getConfig();
    if (integrationSettings.notifications.discordEnabled !== false && discordCfg.configured) {
      const target = discordCfg.mode === "bot" ? `channel:${discordCfg.channelId}` : "webhook";
      results.push(
        await deliverChannel({
          order,
          event: eventKey,
          channel: "discord",
          recipient: target,
          templateSource: "builtin",
          send: () => discord.sendPaymentSuccess(ctx),
        })
      );
    } else {
      const reason = discordCfg.configured ? "Discord dinonaktifkan di Admin Web" : "Discord belum dikonfigurasi di ENV";
      logDelivery({ orderId: order._id, orderCode: order.orderCode, event: eventKey, channel: "discord", recipient: "", status: "SKIPPED", attempts: 0, error: reason });
      results.push({ channel: "discord", status: "SKIPPED" });
    }
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
  const productImageFallback = await resolveProductImageFallback(order);
  const ctx = templates.buildContext({ event: log.event, order, transaction, settings: websiteSettings, productImageFallback });

  // Template diselesaikan SEKALI di sini, bukan di dalam callback send():
  // dengan begitu retry ketiga memakai teks yang persis sama dengan percobaan
  // pertama, dan sumbernya ikut tercatat seperti pengiriman biasa.
  let result;
  if (log.channel === "whatsapp") {
    const wa = templates.resolveWhatsApp(ctx, settings.templates.whatsapp[log.event]);
    debugTemplate({ order, event: log.event, channel: "whatsapp", source: wa.source, preview: wa.text });
    result = await deliverChannel({
      order,
      event: log.event,
      channel: "whatsapp",
      recipient: ctx.customerWhatsApp,
      templateSource: wa.source,
      send: () => fonnte.sendWhatsApp(ctx.customerWhatsApp, wa.text),
    });
  } else if (log.channel === "discord") {
    const discordCfg = discord.getConfig();
    result = await deliverChannel({
      order,
      event: log.event,
      channel: "discord",
      recipient: discordCfg.configured ? (discordCfg.mode === "bot" ? `channel:${discordCfg.channelId}` : "webhook") : "",
      templateSource: "builtin",
      send: () => discord.sendPaymentSuccess(ctx),
    });
  } else {
    const { mail, attachments } = await buildEmailPayload(ctx, settings.templates.email[log.event], order.orderCode);
    debugTemplate({ order, event: log.event, channel: "email", source: mail.source, preview: mail.subject });
    result = await deliverChannel({
      order,
      event: log.event,
      channel: "email",
      recipient: ctx.customerEmail,
      templateSource: mail.source,
      send: () =>
        resend.sendEmail({
          to: ctx.customerEmail,
          subject: mail.subject,
          html: mail.html,
          text: mail.text,
          entityRef: order.orderCode,
          attachments,
        }),
    });
  }

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

/**
 * Merender keempat event untuk kedua channel memakai jalur resolver yang
 * PERSIS SAMA dengan pengiriman sungguhan, tanpa menyentuh Fonnte/Resend.
 *
 * Ini yang menjawab "buktikan runtime memakai template baru": kalau `source`
 * di sini "builtin" dan isinya template premium, maka itulah yang akan
 * dikirim — karena kode yang memilihnya satu dan sama.
 *
 * Kalau ada order sungguhan (orderCode diisi), datanya dipakai apa adanya;
 * kalau tidak, dipakai contoh yang jelas-jelas ditandai sebagai contoh.
 */
async function previewTemplates(orderCode) {
  const Order = require("../models/Order");
  const [settings, websiteSettings] = await Promise.all([
    IntegrationSettings.getSingleton(),
    WebsiteSettings.getSingleton(),
  ]);

  let order = null;
  let transaction = null;
  if (orderCode) {
    order = await Order.findOne({ orderCode: String(orderCode).trim().toUpperCase() });
    if (order) transaction = await Transaction.findOne({ orderId: order._id });
  }
  const usingSample = !order;
  if (usingSample) {
    const now = new Date();
    order = {
      _id: "preview",
      orderCode: "CONTOH-0001",
      customer: { name: "Nama Pelanggan", email: "pelanggan@contoh.com", whatsapp: "6281234567890" },
      product: { name: "Nama Produk", price: 150000, image: "" },
      quantity: 1,
      total: 150000,
      createdAt: now,
    };
    transaction = {
      paymentGateway: "KLIKQRIS",
      totalAmount: 150321,
      expiredAt: new Date(now.getTime() + 60 * 60 * 1000),
      paidAt: now,
    };
  }

  const events = SUPPORTED_EVENTS.map((event) => {
    const ctx = templates.buildContext({ event, order, transaction, settings: websiteSettings });
    const wa = templates.resolveWhatsApp(ctx, settings.templates.whatsapp[event]);
    const mail = templates.resolveEmail(ctx, settings.templates.email[event]);
    return {
      event,
      whatsapp: { source: wa.source, text: wa.text },
      email: { source: mail.source, subject: mail.subject, html: mail.html, text: mail.text },
    };
  });

  return { usingSample, orderCode: order.orderCode, events };
}

module.exports = {
  previewTemplates,
  notifyOrderEvent,
  queueOrderEvent,
  listLogs,
  retryLog,
  getOrderDeliveryStatus,
  SUPPORTED_EVENTS,
};
