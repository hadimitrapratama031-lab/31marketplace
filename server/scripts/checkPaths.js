/**
 * Diagnostik path deployment.
 * Jalankan di lokal:   npm run check:paths
 * Jalankan di Railway: buka shell service lalu `node server/scripts/checkPaths.js`
 *
 * Script ini TIDAK menyentuh database dan tidak menjalankan server — aman
 * dipakai untuk memastikan file frontend benar-benar ikut ter-deploy.
 */
const fs = require("fs");
const path = require("path");
const { resolveFrontendDir, MARKERS } = require("../config/paths");

const PAGES = [
  ["/", "index.html"],
  ["/product", "product.html"],
  ["/admin/", path.join("admin", "index.html")],
  ["/admin/login", path.join("admin", "login.html")],
  ["/cek-pesanan/", path.join("cek-pesanan", "index.html")],
  ["/rating/", path.join("rating", "index.html")],
];

const ASSETS = [
  ["/assets/css/style.css", path.join("assets", "css", "style.css")],
  ["/assets/css/product.css", path.join("assets", "css", "product.css")],
  ["/assets/js/common.js", path.join("assets", "js", "common.js")],
  ["/assets/js/app.js", path.join("assets", "js", "app.js")],
  ["/assets/js/product.js", path.join("assets", "js", "product.js")],
  ["/admin/admin.css", path.join("admin", "admin.css")],
  ["/admin/admin.js", path.join("admin", "admin.js")],
  ["/admin/login.js", path.join("admin", "login.js")],
];

const { frontendDir, tried } = resolveFrontendDir();

console.log("cwd        :", process.cwd());
console.log("__dirname  :", __dirname);
console.log("NODE_ENV   :", process.env.NODE_ENV || "(unset)");
console.log("FRONTEND_DIR env:", process.env.FRONTEND_DIR || "(unset)");
console.log("\nKandidat yang dicek:");
tried.forEach((dir) => console.log("  -", dir, fs.existsSync(dir) ? "(ada)" : "(tidak ada)"));

if (!frontendDir) {
  console.log("\n[GAGAL] Folder frontend tidak ditemukan.");
  console.log("Folder frontend harus berisi:", MARKERS.join(", "));
  console.log("Penyebab paling umum: Railway Root Directory diset ke /server,");
  console.log("sehingga index.html, /admin dan /assets di root repo tidak ikut ter-deploy.");
  process.exit(1);
}

console.log("\n[OK] frontendDir =", frontendDir, "\n");

let missing = 0;
const report = (label, rel) => {
  const full = path.join(frontendDir, rel);
  const ok = fs.existsSync(full);
  if (!ok) missing += 1;
  console.log(`${ok ? "OK  " : "MISS"}  ${label.padEnd(26)} -> ${full}`);
};

console.log("Halaman:");
PAGES.forEach(([url, rel]) => report(url, rel));
console.log("\nAsset:");
ASSETS.forEach(([url, rel]) => report(url, rel));

console.log(missing === 0 ? "\nSemua file frontend ditemukan." : `\n${missing} file tidak ditemukan.`);
process.exit(missing === 0 ? 0 : 1);
