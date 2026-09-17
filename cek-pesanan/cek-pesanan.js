/* ============================================================================
   31 Store — lacak pesanan.
   Reads /api/orders/track/:orderCode and re-reads it whenever the existing
   order:updated / payment:updated events mention the order on screen.
   ========================================================================= */
(function () {
  "use strict";

  var $ = function (id) {
    return document.getElementById(id);
  };

  var currentOrder = null;

  var DONE = ["PAID", "SUCCESS", "COMPLETED"];
  var BAD = ["FAILED", "EXPIRED", "CANCELLED"];

  function pill(status) {
    var tone = MP.STATUS_TONE[status] || "idle";
    var label = MP.STATUS_LABEL[status] || status;
    return '<span class="pill pill-' + tone + '">' + MP.escapeHTML(label) + "</span>";
  }

  function stepState(order) {
    var paid = DONE.indexOf(order.paymentStatus) !== -1 || DONE.indexOf(order.status) !== -1;
    var stopped = BAD.indexOf(order.paymentStatus) !== -1 || BAD.indexOf(order.status) !== -1;
    var finished = order.status === "COMPLETED";

    return [
      { label: "Pesanan dibuat", note: "Kode order diterbitkan", state: "is-done" },
      {
        label: "Pembayaran",
        note: stopped ? "Tidak diselesaikan" : paid ? "Sudah dibayar" : "Menunggu pembayaran",
        state: stopped ? "" : paid ? "is-done" : "is-current",
      },
      {
        label: "Verifikasi",
        note: paid ? "Pembayaran terverifikasi" : "Menunggu pembayaran masuk",
        state: paid ? "is-done" : "",
      },
      {
        label: "Selesai",
        note: finished ? "Pesanan selesai" : "Diproses admin toko",
        state: finished ? "is-done" : paid ? "is-current" : "",
      },
    ];
  }

  function render(order) {
    var steps = stepState(order)
      .map(function (s) {
        return '<div class="step ' + s.state + '"><i></i><b>' + s.label + "</b><span>" + s.note + "</span></div>";
      })
      .join("");

    var payment = "";
    if (order.payment && order.paymentStatus === "PENDING") {
      payment =
        '<div class="pay-box">' +
        "<h4>Selesaikan pembayaran</h4>" +
        (order.payment.qrisUrl ? '<img class="qris" src="' + MP.escapeHTML(order.payment.qrisUrl) + '" alt="Kode QRIS pembayaran">' : "") +
        (order.payment.directUrl
          ? '<a class="btn btn-primary btn-block" href="' + MP.escapeHTML(order.payment.directUrl) + '" target="_blank" rel="noopener">Buka halaman pembayaran</a>'
          : "") +
        (order.payment.expiredAt ? '<p class="muted" style="font-size:12.5px;margin-top:12px">Berlaku sampai ' + MP.formatDate(order.payment.expiredAt) + "</p>" : "") +
        "</div>";
    }

    $("result").innerHTML =
      '<div class="panel order-card">' +
      '<div class="order-top"><span class="order-code">' + MP.escapeHTML(order.orderCode) + "</span>" + pill(order.paymentStatus) + "</div>" +
      '<div class="steps">' + steps + "</div>" +
      '<div style="padding-top:8px">' +
      '<div class="kv"><span>Produk</span><strong>' + MP.escapeHTML(order.product.name) + "</strong></div>" +
      '<div class="kv"><span>Jumlah</span><strong>' + MP.escapeHTML(String(order.quantity)) + "</strong></div>" +
      '<div class="kv"><span>Total</span><strong>' + MP.formatIDR(order.total) + "</strong></div>" +
      '<div class="kv"><span>Status pesanan</span><strong>' + MP.escapeHTML(MP.STATUS_LABEL[order.status] || order.status) + "</strong></div>" +
      '<div class="kv"><span>Dibuat</span><strong>' + MP.formatDate(order.createdAt) + "</strong></div>" +
      "</div>" +
      payment +
      "</div>";
  }

  async function lookup(code, silent) {
    var note = $("track-note");
    var btn = $("track-submit");

    if (!silent) {
      note.className = "form-note";
      note.textContent = "Mencari pesanan…";
      btn.disabled = true;
      btn.textContent = "Mencari…";
    }

    try {
      var res = await MP.get("/orders/track/" + encodeURIComponent(code));
      currentOrder = code;
      if (!silent) note.textContent = "";
      render(res.data);
    } catch (err) {
      if (silent) return; // keep the last good view if a refresh fails
      currentOrder = null;
      $("result").innerHTML = "";
      note.className = "form-note is-error";
      note.textContent = err.message || "Pesanan tidak ditemukan. Periksa lagi kode order kamu.";
    } finally {
      if (!silent) {
        btn.disabled = false;
        btn.textContent = "Cek pesanan";
      }
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    $("track-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var code = ($("order-code").value || "").trim().toUpperCase();
      if (code) lookup(code, false);
    });

    // One listener for the page: it checks the payload against whichever order
    // is on screen, so re-rendering never attaches another handler.
    var refresh = MP.debounce(function (payload) {
      if (!currentOrder) return;
      if (payload && payload.orderCode && payload.orderCode !== currentOrder) return;
      lookup(currentOrder, true);
    }, 250);

    MP.on(["order:updated", "payment:updated"], refresh);
    MP.onReconnect(function () {
      if (currentOrder) lookup(currentOrder, true);
    });

    var preset = new URLSearchParams(window.location.search).get("order");
    if (preset) {
      $("order-code").value = preset.toUpperCase();
      lookup(preset.toUpperCase(), false);
    }
  });
})();
