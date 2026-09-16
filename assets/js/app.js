/* 31 Store — Marketplace homepage. Everything below is fetched from /api/*
   (MongoDB-backed) and kept in sync live via Socket.IO. No hardcoded products. */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const CATEGORY_ICONS = ["▦", "◈", "◆", "◇", "▧", "◉"];

  const state = { settings: null, categories: [], products: [], faqs: [], statistics: null };

  // ---------------------------------------------------------------------
  // Rendering
  // ---------------------------------------------------------------------
  function productCard(product) {
    const outOfStock = Number(product.stock) <= 0;
    const image = product.image
      ? `<img src="${MP.escapeHTML(product.image)}" alt="${MP.escapeHTML(product.name)}" loading="lazy" style="width:100%;height:100%;object-fit:cover">`
      : "PRODUCT IMAGE";
    return `<article class="product-card reveal visible">
      <div class="product-image">${image}</div>
      <div class="product-body">
        <h4>${MP.escapeHTML(product.name)}</h4>
        <p>${MP.escapeHTML(product.description || "")}</p>
        <div class="product-meta">
          <div><div class="price">${MP.formatIDR(product.price)}</div><div class="stock">${outOfStock ? "Stok Habis" : "Tersedia"}</div></div>
          <span class="stock">${Number(product.sold) || 0} terjual</span>
        </div>
        <a class="buy" href="product.html?slug=${encodeURIComponent(product.slug)}" ${outOfStock ? 'style="opacity:.55;pointer-events:none"' : ""}>${outOfStock ? "Stok Habis" : "Beli Sekarang"}</a>
      </div>
    </article>`;
  }

  function renderCategoriesAndProducts() {
    const container = $("categories-container");
    if (!container) return;

    const byCategory = new Map();
    state.products.forEach((p) => {
      const catId = p.categoryId && (p.categoryId._id || p.categoryId);
      if (!catId) return;
      const key = String(catId);
      if (!byCategory.has(key)) byCategory.set(key, []);
      byCategory.get(key).push(p);
    });

    const categoriesWithProducts = state.categories.filter((c) => byCategory.has(String(c._id)));

    if (categoriesWithProducts.length === 0) {
      container.innerHTML = `<p style="color:#8a8093;font-size:13px;padding:18px 0">Belum ada produk tersedia saat ini.</p>`;
      return;
    }

    container.innerHTML = categoriesWithProducts
      .map((cat, idx) => {
        const products = byCategory.get(String(cat._id)) || [];
        const icon = cat.icon || CATEGORY_ICONS[idx % CATEGORY_ICONS.length];
        return `
          <div class="category-heading reveal visible ${idx > 0 ? "second-category" : ""}">
            <div class="category-icon">${MP.escapeHTML(icon)}</div>
            <div><h3>${MP.escapeHTML(cat.name)}</h3><p>${MP.escapeHTML(cat.description || "")}</p></div>
          </div>
          <div class="product-grid">${products.map(productCard).join("")}</div>`;
      })
      .join("");
  }

  function renderFAQ() {
    const el = $("faq-list");
    if (!el) return;
    if (state.faqs.length === 0) {
      el.innerHTML = `<p style="color:#8a8093;font-size:13px">Belum ada pertanyaan yang tersedia.</p>`;
      return;
    }
    el.innerHTML = state.faqs
      .map(
        (f, i) => `<div class="faq-item ${i === 0 ? "open" : ""}">
      <button class="faq-question" type="button"><span>${MP.escapeHTML(f.question)}</span><span>+</span></button>
      <div class="faq-answer">${MP.escapeHTML(f.answer)}</div>
    </div>`
      )
      .join("");
    el.querySelectorAll(".faq-question").forEach((btn) => {
      btn.addEventListener("click", () => btn.parentElement.classList.toggle("open"));
    });
  }

  function renderStatistics() {
    const stats = state.statistics;
    const visibility = state.settings?.statistics || {};
    if (!stats) return;

    const setStat = (wrapId, valueId, visible, text) => {
      const wrap = $(wrapId);
      const valueEl = $(valueId);
      if (wrap) wrap.style.display = visible === false ? "none" : "";
      if (valueEl) valueEl.textContent = text;
    };

    setStat("stat-sold-wrap", "stat-sold", visibility.totalProdukTerjualVisible, `${Number(stats.totalProdukTerjual || 0).toLocaleString("id-ID")}+`);
    setStat("stat-rating-wrap", "stat-rating", visibility.averageRatingVisible, stats.averageRating ? `${stats.averageRating}/5` : "Belum ada");
    setStat("stat-buyer-wrap", "stat-buyer", visibility.totalBuyerVisible, `${Number(stats.totalBuyer || 0).toLocaleString("id-ID")}+`);
    setStat("stat-produk-wrap", "stat-produk", visibility.totalProdukVisible, `${Number(stats.totalProduk || 0).toLocaleString("id-ID")}`);
    setStat("stat-orders-wrap", "stat-orders", visibility.successfulOrdersVisible, `${Number(stats.successfulOrders || 0).toLocaleString("id-ID")}`);

    const supportLabel = $("stat-support-label");
    if (supportLabel && visibility.supportLabel) supportLabel.textContent = visibility.supportLabel;
  }

  function renderSettings() {
    const s = state.settings;
    if (!s) return;

    // General / branding
    if (s.general?.storeName) {
      document.querySelectorAll(".js-store-name").forEach((el) => (el.textContent = s.general.storeName));
      document.title = `${s.general.storeName} — Digital Gaming Marketplace`;
    }
    if (s.general?.logo) {
      document.querySelectorAll(".js-brand-mark").forEach((el) => {
        el.innerHTML = `<img src="${MP.escapeHTML(s.general.logo)}" alt="Logo" style="width:100%;height:100%;object-fit:cover;border-radius:inherit">`;
      });
    }
    if (s.general?.description) {
      const meta = document.querySelector('meta[name="description"]');
      if (meta) meta.setAttribute("content", s.general.description);
    }
    if (s.general?.copyright) {
      const el = $("footer-copyright");
      if (el) el.textContent = s.general.copyright;
    }
    if (s.general?.websiteStatus === "maintenance") {
      showMaintenanceBanner();
    }

    // Navbar
    if (s.navbar?.cekPesananLabel) {
      document.querySelectorAll(".js-cek-pesanan-label").forEach((el) => (el.textContent = s.navbar.cekPesananLabel));
    }

    // Home hero
    if (s.home?.heading) $("hero-heading") && ($("hero-heading").textContent = s.home.heading);
    if (s.home?.subtitle) $("hero-description") && ($("hero-description").textContent = s.home.subtitle);
    if (s.home?.description && !s.home?.subtitle) $("hero-description") && ($("hero-description").textContent = s.home.description);
    if (s.home?.ctaText) $("hero-cta-text") && ($("hero-cta-text").textContent = s.home.ctaText);
    if (s.home?.ctaLink) $("hero-cta") && ($("hero-cta").setAttribute("href", s.home.ctaLink));

    // Highlights
    if (Array.isArray(s.highlights) && s.highlights.length > 0) {
      const enabled = s.highlights.filter((h) => h.enabled !== false).sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
      const grid = $("highlights-grid");
      if (grid && enabled.length > 0) {
        grid.innerHTML = enabled
          .map((h) => `<article class="feature-card"><div class="icon">${MP.escapeHTML(h.icon || "•")}</div><h3>${MP.escapeHTML(h.title)}</h3><p>${MP.escapeHTML(h.description || "")}</p></article>`)
          .join("");
      }
    }

    // Contact
    const contact = s.contact || {};
    if (contact.title) $("contact-title") && ($("contact-title").textContent = contact.title);
    if (contact.description) $("contact-description") && ($("contact-description").textContent = contact.description);
    const waLink = $("contact-whatsapp-link");
    const waCard = $("contact-card-whatsapp");
    if (contact.whatsapp && waLink && waCard) {
      const digits = String(contact.whatsapp).replace(/\D/g, "");
      waLink.href = `https://wa.me/${digits}`;
      if (contact.buttonText) waLink.textContent = `${contact.buttonText} ↗`;
      waCard.style.display = "";
      const footerWa = $("footer-whatsapp-link");
      if (footerWa) footerWa.href = `https://wa.me/${digits}`;
    }
    const dcLink = $("contact-discord-link");
    const dcCard = $("contact-card-discord");
    if (contact.discordUrl && dcLink && dcCard) {
      dcLink.href = contact.discordUrl;
      dcCard.style.display = "";
      const footerDc = $("footer-discord-link");
      if (footerDc) footerDc.href = contact.discordUrl;
    }

    // Footer
    if (s.footer?.description) $("footer-description") && ($("footer-description").textContent = s.footer.description);
    if (s.footer?.copyright) $("footer-copyright") && ($("footer-copyright").textContent = s.footer.copyright);
  }

  function showMaintenanceBanner() {
    if ($("maintenance-banner")) return;
    const bar = document.createElement("div");
    bar.id = "maintenance-banner";
    bar.style.cssText = "position:fixed;top:0;left:0;right:0;z-index:999;background:#211b31;color:#fff;text-align:center;font-size:12px;font-weight:700;padding:10px;letter-spacing:.03em";
    bar.textContent = "Website sedang dalam pemeliharaan. Beberapa fitur mungkin belum tersedia.";
    document.body.prepend(bar);
  }

  // ---------------------------------------------------------------------
  // Data loading
  // ---------------------------------------------------------------------
  async function loadAll() {
    const results = await Promise.allSettled([
      MP.get("/settings"),
      MP.get("/categories"),
      MP.get("/products"),
      MP.get("/faq"),
      MP.get("/statistics"),
    ]);

    const [settingsR, categoriesR, productsR, faqR, statsR] = results;
    if (settingsR.status === "fulfilled") state.settings = settingsR.value.data;
    if (categoriesR.status === "fulfilled") state.categories = categoriesR.value.data || [];
    if (productsR.status === "fulfilled") state.products = productsR.value.data || [];
    if (faqR.status === "fulfilled") state.faqs = faqR.value.data || [];
    if (statsR.status === "fulfilled") state.statistics = statsR.value.data;

    results.forEach((r) => {
      if (r.status === "rejected") console.error("Gagal memuat data marketplace:", r.reason);
    });

    renderSettings();
    renderCategoriesAndProducts();
    renderFAQ();
    renderStatistics();
  }

  async function reloadProducts() {
    try {
      const [categoriesR, productsR] = await Promise.all([MP.get("/categories"), MP.get("/products")]);
      state.categories = categoriesR.data || [];
      state.products = productsR.data || [];
      renderCategoriesAndProducts();
    } catch (err) {
      console.error("Gagal memperbarui produk:", err);
    }
  }

  async function reloadFAQ() {
    try {
      const r = await MP.get("/faq");
      state.faqs = r.data || [];
      renderFAQ();
    } catch (err) {
      console.error("Gagal memperbarui FAQ:", err);
    }
  }

  async function reloadStatistics() {
    try {
      const r = await MP.get("/statistics");
      state.statistics = r.data;
      renderStatistics();
    } catch (err) {
      console.error("Gagal memperbarui statistik:", err);
    }
  }

  async function reloadSettings() {
    try {
      const r = await MP.get("/settings");
      state.settings = r.data;
      renderSettings();
      renderStatistics();
    } catch (err) {
      console.error("Gagal memperbarui pengaturan:", err);
    }
  }

  // ---------------------------------------------------------------------
  // Realtime (Socket.IO) — reacts to events emitted by the Admin Web backend
  // ---------------------------------------------------------------------
  function setupRealtime() {
    const socket = MP.getSocket();
    if (!socket) return;

    const debouncedProducts = MP.debounce(reloadProducts, 300);
    const debouncedStats = MP.debounce(reloadStatistics, 300);
    const debouncedSettings = MP.debounce(reloadSettings, 300);

    ["product:created", "product:updated", "product:deleted", "products:updated", "categories:updated", "stock:updated"].forEach((evt) =>
      socket.on(evt, debouncedProducts)
    );
    ["statistics:updated", "rating:updated"].forEach((evt) => socket.on(evt, debouncedStats));
    ["website:settings:updated", "navbar:updated", "home:updated", "contact:updated"].forEach((evt) => socket.on(evt, debouncedSettings));
    socket.on("faq:updated", MP.debounce(reloadFAQ, 300));

    // After any reconnect, re-sync everything in case events were missed while offline.
    socket.on("connect", () => {
      loadAll().catch((err) => console.error(err));
    });
  }

  // ---------------------------------------------------------------------
  // Page chrome: reveal-on-scroll + active nav link (pure UI, unchanged)
  // ---------------------------------------------------------------------
  function setupPageChrome() {
    const observer = new IntersectionObserver(
      (entries) => entries.forEach((entry) => entry.isIntersecting && entry.target.classList.add("visible")),
      { threshold: 0.08 }
    );
    document.querySelectorAll(".reveal").forEach((el) => observer.observe(el));

    const sections = [...document.querySelectorAll("main section[id]")];
    const navLinks = [...document.querySelectorAll(".nav-link")];
    const sectionObserver = new IntersectionObserver(
      (entries) => {
        entries.forEach((entry) => {
          if (entry.isIntersecting) {
            navLinks.forEach((link) => link.classList.toggle("active", link.getAttribute("href") === "#" + entry.target.id));
          }
        });
      },
      { rootMargin: "-35% 0px -55% 0px" }
    );
    sections.forEach((s) => sectionObserver.observe(s));
  }

  document.addEventListener("DOMContentLoaded", () => {
    setupPageChrome();
    loadAll().catch((err) => console.error("Gagal memuat marketplace:", err));
    setupRealtime();
  });
})();
