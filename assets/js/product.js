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
    // The buy panel only ever gets a short excerpt — the full description
    // is rendered once, in "Tentang produk" below. Keeping the full text
    // out of both places at once is what used to make this column so long
    // and duplicate the copy already shown further down the page.
    $("product-desc").textContent = MP.excerpt(product.description, 140);
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

  /* ------------------------------------------------------ go to checkout */
  // Checkout re-reads price/stock/category itself, so this is only a display
  // hint that survives the navigation — never trusted for the order total.
  function goToCheckout() {
    if (!product || Number(product.stock) <= 0) return;
    try {
      sessionStorage.setItem(
        MP.CHECKOUT_KEY,
        JSON.stringify({ slug: product.slug, productId: product._id, quantity: qty })
      );
    } catch (err) {
      console.error("Gagal menyimpan draf checkout:", err);
    }
    window.location.href = "checkout.html";
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
    $("buy-now").addEventListener("click", goToCheckout);
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
