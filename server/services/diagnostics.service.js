/**
 * Diagnostik — menjawab "kenapa gambar tidak tampil" dan "kenapa masuk Spam"
 * dengan DATA, bukan dugaan.
 *
 * Tidak mengubah apa pun. Ia menjalankan jalur yang sama persis dengan
 * pengiriman sungguhan (buildContext → resolveEmail), lalu membaca kembali
 * HTML yang dihasilkan dan menguji setiap URL gambar di dalamnya seperti yang
 * dilakukan Gmail: minta objeknya dari internet, lihat statusnya, lihat
 * Content-Type-nya.
 *
 * Inilah bedanya dengan menebak: yang diperiksa adalah URL yang BENAR-BENAR
 * masuk ke HTML email, bukan URL yang kita kira tersimpan di MongoDB.
 */

const axios = require("axios");
const IntegrationSettings = require("../models/IntegrationSettings");
const WebsiteSettings = require("../models/WebsiteSettings");
const NotificationLog = require("../models/NotificationLog");
const Order = require("../models/Order");
const Transaction = require("../models/Transaction");
const templates = require("./template.service");
const resend = require("./resend.service");
const discord = require("./discord.service");
const { getResendConfig } = require("./integration.service");
const { inspectAssetUrl, isEmailRenderable, extensionOf } = require("../utils/assetUrl");
const { isFreemailAddress } = require("../utils/email");
const { fetchImageBuffer } = require("./emailInlineImages.service");

const PROBE_TIMEOUT_MS = 8000;

/* --------------------------------------------------------- image tracing */

// Mengambil setiap src dari <img> di HTML final. Sengaja membaca hasil render,
// bukan sumbernya: kalau template custom admin memuat gambar lain, gambar itu
// ikut terperiksa juga.
function extractImageSources(html) {
  const found = [];
  const re = /<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi;
  let match;
  while ((match = re.exec(html)) !== null) {
    // HTML di template sudah di-escape (&amp;), kembalikan ke bentuk aslinya
    // supaya yang diuji adalah URL yang benar-benar diminta email client.
    found.push(match[1].replace(/&amp;/g, "&"));
  }
  return [...new Set(found)];
}

/**
 * Memeriksa satu URL persis seperti proxy gambar Gmail: tanpa cookie, tanpa
 * login, dari luar jaringan aplikasi.
 */
async function probeImage(url) {
  const base = { url, reachable: false, httpStatus: null, contentType: "", contentLength: null, problems: [] };

  if (!isEmailRenderable(url)) {
    base.problems.push(
      `Ekstensi ${extensionOf(url) || "(tidak diketahui)"} tidak pernah dirender sebagai gambar oleh Gmail/Outlook. Unggah ulang aset ini sebagai PNG atau JPG.`
    );
  }

  try {
    // HEAD dulu; sebagian storage (termasuk beberapa konfigurasi R2 di balik
    // custom domain) tidak mengizinkan HEAD, jadi GET dipakai sebagai cadangan
    // dengan pembatasan supaya tidak mengunduh gambar penuh.
    let response;
    try {
      response = await axios.head(url, { timeout: PROBE_TIMEOUT_MS, maxRedirects: 3, validateStatus: () => true });
    } catch {
      response = await axios.get(url, {
        timeout: PROBE_TIMEOUT_MS,
        maxRedirects: 3,
        validateStatus: () => true,
        responseType: "arraybuffer",
        headers: { Range: "bytes=0-2047" },
      });
    }

    base.httpStatus = response.status;
    base.contentType = String((response.headers && response.headers["content-type"]) || "");
    const length = response.headers && response.headers["content-length"];
    base.contentLength = length ? Number(length) : null;
    base.reachable = response.status >= 200 && response.status < 400;

    if (response.status === 401 || response.status === 403) {
      base.problems.push(
        `Objek menolak akses publik (HTTP ${response.status}). Gmail memuat gambar tanpa login — aktifkan akses publik bucket R2 atau pasang custom domain.`
      );
    } else if (response.status === 404) {
      base.problems.push("Objek tidak ada di storage (HTTP 404). URL tersimpan di MongoDB tapi filenya sudah tidak ada.");
    } else if (!base.reachable) {
      base.problems.push(`Objek tidak bisa diambil (HTTP ${response.status}).`);
    }

    if (base.reachable && base.contentType && !/^image\//i.test(base.contentType)) {
      base.problems.push(
        `Content-Type "${base.contentType}" bukan image/*. Email client menolak merendernya walaupun filenya benar. Unggah ulang lewat Admin Web agar Content-Type-nya ikut diperbaiki.`
      );
    }
    if (base.reachable && /image\/svg/i.test(base.contentType)) {
      base.problems.push("Content-Type image/svg+xml — Gmail tidak merender SVG. Gunakan PNG atau JPG.");
    }
  } catch (err) {
    base.problems.push(`Tidak bisa dihubungi dari server: ${err.code || err.message}.`);
  }

  return base;
}

