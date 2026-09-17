/* ============================================================================
   31 Store — catalog page.
   Filtering, sorting and paging all happen over the list returned by
   /api/products (the endpoint has no filter params, so nothing is faked here:
   the whole active catalogue is fetched once and narrowed in the browser).
   ========================================================================= */
(function () {
  "use strict";

  var $ = function (id) {
    return document.getElementById(id);
  };

  var PAGE = 24;

  var state = {
    products: [],
    categories: [],
    query: "",
    category: "",
    sort: "default",
    inStockOnly: false,
    shown: PAGE,
    loaded: false,
  };

  /* ------------------------------------------------------------ url state */
  function readURL() {
    var params = new URLSearchParams(window.location.search);
    state.query = (params.get("q") || "").trim();
    state.category = (params.get("category") || "").trim();
    var sort = params.get("sort") || "default";
    if (["default", "price-asc", "price-desc", "sold", "name"].indexOf(sort) !== -1) state.sort = sort;
    state.inStockOnly = params.get("stock") === "in";

    $("q").value = state.query;
    $("sort").value = state.sort;
    setStockToggle(state.inStockOnly);
  }

  function writeURL() {
    var params = new URLSearchParams();
    if (state.query) params.set("q", state.query);
    if (state.category) params.set("category", state.category);
    if (state.sort !== "default") params.set("sort", state.sort);
    if (state.inStockOnly) params.set("stock", "in");
    var qs = params.toString();
    window.history.replaceState(null, "", qs ? "?" + qs : window.location.pathname);
  }

  function setStockToggle(on) {
    var btn = $("stock-toggle");
    btn.classList.toggle("is-active", on);
    btn.setAttribute("aria-pressed", on ? "true" : "false");
  }

  /* -------------------------------------------------------------- filtering */
  function categoryIdBySlug(slug) {
    var match = state.categories.filter(function (c) {
      return c.slug === slug;
    })[0];
    return match ? String(match._id) : "";
  }

  function visibleProducts() {
    var q = state.query.toLowerCase();
    var catId = state.category ? categoryIdBySlug(state.category) : "";

    var list = state.products.filter(function (p) {
      if (state.inStockOnly && Number(p.stock) <= 0) return false;
      if (catId) {
        var id = String((p.categoryId && p.categoryId._id) || p.categoryId || "");
        if (id !== catId) return false;
      }
      if (!q) return true;
      var haystack = (p.name || "") + " " + (p.description || "") + " " + ((p.categoryId && p.categoryId.name) || "");
      return haystack.toLowerCase().indexOf(q) !== -1;
    });

    var sorted = list.slice();
    if (state.sort === "price-asc") sorted.sort(function (a, b) { return a.price - b.price; });
    else if (state.sort === "price-desc") sorted.sort(function (a, b) { return b.price - a.price; });
    else if (state.sort === "sold") sorted.sort(function (a, b) { return (b.sold || 0) - (a.sold || 0); });
    else if (state.sort === "name") sorted.sort(function (a, b) { return String(a.name).localeCompare(String(b.name), "id"); });

    return sorted;
  }

  /* --------------------------------------------------------------- render */
  function renderChips() {
    var row = $("category-chips");
    var counts = new Map();
    state.products.forEach(function (p) {
      var id = String((p.categoryId && p.categoryId._id) || p.categoryId || "");
      if (id) counts.set(id, (counts.get(id) || 0) + 1);
    });

    var usable = state.categories.filter(function (c) {
      return counts.has(String(c._id));
    });

    if (!usable.length) {
      row.innerHTML = "";
      return;
    }

    var chips = ['<button class="chip' + (state.category ? "" : " is-active") + '" type="button" data-category="">Semua</button>'];
    usable.forEach(function (c) {
      chips.push(
        '<button class="chip' + (state.category === c.slug ? " is-active" : "") + '" type="button" data-category="' +
          MP.escapeHTML(c.slug) +
          '">' +
          MP.escapeHTML(c.name) +
          " <span class=\"muted\">" + counts.get(String(c._id)) + "</span></button>"
      );
    });
    row.innerHTML = chips.join("");
  }

  function renderGrid() {
    var grid = $("grid");
    var list = visibleProducts();
    var hasFilters = Boolean(state.query || state.category || state.inStockOnly || state.sort !== "default");

    $("reset-filters").hidden = !hasFilters;

    if (!state.loaded) return;

    if (!state.products.length) {
      grid.innerHTML = '<div class="notice" style="grid-column:1/-1"><b>Katalog masih kosong</b>Produk yang ditambahkan lewat panel admin akan muncul di sini secara otomatis.</div>';
      $("result-count").textContent = "0 produk";
      $("load-more").hidden = true;
      return;
    }

    if (!list.length) {
      grid.innerHTML =
        '<div class="notice" style="grid-column:1/-1"><b>Tidak ada produk yang cocok</b>Coba kata kunci lain, atau atur ulang filter untuk melihat seluruh katalog.</div>';
      $("result-count").textContent = "0 dari " + MP.formatNumber(state.products.length) + " produk";
      $("load-more").hidden = true;
      return;
    }

    var page = list.slice(0, state.shown);
    grid.innerHTML = page
      .map(function (p) {
        return MP.productCard(p);
      })
      .join("");

    $("result-count").textContent =
      list.length === state.products.length
        ? MP.formatNumber(list.length) + " produk"
        : MP.formatNumber(list.length) + " dari " + MP.formatNumber(state.products.length) + " produk";

    $("load-more").hidden = page.length >= list.length;
  }

  function update(resetPaging) {
    if (resetPaging) state.shown = PAGE;
    writeURL();
    renderChips();
    renderGrid();
  }

  /* ----------------------------------------------------------------- data */
  async function load() {
    var results = await Promise.allSettled([MP.get("/products"), MP.get("/categories")]);
    if (results[0].status === "fulfilled") state.products = results[0].value.data || [];
    if (results[1].status === "fulfilled") state.categories = results[1].value.data || [];

    var failed = results.filter(function (r) {
      return r.status === "rejected";
    });
    failed.forEach(function (r) {
      console.error("Gagal memuat katalog:", r.reason);
    });

    state.loaded = true;

    if (failed.length === results.length) {
      $("grid").innerHTML = '<div class="notice" style="grid-column:1/-1"><b>Katalog gagal dimuat</b>Periksa koneksi, lalu muat ulang halaman.</div>';
      $("result-count").textContent = "Gagal memuat";
      return;
    }

    // A category deleted in Admin Web should not leave a dead filter behind.
    if (state.category && !categoryIdBySlug(state.category)) state.category = "";

    update(false);
  }

  /* ----------------------------------------------------------------- bind */
  function bind() {
    var onQuery = MP.debounce(function () {
      state.query = ($("q").value || "").trim();
      update(true);
    }, 220);

    $("q").addEventListener("input", onQuery);

    $("filters").addEventListener("submit", function (e) {
      e.preventDefault();
      state.query = ($("q").value || "").trim();
      update(true);
    });

    $("sort").addEventListener("change", function () {
      state.sort = $("sort").value;
      update(true);
    });

    $("stock-toggle").addEventListener("click", function () {
      state.inStockOnly = !state.inStockOnly;
      setStockToggle(state.inStockOnly);
      update(true);
    });

    $("category-chips").addEventListener("click", function (e) {
      var chip = e.target.closest("[data-category]");
      if (!chip) return;
      state.category = chip.dataset.category;
      update(true);
    });

    $("load-more-btn").addEventListener("click", function () {
      state.shown += PAGE;
      renderGrid();
    });

    $("reset-filters").addEventListener("click", function () {
      state.query = "";
      state.category = "";
      state.sort = "default";
      state.inStockOnly = false;
      $("q").value = "";
      $("sort").value = "default";
      setStockToggle(false);
      update(true);
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    readURL();
    bind();
    load();

    var refresh = MP.debounce(function () {
      load();
    }, 300);
    MP.on(["product:created", "product:updated", "product:deleted", "products:updated", "categories:updated", "stock:updated"], refresh);
    MP.onReconnect(refresh);
  });
})();
