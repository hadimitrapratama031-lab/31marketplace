(function () {
  const $ = (id) => document.getElementById(id);
  let currentOrderCode = null;
  let socketBound = false;

  function statusPill(status, label) {
    const color = MP.STATUS_COLOR[status] || "#8a8093";
    return `<span style="display:inline-block;padding:5px 12px;border-radius:999px;font-size:11px;font-weight:800;color:#fff;background:${color}">${MP.escapeHTML(label || status)}</span>`;
  }

  function render(order) {
    const paidLabel = MP.STATUS_LABEL[order.paymentStatus] || order.paymentStatus;
    const statusLabel = MP.STATUS_LABEL[order.status] || order.status;

    let paymentBlock = "";
    if (order.payment && order.paymentStatus === "PENDING") {
      paymentBlock = `
        <div style="margin-top:18px;padding:18px;border-radius:14px;background:#f5effd;border:1px solid #e2d5f4">
          <strong style="font-size:12px">Selesaikan Pembayaran</strong>
          ${order.payment.qrisUrl ? `<img src="${MP.escapeHTML(order.payment.qrisUrl)}" alt="QRIS" style="width:100%;max-width:260px;display:block;margin:12px auto;border-radius:12px">` : ""}
          ${order.payment.directUrl ? `<a href="${MP.escapeHTML(order.payment.directUrl)}" target="_blank" rel="noopener" class="primary-button" style="width:100%;justify-content:center;text-decoration:none;margin-top:6px">Buka Halaman Pembayaran ↗</a>` : ""}
          ${order.payment.expiredAt ? `<p style="font-size:11px;color:#8a8093;margin-top:10px">Kedaluwarsa: ${MP.formatDate(order.payment.expiredAt)}</p>` : ""}
        </div>`;
    }

    $("result").innerHTML = `
      <div style="padding:22px;border-radius:16px;background:#fff;border:1px solid #e8e1f0;box-shadow:0 8px 24px rgba(74,50,110,.05)">
        <div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
          <strong style="font-size:16px">${MP.escapeHTML(order.orderCode)}</strong>
          ${statusPill(order.paymentStatus, paidLabel)}
        </div>
        <div style="margin-top:16px;font-size:13px;line-height:2;color:#4c465a">
          <div style="display:flex;justify-content:space-between"><span>Produk</span><strong>${MP.escapeHTML(order.product.name)}</strong></div>
          <div style="display:flex;justify-content:space-between"><span>Jumlah</span><strong>${order.quantity}</strong></div>
          <div style="display:flex;justify-content:space-between"><span>Total</span><strong>${MP.formatIDR(order.total)}</strong></div>
          <div style="display:flex;justify-content:space-between"><span>Status Order</span><strong>${MP.escapeHTML(statusLabel)}</strong></div>
          <div style="display:flex;justify-content:space-between"><span>Tanggal</span><strong>${MP.formatDate(order.createdAt)}</strong></div>
        </div>
        ${paymentBlock}
      </div>`;
  }

  async function lookup(orderCode) {
    const errorEl = $("form-error");
    const btn = $("submit-btn");
    errorEl.textContent = "";
    btn.disabled = true;
    btn.textContent = "Mencari...";
    try {
      const res = await MP.get(`/orders/track/${encodeURIComponent(orderCode)}`);
      currentOrderCode = orderCode;
      render(res.data);
      bindSocket();
    } catch (err) {
      $("result").innerHTML = "";
      errorEl.textContent = err.message || "Order tidak ditemukan.";
    } finally {
      btn.disabled = false;
      btn.textContent = "Cek Pesanan";
    }
  }

  function bindSocket() {
    if (socketBound) return;
    const socket = MP.getSocket();
    if (!socket) return;
    socketBound = true;
    const handler = (payload) => {
      if (payload && payload.orderCode === currentOrderCode) lookup(currentOrderCode);
    };
    socket.on("order:updated", handler);
    socket.on("payment:updated", handler);
  }

  $("form").addEventListener("submit", (e) => {
    e.preventDefault();
    const code = $("order-code").value.trim().toUpperCase();
    if (code) lookup(code);
  });

  // Deep-link support: cek-pesanan/?order=ORD-XXXX
  const preset = new URLSearchParams(location.search).get("order");
  if (preset) {
    $("order-code").value = preset.toUpperCase();
    lookup(preset.toUpperCase());
  }
})();
