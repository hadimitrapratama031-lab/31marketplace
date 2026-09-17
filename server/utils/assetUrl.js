/**
 * Satu tempat untuk mengubah "apa pun yang tersimpan di MongoDB sebagai URL
 * gambar" menjadi URL absolut yang benar-benar bisa dimuat dari internet oleh
 * Gmail / Outlook / Discord.
 *
 * KENAPA FILE INI ADA
 * -------------------
 * Sebelumnya template email memakai safeRemoteUrl() yang hanya menerima URL
 * yang SUDAH berawalan "https://" dan MEMBUANG sisanya tanpa jejak apa pun.
 * Itu benar sebagai pengaman, tapi salah sebagai satu-satunya perlakuan:
 *
 *   - Kalau R2_PUBLIC_URL di Railway kosong, r2.service.uploadBuffer() tetap
 *     "berhasil" dan menyimpan "/branding/1712-uuid.png" ke MongoDB. Di Admin
 *     Web dan Marketplace path relatif itu masih tampil (browser
 *     me-resolve-nya ke domain toko), jadi kelihatan normal — tapi di email
 *     ia dibuang, dan logonya hilang tanpa error di mana pun.
 *   - Kalau R2_PUBLIC_URL ditulis tanpa skema ("pub-xxx.r2.dev"), hasilnya
 *     "pub-xxx.r2.dev/branding/x.png" — juga dibuang diam-diam.
 *   - URL lama berawalan "http://" ikut dibuang, padahal cukup di-upgrade.
 *
 * Jadi: gambar tidak "hilang karena template", gambar hilang karena URL yang
 * masuk ke template memang bukan URL publik absolut. File ini memperbaiki
 * SUMBER URL-nya, bukan templatenya.
 *
 * Tidak pernah mengarang aset: kalau nilainya kosong, ia tetap kosong.
 */

const logger = require("./logger");

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "0.0.0.0", "::1", "[::1]"]);

// Ekstensi yang TIDAK pernah dirender sebagai <img> oleh Gmail/Outlook.
// SVG khususnya: Admin Web mengizinkannya saat upload dan tampil sempurna di
// browser, sehingga admin wajar mengira logonya "sudah benar" — padahal di
// Gmail ia selalu jadi kotak kosong. Ini penyebab paling sering logo
// WhatsApp/Discord tidak tampil di email padahal tampil di web.
const EMAIL_UNSUPPORTED_EXT = new Set([".svg", ".ico", ".avif", ".tiff", ".tif", ".heic", ".heif"]);

function publicBase() {
  const base = process.env.R2_PUBLIC_URL || process.env.SERVER_PUBLIC_URL || process.env.CLIENT_URL || "";
  return String(base).trim().replace(/\/+$/, "");
}

function withScheme(value) {
  if (/^https?:\/\//i.test(value)) return value;
  if (value.startsWith("//")) return `https:${value}`;
  return `https://${value}`;
}

function extensionOf(url) {
  try {
    const pathname = new URL(url).pathname;
    const dot = pathname.lastIndexOf(".");
    return dot === -1 ? "" : pathname.slice(dot).toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Mengembalikan hasil lengkap, termasuk ALASAN kalau gagal — supaya
 * pemanggilnya bisa mencatat log yang bisa ditindaklanjuti, bukan sekadar
 * menerima string kosong.
 *
 * @returns {{ ok: boolean, url: string, original: string, reason: string, changed: boolean }}
 */
function inspectAssetUrl(value) {
  const original = value === undefined || value === null ? "" : String(value).trim();
  const fail = (reason) => ({ ok: false, url: "", original, reason, changed: false });

  if (!original) return fail("kosong");

  const lower = original.toLowerCase();
  if (lower.startsWith("data:")) return fail("data: URI — tidak bisa dimuat email client");
  if (lower.startsWith("blob:")) return fail("blob: URL — hanya hidup di browser admin, bukan URL publik");
  if (lower.startsWith("file:")) return fail("file: URL — menunjuk ke disk lokal");

  let candidate = original;
  let changed = false;

  // Path relatif ("/branding/x.png" atau "branding/x.png") = gejala
  // R2_PUBLIC_URL kosong/salah saat file diunggah. Dipasangkan ke base publik
  // supaya aset yang SUDAH dipilih admin tetap dipakai apa adanya — tidak ada
  // aset baru, tidak ada placeholder.
  const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(candidate) || candidate.startsWith("//");
  if (!hasScheme) {
    const firstSegment = candidate.split("/")[0];
    const looksLikeHost = firstSegment.includes(".") && !firstSegment.includes(" ");
    if (looksLikeHost) {
      candidate = withScheme(candidate);
      changed = true;
    } else {
      const base = publicBase();
      if (!base) {
        return fail(
          "path relatif dan R2_PUBLIC_URL belum diset — URL ini tersimpan tanpa domain, jadi tidak bisa dimuat dari internet"
        );
      }
      candidate = `${withScheme(base)}/${candidate.replace(/^\/+/, "")}`;
      changed = true;
    }
  }

  if (/^http:\/\//i.test(candidate)) {
    candidate = candidate.replace(/^http:\/\//i, "https://");
    changed = true;
  }

  let parsed;
  try {
    parsed = new URL(candidate);
  } catch {
    return fail("bukan URL yang valid");
  }

  if (parsed.protocol !== "https:") return fail(`skema ${parsed.protocol} tidak didukung`);

  const host = parsed.hostname.toLowerCase();
  if (LOCAL_HOSTS.has(host) || host.endsWith(".local") || host.endsWith(".internal")) {
    return fail(`host lokal (${host}) — tidak bisa diakses dari internet`);
  }

  return { ok: true, url: parsed.toString(), original, reason: "", changed: changed || parsed.toString() !== original };
}

/**
 * Bentuk ringkas untuk dipakai di dalam template: string URL, atau "" kalau
 * memang tidak bisa dipakai. Kegagalan dicatat ke log dengan label yang
 * menyebut aset mana yang bermasalah, jadi "logo tidak tampil" punya jejak
 * yang bisa dibaca di Railway logs.
 */
function resolveAssetUrl(value, label) {
  const result = inspectAssetUrl(value);
  if (!result.ok) {
    if (result.original) {
      logger.warn("[Asset] URL gambar dibuang dari notifikasi", {
        asset: label || "(tanpa label)",
        stored: result.original,
        reason: result.reason,
      });
    }
    return "";
  }
  if (result.changed) {
    logger.info("[Asset] URL gambar dinormalisasi", {
      asset: label || "(tanpa label)",
      stored: result.original,
      used: result.url,
    });
  }
  return result.url;
}

/** true kalau ekstensinya memang bisa dirender sebagai <img> oleh email client. */
function isEmailRenderable(url) {
  if (!url) return false;
  const ext = extensionOf(url);
  if (!ext) return true; // tanpa ekstensi, Content-Type yang menentukan — dicek di diagnostik
  return !EMAIL_UNSUPPORTED_EXT.has(ext);
}

module.exports = {
  inspectAssetUrl,
  resolveAssetUrl,
  isEmailRenderable,
  extensionOf,
  EMAIL_UNSUPPORTED_EXT,
  publicBase,
};
