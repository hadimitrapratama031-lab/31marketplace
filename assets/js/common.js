/* ============================================================================
   31 Store — shared frontend layer.
   Wraps the existing REST API and the existing Socket.IO server. No mock data,
   no second realtime system: every page reads through MP.get / MP.post and
   subscribes through MP.on, which de-duplicates listeners so a re-render can
   never stack handlers on the same socket.
   ========================================================================= */
(function (window, document) {
  "use strict";

  var API_BASE = "/api";

  /* --------------------------------------------------------------- fetch */
  async function request(path, options) {
    options = options || {};
    var isForm = options.body instanceof FormData;

    var res = await fetch(API_BASE + path, {
      method: options.method || "GET",
      headers: isForm ? undefined : Object.assign({ "Content-Type": "application/json" }, options.headers || {}),
      body: options.body,
      credentials: "same-origin",
    });

    var payload = null;
    try {
      payload = await res.json();
    } catch (e) {
      payload = null;
    }

    if (!res.ok || (payload && payload.status === false)) {
      var message = (payload && payload.message) || "Terjadi kesalahan (" + res.status + ").";
      var err = new Error(message);
      err.status = res.status;
      err.payload = payload;
      throw err;
    }
    return payload;
  }

  /* -------------------------------------------------------------- format */
  function formatIDR(value) {
    return "Rp " + (Number(value) || 0).toLocaleString("id-ID");
  }

  function formatNumber(value) {
    return (Number(value) || 0).toLocaleString("id-ID");
  }

  function formatDate(value) {
    if (!value) return "-";
    var d = new Date(value);
    if (Number.isNaN(d.getTime())) return "-";
    return d.toLocaleString("id-ID", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
  }

  function escapeHTML(str) {
    return String(str === null || str === undefined ? "" : str).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function initials(name) {
    var clean = String(name || "").trim();
    if (!clean) return "31";
    var parts = clean.split(/\s+/);
    return ((parts[0][0] || "") + (parts[1] ? parts[1][0] : "")).toUpperCase();
  }

  function debounce(fn, delay) {
    var t = null;
    return function () {
      var args = arguments;
      clearTimeout(t);
      t = setTimeout(function () {
        fn.apply(null, args);
      }, delay);
    };
  }

  /* ------------------------------------------------------------- socket */
  var socket = null;
  var bound = new Map(); // event -> Set(handler), so nothing is attached twice

  function getSocket() {
    if (socket) return socket;
    if (typeof window.io !== "function") {
      console.warn("Socket.IO client tidak termuat — update realtime dinonaktifkan.");
      return null;
    }
    socket = window.io({ transports: ["websocket", "polling"], reconnection: true, reconnectionDelay: 1500 });
    socket.on("connect_error", function (err) {
      console.warn("Socket connect_error:", err.message);
    });
    return socket;
  }

  function on(events, handler) {
    var s = getSocket();
    if (!s) return;
    (Array.isArray(events) ? events : [events]).forEach(function (evt) {
      if (!bound.has(evt)) bound.set(evt, new Set());
      var set = bound.get(evt);
      if (set.has(handler)) return; // already listening — never stack
      set.add(handler);
      s.on(evt, handler);
    });
  }

  // socket.io fires "connect" on the very first connection too. The page has
  // just fetched its data at that point, so only later connects (a real
  // reconnect, after possibly missing events) trigger a re-sync.
  function onReconnect(handler) {
    var first = true;
    on("connect", function () {
      if (first) {
        first = false;
        return;
      }
      handler();
    });
  }

  /* ------------------------------------------------------- product card */
  // One renderer for every grid on the site (home, catalog, related), so the
  // card can never drift between pages. `base` prefixes links from subfolders.
  function productCard(product, base) {
    base = base || "";
    var stock = Number(product.stock) || 0;
    var out = stock <= 0;
    var categoryName = (product.categoryId && product.categoryId.name) || "";

    var media = product.image
      ? '<img src="' + escapeHTML(product.image) + '" alt="' + escapeHTML(product.name) + '" loading="lazy" decoding="async">'
      : '<div class="ph">' + escapeHTML(initials(product.name)) + "</div>";

    var flag = "";
    if (out) flag = '<span class="tag tag-danger pcard-flag">Stok habis</span>';
    else if (stock <= 5) flag = '<span class="tag tag-amber pcard-flag">Sisa ' + stock + "</span>";

    return (
      '<a class="pcard" href="' + base + "product.html?slug=" + encodeURIComponent(product.slug) + '">' +
      '<div class="pcard-media">' +
      media +
      (categoryName ? '<span class="pcard-cat">' + escapeHTML(categoryName) + "</span>" : "") +
      flag +
      "</div>" +
      '<div class="pcard-body">' +
      '<div class="pcard-title">' + escapeHTML(product.name) + "</div>" +
      (product.description ? '<div class="pcard-desc">' + escapeHTML(product.description) + "</div>" : "") +
      '<div class="pcard-foot">' +
      '<div class="pcard-price">' + formatIDR(product.price) + "</div>" +
      '<div class="pcard-sold">' + formatNumber(product.sold) + " terjual</div>" +
      "</div>" +
      '<span class="btn ' + (out ? "btn-ghost" : "btn-primary") + ' btn-sm btn-block pcard-cta">' +
      (out ? "Stok habis" : "Lihat produk") +
      "</span>" +
      "</div>" +
      "</a>"
    );
  }

  /* -------------------------------------------------------------- toast */
  function toast(message, tone) {
    var stack = document.querySelector(".toast-stack");
    if (!stack) {
      stack = document.createElement("div");
      stack.className = "toast-stack";
      document.body.appendChild(stack);
    }
    var el = document.createElement("div");
    el.className = "toast" + (tone ? " is-" + tone : "");
    el.textContent = message;
    stack.appendChild(el);
    setTimeout(function () {
      el.remove();
    }, 4200);
  }

  /* ------------------------------------------------------------- reveal */
  function observeReveals(root) {
    var targets = (root || document).querySelectorAll(".reveal:not(.is-in)");
    if (!targets.length) return;
    if (!("IntersectionObserver" in window)) {
      targets.forEach(function (el) {
        el.classList.add("is-in");
      });
      return;
    }
    var io = new IntersectionObserver(
      function (entries) {
        entries.forEach(function (entry) {
          if (!entry.isIntersecting) return;
          entry.target.classList.add("is-in");
          io.unobserve(entry.target);
        });
      },
      { threshold: 0.12 }
    );
    targets.forEach(function (el) {
      io.observe(el);
    });
  }

  /* --------------------------------------------- settings (Admin Web data) */
  var settings = null;
  var settingsSubscribers = [];
  var settingsLoaded = null;

  function onSettings(cb) {
    settingsSubscribers.push(cb);
    if (settings) cb(settings);
  }

  function notifySettings() {
    settingsSubscribers.forEach(function (cb) {
      try {
        cb(settings);
      } catch (err) {
        console.error("Gagal menerapkan pengaturan:", err);
      }
    });
  }

  async function loadSettings(force) {
    if (settingsLoaded && !force) return settingsLoaded;
    settingsLoaded = request("/settings")
      .then(function (res) {
        settings = res.data || {};
        applySettings(settings);
        notifySettings();
        return settings;
      })
      .catch(function (err) {
        console.error("Gagal memuat pengaturan website:", err);
        return null;
      });
    return settingsLoaded;
  }

  var HEX = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i;

  function applyTheme(theme) {
    if (!theme) return;
    var root = document.documentElement;
    // Only the accent scale is admin-controlled. Surface/text tokens stay with
    // the design system so a stray colour can never make the page unreadable.
    if (HEX.test(theme.primary || "")) root.style.setProperty("--violet", theme.primary);
    if (HEX.test(theme.secondary || "")) root.style.setProperty("--violet-soft", theme.secondary);
    if (HEX.test(theme.accent || "")) root.style.setProperty("--amber", theme.accent);
  }

  function setText(selector, value) {
    if (!value) return;
    document.querySelectorAll(selector).forEach(function (el) {
      el.textContent = value;
    });
  }

  function waHref(number) {
    var digits = String(number || "").replace(/\D/g, "");
    return digits ? "https://wa.me/" + digits : "";
  }

  function bindLinks(selector, href) {
    document.querySelectorAll(selector).forEach(function (el) {
      if (href) {
        el.href = href;
        el.hidden = false;
        if (el.dataset.showWhenLinked) el.closest(el.dataset.showWhenLinked).hidden = false;
      } else {
        el.hidden = true;
        if (el.dataset.showWhenLinked) el.closest(el.dataset.showWhenLinked).hidden = true;
      }
    });
  }

  function applySettings(s) {
    if (!s) return;
    var general = s.general || {};
    var contact = s.contact || {};
    var footer = s.footer || {};

    applyTheme(s.theme);

    if (general.storeName) {
      setText("[data-store-name]", general.storeName);
      var suffix = document.body.dataset.titleSuffix || "";
      document.title = suffix ? general.storeName + " — " + suffix : general.storeName;
      setText("[data-store-initials]", initials(general.storeName));
    }

    var logo = general.logo || footer.logo || "";
    if (logo) {
      document.querySelectorAll("[data-brand-mark]").forEach(function (el) {
        el.innerHTML = '<img src="' + escapeHTML(logo) + '" alt="">';
      });
    }

    if (general.favicon) {
      var link = document.querySelector('link[rel="icon"]');
      if (!link) {
        link = document.createElement("link");
        link.rel = "icon";
        document.head.appendChild(link);
      }
      link.href = general.favicon;
    }

    if (general.description) {
      var meta = document.querySelector('meta[name="description"]');
      if (meta) meta.setAttribute("content", general.description);
    }

    setText("[data-copyright]", footer.copyright || general.copyright);
    setText("[data-footer-description]", footer.description || general.description);
    setText("[data-cek-label]", (s.navbar || {}).cekPesananLabel);

    var channels = contactChannels(s);
    bindLinks("[data-wa-link]", channels.whatsapp.href);
    bindLinks("[data-discord-link]", channels.discord.href);
    // Admin-uploaded icons for the homepage contact cards. If no icon has
    // been uploaded yet, leave the existing "WA"/"DC" text glyph in place
    // (set in the HTML) as a safe fallback rather than an empty box.
    setGlyphImage("#contact-card-whatsapp .cat-glyph", channels.whatsapp.icon);
    setGlyphImage("#contact-card-discord .cat-glyph", channels.discord.icon);

    document.querySelectorAll("[data-maintenance]").forEach(function (el) {
      el.hidden = general.websiteStatus !== "maintenance";
    });
  }

  // Derives the two contact channels (href + admin-uploaded icon) from
  // WebsiteSettings.contact in one place, so Order Success, Payment, and the
  // homepage contact section all read the exact same fields instead of each
  // re-implementing the wa.me/discord logic — one source of truth per #6.
  function contactChannels(s) {
    var contact = (s && s.contact) || {};
    var wa = contact.whatsapp || {};
    var discord = contact.discord || {};
    return {
      whatsapp: { href: waHref(wa.number), icon: wa.icon || "" },
      discord: { href: discord.url || "", icon: discord.icon || "" },
    };
  }

  // Swaps a glyph box's content for an admin-uploaded icon <img>, or leaves
  // whatever fallback markup is already in the HTML (text badge) untouched
  // when no icon has been set — never breaks the layout either way.
  function setGlyphImage(selector, iconUrl) {
    var el = document.querySelector(selector);
    if (!el || !iconUrl) return;
    el.innerHTML = '<img src="' + escapeHTML(iconUrl) + '" alt="">';
  }

  /* -------------------------------------------------------- page chrome */
  function initChrome() {
    var toggle = document.querySelector(".nav-toggle");
    var nav = document.querySelector(".nav");
    if (toggle && nav) {
      toggle.addEventListener("click", function () {
        var open = nav.classList.toggle("is-open");
        toggle.setAttribute("aria-expanded", open ? "true" : "false");
      });
      nav.addEventListener("click", function (e) {
        if (e.target.tagName === "A") {
          nav.classList.remove("is-open");
          toggle.setAttribute("aria-expanded", "false");
        }
      });
    }

    var year = new Date().getFullYear();
    document.querySelectorAll("[data-year]").forEach(function (el) {
      el.textContent = year;
    });

    observeReveals();
  }

  window.MP = {
    CHECKOUT_KEY: "mp_checkout_draft",
    get: function (path) {
      return request(path);
    },
    post: function (path, body) {
      return request(path, { method: "POST", body: JSON.stringify(body || {}) });
    },
    postForm: function (path, formData) {
      return request(path, { method: "POST", body: formData });
    },
    formatIDR: formatIDR,
    formatNumber: formatNumber,
    formatDate: formatDate,
    escapeHTML: escapeHTML,
    initials: initials,
    productCard: productCard,
    debounce: debounce,
    getSocket: getSocket,
    on: on,
    onReconnect: onReconnect,
    toast: toast,
    observeReveals: observeReveals,
    onSettings: onSettings,
    loadSettings: loadSettings,
    contactChannels: contactChannels,
    getSettings: function () {
      return settings;
    },
    STATUS_LABEL: {
      PENDING: "Menunggu pembayaran",
      PAID: "Pembayaran berhasil",
      SUCCESS: "Pembayaran berhasil",
      COMPLETED: "Pesanan selesai",
      FAILED: "Pembayaran gagal",
      EXPIRED: "Kedaluwarsa",
      CANCELLED: "Dibatalkan",
    },
    STATUS_TONE: {
      PENDING: "pending",
      PAID: "ok",
      SUCCESS: "ok",
      COMPLETED: "ok",
      FAILED: "bad",
      EXPIRED: "idle",
      CANCELLED: "idle",
    },
  };

  document.addEventListener("DOMContentLoaded", function () {
    initChrome();
    loadSettings();
    // Settings are edited in Admin Web; these are the existing events.
    on(["website:settings:updated", "navbar:updated", "home:updated", "contact:updated"], debounce(function () {
      loadSettings(true);
    }, 300));
    onReconnect(function () {
      loadSettings(true);
    });
  });
})(window, document);
