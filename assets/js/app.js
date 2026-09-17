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

  var GRID_LIMIT = 8;

  var state = { products: [], categories: [], faqs: [], stats: null };

  /* ------------------------------------------------- products, by category */
  // "Kategori" is no longer a standalone section — it's the grouping used to
  // lay out "Produk tersedia". Every group still comes straight from the
  // existing /products + /categories data; a category with no active product
  // simply never gets a group, so the layout never shows an empty grid.
  function categoryGlyph(icon, name) {
    return /^https?:\/\//i.test(icon || "")
      ? '<img src="' + MP.escapeHTML(icon) + '" alt="" loading="lazy">'
      : MP.escapeHTML(icon || MP.initials(name));
  }

  function renderProducts() {
    var wrap = $("product-groups");
    var note = $("product-note");
    if (!wrap) return;

    if (!state.products.length) {
      wrap.innerHTML = '<div class="notice"><b>Belum ada produk</b>Produk yang ditambahkan lewat panel admin akan langsung muncul di sini.</div>';
      if (note) note.textContent = "Belum ada produk aktif.";
      return;
    }

    // Group active products by their category, keeping the same order the
    // admin has set for categories (categories API is already sorted by
    // sortOrder). Products without a matching active category fall into a
    // trailing "Lainnya" group so nothing from the backend ever disappears.
    var byCategory = new Map();
    var others = [];
    state.products.forEach(function (p) {
      var id = String((p.categoryId && p.categoryId._id) || p.categoryId || "");
      if (id) {
        if (!byCategory.has(id)) byCategory.set(id, []);
        byCategory.get(id).push(p);
      } else {
        others.push(p);
      }
    });

    var groups = state.categories
      .filter(function (c) {
        return byCategory.has(String(c._id));
      })
      .map(function (c) {
        return { name: c.name, slug: c.slug, icon: c.icon, items: byCategory.get(String(c._id)) };
      });

    // Any product whose categoryId no longer resolves to an active category
    // (deleted/renamed category, etc.) still needs somewhere to render.
    state.products.forEach(function (p) {
      var id = String((p.categoryId && p.categoryId._id) || p.categoryId || "");
      if (id && !state.categories.some(function (c) { return String(c._id) === id; })) {
        others.push(p);
      }
    });
    if (others.length) groups.push({ name: "Produk lainnya", slug: "", icon: "", items: others });

    if (!groups.length) {
      wrap.innerHTML = '<div class="notice"><b>Belum ada produk</b>Produk yang ditambahkan lewat panel admin akan langsung muncul di sini.</div>';
      if (note) note.textContent = "Belum ada produk aktif.";
      return;
    }

    var shownTotal = 0;
    wrap.innerHTML = groups
      .map(function (g) {
        var items = g.items.slice(0, GRID_LIMIT);
        shownTotal += items.length;
        var link = g.slug
          ? '<a class="sec-link product-group-link" href="products.html?category=' + encodeURIComponent(g.slug) + '">Lihat semua</a>'
          : "";

        return (
          '<div class="product-group">' +
          '<div class="product-group-head">' +
          '<span class="cat-glyph cat-glyph-sm">' + categoryGlyph(g.icon, g.name) + "</span>" +
          '<h3 class="product-group-title">' + MP.escapeHTML(g.name) + "</h3>" +
          '<span class="product-group-count">' + MP.formatNumber(g.items.length) + " produk</span>" +
          link +
          "</div>" +
          '<div class="grid-products">' +
          items
            .map(function (p) {
              return MP.productCard(p);
            })
            .join("") +
          "</div>" +
          "</div>"
        );
      })
      .join("");

    if (note) {
      var totalActive = state.products.length;
      note.textContent =
        shownTotal < totalActive
          ? "Menampilkan " + MP.formatNumber(shownTotal) + " dari " + MP.formatNumber(totalActive) + " produk aktif, dikelompokkan per kategori."
          : MP.formatNumber(totalActive) + " produk aktif di " + MP.formatNumber(groups.length) + " kategori.";
    }
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

  /* ------------------------------------------------------------------ hero */
  // Everything visible in the hero is written by Admin Web and arrives through
  // the same /api/settings payload the rest of the page uses, so a change made
  // in the panel reaches this renderer over the existing Socket.IO connection
  // without a refresh. The HTML holds fallback copy for the very first paint
  // only; from here on this function owns the hero.
  var heroTimer = null;
  var heroIndex = 0;
  var heroSlides = [];

  function heroConfig(s) {
    var home = (s && s.home) || {};
    var hero = home.hero || {};
    var heading = hero.heading || {};

    // Lines the admin actually filled in. Falling back to the older flat
    // `home.heading` keeps documents saved before the hero settings existed
    // rendering correctly instead of showing an empty page.
    var lines = [heading.line1, heading.line2, heading.line3].filter(function (l) {
      return String(l || "").trim();
    });
    if (!lines.length && home.heading) lines = [home.heading];

    return {
      eyebrow: hero.eyebrow || {},
      lines: lines,
      accentText: String(heading.accentText || "").trim(),
      accentColor: heading.accentColor || "",
      description: hero.description || home.subtitle || home.description || "",
      primary: hero.primaryButton || { enabled: true, text: home.ctaText, url: home.ctaLink },
      secondary: hero.secondaryButton || {},
      image: hero.image || {},
      overlay: hero.overlay || {},
      slides: Array.isArray(hero.slides) ? hero.slides : [],
      autoplay: hero.autoplay || {},
    };
  }

  // Wraps the admin's accent words inside an already-escaped line. Escaping
  // first and matching the escaped needle means admin copy can contain < or &
  // without ever injecting markup.
  function withAccent(line, accentText, accentColor) {
    var safe = MP.escapeHTML(line);
    if (!accentText) return safe;
    var needle = MP.escapeHTML(accentText);
    var at = safe.toLowerCase().indexOf(needle.toLowerCase());
    if (at < 0) return safe;
    var style = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(accentColor) ? ' style="color:' + accentColor + '"' : "";
    return (
      safe.slice(0, at) +
      '<span class="hero-accent"' + style + ">" + safe.slice(at, at + needle.length) + "</span>" +
      safe.slice(at + needle.length)
    );
  }

  // A button the admin switched off disappears; one they left on keeps the
  // fallback label from the markup until they type their own, so the hero is
  // never rendered with a blank, button-shaped hole in it.
  function setButton(id, textId, config, fallbackHref) {
    var btn = $(id);
    var label = $(textId);
    if (!btn) return;

    if (config.enabled === false) {
      btn.hidden = true;
      return;
    }

    btn.hidden = false;
    var text = String(config.text || "").trim();
    if (label && text) label.textContent = text;
    btn.setAttribute("href", config.url || fallbackHref);
  }

  function pad2(n) {
    return (n < 10 ? "0" : "") + n;
  }

  function setOverlayText(id, value) {
    var el = $(id);
    if (!el) return;
    el.textContent = value || "";
    el.hidden = !value;
  }

  // The counter is always derived: one enabled slide reads 01 / 01, four read
  // 01 / 04. It is never written into the markup.
  function renderHeroFrame(cfg) {
    var total = heroSlides.length;
    var current = total ? heroSlides[heroIndex] : {};
    var overlay = cfg.overlay || {};
    var showOverlay = overlay.enabled !== false;

    document.querySelectorAll("#hero-slides .hero-slide").forEach(function (el, i) {
      el.classList.toggle("is-current", i === heroIndex);
    });

    if (!showOverlay) {
      ["hero-art-tl", "hero-art-tr", "hero-art-bl", "hero-art-br"].forEach(function (id) {
        setOverlayText(id, "");
      });
      return;
    }

    setOverlayText("hero-art-tl", current.topLeft || overlay.topLeft || "");
    setOverlayText("hero-art-bl", current.bottomLeft || overlay.bottomLeft || "");
    setOverlayText("hero-art-br", current.bottomRight || overlay.bottomRight || "");

    var manualTopRight = current.topRight || overlay.topRight || "";
    var counter = total ? pad2(heroIndex + 1) + " / " + pad2(total) : "";
    setOverlayText("hero-art-tr", manualTopRight || counter);
  }

  function stopHeroAutoplay() {
    if (heroTimer) clearInterval(heroTimer);
    heroTimer = null;
  }

  function startHeroAutoplay(cfg) {
    stopHeroAutoplay();
    if (heroSlides.length < 2) return;
    if (cfg.autoplay && cfg.autoplay.enabled === false) return;
    if (window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    var interval = Number(cfg.autoplay && cfg.autoplay.intervalMs) || 6000;
    heroTimer = setInterval(function () {
      // Nothing to animate while the tab is in the background — let the
      // browser throttle instead of queueing transitions nobody sees.
      if (document.hidden) return;
      heroIndex = (heroIndex + 1) % heroSlides.length;
      renderHeroFrame(cfg);
    }, Math.max(2500, interval));
  }

  function renderHero(s) {
    var hero = $("hero");
    if (!hero) return;
    var cfg = heroConfig(s);

    var eyebrow = $("hero-eyebrow");
    if (eyebrow) {
      var eyebrowText = String(cfg.eyebrow.text || "").trim();
      eyebrow.textContent = eyebrowText;
      eyebrow.hidden = !eyebrowText || cfg.eyebrow.enabled === false;
    }

    var title = $("hero-title");
    if (title && cfg.lines.length) {
      title.innerHTML = cfg.lines
        .map(function (line) {
          return '<span class="hero-line">' + withAccent(line, cfg.accentText, cfg.accentColor) + "</span>";
        })
        .join("");
    }

    if (cfg.description && $("hero-description")) $("hero-description").textContent = cfg.description;

    setButton("hero-cta-primary", "hero-cta-primary-text", cfg.primary, "products.html");
    setButton("hero-cta-secondary", "hero-cta-secondary-text", cfg.secondary, "#contact");

    // Enabled slides first; a single uploaded image is treated as one slide so
    // the counter, the overlay, and the markup stay on one code path.
    heroSlides = cfg.slides
      .filter(function (slide) {
        return slide && slide.enabled !== false && slide.image;
      })
      .slice()
      .sort(function (a, b) {
        return (a.sortOrder || 0) - (b.sortOrder || 0);
      });

    if (!heroSlides.length && cfg.image.url) {
      heroSlides = [{ image: cfg.image.url, alt: cfg.image.alt }];
    }

    var wrap = $("hero-slides");
    if (wrap) {
      wrap.innerHTML = heroSlides.length
        ? heroSlides
            .map(function (slide, i) {
              return (
                '<div class="hero-slide' + (i === 0 ? " is-current" : "") + '">' +
                '<img src="' + MP.escapeHTML(slide.image) + '" alt="' + MP.escapeHTML(slide.alt || "") + '"' +
                (i === 0 ? "" : ' loading="lazy"') + ' decoding="async">' +
                "</div>"
              );
            })
            .join("")
        : // No artwork uploaded yet: a CSS-only orb keeps the hero looking
          // finished instead of showing an empty purple rectangle.
          '<div class="hero-slide is-current"><div class="hero-orb"></div></div>';
    }

    if (heroIndex >= heroSlides.length) heroIndex = 0;

    var nav = $("hero-art-nav");
    if (nav) nav.hidden = heroSlides.length < 2;

    renderHeroFrame(cfg);
    startHeroAutoplay(cfg);

    // One entrance, the first time the hero has real content.
    requestAnimationFrame(function () {
      hero.classList.add("is-ready");
    });

    return cfg;
  }

  function bindHero(getConfig) {
    var art = $("hero-art");
    var nav = $("hero-art-nav");
    if (!art || !nav) return;

    // One delegated listener for the page lifetime — re-rendering the slides
    // on a realtime settings update can never stack handlers.
    nav.addEventListener("click", function (e) {
      var btn = e.target.closest("[data-slide]");
      if (!btn || heroSlides.length < 2) return;
      var step = btn.dataset.slide === "prev" ? -1 : 1;
      heroIndex = (heroIndex + step + heroSlides.length) % heroSlides.length;
      var cfg = getConfig();
      renderHeroFrame(cfg);
      startHeroAutoplay(cfg);
    });

    art.addEventListener("mouseenter", stopHeroAutoplay);
    art.addEventListener("mouseleave", function () {
      startHeroAutoplay(getConfig());
    });
  }

  /* ------------------------------------------- settings-driven home copy */
  var lastHeroConfig = null;

  function applyHomeSettings(s) {
    if (!s) return;
    var contact = s.contact || {};

    lastHeroConfig = renderHero(s) || lastHeroConfig;

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
    renderProducts();
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
    bindHero(function () {
      return lastHeroConfig || heroConfig(MP.getSettings());
    });
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
