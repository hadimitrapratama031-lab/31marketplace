const axios = require("axios");
const { getResendConfig } = require("./integration.service");
const { isValidEmail } = require("../utils/phone");
const { isFreemailAddress } = require("../utils/email");
const logger = require("../utils/logger");

// Resend API: POST https://api.resend.com/emails
// Header: Authorization: Bearer <api_key>
//
// Bentuk hasil sama seperti fonnte.service.js:
//   { success, permanent, message, response, httpStatus }

const TIMEOUT_MS = 20000;

function classifyTransportError(err) {
  const httpStatus = err.response && err.response.status;
  const code = err.code || "";
  const providerMessage = err.response && err.response.data && (err.response.data.message || err.response.data.name);

  if (["ECONNABORTED", "ETIMEDOUT", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED"].includes(code)) {
    return { permanent: false, message: `Resend tidak dapat dihubungi (${code}).`, httpStatus: null };
  }
  if (!httpStatus) {
    return { permanent: false, message: `Resend tidak dapat dihubungi: ${err.message}`, httpStatus: null };
  }
  if (httpStatus >= 500) {
    return { permanent: false, message: `Resend mengembalikan error server (HTTP ${httpStatus}).`, httpStatus };
  }
  // 429 = rate limit, murni soal waktu — layak dicoba lagi.
  if (httpStatus === 429) {
    return { permanent: false, message: "Resend membatasi jumlah permintaan (HTTP 429).", httpStatus };
  }
  if (httpStatus === 401 || httpStatus === 403) {
    return { permanent: true, message: `API key Resend ditolak (HTTP ${httpStatus}). Periksa API key di Admin Web.`, httpStatus };
  }
  // 422 biasanya domain pengirim belum diverifikasi atau alamat tujuan
  // ditolak — mengulang tidak mengubah apa pun sampai admin memperbaikinya.
  return {
    permanent: true,
    message: providerMessage ? `Resend menolak permintaan: ${providerMessage}` : `Resend menolak permintaan (HTTP ${httpStatus}).`,
    httpStatus,
  };
}

// Pengirim level bawah: hanya butuh apiKey/fromEmail. Toggle Enabled diurus
// sendEmail() di bawah, supaya tombol Test Email tetap bisa dipakai lebih dulu.
async function sendEmailRaw({ apiKey, fromEmail, fromName, replyTo, to, subject, html, text, entityRef }) {
  // Validasi sebelum menyentuh jaringan — recipient kosong tidak boleh
  // membuat server melempar exception (spec 25).
  if (!apiKey) return { success: false, permanent: true, message: "API key Resend belum dikonfigurasi." };
  if (!fromEmail || !isValidEmail(fromEmail)) {
    return { success: false, permanent: true, message: `Alamat pengirim Resend tidak valid: ${fromEmail || "(kosong)"}` };
  }
  if (isFreemailAddress(fromEmail)) {
    return {
      success: false,
      permanent: true,
      message: `Alamat pengirim "${fromEmail}" memakai domain email gratisan dan tidak bisa diautentikasi (SPF/DKIM/DMARC) atas nama domain toko. Gunakan alamat di domain toko yang sudah diverifikasi di Resend, mis. noreply@namatoko.com.`,
    };
  }
  if (!isValidEmail(to)) {
    return { success: false, permanent: true, message: `Alamat email tujuan tidak valid: ${to || "(kosong)"}` };
  }
  if (!subject || !String(subject).trim()) return { success: false, permanent: true, message: "Subject email kosong." };
  if (!html || !String(html).trim()) return { success: false, permanent: true, message: "Isi email kosong." };

  try {
    const response = await axios.post(
      "https://api.resend.com/emails",
      {
        from: `${fromName || "Store"} <${fromEmail}>`,
        to: [to],
        // Reply-To yang benar-benar dibaca manusia adalah salah satu sinyal
        // "pengirim sah" yang dinilai Gmail, dan tanpanya balasan pelanggan
        // jatuh ke alamat noreply yang tidak dipantau siapa pun. Kalau admin
        // belum mengisinya, header ini tidak dikirim sama sekali — lebih baik
        // tidak ada daripada menunjuk ke alamat yang tidak dibaca.
        ...(replyTo && isValidEmail(replyTo) ? { reply_to: replyTo } : {}),
        subject,
        html,
        // text/plain wajib disertakan (multipart/alternative) — HTML tanpa
        // padanan plain-text adalah salah satu sinyal spam paling umum di
        // Gmail (spec 8). Kalau pemanggil belum mengirim `text` (mis. kode
        // lama yang belum diperbarui), turunkan versi minimal dari HTML
        // apa adanya supaya bagian ini tidak pernah kosong.
        text: text && String(text).trim() ? text : String(html).replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(),
        // Header identitas per-order. Gmail memakai kemiripan isi untuk
        // mengelompokkan (dan kadang menyembunyikan) pesan beruntun dari
        // pengirim yang sama; referensi unik per order membuat tiap email
        // transaksional berdiri sendiri, bukan terlihat sebagai pengiriman
        // massal berulang. Tidak mengubah apa pun yang dilihat pelanggan.
        ...(entityRef ? { headers: { "X-Entity-Ref-ID": String(entityRef) } } : {}),
      },
      {
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        timeout: TIMEOUT_MS,
      }
    );

    // Resend menandai email diterima dengan mengembalikan id. Tanpa id,
    // 200 saja tidak membuktikan email masuk antrean pengiriman.
    const id = response.data && response.data.id;
    if (!id) {
      logger.warn("Resend returned 200 without message id", { to });
      return {
        success: false,
        permanent: false,
        message: "Resend membalas tanpa id pesan — email tidak masuk antrean.",
        response: response.data,
        httpStatus: response.status,
      };
    }

    logger.info("Resend email accepted", { to, id });
    return { success: true, permanent: false, message: "", response: response.data, httpStatus: response.status };
  } catch (err) {
    const classified = classifyTransportError(err);
    logger.error("Resend send failed", { to, httpStatus: classified.httpStatus, reason: classified.message });
    return { success: false, ...classified };
  }
}

// Dipakai untuk notifikasi order sungguhan — menghormati toggle Enabled.
async function sendEmail({ to, subject, html, text, entityRef }) {
  const cfg = await getResendConfig();
  if (!cfg.enabled) {
    return { success: false, permanent: true, disabled: true, message: "Resend belum diaktifkan/dikonfigurasi." };
  }
  return sendEmailRaw({
    apiKey: cfg.apiKey,
    fromEmail: cfg.fromEmail,
    fromName: cfg.fromName,
    replyTo: cfg.replyTo,
    to,
    subject,
    html,
    text,
    entityRef,
  });
}

// Dipakai tombol "Test Email".
async function testConnection(testTo) {
  const cfg = await getResendConfig();
  if (!cfg.apiKey || !cfg.fromEmail) {
    return { success: false, message: "API key / From email belum diisi." };
  }
  if (!testTo || !isValidEmail(testTo)) {
    return { success: false, message: "Email tujuan test tidak valid." };
  }
  const result = await sendEmailRaw({
    apiKey: cfg.apiKey,
    fromEmail: cfg.fromEmail,
    fromName: cfg.fromName,
    to: testTo,
    subject: "Test koneksi Resend",
    html: "<p>Test koneksi Resend dari Admin Web berhasil.</p>",
    text: "Test koneksi Resend dari Admin Web berhasil.",
  });
  return result.success
    ? { success: true, message: "Email test berhasil dikirim." }
    : { success: false, message: result.message || "Gagal mengirim email test." };
}

/**
 * Mengambil status verifikasi domain langsung dari Resend (GET /domains),
 * bukan dengan mengarang record DNS (spec 9). Dipakai Admin Web untuk
 * menampilkan status SPF/DKIM/DMARC yang SEBENARNYA terpasang di Resend
 * untuk domain pengirim yang sedang dipakai, supaya "kenapa masuk Spam?"
 * bisa dijawab dari data, bukan dugaan.
 */
async function getDomainStatus() {
  const cfg = await getResendConfig();
  if (!cfg.apiKey) {
    return { success: false, message: "API key Resend belum dikonfigurasi.", domains: [] };
  }
  try {
    const response = await axios.get("https://api.resend.com/domains", {
      headers: { Authorization: `Bearer ${cfg.apiKey}` },
      timeout: TIMEOUT_MS,
    });
    const list = (response.data && response.data.data) || [];
    const fromDomain = String(cfg.fromEmail || "").split("@")[1] || "";

    // Detail per-record (SPF/DKIM/DMARC) hanya tersedia lewat GET /domains/:id.
    const detailed = await Promise.all(
      list.map(async (d) => {
        try {
          const detail = await axios.get(`https://api.resend.com/domains/${d.id}`, {
            headers: { Authorization: `Bearer ${cfg.apiKey}` },
            timeout: TIMEOUT_MS,
          });
          return detail.data;
        } catch {
          return d; // tetap tampilkan ringkasan kalau detail gagal diambil
        }
      })
    );

    return {
      success: true,
      fromEmail: cfg.fromEmail,
      fromDomain,
      domains: detailed.map((d) => ({
        id: d.id,
        name: d.name,
        status: d.status, // "verified" | "pending" | "failed" | ...
        region: d.region,
        isSendingDomain: d.name === fromDomain,
        records: (d.records || []).map((r) => ({
          record: r.record, // "SPF" | "DKIM" | "DMARC"
          type: r.type,
          name: r.name,
          value: r.value,
          status: r.status,
          priority: r.priority,
        })),
      })),
    };
  } catch (err) {
    const classified = classifyTransportError(err);
    logger.error("Resend get domain status failed", { httpStatus: classified.httpStatus, reason: classified.message });
    return { success: false, message: classified.message, domains: [] };
  }
}

module.exports = { sendEmail, sendEmailRaw, testConnection, getDomainStatus };
