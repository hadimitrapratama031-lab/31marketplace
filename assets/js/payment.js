/* ============================================================================
   31 Store — Payment (step 2/3).
   Same realtime source product.js's modal used to watch (payment:updated /
   order:updated over the existing Socket.IO, plus the existing
   GET /payments/:orderCode/refresh poll as a fallback) — just rendered as a
   full page instead of a modal. The frontend never decides SUCCESS/FAILED/
   EXPIRED itself; it only reflects order.paymentStatus as returned by the
   backend (which itself only changes from the KlikQRIS webhook).
   ========================================================================= */
(function () {
  "use strict";

  var $ = function (id) {
    return document.getElementById(id);
  };

  var orderCode = (new URLSearchParams(window.location.search).get("order") || "").trim().toUpperCase();
  var current = null;
  var pollTimer = null;
  var countdownTimer = null;
  var socketHandler = null;
  var redirected = false;

  /* -------------------------------------------------------------- helpers */
  function pill(status) {
    var tone = MP.STATUS_TONE[status] || "idle";
    var label = MP.STATUS_LABEL[status] || status;
    return '<span class="pill pill-' + tone + '">' + MP.escapeHTML(label) + "</span>";
  }

  function contactButtonsHTML() {
    var settings = MP.getSettings();
    var channels = MP.contactChannels(settings);
    var out = "";
    if (channels.whatsapp.href) out += '<a class="btn btn-primary" href="' + MP.escapeHTML(channels.whatsapp.href) + '" target="_blank" rel="noopener">Hubungi via WhatsApp</a>';
    if (channels.discord.href) out += '<a class="btn btn-ghost" href="' + MP.escapeHTML(channels.discord.href) + '" target="_blank" rel="noopener">Hubungi via Discord</a>';
    return out;
  }

  function stopCountdown() {
    if (countdownTimer) {
      clearInterval(countdownTimer);
      countdownTimer = null;
    }
  }

  function startCountdown(expiredAt) {
    stopCountdown();
    var el = $("pay-countdown");
    if (!el || !expiredAt) return;
    var target = new Date(expiredAt).getTime();

    var tick = function () {
      var diff = target - Date.now();
      if (diff <= 0) {
        el.textContent = "Menunggu konfirmasi kedaluwarsa…";
        stopCountdown();
        return;
      }
      var m = Math.floor(diff / 60000);
      var s = Math.floor((diff % 60000) / 1000);
      el.textContent = "Kedaluwarsa dalam " + String(m).padStart(2, "0") + ":" + String(s).padStart(2, "0");
    };
    tick();
    countdownTimer = setInterval(tick, 1000);
  }

  /* --------------------------------------------------------------- render */
  function renderSide(order) {
    var rows = [
      ["Order ID", MP.escapeHTML(order.orderCode)],
      ["Produk", MP.escapeHTML(order.product.name)],
    ];
    if (order.product.category) rows.push(["Kategori", MP.escapeHTML(order.product.category)]);
    rows.push(["Harga satuan", MP.formatIDR(order.product.price)]);
    rows.push(["Jumlah", MP.escapeHTML(String(order.quantity))]);
    if (order.payment && order.payment.totalAmount) {
      rows.push(["Total pembayaran", MP.formatIDR(order.payment.totalAmount)]);
    } else {
      rows.push(["Total pembayaran", MP.formatIDR(order.total)]);
    }
    rows.push(["Metode pembayaran", MP.escapeHTML((order.payment && order.payment.method) || "QRIS")]);
    rows.push(["Status", pill(order.paymentStatus)]);
    rows.push(["Waktu transaksi", MP.formatDate(order.createdAt)]);
    if (order.paymentStatus === "PENDING" && order.payment && order.payment.expiredAt) {
      rows.push(["Kedaluwarsa", MP.formatDate(order.payment.expiredAt)]);
    }
    if (order.payment && order.payment.paidAt) {
      rows.push(["Waktu pembayaran", MP.formatDate(order.payment.paidAt)]);
    }

    $("pay-side-body").innerHTML = rows
      .map(function (r) {
        return '<div class="kv"><span>' + r[0] + "</span><strong>" + r[1] + "</strong></div>";
      })
      .join("");
  }

  function renderMainPending(order) {
    var payment = order.payment || {};
    $("pay-main").innerHTML =
      "<h2>Scan QRIS untuk membayar</h2>" +
      '<p class="muted-line">Buka aplikasi e-wallet atau m-banking, lalu scan kode di bawah ini.</p>' +
      (payment.expiredAt ? '<div class="pay-countdown" id="pay-countdown"></div>' : "") +
      (payment.qrisUrl
        ? '<div class="pay-qris-frame"><img src="' + MP.escapeHTML(payment.qrisUrl) + '" alt="Kode QRIS pembayaran"></div>'
        : '<p class="muted-line">Kode QRIS sedang disiapkan…</p>') +
      '<div class="pay-instructions">' +
      "<div><b>1</b><span>Buka aplikasi e-wallet, mobile banking, atau QRIS apapun.</span></div>" +
      "<div><b>2</b><span>Scan kode QRIS di atas, lalu periksa nominal sudah sesuai total.</span></div>" +
      "<div><b>3</b><span>Selesaikan pembayaran. Halaman ini akan otomatis lanjut setelah pembayaran terverifikasi.</span></div>" +
      "</div>" +
      (payment.directUrl
        ? '<a class="btn btn-ghost btn-block" href="' + MP.escapeHTML(payment.directUrl) + '" target="_blank" rel="noopener">Buka halaman pembayaran</a>'
        : "");

    startCountdown(payment.expiredAt);
  }

  function renderMainSuccess() {
    stopCountdown();
    $("pay-main").innerHTML =
      '<div class="pay-state">' +
      '<div class="pay-state-icon is-ok">✓</div>' +
      "<h2>Pembayaran terverifikasi</h2>" +
      "<p>Terima kasih! Kamu akan diarahkan ke halaman pesanan sebentar lagi.</p>" +
      "</div>";
  }

  function renderMainFailed(reasonLabel) {
    stopCountdown();
    $("pay-main").innerHTML =
      '<div class="pay-state">' +
      '<div class="pay-state-icon is-bad">✕</div>' +
      "<h2>" + MP.escapeHTML(reasonLabel) + "</h2>" +
      "<p>Kalau kamu sudah membayar tapi status belum berubah, hubungi admin agar bisa dibantu periksa.</p>" +
      '<div class="pay-state-actions">' +
      '<a class="btn btn-ghost" href="products.html">Kembali ke katalog</a>' +
      contactButtonsHTML() +
      "</div>" +
      "</div>";
  }

  function renderMainExpired() {
    stopCountdown();
    var backHref = current && current.product && current.product.slug ? "product.html?slug=" + encodeURIComponent(current.product.slug) : "products.html";
    $("pay-main").innerHTML =
      '<div class="pay-state">' +
      '<div class="pay-state-icon is-idle">⏱</div>' +
      "<h2>Waktu pembayaran habis</h2>" +
      "<p>Transaksi ini sudah kedaluwarsa. Silakan buat pesanan baru untuk mencoba lagi.</p>" +
      '<div class="pay-state-actions">' +
      '<a class="btn btn-primary" href="' + backHref + '">Pesan ulang</a>' +
      contactButtonsHTML() +
      "</div>" +
      "</div>";
  }

  function render(order) {
    current = order;
    renderSide(order);

    var status = order.paymentStatus;
    if (status === "SUCCESS") {
      renderMainSuccess();
      if (!redirected) {
        redirected = true;
        stopWatch();
        setTimeout(function () {
          window.location.replace("order-success.html?order=" + encodeURIComponent(order.orderCode));
        }, 1100);
      }
    } else if (status === "FAILED") {
      renderMainFailed("Pembayaran gagal");
      stopWatch();
    } else if (status === "CANCELLED") {
      renderMainFailed("Pembayaran dibatalkan");
      stopWatch();
    } else if (status === "EXPIRED") {
      renderMainExpired();
      stopWatch();
    } else {
      renderMainPending(order);
    }
  }

  /* ----------------------------------------------------------------- data */
  async function fetchOrder(silent) {
    try {
      var res = await MP.get("/orders/track/" + encodeURIComponent(orderCode));
      render(res.data);
      return res.data;
    } catch (err) {
      if (silent) return null;
      $("payment-body").innerHTML =
        '<div class="notice" style="margin:20px auto;max-width:560px">' +
        "<b>Pesanan tidak ditemukan</b>" +
        MP.escapeHTML(err.message || "Periksa kembali tautan pembayaran kamu.") +
        '<div style="margin-top:18px"><a class="btn btn-primary" href="products.html">Kembali ke katalog</a></div>' +
        "</div>";
      return null;
    }
  }

  function buildLayout() {
    $("payment-body").innerHTML =
      '<div class="pay-grid">' +
      '<section class="panel pay-main" id="pay-main"></section>' +
      '<aside class="panel pay-side"><h2>Detail Transaksi</h2><div id="pay-side-body"></div></aside>' +
      "</div>";
  }

  /* -------------------------------------------------------------- watcher */
  function stopWatch() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (socketHandler) {
      var socket = MP.getSocket();
      if (socket) {
        socket.off("payment:updated", socketHandler);
        socket.off("order:updated", socketHandler);
      }
      socketHandler = null;
    }
  }

  function startWatch() {
    stopWatch();

    var checkRefresh = async function () {
      try {
        await MP.get("/payments/" + encodeURIComponent(orderCode) + "/refresh");
      } catch (err) {
        console.error("Gagal memeriksa status pembayaran:", err);
        return;
      }
      fetchOrder(true);
    };
    pollTimer = setInterval(checkRefresh, 10000);

    var socket = MP.getSocket();
    if (socket) {
      socketHandler = function (payload) {
        if (payload && payload.orderCode && payload.orderCode !== orderCode) return;
        fetchOrder(true);
      };
      socket.on("payment:updated", socketHandler);
      socket.on("order:updated", socketHandler);
    }
  }

  document.addEventListener("DOMContentLoaded", async function () {
    if (!orderCode) {
      window.location.replace("products.html");
      return;
    }

    buildLayout();
    var order = await fetchOrder(false);
    if (!order) return;

    if (order.paymentStatus === "PENDING") startWatch();

    MP.onReconnect(function () {
      fetchOrder(true);
    });
    MP.onSettings(function () {
      // Contact links may have just been configured/changed in Admin Web —
      // re-render the current terminal state so the buttons stay live.
      if (current && ["FAILED", "CANCELLED", "EXPIRED"].indexOf(current.paymentStatus) !== -1) {
        render(current);
      }
    });
  });
})();
