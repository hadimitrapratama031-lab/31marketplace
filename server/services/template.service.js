/**
 * Satu-satunya tempat pesan notifikasi dibangun (WhatsApp + Email).
 *
 * Dipertahankan sebagai file existing (bukan sistem baru): renderTemplate()
 * dan formatIDR() tetap diekspor dengan perilaku lama supaya template custom
 * yang sudah disimpan admin di IntegrationSettings.templates tetap jalan.
 * Yang ditambahkan adalah builder bawaan (buildWhatsAppMessage /
 * buildEmail) yang dipakai kalau admin BELUM menulis template sendiri.
 */

const { resolveAssetUrl, toEmailSafeUrl } = require("../utils/assetUrl");

/* ------------------------------------------------------------ primitives */

// Mengganti token {{placeholder}} dengan nilai asli. Render tetap di backend
// supaya template dari admin tidak pernah bisa merusak sistem.
function renderTemplate(template, data) {
  if (!template) return "";
  return template.replace(/{{\s*([a-zA-Z_]+)\s*}}/g, (_match, key) => {
    const value = data[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

function formatIDR(amount) {
  const number = Number(amount) || 0;
  return "Rp " + number.toLocaleString("id-ID");
}

const TZ = process.env.TZ || "Asia/Jakarta";

// "17 Sep 2026, 12:30 WIB" — satu format waktu untuk WhatsApp dan Email,
// selalu dalam timezone toko, bukan timezone server Railway (UTC).
function formatDateTime(value) {
  if (!value) return "";
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return "";
  const parts = new Intl.DateTimeFormat("id-ID", {
    timeZone: TZ,
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);
  const get = (type) => (parts.find((p) => p.type === type) || {}).value || "";
  const suffix = TZ === "Asia/Jakarta" ? " WIB" : "";
  return `${get("day")} ${get("month")} ${get("year")}, ${get("hour")}:${get("minute")}${suffix}`;
}

function escapeHTML(value) {
  return String(value === undefined || value === null ? "" : value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// Email client tidak bisa memuat localhost/blob/relative path.
//
// Versi lama fungsi ini hanya menerima URL yang SUDAH https:// dan membuang
// sisanya tanpa jejak — termasuk path relatif seperti "/branding/logo.png"
// yang tersimpan di MongoDB ketika R2_PUBLIC_URL belum/salah diset saat file
// diunggah. Di browser path itu masih tampil (di-resolve ke domain toko),
// sehingga logonya terlihat benar di Admin Web tapi hilang di email.
//
// Sekarang normalisasi dan pembuangannya dikerjakan utils/assetUrl.js: path
// relatif dipasangkan ke R2_PUBLIC_URL, http:// di-upgrade ke https://, dan
// URL yang tetap tidak bisa dipakai dicatat ke log lengkap dengan alasannya.
// Aset yang dipilih admin tidak pernah diganti — hanya URL-nya yang dibetulkan.
function safeRemoteUrl(value, label) {
  return resolveAssetUrl(value, label);
}

/* ------------------------------------------------------------ event copy */

// Satu sumber untuk judul, penjelasan, dan warna aksen tiap event. WhatsApp
// dan Email membaca tabel yang sama supaya kata-katanya tidak pernah beda.
const EVENT_COPY = {
  orderCreated: {
    waTitle: "Pesanan Berhasil Dibuat",
    emailTitle: "Pesanan berhasil dibuat",
    subtitle: "Pesanan sudah kami catat dan menunggu pembayaran.",
    // Subject profesional & konsisten dengan nama toko (bukan hardcoded "31
    // STORE") — mengikuti pola "Judul Event — Nama Toko" yang tidak terlihat
    // seperti spam (tanpa emoji/ALL CAPS/klaim berlebihan), plus Order ID di
    // akhir supaya pelanggan/inbox tetap bisa membedakan pesanan yang mana.
    subject: (ctx) => `Pesanan Anda Berhasil Dibuat — ${ctx.storeName} (${ctx.orderCode})`,
    lead: (ctx) =>
      `Pesanan Anda untuk ${ctx.productName} sudah kami catat. Pesanan akan kami proses segera setelah pembayaran diterima.`,
    statusLabel: "Menunggu pembayaran",
    accent: "#6d3bee",
    accentSoft: "#f1ecff",
  },
  paymentSuccess: {
    waTitle: "Pembayaran Berhasil",
    emailTitle: "Pembayaran berhasil",
    subtitle: "Dana sudah kami terima dan pesanan sedang diproses.",
    subject: (ctx) => `Pembayaran Berhasil — ${ctx.storeName} (${ctx.orderCode})`,
    lead: (ctx) =>
      `Pembayaran untuk ${ctx.productName} sudah kami terima. Pesanan Anda sedang kami proses dan akan dikirimkan melalui kontak yang Anda daftarkan.`,
    statusLabel: "Berhasil",
    accent: "#0f7a52",
    accentSoft: "#e6f4ee",
  },
  paymentFailed: {
    waTitle: "Pembayaran Gagal",
    emailTitle: "Pembayaran gagal",
    subtitle: "Pembayaran tidak dapat diselesaikan.",
    subject: (ctx) => `Pembayaran Gagal — ${ctx.storeName} (${ctx.orderCode})`,
    lead: (ctx) =>
      `Pembayaran untuk ${ctx.productName} tidak berhasil diproses, sehingga pesanan ini tidak dapat dilanjutkan. Anda dapat membuat pesanan baru atau menghubungi admin untuk bantuan.`,
    statusLabel: "Gagal",
    accent: "#b3261e",
    accentSoft: "#fdeceb",
  },
  paymentExpired: {
    waTitle: "Pembayaran Kedaluwarsa",
    emailTitle: "Pembayaran kedaluwarsa",
    subtitle: "Batas waktu pembayaran sudah terlewat.",
    subject: (ctx) => `Pembayaran Kedaluwarsa — ${ctx.storeName} (${ctx.orderCode})`,
    lead: (ctx) =>
      `Batas waktu pembayaran untuk ${ctx.productName} sudah terlewat, sehingga pesanan ini ditutup tanpa pembayaran. Silakan buat pesanan baru jika masih ingin melanjutkan.`,
    statusLabel: "Kedaluwarsa",
    accent: "#8a5a00",
    accentSoft: "#fdf2dd",
  },
};

/**
 * Menyusun data mentah (Order + Transaction + WebsiteSettings) menjadi satu
 * objek datar yang dipakai WhatsApp dan Email. Semua nilai berasal dari
 * database — tidak ada yang dikarang, dan field yang kosong tetap kosong
 * sehingga baris yang bersangkutan tidak ikut dirender.
 */
function buildContext({ event, order, transaction, settings, productImageFallback }) {
  const general = (settings && settings.general) || {};
  const contact = (settings && settings.contact) || {};
  const theme = (settings && settings.theme) || {};
  const wa = contact.whatsapp || {};
  const discord = contact.discord || {};

  const waDigits = String(wa.number || "").replace(/\D/g, "");
  // Admin boleh menyimpan nomor polos ATAU URL wa.me lengkap — keduanya
  // menghasilkan href yang sama, dan tidak ada nomor yang di-hardcode.
  const waHref = /^https?:\/\//i.test(String(wa.number || "").trim())
    ? String(wa.number).trim()
    : waDigits
    ? `https://wa.me/${waDigits}`
    : "";

  const copy = EVENT_COPY[event];
  const paymentMethod = transaction && transaction.paymentGateway === "KLIKQRIS" ? "QRIS" : (transaction && transaction.paymentGateway) || "";

  // URL asli (belum dibungkus proxy domain toko) untuk tiap gambar. Disimpan
  // terpisah di ...Raw supaya emailInlineImages.service.js bisa mengambil
  // byte gambarnya LANGSUNG dari storage (server-to-server, sama seperti
  // asset.controller.proxyAsset) dan melampirkannya ke email sebagai CID —
  // tidak lagi bergantung pada Gmail mau memuat https://.../api/assets/proxy
  // dari internet. ctx.logoUrl dkk (URL proxy) tetap dihitung apa adanya dan
  // dipakai sebagai fallback kalau pengambilan untuk lampiran gagal, dan
  // tetap satu-satunya sumber yang dipakai Discord (lihat discord.service.js
  // buildPaymentSuccessEmbed) — channel itu memang butuh URL asli, bukan CID.
  const logoRaw = safeRemoteUrl(general.logo || (settings && settings.footer && settings.footer.logo), "general.logo");
  const productImageRaw =
    safeRemoteUrl(order.product && order.product.image, "order.product.image") ||
    safeRemoteUrl(productImageFallback, "product.image (live)");
  const waIconRaw = safeRemoteUrl(wa.icon, "contact.whatsapp.icon");
  const discordIconRaw = safeRemoteUrl(discord.icon, "contact.discord.icon");

  const ctx = {
    event,
    storeName: general.storeName || "Store",
    storeTagline: general.description || "",
    // Logo Store: yang dipakai adalah logo aktif dari Admin Web > Branding.
    // footer.logo hanya cadangan kalau field branding memang kosong.
    // toEmailSafeUrl() membungkusnya lewat domain toko sendiri — lihat
    // utils/assetUrl.js untuk alasannya (domain R2 gratis sering diblokir
    // proxy gambar Gmail/Discord walau linknya valid). Untuk EMAIL, URL ini
    // hanya dipakai sebagai fallback — lihat logoUrlRaw di atas.
    logoUrl: toEmailSafeUrl(logoRaw),
    logoUrlRaw: logoRaw,

    customerName: (order.customer && order.customer.name) || "Pelanggan",
    customerEmail: (order.customer && order.customer.email) || "",
    customerWhatsApp: (order.customer && order.customer.whatsapp) || "",

    orderCode: order.orderCode,
    productName: (order.product && order.product.name) || "",
    // Gambar produk diambil dari snapshot order. `productImageFallback` diisi
    // notification.service dengan Product.image yang hidup sekarang, untuk
    // order lama yang snapshot-nya tersimpan sebelum URL R2-nya dibetulkan.
    productImage: toEmailSafeUrl(productImageRaw),
    productImageRaw,
    quantity: order.quantity,
    price: formatIDR(order.product && order.product.price),
    // Yang ditagihkan gateway adalah totalAmount (total + kode unik). Kalau
    // ada, itu yang ditampilkan sebagai Total supaya angka di notifikasi
    // sama persis dengan angka yang dibayar pelanggan.
    total: formatIDR((transaction && transaction.totalAmount) || order.total),
    paymentMethod,

    statusLabel: copy ? copy.statusLabel : order.paymentStatus,
    orderedAt: formatDateTime(order.createdAt),
    paidAt: formatDateTime(transaction && transaction.paidAt),
    expiredAt: formatDateTime(transaction && transaction.expiredAt),
    payUrl: safeRemoteUrl(transaction && (transaction.directUrl || transaction.qrisUrl), "transaction.payUrl"),

    waHref,
    // Ikon dibungkus proxy (gambar); href tautan dibiarkan apa adanya (bukan
    // gambar, tidak perlu dan tidak boleh diproxy).
    waIcon: toEmailSafeUrl(waIconRaw),
    waIconRaw,
    waEnabled: wa.enabled !== false && Boolean(waHref),
    discordHref: safeRemoteUrl(discord.url, "contact.discord.url") || (discord.url && /^https?:\/\//i.test(discord.url) ? discord.url : ""),
    discordIcon: toEmailSafeUrl(discordIconRaw),
    discordIconRaw,
    discordEnabled: discord.enabled !== false && Boolean(discord.url),

    accent: copy ? copy.accent : theme.primary || "#6d3bee",
    accentSoft: copy ? copy.accentSoft : "#f1ecff",
  };

  ctx.subject = copy ? copy.subject(ctx) : `Update pesanan ${ctx.orderCode}`;
  return ctx;
}

// Placeholder untuk template custom admin. Tetap kompatibel dengan nama
// lama ({{customer_name}}, {{order_code}}, …) dan menambah yang baru.
function placeholders(ctx) {
  return {
    customer_name: ctx.customerName,
    order_code: ctx.orderCode,
    product_name: ctx.productName,
    quantity: ctx.quantity,
    price: ctx.price,
    total: ctx.total,
    payment_status: ctx.statusLabel,
    payment_method: ctx.paymentMethod,
    store_name: ctx.storeName,
    ordered_at: ctx.orderedAt,
    paid_at: ctx.paidAt,
    expired_at: ctx.expiredAt,
    pay_url: ctx.payUrl,
    wa_admin_url: ctx.waHref,
    discord_url: ctx.discordHref,
  };
}

/* ------------------------------------------------------------- whatsapp */

const RULE = "━━━━━━━━━━━━━━━━━━━━";

// Baris "Label : Nilai" dengan label dipadkan supaya kolom nilainya lurus.
// WhatsApp memakai font proporsional, jadi kelurusan tidak pernah sempurna —
// padding tetap dipakai karena hasilnya jauh lebih terbaca daripada tanpa.
function detailLine(label, value) {
  if (value === undefined || value === null || value === "") return null;
  return `${label.padEnd(12, " ")}: ${value}`;
}

function buildWhatsAppMessage(ctx) {
  const copy = EVENT_COPY[ctx.event];
  if (!copy) return "";

  const lines = [];
  lines.push(RULE);
  lines.push(ctx.storeName.toUpperCase());
  if (ctx.storeTagline) lines.push(ctx.storeTagline);
  lines.push(RULE);
  lines.push("");
  lines.push(`*${copy.waTitle}*`);
  lines.push("");
  lines.push(`Halo, ${ctx.customerName}.`);
  lines.push("");
  lines.push(copy.lead(ctx));
  lines.push("");
  lines.push("*DETAIL PESANAN*");
  lines.push(RULE);

  const details = [
    detailLine("Produk", ctx.quantity > 1 ? `${ctx.productName} x${ctx.quantity}` : ctx.productName),
    detailLine("Order ID", ctx.orderCode),
    detailLine("Harga", ctx.price),
    detailLine("Total", ctx.total),
    detailLine("Pembayaran", ctx.paymentMethod),
    detailLine("Status", ctx.statusLabel),
    detailLine("Waktu", ctx.orderedAt),
  ].filter(Boolean);

  if (ctx.event === "paymentSuccess" && ctx.paidAt) details.push(detailLine("Dibayar", ctx.paidAt));
  if ((ctx.event === "orderCreated" || ctx.event === "paymentExpired") && ctx.expiredAt) {
    details.push(detailLine(ctx.event === "paymentExpired" ? "Kedaluwarsa" : "Batas bayar", ctx.expiredAt));
  }
  lines.push(...details);
  lines.push(RULE);
  lines.push("");

  // Blok tambahan per event. Hanya berisi hal yang benar-benar diketahui
  // sistem — alasan kegagalan tidak pernah dikarang kalau provider tidak
  // memberikannya (spec 10).
  if (ctx.event === "orderCreated") {
    lines.push("*CARA MEMBAYAR*");
    lines.push("Selesaikan pembayaran melalui halaman pembayaran, lalu status pesanan akan diperbarui otomatis.");
    if (ctx.payUrl) {
      lines.push("");
      lines.push(ctx.payUrl);
    }
    if (ctx.expiredAt) {
      lines.push("");
      lines.push(`Selesaikan sebelum ${ctx.expiredAt} agar pesanan tidak ditutup otomatis.`);
    }
  } else if (ctx.event === "paymentSuccess") {
    lines.push("*LANGKAH SELANJUTNYA*");
    lines.push("Pesanan sedang kami proses. Detail produk akan dikirimkan ke WhatsApp dan email ini. Simpan Order ID di atas untuk mengecek status kapan saja.");
  } else if (ctx.event === "paymentFailed") {
    lines.push("*LANGKAH SELANJUTNYA*");
    lines.push("Silakan buat pesanan baru untuk mencoba kembali. Jika dana Anda terpotong, kirimkan Order ID di atas ke admin agar kami periksa.");
  } else if (ctx.event === "paymentExpired") {
    lines.push("*LANGKAH SELANJUTNYA*");
    lines.push("Pembayaran belum kami terima untuk pesanan ini. Silakan buat pesanan baru jika masih ingin melanjutkan.");
  }

  if (ctx.waEnabled || ctx.discordEnabled) {
    lines.push("");
    lines.push("*BUTUH BANTUAN?*");
    if (ctx.waEnabled) {
      lines.push("Hubungi admin melalui WhatsApp:");
      lines.push(ctx.waHref);
    }
    if (ctx.discordEnabled) {
      if (ctx.waEnabled) lines.push("");
      lines.push("Discord:");
      lines.push(ctx.discordHref);
    }
  }

  lines.push("");
  lines.push(`Terima kasih telah menggunakan ${ctx.storeName}.`);
  lines.push(RULE);

  return lines.join("\n");
}

/* ---------------------------------------------------------------- email */

const FONT = "-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif";
const INK = "#17122a";
const MUTED = "#6b6480";
const HAIRLINE = "#e7e3f2";
const PAGE = "#f4f3f7";

// Baris label/nilai di dalam card detail. Label rata kiri abu-abu, nilai
// rata kanan gelap — pola yang stabil di Gmail, Outlook, dan Apple Mail
// karena hanya memakai <table>, bukan flex/grid.
function row(label, value, opts = {}) {
  if (value === undefined || value === null || value === "") return "";
  const valueStyle = opts.strong
    ? `font-size:15px;font-weight:700;color:${INK};`
    : `font-size:14px;font-weight:500;color:${INK};`;
  return `<tr>
<td style="padding:11px 0;border-bottom:1px solid ${HAIRLINE};font-family:${FONT};font-size:13px;color:${MUTED};white-space:nowrap;">${escapeHTML(label)}</td>
<td align="right" style="padding:11px 0 11px 16px;border-bottom:1px solid ${HAIRLINE};font-family:${FONT};${valueStyle}">${escapeHTML(value)}</td>
</tr>`;
}

// Tombol kontak. Kalau admin sudah mengunggah logo, logo itu yang dipakai;
// kalau belum, jatuh ke lettermark supaya tombol tidak pernah tampil rusak
// (spec 20). WhatsApp dan Discord tidak pernah berbagi satu logo.
function contactButton(href, label, iconUrl, fallbackMark, accent) {
  const mark = iconUrl
    ? `<img src="${escapeHTML(iconUrl)}" width="20" height="20" alt="" style="display:block;width:20px;height:20px;border:0;border-radius:5px;">`
    : `<span style="display:inline-block;width:20px;height:20px;line-height:20px;text-align:center;border-radius:5px;background:${accent};color:#ffffff;font-family:${FONT};font-size:10px;font-weight:700;">${escapeHTML(fallbackMark)}</span>`;
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="display:inline-table;margin:0 6px 8px 0;">
<tr><td style="border:1px solid ${HAIRLINE};border-radius:10px;background:#ffffff;">
<a href="${escapeHTML(href)}" target="_blank" rel="noopener" style="display:block;padding:11px 18px;text-decoration:none;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="padding-right:9px;">${mark}</td>
<td style="font-family:${FONT};font-size:14px;font-weight:600;color:${INK};white-space:nowrap;">${escapeHTML(label)}</td>
</tr></table></a></td></tr></table>`;
}

function buildEmailHtml(ctx) {
  const copy = EVENT_COPY[ctx.event];
  if (!copy) return "";

  const brandMark = ctx.logoUrl
    ? `<img src="${escapeHTML(ctx.logoUrl)}" width="40" height="40" alt="${escapeHTML(ctx.storeName)}" style="display:block;width:40px;height:40px;border:0;border-radius:10px;object-fit:cover;">`
    : `<span style="display:inline-block;width:40px;height:40px;line-height:40px;text-align:center;border-radius:10px;background:${ctx.accent};color:#ffffff;font-family:${FONT};font-size:17px;font-weight:700;">${escapeHTML(ctx.storeName.trim().charAt(0).toUpperCase() || "S")}</span>`;

  const productThumb = ctx.productImage
    ? `<tr><td colspan="2" style="padding:0 0 18px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%"><tr>
<td width="72" style="padding-right:14px;vertical-align:top;">
<img src="${escapeHTML(ctx.productImage)}" width="72" height="72" alt="" style="display:block;width:72px;height:72px;border:1px solid ${HAIRLINE};border-radius:10px;object-fit:cover;background:${PAGE};">
</td>
<td style="vertical-align:middle;font-family:${FONT};font-size:16px;font-weight:700;color:${INK};line-height:1.4;">${escapeHTML(ctx.productName)}${
        ctx.quantity > 1 ? `<span style="font-weight:500;color:${MUTED};"> &times;${escapeHTML(ctx.quantity)}</span>` : ""
      }</td>
</tr></table></td></tr>`
    : "";

  const rows =
    (ctx.productImage ? "" : row("Produk", ctx.quantity > 1 ? `${ctx.productName} ×${ctx.quantity}` : ctx.productName)) +
    row("Order ID", ctx.orderCode) +
    row("Harga satuan", ctx.price) +
    row("Pembayaran", ctx.paymentMethod) +
    row("Status", ctx.statusLabel) +
    row("Waktu pesanan", ctx.orderedAt) +
    (ctx.event === "paymentSuccess" ? row("Waktu pembayaran", ctx.paidAt) : "") +
    (ctx.event === "orderCreated" ? row("Batas pembayaran", ctx.expiredAt) : "") +
    (ctx.event === "paymentExpired" ? row("Kedaluwarsa pada", ctx.expiredAt) : "") +
    row("Total", ctx.total, { strong: true });

  const payBlock =
    ctx.event === "orderCreated" && ctx.payUrl
      ? `<tr><td style="padding:0 32px 4px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="border-radius:10px;background:${ctx.accent};">
<a href="${escapeHTML(ctx.payUrl)}" target="_blank" rel="noopener" style="display:block;padding:14px 28px;font-family:${FONT};font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;">Bayar sekarang</a>
</td></tr></table>
<p style="margin:12px 0 0;font-family:${FONT};font-size:13px;line-height:1.6;color:${MUTED};">Status pesanan diperbarui otomatis setelah pembayaran diterima.</p>
</td></tr>`
      : "";

  const contactButtons =
    (ctx.waEnabled ? contactButton(ctx.waHref, "Hubungi admin", ctx.waIcon, "WA", "#25d366") : "") +
    (ctx.discordEnabled ? contactButton(ctx.discordHref, "Discord", ctx.discordIcon, "DC", "#5865f2") : "");

  const helpBlock = contactButtons
    ? `<tr><td style="padding:28px 32px 0;">
<div style="border-top:1px solid ${HAIRLINE};padding-top:24px;">
<p style="margin:0 0 4px;font-family:${FONT};font-size:15px;font-weight:700;color:${INK};">Butuh bantuan?</p>
<p style="margin:0 0 16px;font-family:${FONT};font-size:14px;line-height:1.6;color:${MUTED};">Sebutkan Order ID ${escapeHTML(
        ctx.orderCode
      )} agar admin bisa langsung menemukan pesanan Anda.</p>
${contactButtons}
</div></td></tr>`
    : "";

  return `<!DOCTYPE html>
<html lang="id"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHTML(ctx.subject)}</title>
<style>
  @media only screen and (max-width:620px){
    .shell{width:100% !important;}
    .pad{padding-left:20px !important;padding-right:20px !important;}
  }
</style>
</head>
<body style="margin:0;padding:0;background:${PAGE};-webkit-font-smoothing:antialiased;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;">${escapeHTML(copy.subtitle)} Order ${escapeHTML(ctx.orderCode)}.</div>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:${PAGE};">
<tr><td align="center" style="padding:32px 16px 40px;">

<table role="presentation" class="shell" cellpadding="0" cellspacing="0" border="0" width="560" style="width:560px;max-width:560px;">

<tr><td class="pad" style="padding:0 32px 18px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="padding-right:12px;">${brandMark}</td>
<td style="font-family:${FONT};">
<div style="font-size:16px;font-weight:700;color:${INK};letter-spacing:-0.01em;">${escapeHTML(ctx.storeName)}</div>
${ctx.storeTagline ? `<div style="font-size:13px;color:${MUTED};margin-top:2px;">${escapeHTML(ctx.storeTagline)}</div>` : ""}
</td></tr></table>
</td></tr>

<tr><td style="background:#ffffff;border:1px solid ${HAIRLINE};border-radius:16px;">
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">

<tr><td style="height:4px;background:${ctx.accent};border-radius:16px 16px 0 0;font-size:0;line-height:0;">&nbsp;</td></tr>

<tr><td class="pad" style="padding:30px 32px 0;">
<h1 style="margin:0;font-family:${FONT};font-size:23px;line-height:1.3;font-weight:700;color:${INK};letter-spacing:-0.02em;">${escapeHTML(
    copy.emailTitle
  )}</h1>
<p style="margin:8px 0 0;font-family:${FONT};font-size:14px;line-height:1.6;color:${MUTED};">${escapeHTML(copy.subtitle)}</p>
</td></tr>

<tr><td class="pad" style="padding:22px 32px 0;">
<p style="margin:0;font-family:${FONT};font-size:15px;line-height:1.65;color:${INK};">Halo, ${escapeHTML(ctx.customerName)}.</p>
<p style="margin:10px 0 0;font-family:${FONT};font-size:15px;line-height:1.65;color:${INK};">${escapeHTML(copy.lead(ctx))}</p>
</td></tr>

<tr><td class="pad" style="padding:26px 32px 0;">
<div style="background:${ctx.accentSoft};border-radius:12px;padding:20px;">
<p style="margin:0 0 16px;font-family:${FONT};font-size:12px;font-weight:700;color:${ctx.accent};letter-spacing:0.04em;">Detail pesanan</p>
<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
${productThumb}${rows}
</table>
</div>
</td></tr>

<tr><td style="height:24px;font-size:0;line-height:0;">&nbsp;</td></tr>
${payBlock}
${helpBlock}
<tr><td style="height:30px;font-size:0;line-height:0;">&nbsp;</td></tr>
</table>
</td></tr>

<tr><td class="pad" style="padding:20px 32px 0;font-family:${FONT};font-size:12px;line-height:1.7;color:${MUTED};">
Email ini dikirim otomatis untuk pesanan ${escapeHTML(ctx.orderCode)} ke ${escapeHTML(ctx.customerEmail)}.
Balasan ke alamat ini tidak terbaca &mdash; gunakan kontak admin di atas.
<div style="margin-top:8px;">&copy; ${new Date().getFullYear()} ${escapeHTML(ctx.storeName)}</div>
</td></tr>

</table>
</td></tr></table>
</body></html>`;
}

// Baris "Label: Nilai" untuk versi plain-text — padanan `row()` tapi tanpa HTML.
function textLine(label, value) {
  if (value === undefined || value === null || value === "") return null;
  return `${label}: ${value}`;
}

/**
 * Versi plain-text dari email. WAJIB dikirim berdampingan dengan HTML
 * (multipart/alternative) — email yang HANYA berisi HTML, tanpa bagian
 * text/plain, adalah salah satu sinyal paling umum yang membuat provider
 * penerima (termasuk Gmail) menilai email sebagai kurang tepercaya dan lebih
 * mudah diarahkan ke Spam (spec 8 & 2). Dibangun langsung dari `ctx` — bukan
 * dari HTML admin yang mungkin dikustomisasi — supaya isi intinya (Order ID,
 * total, status, kontak admin) selalu ikut update kalau data order berubah,
 * apa pun sumber template HTML-nya.
 */
function buildEmailText(ctx) {
  const copy = EVENT_COPY[ctx.event];
  if (!copy) return "";

  const lines = [];
  lines.push(ctx.storeName);
  if (ctx.storeTagline) lines.push(ctx.storeTagline);
  lines.push("");
  lines.push(copy.emailTitle.toUpperCase());
  lines.push("");
  lines.push(`Halo, ${ctx.customerName}.`);
  lines.push(copy.lead(ctx));
  lines.push("");
  lines.push("Detail pesanan");
  lines.push("--------------");

  const details = [
    textLine("Produk", ctx.quantity > 1 ? `${ctx.productName} x${ctx.quantity}` : ctx.productName),
    textLine("Order ID", ctx.orderCode),
    textLine("Harga satuan", ctx.price),
    textLine("Pembayaran", ctx.paymentMethod),
    textLine("Status", ctx.statusLabel),
    textLine("Waktu pesanan", ctx.orderedAt),
    ctx.event === "paymentSuccess" ? textLine("Waktu pembayaran", ctx.paidAt) : null,
    ctx.event === "orderCreated" ? textLine("Batas pembayaran", ctx.expiredAt) : null,
    ctx.event === "paymentExpired" ? textLine("Kedaluwarsa pada", ctx.expiredAt) : null,
    textLine("Total", ctx.total),
  ].filter(Boolean);
  lines.push(...details);

  if (ctx.event === "orderCreated" && ctx.payUrl) {
    lines.push("");
    lines.push(`Bayar sekarang: ${ctx.payUrl}`);
  }

  if (ctx.waEnabled || ctx.discordEnabled) {
    lines.push("");
    lines.push(`Butuh bantuan? Sebutkan Order ID ${ctx.orderCode} ke admin.`);
    if (ctx.waEnabled) lines.push(`WhatsApp: ${ctx.waHref}`);
    if (ctx.discordEnabled) lines.push(`Discord: ${ctx.discordHref}`);
  }

  lines.push("");
  lines.push(`Email ini dikirim otomatis untuk pesanan ${ctx.orderCode} ke ${ctx.customerEmail}.`);
  lines.push(`© ${new Date().getFullYear()} ${ctx.storeName}`);

  return lines.join("\n");
}

/**
 * Menghasilkan isi final tiap channel. Template custom dari Admin Web selalu
 * menang kalau admin benar-benar sudah mengisinya; kalau tidak, dipakai
 * builder premium di atas. Tidak ada sistem template kedua.
 */
/**
 * Teks default versi LAMA yang pernah ditanam sebagai `default:` di skema
 * IntegrationSettings. Dokumen singleton dibuat otomatis pada boot pertama,
 * jadi field-field ini TIDAK PERNAH kosong di database — dan selama "tidak
 * kosong" dipakai sebagai tanda "admin menulis template sendiri", template
 * bawaan yang baru tidak akan pernah terpakai.
 *
 * Daftar ini membuat runtime bisa mengenali teks itu sebagai peninggalan
 * skema, bukan karya admin, bahkan kalau migrasi database belum dijalankan.
 * Jangan menambahkan template buatan admin ke sini.
 */
const LEGACY_TEMPLATES = new Set(
  [
    "Halo {{customer_name}}, order {{order_code}} untuk {{product_name}} sudah dibuat. Total: {{total}}.",
    "Pembayaran berhasil! Order {{order_code}} ({{product_name}}) sebesar {{total}} sudah kami terima. Terima kasih sudah belanja di {{store_name}}.",
    "Pembayaran untuk order {{order_code}} gagal diproses. Silakan coba lagi atau hubungi admin {{store_name}}.",
    "Waktu pembayaran untuk order {{order_code}} telah habis. Silakan lakukan order ulang di {{store_name}}.",
    "Order {{order_code}} Diterima — {{store_name}}",
    "Pembayaran Berhasil — {{order_code}}",
    "Pembayaran Gagal — {{order_code}}",
    "Order Kedaluwarsa — {{order_code}}",
    "<p>Halo {{customer_name}},</p><p>Order <b>{{order_code}}</b> untuk <b>{{product_name}}</b> x{{quantity}} sudah kami terima. Total: <b>{{total}}</b>.</p><p>Status: {{payment_status}}</p>",
    "<p>Halo {{customer_name}},</p><p>Pembayaran order <b>{{order_code}}</b> sebesar <b>{{total}}</b> telah berhasil. Terima kasih sudah berbelanja di {{store_name}}!</p>",
    "<p>Halo {{customer_name}},</p><p>Pembayaran order <b>{{order_code}}</b> gagal diproses. Silakan coba lagi.</p>",
    "<p>Halo {{customer_name}},</p><p>Waktu pembayaran order <b>{{order_code}}</b> telah habis.</p>",
  ].map((t) => t.trim())
);

// Kosong ATAU sama persis dengan default skema lama = bukan template admin.
function isAdminWritten(value) {
  if (!value || !String(value).trim()) return false;
  return !LEGACY_TEMPLATES.has(String(value).trim());
}

/**
 * Menentukan isi final SEKALIGUS melaporkan asalnya. `source` sengaja ikut
 * dikembalikan supaya bisa dicatat di NotificationLog dan dilihat admin —
 * tanpa itu tidak ada cara membuktikan template mana yang benar-benar
 * dipakai runtime, hanya menebak dari isi pesan.
 */
function resolveWhatsApp(ctx, customTemplate) {
  if (isAdminWritten(customTemplate)) {
    return { source: "custom", text: renderTemplate(customTemplate, placeholders(ctx)) };
  }
  return { source: "builtin", text: buildWhatsAppMessage(ctx) };
}

function resolveEmail(ctx, customTemplate) {
  const data = placeholders(ctx);
  const tpl = customTemplate || {};
  const htmlIsCustom = isAdminWritten(tpl.html);
  const subjectIsCustom = isAdminWritten(tpl.subject);
  return {
    source: htmlIsCustom ? "custom" : "builtin",
    subject: subjectIsCustom ? renderTemplate(tpl.subject, data) : ctx.subject,
    html: htmlIsCustom ? renderTemplate(tpl.html, data) : buildEmailHtml(ctx),
    // Selalu diturunkan dari `ctx`, bukan dari HTML admin (yang bisa berisi
    // markup tak beraturan kalau ditelanjangi tag-nya). Ini bagian
    // text/plain wajib untuk email multipart — lihat buildEmailText().
    text: buildEmailText(ctx),
  };
}

// Dipertahankan supaya pemanggil lama tetap jalan; keduanya hanya membungkus
// resolver di atas agar tidak ada dua logika pemilihan template.
function buildWhatsApp(ctx, customTemplate) {
  return resolveWhatsApp(ctx, customTemplate).text;
}

function buildEmail(ctx, customTemplate) {
  const resolved = resolveEmail(ctx, customTemplate);
  return { subject: resolved.subject, html: resolved.html, text: resolved.text };
}

module.exports = {
  renderTemplate,
  resolveWhatsApp,
  resolveEmail,
  isAdminWritten,
  LEGACY_TEMPLATES,
  formatIDR,
  formatDateTime,
  safeRemoteUrl,
  buildContext,
  buildWhatsApp,
  buildEmail,
  buildWhatsAppMessage,
  buildEmailHtml,
  buildEmailText,
  EVENT_COPY,
};
