/* ============================================================================
   31 Store — home page.
   Every list here is read from /api/* and re-read when the existing Socket.IO
   events fire. Nothing on this page is hardcoded except interface copy.
   ========================================================================= */
(function () {
  "use strict";

  var $ = function (id) {
    return document.getElementById(id);
  };

  var BOARD_LIMIT = 8;
  var GRID_LIMIT = 8;

  var state = { products: [], categories: [], faqs: [], stats: null };
  var lastBoard = new Map(); // slug -> "price|stock", used to flash changed rows

  /* -------------------------------------------------------- price board */
  function renderBoard() {
    var rows = $("board-rows");
    var count = $("board-count");
    if (!rows) return;

    var items = state.products.slice(0, BOARD_LIMIT);

    if (!items.length) {
      rows.innerHTML = '<div class="board-row"><div class="board-cell"><div class="board-sub">Belum ada produk aktif.</div></div></div>';
      if (count) count.textContent = "0 produk";
      return;
    }

    if (count) count.textContent = MP.formatNumber(state.products.length) + " produk aktif";

    var next = new Map();
    rows.innerHTML = items
      .map(function (p) {
        var stock = Number(p.stock) || 0;
        var signature = p.price + "|" + stock;
        var changed = lastBoard.size > 0 && lastBoard.get(p.slug) !== signature;
        next.set(p.slug, signature);

        var category = (p.categoryId && p.categoryId.name) || "Produk digital";
        var stockLabel = stock <= 0 ? "Stok habis" : stock <= 5 ? "Sisa " + stock : "Stok " + MP.formatNumber(stock);

        return (
          '<a class="board-row' + (changed ? " is-fresh" : "") + '" href="product.html?slug=' + encodeURIComponent(p.slug) + '">' +
          '<span class="board-cell">' +
          '<span class="board-name">' + MP.escapeHTML(p.name) + "</span>" +
          '<span class="board-sub">' + MP.escapeHTML(category) + "</span>" +
          "</span>" +
          '<span class="board-cell">' +
          '<span class="board-price">' + MP.formatIDR(p.price) + "</span>" +
          '<span class="board-stock">' + stockLabel + "</span>" +
          "</span>" +
          "</a>"
        );
      })
      .join("");

    lastBoard = next;
  }

  /* ------------------------------------------------------------ products */
  function renderProducts() {
    var grid = $("product-grid");
    var note = $("product-note");
    if (!grid) return;

    if (!state.products.length) {
      grid.innerHTML = '<div class="notice" style="grid-column:1/-1"><b>Belum ada produk</b>Produk yang ditambahkan lewat panel admin akan langsung muncul di sini.</div>';
      if (note) note.textContent = "Belum ada produk aktif.";
      return;
    }

    grid.innerHTML = state.products
      .slice(0, GRID_LIMIT)
      .map(function (p) {
        return MP.productCard(p);
      })
      .join("");

    if (note) {
      note.textContent =
        state.products.length > GRID_LIMIT
          ? "Menampilkan " + GRID_LIMIT + " dari " + MP.formatNumber(state.products.length) + " produk aktif."
          : MP.formatNumber(state.products.length) + " produk aktif, harga dan stok terkini.";
    }
  }

  /* ---------------------------------------------------------- categories */
  function renderCategories() {
    var rail = $("category-rail");
    var note = $("category-note");
    if (!rail) return;

    var counts = new Map();
    state.products.forEach(function (p) {
      var id = String((p.categoryId && p.categoryId._id) || p.categoryId || "");
      if (!id) return;
      counts.set(id, (counts.get(id) || 0) + 1);
    });

    var visible = state.categories.filter(function (c) {
      return counts.has(String(c._id));
    });

    if (!visible.length) {
      rail.innerHTML = '<div class="notice" style="grid-column:1/-1">Kategori akan muncul setelah ada produk aktif di dalamnya.</div>';
      if (note) note.textContent = "Belum ada kategori dengan produk aktif.";
      return;
    }

    if (note) note.textContent = visible.length + " kategori dengan produk aktif saat ini.";

    rail.innerHTML = visible
      .map(function (c) {
        var n = counts.get(String(c._id)) || 0;
        var icon = c.icon || "";
        var glyph = /^https?:\/\//i.test(icon)
          ? '<img src="' + MP.escapeHTML(icon) + '" alt="" loading="lazy">'
          : MP.escapeHTML(icon || MP.initials(c.name));

        return (
          '<a class="cat-card" href="products.html?category=' + encodeURIComponent(c.slug) + '">' +
          '<span class="cat-glyph">' + glyph + "</span>" +
          '<span class="cat-text"><b>' + MP.escapeHTML(c.name) + "</b><small>" + n + " produk</small></span>" +
          "</a>"
        );
      })
      .join("");
  }

  /* ----------------------------------------------------------------- faq */
  function renderFAQ() {
    var list = $("faq-list");
    var note = $("faq-note");
    if (!list) return;

    if (!state.faqs.length) {
      list.innerHTML = '<div class="notice"><b>Belum ada pertanyaan</b>Admin belum menambahkan FAQ untuk toko ini.</div>';
      if (note) note.textContent = "Belum ada pertanyaan yang dipublikasikan.";
      return;
    }

    if (note) note.textContent = state.faqs.length + " pertanyaan, dikelola langsung oleh admin toko.";

    list.innerHTML = state.faqs
      .map(function (f, i) {
        var open = i === 0;
        return (
          '<div class="faq-item' + (open ? " is-open" : "") + '">' +
          '<button class="faq-q" type="button" aria-expanded="' + (open ? "true" : "false") + '">' +
          "<span>" + MP.escapeHTML(f.question) + "</span>" +
          '<span class="faq-sign" aria-hidden="true">+</span>' +
          "</button>" +
          '<div class="faq-a"><div><p>' + MP.escapeHTML(f.answer) + "</p></div></div>" +
          "</div>"
        );
      })
      .join("");
  }

  function bindFAQ() {
    var list = $("faq-list");
    if (!list) return;
    // One delegated listener for the lifetime of the page — re-rendering the
    // list on a realtime FAQ update can never stack handlers.
    list.addEventListener("click", function (e) {
      var btn = e.target.closest(".faq-q");
      if (!btn) return;
      var item = btn.parentElement;
      var open = item.classList.toggle("is-open");
      btn.setAttribute("aria-expanded", open ? "true" : "false");
    });
  }

  /* ---------------------------------------------------------- statistics */
  function renderStats() {
    if (!state.stats) return;
    var s = state.stats;
    var visibility = (MP.getSettings() || {}).statistics || {};

    var map = {
      sold: { el: $("stat-sold"), value: MP.formatNumber(s.totalProdukTerjual), visible: visibility.totalProdukTerjualVisible },
      rating: { el: $("stat-rating"), value: s.averageRating ? s.averageRating + " / 5" : "Belum ada", visible: visibility.averageRatingVisible },
      buyer: { el: $("stat-buyer"), value: MP.formatNumber(s.totalBuyer), visible: visibility.totalBuyerVisible },
      produk: { el: $("stat-produk"), value: MP.formatNumber(s.totalProduk), visible: visibility.totalProdukVisible },
      orders: { el: $("stat-orders"), value: MP.formatNumber(s.successfulOrders), visible: visibility.successfulOrdersVisible },
    };

    Object.keys(map).forEach(function (key) {
      var entry = map[key];
      if (entry.el) entry.el.textContent = entry.value;
      var wrap = document.querySelector('[data-stat="' + key + '"]');
      if (wrap) wrap.hidden = entry.visible === false;
    });

    if (visibility.supportLabel && $("stat-support-label")) $("stat-support-label").textContent = visibility.supportLabel;

    // The divider belongs to the last *visible* stat, not the last element.
    var cells = Array.prototype.slice.call(document.querySelectorAll(".stat"));
    var shown = cells.filter(function (c) {
      return !c.hidden;
    });
    cells.forEach(function (c) {
      c.classList.toggle("is-last", c === shown[shown.length - 1]);
    });
  }

  /* ------------------------------------------- settings-driven home copy */
  function applyHomeSettings(s) {
    if (!s) return;
    var home = s.home || {};
    var contact = s.contact || {};

    if (home.heading && $("hero-heading")) $("hero-heading").textContent = home.heading;
    var lede = home.subtitle || home.description;
    if (lede && $("hero-description")) $("hero-description").textContent = lede;
    if (home.ctaText && $("hero-cta-text")) $("hero-cta-text").textContent = home.ctaText;
    if (home.ctaLink && $("hero-cta")) $("hero-cta").setAttribute("href", home.ctaLink);

    if (contact.title && $("contact-title")) $("contact-title").textContent = contact.title;
    if (contact.description && $("contact-description")) $("contact-description").textContent = contact.description;

    var highlights = Array.isArray(s.highlights)
      ? s.highlights
          .filter(function (h) {
            return h.enabled !== false && h.title;
          })
          .sort(function (a, b) {
            return (a.sortOrder || 0) - (b.sortOrder || 0);
          })
      : [];

    var grid = $("benefit-grid");
    if (grid && highlights.length) {
      grid.innerHTML = highlights
        .map(function (h) {
          return (
            '<article class="benefit">' +
            '<div class="cat-glyph">' + MP.escapeHTML(h.icon || "•") + "</div>" +
            "<h3>" + MP.escapeHTML(h.title) + "</h3>" +
            "<p>" + MP.escapeHTML(h.description || "") + "</p>" +
            "</article>"
          );
        })
        .join("");
    }

    renderStats();
  }

  /* --------------------------------------------------------- data loading */
  async function loadCatalog() {
    var results = await Promise.allSettled([MP.get("/products"), MP.get("/categories")]);
    if (results[0].status === "fulfilled") state.products = results[0].value.data || [];
    if (results[1].status === "fulfilled") state.categories = results[1].value.data || [];
    results.forEach(function (r) {
      if (r.status === "rejected") console.error("Gagal memuat katalog:", r.reason);
    });
    renderBoard();
    renderProducts();
    renderCategories();
  }

  async function loadFAQ() {
    try {
      var res = await MP.get("/faq");
      state.faqs = res.data || [];
      renderFAQ();
    } catch (err) {
      console.error("Gagal memuat FAQ:", err);
      var list = $("faq-list");
      if (list && !state.faqs.length) list.innerHTML = '<div class="notice">Daftar pertanyaan gagal dimuat. Coba muat ulang halaman.</div>';
    }
  }

  async function loadStats() {
    try {
      var res = await MP.get("/statistics");
      state.stats = res.data;
      renderStats();
    } catch (err) {
      console.error("Gagal memuat statistik:", err);
    }
  }

  // Admin Web emits statistics:updated both when the numbers move and when a
  // stat is shown/hidden — the visibility flags live in settings, so refresh
  // both or a toggled stat would stay on screen until the next reload.
  function refreshStatsAndVisibility() {
    return Promise.all([loadStats(), MP.loadSettings(true)]);
  }

  function loadAll() {
    return Promise.all([loadCatalog(), loadFAQ(), loadStats()]);
  }

  /* ------------------------------------------------------------ realtime */
  function setupRealtime() {
    var refreshCatalog = MP.debounce(loadCatalog, 300);
    var refreshFAQ = MP.debounce(loadFAQ, 300);
    var refreshStats = MP.debounce(refreshStatsAndVisibility, 300);

    MP.on(["product:created", "product:updated", "product:deleted", "products:updated", "categories:updated", "stock:updated"], refreshCatalog);
    MP.on("faq:updated", refreshFAQ);
    MP.on(["statistics:updated", "rating:updated", "order:updated", "payment:updated"], refreshStats);
    MP.onReconnect(function () {
      loadAll().catch(function (err) {
        console.error(err);
      });
    });
  }

  /* --------------------------------------------------------------- search */
  function setupSearch() {
    var form = $("hero-search");
    if (!form) return;
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var q = ($("hero-search-input").value || "").trim();
      window.location.href = q ? "products.html?q=" + encodeURIComponent(q) : "products.html";
    });
  }

  /* --------------------------------------------------- active nav on scroll */
  function setupScrollSpy() {
    var sections = Array.prototype.slice.call(document.querySelectorAll("main section[id]"));
    var links = Array.prototype.slice.call(document.querySelectorAll('.nav a[href^="#"]'));
    if (!sections.length || !links.length || !("IntersectionObserver" in window)) return;

    var home = document.querySelector('.nav a[href="index.html"]');
    var observer = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          var match = links.filter(function (l) {
            return l.getAttribute("href") === "#" + entry.target.id;
          })[0];
          links.forEach(function (l) {
            l.classList.toggle("is-active", l === match);
          });
          if (home) home.classList.toggle("is-active", !match);
        });
      },
      { rootMargin: "-40% 0px -55% 0px" }
    );
    sections.forEach(function (s) {
      observer.observe(s);
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    bindFAQ();
    setupSearch();
    setupScrollSpy();
    MP.onSettings(applyHomeSettings);
    loadAll()
      .then(function () {
        MP.observeReveals();
      })
      .catch(function (err) {
        console.error("Gagal memuat halaman:", err);
      });
    setupRealtime();
  });
})();
