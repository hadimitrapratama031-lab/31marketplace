/* Test routing dengan konfigurasi produksi (NODE_ENV=production), tanpa DB. */
process.env.NODE_ENV = "production";
process.env.MONGODB_URI = process.env.MONGODB_URI || "mongodb://127.0.0.1:27017/test";
process.env.JWT_SECRET = process.env.JWT_SECRET || "x".repeat(32);
process.env.SESSION_SECRET = process.env.SESSION_SECRET || "x".repeat(32);
process.env.ENCRYPTION_SECRET = process.env.ENCRYPTION_SECRET || "x".repeat(32);
process.env.CLIENT_URL = process.env.CLIENT_URL || "https://www.31store.site";
process.env.ADMIN_URL = process.env.ADMIN_URL || "https://www.31store.site";

const request = require("supertest");
const { app } = require("../server");

const cases = [
  ["GET", "/", [200], "text/html"],
  ["GET", "/admin", [301]],
  ["GET", "/admin/", [200], "text/html"],
  ["GET", "/admin/login", [200], "text/html"],
  ["GET", "/admin/admin.css", [200], "text/css"],
  ["GET", "/admin/admin.js", [200], "javascript"],
  ["GET", "/admin/login.js", [200], "javascript"],
  ["GET", "/product", [200], "text/html"],
  ["GET", "/cek-pesanan", [301]],
  ["GET", "/cek-pesanan/", [200], "text/html"],
  ["GET", "/rating", [301]],
  ["GET", "/rating/", [200], "text/html"],
  ["GET", "/assets/css/style.css", [200], "text/css"],
  ["GET", "/assets/css/product.css", [200], "text/css"],
  ["GET", "/assets/js/common.js", [200], "javascript"],
  ["GET", "/assets/js/app.js", [200], "javascript"],
  ["GET", "/css/style.css", [200], "text/css"],
  ["GET", "/js/app.js", [200], "javascript"],
  // API harus tetap API: 200/401/500 boleh, yang penting BUKAN HTML & bukan 404 route.
  ["GET", "/api/settings", [200, 401, 500, 503]],
  ["GET", "/api/health", [200, 500, 503]],
  ["GET", "/api/products", [200, 401, 500, 503]],
  ["GET", "/api/tidak-ada-endpoint-ini", [404], "application/json"],
  ["GET", "/halaman-tidak-ada", [404]],
];

(async () => {
  let failed = 0;
  for (const [method, url, expected, contains] of cases) {
    const res = await request(app)[method.toLowerCase()](url);
    const type = res.headers["content-type"] || "";
    const statusOk = expected.includes(res.status);
    const typeOk = !contains || type.includes(contains);
    const ok = statusOk && typeOk;
    if (!ok) failed += 1;
    console.log(
      `${ok ? "PASS" : "FAIL"}  ${method} ${url.padEnd(32)} -> ${res.status} ${type.split(";")[0] || "-"}` +
        (res.headers.location ? `  location=${res.headers.location}` : "")
    );
  }
  console.log(failed === 0 ? "\nSemua route lulus." : `\n${failed} route gagal.`);
  process.exit(failed === 0 ? 0 : 1);
})();
