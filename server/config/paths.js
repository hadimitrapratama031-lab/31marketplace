const fs = require("fs");
const path = require("path");

// Direktori /server itu sendiri (file ini ada di /server/config).
const SERVER_DIR = path.join(__dirname, "..");

// Penanda bahwa sebuah folder benar-benar berisi frontend Marketplace,
// bukan sekadar folder acak yang kebetulan ada. Tanpa cek ini, express.static
// bisa "berhasil" mount ke folder kosong dan semua halaman jadi 404 diam-diam.
const MARKERS = ["index.html", path.join("admin", "index.html"), path.join("assets", "css", "style.css")];

function isFrontendDir(dir) {
  if (!dir) return false;
  try {
    if (!fs.statSync(dir).isDirectory()) return false;
  } catch {
    return false;
  }
  return MARKERS.every((marker) => fs.existsSync(path.join(dir, marker)));
}

/**
 * Urutan pencarian, dari yang paling spesifik:
 *  1. FRONTEND_DIR dari environment (absolut atau relatif terhadap /server)
 *  2. /server/public        -> kalau frontend dipindah ke dalam /server
 *  3. repo root (../)       -> struktur saat ini (Root Directory Railway kosong)
 *  4. ../public
 *  5. process.cwd()         -> start command dijalankan dari root repo
 */
function candidateDirs() {
  const fromEnv = process.env.FRONTEND_DIR
    ? path.isAbsolute(process.env.FRONTEND_DIR)
      ? process.env.FRONTEND_DIR
      : path.resolve(SERVER_DIR, process.env.FRONTEND_DIR)
    : null;

  return [
    fromEnv,
    path.join(SERVER_DIR, "public"),
    path.join(SERVER_DIR, ".."),
    path.join(SERVER_DIR, "..", "public"),
    process.cwd(),
    path.join(process.cwd(), "public"),
  ].filter(Boolean);
}

function resolveFrontendDir() {
  const tried = [];
  for (const dir of candidateDirs()) {
    const resolved = path.resolve(dir);
    if (tried.includes(resolved)) continue;
    tried.push(resolved);
    if (isFrontendDir(resolved)) {
      return { frontendDir: resolved, tried };
    }
  }
  return { frontendDir: null, tried };
}

module.exports = { SERVER_DIR, resolveFrontendDir, isFrontendDir, MARKERS };
