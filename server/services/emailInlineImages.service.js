/**
 * Melampirkan gambar notifikasi (logo toko, gambar produk, ikon WhatsApp,
 * ikon Discord) ke EMAIL sebagai lampiran inline CID (Content-ID), bukan
 * sebagai <img src="https://..."> yang baru diminta Gmail SETELAH email
 * diterima.
 *
 * KENAPA INI ADA — ROOT CAUSE
 * ---------------------------
 * Implementasi sebelumnya (utils/assetUrl.js + asset.controller.js) sudah
 * menormalisasi URL gambar dan membungkusnya lewat proxy domain toko sendiri
 * supaya tidak kena bot-protection domain R2 gratis. Itu solusi yang benar
 * untuk MASALAH URL, tapi tetap mewariskan satu asumsi yang ternyata rapuh:
 * Gmail harus BERHASIL memuat https://<domain-toko>/api/assets/proxy?src=...
 * dari internet, di waktu email itu DIBUKA — bergantung pada domain toko
 * tetap hidup, DNS resmi, TLS valid, tidak di-throttle, dan tidak diblokir
 * image-proxy Gmail (Gmail menolak citra dari origin yang lambat/tidak stabil
 * tanpa pesan error yang terlihat pengguna — gambar hanya tidak tampil).
 * Kalau ANY dari itu gagal (mis. CLIENT_URL/SERVER_PUBLIC_URL belum diset di
 * Railway sehingga emailAssetBase() balik "" dan toEmailSafeUrl() diam-diam
 * mengembalikan URL R2 mentah yang memang diblokir bot-protection-nya),
 * hasilnya persis gejala yang dilaporkan: gambar TIDAK MUNCUL SAMA SEKALI,
 * tanpa error di mana pun karena Gmail tidak pernah melaporkan kegagalan
 * memuat gambar ke pengirim.
 *
 * CID menghilangkan seluruh ketergantungan itu: server TOKO yang mengambil
 * byte gambar dari storage (server-to-server, jalur yang sama seperti
 * asset.controller.proxyAsset — tidak pernah kena bot-protection yang
 * menyasar proxy gambar publik), lalu menyertakan byte itu LANGSUNG di dalam
 * payload yang dikirim ke Resend sebagai attachment ber-Content-ID. Begitu
 * Resend menerima email itu (respons sukses dari POST /emails), gambarnya
 * SUDAH ikut terkirim sebagai bagian dari pesan MIME multipart/related —
 * tidak ada permintaan susulan apa pun yang bisa gagal setelah itu. Referensi
 * di HTML memakai skema `cid:` (RFC 2387), didukung semua email client utama
 * termasuk Gmail.
 *
 * Didukung resmi oleh Resend: attachment dengan field `content` (base64) +
 * `content_id`, direferensikan di HTML lewat `src="cid:<content_id>"`.
 * https://resend.com/docs/dashboard/emails/embed-inline-images
 *
 * FALLBACK: kalau pengambilan gambar untuk SATU aset gagal (storage down,
 * file terhapus, dll), aset itu saja yang jatuh kembali ke URL proxy externals
 * (ctx.logoUrl dkk apa adanya) — bukan seluruh email yang gagal terkirim.
 * Tidak ada gambar yang dikarang/diganti; yang gagal diambil tetap kosong
 * atau tetap URL lama, sama seperti sebelumnya.
 */

const axios = require("axios");
const logger = require("../utils/logger");
const { isEmailRenderable, extensionOf } = require("../utils/assetUrl");

const FETCH_TIMEOUT_MS = 8000;
// Logo/ikon/thumbnail toko selalu jauh di bawah ini dalam praktik. Batas ini
// mencegah satu aset raksasa membuat email melebihi batas Resend (40MB
// setelah base64) atau batas penerima (Gmail/Outlook ~25MB per pesan).
const MAX_BYTES_PER_IMAGE = 3 * 1024 * 1024; // 3MB per gambar
const MAX_TOTAL_EMBED_BYTES = 8 * 1024 * 1024; // 8MB total per email (~10.7MB setelah base64)

/**
 * Mengambil byte gambar langsung dari storage, memvalidasi seperti yang
 * dilakukan email client (status HTTP, Content-Type, ukuran, buffer tidak
 * kosong) — kombinasi pengecekan yang sama dengan diagnostics.service.js
 * probeImage() dan asset.controller.js proxyAsset(), supaya alasan gagal
 * konsisten di seluruh sistem.
 */
