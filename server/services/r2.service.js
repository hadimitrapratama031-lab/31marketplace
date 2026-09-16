const { PutObjectCommand, DeleteObjectCommand, HeadBucketCommand } = require("@aws-sdk/client-s3");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const { getR2Client, isR2Configured } = require("../config/r2");
const { AppError } = require("../middlewares/errorHandler");
const logger = require("../utils/logger");

// Uploads a buffer to Cloudflare R2 and returns { url, key }.
// folder e.g. "products", "logos", "avatars", "backgrounds".
async function uploadBuffer(buffer, originalName, mimeType, folder = "misc") {
  if (!isR2Configured()) {
    throw new AppError("Cloudflare R2 belum dikonfigurasi di server (ENV R2_* belum diisi).", 503);
  }
  const client = getR2Client();
  const ext = path.extname(originalName || "") || "";
  const key = `${folder}/${Date.now()}-${uuidv4()}${ext}`;

  await client.send(
    new PutObjectCommand({
      Bucket: process.env.R2_BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: mimeType,
    })
  );

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
