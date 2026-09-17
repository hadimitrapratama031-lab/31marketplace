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
  var activeImage = "";

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

  /* ------------------------------------------------------------ galeri
     Gambar utama tetap jadi banner; thumbnail di bawahnya hanya memilih gambar
     mana yang ditampilkan di banner itu. Produk lama tanpa additionalImages
     dibaca sebagai [] — strip thumbnail-nya tidak muncul sama sekali, dan
     halamannya persis seperti sebelumnya. */
  function galleryImages() {
    var images = [];
    if (product.image) images.push(product.image);
    (product.additionalImages || []).forEach(function (img) {
      if (img && img.url) images.push(img.url);
    });
    return images;
  }

  function setActiveImage(url) {
    var frame = $("media-frame");
    var img = frame && frame.querySelector("img");
    if (!img || img.getAttribute("src") === url) return;

    activeImage = url;

    // Transisi sederhana: banner dipudarkan, gambar ditukar setelah yang baru
    // benar-benar selesai dimuat, lalu dimunculkan lagi. Tanpa menunggu onload,
    // banner sempat kosong di koneksi lambat.
    frame.classList.add("is-swapping");
    var next = new Image();
    next.onload = next.onerror = function () {
      img.src = url;
      frame.classList.remove("is-swapping");
    };
    next.src = url;

    renderThumbs();
  }

  function renderThumbs() {
    var strip = $("media-thumbs");
    if (!strip) return;

    var images = galleryImages();
    // Satu gambar bukan galeri. Strip-nya disembunyikan daripada menampilkan
    // satu thumbnail yang tidak bisa dipilih ke mana-mana.
    if (images.length < 2) {
      strip.hidden = true;
      strip.innerHTML = "";
      return;
    }

    strip.hidden = false;
    strip.innerHTML = images
      .map(function (url, i) {
        var active = url === activeImage;
        return (
          '<button class="media-thumb' +
          (active ? " is-active" : "") +
          '" type="button" data-image="' +
          MP.escapeHTML(url) +
          '" aria-label="Tampilkan gambar ' +
          (i + 1) +
          '" aria-pressed="' +
          (active ? "true" : "false") +
          '"><img src="' +
          MP.escapeHTML(url) +
          '" alt="" loading="lazy" decoding="async"></button>'
        );
      })
      .join("");
  }

  function renderMedia() {
    var frame = $("media-frame");
    if (!frame) return;
    var categoryName = (product.categoryId && product.categoryId.name) || "";
    var images = galleryImages();

    // Gambar yang sedang dipilih dipertahankan selama masih ada di produk —
    // update realtime dari Admin Web tidak boleh melempar pembeli kembali ke
    // gambar utama tanpa alasan. Kalau gambarnya baru saja dihapus admin,
    // baru jatuh ke gambar utama.
    if (!activeImage || images.indexOf(activeImage) === -1) {
      activeImage = images[0] || "";
    }

    if (activeImage) {
      frame.innerHTML =
        '<img src="' + MP.escapeHTML(activeImage) + '" alt="' + MP.escapeHTML(product.name) + '" decoding="async">' +
        (categoryName ? '<figcaption class="media-flag">' + MP.escapeHTML(categoryName) + "</figcaption>" : "");
    } else {
      frame.innerHTML =
        '<div class="ph">' + MP.escapeHTML(MP.initials(product.name)) + "</div>" +
        (categoryName ? '<figcaption class="media-flag">' + MP.escapeHTML(categoryName) + "</figcaption>" : "");
    }

    renderThumbs();
  }

  function renderProduct() {
    var stock = Number(product.stock) || 0;
    var out = stock <= 0;
    var categoryName = (product.categoryId && product.categoryId.name) || "Produk digital";

    if (qty > Math.max(1, stock)) qty = Math.max(1, stock);

    $("crumb-name").textContent = product.name;
    $("product-name").textContent = product.name;
    // Buy panel: admin-authored shortDescription is the source of truth.
    // Older products that don't have one yet fall back to an excerpt of the
    // full description, purely as a display fallback — never saved back,
    // never shown instead of the full text in "Tentang produk" below.
    var shortDesc = (product.shortDescription || "").trim() || MP.excerpt(product.description, 140);
    $("product-desc").textContent = shortDesc;
    $("product-desc").hidden = !shortDesc;
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

    // Satu listener untuk seluruh strip: isinya boleh dirender ulang berkali-kali
    // (termasuk oleh update realtime) tanpa pernah menumpuk handler.
    $("media-thumbs").addEventListener("click", function (e) {
      var btn = e.target.closest("[data-image]");
      if (btn) setActiveImage(btn.dataset.image);
    });
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
