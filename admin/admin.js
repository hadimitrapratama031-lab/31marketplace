/* ==========================================================================
   ADMIN CONSOLE — application layer
   Seluruh data berasal dari Express API + MongoDB. Tidak ada dummy/mock data.
   Realtime memakai Socket.IO; listener dipasang sekali saat init.
   ========================================================================== */
(function () {
  "use strict";

  const TOKEN_KEY = "mp_admin_token";
  const LOGIN_URL = "./login.html";
  const { formatIDR, formatDate, escapeHTML, getSocket, debounce } = window.MP;
  const esc = escapeHTML;

  /* ---------------------------------------------------------------- state */
  const state = {
    admin: null,
    settings: null,
    categories: [],
    products: [],
    orders: [],
    ordersPagination: { page: 1, limit: 30, total: 0 },
    transactions: [],
    txPagination: { page: 1, limit: 30, total: 0 },
    txStatus: "",
    summary: null,
    customers: [],
    customersPagination: { page: 1, limit: 30, total: 0 },
    faqs: [],
    ratings: [],
    ratingFilter: "",
    integrations: null,
    templates: null,
    notifLogs: [],
    notifLogsPagination: { page: 1, limit: 30, total: 0 },
    notifLogFilters: { orderCode: "", event: "", channel: "", status: "" },
    notifications: [],
    unread: 0,
    productView: "grid",
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
      throw new Error("Sesi berakhir. Silakan masuk kembali.");
    }

    if (!res.ok || (payload && payload.status === false)) {
      const err = new Error((payload && payload.message) || "Terjadi kesalahan (" + res.status + ").");
      err.status = res.status;
      throw err;
    }
    return payload;
  }

  /* ---------------------------------------------------------- ui primitives */
  function ico(name, cls) {
    return '<svg class="ico' + (cls ? " " + cls : "") + '"><use href="#i-' + name + '"></use></svg>';
  }

  function showToast(message, kind) {
    const stack = $("toastStack");
    if (!stack) return;
    const k = kind || "info";
    const iconName = k === "success" ? "check-circle" : k === "error" ? "alert" : "info";
    const el = document.createElement("div");
    el.className = "toast";
    el.dataset.kind = k;
    el.innerHTML =
      ico(iconName, "ico-sm") +
      "<span>" +
      esc(message) +
      '</span><button class="toast-x" type="button" aria-label="Tutup">' +
      ico("x", "ico-sm") +
      "</button>";
    stack.appendChild(el);

    const dismiss = () => {
      if (!el.isConnected) return;
      el.classList.add("out");
      setTimeout(() => el.remove(), 200);
    };
    el.querySelector(".toast-x").addEventListener("click", dismiss);
    setTimeout(dismiss, k === "error" ? 6000 : 3800);

    // Jaga agar tumpukan toast tidak memenuhi layar.
    while (stack.children.length > 4) stack.firstElementChild.remove();
  }

  /* --- modal manager: kunci scroll halaman, kembalikan fokus, ESC & backdrop */
  const openModals = [];
  let lastFocused = null;

  function openModal(id) {
    const el = $(id);
    if (!el || el.classList.contains("open")) return;
    if (!openModals.length) lastFocused = document.activeElement;
    el.classList.add("open");
    openModals.push(id);
    document.body.classList.add("modal-open");
    const target = el.querySelector(
      "input:not([type=hidden]):not([disabled]), select:not([disabled]), textarea:not([disabled]), button.btn-primary"
    );
    if (target) setTimeout(() => target.focus(), 60);
  }

  function closeModal(id) {
    const el = $(id);
    if (!el || !el.classList.contains("open")) return;
    el.classList.remove("open");
    const i = openModals.indexOf(id);
    if (i > -1) openModals.splice(i, 1);
    if (!openModals.length) {
      document.body.classList.remove("modal-open");
      if (lastFocused && lastFocused.focus) lastFocused.focus();
      lastFocused = null;
    }
    if (id === "confirmModal") settleConfirm(false);
  }

  function setAlert(id, message) {
    const box = $(id);
    if (!box) return;
    if (!message) {
      box.classList.remove("show");
      return;
    }
    box.querySelector("span").textContent = message;
    box.classList.add("show");
  }

  /* --- konfirmasi: pengganti window.confirm agar satu bahasa visual --- */
  let confirmResolve = null;

  function settleConfirm(value) {
    if (!confirmResolve) return;
    const fn = confirmResolve;
    confirmResolve = null;
    fn(value);
  }

  function confirmAction(opts) {
    const o = opts || {};
    $("confirmTitle").textContent = o.title || "Konfirmasi";
    $("confirmText").innerHTML = o.html || esc(o.text || "Tindakan ini tidak bisa dibatalkan.");
    const ok = $("confirmOk");
    ok.textContent = o.confirmLabel || "Hapus";
    ok.className = "btn " + (o.tone === "primary" ? "btn-primary" : "btn-danger");
    openModal("confirmModal");
    return new Promise((resolve) => {
      confirmResolve = resolve;
    });
  }

  // Tombol dikunci selama request berjalan — status loading yang sebenarnya.
  async function withBusy(button, label, fn) {
    if (!button) return fn();
    const original = button.innerHTML;
    button.disabled = true;
    button.innerHTML = '<span class="boot-spin" style="width:14px;height:14px;border-width:2px"></span>' + esc(label || "Memproses…");
    try {
      return await fn();
    } finally {
      button.disabled = false;
      button.innerHTML = original;
    }
  }

  /* ------------------------------------------------------------- formatting */
  const STATUS_META = {
    PENDING: { cls: "st-pending", label: "Menunggu" },
    PAID: { cls: "st-success", label: "Dibayar" },
    SUCCESS: { cls: "st-success", label: "Berhasil" },
    COMPLETED: { cls: "st-success", label: "Selesai" },
    PROCESSING: { cls: "st-info", label: "Diproses" },
    FAILED: { cls: "st-danger", label: "Gagal" },
    EXPIRED: { cls: "st-neutral", label: "Kedaluwarsa" },
    CANCELLED: { cls: "st-neutral", label: "Dibatalkan" },
  };

  function chip(value) {
    const key = String(value || "").toUpperCase();
    const meta = STATUS_META[key] || { cls: "st-neutral", label: key || "—" };
    return '<span class="st ' + meta.cls + '"><i></i>' + esc(meta.label) + "</span>";
  }

  function chipActive(status) {
    return status === "active"
      ? '<span class="st st-success"><i></i>Aktif</span>'
      : '<span class="st st-neutral"><i></i>Nonaktif</span>';
  }

  const REVIEW_META = {
    approved: { cls: "st-success", label: "Disetujui" },
    pending: { cls: "st-pending", label: "Menunggu" },
    hidden: { cls: "st-neutral", label: "Disembunyikan" },
  };

  function chipReview(status) {
    const meta = REVIEW_META[status] || { cls: "st-neutral", label: status || "—" };
    return '<span class="st ' + meta.cls + '"><i></i>' + esc(meta.label) + "</span>";
  }

  function starsInner(value) {
    const n = Math.round(Number(value) || 0);
    let out = "";
    for (let i = 1; i <= 5; i += 1) {
      out += '<svg class="ico' + (i <= n ? " on" : "") + '"><use href="#i-star"></use></svg>';
    }
    return out;
  }

  function starsHTML(value, extraClass) {
    return '<span class="stars' + (extraClass ? " " + extraClass : "") + '">' + starsInner(value) + "</span>";
  }

  function initials(name) {
    return String(name || "")
      .trim()
      .split(/\s+/)
      .slice(0, 2)
      .map((w) => w.charAt(0).toUpperCase())
      .join("") || "·";
  }

  function shortDate(value) {
    if (!value) return "—";
    const d = new Date(value);
    if (Number.isNaN(d.getTime())) return "—";
    return d.toLocaleDateString("id-ID", { day: "2-digit", month: "short", year: "numeric" });
  }

  function timeAgo(value) {
    const d = new Date(value);
    const diff = Math.max(0, Date.now() - d.getTime());
    const m = Math.floor(diff / 60000);
    if (m < 1) return "baru saja";
    if (m < 60) return m + " menit lalu";
    const h = Math.floor(m / 60);
    if (h < 24) return h + " jam lalu";
    return shortDate(value);
  }

  // Sel tanggal dibuat dua baris agar kolomnya tetap sempit dan tidak pernah
  // terpotong di layar 1280px.
  function dateCell(value) {
    const d = new Date(value);
    if (!value || Number.isNaN(d.getTime())) return '<td class="shrink">—</td>';
    const time = d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
    return (
      '<td class="shrink"><span class="date-main">' + esc(shortDate(value)) + '</span><small class="sub">' + esc(time) + "</small></td>"
    );
  }

  function emptyRow(colspan, message) {
    return '<tr><td colspan="' + colspan + '" class="empty-cell">' + esc(message) + "</td></tr>";
  }

  function emptyState(iconName, title, text, actionHTML) {
    return (
      '<div class="empty">' +
      ico(iconName) +
      "<b>" +
      esc(title) +
      "</b>" +
      (text ? "<p>" + esc(text) + "</p>" : "") +
      (actionHTML || "") +
      "</div>"
    );
  }

  function thumbHTML(url, fallbackText, cls) {
    if (url) {
      return '<span class="thumb' + (cls ? " " + cls : "") + '"><img src="' + esc(url) + '" alt="" loading="lazy"></span>';
    }
    return (
      '<span class="thumb' + (cls ? " " + cls : "") + '">' +
      (fallbackText ? esc(String(fallbackText).charAt(0).toUpperCase()) : ico("image", "ico-sm")) +
      "</span>"
    );
  }

  function categoryIdOf(product) {
    const c = product.categoryId;
    return c && c._id ? c._id : c;
  }

  function categoryNameOf(product) {
    const c = product.categoryId;
    if (c && c.name) return c.name;
    const found = state.categories.find((x) => x._id === categoryIdOf(product));
    return found ? found.name : "Tanpa kategori";
  }

  /* ---------------------------------------------------------------- router */
  const PAGES = {
    dashboard: { title: "Dashboard", group: "Overview" },
    products: { title: "Produk", group: "Katalog" },
    categories: { title: "Kategori", group: "Katalog" },
    faq: { title: "FAQ", group: "Katalog" },
    orders: { title: "Pesanan", group: "Transaksi" },
    transactions: { title: "Pembayaran", group: "Transaksi" },
    reviews: { title: "Rating", group: "Transaksi" },
    customers: { title: "Customer", group: "Transaksi" },
    content: { title: "Marketplace", group: "Website" },
    integrations: { title: "Integrasi", group: "Sistem" },
    settings: { title: "Pengaturan", group: "Sistem" },
  };

  const LOADERS = {
    dashboard: loadDashboard,
    products: loadProducts,
    categories: loadCategories,
    faq: loadFaqs,
    orders: loadOrders,
    transactions: loadTransactions,
    reviews: loadRatings,
    customers: loadCustomers,
    content: loadSettings,
    integrations: loadIntegrations,
    settings: loadAccountPage,
  };

  function showPage(id) {
    if (!PAGES[id]) id = "dashboard";
    state.currentPage = id;
    qsa(".page").forEach((p) => p.classList.toggle("active", p.id === id));
    qsa(".rail-item[data-page]").forEach((b) => b.classList.toggle("active", b.dataset.page === id));
    $("pageTitle").textContent = PAGES[id].title;
    $("crumb").textContent = PAGES[id].title;
    $("crumbStore").textContent = PAGES[id].group;
    closeAllPops();
    if (window.innerWidth <= 1240) $("appShell").dataset.drawer = "false";
    if (window.location.hash.replace("#", "") !== id) window.location.hash = id;
    window.scrollTo({ top: 0, behavior: "auto" });
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
    state.summary = s;

    $("statRevenue").textContent = formatIDR(s.totalRevenue);
    renderDelta($("statRevenueDelta"), s.revenueDeltaPercent, "dibanding bulan lalu");
    $("statOrders").textContent = String(s.totalOrders);
    renderDelta($("statOrdersDelta"), s.ordersDeltaPercent, "dibanding bulan lalu");
    $("statCustomers").textContent = String(st.totalBuyer);
    $("statCustomersSub").textContent = st.successfulOrders + " order dibayar";
    $("statRating").textContent = st.ratingCount ? st.averageRating + " / 5" : "Belum ada";
    $("statRatingSub").textContent = st.ratingCount + " review disetujui";
    $("statRatingStars").innerHTML = starsInner(st.ratingCount ? st.averageRating : 0);

    // Mini chart: pendapatan 7 hari terakhir, angka nyata dari agregasi order.
    const max = Math.max.apply(null, s.daily.map((d) => d.revenue).concat([1]));
    $("revenueChart").innerHTML = s.daily
      .map(
        (d) =>
          '<b style="height:' +
          Math.max(6, Math.round((d.revenue / max) * 100)) +
          '%" title="' +
          esc(shortDate(d.date) + " · " + formatIDR(d.revenue)) +
          '"></b>'
      )
      .join("");

    state.orders = orders.data;
    $("recentOrders").innerHTML =
      orders.data
        .map(
          (o) =>
            '<tr data-order-detail="' +
            o._id +
            '" style="cursor:pointer"><td><span class="mono">' +
            esc(o.orderCode) +
            '</span></td><td class="strong">' +
            esc(o.customer.name || o.customer.email) +
            '</td><td class="truncate" style="max-width:200px">' +
            esc(o.product.name) +
            '</td><td class="num strong">' +
            formatIDR(o.total) +
            "</td><td>" +
            chip(o.status) +
            "</td></tr>"
        )
        .join("") || emptyRow(5, "Belum ada pesanan yang masuk.");

    // Sebaran status order — dihitung backend, bukan ditebak di browser.
    const byStatus = s.byStatus || {};
    const keys = Object.keys(byStatus).filter((k) => byStatus[k] > 0);
    const totalStatus = keys.reduce((acc, k) => acc + byStatus[k], 0) || 1;
    $("statusBreakdown").innerHTML = keys.length
      ? '<div class="rating-bars">' +
        keys
          .sort((a, b) => byStatus[b] - byStatus[a])
          .map(
            (k) =>
              '<div class="rating-bar wide"><span class="k">' +
              esc((STATUS_META[k] && STATUS_META[k].label) || k) +
              '</span><i><b style="width:' +
              Math.round((byStatus[k] / totalStatus) * 100) +
              '%"></b></i><span class="n">' +
              byStatus[k] +
              "</span></div>"
          )
          .join("") +
        "</div>"
      : emptyState("inbox", "Belum ada data status", "Status akan muncul setelah order pertama masuk.");

    state.products = products.data;
    const best = products.data.slice().sort((a, b) => b.sold - a.sold).slice(0, 5);
    $("bestProducts").innerHTML =
      best
        .map(
          (p) =>
            '<tr><td><div class="cell-media">' +
            thumbHTML(p.image, p.name) +
            '<div class="cell-media-text"><b>' +
            esc(p.name) +
            "</b><small>" +
            p.sold +
            " terjual · stok " +
            p.stock +
            '</small></div></div></td><td class="num strong">' +
            formatIDR(p.price) +
            "</td></tr>"
        )
        .join("") || emptyRow(2, "Belum ada produk.");

    updateOrderBadge(s.pendingPayments);
  }

  function renderDelta(el, percent, suffix) {
    if (percent === null || percent === undefined) {
      el.className = "stat-note";
      el.textContent = "Belum ada pembanding bulan lalu";
      return;
    }
    const up = percent >= 0;
    el.className = "stat-note " + (up ? "up" : "down");
    el.innerHTML = ico(up ? "trend-up" : "trend-down") + Math.abs(percent) + "% <i>" + esc(suffix) + "</i>";
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
    const list = q ? state.orders.filter((o) => orderMatches(o, q)) : state.orders;

    $("ordersTable").innerHTML =
      list
        .map(
          (o) =>
            '<tr><td><span class="mono">' +
            esc(o.orderCode) +
            '</span></td><td><b class="truncate" style="display:block;max-width:180px">' +
            esc(o.customer.name || "Tanpa nama") +
            '</b><small class="sub">' +
            esc(o.customer.email) +
            '</small></td><td class="truncate" style="max-width:220px">' +
            esc(o.product.name) +
            '</td><td class="num">' +
            o.quantity +
            '</td><td class="num strong">' +
            formatIDR(o.total) +
            "</td><td>" +
            chip(o.paymentStatus) +
            "</td><td>" +
            chip(o.status) +
            "</td>" +
            dateCell(o.createdAt) +
            '<td class="cell-actions"><button class="btn btn-icon btn-sm" type="button" data-order-detail="' +
            o._id +
            '" title="Lihat detail" aria-label="Lihat detail">' +
            ico("eye", "ico-sm") +
            "</button></td></tr>"
        )
        .join("") || emptyRow(9, q ? "Tidak ada order yang cocok dengan pencarian." : "Belum ada pesanan.");

    renderPager($("ordersPager"), state.ordersPagination, (page) => {
      state.ordersPagination.page = page;
      loadOrders().catch((err) => showToast(err.message, "error"));
    });
  }

  function orderMatches(o, q) {
    return [o.orderCode, o.customer.name, o.customer.email, o.customer.whatsapp, o.product.name]
      .join(" ")
      .toLowerCase()
      .includes(q);
  }

  function renderPager(container, pagination, onGo) {
    const pages = Math.max(1, Math.ceil(pagination.total / pagination.limit));
    if (pages <= 1) {
      container.innerHTML = "";
      return;
    }
    const from = (pagination.page - 1) * pagination.limit + 1;
    const to = Math.min(pagination.total, pagination.page * pagination.limit);
    container.innerHTML =
      '<span class="pager-info">' +
      from +
      "–" +
      to +
      " dari " +
      pagination.total +
      ' data</span><span class="pager-nav"><button class="btn btn-sm btn-outline" type="button" data-pg="prev"' +
      (pagination.page <= 1 ? " disabled" : "") +
      ">" +
      ico("chevron-left", "ico-sm") +
      'Sebelumnya</button><span class="pager-info">Halaman ' +
      pagination.page +
      " dari " +
      pages +
      '</span><button class="btn btn-sm btn-outline" type="button" data-pg="next"' +
      (pagination.page >= pages ? " disabled" : "") +
      ">Berikutnya" +
      ico("chevron-right", "ico-sm") +
      "</button></span>";

    container.onclick = (e) => {
      const btn = e.target.closest("[data-pg]");
      if (!btn || btn.disabled) return;
      onGo(btn.dataset.pg === "prev" ? pagination.page - 1 : pagination.page + 1);
    };
  }

  /* ---------------------------------------------------------- transactions */
  async function loadTransactions() {
    const params = new URLSearchParams();
    if (state.txStatus) params.set("paymentStatus", state.txStatus);
    params.set("page", String(state.txPagination.page));
    params.set("limit", String(state.txPagination.limit));

    const [res, summary] = await Promise.all([
      api("/orders/admin/all?" + params.toString()),
      api("/orders/admin/summary"),
    ]);

    state.transactions = res.data;
    state.txPagination = res.pagination;
    state.summary = summary.data;
    renderTxStats(summary.data);
    renderTransactions();
  }

  function renderTxStats(s) {
    $("txStats").innerHTML = [
      { label: "Nominal terverifikasi", value: formatIDR(s.totalRevenue), icon: "wallet", note: "Dari seluruh order berstatus dibayar" },
      { label: "Menunggu pembayaran", value: String(s.pendingPayments), icon: "clock", note: "Belum dikonfirmasi gateway" },
      { label: "Order dibayar", value: String(s.paidOrders), icon: "check-circle", note: "Pembayaran sudah terverifikasi" },
      { label: "Total order", value: String(s.totalOrders), icon: "receipt", note: "Semua status digabung" },
    ]
      .map(
        (c) =>
          '<div class="stat"><div class="stat-top"><span class="stat-label">' +
          esc(c.label) +
          '</span><span class="stat-mark">' +
          ico(c.icon, "ico-sm") +
          '</span></div><div class="stat-value">' +
          esc(c.value) +
          '</div><div class="stat-note">' +
          esc(c.note) +
          "</div></div>"
      )
      .join("");
  }

  function renderTransactions() {
    const q = ($("txSearch").value || "").toLowerCase().trim();
    const list = q ? state.transactions.filter((o) => orderMatches(o, q)) : state.transactions;

    $("txTable").innerHTML =
      list
        .map(
          (o) =>
            '<tr><td><span class="mono">' +
            esc(o.orderCode) +
            '</span></td><td><b class="truncate" style="display:block;max-width:180px">' +
            esc(o.customer.name || "Tanpa nama") +
            '</b><small class="sub">' +
            esc(o.customer.whatsapp || o.customer.email) +
            '</small></td><td class="truncate" style="max-width:200px">' +
            esc(o.product.name) +
            '</td><td class="num strong">' +
            formatIDR(o.total) +
            "</td><td>" +
            chip(o.paymentStatus) +
            "</td><td>" +
            chip(o.status) +
            "</td>" +
            dateCell(o.createdAt) +
            '<td class="cell-actions"><button class="btn btn-icon btn-sm" type="button" data-order-detail="' +
            o._id +
            '" title="Lihat detail transaksi" aria-label="Lihat detail transaksi">' +
            ico("eye", "ico-sm") +
            "</button></td></tr>"
        )
        .join("") ||
      emptyRow(8, q ? "Tidak ada pembayaran yang cocok." : "Belum ada pembayaran pada filter ini.");

    renderPager($("txPager"), state.txPagination, (page) => {
      state.txPagination.page = page;
      loadTransactions().catch((err) => showToast(err.message, "error"));
    });
  }

  /* ---------------------------------------------------------- order detail */
  async function openOrderDetail(id) {
    openModal("orderModal");
    $("orderModalTitle").textContent = "Detail order";
    $("orderModalSub").textContent = "Mengambil data dari database…";
    $("orderModalBody").innerHTML = '<div class="empty"><span class="boot-spin"></span><b>Memuat detail order</b></div>';
    try {
      const res = await api("/orders/admin/" + id);
      const { order, transaction } = res.data;
      $("orderModalTitle").textContent = order.orderCode;
      $("orderModalSub").textContent = "Dibuat " + formatDate(order.createdAt);

      let html =
        '<div class="detail-group"><h4>Status</h4>' +
        '<div class="detail-row"><span>Status order</span><b>' +
        chip(order.status) +
        "</b></div>" +
        '<div class="detail-row"><span>Status pembayaran</span><b>' +
        chip(order.paymentStatus) +
        "</b></div>" +
        detailRow("Terakhir diperbarui", formatDate(order.updatedAt || order.createdAt)) +
        "</div>";

      html +=
        '<div class="detail-group"><h4>Pembeli</h4>' +
        detailRow("Nama", order.customer.name || "Tidak diisi") +
        detailRow("Email", order.customer.email) +
        detailRow("WhatsApp", order.customer.whatsapp) +
        "</div>";

      html +=
        '<div class="detail-group"><h4>Produk</h4>' +
        detailRow("Nama produk", order.product.name) +
        detailRow("Harga satuan", formatIDR(order.product.price)) +
        detailRow("Jumlah", order.quantity) +
        '<div class="detail-total"><span>Total tagihan</span><b>' +
        esc(formatIDR(order.total)) +
        "</b></div></div>";

      html += '<div class="detail-group"><h4>Transaksi pembayaran</h4>';
      if (transaction) {
        html +=
          detailRow("Gateway", transaction.paymentGateway || "—") +
          detailRow("ID transaksi", transaction.transactionId || "—") +
          detailRow("Nominal dibayar", transaction.totalAmount ? formatIDR(transaction.totalAmount) : "—") +
          '<div class="detail-row"><span>Status transaksi</span><b>' +
          chip(transaction.status) +
          "</b></div>" +
          detailRow("Kedaluwarsa", transaction.expiredAt ? formatDate(transaction.expiredAt) : "—") +
          detailRow("Dibayar pada", transaction.paidAt ? formatDate(transaction.paidAt) : "—");
      } else {
        html +=
          '<div class="notice"><svg class="ico ico-sm"><use href="#i-info"></use></svg><div>Order ini belum punya transaksi pembayaran yang tercatat.</div></div>';
      }
      html += "</div>";

      $("orderModalBody").innerHTML = html;
    } catch (err) {
      $("orderModalSub").textContent = "Gagal memuat";
      $("orderModalBody").innerHTML = emptyState("alert", "Detail order tidak bisa dimuat", err.message);
    }
  }

  function detailRow(label, value) {
    return '<div class="detail-row"><span>' + esc(label) + "</span><b>" + esc(String(value)) + "</b></div>";
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
      '<option value="">Semua kategori</option>' +
      state.categories.map((c) => '<option value="' + c._id + '">' + esc(c.name) + "</option>").join("");
    filter.value = state.categories.some((c) => c._id === keep) ? keep : "";

    const modalSelect = $("pCategory");
    const keepModal = modalSelect.value;
    modalSelect.innerHTML = state.categories.length
      ? state.categories.map((c) => '<option value="' + c._id + '">' + esc(c.name) + "</option>").join("")
      : '<option value="">Belum ada kategori</option>';
    if (state.categories.some((c) => c._id === keepModal)) modalSelect.value = keepModal;
  }

  function filteredProducts() {
    const q = ($("productSearch").value || "").toLowerCase().trim();
    const cat = $("categoryFilter").value;
    const status = $("productStatusFilter").value;
    return state.products.filter(
      (p) =>
        (!q || p.name.toLowerCase().includes(q)) &&
        (!cat || String(categoryIdOf(p)) === cat) &&
        (!status || p.status === status)
    );
  }

  function renderProducts() {
    const list = filteredProducts();
    const isGrid = state.productView === "grid";
    $("productGrid").hidden = !isGrid;
    $("productTableWrap").hidden = isGrid;

    if (!list.length) {
      const empty = state.products.length
        ? emptyState("search", "Produk tidak ditemukan", "Coba ubah kata kunci atau filter yang dipakai.")
        : emptyState(
            "package",
            "Belum ada produk",
            "Tambahkan produk pertama agar Marketplace punya sesuatu untuk dijual.",
            '<button class="btn btn-primary" type="button" data-open-product>' + ico("plus") + "Tambah produk</button>"
          );
      $("productGrid").innerHTML = '<div class="panel" style="grid-column:1/-1">' + empty + "</div>";
      $("productTable").innerHTML = emptyRow(7, state.products.length ? "Produk tidak ditemukan." : "Belum ada produk.");
      return;
    }

    $("productGrid").innerHTML = list
      .map((p) => {
        const low = p.stock <= 0;
        return (
          '<article class="pcard"><div class="pcard-img">' +
          (p.image
            ? '<img src="' + esc(p.image) + '" alt="" loading="lazy">'
            : ico("image")) +
          '<span class="tag"><span>' +
          esc(categoryNameOf(p)) +
          "</span></span>" +
          (p.status === "inactive" ? '<span class="st st-neutral"><i></i>Nonaktif</span>' : "") +
          '</div><div class="pcard-body"><h3>' +
          esc(p.name) +
          "</h3><p class=\"clamp-2\">" +
          esc(p.description || "Belum ada deskripsi.") +
          '</p><div class="pcard-meta"><span class="pcard-price">' +
          formatIDR(p.price) +
          '</span><span class="pcard-stock"' +
          (low ? ' style="color:var(--danger)"' : "") +
          ">" +
          (low ? "Stok habis" : p.stock + " stok") +
          " · " +
          p.sold +
          ' terjual</span></div></div><div class="pcard-foot"><button class="btn btn-sm btn-outline" type="button" data-edit-product="' +
          p._id +
          '">' +
          ico("edit") +
          'Edit</button><button class="btn btn-sm btn-icon danger" type="button" data-delete-product="' +
          p._id +
          '" title="Hapus produk" aria-label="Hapus produk">' +
          ico("trash", "ico-sm") +
          "</button></div></article>"
        );
      })
      .join("");

    $("productTable").innerHTML = list
      .map(
        (p) =>
          '<tr><td><div class="cell-media">' +
          thumbHTML(p.image, p.name) +
          '<div class="cell-media-text"><b>' +
          esc(p.name) +
          "</b><small>" +
          esc(p.slug || "") +
          '</small></div></div></td><td><span class="tag"><span>' +
          esc(categoryNameOf(p)) +
          '</span></span></td><td class="num strong">' +
          formatIDR(p.price) +
          '</td><td class="num"' +
          (p.stock <= 0 ? ' style="color:var(--danger);font-weight:600"' : "") +
          ">" +
          p.stock +
          '</td><td class="num">' +
          p.sold +
          "</td><td>" +
          chipActive(p.status) +
          '</td><td class="cell-actions"><div class="row-actions"><button class="btn btn-icon btn-sm" type="button" data-edit-product="' +
          p._id +
          '" title="Edit produk" aria-label="Edit produk">' +
          ico("edit", "ico-sm") +
          '</button><button class="btn btn-icon btn-sm danger" type="button" data-delete-product="' +
          p._id +
          '" title="Hapus produk" aria-label="Hapus produk">' +
          ico("trash", "ico-sm") +
          "</button></div></td></tr>"
      )
      .join("");
  }

  /* --- form produk --- */
  let pendingImageFile = null;
  let removeExistingImage = false;
  const ALLOWED_IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp"];

  function setDropState(value) {
    $("imageDrop").dataset.state = value;
  }

  function setProductImageFile(file) {
    if (!file) return;
    if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
      showToast("Format gambar belum didukung. Pakai PNG, JPG, atau WEBP.", "error");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      showToast("Ukuran gambar melebihi 5 MB.", "error");
      return;
    }
    pendingImageFile = file;
    removeExistingImage = false;
    setDropState("idle");
    $("imagePreview").src = URL.createObjectURL(file);
    $("imageDrop").classList.add("has-image");
  }

  function openProductModal(id) {
    if (!state.categories.length) {
      showToast("Buat minimal satu kategori sebelum menambah produk.", "error");
      showPage("categories");
      return;
    }
    state.editing.productId = id || null;
    pendingImageFile = null;
    removeExistingImage = false;
    setAlert("productAlert", "");

    const p = id ? state.products.find((x) => x._id === id) : null;

    $("productModalTitle").textContent = p ? "Edit produk" : "Tambah produk";
    $("productSubmit").textContent = p ? "Simpan perubahan" : "Simpan produk";
    $("pName").value = p ? p.name : "";
    $("pCategory").value = p ? categoryIdOf(p) : state.categories[0]._id;
    $("pStatus").value = p ? p.status : "active";
    $("pPrice").value = p ? p.price : "";
    $("pStock").value = p ? p.stock : 0;
    $("pSortOrder").value = p ? p.sortOrder : 0;
    $("pDesc").value = p ? p.description || "" : "";
    $("pSoldHint").textContent = p
      ? "Sudah terjual " + p.sold + " unit. Angka ini dihitung otomatis dari order yang dibayar dan tidak bisa diubah manual."
      : "Jumlah terjual akan dihitung otomatis dari order yang dibayar.";

    const drop = $("imageDrop");
    setDropState("idle");
    $("imageInput").value = "";
    $("imagePreview").src = p && p.image ? p.image : "";
    drop.classList.toggle("has-image", Boolean(p && p.image));
    openModal("productModal");
  }

  async function submitProduct(e) {
    e.preventDefault();
    setAlert("productAlert", "");

    const form = new FormData();
    form.append("name", $("pName").value.trim());
    form.append("categoryId", $("pCategory").value);
    form.append("status", $("pStatus").value);
    form.append("price", $("pPrice").value);
    form.append("stock", $("pStock").value);
    form.append("sortOrder", $("pSortOrder").value || "0");
    form.append("description", $("pDesc").value.trim());
    if (pendingImageFile) form.append("image", pendingImageFile);
    else if (removeExistingImage) form.append("removeImage", "true");

    const id = state.editing.productId;
    const hasImageWork = Boolean(pendingImageFile);
    if (hasImageWork) setDropState("uploading");

    await withBusy($("productSubmit"), "Menyimpan…", async () => {
      try {
        await api(id ? "/products/admin/" + id : "/products/admin", { method: id ? "PUT" : "POST", body: form });
        setDropState("idle");
        closeModal("productModal");
        showToast(id ? "Produk diperbarui." : "Produk ditambahkan.", "success");
        await loadProducts();
      } catch (err) {
        if (hasImageWork) {
          $("uploadErrorMsg").textContent = err.message || "Unggahan gagal, coba lagi.";
          setDropState("error");
        }
        setAlert("productAlert", err.message);
      }
    });
  }

  async function deleteProduct(id) {
    const p = state.products.find((x) => x._id === id);
    const ok = await confirmAction({
      title: "Hapus produk",
      html:
        "Produk <strong>" +
        esc(p ? p.name : "") +
        "</strong> akan dihapus permanen beserta gambarnya di Cloudflare R2. Riwayat order yang sudah ada tidak terpengaruh.",
      confirmLabel: "Hapus produk",
    });
    if (!ok) return;
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
    const [categories, products] = await Promise.all([api("/categories/admin/all"), api("/products/admin/all")]);
    state.categories = categories.data;
    state.products = products.data;
    syncCategoryOptions();
    renderCategories();
  }

  function productCountOf(categoryId) {
    return state.products.filter((p) => String(categoryIdOf(p)) === String(categoryId)).length;
  }

  function renderCategories() {
    const q = ($("categorySearch").value || "").toLowerCase().trim();
    const list = q ? state.categories.filter((c) => (c.name || "").toLowerCase().includes(q)) : state.categories;

    $("categoriesTable").innerHTML =
      list
        .map(
          (c) =>
            '<tr><td><div class="cell-media"><span class="cat-icon">' +
            (c.icon ? esc(c.icon) : ico("layers", "ico-sm")) +
            '</span><div class="cell-media-text"><b>' +
            esc(c.name) +
            "</b></div></div></td><td><code>" +
            esc(c.slug) +
            '</code></td><td class="truncate" style="max-width:260px">' +
            esc(c.description || "—") +
            '</td><td class="num">' +
            productCountOf(c._id) +
            '</td><td class="num">' +
            c.sortOrder +
            "</td><td>" +
            chipActive(c.status) +
            '</td><td class="cell-actions"><div class="row-actions"><button class="btn btn-icon btn-sm" type="button" data-edit-category="' +
            c._id +
            '" title="Edit kategori" aria-label="Edit kategori">' +
            ico("edit", "ico-sm") +
            '</button><button class="btn btn-icon btn-sm danger" type="button" data-delete-category="' +
            c._id +
            '" title="Hapus kategori" aria-label="Hapus kategori">' +
            ico("trash", "ico-sm") +
            "</button></div></td></tr>"
        )
        .join("") ||
      emptyRow(7, state.categories.length ? "Kategori tidak ditemukan." : "Belum ada kategori. Buat satu untuk mulai menata produk.");
  }

  function slugPreview(value) {
    return String(value || "")
      .toLowerCase()
      .trim()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function updateCategoryPreview() {
    $("cIconPreview").textContent = $("cIcon").value.trim() || "◆";
    const c = state.editing.categoryId ? state.categories.find((x) => x._id === state.editing.categoryId) : null;
    $("cSlugPreview").value = c ? c.slug : slugPreview($("cName").value);
  }

  function openCategoryModal(id) {
    state.editing.categoryId = id || null;
    setAlert("categoryAlert", "");
    const c = id ? state.categories.find((x) => x._id === id) : null;
    $("categoryModalTitle").textContent = c ? "Edit kategori" : "Tambah kategori";
    $("categorySubmit").textContent = c ? "Simpan perubahan" : "Simpan kategori";
    $("cName").value = c ? c.name : "";
    $("cIcon").value = c ? c.icon || "" : "";
    $("cSortOrder").value = c ? c.sortOrder : 0;
    $("cStatus").value = c ? c.status : "active";
    $("cDesc").value = c ? c.description || "" : "";
    updateCategoryPreview();
    openModal("categoryModal");
  }

  async function submitCategory(e) {
    e.preventDefault();
    setAlert("categoryAlert", "");
    const body = {
      name: $("cName").value.trim(),
      icon: $("cIcon").value.trim(),
      description: $("cDesc").value.trim(),
      status: $("cStatus").value,
      sortOrder: Number($("cSortOrder").value) || 0,
    };
    const id = state.editing.categoryId;
    await withBusy($("categorySubmit"), "Menyimpan…", async () => {
      try {
        await api(id ? "/categories/admin/" + id : "/categories/admin", { method: id ? "PUT" : "POST", body });
        closeModal("categoryModal");
        showToast(id ? "Kategori diperbarui." : "Kategori ditambahkan.", "success");
        await loadCategories();
      } catch (err) {
        setAlert("categoryAlert", err.message);
      }
    });
  }

  async function deleteCategory(id) {
    const c = state.categories.find((x) => x._id === id);
    const count = productCountOf(id);
    const ok = await confirmAction({
      title: "Hapus kategori",
      html:
        "Kategori <strong>" +
        esc(c ? c.name : "") +
        "</strong> akan dihapus." +
        (count ? " Saat ini ada <strong>" + count + " produk</strong> yang memakai kategori ini." : ""),
      confirmLabel: "Hapus kategori",
    });
    if (!ok) return;
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
            '<tr><td><div class="cell-media"><span class="review-avatar">' +
            esc(initials(c.name || c.email)) +
            '</span><div class="cell-media-text"><b>' +
            esc(c.name || "Tanpa nama") +
            "</b><small>" +
            esc(c.email) +
            '</small></div></div></td><td>' +
            esc(c.whatsapp || "—") +
            '</td><td class="num">' +
            c.orderCount +
            '</td><td class="num">' +
            c.paidOrderCount +
            '</td><td class="num strong">' +
            formatIDR(c.totalSpent) +
            "</td>" +
            dateCell(c.lastOrderAt) +
            "</tr>"
        )
        .join("") || emptyRow(6, search ? "Customer tidak ditemukan." : "Belum ada customer yang tercatat.");

    renderPager($("customersPager"), state.customersPagination, (page) => {
      state.customersPagination.page = page;
      loadCustomers().catch((err) => showToast(err.message, "error"));
    });
  }

  /* -------------------------------------------------- marketplace settings */
  async function loadSettings() {
    const res = await api("/settings/admin");
    state.settings = res.data;
    fillSettingsForm(state.settings);
    applyBranding(state.settings);
  }

  // Reads a possibly-nested value, e.g. getPath(settings.contact, "whatsapp.icon").
  // Plain (non-dotted) fields keep working exactly as before — this is a
  // superset of the old flat `section[field]` lookup, not a replacement for it.
  function getPath(obj, path) {
    return path.split(".").reduce((cur, key) => (cur === undefined || cur === null ? undefined : cur[key]), obj);
  }

  function setPath(obj, path, value) {
    const keys = path.split(".");
    let cur = obj;
    keys.forEach((key, i) => {
      if (i === keys.length - 1) {
        cur[key] = value;
      } else {
        cur[key] = cur[key] && typeof cur[key] === "object" ? cur[key] : {};
        cur = cur[key];
      }
    });
  }

  function fillSettingsForm(s) {
    qsa("[data-section][data-field]").forEach((el) => {
      const section = s[el.dataset.section];
      if (!section) return;
      const value = getPath(section, el.dataset.field);
      if (el.type === "checkbox") el.checked = Boolean(value);
      else if (el.type === "color") el.value = /^#[0-9a-f]{6}$/i.test(String(value || "")) ? value : "#000000";
      else el.value = value === undefined || value === null ? "" : value;
    });

    setPreview("preview-general-logo", s.general.logo);
    setPreview("preview-general-favicon", s.general.favicon);
    setPreview("preview-contact-whatsapp-icon", s.contact.whatsapp && s.contact.whatsapp.icon);
    setPreview("preview-contact-discord-icon", s.contact.discord && s.contact.discord.icon);
    setPreview("preview-footer-logo", s.footer.logo);
    setPreview("preview-background-image", s.background.image);
    setPreview("preview-home-hero-image-url", getPath(s.home || {}, "hero.image.url"));

    renderNavbarItems(s.navbar.items || []);
    renderHeroSlides(getPath(s.home || {}, "hero.slides") || []);
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
    const name = (s.general && s.general.storeName) || "Store";
    $("brandName").textContent = name;
    const mark = $("brandMark");
    if (s.general && s.general.logo) {
      mark.innerHTML = '<img src="' + esc(s.general.logo) + '" alt="">';
    } else {
      mark.textContent = name.trim().charAt(0).toUpperCase() || "·";
    }
    document.title = "Admin Console — " + name;

    const online = !s.general || s.general.websiteStatus === "online";
    $("storeStatusText").textContent = online ? "Marketplace online" : "Mode maintenance";
    $("storeStatus").dataset.state = online ? "online" : "maintenance";
  }

  /* --- baris berulang (navbar, statistik, highlight, footer) --- */
  function repeatRow(inner, index) {
    return (
      '<div class="repeat-row" data-index="' +
      index +
      '"><div class="repeat-fields">' +
      inner +
      '</div><div class="repeat-actions"><button class="btn btn-icon btn-sm" type="button" data-move="up" title="Naikkan" aria-label="Naikkan">' +
      ico("arrow-up", "ico-sm") +
      '</button><button class="btn btn-icon btn-sm" type="button" data-move="down" title="Turunkan" aria-label="Turunkan">' +
      ico("arrow-down", "ico-sm") +
      '</button><button class="btn btn-icon btn-sm danger" type="button" data-remove="1" title="Hapus baris" aria-label="Hapus baris">' +
      ico("trash", "ico-sm") +
      "</button></div></div>"
    );
  }

  function field(label, key, value, opts) {
    const o = opts || {};
    return (
      '<label class="field' +
      (o.full ? " span-full" : "") +
      '"><span>' +
      esc(label) +
      "</span>" +
      (o.textarea
        ? '<textarea data-key="' + key + '" rows="2">' + esc(value || "") + "</textarea>"
        : '<input data-key="' + key + '" value="' + esc(value || "") + '"' + (o.readonly ? " readonly" : "") + (o.placeholder ? ' placeholder="' + esc(o.placeholder) + '"' : "") + ">") +
      "</label>"
    );
  }

  function switchField(label, key, checked, disabled) {
    return (
      '<div class="field"><span>' +
      esc(label) +
      '</span><label class="switch"><input type="checkbox" data-key="' +
      key +
      '"' +
      (checked ? " checked" : "") +
      (disabled ? " disabled" : "") +
      "><i></i></label></div>"
    );
  }

  function renderNavbarItems(items) {
    $("navbarItems").innerHTML =
      items
        .map((item, i) =>
          repeatRow(
            field("Label", "label", item.label, { placeholder: "Produk" }) +
              field("Tujuan", "route", item.route, { placeholder: "#produk" }) +
              field("Ikon", "icon", item.icon) +
              switchField("Aktif", "enabled", item.enabled !== false),
            i
          )
        )
        .join("") || emptyState("list", "Belum ada menu", "Tambah menu agar pengunjung bisa berpindah bagian.");
  }

  const STAT_KEYS = [
    ["totalProdukTerjual", "Total produk terjual"],
    ["averageRating", "Rating rata-rata"],
    ["totalBuyer", "Total pembeli"],
    ["totalProduk", "Total produk"],
    ["successfulOrders", "Order berhasil"],
    ["support", "Dukungan"],
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
        const hasToggle = key !== "support";
        return repeatRow(
          field("Kunci", "key", key, { readonly: true }) +
            field("Label", "label", label, { readonly: true }) +
            (hasToggle
              ? switchField("Tampilkan", "visible", statistics[key + "Visible"] !== false)
              : switchField("Selalu tampil", "visible", true, true)),
          i
        );
      })
      .join("");
  }

  // Hero slides. Each row owns its own image, so the upload control lives in
  // the row and writes straight into that row's `image` field — it posts to
  // the same /settings/admin/upload endpoint (and therefore the same R2
  // bucket) as every other asset in this panel, no second upload path.
  function slideImageField(value) {
    return (
      '<label class="field span-full"><span>Gambar slide</span>' +
      '<span class="row-asset">' +
      '<img class="row-thumb" src="' + esc(value || "") + '" alt="">' +
      '<input type="file" class="row-file" accept="image/*" data-row-upload="1">' +
      "</span>" +
      '<input data-key="image" value="' + esc(value || "") + '" placeholder="URL gambar, terisi otomatis setelah unggah">' +
      "</label>"
    );
  }

  function renderHeroSlides(slides) {
    const ordered = slides.slice().sort((a, b) => (a.sortOrder || 0) - (b.sortOrder || 0));
    $("heroSlides").innerHTML =
      ordered
        .map((slide, i) =>
          repeatRow(
            slideImageField(slide.image) +
              field("Teks alternatif", "alt", slide.alt, { placeholder: "Deskripsi singkat gambar" }) +
              switchField("Aktif", "enabled", slide.enabled !== false) +
              field("Kiri atas", "topLeft", slide.topLeft) +
              field("Kanan atas", "topRight", slide.topRight, { placeholder: "Kosong = nomor slide otomatis" }) +
              field("Kiri bawah", "bottomLeft", slide.bottomLeft) +
              field("Kanan bawah", "bottomRight", slide.bottomRight),
            i
          )
        )
        .join("") ||
      emptyState("image", "Belum ada slide", "Hero memakai satu gambar di atas. Tambah slide kalau ingin gambarnya bergantian.");
  }

  async function uploadSlideImage(input) {
    const file = input.files && input.files[0];
    if (!file) return;

    const row = input.closest(".repeat-row");
    const target = row && row.querySelector('[data-key="image"]');
    const thumb = row && row.querySelector(".row-thumb");
    if (!target) return;

    if (!UPLOAD_ALLOWED_MIME.includes(file.type)) {
      showToast("Tipe file tidak didukung. Gunakan JPG, PNG, WEBP, GIF, atau SVG.", "error");
      input.value = "";
      return;
    }
    if (file.size > UPLOAD_MAX_BYTES) {
      showToast("Ukuran file maksimal 5MB.", "error");
      input.value = "";
      return;
    }

    // Roll back to whatever the row held before, not to the <img> src, so a
    // failed upload restores the saved URL instead of the page's own URL.
    const previous = target.value;
    const blobUrl = URL.createObjectURL(file);
    if (thumb) thumb.src = blobUrl;

    const form = new FormData();
    form.append("file", file);
    form.append("folder", "hero");

    try {
      const res = await api("/settings/admin/upload", { method: "POST", body: form });
      if (!res.data || !res.data.url) throw new Error("Upload gagal: server tidak mengembalikan URL gambar.");
      target.value = res.data.url;
      if (thumb) thumb.src = res.data.url;
      showToast("Gambar slide terunggah. Tekan simpan untuk menerapkannya.", "success");
    } catch (err) {
      target.value = previous;
      if (thumb) thumb.src = previous;
      showToast(err.message, "error");
    } finally {
      URL.revokeObjectURL(blobUrl);
      input.value = "";
    }
  }

  function renderHighlights(items) {
    $("highlightItems").innerHTML =
      items
        .map((item, i) =>
          repeatRow(
            field("Ikon", "icon", item.icon) +
              field("Judul", "title", item.title) +
              switchField("Aktif", "enabled", item.enabled !== false) +
              field("Deskripsi", "description", item.description, { textarea: true, full: true }),
            i
          )
        )
        .join("") || emptyState("sparkle", "Belum ada highlight", "Tambah keunggulan store agar pengunjung cepat paham.");
  }

  function renderFooterLinks(links) {
    $("footerLinks").innerHTML =
      links.map((l, i) => repeatRow(field("Label", "label", l.label) + field("URL", "url", l.url), i)).join("") ||
      emptyState("link", "Belum ada tautan footer", "Tambahkan tautan penting seperti syarat layanan.");
  }

  function renderFooterSocial(social) {
    $("footerSocial").innerHTML =
      social.map((s, i) => repeatRow(field("Platform", "platform", s.platform) + field("URL", "url", s.url), i)).join("") ||
      emptyState("share", "Belum ada media sosial", "Tambahkan akun sosial store kamu.");
  }

  function collectRows(containerId) {
    return qsa("#" + containerId + " .repeat-row").map((row, index) => {
      const obj = { sortOrder: index };
      qsa("[data-key]", row).forEach((f) => {
        obj[f.dataset.key] = f.type === "checkbox" ? f.checked : f.value;
      });
      return obj;
    });
  }

  function collectSectionFields(section) {
    const data = {};
    qsa('[data-section="' + section + '"][data-field]').forEach((el) => {
      const value = el.type === "checkbox" ? el.checked : el.value;
      setPath(data, el.dataset.field, value);
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

    // `updateSection` replaces the section object it receives, so the whole
    // hero (including its slides) has to travel in one payload. The dotted
    // data-field names above already rebuilt `data.hero`; only the repeating
    // rows are left to attach.
    if (section === "home") {
      data.hero = data.hero || {};
      data.hero.slides = collectRows("heroSlides")
        .filter((r) => r.image)
        .map((r) => ({
          image: r.image,
          alt: r.alt,
          enabled: r.enabled,
          sortOrder: r.sortOrder,
          topLeft: r.topLeft,
          topRight: r.topRight,
          bottomLeft: r.bottomLeft,
          bottomRight: r.bottomRight,
        }));
    }

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
    await withBusy(button, "Menyimpan…", async () => {
      try {
        const res = await api("/settings/admin/" + section, { method: "PATCH", body: buildSectionPayload(section) });
        state.settings = res.data;
        fillSettingsForm(state.settings);
        applyBranding(state.settings);
        showToast("Perubahan tersimpan dan sudah dikirim ke Marketplace.", "success");
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  }

  // Same allow-list and size limit as server/middlewares/upload.js — checked
  // here too so a bad file is rejected instantly instead of after a round
  // trip to the API, and so the person gets an immediate, specific message.
  const UPLOAD_ALLOWED_MIME = ["image/jpeg", "image/png", "image/webp", "image/gif", "image/svg+xml", "image/x-icon"];
  const UPLOAD_MAX_BYTES = 5 * 1024 * 1024;

  async function uploadAsset(input) {
    const file = input.files && input.files[0];
    if (!file) return;

    // uploadTarget can be "section.field" (e.g. "general.logo") or a nested
    // path "section.field.subfield" (e.g. "contact.whatsapp.icon") — first
    // segment is always the settings section, the rest is the field path.
    const targetParts = input.dataset.uploadTarget.split(".");
    const section = targetParts.shift();
    const fieldName = targetParts.join(".");
    const previewId = "preview-" + section + "-" + fieldName.replace(/\./g, "-");
    // Read the last-known-good value from app state, not the <img> DOM src —
    // reading back an empty img.src returns the page's own URL (a DOM
    // quirk), which would show a broken image instead of an empty preview
    // if we rolled back to it after a failed upload.
    const previousValue = (state.settings && getPath(state.settings[section] || {}, fieldName)) || "";

    if (!UPLOAD_ALLOWED_MIME.includes(file.type)) {
      showToast("Tipe file tidak didukung. Gunakan JPG, PNG, WEBP, GIF, atau SVG.", "error");
      input.value = "";
      return;
    }
    if (file.size > UPLOAD_MAX_BYTES) {
      showToast("Ukuran file maksimal 5MB.", "error");
      input.value = "";
      return;
    }

    // Preview before upload finishes (local blob URL), so the admin sees
    // feedback immediately instead of a blank box while R2 is still working.
    const blobUrl = URL.createObjectURL(file);
    setPreview(previewId, blobUrl);

    const form = new FormData();
    form.append("file", file);
    form.append("folder", input.dataset.uploadFolder || "settings");

    const box = input.closest(".asset");
    if (box) box.classList.add("uploading");
    try {
      const res = await api("/settings/admin/upload", { method: "POST", body: form });
      if (!res.data || !res.data.url) throw new Error("Upload gagal: server tidak mengembalikan URL gambar.");
      const hidden = document.querySelector('[data-section="' + section + '"][data-field="' + fieldName + '"]');
      if (hidden) hidden.value = res.data.url;
      // Swap to the real R2 URL now that it's confirmed saved server-side.
      setPreview(previewId, res.data.url);
      showToast("File terunggah. Tekan tombol simpan untuk menerapkannya.", "success");
    } catch (err) {
      setPreview(previewId, previousValue);
      showToast(err.message, "error");
    } finally {
      URL.revokeObjectURL(blobUrl);
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
          (f) =>
            '<div class="faq-item"><span class="faq-order">' +
            f.sortOrder +
            '</span><div class="faq-text"><b>' +
            esc(f.question) +
            "</b><p>" +
            esc(f.answer) +
            "</p>" +
            (f.enabled ? "" : '<span class="st st-neutral"><i></i>Disembunyikan</span>') +
            '</div><div class="row-actions"><button class="btn btn-icon btn-sm" type="button" data-edit-faq="' +
            f._id +
            '" title="Edit FAQ" aria-label="Edit FAQ">' +
            ico("edit", "ico-sm") +
            '</button><button class="btn btn-icon btn-sm danger" type="button" data-delete-faq="' +
            f._id +
            '" title="Hapus FAQ" aria-label="Hapus FAQ">' +
            ico("trash", "ico-sm") +
            "</button></div></div>"
        )
        .join("") ||
      emptyState(
        "help",
        "Belum ada FAQ",
        "Tambahkan pertanyaan yang paling sering ditanyakan pembeli.",
        '<button class="btn btn-primary" type="button" data-open-faq>' + ico("plus") + "Tambah FAQ</button>"
      );
  }

  function openFaqModal(id) {
    state.editing.faqId = id || null;
    setAlert("faqAlert", "");
    const f = id ? state.faqs.find((x) => x._id === id) : null;
    $("faqModalTitle").textContent = f ? "Edit FAQ" : "Tambah FAQ";
    $("faqSubmit").textContent = f ? "Simpan perubahan" : "Simpan FAQ";
    $("fQuestion").value = f ? f.question : "";
    $("fAnswer").value = f ? f.answer : "";
    $("fSortOrder").value = f ? f.sortOrder : state.faqs.length;
    $("fEnabled").value = f ? String(f.enabled) : "true";
    openModal("faqModal");
  }

  async function submitFaq(e) {
    e.preventDefault();
    setAlert("faqAlert", "");
    const body = {
      question: $("fQuestion").value.trim(),
      answer: $("fAnswer").value.trim(),
      sortOrder: Number($("fSortOrder").value) || 0,
      enabled: $("fEnabled").value === "true",
    };
    const id = state.editing.faqId;
    await withBusy($("faqSubmit"), "Menyimpan…", async () => {
      try {
        await api(id ? "/faq/admin/" + id : "/faq/admin", { method: id ? "PUT" : "POST", body });
        closeModal("faqModal");
        showToast(id ? "FAQ diperbarui." : "FAQ ditambahkan.", "success");
        await loadFaqs();
      } catch (err) {
        setAlert("faqAlert", err.message);
      }
    });
  }

  async function deleteFaq(id) {
    const f = state.faqs.find((x) => x._id === id);
    const ok = await confirmAction({
      title: "Hapus FAQ",
      html: "Pertanyaan <strong>" + esc(f ? f.question : "") + "</strong> akan dihapus dari Marketplace.",
      confirmLabel: "Hapus FAQ",
    });
    if (!ok) return;
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
    const status = state.ratingFilter;
    const [res, stats] = await Promise.all([
      api("/ratings/admin/all" + (status ? "?status=" + status : "")),
      api("/statistics"),
    ]);
    state.ratings = res.data;

    const approved = res.data.filter((r) => r.status === "approved");
    $("ratingAvg").textContent = stats.data.ratingCount ? stats.data.averageRating : "—";
    $("ratingStars").innerHTML = starsInner(stats.data.ratingCount ? stats.data.averageRating : 0);
    $("ratingTotal").textContent = stats.data.ratingCount + " review disetujui";

    const buckets = [5, 4, 3, 2, 1].map((n) => ({ n, count: approved.filter((r) => Math.round(r.rating) === n).length }));
    const maxBucket = Math.max.apply(null, buckets.map((b) => b.count).concat([1]));
    $("ratingBars").innerHTML = buckets
      .map(
        (b) =>
          '<div class="rating-bar"><span class="k">' +
          b.n +
          '<svg class="ico on" style="width:12px;height:12px;color:#d9a441"><use href="#i-star"></use></svg></span><i><b style="width:' +
          Math.round((b.count / maxBucket) * 100) +
          '%"></b></i><span class="n">' +
          b.count +
          "</span></div>"
      )
      .join("");

    const pending = state.ratings.filter((r) => r.status === "pending").length;
    const badge = $("ratingBadge");
    badge.textContent = String(pending);
    badge.hidden = !pending;

    $("reviewAdmin").innerHTML =
      res.data
        .map((r) => {
          const product = r.productId ? state.products.find((p) => p._id === String(r.productId)) : null;
          return (
            '<article class="review"><div class="review-top"><div class="review-who"><span class="review-avatar">' +
            (r.avatar ? '<img src="' + esc(r.avatar) + '" alt="">' : esc(initials(r.user))) +
            "</span><div><b>" +
            esc(r.user) +
            "</b>" +
            starsHTML(r.rating) +
            "</div></div>" +
            chipReview(r.status) +
            "</div><p>" +
            esc(r.review) +
            '</p><div class="review-foot"><div class="review-meta">' +
            ico("clock", "ico-sm") +
            esc(formatDate(r.createdAt)) +
            (product ? '<span class="tag"><span>' + esc(product.name) + "</span></span>" : "") +
            '</div><div class="row-actions">' +
            (r.status !== "approved"
              ? '<button class="btn btn-sm btn-outline" type="button" data-rating-status="approved" data-id="' +
                r._id +
                '">' +
                ico("check") +
                "Setujui</button>"
              : "") +
            (r.status !== "hidden"
              ? '<button class="btn btn-sm btn-outline" type="button" data-rating-status="hidden" data-id="' +
                r._id +
                '">Sembunyikan</button>'
              : "") +
            '<button class="btn btn-icon btn-sm danger" type="button" data-delete-rating="' +
            r._id +
            '" title="Hapus review" aria-label="Hapus review">' +
            ico("trash", "ico-sm") +
            "</button></div></div></article>"
          );
        })
        .join("") ||
      '<div class="panel" style="grid-column:1/-1">' +
        emptyState("star", "Belum ada review", "Review dari pembeli akan muncul di sini untuk dimoderasi.") +
        "</div>";
  }

  async function setRatingStatus(id, status) {
    try {
      await api("/ratings/admin/" + id + "/status", { method: "PATCH", body: { status } });
      showToast(status === "approved" ? "Review disetujui dan tampil di Marketplace." : "Review disembunyikan.", "success");
      await loadRatings();
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  async function deleteRating(id) {
    const ok = await confirmAction({
      title: "Hapus review",
      text: "Review ini akan dihapus permanen dan tidak bisa dikembalikan.",
      confirmLabel: "Hapus review",
    });
    if (!ok) return;
    try {
      await api("/ratings/admin/" + id, { method: "DELETE" });
      showToast("Review dihapus.", "success");
      await loadRatings();
    } catch (err) {
      showToast(err.message, "error");
    }
  }

  /* ---------------------------------------------------------- integrations */
  const PROVIDER = {
    klikqris: { label: "KlikQRIS", icon: "qr", desc: "Pembayaran QRIS untuk checkout Marketplace." },
    fonnte: { label: "Fonnte", icon: "message", desc: "Notifikasi WhatsApp ke pembeli." },
    resend: { label: "Resend", icon: "mail", desc: "Email transaksional ke pembeli." },
    r2: { label: "Cloudflare R2", icon: "cloud", desc: "Penyimpanan gambar produk dan aset." },
  };

  async function loadIntegrations() {
    const [statusRes, templatesRes] = await Promise.all([api("/integrations/status"), api("/integrations/templates")]);
    state.integrations = statusRes.data;
    state.templates = templatesRes.data;
    renderIntegrationStatus();
    fillIntegrationForms();
    fillTemplateForms();
    // Riwayat pengiriman dimuat terpisah: kalau endpointnya bermasalah, tab
    // Integrasi tetap terbuka dan bisa dipakai, hanya tabelnya yang kosong.
    await loadNotificationLogs().catch((err) => showToast(err.message, "error"));
  }

  /* ------------------------------------------------- riwayat notifikasi */

  const NOTIF_EVENT_LABEL = {
    orderCreated: "Pesanan dibuat",
    paymentPending: "Menunggu pembayaran",
    paymentSuccess: "Pembayaran berhasil",
    paymentFailed: "Pembayaran gagal",
    paymentExpired: "Pembayaran kedaluwarsa",
    orderCompleted: "Pesanan selesai",
  };

  // Status pengiriman per channel — sengaja dibedakan dari status order
  // supaya "email gagal" tidak pernah terbaca sebagai "pesanan gagal".
  const NOTIF_STATUS = {
    sent: { cls: "st-success", text: "Terkirim" },
    failed: { cls: "st-danger", text: "Gagal" },
    sending: { cls: "st-pending", text: "Dikirim…" },
    pending: { cls: "st-neutral", text: "Menunggu" },
  };

  async function loadNotificationLogs() {
    const f = state.notifLogFilters;
    const params = new URLSearchParams();
    if (f.orderCode) params.set("orderCode", f.orderCode);
    if (f.event) params.set("event", f.event);
    if (f.channel) params.set("channel", f.channel);
    if (f.status) params.set("status", f.status);
    params.set("page", state.notifLogsPagination.page);
    params.set("limit", state.notifLogsPagination.limit);

    const res = await api("/integrations/notifications/logs?" + params.toString());
    state.notifLogs = res.data || [];
    state.notifLogsPagination = res.pagination || state.notifLogsPagination;
    renderNotificationLogs();
  }

  function renderNotificationLogs() {
    const body = $("notifLogsTable");
    if (!body) return;

    body.innerHTML =
      state.notifLogs
        .map((row) => {
          const st = NOTIF_STATUS[row.status] || NOTIF_STATUS.pending;
          // Waktu yang ditampilkan adalah waktu kejadian terakhir yang nyata:
          // saat terkirim, saat gagal, atau saat baris dibuat.
          const when = row.sentAt || row.failedAt || row.createdAt;
          // Kirim ulang hanya masuk akal untuk yang belum berhasil.
          const retry =
            row.status === "sent"
              ? ""
              : '<button class="btn btn-icon btn-sm" type="button" data-retry-notif="' +
                esc(row._id) +
                '" title="Kirim ulang" aria-label="Kirim ulang">' +
                ico("refresh", "ico-sm") +
                "</button>";
          return (
            "<tr><td><b>" +
            esc(row.orderCode || "—") +
            "</b></td><td>" +
            esc(NOTIF_EVENT_LABEL[row.event] || row.event) +
            '</td><td class="shrink">' +
            esc(row.channel === "whatsapp" ? "WhatsApp" : "Email") +
            "</td><td>" +
            esc(row.recipient || "—") +
            '</td><td class="shrink"><span class="st ' +
            st.cls +
            '"><i></i>' +
            esc(st.text) +
            '</span></td><td class="num shrink">' +
            esc(row.attempts || 0) +
            "</td>" +
            dateCell(when) +
            '<td class="sub">' +
            esc(row.error || "—") +
            '</td><td class="cell-actions">' +
            retry +
            "</td></tr>"
          );
        })
        .join("") ||
      emptyRow(9, "Belum ada notifikasi yang dikirim. Baris akan muncul otomatis setelah ada pesanan.");

    renderPager($("notifLogsPager"), state.notifLogsPagination, (page) => {
      state.notifLogsPagination.page = page;
      loadNotificationLogs().catch((err) => showToast(err.message, "error"));
    });
  }

  async function retryNotification(id, button) {
    await withBusy(button, "", async () => {
      try {
        const res = await api("/integrations/notifications/logs/" + id + "/retry", { method: "POST" });
        showToast(res.message || "Notifikasi dikirim ulang.", "success");
      } catch (err) {
        // Pesan dari server adalah alasan asli dari provider — ditampilkan
        // apa adanya, bukan diganti "gagal" yang tidak bisa ditindaklanjuti.
        showToast(err.message, "error");
      }
      await loadNotificationLogs().catch(() => {});
    });
  }

  function providerState(info, provider) {
    if (!info.configured) return { cls: "st-neutral", text: "Belum dikonfigurasi" };
    if (info.lastTestStatus === "error") return { cls: "st-danger", text: "Bermasalah" };
    if (provider !== "r2" && !info.enabled) return { cls: "st-neutral", text: "Dinonaktifkan" };
    if (info.lastTestStatus === "success") return { cls: "st-success", text: "Terhubung" };
    return { cls: "st-pending", text: "Belum diuji" };
  }

  function statePill(info, key) {
    const st = providerState(info, key);
    return '<span class="st ' + st.cls + '"><i></i>' + esc(st.text) + "</span>";
  }

  function renderIntegrationStatus() {
    $("integrationStatus").innerHTML = Object.keys(PROVIDER)
      .map((key) => {
        const info = state.integrations[key];
        const meta = PROVIDER[key];
        return (
          '<div class="int-card"><div class="int-card-top"><div class="int-card-id"><span class="int-logo">' +
          ico(meta.icon, "ico-sm") +
          "</span><b>" +
          esc(meta.label) +
          "</b></div>" +
          statePill(info, key) +
          "</div><small>" +
          esc(meta.desc) +
          "</small><small>" +
          esc(info.lastTestAt ? "Diuji " + formatDate(info.lastTestAt) : "Belum pernah diuji") +
          "</small>" +
          (info.lastTestMessage ? "<small>" + esc(info.lastTestMessage) + "</small>" : "") +
          "</div>"
        );
      })
      .join("");

    $("kqStatePill").innerHTML = statePill(state.integrations.klikqris, "klikqris");
    $("fnStatePill").innerHTML = statePill(state.integrations.fonnte, "fonnte");
    $("rsStatePill").innerHTML = statePill(state.integrations.resend, "resend");
    $("r2StatePill").innerHTML = statePill(state.integrations.r2, "r2");
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

    $("r2StatusText").value = providerState(i.r2, "r2").text;
    $("r2LastTest").value = i.r2.lastTestAt ? formatDate(i.r2.lastTestAt) : "Belum pernah diuji";

    $("notifWa").checked = Boolean(i.notifications.whatsappEnabled);
    $("notifEmail").checked = Boolean(i.notifications.emailEnabled);
    qsa("[data-notif-event]").forEach((el) => {
      el.checked = Boolean(i.notifications.events[el.dataset.notifEvent]);
    });

    $("webhookUrlHint").textContent = window.location.origin + "/api/payments/klikqris/webhook";
  }

  const EMAIL_EVENTS = [
    ["orderCreated", "Order dibuat"],
    ["paymentSuccess", "Pembayaran berhasil"],
    ["paymentFailed", "Pembayaran gagal"],
    ["paymentExpired", "Pembayaran kedaluwarsa"],
  ];

  function fillTemplateForms() {
    qsa("[data-tpl-wa]").forEach((el) => {
      el.value = state.templates.whatsapp[el.dataset.tplWa] || "";
    });

    $("emailTemplates").innerHTML = EMAIL_EVENTS.map((ev) => {
      const tpl = state.templates.email[ev[0]] || {};
      return (
        '<div class="tpl-block"><h4>' +
        esc(ev[1]) +
        '</h4><label class="field"><span>Subjek</span><input data-tpl-email-subject="' +
        ev[0] +
        '" value="' +
        esc(tpl.subject || "") +
        '"></label><label class="field"><span>Isi HTML</span><textarea data-tpl-email-html="' +
        ev[0] +
        '" rows="6">' +
        esc(tpl.html || "") +
        "</textarea></label></div>"
      );
    }).join("");
  }

  async function saveIntegration(provider, button, body) {
    await withBusy(button, "Menyimpan…", async () => {
      try {
        await api("/integrations/" + provider, { method: "PUT", body });
        showToast("Konfigurasi " + PROVIDER[provider].label + " tersimpan.", "success");
        await loadIntegrations();
      } catch (err) {
        showToast(err.message, "error");
      }
    });
  }

  async function testIntegration(provider, button, body) {
    await withBusy(button, "Menguji…", async () => {
      try {
        const res = await fetch("/api/integrations/" + provider + "/test", {
          method: "POST",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + getToken() },
          body: JSON.stringify(body || {}),
        });
        const payload = await res.json().catch(() => null);
        if (res.status === 401) return logout();
        showToast((payload && payload.message) || "Pengujian selesai.", payload && payload.status ? "success" : "error");
      } catch (err) {
        showToast("Pengujian tidak bisa dijalankan: " + err.message, "error");
      } finally {
        await loadIntegrations().catch(() => {});
      }
    });
  }

  /* ---------------------------------------------------- account & security */
  async function loadAccountPage() {
    const admin = state.admin;
    $("accName").value = admin.name;
    $("accEmail").value = admin.email;
    $("accRole").value = admin.role === "superadmin" ? "Superadmin" : "Admin";
    $("accLastLogin").value = admin.lastLoginAt ? formatDate(admin.lastLoginAt) : "—";

    const isSuper = admin.role === "superadmin";
    $("addAdminSection").hidden = !isSuper;
    if (!isSuper) {
      $("adminsNote").textContent = "Hanya superadmin yang bisa melihat dan mengelola akun admin.";
      $("adminsTable").innerHTML = emptyRow(6, "Akses daftar admin terbatas untuk superadmin.");
      return;
    }

    $("adminsNote").textContent = "Kelola siapa saja yang bisa masuk ke Admin Console.";
    const res = await api("/admins");
    $("adminsTable").innerHTML =
      res.data
        .map(
          (a) =>
            '<tr><td><div class="cell-media"><span class="review-avatar">' +
            esc(initials(a.name)) +
            '</span><div class="cell-media-text"><b>' +
            esc(a.name) +
            "</b></div></div></td><td>" +
            esc(a.email) +
            '</td><td><span class="tag"><span>' +
            esc(a.role === "superadmin" ? "Superadmin" : "Admin") +
            "</span></span></td>" +
            dateCell(a.lastLoginAt) +
            "<td>" +
            (a.active ? '<span class="st st-success"><i></i>Aktif</span>' : '<span class="st st-neutral"><i></i>Nonaktif</span>') +
            '</td><td class="cell-actions">' +
            (a._id === state.admin._id
              ? '<span class="tag"><span>Akun ini</span></span>'
              : '<button class="btn btn-sm btn-outline" type="button" data-toggle-admin="' +
                a._id +
                '" data-active="' +
                (a.active ? "false" : "true") +
                '">' +
                (a.active ? "Nonaktifkan" : "Aktifkan") +
                "</button>") +
            "</td></tr>"
        )
        .join("") || emptyRow(6, "Belum ada akun admin lain.");
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

  async function loadHealth() {
    $("healthBox").innerHTML = '<div class="empty"><span class="boot-spin"></span><b>Memeriksa server</b></div>';
    try {
      const res = await fetch("/api/health");
      const payload = await res.json();
      const rows = [
        ["Server", payload.server, "server"],
        ["MongoDB", payload.mongodb, "database"],
        ["Cloudflare R2", payload.r2, "cloud"],
        ["KlikQRIS", payload.integrations ? payload.integrations.klikqris : "unknown", "qr"],
        ["Fonnte", payload.integrations ? payload.integrations.fonnte : "unknown", "message"],
        ["Resend", payload.integrations ? payload.integrations.resend : "unknown", "mail"],
        ["Waktu server", payload.time ? formatDate(payload.time) : "—", "clock"],
      ];
      $("healthBox").innerHTML = rows
        .map((r) => '<div class="kv"><span>' + esc(r[0]) + "</span><b>" + esc(String(r[1])) + "</b></div>")
        .join("");
    } catch (err) {
      $("healthBox").innerHTML = emptyState("alert", "Status server tidak bisa dibaca", "Coba muat ulang beberapa saat lagi.");
    }
  }

  /* --------------------------------------------------------- notifications */
  function pushNotification(kind, title, text) {
    state.notifications.unshift({ kind, title, text, at: new Date().toISOString() });
    state.notifications = state.notifications.slice(0, 30);
    state.unread += 1;
    renderNotifications();
  }

  function renderNotifications() {
    const pip = $("notifPip");
    pip.textContent = state.unread > 9 ? "9+" : String(state.unread);
    pip.hidden = state.unread === 0;

    $("notifList").innerHTML =
      state.notifications
        .map(
          (n) =>
            '<div class="pop-item">' +
            ico(n.kind === "success" ? "check-circle" : n.kind === "error" ? "alert" : "info", "ico-sm") +
            "<div><b>" +
            esc(n.title) +
            "</b><small>" +
            esc(n.text) +
            "</small><time>" +
            esc(timeAgo(n.at)) +
            "</time></div></div>"
        )
        .join("") ||
      '<div class="pop-empty">Belum ada aktivitas sejak kamu masuk. Kejadian realtime akan muncul di sini.</div>';
  }

  /* ---------------------------------------------------------- global search */
  function runGlobalSearch() {
    const q = ($("globalSearch").value || "").toLowerCase().trim();
    const box = $("globalResults");
    if (!q) {
      box.classList.remove("open");
      return;
    }

    const pages = Object.keys(PAGES)
      .filter((k) => PAGES[k].title.toLowerCase().includes(q))
      .slice(0, 3)
      .map(
        (k) =>
          '<button class="pop-item" type="button" data-go-page="' +
          k +
          '">' +
          ico("chevron-right", "ico-sm") +
          "<div><b>" +
          esc(PAGES[k].title) +
          "</b><small>Halaman " +
          esc(PAGES[k].group) +
          "</small></div></button>"
      );

    const products = state.products
      .filter((p) => p.name.toLowerCase().includes(q))
      .slice(0, 5)
      .map(
        (p) =>
          '<button class="pop-item" type="button" data-go-product="' +
          p._id +
          '">' +
          ico("package", "ico-sm") +
          "<div><b>" +
          esc(p.name) +
          "</b><small>" +
          esc(formatIDR(p.price) + " · " + p.stock + " stok") +
          "</small></div></button>"
      );

    const orders = state.orders
      .filter((o) => orderMatches(o, q))
      .slice(0, 5)
      .map(
        (o) =>
          '<button class="pop-item" type="button" data-order-detail="' +
          o._id +
          '">' +
          ico("receipt", "ico-sm") +
          "<div><b>" +
          esc(o.orderCode) +
          "</b><small>" +
          esc((o.customer.name || o.customer.email) + " · " + formatIDR(o.total)) +
          "</small></div></button>"
      );

    const all = pages.concat(products, orders);
    box.innerHTML = all.length
      ? '<div class="pop-body">' + all.join("") + "</div>"
      : '<div class="pop-empty">Tidak ada yang cocok. Coba kata kunci lain.</div>';
    box.classList.add("open");
  }

  function closeAllPops() {
    qsa(".pop.open").forEach((p) => p.classList.remove("open"));
  }

  /* -------------------------------------------------------------- realtime */
  let realtimeReady = false;

  function refreshCurrentPage() {
    const loader = LOADERS[state.currentPage];
    if (loader) loader().catch(() => {});
  }
  const refreshCurrentPageDebounced = debounce(refreshCurrentPage, 400);

  const refreshOrdersRelated = debounce(() => {
    api("/orders/admin/summary")
      .then((res) => updateOrderBadge(res.data.pendingPayments))
      .catch(() => {});
    if (["orders", "transactions", "dashboard", "customers"].includes(state.currentPage)) refreshCurrentPage();
  }, 400);

  function initRealtime() {
    if (realtimeReady) return; // listener dipasang sekali saja
    const socket = getSocket();
    if (!socket) return;
    realtimeReady = true;

    const pill = $("connPill");
    socket.on("connect", () => {
      pill.dataset.state = "online";
      refreshCurrentPage(); // sinkron ulang setelah reconnect / restart server
    });
    socket.on("disconnect", () => {
      pill.dataset.state = "offline";
    });

    socket.on("order:created", (payload) => {
      const code = (payload && payload.orderCode) || "";
      showToast("Pesanan baru masuk" + (code ? ": " + code : "") + ".", "info");
      pushNotification("info", "Pesanan baru", code ? "Order " + code + " menunggu pembayaran." : "Order baru masuk.");
      refreshOrdersRelated();
    });
    socket.on("order:updated", refreshOrdersRelated);
    socket.on("payment:updated", (payload) => {
      if (payload && payload.paymentStatus === "SUCCESS") {
        const code = payload.orderCode || "sebuah order";
        showToast("Pembayaran berhasil untuk " + code + ".", "success");
        pushNotification("success", "Pembayaran berhasil", "Order " + code + " sudah terbayar.");
      }
      refreshOrdersRelated();
    });
    socket.on("stock:updated", () => {
      if (["products", "dashboard"].includes(state.currentPage)) refreshCurrentPageDebounced();
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
      pushNotification("info", "Review diperbarui", "Ada perubahan pada daftar review.");
      if (["reviews", "dashboard"].includes(state.currentPage)) refreshCurrentPageDebounced();
    });
    socket.on("statistics:updated", () => {
      if (state.currentPage === "dashboard") refreshCurrentPageDebounced();
    });
    ["integration:updated", "notification:updated"].forEach((ev) =>
      socket.on(ev, () => {
        if (state.currentPage === "integrations") refreshCurrentPageDebounced();
      })
    );
    // Hasil pengiriman tiap channel, dikirim notification.service.js begitu
    // provider menjawab — tabel riwayat ikut hidup tanpa perlu ditekan ulang.
    socket.on("notification:log", (payload) => {
      if (payload && payload.status === "failed") {
        pushNotification(
          "error",
          "Notifikasi gagal terkirim",
          (payload.channel === "whatsapp" ? "WhatsApp" : "Email") +
            " untuk " +
            (payload.orderCode || "order") +
            " gagal: " +
            (payload.error || "tidak ada keterangan dari provider.")
        );
      }
      if (state.currentPage === "integrations") {
        loadNotificationLogs().catch(() => {});
      }
    });
    socket.on("website:settings:updated", () => {
      // Branding sidebar selalu disinkronkan; formnya hanya kalau tab Marketplace terbuka.
      api("/settings/admin")
        .then((res) => {
          state.settings = res.data;
          applyBranding(state.settings);
          if (state.currentPage === "content") fillSettingsForm(state.settings);
        })
        .catch(() => {});
    });
  }

  /* ---------------------------------------------------------- event wiring */
  function wireEvents() {
    // Delegasi global: navigasi, modal, aksi baris.
    document.addEventListener("click", (e) => {
      const nav = e.target.closest("[data-page]");
      if (nav) {
        showPage(nav.dataset.page);
        return;
      }

      const retryNotif = e.target.closest("[data-retry-notif]");
      if (retryNotif) {
        retryNotification(retryNotif.dataset.retryNotif, retryNotif);
        return;
      }

      const goPage = e.target.closest("[data-go-page]");
      if (goPage) {
        $("globalSearch").value = "";
        closeAllPops();
        showPage(goPage.dataset.goPage);
        return;
      }

      const goProduct = e.target.closest("[data-go-product]");
      if (goProduct) {
        const id = goProduct.dataset.goProduct;
        $("globalSearch").value = "";
        closeAllPops();
        showPage("products");
        setTimeout(() => openProductModal(id), 260);
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
      if (orderDetail) {
        closeAllPops();
        return openOrderDetail(orderDetail.dataset.orderDetail);
      }

      const ratingStatus = e.target.closest("[data-rating-status]");
      if (ratingStatus) return setRatingStatus(ratingStatus.dataset.id, ratingStatus.dataset.ratingStatus);
      const delRating = e.target.closest("[data-delete-rating]");
      if (delRating) return deleteRating(delRating.dataset.deleteRating);

      const toggleAdmin = e.target.closest("[data-toggle-admin]");
      if (toggleAdmin) return toggleAdminActive(toggleAdmin.dataset.toggleAdmin, toggleAdmin.dataset.active === "true");

      const saveSectionBtn = e.target.closest("[data-save-section]");
      if (saveSectionBtn) return saveSection(saveSectionBtn.dataset.saveSection, saveSectionBtn);

      // Baris berulang: naik / turun / hapus.
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

    // Modal: klik backdrop dan tombol Escape.
    qsa(".modal-root").forEach((root) =>
      root.addEventListener("mousedown", (e) => {
        if (e.target === root) closeModal(root.id);
      })
    );
    document.addEventListener("keydown", (e) => {
      if (e.key !== "Escape") return;
      if (openModals.length) {
        closeModal(openModals[openModals.length - 1]);
        return;
      }
      closeAllPops();
    });

    $("confirmOk").addEventListener("click", () => {
      const resolve = confirmResolve;
      confirmResolve = null;
      closeModal("confirmModal");
      if (resolve) resolve(true);
    });

    // Sidebar: mode ringkas di desktop, laci geser di layar sempit.
    $("railToggle").addEventListener("click", () => {
      const shell = $("appShell");
      if (window.innerWidth <= 1240) {
        shell.dataset.drawer = shell.dataset.drawer === "true" ? "false" : "true";
      } else {
        shell.dataset.rail = shell.dataset.rail === "true" ? "false" : "true";
        try {
          localStorage.setItem("mp_admin_rail", shell.dataset.rail);
        } catch (err) {
          /* penyimpanan lokal tidak tersedia — abaikan */
        }
      }
    });
    $("drawerScrim").addEventListener("click", () => {
      $("appShell").dataset.drawer = "false";
    });

    // Tab internal pada halaman Marketplace, Integrasi, dan Pengaturan.
    qsa(".split-tab").forEach((tab) =>
      tab.addEventListener("click", () => {
        const wrap = tab.closest(".split-layout");
        qsa(".split-tab", wrap).forEach((x) => x.classList.remove("active"));
        tab.classList.add("active");
        qsa(".pane", wrap).forEach((p) => p.classList.toggle("active", p.id === "tab-" + tab.dataset.tab));
        if (tab.dataset.tab === "server") loadHealth();
      })
    );

    // Dropdown topbar. Klik di luar menutup semua dropdown, tapi klik DI DALAM
    // dropdown tetap dibiarkan naik ke delegasi utama supaya item menu berfungsi.
    function bindPop(btnId, popId) {
      const btn = $(btnId);
      const pop = $(popId);
      btn.addEventListener("click", () => {
        const wasOpen = pop.classList.contains("open");
        closeAllPops();
        if (!wasOpen) {
          pop.classList.add("open");
          if (popId === "notifPop") {
            state.unread = 0;
            renderNotifications();
          }
        }
      });
    }
    bindPop("notifBtn", "notifPop");
    bindPop("profileBtn", "profilePop");
    $("notifClear").addEventListener("click", () => {
      state.notifications = [];
      state.unread = 0;
      renderNotifications();
    });
    document.addEventListener("click", (e) => {
      if (e.target.closest(".pop, #notifBtn, #profileBtn, .quick-search")) return;
      closeAllPops();
    });

    // Pencarian cepat.
    const globalSearch = $("globalSearch");
    globalSearch.addEventListener("input", debounce(runGlobalSearch, 180));
    globalSearch.addEventListener("focus", runGlobalSearch);
    document.addEventListener("keydown", (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        globalSearch.focus();
        globalSearch.select();
      }
    });

    const logoutHandler = async () => {
      const ok = await confirmAction({
        title: "Keluar dari Admin Console",
        text: "Sesi akan diakhiri dan kamu perlu masuk lagi untuk membuka halaman ini.",
        confirmLabel: "Keluar",
      });
      if (ok) logout();
    };
    $("logoutBtn").addEventListener("click", logoutHandler);
    $("logoutBtn2").addEventListener("click", logoutHandler);

    // Dashboard
    $("dashRefresh").addEventListener("click", () =>
      withBusy($("dashRefresh"), "Memuat…", () => loadDashboard().catch((err) => showToast(err.message, "error")))
    );

    // Pesanan
    $("orderSearch").addEventListener("input", debounce(renderOrders, 200));
    const reloadOrders = () => {
      state.ordersPagination.page = 1;
      loadOrders().catch((err) => showToast(err.message, "error"));
    };
    $("orderStatusFilter").addEventListener("change", reloadOrders);
    $("paymentStatusFilter").addEventListener("change", reloadOrders);

    // Pembayaran
    $("txSearch").addEventListener("input", debounce(renderTransactions, 200));
    $("txSeg").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-tx-status]");
      if (!btn) return;
      qsa("button", $("txSeg")).forEach((b) => b.classList.toggle("active", b === btn));
      state.txStatus = btn.dataset.txStatus;
      state.txPagination.page = 1;
      loadTransactions().catch((err) => showToast(err.message, "error"));
    });

    // Produk
    $("productSearch").addEventListener("input", debounce(renderProducts, 200));
    $("categoryFilter").addEventListener("change", renderProducts);
    $("productStatusFilter").addEventListener("change", renderProducts);
    $("productView").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-view]");
      if (!btn) return;
      qsa("button", $("productView")).forEach((b) => b.classList.toggle("active", b === btn));
      state.productView = btn.dataset.view;
      renderProducts();
    });
    $("productForm").addEventListener("submit", submitProduct);

    // Dropzone gambar produk
    const imageDrop = $("imageDrop");
    $("imageInput").addEventListener("change", (e) => setProductImageFile(e.target.files && e.target.files[0]));
    ["dragenter", "dragover"].forEach((evt) =>
      imageDrop.addEventListener(evt, (e) => {
        e.preventDefault();
        e.stopPropagation();
        imageDrop.classList.add("drag-over");
      })
    );
    ["dragleave", "dragend"].forEach((evt) =>
      imageDrop.addEventListener(evt, (e) => {
        e.preventDefault();
        imageDrop.classList.remove("drag-over");
      })
    );
    imageDrop.addEventListener("drop", (e) => {
      e.preventDefault();
      e.stopPropagation();
      imageDrop.classList.remove("drag-over");
      setProductImageFile(e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0]);
    });
    qsa("[data-replace-image]").forEach((btn) =>
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        $("imageInput").click();
      })
    );
    qsa("[data-remove-image]").forEach((btn) =>
      btn.addEventListener("click", (e) => {
        e.preventDefault();
        e.stopPropagation();
        pendingImageFile = null;
        removeExistingImage = true;
        $("imageInput").value = "";
        $("imagePreview").src = "";
        imageDrop.classList.remove("has-image");
        setDropState("idle");
      })
    );
    // Kalau URL gambar (misalnya dari R2) tidak bisa dimuat, tampilkan pesan
    // yang jelas alih-alih kotak kosong tanpa keterangan.
    $("imagePreview").addEventListener("error", () => {
      if (!$("imagePreview").getAttribute("src")) return;
      $("uploadErrorMsg").textContent = "URL gambar tidak bisa dimuat. Coba unggah ulang.";
      setDropState("error");
    });

    // Kategori & FAQ
    $("categorySearch").addEventListener("input", debounce(renderCategories, 200));
    $("categoryForm").addEventListener("submit", submitCategory);
    $("cIcon").addEventListener("input", updateCategoryPreview);
    $("cName").addEventListener("input", updateCategoryPreview);
    $("faqForm").addEventListener("submit", submitFaq);

    // Customer
    $("customerSearch").addEventListener(
      "input",
      debounce(() => {
        state.customersPagination.page = 1;
        loadCustomers().catch((err) => showToast(err.message, "error"));
      }, 350)
    );

    // Rating
    $("ratingSeg").addEventListener("click", (e) => {
      const btn = e.target.closest("[data-rating-filter]");
      if (!btn) return;
      qsa("button", $("ratingSeg")).forEach((b) => b.classList.toggle("active", b === btn));
      state.ratingFilter = btn.dataset.ratingFilter;
      $("ratingStatusFilter").value = state.ratingFilter;
      loadRatings().catch((err) => showToast(err.message, "error"));
    });

    // Baris berulang: tombol tambah
    $("addNavbarItem").addEventListener("click", () =>
      appendRow("navbarItems", renderNavbarItems, { label: "", route: "", icon: "", enabled: true })
    );
    $("addHighlight").addEventListener("click", () =>
      appendRow("highlightItems", renderHighlights, { icon: "", title: "", description: "", enabled: true })
    );
    $("addFooterLink").addEventListener("click", () => appendRow("footerLinks", renderFooterLinks, { label: "", url: "" }));
    $("addFooterSocial").addEventListener("click", () =>
      appendRow("footerSocial", renderFooterSocial, { platform: "", url: "" })
    );
    $("addHeroSlide").addEventListener("click", () =>
      appendRow("heroSlides", renderHeroSlides, {
        image: "",
        alt: "",
        enabled: true,
        topLeft: "",
        topRight: "",
        bottomLeft: "",
        bottomRight: "",
      })
    );

    // Unggah aset Marketplace
    qsa("[data-upload-target]").forEach((input) => input.addEventListener("change", () => uploadAsset(input)));

    // Slide hero dirender ulang setiap kali daftarnya berubah, jadi input
    // filenya didengarkan lewat delegasi — bukan diikat satu per satu, supaya
    // baris baru ikut bekerja tanpa menumpuk listener pada baris lama.
    $("heroSlides").addEventListener("change", (e) => {
      const input = e.target.closest("[data-row-upload]");
      if (input) uploadSlideImage(input);
    });

    // Mengetik URL gambar secara manual juga memperbarui thumbnail barisnya.
    $("heroSlides").addEventListener("input", (e) => {
      const field = e.target.closest('[data-key="image"]');
      if (!field) return;
      const thumb = field.closest(".repeat-row").querySelector(".row-thumb");
      if (thumb) thumb.src = field.value;
    });

    // Integrasi
    $("intRefresh").addEventListener("click", () =>
      withBusy($("intRefresh"), "Memuat…", () => loadIntegrations().catch((err) => showToast(err.message, "error")))
    );

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
      saveIntegration("fonnte", $("fnSave"), {
        enabled: $("fnEnabled").checked,
        token: $("fnToken").value.trim() || undefined,
      })
    );
    $("fnTest").addEventListener("click", () => {
      const target = $("fnTestTarget").value.trim();
      if (!target) return showToast("Isi dulu nomor WhatsApp tujuan pengujian.", "error");
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
      if (!to) return showToast("Isi dulu email tujuan pengujian.", "error");
      testIntegration("resend", $("rsTest"), { testTo: to });
    });

    $("r2Test").addEventListener("click", () => testIntegration("r2", $("r2Test")));

    $("notifLogsRefresh").addEventListener("click", () =>
      withBusy($("notifLogsRefresh"), "Memuat…", async () => {
        state.notifLogsPagination.page = 1;
        await loadNotificationLogs().catch((err) => showToast(err.message, "error"));
      })
    );

    const applyNotifFilters = () => {
      state.notifLogFilters = {
        orderCode: $("notifLogOrder").value.trim(),
        event: $("notifLogEvent").value,
        channel: $("notifLogChannel").value,
        status: $("notifLogStatus").value,
      };
      // Filter apa pun mengembalikan ke halaman 1 — kalau tidak, hasil yang
      // menyusut bisa mendarat di halaman yang sudah tidak ada isinya.
      state.notifLogsPagination.page = 1;
      loadNotificationLogs().catch((err) => showToast(err.message, "error"));
    };
    $("notifLogOrder").addEventListener("input", debounce(applyNotifFilters, 350));
    ["notifLogEvent", "notifLogChannel", "notifLogStatus"].forEach((id) =>
      $(id).addEventListener("change", applyNotifFilters)
    );

    $("notifSave").addEventListener("click", () =>
      withBusy($("notifSave"), "Menyimpan…", async () => {
        const events = {};
        qsa("[data-notif-event]").forEach((el) => {
          events[el.dataset.notifEvent] = el.checked;
        });
        try {
          await api("/integrations/notifications", {
            method: "PUT",
            body: { whatsappEnabled: $("notifWa").checked, emailEnabled: $("notifEmail").checked, events },
          });
          showToast("Pengaturan notifikasi tersimpan.", "success");
        } catch (err) {
          showToast(err.message, "error");
        }
      })
    );

    $("templatesSave").addEventListener("click", () =>
      withBusy($("templatesSave"), "Menyimpan…", async () => {
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
          showToast("Template notifikasi tersimpan.", "success");
        } catch (err) {
          showToast(err.message, "error");
        }
      })
    );

    // Akun
    $("savePassword").addEventListener("click", () =>
      withBusy($("savePassword"), "Menyimpan…", async () => {
        const currentPassword = $("oldPassword").value;
        const newPassword = $("newPassword").value;
        if (!currentPassword || newPassword.length < 8) {
          return showToast("Isi password saat ini dan pakai password baru minimal 8 karakter.", "error");
        }
        try {
          await api("/auth/change-password", { method: "POST", body: { currentPassword, newPassword } });
          $("oldPassword").value = "";
          $("newPassword").value = "";
          showToast("Password berhasil diganti.", "success");
        } catch (err) {
          showToast(err.message, "error");
        }
      })
    );

    $("createAdmin").addEventListener("click", () =>
      withBusy($("createAdmin"), "Menyimpan…", async () => {
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
          showToast("Akun admin baru dibuat.", "success");
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
    if (container.lastElementChild) container.lastElementChild.scrollIntoView({ block: "nearest" });
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
      // api() sudah mengalihkan ke login untuk 401; sisanya tampilkan pesannya.
      $("bootText").textContent = "Sesi admin tidak bisa dimuat: " + err.message;
      return;
    }

    $("bootScreen").hidden = true;
    $("appShell").hidden = false;

    $("adminName").textContent = state.admin.name;
    $("adminRole").textContent = state.admin.role === "superadmin" ? "Superadmin" : "Admin";
    $("adminInitials").textContent = initials(state.admin.name);
    $("menuAdminName").textContent = state.admin.name;
    $("menuAdminEmail").textContent = state.admin.email;

    const hour = new Date().getHours();
    const salam = hour < 11 ? "Selamat pagi" : hour < 15 ? "Selamat siang" : hour < 19 ? "Selamat sore" : "Selamat malam";
    $("greeting").textContent = salam + ", " + state.admin.name.split(/\s+/)[0] + ".";
    $("greetingSub").textContent =
      "Ringkasan " +
      new Date().toLocaleDateString("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric" }) +
      ". Semua angka dihitung langsung dari database.";

    try {
      const saved = localStorage.getItem("mp_admin_rail");
      if (saved === "true" && window.innerWidth > 1240) $("appShell").dataset.rail = "true";
    } catch (err) {
      /* penyimpanan lokal tidak tersedia — abaikan */
    }

    wireEvents();
    renderNotifications();
    initRealtime();

    // Branding sidebar selalu mengikuti WebsiteSettings yang asli.
    try {
      const settings = await api("/settings/admin");
      state.settings = settings.data;
      applyBranding(state.settings);
    } catch (e) {
      /* tidak fatal */
    }

    // Kategori dipakai lintas halaman (filter produk + form produk).
    try {
      const categories = await api("/categories/admin/all");
      state.categories = categories.data;
      syncCategoryOptions();
    } catch (e) {
      /* tidak fatal */
    }

    const initial = window.location.hash.replace("#", "");
    showPage(PAGES[initial] ? initial : "dashboard");
  }

  document.addEventListener("DOMContentLoaded", init);
})();