/**
 * Menelusuri rantai lengkap: Admin Web → MongoDB → Backend → Email Template →
 * URL final di HTML → hasil pengujian dari internet.
 *
 * @param {string} [orderCode] pakai order sungguhan kalau diisi; kalau tidak,
 *   dipakai contoh yang jelas ditandai sebagai contoh (aset toko tetap asli).
 */
async function auditEmailAssets(orderCode) {
  const [integrationSettings, websiteSettings] = await Promise.all([
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
      _id: "diagnostic",
      orderCode: "CONTOH-0001",
      customer: { name: "Nama Pelanggan", email: "pelanggan@contoh.com", whatsapp: "6281234567890" },
      product: { name: "Nama Produk", price: 150000, image: "" },
      quantity: 1,
      total: 150000,
      createdAt: now,
    };
    transaction = { paymentGateway: "KLIKQRIS", totalAmount: 150000, paidAt: now, expiredAt: now };
  }

  // Nilai MENTAH dari MongoDB, sebelum disentuh resolver. Ini yang menjawab
  // "URL mana yang sebenarnya tersimpan?" — sering berbeda dari yang dikira.
  const contact = (websiteSettings.contact || {});
  const stored = {
    "general.logo": (websiteSettings.general && websiteSettings.general.logo) || "",
    "footer.logo": (websiteSettings.footer && websiteSettings.footer.logo) || "",
    "contact.whatsapp.icon": (contact.whatsapp && contact.whatsapp.icon) || "",
    "contact.discord.icon": (contact.discord && contact.discord.icon) || "",
    "order.product.image": (order.product && order.product.image) || "",
  };

  const storedReport = Object.entries(stored).map(([key, value]) => {
    const inspected = inspectAssetUrl(value);
    return {
      asset: key,
      storedValue: value,
      configured: Boolean(value),
      usable: inspected.ok,
      normalizedTo: inspected.ok && inspected.changed ? inspected.url : null,
      reason: inspected.reason || null,
    };
  });

  // Render email untuk tiap event lewat resolver yang sama dengan pengiriman
  // sungguhan, lalu baca URL gambar dari hasilnya.
  const perEvent = [];
  const allUrls = new Set();
  let ctxForEmbedProbe = null;
  for (const event of ["orderCreated", "paymentSuccess", "paymentFailed", "paymentExpired"]) {
    const ctx = templates.buildContext({ event, order, transaction, settings: websiteSettings });
    if (!ctxForEmbedProbe) ctxForEmbedProbe = ctx; // *Raw fields sama untuk keempat event (aset toko/produk tidak berubah per event)
    const mail = templates.resolveEmail(ctx, integrationSettings.templates.email[event]);
    const images = extractImageSources(mail.html);
    images.forEach((u) => allUrls.add(u));
    perEvent.push({ event, templateSource: mail.source, imageCount: images.length, images });
  }

  const probes = await Promise.all([...allUrls].map((url) => probeImage(url)));
  const broken = probes.filter((p) => !p.reachable || p.problems.length > 0);

  // Pengiriman SUNGGUHAN (notification.service.js) tidak lagi bergantung
  // pada Gmail memuat `probes` di atas — sejak lampiran CID ditambahkan,
  // gambar diambil server-to-server dan disertakan langsung di payload
  // Resend (lihat emailInlineImages.service.js). Jadi pertanyaan yang
  // sebenarnya menentukan "tampil atau tidak" bukan lagi "apakah URL proxy
  // bisa dimuat dari internet", melainkan "apakah SERVER TOKO SENDIRI bisa
  // mengambil byte-nya dari storage". Bagian ini menguji jalur itu — persis
  // fungsi yang dipanggil saat order sungguhan dikirim — supaya admin bisa
  // membuktikan sebelum satu pelanggan pun menerima email yang gambarnya
  // gagal dilampirkan.
  const embeddableAssets = [
    { asset: "logoUrl", label: "Logo toko", rawUrl: ctxForEmbedProbe.logoUrlRaw },
    { asset: "productImage", label: "Gambar produk", rawUrl: ctxForEmbedProbe.productImageRaw },
    { asset: "waIcon", label: "Ikon WhatsApp", rawUrl: ctxForEmbedProbe.waIconRaw },
    { asset: "discordIcon", label: "Ikon Discord", rawUrl: ctxForEmbedProbe.discordIconRaw },
  ];
  const embedding = await Promise.all(
    embeddableAssets.map(async (a) => {
      if (!a.rawUrl) return { ...a, configured: false, embeddable: false, reason: "aset tidak diset di Admin Web" };
      const result = await fetchImageBuffer(a.rawUrl, a.label);
      return {
        ...a,
        configured: true,
        embeddable: result.ok,
        sizeBytes: result.ok ? result.size : null,
        contentType: result.ok ? result.contentType : null,
        reason: result.ok ? null : result.reason,
      };
    })
  );

  return {
    usingSample,
    orderCode: order.orderCode,
    // Aset yang diset admin, apa adanya dari database.
    storedAssets: storedReport,
    // URL yang benar-benar masuk ke HTML email, per event.
    renderedImages: perEvent,
    probes,
    // Hasil nyata dari jalur lampiran CID yang benar-benar dipakai saat
    // pengiriman order sungguhan — inilah yang membuktikan gambar akan
    // (atau tidak akan) ikut terkirim sebagai bagian dari email, bukan lagi
    // sekadar "URL-nya bisa dibuka".
    embedding,
    summary: {
      totalImageUrls: allUrls.size,
      ok: probes.length - broken.length,
      problematic: broken.length,
      // Aset yang diset admin tapi tidak sampai ke HTML sama sekali — inilah
      // gejala "logo tidak tampil" yang paling sering: URL-nya dibuang di
      // tahap resolver, jadi <img>-nya memang tidak pernah ada.
      configuredButDropped: storedReport.filter((r) => r.configured && !r.usable).map((r) => r.asset),
      embeddableCount: embedding.filter((e) => e.embeddable).length,
      embeddingWillFallback: embedding.filter((e) => e.configured && !e.embeddable).map((e) => e.asset),
    },
  };
}

