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

  // Blok REDEEM CODE + CARA REDEEM (sistem baru — Automatic Redeem Code).
  // `order.redeem` HANYA diisi backend kalau produknya orderSystem
  // "REDEEM_CODE" DAN pembayaran sudah SUCCESS — order.redeem null berarti
  // produk sistem lama (tidak ada blok apa pun, flow lama tidak berubah).
  // `order.redeem.codes` kosong berarti klaim gagal/tidak lengkap saat
  // pembayaran: TIDAK PERNAH mengarang code, tampilkan pesan error apa adanya.
  function redeemBoxHTML(redeem) {
    if (!redeem) return "";

    if (redeem.codes && redeem.codes.length) {
      var rows = redeem.codes
        .map(function (code) {
          return (
            '<div class="redeem-code-row"><span class="redeem-code-value">' +
            MP.escapeHTML(code) +
            '</span><button type="button" class="redeem-copy-btn" data-copy-code="' +
            MP.escapeHTML(code) +
            '">Salin</button></div>'
          );
        })
        .join("");
      var instructions = redeem.instructions
        ? '<div class="redeem-instructions"><h4>Cara Redeem</h4><p>' + MP.escapeHTML(redeem.instructions) + "</p></div>"
        : "";
      return '<section class="panel redeem-box"><h4>Redeem Code</h4>' + rows + instructions + "</section>";
    }

    return (
      '<section class="panel redeem-box is-error"><h4>Redeem Code</h4><p>' +
      MP.escapeHTML(redeem.error || "Redeem code sedang diproses. Silakan hubungi admin jika belum muncul.") +
      "</p></section>"
    );
  }

  // Tombol "Salin" pada tiap baris redeem code. Dipasang ulang setiap kali
  // success-body dirender ulang (realtime), memakai clipboard API dengan
  // fallback execCommand untuk browser lama.
  function bindCopyButtons(root) {
    root.querySelectorAll("[data-copy-code]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var code = btn.dataset.copyCode;
        var markCopied = function () {
          var original = btn.textContent;
          btn.textContent = "Tersalin";
          btn.classList.add("is-copied");
          setTimeout(function () {
            btn.textContent = original;
            btn.classList.remove("is-copied");
          }, 1600);
        };
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(code).then(markCopied).catch(function () {});
          return;
        }
        var ta = document.createElement("textarea");
        ta.value = code;
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        try {
          document.execCommand("copy");
          markCopied();
        } catch (e) {
          /* abaikan kalau copy tidak didukung */
        }
        document.body.removeChild(ta);
      });
    });
  }

  function adminButtonsHTML() {
    var settings = MP.getSettings();
    var channels = MP.contactChannels(settings);
    var out = "";
    if (channels.whatsapp.href) {
      out +=
        '<a class="admin-btn is-wa" href="' + MP.escapeHTML(channels.whatsapp.href) + '" target="_blank" rel="noopener">' +
        channelGlyph(channels.whatsapp.icon, "WA") +
        "WhatsApp</a>";
    }
    if (channels.discord.href) {
      out +=
        '<a class="admin-btn is-discord" href="' + MP.escapeHTML(channels.discord.href) + '" target="_blank" rel="noopener">' +
        channelGlyph(channels.discord.icon, "DC") +
        "Discord</a>";
    }
    if (!out) {
      out = '<p class="muted-line" style="margin:0">Kontak admin belum diatur di Admin Web.</p>';
    }
    return out;
  }

  // Renders the admin-uploaded logo when one exists; otherwise keeps the
  // existing text-badge fallback so the button never looks broken/empty.
  function channelGlyph(iconUrl, fallbackText) {
    return iconUrl
      ? "<i><img src=\"" + MP.escapeHTML(iconUrl) + "\" alt=\"\"></i>"
      : "<i>" + fallbackText + "</i>";
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

      redeemBoxHTML(order.redeem) +

      '<section class="panel admin-help">' +
      "<h2>Perlu bantuan?</h2>" +
      "<p>Silakan hubungi admin melalui salah satu kontak berikut.</p>" +
      '<div class="admin-btn-row" id="admin-btn-row">' + adminButtonsHTML() + "</div>" +
      "</section>" +

      '<div class="success-cta">' +
      '<a class="btn btn-primary" href="products.html">Lihat produk lain</a>' +
      // Cek Pesanan sekarang dibuka dengan email, bukan kode order: kode order
      // saja tercetak di mana-mana dan tidak membuktikan kepemilikan. Emailnya
      // tidak dibawa di URL — pembeli mengetiknya sendiri di halaman itu.
      '<a class="btn btn-ghost" href="cek-pesanan/">Lacak pesanan</a>' +
      "</div>" +
      "</div>";

    bindCopyButtons($("success-body"));
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
