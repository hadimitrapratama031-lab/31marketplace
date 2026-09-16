const crypto = require("crypto");

// AES-256-GCM encryption for integration secrets stored in MongoDB
// (e.g. KlikQRIS / Fonnte / Resend credentials configured from Admin Web).
// ENCRYPTION_SECRET must be set in Railway environment variables — never in the DB.
function getKey() {
  const secret = process.env.ENCRYPTION_SECRET;
  if (!secret) throw new Error("ENCRYPTION_SECRET is not set");
  return crypto.createHash("sha256").update(secret).digest();
}

function encrypt(plainText) {
  if (plainText === null || plainText === undefined || plainText === "") return null;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", getKey(), iv);
  const encrypted = Buffer.concat([cipher.update(String(plainText), "utf8"), cipher.final()]);
  const authTag = cipher.getAuthTag();
  return Buffer.concat([iv, authTag, encrypted]).toString("base64");
}

function decrypt(payload) {
  if (!payload) return null;
  const raw = Buffer.from(payload, "base64");
  const iv = raw.subarray(0, 12);
  const authTag = raw.subarray(12, 28);
  const encrypted = raw.subarray(28);
  const decipher = crypto.createDecipheriv("aes-256-gcm", getKey(), iv);
  decipher.setAuthTag(authTag);
  const decrypted = Buffer.concat([decipher.update(encrypted), decipher.final()]);
  return decrypted.toString("utf8");
}

// Returns a masked preview like "••••••••ab12" for display in Admin Web, never the real secret.
function maskSecret(plainText) {
  if (!plainText) return null;
  const str = String(plainText);
  const tail = str.slice(-4);
  return "•".repeat(12) + tail;
}

module.exports = { encrypt, decrypt, maskSecret };
