require("dotenv").config();

const path = require("path");
const http = require("http");
const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const compression = require("compression");
const cookieParser = require("cookie-parser");
const morgan = require("morgan");

const { connectDB } = require("./config/db");
const { initSocket } = require("./services/socket.service");
const { notFoundHandler, errorHandler } = require("./middlewares/errorHandler");
const { publicApiLimiter } = require("./middlewares/rateLimit");
const logger = require("./utils/logger");
const apiRouter = require("./routes");
const { resolveFrontendDir } = require("./config/paths");
const { startExpirySweeper } = require("./controllers/payment.controller");

const app = express();
const httpServer = http.createServer(app);

// Railway (dan PaaS lain) menaruh app di belakang reverse proxy. Tanpa ini,
// express-rate-limit membaca IP proxy untuk semua orang dan req.protocol
// selalu "http" walau domainnya HTTPS.
app.set("trust proxy", 1);

// ---- CORS: only allow known frontend origins (Marketplace + Admin Web) ----
// A browser's `Origin` header is always just `scheme://host:port` — never a
// path and never a trailing slash. Env vars are frequently pasted with one of
// those (e.g. ADMIN_URL=https://host/admin), which would silently break the
// exact-match check below, so normalize down to just the origin here.
function toOrigin(value) {
  if (!value) return null;
  try {
    return new URL(value.trim()).origin;
  } catch {
    return null;
  }
}

const allowedOrigins = [process.env.CLIENT_URL, process.env.ADMIN_URL, ...(process.env.EXTRA_CORS_ORIGINS || "").split(",")]
  .map(toOrigin)
  .filter(Boolean);

const corsOptions = {
  origin(origin, callback) {
    // Allow same-origin/non-browser requests (no Origin header) and the static
    // frontend when served from this same Express app.
    if (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) {
      return callback(null, true);
    }
    logger.warn("Blocked CORS origin", { origin });
    callback(new Error("Not allowed by CORS"));
  },
  credentials: true,
};

