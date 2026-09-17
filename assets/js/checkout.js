/* ============================================================================
   31 Store — Checkout (step 1/3).
   The sessionStorage draft only carries slug + quantity across the navigation
   from Product Detail. Price, stock, name, image and category are always
   re-read here from /api/products/:slug — exactly like product.js does —
   and the order itself is created the same way it always was, through
   POST /api/orders, which re-reads everything again server-side.
   ========================================================================= */
(function () {
  "use strict";

  var $ = function (id) {
    return document.getElementById(id);
  };

  var product = null;
  var qty = 1;
  var submitting = false;

  function readDraft() {
    try {
      var raw = sessionStorage.getItem(MP.CHECKOUT_KEY);
      if (!raw) return null;
      var draft = JSON.parse(raw);
      if (!draft || !draft.slug) return null;
      return draft;
    } catch (err) {
      return null;
    }
  }

  function renderNotice(title, message, ctaHref, ctaLabel) {
    $("checkout-body").innerHTML =
      '<div class="notice" style="margin:20px auto;max-width:560px">' +
      "<b>" + MP.escapeHTML(title) + "</b>" +
      MP.escapeHTML(message) +
      (ctaHref
        ? '<div style="margin-top:18px"><a class="btn btn-primary" href="' + ctaHref + '">' + MP.escapeHTML(ctaLabel) + "</a></div>"
        : "") +
      "</div>";
  }

  function productMedia(p) {
    return p.image
      ? '<img src="' + MP.escapeHTML(p.image) + '" alt="' + MP.escapeHTML(p.name) + '">'
      : '<div class="ph">' + MP.escapeHTML(MP.initials(p.name)) + "</div>";
  }

  function render() {
    var stock = Number(product.stock) || 0;
    var categoryName = (product.categoryId && product.categoryId.name) || "";
    var subtotal = product.price * qty;

    if (stock <= 0) {
      renderNotice(
        "Stok produk ini baru saja habis",
        "Produk sudah tidak tersedia untuk dibeli. Silakan pilih produk lain di katalog.",
        "products.html",
        "Kembali ke katalog"
      );
      return;
    }
    if (qty > stock) qty = stock;

    $("checkout-body").innerHTML =
      '<div class="co-grid">' +
      '<section class="panel co-panel">' +
      "<h2>Informasi pemesan</h2>" +
      '<form id="checkout-form" class="co-form" novalidate>' +
      '<label class="field"><span>Nama</span><input class="input" id="ck-name" placeholder="Nama kamu" autocomplete="name"></label>' +
      '<label class="field"><span>Email</span><input class="input" id="ck-email" type="email" required placeholder="nama@email.com" autocomplete="email"></label>' +
      '<label class="field"><span>Nomor WhatsApp</span><input class="input" id="ck-wa" required placeholder="08xxxxxxxxxx" inputmode="tel" autocomplete="tel"></label>' +
      '<p class="form-note" id="ck-note">Detail pesanan dan kode order dikirim ke email dan WhatsApp di atas.</p>' +
      "</form>" +
      "</section>" +
      '<aside class="panel co-summary">' +
      "<h2>Ringkasan pesanan</h2>" +
      '<div class="co-product">' +
      '<div class="co-product-media">' + productMedia(product) + "</div>" +
      '<div class="co-product-info">' +
      "<b>" + MP.escapeHTML(product.name) + "</b>" +
      '<div class="co-product-tags">' +
      (categoryName ? '<span class="tag">' + MP.escapeHTML(categoryName) + "</span>" : "") +
      '<span class="tag">' + qty + " item</span>" +
      "</div>" +
      "</div>" +
      "</div>" +
      '<div class="co-price-rows">' +
      '<div class="kv"><span>Harga satuan</span><strong>' + MP.formatIDR(product.price) + "</strong></div>" +
      '<div class="kv"><span>Jumlah</span><strong>' + qty + "</strong></div>" +
      '<div class="kv"><span>Subtotal</span><strong>' + MP.formatIDR(subtotal) + "</strong></div>" +
      "</div>" +
      '<div class="co-total"><span>Total pembayaran</span><strong>' + MP.formatIDR(subtotal) + "</strong></div>" +
      '<button class="btn btn-primary btn-lg btn-block" type="submit" form="checkout-form" id="ck-submit">Lanjutkan Pembayaran</button>' +
      '<p class="buy-fine">Pembayaran memakai QRIS. Kamu akan diarahkan ke halaman pembayaran setelah pesanan dibuat.</p>' +
      "</aside>" +
      "</div>";

    $("checkout-form").addEventListener("submit", submit);
  }

  async function submit(e) {
    e.preventDefault();
    if (submitting) return;

    var note = $("ck-note");
    var btn = $("ck-submit");
    var email = $("ck-email").value.trim();
    var wa = $("ck-wa").value.trim();

    if (!email || !wa) {
      note.className = "form-note is-error";
      note.textContent = "Email dan nomor WhatsApp wajib diisi.";
      return;
    }

    submitting = true;
    note.className = "form-note";
    note.textContent = "Membuat pesanan…";
    btn.disabled = true;
    btn.textContent = "Memproses…";

    try {
      var res = await MP.post("/orders", {
        productId: product._id,
        quantity: qty,
        name: $("ck-name").value.trim(),
        email: email,
        whatsapp: wa,
      });
      try {
        sessionStorage.removeItem(MP.CHECKOUT_KEY);
      } catch (err) {
        /* ignore */
      }
      // replace(), not href — so the back button from Payment skips this
      // already-submitted form instead of allowing a second POST /orders.
      window.location.replace("payment.html?order=" + encodeURIComponent(res.data.order.orderCode));
    } catch (err) {
      submitting = false;
      note.className = "form-note is-error";
      note.textContent = err.message || "Pesanan gagal dibuat. Coba lagi.";
      btn.disabled = false;
      btn.textContent = "Lanjutkan Pembayaran";
    }
  }

  async function load() {
    var draft = readDraft();
    if (!draft) {
      window.location.replace("products.html");
      return;
    }

    try {
      var res = await MP.get("/products/" + encodeURIComponent(draft.slug));
      product = res.data;
      qty = Math.max(1, Math.min(99, Number(draft.quantity) || 1, Number(product.stock) || 1));
      render();
    } catch (err) {
      renderNotice("Produk tidak ditemukan", err.message || "Produk ini sudah tidak tersedia.", "products.html", "Kembali ke katalog");
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    load();

    var refresh = MP.debounce(function () {
      if (!product || submitting) return;
      load();
    }, 300);
    MP.on(["product:updated", "products:updated", "stock:updated"], refresh);
    MP.on("product:deleted", function (payload) {
      if (product && payload && String(payload.productId) === String(product._id)) {
        renderNotice("Produk dihapus", "Produk ini baru saja dihapus oleh admin toko.", "products.html", "Kembali ke katalog");
      }
    });
    MP.onReconnect(refresh);
  });
})();
