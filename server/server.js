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

const app = express();
const httpServer = http.createServer(app);

// ---- CORS: only allow known frontend origins (Marketplace + Admin Web) ----
const allowedOrigins = [process.env.CLIENT_URL, process.env.ADMIN_URL, ...(process.env.EXTRA_CORS_ORIGINS || "").split(",")]
  .map((o) => o && o.trim())
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

app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(cors(corsOptions));
app.use(compression());
app.use(cookieParser());
app.use(express.json({ limit: "2mb" }));
app.use(express.urlencoded({ extended: true }));
app.use(morgan(process.env.NODE_ENV === "production" ? "combined" : "dev"));

// ---- API routes ----
app.use("/api", publicApiLimiter, apiRouter);

// ---- Static frontend (Marketplace + Admin Web + Cek Pesanan) ----
// Keeps the existing HTML/CSS/JS structure; only the JS behind it is now real.
const rootDir = path.join(__dirname, "..");
app.use(express.static(rootDir, { extensions: ["html"] }));
app.get("/admin/login", (req, res) => res.sendFile(path.join(rootDir, "admin", "login.html")));
app.get("/admin", (req, res) => res.sendFile(path.join(rootDir, "admin", "index.html")));
app.get(["/cek-pesanan", "/cek-pesanan/*"], (req, res) => res.sendFile(path.join(rootDir, "cek-pesanan", "index.html")));

app.use(notFoundHandler);
app.use(errorHandler);

const PORT = process.env.PORT || 4000;

async function start() {
  try {
    await connectDB();
    initSocket(httpServer, allowedOrigins.length ? allowedOrigins : "*");

    httpServer.listen(PORT, () => {
      logger.info(`Server started`, { port: PORT, env: process.env.NODE_ENV || "development" });
    });
  } catch (err) {
    logger.error("Failed to start server", { message: err.message });
    process.exit(1);
  }
}

process.on("unhandledRejection", (reason) => {
  logger.error("Unhandled promise rejection", { message: reason?.message || String(reason) });
});

start();

module.exports = { app, httpServer };
