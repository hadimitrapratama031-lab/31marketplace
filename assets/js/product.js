/* ============================================================================
   31 Store — product detail + checkout.
   Price and stock are never trusted from this page: the order endpoint reads
   them from MongoDB again. Everything shown here comes from /api/products,
   /api/orders and /api/payments, and stays in sync over the existing sockets.
   ========================================================================= */
(function () {
  "use strict";

  var $ = function (id) {
    return document.getElementById(id);
  };

  var slug = new URLSearchParams(window.location.search).get("slug");
  var product = null;
  var qty = 1;

  var pollTimer = null;
  var paymentHandler = null; // detached on close so watchers never pile up
  var watchedOrder = null;

  /* --------------------------------------------------------------- render */
  function renderNotFound(message) {
    var root = $("detail-root");
    if (!root) return;
    root.innerHTML =
      '<div class="notice" style="margin:80px auto;max-width:560px">' +
      "<b>Produk tidak tersedia</b>" +
      MP.escapeHTML(message) +
      '<div style="margin-top:18px"><a class="btn btn-primary" href="products.html">Kembali ke katalog</a></div>' +
      "</div>";
  }

  function renderMedia() {
    var frame = $("media-frame");
    if (!frame) return;
    var categoryName = (product.categoryId && product.categoryId.name) || "";

    if (product.image) {
      frame.innerHTML =
        '<img src="' + MP.escapeHTML(product.image) + '" alt="' + MP.escapeHTML(product.name) + '" decoding="async">' +
        (categoryName ? '<figcaption class="media-flag">' + MP.escapeHTML(categoryName) + "</figcaption>" : "");
    } else {
      frame.innerHTML =
        '<div class="ph">' + MP.escapeHTML(MP.initials(product.name)) + "</div>" +
        (categoryName ? '<figcaption class="media-flag">' + MP.escapeHTML(categoryName) + "</figcaption>" : "");
    }
  }

  function renderProduct() {
    var stock = Number(product.stock) || 0;
    var out = stock <= 0;
    var categoryName = (product.categoryId && product.categoryId.name) || "Produk digital";

    if (qty > Math.max(1, stock)) qty = Math.max(1, stock);

    $("crumb-name").textContent = product.name;
    $("product-name").textContent = product.name;
    $("product-desc").textContent = product.description || "";
    $("product-desc").hidden = !product.description;
    $("product-price").textContent = MP.formatIDR(product.price);
    $("product-sold").textContent = MP.formatNumber(product.sold) + " terjual";
    $("product-category-line").textContent = categoryName;
    $("tag-category").textContent = categoryName;

    var stockTag = $("tag-stock");
    stockTag.textContent = out ? "Stok habis" : stock <= 5 ? "Sisa " + stock : "Tersedia";
    stockTag.className = "tag " + (out ? "tag-danger" : stock <= 5 ? "tag-amber" : "tag-ok");

    $("product-stock-line").textContent = out ? "Stok sedang kosong" : "Stok " + MP.formatNumber(stock);

    $("about-body").textContent = product.description || "Deskripsi produk belum diisi oleh admin toko.";

    var buy = $("buy-now");
    buy.disabled = out;
    buy.textContent = out ? "Stok habis" : "Beli sekarang";

    // applySettings() rebuilds the title from this suffix, so storing it here
    // keeps the product name even if settings arrive after the product does.
    document.body.dataset.titleSuffix = product.name;
    var settings = MP.getSettings();
    var storeName = (settings && settings.general && settings.general.storeName) || "31 Store";
    document.title = storeName + " — " + product.name;

    renderMedia();
    updateQty();
  }

  function updateQty() {
    var stock = Number(product ? product.stock : 0) || 0;
    var max = Math.max(1, Math.min(99, stock));
    if (qty > max) qty = max;
    if (qty < 1) qty = 1;

    $("qty-value").textContent = qty;
    $("qty-minus").disabled = qty <= 1 || stock <= 0;
    $("qty-plus").disabled = qty >= max || stock <= 0;
    $("buy-total").textContent = MP.formatIDR(product ? product.price * qty : 0);
  }

  /* -------------------------------------------------------------- related */
  async function loadRelated() {
    var grid = $("related-grid");
    if (!grid || !product) return;
    try {
      var res = await MP.get("/products");
      var all = (res.data || []).filter(function (p) {
        return p._id !== product._id;
      });
      var currentCat = String((product.categoryId && product.categoryId._id) || product.categoryId || "");
      var sameCat = all.filter(function (p) {
        return String((p.categoryId && p.categoryId._id) || p.categoryId || "") === currentCat;
      });
      var others = all.filter(function (p) {
        return sameCat.indexOf(p) === -1;
      });

      var related = sameCat.concat(others).slice(0, 4);
      grid.innerHTML = related.length
        ? related
            .map(function (p) {
              return MP.productCard(p);
            })
            .join("")
        : '<div class="notice" style="grid-column:1/-1">Belum ada produk lain yang aktif.</div>';
    } catch (err) {
      console.error("Gagal memuat produk lain:", err);
    }
  }

  /* ------------------------------------------------------------ load data */
  async function loadProduct(silent) {
    if (!slug) {
      window.location.replace("products.html");
      return;
    }
    try {
      var res = await MP.get("/products/" + encodeURIComponent(slug));
      product = res.data;
      renderProduct();
      if (!silent) loadRelated();
    } catch (err) {
      if (silent) return; // a realtime refresh failing should not wipe the page
      renderNotFound(err.message || "Produk ini sudah tidak tersedia.");
    }
  }

  /* ---------------------------------------------------------------- modal */
  function closeModal() {
    $("modal-root").innerHTML = "";
    document.removeEventListener("keydown", onEsc);
    stopPaymentWatch();
  }

  function onEsc(e) {
    if (e.key === "Escape") closeModal();
  }

  function openModal(inner) {
    $("modal-root").innerHTML =
      '<div class="overlay" id="overlay"><div class="modal" role="dialog" aria-modal="true">' +
      '<button class="modal-close" type="button" id="modal-close" aria-label="Tutup">✕</button>' +
      inner +
      "</div></div>";

    $("overlay").addEventListener("click", function (e) {
      if (e.target.id === "overlay") closeModal();
    });
    $("modal-close").addEventListener("click", closeModal);
    document.addEventListener("keydown", onEsc);
  }

  function openCheckout() {
    if (!product || Number(product.stock) <= 0) return;

    openModal(
      "<h3>" + MP.escapeHTML(product.name) + "</h3>" +
        '<p class="modal-sub">' + qty + " item · Total " + MP.formatIDR(product.price * qty) + "</p>" +
        '<form id="checkout-form" novalidate>' +
        '<label class="field"><span>Nama</span><input class="input" id="ck-name" placeholder="Nama kamu" autocomplete="name"></label>' +
        '<label class="field"><span>Email</span><input class="input" id="ck-email" type="email" required placeholder="nama@email.com" autocomplete="email"></label>' +
        '<label class="field"><span>Nomor WhatsApp</span><input class="input" id="ck-wa" required placeholder="08xxxxxxxxxx" inputmode="tel" autocomplete="tel"></label>' +
        '<p class="form-note" id="ck-note">Detail pesanan dikirim ke email dan WhatsApp di atas.</p>' +
        '<button class="btn btn-primary btn-block btn-lg" type="submit" id="ck-submit">Buat pesanan</button>' +
        "</form>"
    );

    $("checkout-form").addEventListener("submit", submitCheckout);
  }

  async function submitCheckout(e) {
    e.preventDefault();
    var submit = $("ck-submit");
    var note = $("ck-note");

    var email = $("ck-email").value.trim();
    var wa = $("ck-wa").value.trim();

    if (!email || !wa) {
      note.className = "form-note is-error";
      note.textContent = "Email dan nomor WhatsApp wajib diisi.";
      return;
    }

    note.className = "form-note";
    note.textContent = "Membuat pesanan…";
    submit.disabled = true;
    submit.textContent = "Memproses…";

    try {
      var res = await MP.post("/orders", {
        productId: product._id,
        quantity: qty,
        name: $("ck-name").value.trim(),
        email: email,
        whatsapp: wa,
      });
      renderPayment(res.data.order, res.data.payment);
    } catch (err) {
      note.className = "form-note is-error";
      note.textContent = err.message || "Pesanan gagal dibuat. Coba lagi.";
      submit.disabled = false;
      submit.textContent = "Buat pesanan";
    }
  }

  function renderPayment(order, payment) {
    openModal(
      "<h3>Pesanan " + MP.escapeHTML(order.orderCode) + "</h3>" +
        '<p class="modal-sub">Total ' + MP.formatIDR(payment.totalAmount || payment.amount) + "</p>" +
        (payment.qrisUrl ? '<img class="qris" src="' + MP.escapeHTML(payment.qrisUrl) + '" alt="Kode QRIS pembayaran">' : "") +
        (payment.directUrl
          ? '<a class="btn btn-ghost btn-block" style="margin-bottom:12px" href="' +
            MP.escapeHTML(payment.directUrl) +
            '" target="_blank" rel="noopener">Buka halaman pembayaran</a>'
          : "") +
        '<div class="pay-status" id="pay-status">Menunggu pembayaran…</div>' +
        '<p class="buy-fine">Simpan kode pesanan ini. Status diperbarui otomatis, dan bisa dicek kapan saja di <a href="cek-pesanan/?order=' +
        encodeURIComponent(order.orderCode) +
        '" style="color:var(--violet-soft)">Cek Pesanan</a>.</p>'
    );

    startPaymentWatch(order.orderCode);
  }

  /* -------------------------------------------------------- payment watch */
  function stopPaymentWatch() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (paymentHandler) {
      var socket = MP.getSocket();
      if (socket) {
        socket.off("payment:updated", paymentHandler);
        socket.off("order:updated", paymentHandler);
      }
      paymentHandler = null;
    }
    watchedOrder = null;
  }

  function startPaymentWatch(orderCode) {
    stopPaymentWatch();
    watchedOrder = orderCode;

    var check = async function () {
      try {
        var res = await MP.get("/payments/" + encodeURIComponent(orderCode) + "/refresh");
        applyStatus(res.data.status);
      } catch (err) {
        console.error("Gagal memeriksa status pembayaran:", err);
      }
    };

    pollTimer = setInterval(check, 10000);
    check();

    var socket = MP.getSocket();
    if (socket) {
      paymentHandler = function (payload) {
        if (payload && payload.orderCode === watchedOrder) applyStatus(payload.paymentStatus || payload.status);
      };
      socket.on("payment:updated", paymentHandler);
      socket.on("order:updated", paymentHandler);
    }
  }

  function applyStatus(status) {
    var el = $("pay-status");
    if (!el) return;

    var tone = MP.STATUS_TONE[status] || "pending";
    el.textContent = MP.STATUS_LABEL[status] || status;
    el.className = "pay-status" + (tone === "ok" ? " is-ok" : tone === "bad" ? " is-bad" : "");

    if (status === "PAID" || status === "SUCCESS") {
      stopPaymentWatch();
      MP.toast("Pembayaran diterima. Terima kasih!", "ok");
      loadProduct(true);
    } else if (["FAILED", "EXPIRED", "CANCELLED"].indexOf(status) !== -1) {
      stopPaymentWatch();
    }
  }

  /* ----------------------------------------------------------------- bind */
  function bind() {
    $("qty-plus").addEventListener("click", function () {
      qty += 1;
      updateQty();
    });
    $("qty-minus").addEventListener("click", function () {
      qty -= 1;
      updateQty();
    });
    $("buy-now").addEventListener("click", openCheckout);
  }

  document.addEventListener("DOMContentLoaded", function () {
    if (!slug) {
      window.location.replace("products.html");
      return;
    }

    bind();
    loadProduct();

    var refresh = MP.debounce(function () {
      loadProduct(true);
    }, 300);
    MP.on(["product:updated", "products:updated", "stock:updated", "categories:updated"], refresh);
    MP.on("product:deleted", function (payload) {
      if (product && payload && String(payload.productId) === String(product._id)) {
        renderNotFound("Produk ini baru saja dihapus oleh admin toko.");
      }
    });
    MP.onReconnect(refresh);
  });
})();
