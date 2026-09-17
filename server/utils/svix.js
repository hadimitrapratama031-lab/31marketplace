const crypto = require("crypto");

/**
 * Verifikasi minimal skema webhook Svix (dipakai Resend), tanpa menambah
 * dependency baru: HMAC-SHA256 atas "{svix-id}.{svix-timestamp}.{rawBody}"
 * memakai secret key yang tersimpan di RESEND_WEBHOOK_SECRET (format
 * "whsec_<base64>"), dibandingkan timing-safe terhadap tiap signature di
 * header `svix-signature` (bisa berisi beberapa versi dipisah spasi).
 *
 * Dilakukan atas byte MENTAH dari body (req.rawBody) — bukan
 * JSON.stringify(req.body) — karena representasi ulang JSON tidak dijamin
 * byte-identik dengan yang dikirim dan ditandatangani pengirim.
 */
const TOLERANCE_SECONDS = 5 * 60;

function verifySvixSignature({ secret, id, timestamp, signatureHeader, rawBody }) {
  if (!secret || !id || !timestamp || !signatureHeader || !rawBody) return false;

  const now = Math.floor(Date.now() / 1000);
  const ts = Number(timestamp);
  if (!Number.isFinite(ts) || Math.abs(now - ts) > TOLERANCE_SECONDS) return false;

  const secretKey = Buffer.from(secret.replace(/^whsec_/, ""), "base64");
  const signedContent = `${id}.${timestamp}.${rawBody.toString("utf8")}`;
  const expected = crypto.createHmac("sha256", secretKey).update(signedContent).digest("base64");

  const candidates = String(signatureHeader)
    .split(" ")
    .map((part) => part.split(",")[1])
    .filter(Boolean);

  const expectedBuf = Buffer.from(expected);
  return candidates.some((candidate) => {
    try {
      const candidateBuf = Buffer.from(candidate);
      return candidateBuf.length === expectedBuf.length && crypto.timingSafeEqual(candidateBuf, expectedBuf);
    } catch {
      return false;
    }
  });
}

module.exports = { verifySvixSignature };