async function fetchImageBuffer(url, label) {
  if (!url) return { ok: false, reason: "URL kosong" };
  if (!isEmailRenderable(url)) {
    return { ok: false, reason: `ekstensi ${extensionOf(url) || "(tidak diketahui)"} tidak didukung sebagai lampiran gambar email` };
  }

  try {
    const response = await axios.get(url, {
      timeout: FETCH_TIMEOUT_MS,
      responseType: "arraybuffer",
      maxContentLength: MAX_BYTES_PER_IMAGE,
      maxBodyLength: MAX_BYTES_PER_IMAGE,
      maxRedirects: 3,
      validateStatus: () => true,
    });

    if (response.status < 200 || response.status >= 300) {
      return { ok: false, reason: `storage membalas HTTP ${response.status}` };
    }

    const contentType = String((response.headers && response.headers["content-type"]) || "").split(";")[0].trim();
    if (!/^image\//i.test(contentType)) {
      return { ok: false, reason: `Content-Type "${contentType || "(kosong)"}" bukan image/*` };
    }

    const buffer = Buffer.from(response.data);
    if (!buffer.length) return { ok: false, reason: "buffer kosong" };
    if (buffer.length > MAX_BYTES_PER_IMAGE) {
      return { ok: false, reason: `gambar ${buffer.length} bytes melebihi batas lampiran ${MAX_BYTES_PER_IMAGE} bytes` };
    }

    return { ok: true, buffer, contentType, size: buffer.length };
  } catch (err) {
    // ENOTFOUND/ECONNREFUSED/timeout/dll — tidak pernah melempar, supaya satu
    // aset gagal tidak pernah menggagalkan pengiriman channel lain (spec 25).
    return { ok: false, reason: err.code || err.message };
  }
}

// Field mana di ctx yang boleh dilampirkan sebagai CID untuk email, dan nama
// Content-ID/filename yang dipakai di dalamnya. Field mentah (...Raw) dibaca
// dari template.service.buildContext(); field akhir (mis. "logoUrl") yang
// DITULIS ULANG di sini hanya pada objek ctx yang dioper masuk — pemanggil
// WAJIB mengoper salinan (bukan ctx asli) supaya channel lain (Discord,
// WhatsApp) yang membaca ctx yang sama tidak ikut berubah.
const EMBEDDABLE_FIELDS = [
  { field: "logoUrl", rawField: "logoUrlRaw", contentId: "brand-logo", filename: "logo", label: "logo toko" },
  { field: "productImage", rawField: "productImageRaw", contentId: "product-image", filename: "produk", label: "gambar produk" },
  { field: "waIcon", rawField: "waIconRaw", contentId: "wa-icon", filename: "whatsapp-icon", label: "ikon WhatsApp" },
  { field: "discordIcon", rawField: "discordIconRaw", contentId: "discord-icon", filename: "discord-icon", label: "ikon Discord" },
];

function extensionForContentType(contentType) {
  if (/png/i.test(contentType)) return "png";
  if (/jpeg|jpg/i.test(contentType)) return "jpg";
  if (/gif/i.test(contentType)) return "gif";
  if (/webp/i.test(contentType)) return "webp";
  return "img";
}

/**
 * Mengubah ctx (DIMODIFIKASI IN-PLACE — pemanggil wajib mengoper salinan)
 * supaya field gambar memakai "cid:<content_id>" untuk tiap aset yang
 * berhasil diambil, dan mengembalikan array attachment siap dikirim ke
 * resend.service.sendEmail({ attachments }).
 *
 * Aset yang gagal diambil TIDAK membuat proses berhenti — field itu saja
 * yang dibiarkan memakai nilai lama (URL proxy, hasil toEmailSafeUrl), persis
 * seperti sebelum CID ada. Setiap kegagalan dicatat lengkap dengan alasannya
 * supaya bisa dibuktikan dari Railway logs (spec: "Jangan silently ignore").
 */
async function embedContextImages(ctx, { orderCode } = {}) {
  const attachments = [];
  let totalBytes = 0;
  const idSuffix = String(orderCode || "preview")
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "preview";

  for (const spec of EMBEDDABLE_FIELDS) {
    const rawUrl = ctx[spec.rawField];
    if (!rawUrl) continue; // tidak ada aset untuk field ini — tidak ada yang perlu dilampirkan

    if (totalBytes >= MAX_TOTAL_EMBED_BYTES) {
      logger.warn("[EmailEmbed] anggaran lampiran per-email habis, aset tetap memakai URL eksternal", {
        orderCode,
        asset: spec.label,
      });
      continue;
    }

    const result = await fetchImageBuffer(rawUrl, spec.label);
    if (!result.ok) {
      logger.warn("[EmailEmbed] gagal mengambil gambar untuk dilampirkan sebagai CID — jatuh ke URL eksternal", {
        orderCode,
        asset: spec.label,
        url: rawUrl,
        reason: result.reason,
      });
      continue; // ctx[spec.field] dibiarkan apa adanya (fallback URL proxy)
    }

    totalBytes += result.size;
    const contentId = `${spec.contentId}-${idSuffix}`;
    attachments.push({
      filename: `${spec.filename}.${extensionForContentType(result.contentType)}`,
      content: result.buffer.toString("base64"),
      content_type: result.contentType,
      content_id: contentId,
    });
    ctx[spec.field] = `cid:${contentId}`;
  }

  if (attachments.length) {
    logger.info("[EmailEmbed] gambar dilampirkan sebagai CID", {
      orderCode,
      count: attachments.length,
      assets: attachments.map((a) => a.content_id),
      totalBytes,
    });
  }

  return attachments;
}

module.exports = { embedContextImages, fetchImageBuffer, MAX_BYTES_PER_IMAGE, MAX_TOTAL_EMBED_BYTES };
