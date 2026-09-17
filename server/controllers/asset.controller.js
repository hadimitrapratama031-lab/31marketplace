/**
 * Proxy gambar untuk notifikasi (email + Discord).
 *
 * Server ini yang mengambil gambar dari R2, bukan Gmail/Discord langsung.
 * Alasannya ada di utils/assetUrl.js (emailAssetBase). Ringkasnya: proxy
 * gambar Gmail dan bot Discord mengambil dari server MEREKA, dan domain
 * gratis "*.r2.dev" sering diblokir bot-protection pihak ketiga untuk jenis
 * traffic itu — walau link yang sama terbuka sempurna kalau dibuka manual di
 * browser. Server-to-server (di sini) tidak kena batasan itu.
 *
 * KEAMANAN: hanya boleh meneruskan host yang ada di allowlist
 * (isAllowedProxyTarget — R2_PUBLIC_URL + ASSET_PROXY_ALLOWED_HOSTS). Tanpa
 * ini endpoint ini jadi open proxy / celah SSRF. Ditolak sebelum satu byte
 * pun diminta ke luar.
 */

const axios = require("axios");
const asyncHandler = require("../utils/asyncHandler");
const { isAllowedProxyTarget } = require("../utils/assetUrl");
const logger = require("../utils/logger");

const TIMEOUT_MS = 10000;
const MAX_BYTES = 8 * 1024 * 1024; // aset toko (logo/ikon/produk) jauh di bawah ini

const proxyAsset = asyncHandler(async (req, res) => {
  const src = req.query.src;
  if (!src || typeof src !== "string") {
    return res.status(400).json({ status: false, message: "Parameter src wajib diisi." });
  }

  let parsed;
  try {
    parsed = new URL(src);
  } catch {
    return res.status(400).json({ status: false, message: "src bukan URL yang valid." });
  }
  if (parsed.protocol !== "https:" || !isAllowedProxyTarget(src)) {
    // Pesan sengaja tidak spesifik: tidak perlu memberi tahu penyerang host
    // mana yang ditolak vs diterima.
    return res.status(403).json({ status: false, message: "Sumber gambar tidak diizinkan." });
  }

  try {
    const upstream = await axios.get(src, {
      timeout: TIMEOUT_MS,
      responseType: "stream",
      maxContentLength: MAX_BYTES,
      maxBodyLength: MAX_BYTES,
      validateStatus: () => true,
    });

    if (upstream.status < 200 || upstream.status >= 300) {
      logger.warn("[AssetProxy] upstream gagal", { src, status: upstream.status });
      return res.status(502).json({ status: false, message: `Storage membalas HTTP ${upstream.status}.` });
    }

    const contentType = String(upstream.headers["content-type"] || "");
    if (!/^image\//i.test(contentType)) {
      logger.warn("[AssetProxy] Content-Type bukan gambar, ditolak", { src, contentType });
      return res.status(415).json({ status: false, message: "Objek bukan gambar." });
    }

    res.setHeader("Content-Type", contentType);
    // Aset toko diunggah dengan nama file unik (timestamp+uuid) — begitu URL-
    // nya berubah, isinya juga URL baru, jadi aman di-cache lama/immutable.
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    if (upstream.headers["content-length"]) res.setHeader("Content-Length", upstream.headers["content-length"]);

    if (req.method === "HEAD") {
      upstream.data.destroy();
      return res.status(200).end();
    }
    upstream.data.pipe(res);
  } catch (err) {
    logger.error("[AssetProxy] gagal mengambil gambar", { src, message: err.message });
    res.status(502).json({ status: false, message: "Gagal mengambil gambar dari storage." });
  }
});

module.exports = { proxyAsset };