app.use(
  helmet({
    crossOriginResourcePolicy: false,
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'self'"],
        // Product photos & QRIS images are hosted externally (Cloudflare R2 /
        // KlikQRIS), not on this domain — default 'self' data: would block them.
        // "blob:" is required too: Admin Web previews a picked file with
        // URL.createObjectURL() before it's ever uploaded, which produces a
        // blob: URL, not an https: one — without this the browser blocks the
        // preview image itself (upload still succeeds, only the preview fails).
        imgSrc: ["'self'", "data:", "blob:", "https:"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", "https:", "'unsafe-inline'"],
        fontSrc: ["'self'", "https:", "data:"],
        connectSrc: ["'self'", "ws:", "wss:"],
      },
    },
  })
);
app.use(cors(corsOptions));
app.use(compression());
app.use(cookieParser());
// `verify` menyimpan body mentah di req.rawBody SEBELUM di-parse jadi objek.
// Webhook Resend menandatangani byte mentah persis seperti yang dikirim
// (format Svix) — memverifikasi ulang JSON.stringify(req.body) tidak pernah
// cocok karena urutan key/whitespace bisa berubah. Tidak memengaruhi route
// lain: req.body tetap objek biasa seperti sebelumnya.
app.use(
  express.json({
    limit: "2mb",
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  })
);
app.use(express.urlencoded({ extended: true }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// =====================================================================
// URUTAN ROUTE (jangan diubah): API -> 404 API -> asset -> halaman -> 404
// Dengan urutan ini "/api/*" tidak pernah jatuh ke frontend, dan route
// frontend tidak pernah menelan request API.
// =====================================================================

// ---- 1. API routes ----
app.use("/api", publicApiLimiter, apiRouter);

// 404 khusus API: endpoint /api yang tidak ada harus tetap balas JSON dan
// berhenti di sini, tidak boleh lanjut ke express.static / halaman HTML.
app.all("/api/*", (req, res) => {
  res.status(404).json({ status: false, message: `API endpoint not found: ${req.method} ${req.originalUrl}` });
});

// ---- 2. Lokasi frontend ----
// Root Directory Railway menentukan folder mana yang ikut ter-deploy. Kalau
// Root Directory = /server, maka index.html, /admin dan /assets yang ada di
// repo root TIDAK ikut ter-upload, sehingga path "__dirname/.." menunjuk ke
// folder kosong dan semua halaman jadi "Route not found". Resolver ini
// mencari lokasi frontend yang benar-benar ada dan berteriak di log kalau
// tidak ketemu, bukan diam-diam 404.
const { frontendDir, tried } = resolveFrontendDir();

if (frontendDir) {
  logger.info("Frontend directory resolved", { frontendDir });
} else {
  logger.error(
    "Frontend directory NOT FOUND — halaman Marketplace/Admin tidak bisa diserve. " +
      "Pastikan Root Directory Railway dikosongkan (deploy dari root repo) atau set FRONTEND_DIR.",
    { tried }
  );
}

const ADMIN_DIR = frontendDir ? path.join(frontendDir, "admin") : null;
const ASSETS_DIR = frontendDir ? path.join(frontendDir, "assets") : null;

const staticOptions = {
  index: false,
  redirect: false,
  extensions: ["html"],
  maxAge: process.env.NODE_ENV === "production" ? "1h" : 0,
};
const assetOptions = {
  index: false,
  redirect: false,
  maxAge: process.env.NODE_ENV === "production" ? "7d" : 0,
};

// Kirim satu file halaman. Kalau frontend tidak ter-deploy, balas pesan yang
// menjelaskan sebabnya — bukan "Route not found" yang menyesatkan.
function sendPage(res, next, ...segments) {
  if (!frontendDir) {
    return res
      .status(500)
      .type("text/plain")
      .send(
        "Frontend files tidak ditemukan di server.\n" +
          "Penyebab paling umum: Railway Root Directory diset ke /server, sehingga folder\n" +
          "index.html, /admin dan /assets di root repo tidak ikut ter-deploy.\n" +
          "Perbaikan: kosongkan Root Directory (deploy dari root repo), atau set env FRONTEND_DIR."
      );
  }
  const file = path.join(frontendDir, ...segments);
  res.sendFile(file, (err) => {
    if (err) next(err);
  });
}

if (frontendDir) {
  // ---- 3. Asset: /assets/*, /css/*, /js/* ----
  // /css dan /js disediakan sebagai alias agar path absolut gaya
  // "/css/style.css" atau "/js/app.js" tetap termuat, selain path relatif
  // "assets/css/style.css" yang dipakai file HTML saat ini.
  app.use("/assets", express.static(ASSETS_DIR, assetOptions));
  app.use("/css", express.static(path.join(ASSETS_DIR, "css"), assetOptions));
  app.use("/js", express.static(path.join(ASSETS_DIR, "js"), assetOptions));

  // Asset Admin Web (admin.css, admin.js, login.js) — harus dimount sebelum
  // route halaman /admin agar CSS/JS-nya tidak ditelan handler HTML.
  app.use("/admin", express.static(ADMIN_DIR, assetOptions));

  // Bug lama: "/rating/*" dan "/cek-pesanan/*" di bawah adalah catch-all yang
  // SELALU membalas index.html halaman itu, termasuk untuk request asetnya
  // sendiri (rating.js, cek-pesanan.js) — browser jadi menerima HTML dengan
  // Content-Type text/html untuk file yang diminta sebagai <script src>, lalu
  // ditolak browser karena MIME mismatch (Rating jadi tidak bisa memuat atau
  // mengirim apa pun). Sama seperti /admin di atas, aset folder ini harus
  // dimount sebagai static SEBELUM route halamannya supaya rating.js dan
  // cek-pesanan.js benar-benar dilayani sebagai file JS, bukan ditelan HTML.
  app.use("/rating", express.static(path.join(frontendDir, "rating"), assetOptions));
  app.use("/cek-pesanan", express.static(path.join(frontendDir, "cek-pesanan"), assetOptions));
}

// ---- 4. Halaman frontend ----

// Homepage Marketplace
app.get("/", (req, res, next) => sendPage(res, next, "index.html"));

// Admin Web. Bare "/admin" di-redirect ke "/admin/" supaya path relatif
// admin.css / admin.js di dalam admin/index.html resolve ke /admin/admin.css,
// bukan ke /admin.css di root (inilah penyebab /admin tampil polos tanpa CSS).
app.get(["/admin/login", "/admin/login.html"], (req, res, next) => sendPage(res, next, "admin", "login.html"));
app.get(["/admin", "/admin/"], (req, res, next) => {
  // Express non-strict routing menganggap "/admin" dan "/admin/" sama, jadi
  // pembedaannya harus lewat req.path — kalau tidak, redirect-nya jadi loop.
  if (req.path === "/admin") return res.redirect(301, "/admin/");
  return sendPage(res, next, "admin", "index.html");
});

// Katalog produk (daftar). Didaftarkan eksplisit supaya "/products" tidak
// bergantung pada opsi `extensions` di express.static.
app.get(["/products", "/products.html"], (req, res, next) => sendPage(res, next, "products.html"));

// Halaman detail produk
app.get(["/product", "/product.html"], (req, res, next) => sendPage(res, next, "product.html"));

// Alur pembayaran: Checkout -> Payment (QRIS) -> Order Success
app.get(["/checkout", "/checkout.html"], (req, res, next) => sendPage(res, next, "checkout.html"));
app.get(["/payment", "/payment.html"], (req, res, next) => sendPage(res, next, "payment.html"));
app.get(["/order-success", "/order-success.html"], (req, res, next) => sendPage(res, next, "order-success.html"));

// Cek Pesanan
app.get(["/cek-pesanan", "/cek-pesanan/", "/cek-pesanan/*"], (req, res, next) => {
  if (req.path === "/cek-pesanan") return res.redirect(301, "/cek-pesanan/");
  return sendPage(res, next, "cek-pesanan", "index.html");
});

// Rating
app.get(["/rating", "/rating/", "/rating/*"], (req, res, next) => {
  if (req.path === "/rating") return res.redirect(301, "/rating/");
  return sendPage(res, next, "rating", "index.html");
});

// ---- 5. Sisa file statis (favicon, gambar, file lain di root repo) ----
// Diletakkan PALING AKHIR sebelum 404 supaya tidak pernah menyalip /api.
if (frontendDir) {
  app.use(express.static(frontendDir, staticOptions));
}

app.use(notFoundHandler);
app.use(errorHandler);

const PORT = process.env.PORT || 4000;
// Bind explicitly to 0.0.0.0 — required by most container platforms (Railway
// included) so the platform's proxy can reach the process. Binding with no
// host can default to IPv6-only on some environments and never get hit.
const HOST = "0.0.0.0";

// Fail fast with a clear, named reason instead of a generic crash — makes
// misconfigured environment variables obvious in the deploy logs.
function checkRequiredEnv() {
  const required = ["MONGODB_URI", "JWT_SECRET", "SESSION_SECRET", "ENCRYPTION_SECRET"];
  const missing = required.filter((key) => !process.env[key]);
  if (missing.length) {
    throw new Error(`Missing required environment variable(s): ${missing.join(", ")}`);
  }
}

async function start() {
  try {
    checkRequiredEnv();
    await connectDB();
    initSocket(httpServer, allowedOrigins.length ? allowedOrigins : "*");

    // Menutup transaksi yang lewat batas waktu, supaya notifikasi
    // PAYMENT_EXPIRED tetap terkirim walau gateway tidak mengirim webhook
    // EXPIRED dan pembeli tidak pernah membuka lagi halaman pembayaran.
    startExpirySweeper();

    httpServer.listen(PORT, HOST, () => {
      logger.info(`Server started`, { port: PORT, host: HOST, env: process.env.NODE_ENV || "development" });
    });
  } catch (err) {
    logger.error("Failed to start server", { message: err.message });
    process.exit(1);
  }
}

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", { message: reason?.message || String(reason) });
});

// Dijalankan sebagai entrypoint -> start server. Kalau di-require (test /
// tooling), cukup ekspor app tanpa connect DB & listen.
if (require.main === module) {
  start();
}

module.exports = { app, httpServer };
