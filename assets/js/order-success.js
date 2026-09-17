/* ============================================================================
   31 Store — Order Success (step 3/3).
   Guards against being opened directly for an order that isn't actually
   paid: it re-checks the real backend status and bounces back to Payment if
   it isn't SUCCESS. Contact buttons read the existing WebsiteSettings.contact
   (same fields the homepage footer already uses) — no duplicate config.
   ========================================================================= */
(function () {
  "use strict";

  var $ = function (id) {
    return document.getElementById(id);
  };

  var orderCode = (new URLSearchParams(window.location.search).get("order") || "").trim().toUpperCase();
  var current = null;

  var DONE = ["PAID", "SUCCESS", "COMPLETED"];

  function productMedia(p) {
    return p.image
      ? '<img src="' + MP.escapeHTML(p.image) + '" alt="' + MP.escapeHTML(p.name) + '">'
      : '<div class="ph">' + MP.escapeHTML(MP.initials(p.name)) + "</div>";
  }

  function adminButtonsHTML() {
    var settings = MP.getSettings();
    var contact = (settings && settings.contact) || {};
    var waDigits = String(contact.whatsapp || "").replace(/\D/g, "");
    var waHref = waDigits ? "https://wa.me/" + waDigits : "";
    var dcHref = contact.discordUrl || "";
    var out = "";
    if (waHref) {
      out +=
        '<a class="admin-btn is-wa" href="' + MP.escapeHTML(waHref) + '" target="_blank" rel="noopener"><i>WA</i>WhatsApp</a>';
    }
    if (dcHref) {
      out +=
        '<a class="admin-btn is-discord" href="' + MP.escapeHTML(dcHref) + '" target="_blank" rel="noopener"><i>DC</i>Discord</a>';
    }
    if (!out) {
      out = '<p class="muted-line" style="margin:0">Kontak admin belum diatur di Admin Web.</p>';
    }
    return out;
  }

  function refreshAdminButtons() {
    var el = $("admin-btn-row");
    if (el) el.innerHTML = adminButtonsHTML();
  }

  function render(order) {
    current = order;
    var qty = order.quantity;

    $("success-body").innerHTML =
      '<div class="success-shell">' +
      '<div class="success-hero">' +
      '<div class="success-check">✓</div>' +
      "<h1>Pembayaran Berhasil</h1>" +
      "<p>Pembayaran berhasil diproses.</p>" +
      "</div>" +

      '<section class="panel success-card">' +
      "<h2>Detail Pesanan</h2>" +
      '<div class="success-product">' +
      '<div class="success-product-media">' + productMedia(order.product) + "</div>" +
      '<div class="success-product-info">' +
      "<b>" + MP.escapeHTML(order.product.name) + "</b>" +
      '<div class="success-product-tags">' +
      (order.product.category ? '<span class="tag">' + MP.escapeHTML(order.product.category) + "</span>" : "") +
      '<span class="tag">' + qty + " item</span>" +
      "</div>" +
      "</div>" +
      "</div>" +
      '<div class="kv"><span>Order ID</span><strong>' + MP.escapeHTML(order.orderCode) + "</strong></div>" +
      '<div class="kv"><span>Harga satuan</span><strong>' + MP.formatIDR(order.product.price) + "</strong></div>" +
      '<div class="kv"><span>Total pembayaran</span><strong>' + MP.formatIDR(order.total) + "</strong></div>" +
      '<div class="kv"><span>Metode pembayaran</span><strong>' + MP.escapeHTML((order.payment && order.payment.method) || "QRIS") + "</strong></div>" +
      '<div class="kv"><span>Status pembayaran</span><strong>' + MP.escapeHTML(MP.STATUS_LABEL[order.paymentStatus] || order.paymentStatus) + "</strong></div>" +
      '<div class="kv"><span>Waktu pembayaran</span><strong>' + MP.formatDate((order.payment && order.payment.paidAt) || order.createdAt) + "</strong></div>" +
      "</section>" +

      '<section class="panel admin-help">' +
      "<h2>Butuh bantuan?</h2>" +
      "<p>Pembayaran berhasil. Silakan hubungi admin jika membutuhkan bantuan terkait pesanan Anda.</p>" +
      '<div class="admin-btn-row" id="admin-btn-row">' + adminButtonsHTML() + "</div>" +
      "</section>" +

      '<div class="success-cta">' +
      '<a class="btn btn-primary" href="products.html">Lihat produk lain</a>' +
      '<a class="btn btn-ghost" href="cek-pesanan/?order=' + encodeURIComponent(order.orderCode) + '">Lacak pesanan ini</a>' +
      "</div>" +
      "</div>";
  }

  async function load(silent) {
    try {
      var res = await MP.get("/orders/track/" + encodeURIComponent(orderCode));
      var order = res.data;

      // Never trust a direct/guessed URL: only show this page once the
      // backend itself reports the order as paid.
      if (DONE.indexOf(order.paymentStatus) === -1 && DONE.indexOf(order.status) === -1) {
        window.location.replace("payment.html?order=" + encodeURIComponent(order.orderCode));
        return;
      }
      render(order);
    } catch (err) {
      if (silent) return;
      $("success-body").innerHTML =
        '<div class="notice" style="margin:20px auto;max-width:560px">' +
        "<b>Pesanan tidak ditemukan</b>" +
        MP.escapeHTML(err.message || "Periksa kembali tautan pesanan kamu.") +
        '<div style="margin-top:18px"><a class="btn btn-primary" href="products.html">Kembali ke katalog</a></div>' +
        "</div>";
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    if (!orderCode) {
      window.location.replace("products.html");
      return;
    }

    load(false);

    var refresh = MP.debounce(function (payload) {
      if (payload && payload.orderCode && payload.orderCode !== orderCode) return;
      load(true);
    }, 250);
    MP.on(["order:updated", "payment:updated"], refresh);
    MP.onReconnect(function () {
      load(true);
    });
    MP.onSettings(refreshAdminButtons);
  });
})();
