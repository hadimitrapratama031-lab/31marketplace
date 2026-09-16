/* 31 Store — shared frontend helpers (real API + Socket.IO, no dummy data). */
(function (window) {
  "use strict";

  const API_BASE = "/api";

  async function request(path, options = {}) {
    const isForm = options.body instanceof FormData;
    const res = await fetch(API_BASE + path, {
      method: options.method || "GET",
      headers: isForm ? undefined : { "Content-Type": "application/json", ...(options.headers || {}) },
      body: options.body,
      credentials: "same-origin",
    });

    let payload = null;
    try {
      payload = await res.json();
    } catch (e) {
      payload = null;
    }

    if (!res.ok || (payload && payload.status === false)) {
      const message = (payload && payload.message) || `Terjadi kesalahan (${res.status}).`;
      const err = new Error(message);
      err.status = res.status;
      err.payload = payload;
      throw err;
    }
    return payload;
  }

  function formatIDR(value) {
    const n = Number(value) || 0;
    return "Rp " + n.toLocaleString("id-ID");
  }

  function formatDate(value) {
    if (!value) return "-";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "-";
    return d.toLocaleString("id-ID", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function escapeHTML(str) {
    return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // ---- Socket.IO (served by the same Express/Socket.IO server, no CDN needed) ----
  let socket = null;
  function getSocket() {
    if (socket) return socket;
    if (typeof window.io !== "function") {
      console.warn("Socket.IO client not loaded — realtime updates disabled.");
      return null;
    }
    socket = window.io({ transports: ["websocket", "polling"], reconnection: true, reconnectionDelay: 1500 });
    socket.on("connect_error", (err) => console.warn("Socket connect_error:", err.message));
    return socket;
  }

  // Debounced "refresh everything relevant" helper so bursts of Socket.IO
  // events (e.g. several settings sections saved at once) only trigger one refetch.
  function debounce(fn, delay) {
    let t = null;
    return (...args) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...args), delay);
    };
  }

  const STATUS_LABEL = {
    PENDING: "Menunggu Pembayaran",
    PAID: "Pembayaran Berhasil",
    SUCCESS: "Pembayaran Berhasil",
    FAILED: "Pembayaran Gagal",
    EXPIRED: "Kedaluwarsa",
    CANCELLED: "Dibatalkan",
  };

  const STATUS_COLOR = {
    PENDING: "#b8860b",
    PAID: "#1b8a4c",
    SUCCESS: "#1b8a4c",
    FAILED: "#c0392b",
    EXPIRED: "#8a8a8a",
    CANCELLED: "#8a8a8a",
  };

  window.MP = {
    get: (path) => request(path),
    post: (path, body) => request(path, { method: "POST", body: JSON.stringify(body || {}) }),
    postForm: (path, formData) => request(path, { method: "POST", body: formData }),
    formatIDR,
    formatDate,
    escapeHTML,
    getSocket,
    debounce,
    STATUS_LABEL,
    STATUS_COLOR,
  };
})(window);
