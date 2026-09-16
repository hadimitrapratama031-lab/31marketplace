/* ==========================================================================
   Admin Web — semua data berasal dari Express API + MongoDB.
   Tidak ada dummy/mock/hardcoded production data di file ini.
   Realtime memakai Socket.IO (listener dipasang sekali di init).
   ========================================================================== */
(function () {
  "use strict";

  const TOKEN_KEY = "mp_admin_token";
  const LOGIN_URL = "./login.html";
  const { formatIDR, formatDate, escapeHTML, getSocket, debounce } = window.MP;

  /* ---------------------------------------------------------------- state */
  const state = {
    admin: null,
    settings: null,
    categories: [],
    products: [],
    orders: [],
    ordersPagination: { page: 1, limit: 30, total: 0 },
    customers: [],
    customersPagination: { page: 1, limit: 30, total: 0 },
    faqs: [],
    ratings: [],
    integrations: null,
    templates: null,
    currentPage: "dashboard",
    editing: { productId: null, categoryId: null, faqId: null },
  };

  const $ = (id) => document.getElementById(id);
  const qsa = (sel, root = document) => Array.from(root.querySelectorAll(sel));

  /* ------------------------------------------------------------------ api */
  function getToken() {
    return sessionStorage.getItem(TOKEN_KEY);
  }

  function logout() {
    sessionStorage.removeItem(TOKEN_KEY);
    window.location.replace(LOGIN_URL);
  }

  async function api(path, options = {}) {
    const token = getToken();
    const isForm = options.body instanceof FormData;
    const headers = Object.assign({}, options.headers || {});
    if (token) headers.Authorization = "Bearer " + token;
    if (!isForm && options.body !== undefined) headers["Content-Type"] = "application/json";

    const res = await fetch("/api" + path, {
      method: options.method || "GET",
      headers,
      body: isForm ? options.body : options.body !== undefined ? JSON.stringify(options.body) : undefined,
      credentials: "same-origin",
    });

    let payload = null;
    try {
      payload = await res.json();
    } catch (e) {
      payload = null;
    }

    if (res.status === 401) {
      logout();
      throw new Error("Sesi berakhir. Silakan login kembali.");
    }

    if (!res.ok || (payload && payload.status === false)) {
      const err = new Error((payload && payload.message) || "Terjadi kesalahan (" + res.status + ").");
      err.status = res.status;
      throw err;
    }
    return payload;
  }

  /* ------------------------------------------------------------ ui helpers */
  let toastTimer = null;
  function showToast(message, kind) {
    const el = $("toast");
    el.textContent = message;
    el.dataset.kind = kind || "info";
    el.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove("show"), 3200);
  }

  function openModal(id) {
    $(id).classList.add("open");
  }
  function closeModal(id) {
    $(id).classList.remove("open");
  }

  // Loading yang nyata: tombol dikunci selama request berjalan, bukan setTimeout palsu.
  async function withBusy(button, label, fn) {
    if (!button) return fn();
    const original = button.textContent;
    button.disabled = true;
    button.textContent = label || "Memproses...";
    try {
      return await fn();
    } finally {
      button.disabled = false;
      button.textContent = original;
    }
  }

  function statusBadge(value) {
    const v = String(value || "").toUpperCase();
    const cls =
      v === "PAID" || v === "SUCCESS" || v === "COMPLETED"
        ? "paid"
        : v === "PENDING"
        ? "pending"
        : v === "PROCESSING"
        ? "processing"
        : "failed";
    return '<span class="status ' + cls + '">' + escapeHTML(v || "-") + "</span>";
  }

  function badge(text, kind) {
    return '<span class="status ' + kind + '">' + escapeHTML(String(text).toUpperCase()) + "</span>";
  }

  function stars(value) {
    const n = Math.round(Number(value) || 0);
    return "★".repeat(Math.max(0, Math.min(5, n))) + "☆".repeat(Math.max(0, 5 - n));
  }

  function emptyRow(colspan, message) {
    return '<tr><td colspan="' + colspan + '" class="empty-cell">' + escapeHTML(message) + "</td></tr>";
  }

  function emptyBlock(message) {
    return '<div class="empty-block">' + escapeHTML(message) + "</div>";
  }

  /* ---------------------------------------------------------------- router */
  const PAGE_TITLES = {
    dashboard: "Dashboard",
    orders: "Pesanan",
    products: "Produk",
    categories: "Kategori",
    customers: "Customer",
    content: "Konten Marketplace",
    faq: "FAQ",
    reviews: "Rating",
    integrations: "Integrasi",
    settings: "Pengaturan",
  };

  const LOADERS = {
    dashboard: loadDashboard,
    orders: loadOrders,
    products: loadProducts,
    categories: loadCategories,
    customers: loadCustomers,
    content: loadSettings,
    faq: loadFaqs,
    reviews: loadRatings,
    integrations: loadIntegrations,
    settings: loadAccountPage,
  };

  function showPage(id) {
    if (!PAGE_TITLES[id]) id = "dashboard";
    state.currentPage = id;
    qsa(".page").forEach((p) => p.classList.toggle("active", p.id === id));
    qsa(".nav-item").forEach((b) => b.classList.toggle("active", b.dataset.page === id));
    $("pageTitle").textContent = PAGE_TITLES[id];
    $("crumb").textContent = PAGE_TITLES[id].toUpperCase();
    window.location.hash = id;
    const loader = LOADERS[id];
    if (loader) loader().catch((err) => showToast(err.message, "error"));
  }

  /* ------------------------------------------------------------- dashboard */
  async function loadDashboard() {
    const [summary, stats, orders, products] = await Promise.all([
      api("/orders/admin/summary"),
      api("/statistics"),
      api("/orders/admin/all?limit=5"),
      api("/products/admin/all"),
    ]);

    const s = summary.data;
    const st = stats.data;

    $("statRevenue").textContent = formatIDR(s.totalRevenue);
    renderDelta($("statRevenueDelta"), s.revenueDeltaPercent, "vs bulan lalu");
    $("statOrders").textContent = String(s.totalOrders);
    renderDelta($("statOrdersDelta"), s.ordersDeltaPercent, "vs bulan lalu");
    $("statCustomers").textContent = String(st.totalBuyer);
    $("statCustomersSub").textContent = st.successfulOrders + " order berhasil";
    $("statRating").textContent = st.ratingCount ? st.averageRating + " / 5" : "Belum ada";
    $("statRatingSub").textContent = st.ratingCount + " review disetujui";
    $("statRatingStars").textContent = st.ratingCount ? stars(st.averageRating) : "";

    // Mini chart = pendapatan 7 hari terakhir yang nyata.
    const max = Math.max.apply(null, s.daily.map((d) => d.revenue).concat([1]));
    $("revenueChart").innerHTML = s.daily
      .map(
        (d) =>
          '<b style="height:' +
          Math.max(6, Math.round((d.revenue / max) * 100)) +
          '%" title="' +
          escapeHTML(d.date) +
          " · " +
          escapeHTML(formatIDR(d.revenue)) +
          '"></b>'
      )
      .join("");

    state.orders = orders.data;
    $("recentOrders").innerHTML =
      orders.data
        .map(
          (o) =>
            "<tr><td class=\"order-id\">" +
            escapeHTML(o.orderCode) +
            "</td><td>" +
            escapeHTML(o.customer.name || o.customer.email) +
            "</td><td>" +
            escapeHTML(o.product.name) +
            "</td><td><b>" +
            formatIDR(o.total) +
            "</b></td><td>" +
            statusBadge(o.status) +
            "</td></tr>"
        )
        .join("") || emptyRow(5, "Belum ada pesanan.");

    state.products = products.data;
    const best = products.data.slice().sort((a, b) => b.sold - a.sold).slice(0, 5);
    $("bestProducts").innerHTML =
      best
        .map(
          (p) =>
            '<div class="best"><div class="best-img">' +
            (p.image ? '<img src="' + escapeHTML(p.image) + '" alt="" loading="lazy">' : escapeHTML(p.name.charAt(0))) +
            "</div><div><b>" +
            escapeHTML(p.name) +
            "</b><small>" +
            p.sold +
            " terjual · stok " +
            p.stock +
            "</small></div><strong>" +
            formatIDR(p.price) +
            "</strong></div>"
        )
        .join("") || emptyBlock("Belum ada produk.");

    updateOrderBadge(s.pendingPayments);
  }

  function renderDelta(el, percent, suffix) {
    if (percent === null || percent === undefined) {
      el.className = "neutral";
      el.textContent = "Belum ada pembanding bulan lalu";
      return;
    }
    el.className = percent >= 0 ? "up" : "down";
    el.innerHTML = (percent >= 0 ? "↑ " : "↓ ") + Math.abs(percent) + "% <i>" + escapeHTML(suffix) + "</i>";
  }

  function updateOrderBadge(count) {
    const badge = $("orderBadge");
    badge.textContent = String(count || 0);
    badge.hidden = !count;
  }

  /* ---------------------------------------------------------------- orders */
  async function loadOrders() {
    const params = new URLSearchParams();
    const status = $("orderStatusFilter").value;
    const paymentStatus = $("paymentStatusFilter").value;
    if (status) params.set("status", status);
    if (paymentStatus) params.set("paymentStatus", paymentStatus);
    params.set("page", String(state.ordersPagination.page));
    params.set("limit", String(state.ordersPagination.limit));

    const res = await api("/orders/admin/all?" + params.toString());
    state.orders = res.data;
    state.ordersPagination = res.pagination;
    renderOrders();
  }

  function renderOrders() {
    const q = ($("orderSearch").value || "").toLowerCase().trim();
    const list = q
      ? state.orders.filter((o) =>
          [o.orderCode, o.customer.name, o.customer.email, o.customer.whatsapp, o.product.name]
            .join(" ")
            .toLowerCase()
            .includes(q)
        )
      : state.orders;

    $("ordersTable").innerHTML =
      list
        .map(
          (o) =>
            '<tr><td class="order-id">' +
            escapeHTML(o.orderCode) +
            "</td><td><b>" +
            escapeHTML(o.customer.name || "-") +
            "</b><small class=\"sub\">" +
            escapeHTML(o.customer.email) +
            "</small></td><td>" +
            escapeHTML(o.product.name) +
            "</td><td>" +
            o.quantity +
            "</td><td>" +
            escapeHTML(formatDate(o.createdAt)) +
            "</td><td><b>" +
            formatIDR(o.total) +
            "</b></td><td>" +
            statusBadge(o.paymentStatus) +
            "</td><td>" +
            statusBadge(o.status) +
            '</td><td><button class="icon-btn" type="button" data-order-detail="' +
            o._id +
            '">•••</button></td></tr>'
        )
        .join("") || emptyRow(9, q ? "Tidak ada order yang cocok." : "Belum ada pesanan.");

    renderPager($("ordersPager"), state.ordersPagination, (page) => {
      state.ordersPagination.page = page;
      loadOrders().catch((err) => showToast(err.message, "error"));
    });
  }

  function renderPager(container, pagination, onGo) {
    const pages = Math.max(1, Math.ceil(pagination.total / pagination.limit));
    if (pages <= 1) {
      container.innerHTML = "";
      return;
    }
    container.innerHTML =
      '<button class="outline" type="button" data-pg="prev"' +
      (pagination.page <= 1 ? " disabled" : "") +
      ">← Sebelumnya</button><span>Halaman " +
      pagination.page +
      " dari " +
      pages +
      ' (' + pagination.total + ' data)</span><button class="outline" type="button" data-pg="next"' +
      (pagination.page >= pages ? " disabled" : "") +
      ">Berikutnya →</button>";

    container.onclick = (e) => {
      const btn = e.target.closest("[data-pg]");
      if (!btn || btn.disabled) return;
      onGo(btn.dataset.pg === "prev" ? pagination.page - 1 : pagination.page + 1);
    };
  }

  async function openOrderDetail(id) {
    openModal("orderModal");
    $("orderModalBody").innerHTML = '<div class="empty-block">Memuat detail order...</div>';
    try {
      const res = await api("/orders/admin/" + id);
      const { order, transaction } = res.data;
      $("orderModalTitle").textContent = order.orderCode;
      $("orderModalBody").innerHTML =
        detailRow("Order Code", order.orderCode) +
        detailRow("Tanggal", formatDate(order.createdAt)) +
        detailRow("Order Status", order.status) +
        detailRow("Payment Status", order.paymentStatus) +
        '<hr class="detail-sep">' +
        detailRow("Nama", order.customer.name || "-") +
        detailRow("Email", order.customer.email) +
        detailRow("WhatsApp", order.customer.whatsapp) +
        '<hr class="detail-sep">' +
        detailRow("Produk", order.product.name) +
        detailRow("Harga satuan", formatIDR(order.product.price)) +
        detailRow("Quantity", order.quantity) +
        detailRow("Total", formatIDR(order.total)) +
        (transaction
          ? '<hr class="detail-sep">' +
            detailRow("Gateway", transaction.paymentGateway) +
            detailRow("Transaction ID", transaction.transactionId) +
            detailRow("Nominal dibayar", transaction.totalAmount ? formatIDR(transaction.totalAmount) : "-") +
            detailRow("Status transaksi", transaction.status) +
            detailRow("Kedaluwarsa", transaction.expiredAt ? formatDate(transaction.expiredAt) : "-") +
            detailRow("Dibayar pada", transaction.paidAt ? formatDate(transaction.paidAt) : "-")
          : '<hr class="detail-sep"><div class="empty-block">Belum ada transaksi pembayaran untuk order ini.</div>');
    } catch (err) {
      $("orderModalBody").innerHTML = '<div class="empty-block">' + escapeHTML(err.message) + "</div>";
    }
  }

  function detailRow(label, value) {
    return '<div class="detail-row"><span>' + escapeHTML(label) + "</span><b>" + escapeHTML(String(value)) + "</b></div>";
  }

  /* -------------------------------------------------------------- products */
  async function loadProducts() {
    const [products, categories] = await Promise.all([api("/products/admin/all"), api("/categories/admin/all")]);
    state.products = products.data;
    state.categories = categories.data;
    syncCategoryOptions();
    renderProducts();
  }

  function syncCategoryOptions() {
    const filter = $("categoryFilter");
    const keep = filter.value;
    filter.innerHTML =
      '<option value="">Semua Kategori</option>' +
      state.categories
        .map((c) => '<option value="' + c._id + '">' + escapeHTML(c.name) + "</option>")
        .join("");
    filter.value = state.categories.some((c) => c._id === keep) ? keep : "";

    const modalSelect = $("pCategory");
    const keepModal = modalSelect.value;
    modalSelect.innerHTML = state.categories.length
      ? state.categories.map((c) => '<option value="' + c._id + '">' + escapeHTML(c.name) + "</option>").join("")
      : '<option value="">Belum ada kategori</option>';
    if (state.categories.some((c) => c._id === keepModal)) modalSelect.value = keepModal;
  }

  function renderProducts() {
    const q = ($("productSearch").value || "").toLowerCase().trim();
    const cat = $("categoryFilter").value;
    const status = $("productStatusFilter").value;

    const list = state.products.filter((p) => {
      const catId = p.categoryId && p.categoryId._id ? p.categoryId._id : p.categoryId;
      return (
        (!q || p.name.toLowerCase().includes(q)) &&
        (!cat || String(catId) === cat) &&
        (!status || p.status === status)
      );
    });

    $("productGrid").innerHTML =
      list
        .map((p) => {
          const catName = p.categoryId && p.categoryId.name ? p.categoryId.name : "TANPA KATEGORI";
          return (
            '<article class="product-admin"><div class="p-img">' +
            (p.image
              ? '<img src="' + escapeHTML(p.image) + '" alt="" loading="lazy">'
              : '<span class="no-image">Tanpa gambar</span>') +
            '<span class="category">' +
            escapeHTML(catName.toUpperCase()) +
            "</span>" +
            (p.status === "inactive" ? '<span class="inactive-flag">INACTIVE</span>' : "") +
            '</div><div class="p-body"><h3>' +
            escapeHTML(p.name) +
            "</h3><p>" +
            escapeHTML(p.description || "Tanpa deskripsi.") +
            '</p><div class="p-meta"><strong>' +
            formatIDR(p.price) +
            "</strong><small>" +
            p.stock +
            " stok · " +
            p.sold +
            ' terjual</small></div><div class="p-actions"><button type="button" data-edit-product="' +
            p._id +
            '">Edit Produk</button><button class="danger" type="button" data-delete-product="' +
            p._id +
            '">Hapus</button></div></div></article>'
          );
        })
        .join("") ||
      '<div class="panel empty-block" style="grid-column:1/-1">' +
        (state.products.length ? "Produk tidak ditemukan." : "Belum ada produk. Tambahkan produk pertama kamu.") +
        "</div>";
  }

  let pendingImageFile = null;

  function openProductModal(id) {
    if (!state.categories.length) {
      showToast("Buat minimal satu kategori dulu sebelum menambah produk.", "error");
      showPage("categories");
      return;
    }
    state.editing.productId = id || null;
    pendingImageFile = null;
    const p = id ? state.products.find((x) => x._id === id) : null;

    $("productModalTitle").textContent = p ? "Edit Produk" : "Tambah Produk";
    $("pName").value = p ? p.name : "";
    $("pCategory").value = p ? (p.categoryId && p.categoryId._id ? p.categoryId._id : p.categoryId) : state.categories[0]._id;
    $("pStatus").value = p ? p.status : "active";
    $("pPrice").value = p ? p.price : "";
    $("pStock").value = p ? p.stock : 0;
    $("pSortOrder").value = p ? p.sortOrder : 0;
    $("pDesc").value = p ? p.description || "" : "";

    const drop = $("imageDrop");
    $("imageInput").value = "";
    $("imagePreview").src = p && p.image ? p.image : "";
    drop.classList.toggle("has-image", Boolean(p && p.image));
    openModal("productModal");
  }

  async function submitProduct(e) {
    e.preventDefault();
    const form = new FormData();
    form.append("name", $("pName").value.trim());
    form.append("categoryId", $("pCategory").value);
    form.append("status", $("pStatus").value);
    form.append("price", $("pPrice").value);
    form.append("stock", $("pStock").value);
    form.append("sortOrder", $("pSortOrder").value || "0");
    form.append("description", $("pDesc").value.trim());
    if (pendingImageFile) form.append("image", pendingImageFile);

    const id = state.editing.productId;
    await withBusy($("productSubmit"), "Menyimpan...", async () => {
      try {
        await api(id ? "/products/admin/" + id : "/products/admin", { method: id ? "PUT" : "POST", body: form });
        closeModal("productModal");
        showToast(id ? "Produk diperbarui." : "Produk ditambahkan.", "success");
        await loadProducts();
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  }

  async function deleteProduct(id) {
    const p = state.products.find((x) => x._id === id);
    if (!window.confirm('Hapus produk "' + (p ? p.name : "") + '"? Tindakan ini tidak bisa dibatalkan.')) return;
    try {
      await api("/products/admin/" + id, { method: "DELETE" });
      showToast("Produk dihapus.", "success");
      await loadProducts();
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  /* ------------------------------------------------------------ categories */
  async function loadCategories() {
    const res = await api("/categories/admin/all");
    state.categories = res.data;
    syncCategoryOptions();
    renderCategories();
  }

  function renderCategories() {
    $("categoriesTable").innerHTML =
      state.categories
        .map(
          (c) =>
            "<tr><td><b>" +
            escapeHTML(c.name) +
            "</b></td><td><code>" +
            escapeHTML(c.slug) +
            "</code></td><td>" +
            escapeHTML(c.icon || "-") +
            "</td><td>" +
            escapeHTML(c.description || "-") +
            "</td><td>" +
            c.sortOrder +
            "</td><td>" +
            badge(c.status, c.status === "active" ? "paid" : "pending") +
            '</td><td class="row-actions"><button class="icon-btn" type="button" data-edit-category="' +
            c._id +
            '">Edit</button><button class="icon-btn danger" type="button" data-delete-category="' +
            c._id +
            '">Hapus</button></td></tr>'
        )
        .join("") || emptyRow(7, "Belum ada kategori.");
  }

  function openCategoryModal(id) {
    state.editing.categoryId = id || null;
    const c = id ? state.categories.find((x) => x._id === id) : null;
    $("categoryModalTitle").textContent = c ? "Edit Kategori" : "Tambah Kategori";
    $("cName").value = c ? c.name : "";
    $("cIcon").value = c ? c.icon || "" : "";
    $("cSortOrder").value = c ? c.sortOrder : 0;
    $("cStatus").value = c ? c.status : "active";
    $("cDesc").value = c ? c.description || "" : "";
    openModal("categoryModal");
  }

  async function submitCategory(e) {
    e.preventDefault();
    const body = {
      name: $("cName").value.trim(),
      icon: $("cIcon").value.trim(),
      description: $("cDesc").value.trim(),
      status: $("cStatus").value,
      sortOrder: Number($("cSortOrder").value) || 0,
    };
    const id = state.editing.categoryId;
    await withBusy($("categorySubmit"), "Menyimpan...", async () => {
      try {
        await api(id ? "/categories/admin/" + id : "/categories/admin", { method: id ? "PUT" : "POST", body });
        closeModal("categoryModal");
        showToast(id ? "Kategori diperbarui." : "Kategori ditambahkan.", "success");
        await loadCategories();
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  }

  async function deleteCategory(id) {
    const c = state.categories.find((x) => x._id === id);
    if (!window.confirm('Hapus kategori "' + (c ? c.name : "") + '"?')) return;
    try {
      await api("/categories/admin/" + id, { method: "DELETE" });
      showToast("Kategori dihapus.", "success");
      await loadCategories();
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  /* ------------------------------------------------------------- customers */
  async function loadCustomers() {
    const params = new URLSearchParams();
    const search = ($("customerSearch").value || "").trim();
    if (search) params.set("search", search);
    params.set("page", String(state.customersPagination.page));
    params.set("limit", String(state.customersPagination.limit));

    const res = await api("/customers/admin/all?" + params.toString());
    state.customers = res.data;
    state.customersPagination = res.pagination;

    $("customersTable").innerHTML =
      res.data
        .map(
          (c) =>
            "<tr><td><b>" +
            escapeHTML(c.name || "-") +
            "</b></td><td>" +
            escapeHTML(c.email) +
            "</td><td>" +
            escapeHTML(c.whatsapp) +
            "</td><td>" +
            c.orderCount +
            "</td><td>" +
            c.paidOrderCount +
            "</td><td><b>" +
            formatIDR(c.totalSpent) +
            "</b></td><td>" +
            escapeHTML(c.lastOrderAt ? formatDate(c.lastOrderAt) : "-") +
            "</td></tr>"
        )
        .join("") || emptyRow(7, search ? "Customer tidak ditemukan." : "Belum ada customer.");

    renderPager($("customersPager"), state.customersPagination, (page) => {
      state.customersPagination.page = page;
      loadCustomers().catch((err) => showToast(err.message, "error"));
    });
  }

  /* --------------------------------------------------- website settings UI */
  async function loadSettings() {
    const res = await api("/settings/admin");
    state.settings = res.data;
    fillSettingsForm(state.settings);
    applyBranding(state.settings);
  }

  function fillSettingsForm(s) {
    qsa("[data-section][data-field]").forEach((el) => {
      const section = s[el.dataset.section];
      if (!section) return;
      const value = section[el.dataset.field];
      if (el.type === "checkbox") el.checked = Boolean(value);
      else if (el.type === "color") el.value = /^#[0-9a-f]{6}$/i.test(String(value || "")) ? value : "#000000";
      else el.value = value === undefined || value === null ? "" : value;
    });

    setPreview("preview-general-logo", s.general.logo);
    setPreview("preview-general-favicon", s.general.favicon);
    setPreview("preview-contact-logo", s.contact.logo);
    setPreview("preview-footer-logo", s.footer.logo);
    setPreview("preview-background-image", s.background.image);

    renderNavbarItems(s.navbar.items || []);
    renderStatisticsItems(s.statistics || {});
    renderHighlights(s.highlights || []);
    renderFooterLinks(s.footer.links || []);
    renderFooterSocial(s.footer.social || []);
  }

  function setPreview(id, url) {
    const img = $(id);
    if (!img) return;
    img.src = url || "";
    img.classList.toggle("has-src", Boolean(url));
  }

  function applyBranding(s) {
    const name = (s.general && s.general.storeName) || "Admin";
    $("brandName").textContent = name;
    $("brandMark").textContent = name.trim().charAt(0).toUpperCase() || "·";
    $("crumbStore").textContent = name.toUpperCase();
    document.title = "Admin Panel — " + name;

    const online = !s.general || s.general.websiteStatus === "online";
    $("storeStatusText").textContent = online ? "Store Online" : "Mode Maintenance";
    $("storeStatus").dataset.state = online ? "online" : "maintenance";
  }

  /* --- repeatable rows --- */
  function repeatRow(inner, index) {
    return (
      '<div class="repeat-row" data-index="' +
      index +
      '"><div class="repeat-fields">' +
      inner +
      '</div><div class="repeat-actions"><button class="icon-btn" type="button" data-move="up">↑</button><button class="icon-btn" type="button" data-move="down">↓</button><button class="icon-btn danger" type="button" data-remove="1">✕</button></div></div>'
    );
  }

  function renderNavbarItems(items) {
    $("navbarItems").innerHTML =
      items
        .map((item, i) =>
          repeatRow(
            '<label>Label<input data-key="label" value="' +
              escapeHTML(item.label || "") +
              '"></label><label>Route<input data-key="route" value="' +
              escapeHTML(item.route || "") +
              '"></label><label>Icon<input data-key="icon" value="' +
              escapeHTML(item.icon || "") +
              '"></label><label class="inline-check">Aktif<input type="checkbox" data-key="enabled"' +
              (item.enabled !== false ? " checked" : "") +
              "></label>",
            i
          )
        )
        .join("") || emptyBlock("Belum ada menu navbar.");
  }

  const STAT_KEYS = [
    ["totalProdukTerjual", "Total Produk Terjual"],
    ["averageRating", "Average Rating"],
    ["totalBuyer", "Total Buyer"],
    ["totalProduk", "Total Produk"],
    ["successfulOrders", "Successful Orders"],
    ["support", "Support"],
  ];

  function renderStatisticsItems(statistics) {
    const saved = Array.isArray(statistics.order) && statistics.order.length ? statistics.order : STAT_KEYS.map((k) => k[0]);
    const ordered = saved.filter((k) => STAT_KEYS.some((s) => s[0] === k));
    STAT_KEYS.forEach((s) => {
      if (!ordered.includes(s[0])) ordered.push(s[0]);
    });

    $("statisticsItems").innerHTML = ordered
      .map((key, i) => {
        const label = (STAT_KEYS.find((s) => s[0] === key) || [key, key])[1];
        const visibleField = key + "Visible";
        const hasToggle = key !== "support";
        return repeatRow(
          '<label>Statistik<input data-key="key" value="' +
            escapeHTML(key) +
            '" readonly></label><label>Label<input data-key="label" value="' +
            escapeHTML(label) +
            '" readonly></label>' +
            (hasToggle
              ? '<label class="inline-check">Tampilkan<input type="checkbox" data-key="visible"' +
                (statistics[visibleField] !== false ? " checked" : "") +
                "></label>"
              : '<label class="inline-check">Selalu tampil<input type="checkbox" data-key="visible" checked disabled></label>'),
          i
        );
      })
      .join("");
  }

  function renderHighlights(items) {
    $("highlightItems").innerHTML =
      items
        .map((item, i) =>
          repeatRow(
            '<label>Icon<input data-key="icon" value="' +
              escapeHTML(item.icon || "") +
              '"></label><label>Judul<input data-key="title" value="' +
              escapeHTML(item.title || "") +
              '"></label><label class="wide">Deskripsi<textarea data-key="description">' +
              escapeHTML(item.description || "") +
              '</textarea></label><label class="inline-check">Aktif<input type="checkbox" data-key="enabled"' +
              (item.enabled !== false ? " checked" : "") +
              "></label>",
            i
          )
        )
        .join("") || emptyBlock("Belum ada highlight.");
  }

  function renderFooterLinks(links) {
    $("footerLinks").innerHTML =
      links
        .map((l, i) =>
          repeatRow(
            '<label>Label<input data-key="label" value="' +
              escapeHTML(l.label || "") +
              '"></label><label>URL<input data-key="url" value="' +
              escapeHTML(l.url || "") +
              '"></label>',
            i
          )
        )
        .join("") || emptyBlock("Belum ada link footer.");
  }

  function renderFooterSocial(social) {
    $("footerSocial").innerHTML =
      social
        .map((s, i) =>
          repeatRow(
            '<label>Platform<input data-key="platform" value="' +
              escapeHTML(s.platform || "") +
              '"></label><label>URL<input data-key="url" value="' +
              escapeHTML(s.url || "") +
              '"></label>',
            i
          )
        )
        .join("") || emptyBlock("Belum ada social link.");
  }

  function collectRows(containerId) {
    return qsa("#" + containerId + " .repeat-row").map((row, index) => {
      const obj = { sortOrder: index };
      qsa("[data-key]", row).forEach((field) => {
        obj[field.dataset.key] = field.type === "checkbox" ? field.checked : field.value;
      });
      return obj;
    });
  }

  function collectSectionFields(section) {
    const data = {};
    qsa('[data-section="' + section + '"][data-field]').forEach((el) => {
      data[el.dataset.field] = el.type === "checkbox" ? el.checked : el.value;
    });
    return data;
  }

  function buildSectionPayload(section) {
    if (section === "highlights") {
      return collectRows("highlightItems").map((r) => ({
        icon: r.icon,
        title: r.title,
        description: r.description,
        enabled: r.enabled,
        sortOrder: r.sortOrder,
      }));
    }

    const data = collectSectionFields(section);

    if (section === "navbar") {
      data.items = collectRows("navbarItems").map((r) => ({
        label: r.label,
        route: r.route,
        icon: r.icon,
        enabled: r.enabled,
        sortOrder: r.sortOrder,
      }));
    }

    if (section === "statistics") {
      const rows = collectRows("statisticsItems");
      data.order = rows.map((r) => r.key);
      rows.forEach((r) => {
        if (r.key !== "support") data[r.key + "Visible"] = r.visible;
      });
    }

    if (section === "footer") {
      data.links = collectRows("footerLinks").map((r) => ({ label: r.label, url: r.url }));
      data.social = collectRows("footerSocial").map((r) => ({ platform: r.platform, url: r.url }));
    }

    return data;
  }

  async function saveSection(section, button) {
    await withBusy(button, "Menyimpan...", async () => {
      try {
        const res = await api("/settings/admin/" + section, { method: "PATCH", body: buildSectionPayload(section) });
        state.settings = res.data;
        fillSettingsForm(state.settings);
        applyBranding(state.settings);
        showToast("Section " + section + " tersimpan dan dikirim ke Marketplace.", "success");
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  }

  async function uploadAsset(input) {
    const file = input.files && input.files[0];
    if (!file) return;
    const [section, field] = input.dataset.uploadTarget.split(".");
    const form = new FormData();
    form.append("file", file);
    form.append("folder", input.dataset.uploadFolder || "settings");

    const box = input.closest(".asset-box");
    if (box) box.classList.add("uploading");
    try {
      const res = await api("/settings/admin/upload", { method: "POST", body: form });
      const hidden = document.querySelector('[data-section="' + section + '"][data-field="' + field + '"]');
      if (hidden) hidden.value = res.data.url;
      setPreview("preview-" + section + "-" + field, res.data.url);
      showToast("File terupload ke R2. Klik Simpan untuk menerapkannya.", "success");
    } catch (err) {
      showToast(err.message, "error");
    } finally {
      if (box) box.classList.remove("uploading");
      input.value = "";
    }
  }

  /* ------------------------------------------------------------------- faq */
  async function loadFaqs() {
    const res = await api("/faq/admin/all");
    state.faqs = res.data;
    $("faqAdmin").innerHTML =
      res.data
        .map(
          (f, i) =>
            '<div class="faq-row"><div class="faq-num">' +
            String(i + 1).padStart(2, "0") +
            "</div><main><b>" +
            escapeHTML(f.question) +
            "</b><p>" +
            escapeHTML(f.answer) +
            "</p>" +
            (f.enabled ? "" : '<small class="muted-flag">Disembunyikan dari Marketplace</small>') +
            '</main><button type="button" data-edit-faq="' +
            f._id +
            '">Edit</button><button type="button" data-delete-faq="' +
            f._id +
            '">Hapus</button></div>'
        )
        .join("") || emptyBlock("Belum ada FAQ.");
  }

  function openFaqModal(id) {
    state.editing.faqId = id || null;
    const f = id ? state.faqs.find((x) => x._id === id) : null;
    $("faqModalTitle").textContent = f ? "Edit FAQ" : "Tambah FAQ";
    $("fQuestion").value = f ? f.question : "";
    $("fAnswer").value = f ? f.answer : "";
    $("fSortOrder").value = f ? f.sortOrder : 0;
    $("fEnabled").value = f ? String(f.enabled) : "true";
    openModal("faqModal");
  }

  async function submitFaq(e) {
    e.preventDefault();
    const body = {
      question: $("fQuestion").value.trim(),
      answer: $("fAnswer").value.trim(),
      sortOrder: Number($("fSortOrder").value) || 0,
      enabled: $("fEnabled").value === "true",
    };
    const id = state.editing.faqId;
    await withBusy($("faqSubmit"), "Menyimpan...", async () => {
      try {
        await api(id ? "/faq/admin/" + id : "/faq/admin", { method: id ? "PUT" : "POST", body });
        closeModal("faqModal");
        showToast(id ? "FAQ diperbarui." : "FAQ ditambahkan.", "success");
        await loadFaqs();
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  }

  async function deleteFaq(id) {
    if (!window.confirm("Hapus FAQ ini?")) return;
    try {
      await api("/faq/admin/" + id, { method: "DELETE" });
      showToast("FAQ dihapus.", "success");
      await loadFaqs();
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  /* --------------------------------------------------------------- ratings */
  async function loadRatings() {
    const status = $("ratingStatusFilter").value;
    const [res, stats] = await Promise.all([
      api("/ratings/admin/all" + (status ? "?status=" + status : "")),
      api("/statistics"),
    ]);
    state.ratings = res.data;

    const approved = res.data.filter((r) => r.status === "approved");
    $("ratingAvg").textContent = stats.data.ratingCount ? stats.data.averageRating : "—";
    $("ratingStars").textContent = stats.data.ratingCount ? stars(stats.data.averageRating) : "";
    $("ratingTotal").textContent = stats.data.ratingCount + " review disetujui";

    const buckets = [5, 4, 3, 2, 1].map((n) => ({ n, count: approved.filter((r) => Math.round(r.rating) === n).length }));
    const maxBucket = Math.max.apply(null, buckets.map((b) => b.count).concat([1]));
    $("ratingBars").innerHTML = buckets
      .map(
        (b) =>
          "<div>" +
          b.n +
          ' <i><b style="width:' +
          Math.round((b.count / maxBucket) * 100) +
          '%"></b></i><small>' +
          b.count +
          "</small></div>"
      )
      .join("");

    const pending = state.ratings.filter((r) => r.status === "pending").length;
    const badge = $("ratingBadge");
    badge.textContent = String(pending);
    badge.hidden = !pending;

    $("reviewAdmin").innerHTML =
      res.data
        .map(
          (r) =>
            '<div class="review-card"><div class="r-head"><div><b>' +
            escapeHTML(r.user) +
            '</b><div style="margin-top:5px"><span>' +
            stars(r.rating) +
            "</span> " +
            badge(r.status, r.status === "approved" ? "paid" : r.status === "pending" ? "pending" : "failed") +
            '</div></div><div class="row-actions">' +
            (r.status !== "approved"
              ? '<button type="button" data-rating-status="approved" data-id="' + r._id + '">Approve</button>'
              : "") +
            (r.status !== "hidden"
              ? '<button type="button" data-rating-status="hidden" data-id="' + r._id + '">Hide</button>'
              : "") +
            '<button type="button" class="danger" data-delete-rating="' +
            r._id +
            '">Hapus</button></div></div><p>' +
            escapeHTML(r.review) +
            "</p><small>" +
            escapeHTML(formatDate(r.createdAt)) +
            "</small></div>"
        )
        .join("") || emptyBlock("Belum ada review.");
  }

  async function setRatingStatus(id, status) {
    try {
      await api("/ratings/admin/" + id + "/status", { method: "PATCH", body: { status } });
      showToast("Status review diperbarui.", "success");
      await loadRatings();
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  async function deleteRating(id) {
    if (!window.confirm("Hapus review ini secara permanen?")) return;
    try {
      await api("/ratings/admin/" + id, { method: "DELETE" });
      showToast("Review dihapus.", "success");
      await loadRatings();
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  /* ---------------------------------------------------------- integrations */
  const PROVIDER_LABEL = { klikqris: "KlikQRIS", fonnte: "Fonnte", resend: "Resend", r2: "Cloudflare R2" };

  async function loadIntegrations() {
    const [statusRes, templatesRes] = await Promise.all([api("/integrations/status"), api("/integrations/templates")]);
    state.integrations = statusRes.data;
    state.templates = templatesRes.data;
    renderIntegrationStatus();
    fillIntegrationForms();
    fillTemplateForms();
  }

  function providerState(info, provider) {
    if (!info.configured) return { cls: "off", text: "Not Configured" };
    if (info.lastTestStatus === "error") return { cls: "error", text: "Error" };
    if (provider !== "r2" && !info.enabled) return { cls: "off", text: "Dinonaktifkan" };
    if (info.lastTestStatus === "success") return { cls: "ok", text: "Connected" };
    return { cls: "warn", text: "Terkonfigurasi (belum dites)" };
  }

  function renderIntegrationStatus() {
    $("integrationStatus").innerHTML = ["klikqris", "fonnte", "resend", "r2"]
      .map((key) => {
        const info = state.integrations[key];
        const st = providerState(info, key);
        return (
          '<div class="integration-card"><div class="integration-head"><b>' +
          PROVIDER_LABEL[key] +
          '</b><span class="dot-status ' +
          st.cls +
          '"></span></div><span class="integration-state">' +
          escapeHTML(st.text) +
          "</span><small>" +
          escapeHTML(info.lastTestAt ? "Test terakhir: " + formatDate(info.lastTestAt) : "Belum pernah dites") +
          "</small>" +
          (info.lastTestMessage ? "<small>" + escapeHTML(info.lastTestMessage) + "</small>" : "") +
          "</div>"
        );
      })
      .join("");
  }

  function fillIntegrationForms() {
    const i = state.integrations;

    $("kqEnabled").checked = Boolean(i.klikqris.enabled);
    $("kqMode").value = i.klikqris.mode || "production";
    $("kqApiKeyMasked").value = i.klikqris.apiKeyMasked || "";
    $("kqApiKey").value = "";
    $("kqMerchantId").value = "";

    $("fnEnabled").checked = Boolean(i.fonnte.enabled);
    $("fnTokenMasked").value = i.fonnte.tokenMasked || "";
    $("fnToken").value = "";

    $("rsEnabled").checked = Boolean(i.resend.enabled);
    $("rsApiKeyMasked").value = i.resend.apiKeyMasked || "";
    $("rsApiKey").value = "";
    $("rsFromEmail").value = i.resend.fromEmail || "";
    $("rsFromName").value = i.resend.fromName || "";

    const r2State = providerState(i.r2, "r2");
    $("r2StatusText").value = r2State.text;
    $("r2LastTest").value = i.r2.lastTestAt ? formatDate(i.r2.lastTestAt) : "Belum pernah dites";

    $("notifWa").checked = Boolean(i.notifications.whatsappEnabled);
    $("notifEmail").checked = Boolean(i.notifications.emailEnabled);
    qsa("[data-notif-event]").forEach((el) => {
      el.checked = Boolean(i.notifications.events[el.dataset.notifEvent]);
    });

    $("webhookUrlHint").textContent = window.location.origin + "/api/payments/klikqris/webhook";
  }

  const EMAIL_EVENTS = [
    ["orderCreated", "Order Created"],
    ["paymentSuccess", "Payment Success"],
    ["paymentFailed", "Payment Failed"],
    ["paymentExpired", "Payment Expired"],
  ];

  function fillTemplateForms() {
    qsa("[data-tpl-wa]").forEach((el) => {
      el.value = state.templates.whatsapp[el.dataset.tplWa] || "";
    });

    $("emailTemplates").innerHTML = EMAIL_EVENTS.map((ev) => {
      const tpl = state.templates.email[ev[0]] || {};
      return (
        '<div class="tpl-block"><h4>' +
        escapeHTML(ev[1]) +
        '</h4><label class="block-label">Subject<input data-tpl-email-subject="' +
        ev[0] +
        '" value="' +
        escapeHTML(tpl.subject || "") +
        '"></label><label class="block-label">HTML<textarea data-tpl-email-html="' +
        ev[0] +
        '" rows="5">' +
        escapeHTML(tpl.html || "") +
        "</textarea></label></div>"
      );
    }).join("");
  }

  async function saveIntegration(provider, button, body) {
    await withBusy(button, "Menyimpan...", async () => {
      try {
        await api("/integrations/" + provider, { method: "PUT", body });
        showToast("Konfigurasi " + PROVIDER_LABEL[provider] + " disimpan.", "success");
        await loadIntegrations();
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  }

  async function testIntegration(provider, button, body) {
    await withBusy(button, "Menguji...", async () => {
      try {
        const res = await fetch("/api/integrations/" + provider + "/test", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + getToken() },
          body: JSON.stringify(body || {}),
        });
        const payload = await res.json().catch(() => null);
        if (res.status === 401) return logout();
        showToast((payload && payload.message) || "Test selesai.", payload && payload.status ? "success" : "error");
      } catch (err) {
        showToast("Gagal menjalankan test: " + err.message, "error");
      } finally {
        await loadIntegrations().catch(() => {});
      }
    });
  }

  /* -------------------------------------------------- account / admins UI */
  async function loadAccountPage() {
    const admin = state.admin;
    $("accName").value = admin.name;
    $("accEmail").value = admin.email;
    $("accRole").value = admin.role;
    $("accLastLogin").value = admin.lastLoginAt ? formatDate(admin.lastLoginAt) : "-";

    const isSuper = admin.role === "superadmin";
    $("addAdminSection").hidden = !isSuper;
    if (!isSuper) {
      $("adminsNote").textContent = "Hanya superadmin yang dapat melihat dan mengelola akun admin.";
      $("adminsTable").innerHTML = emptyRow(6, "Akses terbatas untuk role admin.");
      return;
    }

    $("adminsNote").textContent = "Kelola akun yang bisa masuk ke Admin Web.";
    const res = await api("/admins");
    $("adminsTable").innerHTML =
      res.data
        .map(
          (a) =>
            "<tr><td><b>" +
            escapeHTML(a.name) +
            "</b></td><td>" +
            escapeHTML(a.email) +
            "</td><td>" +
            escapeHTML(a.role) +
            "</td><td>" +
            escapeHTML(a.lastLoginAt ? formatDate(a.lastLoginAt) : "-") +
            "</td><td>" +
            (a.active ? '<span class="status paid">AKTIF</span>' : '<span class="status failed">NONAKTIF</span>') +
            '</td><td class="row-actions">' +
            (a._id === state.admin._id
              ? '<small class="muted-flag">Akun ini</small>'
              : '<button class="icon-btn" type="button" data-toggle-admin="' +
                a._id +
                '" data-active="' +
                (a.active ? "false" : "true") +
                '">' +
                (a.active ? "Nonaktifkan" : "Aktifkan") +
                "</button>") +
            "</td></tr>"
        )
        .join("") || emptyRow(6, "Belum ada admin.");
  }

  async function loadHealth() {
    $("healthBox").innerHTML = '<div class="empty-block">Memuat status server...</div>';
    try {
      const res = await fetch("/api/health");
      const payload = await res.json();
      const data = {
        Server: payload.server,
        MongoDB: payload.mongodb,
        "Cloudflare R2": payload.r2,
        KlikQRIS: payload.integrations ? payload.integrations.klikqris : "unknown",
        Fonnte: payload.integrations ? payload.integrations.fonnte : "unknown",
        Resend: payload.integrations ? payload.integrations.resend : "unknown",
        "Waktu server": payload.time ? formatDate(payload.time) : "-",
      };
      $("healthBox").innerHTML = Object.keys(data)
        .map((key) => {
          const text = String(data[key]);
          return (
            '<div class="integration-card"><div class="integration-head"><b>' +
            escapeHTML(key) +
            '</b></div><span class="integration-state">' +
            escapeHTML(text) +
            "</span></div>"
          );
        })
        .join("");
    } catch (err) {
      $("healthBox").innerHTML = '<div class="empty-block">Gagal memuat health check.</div>';
    }
  }

  /* -------------------------------------------------------------- realtime */
  let realtimeReady = false;

  function refreshCurrentPage() {
    const loader = LOADERS[state.currentPage];
    if (loader) loader().catch(() => {});
  }
  const refreshCurrentPageDebounced = debounce(refreshCurrentPage, 400);

  function initRealtime() {
    if (realtimeReady) return; // listener dipasang sekali saja, bukan tiap showPage()
    const socket = getSocket();
    if (!socket) return;
    realtimeReady = true;

    const pill = $("connPill");
    socket.on("connect", () => {
      pill.dataset.state = "online";
      pill.textContent = "Realtime: online";
      refreshCurrentPage(); // sync ulang setelah reconnect / restart server
    });
    socket.on("disconnect", () => {
      pill.dataset.state = "offline";
      pill.textContent = "Realtime: offline";
    });

    socket.on("order:created", (payload) => {
      showToast("Pesanan baru masuk: " + ((payload && payload.orderCode) || ""), "info");
      refreshOrdersRelated();
    });
    socket.on("order:updated", refreshOrdersRelated);
    socket.on("payment:updated", (payload) => {
      if (payload && payload.paymentStatus === "SUCCESS") {
        showToast("Pembayaran berhasil untuk " + (payload.orderCode || "sebuah order") + ".", "success");
      }
      refreshOrdersRelated();
    });
    socket.on("stock:updated", () => {
      if (state.currentPage === "products" || state.currentPage === "dashboard") refreshCurrentPageDebounced();
    });

    ["product:created", "product:updated", "product:deleted", "products:updated", "categories:updated"].forEach((ev) =>
      socket.on(ev, () => {
        if (["products", "categories", "dashboard"].includes(state.currentPage)) refreshCurrentPageDebounced();
      })
    );

    socket.on("faq:updated", () => {
      if (state.currentPage === "faq") refreshCurrentPageDebounced();
    });
    socket.on("rating:updated", () => {
      if (state.currentPage === "reviews" || state.currentPage === "dashboard") refreshCurrentPageDebounced();
    });
    socket.on("statistics:updated", () => {
      if (state.currentPage === "dashboard") refreshCurrentPageDebounced();
    });
    ["integration:updated", "notification:updated"].forEach((ev) =>
      socket.on(ev, () => {
        if (state.currentPage === "integrations") refreshCurrentPageDebounced();
      })
    );
    socket.on("website:settings:updated", () => {
      // Selalu resync branding sidebar, form-nya hanya kalau tab Konten sedang dibuka.
      api("/settings/admin")
        .then((res) => {
          state.settings = res.data;
          applyBranding(state.settings);
          if (state.currentPage === "content") fillSettingsForm(state.settings);
        })
        .catch(() => {});
    });
  }

  const refreshOrdersRelated = debounce(() => {
    api("/orders/admin/summary")
      .then((res) => updateOrderBadge(res.data.pendingPayments))
      .catch(() => {});
    if (state.currentPage === "orders" || state.currentPage === "dashboard" || state.currentPage === "customers") {
      refreshCurrentPage();
    }
  }, 400);

  /* ----------------------------------------------------------- event wiring */
  function wireEvents() {
    // Navigasi — dipasang sekali, delegasi untuk tombol "lihat semua".
    document.addEventListener("click", (e) => {
      const nav = e.target.closest(".nav-item, .text-btn");
      if (nav && nav.dataset.page) {
        showPage(nav.dataset.page);
        return;
      }

      const closer = e.target.closest("[data-close-modal]");
      if (closer) {
        closeModal(closer.dataset.closeModal);
        return;
      }

      if (e.target.closest("[data-open-product]")) return openProductModal(null);
      if (e.target.closest("[data-open-category]")) return openCategoryModal(null);
      if (e.target.closest("[data-open-faq]")) return openFaqModal(null);

      const editProduct = e.target.closest("[data-edit-product]");
      if (editProduct) return openProductModal(editProduct.dataset.editProduct);
      const delProduct = e.target.closest("[data-delete-product]");
      if (delProduct) return deleteProduct(delProduct.dataset.deleteProduct);

      const editCategory = e.target.closest("[data-edit-category]");
      if (editCategory) return openCategoryModal(editCategory.dataset.editCategory);
      const delCategory = e.target.closest("[data-delete-category]");
      if (delCategory) return deleteCategory(delCategory.dataset.deleteCategory);

      const editFaq = e.target.closest("[data-edit-faq]");
      if (editFaq) return openFaqModal(editFaq.dataset.editFaq);
      const delFaq = e.target.closest("[data-delete-faq]");
      if (delFaq) return deleteFaq(delFaq.dataset.deleteFaq);

      const orderDetail = e.target.closest("[data-order-detail]");
      if (orderDetail) return openOrderDetail(orderDetail.dataset.orderDetail);

      const ratingStatus = e.target.closest("[data-rating-status]");
      if (ratingStatus) return setRatingStatus(ratingStatus.dataset.id, ratingStatus.dataset.ratingStatus);
      const delRating = e.target.closest("[data-delete-rating]");
      if (delRating) return deleteRating(delRating.dataset.deleteRating);

      const toggleAdmin = e.target.closest("[data-toggle-admin]");
      if (toggleAdmin) return toggleAdminActive(toggleAdmin.dataset.toggleAdmin, toggleAdmin.dataset.active === "true");

      const saveSectionBtn = e.target.closest("[data-save-section]");
      if (saveSectionBtn) return saveSection(saveSectionBtn.dataset.saveSection, saveSectionBtn);

      // Baris repeatable: naik / turun / hapus.
      const move = e.target.closest("[data-move]");
      if (move) {
        const row = move.closest(".repeat-row");
        const sibling = move.dataset.move === "up" ? row.previousElementSibling : row.nextElementSibling;
        if (sibling && sibling.classList.contains("repeat-row")) {
          if (move.dataset.move === "up") row.parentNode.insertBefore(row, sibling);
          else row.parentNode.insertBefore(sibling, row);
        }
        return;
      }
      const remove = e.target.closest("[data-remove]");
      if (remove) {
        remove.closest(".repeat-row").remove();
        return;
      }
    });

    // Tutup modal saat klik backdrop.
    qsa(".modal-backdrop").forEach((backdrop) =>
      backdrop.addEventListener("click", (e) => {
        if (e.target === backdrop) closeModal(backdrop.id);
      })
    );
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") qsa(".modal-backdrop.open").forEach((m) => m.classList.remove("open"));
    });

    // Tab pada settings-layout (Konten, Integrasi, Pengaturan).
    qsa(".setting-tab").forEach((tab) =>
      tab.addEventListener("click", () => {
        const wrap = tab.closest(".settings-layout");
        qsa(".setting-tab", wrap).forEach((x) => x.classList.remove("active"));
        tab.classList.add("active");
        qsa(".setting-pane", wrap).forEach((p) => p.classList.toggle("active", p.id === "tab-" + tab.dataset.tab));
        if (tab.dataset.tab === "server") loadHealth();
      })
    );

    $("logoutBtn").addEventListener("click", () => {
      if (window.confirm("Keluar dari Admin Web?")) logout();
    });

    // Orders
    $("orderSearch").addEventListener("input", debounce(renderOrders, 200));
    $("orderStatusFilter").addEventListener("change", () => {
      state.ordersPagination.page = 1;
      loadOrders().catch((err) => showToast(err.message, "error"));
    });
    $("paymentStatusFilter").addEventListener("change", () => {
      state.ordersPagination.page = 1;
      loadOrders().catch((err) => showToast(err.message, "error"));
    });

    // Products
    $("productSearch").addEventListener("input", debounce(renderProducts, 200));
    $("categoryFilter").addEventListener("change", renderProducts);
    $("productStatusFilter").addEventListener("change", renderProducts);
    $("productForm").addEventListener("submit", submitProduct);
    $("imageInput").addEventListener("change", (e) => {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (file.size > 5 * 1024 * 1024) {
        showToast("Ukuran gambar maksimal 5MB.", "error");
        e.target.value = "";
        return;
      }
      pendingImageFile = file;
      $("imagePreview").src = URL.createObjectURL(file);
      $("imageDrop").classList.add("has-image");
    });

    // Categories & FAQ
    $("categoryForm").addEventListener("submit", submitCategory);
    $("faqForm").addEventListener("submit", submitFaq);

    // Customers
    $("customerSearch").addEventListener(
      "input",
      debounce(() => {
        state.customersPagination.page = 1;
        loadCustomers().catch((err) => showToast(err.message, "error"));
      }, 350)
    );

    // Ratings
    $("ratingStatusFilter").addEventListener("change", () => loadRatings().catch((err) => showToast(err.message, "error")));

    // Repeatable adders
    $("addNavbarItem").addEventListener("click", () => appendRow("navbarItems", renderNavbarItems, { label: "", route: "", icon: "", enabled: true }));
    $("addHighlight").addEventListener("click", () => appendRow("highlightItems", renderHighlights, { icon: "", title: "", description: "", enabled: true }));
    $("addFooterLink").addEventListener("click", () => appendRow("footerLinks", renderFooterLinks, { label: "", url: "" }));
    $("addFooterSocial").addEventListener("click", () => appendRow("footerSocial", renderFooterSocial, { platform: "", url: "" }));

    // Upload aset settings
    qsa("[data-upload-target]").forEach((input) => input.addEventListener("change", () => uploadAsset(input)));

    // Integrasi
    $("kqSave").addEventListener("click", () =>
      saveIntegration("klikqris", $("kqSave"), {
        enabled: $("kqEnabled").checked,
        mode: $("kqMode").value,
        apiKey: $("kqApiKey").value.trim() || undefined,
        merchantId: $("kqMerchantId").value.trim() || undefined,
      })
    );
    $("kqTest").addEventListener("click", () => testIntegration("klikqris", $("kqTest")));

    $("fnSave").addEventListener("click", () =>
      saveIntegration("fonnte", $("fnSave"), { enabled: $("fnEnabled").checked, token: $("fnToken").value.trim() || undefined })
    );
    $("fnTest").addEventListener("click", () => {
      const target = $("fnTestTarget").value.trim();
      if (!target) return showToast("Isi nomor WhatsApp tujuan test dulu.", "error");
      testIntegration("fonnte", $("fnTest"), { testTarget: target });
    });

    $("rsSave").addEventListener("click", () =>
      saveIntegration("resend", $("rsSave"), {
        enabled: $("rsEnabled").checked,
        apiKey: $("rsApiKey").value.trim() || undefined,
        fromEmail: $("rsFromEmail").value.trim() || undefined,
        fromName: $("rsFromName").value.trim() || undefined,
      })
    );
    $("rsTest").addEventListener("click", () => {
      const to = $("rsTestTo").value.trim();
      if (!to) return showToast("Isi email tujuan test dulu.", "error");
      testIntegration("resend", $("rsTest"), { testTo: to });
    });

    $("r2Test").addEventListener("click", () => testIntegration("r2", $("r2Test")));

    $("notifSave").addEventListener("click", () =>
      withBusy($("notifSave"), "Menyimpan...", async () => {
        const events = {};
        qsa("[data-notif-event]").forEach((el) => {
          events[el.dataset.notifEvent] = el.checked;
        });
        try {
          await api("/integrations/notifications", {
            method: "PUT",
            body: { whatsappEnabled: $("notifWa").checked, emailEnabled: $("notifEmail").checked, events },
          });
          showToast("Pengaturan notifikasi disimpan.", "success");
        } catch (err) {
          showToast(err.message, "error");
        }
      })
    );

    $("templatesSave").addEventListener("click", () =>
      withBusy($("templatesSave"), "Menyimpan...", async () => {
        const whatsapp = {};
        qsa("[data-tpl-wa]").forEach((el) => {
          whatsapp[el.dataset.tplWa] = el.value;
        });
        const email = {};
        qsa("[data-tpl-email-subject]").forEach((el) => {
          email[el.dataset.tplEmailSubject] = { subject: el.value };
        });
        qsa("[data-tpl-email-html]").forEach((el) => {
          email[el.dataset.tplEmailHtml] = Object.assign(email[el.dataset.tplEmailHtml] || {}, { html: el.value });
        });
        try {
          await api("/integrations/templates", { method: "PUT", body: { whatsapp, email } });
          showToast("Template notifikasi disimpan.", "success");
        } catch (err) {
          showToast(err.message, "error");
        }
      })
    );

    // Akun
    $("savePassword").addEventListener("click", () =>
      withBusy($("savePassword"), "Menyimpan...", async () => {
        const currentPassword = $("oldPassword").value;
        const newPassword = $("newPassword").value;
        if (!currentPassword || newPassword.length < 8) {
          return showToast("Password lama wajib diisi dan password baru minimal 8 karakter.", "error");
        }
        try {
          await api("/auth/change-password", { method: "POST", body: { currentPassword, newPassword } });
          $("oldPassword").value = "";
          $("newPassword").value = "";
          showToast("Password berhasil diubah.", "success");
        } catch (err) {
          showToast(err.message, "error");
        }
      })
    );

    $("createAdmin").addEventListener("click", () =>
      withBusy($("createAdmin"), "Menyimpan...", async () => {
        try {
          await api("/admins", {
            method: "POST",
            body: {
              name: $("newAdminName").value.trim(),
              email: $("newAdminEmail").value.trim(),
              password: $("newAdminPassword").value,
              role: $("newAdminRole").value,
            },
          });
          $("newAdminName").value = "";
          $("newAdminEmail").value = "";
          $("newAdminPassword").value = "";
          showToast("Admin baru dibuat.", "success");
          await loadAccountPage();
        } catch (err) {
          showToast(err.message, "error");
        }
      })
    );

    $("refreshHealth").addEventListener("click", loadHealth);

    window.addEventListener("hashchange", () => {
      const id = window.location.hash.replace("#", "");
      if (id && id !== state.currentPage) showPage(id);
    });
  }

  function appendRow(containerId, renderFn, blank) {
    const container = $(containerId);
    const existing = qsa("#" + containerId + " .repeat-row").map((row) => {
      const obj = {};
      qsa("[data-key]", row).forEach((f) => {
        obj[f.dataset.key] = f.type === "checkbox" ? f.checked : f.value;
      });
      return obj;
    });
    existing.push(blank);
    renderFn(existing);
    container.lastElementChild.scrollIntoView({ block: "nearest" });
  }

  async function toggleAdminActive(id, active) {
    try {
      await api("/admins/" + id + "/active", { method: "PATCH", body: { active } });
      showToast("Status admin diperbarui.", "success");
      await loadAccountPage();
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  /* ------------------------------------------------------------------ init */
  async function init() {
    if (!getToken()) {
      window.location.replace(LOGIN_URL);
      return;
    }

    try {
      const me = await api("/auth/me");
      state.admin = me.data.admin;
    } catch (err) {
      // api() sudah redirect ke login untuk 401; sisanya tampilkan pesan.
      $("bootScreen").textContent = "Gagal memuat sesi admin: " + err.message;
      return;
    }

    $("bootScreen").hidden = true;
    $("appShell").hidden = false;

    $("adminName").textContent = state.admin.name;
    $("adminRole").textContent = state.admin.role === "superadmin" ? "Super Admin" : "Admin";
    $("adminInitials").textContent = state.admin.name
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w.charAt(0).toUpperCase())
      .join("");

    wireEvents();
    initRealtime();

    // Branding sidebar selalu dari WebsiteSettings asli.
    try {
      const settings = await api("/settings/admin");
      state.settings = settings.data;
      applyBranding(state.settings);
    } catch (e) {
      /* non-fatal */
    }

    // Kategori dibutuhkan lintas halaman (filter produk + modal produk).
    try {
      const categories = await api("/categories/admin/all");
      state.categories = categories.data;
      syncCategoryOptions();
    } catch (e) {
      /* non-fatal */
    }

    const initial = window.location.hash.replace("#", "");
    showPage(PAGE_TITLES[initial] ? initial : "dashboard");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