/* ------------------------------------------------------- deliverability */

/**
 * Audit deliverability — TANPA menyentuh template email.
 *
 * Yang diperiksa adalah konfigurasi pengirim dan hasil pengiriman nyata yang
 * dilaporkan Resend, bukan isi pesannya.
 */
async function auditDeliverability() {
  const cfg = await getResendConfig();
  const domainStatus = await resend.getDomainStatus();
  const websiteSettings = await WebsiteSettings.getSingleton();

  const findings = [];
  const add = (severity, message) => findings.push({ severity, message });

  const fromDomain = String(cfg.fromEmail || "").split("@")[1] || "";

  if (!cfg.fromEmail) {
    add("error", "From email belum diisi — tidak ada email yang bisa dikirim.");
  } else if (isFreemailAddress(cfg.fromEmail)) {
    add("error", `From email "${cfg.fromEmail}" memakai domain gratisan dan tidak bisa diautentikasi atas nama toko.`);
  }

  const sendingDomain = (domainStatus.domains || []).find((d) => d.isSendingDomain);
  if (!domainStatus.success) {
    add("warn", `Status domain tidak bisa dibaca dari Resend: ${domainStatus.message || "tidak diketahui"}.`);
  } else if (!sendingDomain) {
    add(
      "error",
      `Domain "${fromDomain}" yang dipakai runtime TIDAK ada di daftar domain Resend. Runtime mengirim dari domain yang berbeda dari yang Anda verifikasi.`
    );
  } else {
    if (sendingDomain.status !== "verified") {
      add("error", `Domain ${sendingDomain.name} berstatus "${sendingDomain.status}" di Resend, bukan verified.`);
    }
    const byRecord = (name) => (sendingDomain.records || []).filter((r) => String(r.record || "").toUpperCase() === name);
    ["SPF", "DKIM", "DMARC"].forEach((record) => {
      const rows = byRecord(record);
      if (!rows.length) {
        // DMARC memang tidak selalu dikelola Resend — dilaporkan sebagai
        // catatan, bukan kegagalan, supaya tidak jadi alarm palsu.
        add(record === "DMARC" ? "info" : "warn", `Record ${record} tidak dilaporkan Resend untuk domain ini.`);
      } else if (rows.some((r) => r.status && r.status !== "verified")) {
        add("error", `Record ${record} belum verified di Resend.`);
      }
    });
    if (!byRecord("DMARC").length) {
      add(
        "info",
        "DMARC tidak terdeteksi. Untuk pengiriman ke Gmail, kebijakan DMARC minimal p=none di DNS domain toko sangat membantu reputasi pengirim."
      );
    }
  }

  if (!cfg.replyTo) {
    add("warn", "Reply-To belum diset. Email transaksional tanpa alamat balasan yang dipantau adalah sinyal negatif ringan.");
  }

  // Konsistensi identitas pengirim: nama di From harus sama dengan nama toko
  // yang dilihat pelanggan di Marketplace dan di isi email.
  const storeName = (websiteSettings.general && websiteSettings.general.storeName) || "";
  if (storeName && cfg.fromName && storeName.trim().toLowerCase() !== String(cfg.fromName).trim().toLowerCase()) {
    add(
      "warn",
      `Nama pengirim "${cfg.fromName}" berbeda dari nama toko "${storeName}". Ketidakcocokan identitas pengirim menurunkan kepercayaan penerima.`
    );
  }

  if (process.env.NODE_ENV !== "production") {
    add("warn", `NODE_ENV="${process.env.NODE_ENV || "(kosong)"}" — pastikan deployment produksi berjalan dengan NODE_ENV=production.`);
  }

  // Hasil nyata dari webhook Resend. Bounce dan complaint adalah penyebab
  // deliverability yang paling merusak, dan keduanya sudah tercatat di sini.
  const [delivered, bounced, complained, failed] = await Promise.all([
    NotificationLog.countDocuments({ channel: "email", deliveryStatus: "delivered" }),
    NotificationLog.countDocuments({ channel: "email", deliveryStatus: "bounced" }),
    NotificationLog.countDocuments({ channel: "email", deliveryStatus: "complained" }),
    NotificationLog.countDocuments({ channel: "email", status: "failed" }),
  ]);

  const totalTracked = delivered + bounced + complained;
  if (totalTracked > 0) {
    const bounceRate = (bounced / totalTracked) * 100;
    if (bounceRate >= 5) add("error", `Bounce rate ${bounceRate.toFixed(1)}% — di atas 5% reputasi pengirim ikut turun.`);
    if (complained > 0) add("warn", `${complained} email ditandai spam oleh penerima. Setiap laporan menurunkan reputasi domain.`);
  }
  if (totalTracked === 0) {
    add(
      "info",
      "Belum ada event delivered/bounced/complained yang tercatat. Pasang webhook Resend (RESEND_WEBHOOK_SECRET) agar status pengiriman sebenarnya bisa dibaca, bukan hanya 'diterima API'."
    );
  }

  return {
    sender: {
      fromEmail: cfg.fromEmail || null,
      fromName: cfg.fromName || null,
      replyTo: cfg.replyTo || null,
      fromDomain,
      enabled: cfg.enabled,
    },
    domains: domainStatus.domains || [],
    counters: { delivered, bounced, complained, failedToSend: failed },
    findings,
    // Batas yang jujur: tidak ada konfigurasi apa pun yang bisa MEMAKSA Gmail
    // menaruh email di Primary. Yang bisa dikerjakan aplikasi hanyalah
    // menghapus alasan teknis untuk tidak mempercayainya.
    disclaimer:
      "Penempatan Inbox/Spam ditentukan Gmail berdasarkan reputasi pengirim dari waktu ke waktu. Audit ini menghapus penyebab teknis dari sisi aplikasi dan provider; tidak ada kode yang bisa memaksa penempatan Primary.",
  };
}

/** Status ringkas Discord untuk dashboard integrasi (tanpa token). */
function discordStatus() {
  return discord.getStatus();
}

module.exports = { auditEmailAssets, auditDeliverability, probeImage, extractImageSources, discordStatus };
