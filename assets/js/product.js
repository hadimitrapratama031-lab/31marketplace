/* 31 Store — Product detail + checkout. Talks to /api/products, /api/orders,
   and /api/payments; price/stock always come from the backend (never trusted
   from this page). No fake loading delays — every spinner waits on a real request. */
(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const params = new URLSearchParams(location.search);
  const slug = params.get("slug");

  let product = null;
  let qty = 1;
  let pollTimer = null;
  let paymentSocketHandler = null; // dilepas lagi saat modal ditutup agar listener tidak menumpuk

  // ---------------------------------------------------------------------
  // Load product
  // ---------------------------------------------------------------------
  async function loadProduct() {
    if (!slug) {
      renderNotFound("Produk tidak ditemukan. Kembali ke halaman utama untuk memilih produk.");
      return;
    }
    try {
      const res = await MP.get(`/products/${encodeURIComponent(slug)}`);
      product = res.data;
      renderProduct();
      loadRelated();
    } catch (err) {
      renderNotFound(err.message || "Produk tidak ditemukan.");
    }
  }

  function renderNotFound(message) {
    const main = document.querySelector(".product-detail-page");
    if (main) {
      main.innerHTML = `<div style="max-width:600px;margin:80px auto;text-align:center">
        <h2 style="margin-bottom:12px">Produk tidak tersedia</h2>
        <p style="color:#7d7485;margin-bottom:20px">${MP.escapeHTML(message)}</p>
        <a class="primary-button" href="index.html#product">Kembali ke Marketplace</a>
      </div>`;
    }
  }

  function renderProduct() {
    const outOfStock = Number(product.stock) <= 0;
    qty = 1;

    $("product-name").textContent = product.name;
    $("crumb-name").textContent = product.name;
    $("product-desc").textContent = product.description || "";
    $("product-price").textContent = MP.formatIDR(product.price);
    $("sold").textContent = `${Number(product.sold) || 0} terjual`;
    $("summary-name").textContent = product.name;

    const catName = (product.categoryId && product.categoryId.name) || "Produk";
    $("product-category-badge").textContent = catName.toUpperCase();
    $("preview-title").innerHTML = `${MP.escapeHTML(catName.toUpperCase())}<br><strong>DIGITAL</strong>`;

    const statusBadge = $("product-status-badge");
    statusBadge.textContent = outOfStock ? "● STOK HABIS" : "● TERSEDIA";
    statusBadge.className = "badge " + (outOfStock ? "purple" : "green");

    if (product.image) {
      const preview = $("main-preview");
      if (preview) preview.style.cssText += `background-image:url('${product.image}');background-size:cover;background-position:center`;
    }

    const buyBtn = $("buy-now");
    const sideBtn = $("side-buy");
    [buyBtn, sideBtn].forEach((btn) => {
      if (!btn) return;
      btn.disabled = outOfStock;
      btn.style.opacity = outOfStock ? ".5" : "";
      btn.style.cursor = outOfStock ? "not-allowed" : "";
      btn.textContent = outOfStock ? "Stok Habis" : btn.id === "buy-now" ? "Beli Sekarang →" : "Lanjutkan Pembelian →";
    });

    document.title = `${product.name} — 31 Store`;
    updateQty();
  }

  async function loadRelated() {
    try {
      const res = await MP.get("/products");
      const all = (res.data || []).filter((p) => p._id !== product._id);
      const sameCategory = all.filter((p) => String(p.categoryId?._id || p.categoryId) === String(product.categoryId?._id || product.categoryId));
      const rest = all.filter((p) => !sameCategory.includes(p));
      const related = [...sameCategory, ...rest].slice(0, 4);
      const grid = $("related-grid");
      if (!grid) return;
      grid.innerHTML = related.length
        ? related
            .map(
              (p) => `<a class="related-card" href="product.html?slug=${encodeURIComponent(p.slug)}">
          <div class="related-image">${p.image ? `<img src="${MP.escapeHTML(p.image)}" alt="${MP.escapeHTML(p.name)}" style="width:100%;height:100%;object-fit:cover">` : ""}</div>
          <div class="related-body"><h4>${MP.escapeHTML(p.name)}</h4><p>${MP.escapeHTML(p.description || "")}</p><span class="related-price">${MP.formatIDR(p.price)}</span></div>
        </a>`
            )
            .join("")
        : `<p style="color:#8a8093;font-size:13px">Belum ada produk lain.</p>`;
    } catch (err) {
      console.error("Gagal memuat produk terkait:", err);
    }
  }

  // ---------------------------------------------------------------------
  // Quantity + tabs + gallery thumbs (pure UI)
  // ---------------------------------------------------------------------
  function updateQty() {
    $("qty").textContent = qty;
    $("summary-qty").textContent = qty;
    const total = product ? product.price * qty : 0;
    $("summary-total").textContent = MP.formatIDR(total);
  }

  $("plus").onclick = () => {
    if (!product) return;
    if (qty < Math.min(99, product.stock)) qty++;
    updateQty();
  };
  $("minus").onclick = () => {
    if (qty > 1) qty--;
    updateQty();
  };

  document.querySelectorAll(".tab").forEach((t) =>
    t.addEventListener("click", () => {
      document.querySelectorAll(".tab,.tab-content").forEach((x) => x.classList.remove("active"));
      t.classList.add("active");
      $(t.dataset.tab).classList.add("active");
    })
  );
  document.querySelectorAll(".thumb").forEach((t) => t.addEventListener("click", () => document.querySelectorAll(".thumb").forEach((x) => x.classList.toggle("active", x === t))));

  // ---------------------------------------------------------------------
  // Checkout modal (built at runtime, styled to match the site's purple theme)
  // ---------------------------------------------------------------------
  function ensureModalRoot() {
    let root = $("checkout-modal-root");
    if (root) return root;
    root = document.createElement("div");
    root.id = "checkout-modal-root";
    document.body.appendChild(root);
    return root;
  }

  function closeModal() {
    const root = $("checkout-modal-root");
    if (root) root.innerHTML = "";
    stopPaymentWatch();
  }

  function stopPaymentWatch() {
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    if (paymentSocketHandler) {
      const socket = MP.getSocket();
      if (socket) {
        socket.off("payment:updated", paymentSocketHandler);
        socket.off("order:updated", paymentSocketHandler);
      }
      paymentSocketHandler = null;
    }
  }

  function modalShell(innerHTML) {
    const root = ensureModalRoot();
    root.innerHTML = `
      <div id="checkout-overlay" style="position:fixed;inset:0;background:rgba(33,27,49,.55);backdrop-filter:blur(3px);z-index:998;display:grid;place-items:center;padding:18px">
        <div style="width:min(420px,100%);max-height:90vh;overflow:auto;background:#fff;border-radius:20px;padding:26px;box-shadow:0 24px 60px rgba(50,30,90,.28);position:relative">
          ${innerHTML}
        </div>
      </div>`;
    $("checkout-overlay").addEventListener("click", (e) => {
      if (e.target.id === "checkout-overlay") closeModal();
    });
  }

  function openCheckoutForm() {
    if (!product || Number(product.stock) <= 0) return;
    modalShell(`
      <button id="checkout-close" style="position:absolute;top:16px;right:16px;border:0;background:none;font-size:18px;cursor:pointer;color:#8a8093">✕</button>
      <span style="font-size:11px;font-weight:800;letter-spacing:.08em;color:#7650bd">CHECKOUT</span>
      <h3 style="margin:6px 0 4px;font-size:20px">${MP.escapeHTML(product.name)}</h3>
      <p style="color:#7d7485;font-size:13px;margin-bottom:18px">Jumlah: ${qty} • Total <strong>${MP.formatIDR(product.price * qty)}</strong></p>
      <form id="checkout-form">
        <label style="display:block;font-size:12px;font-weight:700;margin-bottom:6px">Nama</label>
        <input id="ck-name" placeholder="Nama kamu" style="width:100%;padding:13px;border:1px solid #e4ddec;border-radius:11px;outline:none;font:13px Inter;margin-bottom:12px">
        <label style="display:block;font-size:12px;font-weight:700;margin-bottom:6px">Email *</label>
        <input id="ck-email" type="email" required placeholder="nama@email.com" style="width:100%;padding:13px;border:1px solid #e4ddec;border-radius:11px;outline:none;font:13px Inter;margin-bottom:12px">
        <label style="display:block;font-size:12px;font-weight:700;margin-bottom:6px">Nomor WhatsApp *</label>
        <input id="ck-whatsapp" required placeholder="08xxxxxxxxxx" style="width:100%;padding:13px;border:1px solid #e4ddec;border-radius:11px;outline:none;font:13px Inter;margin-bottom:6px">
        <p id="checkout-error" style="color:#c0392b;font-size:12px;min-height:16px;margin-bottom:10px"></p>
        <button class="primary-button" id="checkout-submit" type="submit" style="width:100%;border:0;cursor:pointer;justify-content:center">Buat Pesanan & Bayar →</button>
      </form>
    `);
    $("checkout-close").onclick = closeModal;
    $("checkout-form").addEventListener("submit", handleCheckoutSubmit);
  }

  async function handleCheckoutSubmit(e) {
    e.preventDefault();
    const submitBtn = $("checkout-submit");
    const errorEl = $("checkout-error");
    errorEl.textContent = "";
    submitBtn.disabled = true;
    submitBtn.textContent = "Memproses...";

    try {
      const body = {
        productId: product._id,
        quantity: qty,
        name: $("ck-name").value.trim(),
        email: $("ck-email").value.trim(),
        whatsapp: $("ck-whatsapp").value.trim(),
      };
      const res = await MP.post("/orders", body);
      renderPaymentModal(res.data.order, res.data.payment);
    } catch (err) {
      errorEl.textContent = err.message || "Gagal membuat pesanan.";
      submitBtn.disabled = false;
      submitBtn.textContent = "Buat Pesanan & Bayar →";
    }
  }

  function renderPaymentModal(order, payment) {
    modalShell(`
      <button id="checkout-close" style="position:absolute;top:16px;right:16px;border:0;background:none;font-size:18px;cursor:pointer;color:#8a8093">✕</button>
      <span style="font-size:11px;font-weight:800;letter-spacing:.08em;color:#7650bd">PEMBAYARAN QRIS</span>
      <h3 style="margin:6px 0 4px;font-size:18px">Order ${MP.escapeHTML(order.orderCode)}</h3>
      <p style="color:#7d7485;font-size:13px;margin-bottom:14px">Total <strong>${MP.formatIDR(payment.totalAmount || payment.amount)}</strong></p>
      ${payment.qrisUrl ? `<img src="${MP.escapeHTML(payment.qrisUrl)}" alt="QRIS" style="width:100%;border-radius:14px;border:1px solid #e4ddec;margin-bottom:14px">` : ""}
      ${payment.directUrl ? `<a href="${MP.escapeHTML(payment.directUrl)}" target="_blank" rel="noopener" class="primary-button" style="width:100%;justify-content:center;text-decoration:none;margin-bottom:10px">Buka Halaman Pembayaran ↗</a>` : ""}
      <div id="payment-status" style="text-align:center;padding:12px;border-radius:11px;background:#f5effd;border:1px solid #e2d5f4;font-size:12px;font-weight:700;color:#b8860b;margin-bottom:10px">Menunggu Pembayaran…</div>
      <p style="font-size:11px;color:#8a8093;text-align:center">Simpan kode order ini. Status akan diperbarui otomatis begitu pembayaran terverifikasi. Kamu juga bisa cek statusnya kapan saja lewat halaman <a href="cek-pesanan/?order=${encodeURIComponent(order.orderCode)}" style="color:#7650bd">Cek Pesanan</a>.</p>
    `);
    $("checkout-close").onclick = closeModal;
    startPaymentWatch(order.orderCode);
  }

  function startPaymentWatch(orderCode) {
    stopPaymentWatch(); // pastikan watcher order sebelumnya benar-benar dilepas

    const check = async () => {
      try {
        const res = await MP.get(`/payments/${encodeURIComponent(orderCode)}/refresh`);
        applyStatus(res.data.status);
      } catch (err) {
        console.error("Gagal memeriksa status pembayaran:", err);
      }
    };

    pollTimer = setInterval(check, 10000);
    check();

    const socket = MP.getSocket();
    if (socket) {
      paymentSocketHandler = (payload) => {
        if (payload && payload.orderCode === orderCode) applyStatus(payload.paymentStatus || payload.status);
      };
      socket.on("payment:updated", paymentSocketHandler);
      socket.on("order:updated", paymentSocketHandler);
    }
  }

  function applyStatus(status) {
    const el = $("payment-status");
    if (!el) return;
    const label = MP.STATUS_LABEL[status] || status;
    const color = MP.STATUS_COLOR[status] || "#b8860b";
    el.textContent = label;
    el.style.color = color;
    if (status === "PAID" || status === "SUCCESS") {
      el.style.background = "#e9f9ef";
      el.style.borderColor = "#bfe8cf";
      stopPaymentWatch();
      loadProduct(); // stock/sold changed
    } else if (["FAILED", "EXPIRED", "CANCELLED"].includes(status)) {
      el.style.background = "#fdecea";
      el.style.borderColor = "#f3c6c1";
      stopPaymentWatch();
    }
  }

  $("buy-now").addEventListener("click", openCheckoutForm);
  $("side-buy").addEventListener("click", openCheckoutForm);

  loadProduct();
})();
