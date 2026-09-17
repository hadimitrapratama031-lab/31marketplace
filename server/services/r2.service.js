const { PutObjectCommand, DeleteObjectCommand, HeadBucketCommand } = require("@aws-sdk/client-s3");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const { getR2Client, isR2Configured } = require("../config/r2");
const { AppError } = require("../middlewares/errorHandler");
const logger = require("../utils/logger");

// Cloudflare R2 speaks the S3 API, so failures surface as AWS SDK exceptions
// (S3ServiceException) or plain Node network errors (DNS/connection/timeout).
// Both are opaque to the errorHandler — without translation here they fall
// through as a generic 500 "Terjadi kesalahan pada server", so Admin Web
// shows the same message whether R2 is misconfigured, unreachable, or the
// upload genuinely failed, and there is nothing to act on.
function describeR2Failure(err) {
  const code = err.Code || err.code || err.name || "";
  const httpStatus = err.$metadata?.httpStatusCode;

  if (
    code === "InvalidAccessKeyId" ||
    code === "SignatureDoesNotMatch" ||
    code === "CredentialsProviderError" ||
    httpStatus === 401
  ) {
    return "Kredensial Cloudflare R2 tidak valid. Periksa R2_ACCESS_KEY_ID dan R2_SECRET_ACCESS_KEY di server.";
  }
  if (code === "AccessDenied" || httpStatus === 403) {
    return "Akses ke bucket R2 ditolak. Periksa hak akses API token dan nama R2_BUCKET_NAME.";
  }
  if (code === "NoSuchBucket") {
    return "Bucket R2 tidak ditemukan. Periksa R2_BUCKET_NAME di server.";
  }
  if (["ENOTFOUND", "ECONNREFUSED", "ETIMEDOUT", "EAI_AGAIN"].includes(code)) {
    return "Server tidak bisa terhubung ke Cloudflare R2. Periksa R2_ACCOUNT_ID dan koneksi jaringan server.";
  }
  return "Upload gambar ke Cloudflare R2 gagal. Coba lagi, atau periksa konfigurasi R2 di server.";
}

// Uploads a buffer to Cloudflare R2 and returns { url, key }.
// folder e.g. "products", "logos", "avatars", "backgrounds".
async function uploadBuffer(buffer, originalName, mimeType, folder = "misc") {
  if (!isR2Configured()) {
    throw new AppError("Cloudflare R2 belum dikonfigurasi di server (ENV R2_* belum diisi).", 503);
  }
  const client = getR2Client();
  const ext = path.extname(originalName || "") || "";
  const key = `${folder}/${Date.now()}-${uuidv4()}${ext}`;

  try {
    await client.send(
      new PutObjectCommand({
        Bucket: process.env.R2_BUCKET_NAME,
        Key: key,
        Body: buffer,
        ContentType: mimeType,
      })
    );
  } catch (err) {
    // Full technical detail goes to the server log (never secrets, never the
    // client) so the real cause is diagnosable from Railway logs instead of
    // guessed at from a generic "server error" toast.
    logger.error("R2 upload failed", {
      folder,
      code: err.Code || err.code || err.name,
      httpStatus: err.$metadata?.httpStatusCode,
      message: err.message,
    });
    throw new AppError(describeR2Failure(err), 502);
  }

  const publicBase = process.env.R2_PUBLIC_URL ? process.env.R2_PUBLIC_URL.replace(/\/$/, "") : "";
  const url = `${publicBase}/${key}`;

  logger.info("R2 upload success", { key });
  return { url, key };
}

async function deleteObject(key) {
  if (!isR2Configured() || !key) return;
  const client = getR2Client();
  try {
    await client.send(new DeleteObjectCommand({ Bucket: process.env.R2_BUCKET_NAME, Key: key }));
    logger.info("R2 object deleted", { key });
  } catch (err) {
    logger.warn("R2 delete failed", { key, message: err.message });
  }
}

async function testConnection() {
  if (!isR2Configured()) {
    return { success: false, message: "R2 belum dikonfigurasi (ENV kosong)." };
  }
  try {
    const client = getR2Client();
    await client.send(new HeadBucketCommand({ Bucket: process.env.R2_BUCKET_NAME }));
    return { success: true, message: "Berhasil terhubung ke bucket R2." };
  } catch (err) {
    return { success: false, message: "Gagal terhubung ke R2. Periksa kredensial dan nama bucket." };
  }
}

module.exports = { uploadBuffer, deleteObject, testConnection };
