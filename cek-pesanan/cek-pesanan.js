/* ============================================================================
   31 Store — Cek Pesanan.

   Pencarian sekarang memakai EMAIL, bukan kode order. MongoDB adalah satu-
   satunya sumber kebenaran: halaman ini tidak membaca LocalStorage sama sekali
   untuk menentukan pesanan siapa yang boleh tampil — email yang diketik
   dikirim ke backend, dan backend yang mencocokkannya.

   Realtime memakai Socket.IO yang sudah ada lewat MP.on(): tidak ada koneksi
   atau sistem realtime kedua. Saat order:updated / payment:updated datang,
   tampilan yang sedang terbuka dibaca ulang dari backend supaya statusnya
   selalu berasal dari database, bukan dari tebakan di sisi klien.
   ========================================================================= */
(function () {
  "use strict";

  var $ = function (id) {
    return document.getElementById(id);
  };

  // Email yang sedang ditampilkan, dan (kalau sedang membuka detail) kode
  // ordernya. Keduanya hanya ada di memori halaman ini.
  var currentEmail = null;
  var currentOrderCode = null;

  var DONE = ["PAID", "SUCCESS", "COMPLETED"];
  var BAD = ["FAILED", "EXPIRED", "CANCELLED"];

  function normalizeEmail(value) {
    return String(value || "").trim().toLowerCase();
  }

  function pill(status) {
    var tone = MP.STATUS_TONE[status] || "idle";
    var label = MP.STATUS_LABEL[status] || status;
    return '<span class="pill pill-' + tone + '">' + MP.escapeHTML(label) + "</span>";
  }

  function thumb(product) {
    if (product && product.image) {
      return (
        '<span class="order-row-media"><img src="' +
        MP.escapeHTML(product.image) +
        '" alt="" loading="lazy" decoding="async"></span>'
      );
    }
    return '<span class="order-row-media"><span class="ph">' + MP.escapeHTML(MP.initials(product && product.name)) + "</span></span>";
  }

  function setNote(message, isError) {
    var note = $("track-note");
    note.className = isError ? "form-note is-error" : "form-note";
    note.textContent = message || "";
  }

  /* ------------------------------------------------------------- daftar */

  function renderList(payload) {
    var orders = payload.orders || [];

    if (!orders.length) {
      $("result").innerHTML =
        '<div class="panel order-card">' +
        "<h3>Belum ada pesanan untuk email ini</h3>" +
        '<p class="muted" style="margin-top:8px">Pastikan email yang kamu masukkan sama persis dengan yang dipakai saat checkout. ' +
        'Kalau kamu memakai email lain, coba email tersebut.</p>' +
        "</div>";
      return;
    }

    var rows = orders
      .map(function (order) {
        var meta = [order.orderCode, MP.formatDate(order.createdAt), order.paymentMethod].filter(Boolean).join(" · ");
        return (
          '<button class="order-row" type="button" data-order="' +
          MP.escapeHTML(order.orderCode) +
          '">' +
          thumb(order.product) +
          '<span><span class="order-row-name">' +
          MP.escapeHTML(order.product.name) +
          (order.quantity > 1 ? " ×" + MP.escapeHTML(String(order.quantity)) : "") +
          '</span><span class="order-row-meta">' +
          MP.escapeHTML(meta) +
          "</span></span>" +
          '<span class="order-row-end"><span class="order-row-total">' +
          MP.formatIDR(order.total) +
          "</span>" +
          pill(order.paymentStatus) +
          "</span>" +
          "</button>"
        );
      })
      .join("");

    $("result").innerHTML = '<div class="order-list">' + rows + "</div>";
  }

  /* ------------------------------------------------------------- detail */

  function stepState(order) {
    var paid = DONE.indexOf(order.paymentStatus) !== -1 || DONE.indexOf(order.status) !== -1;
    var stopped = BAD.indexOf(order.paymentStatus) !== -1 || BAD.indexOf(order.status) !== -1;
    var finished = order.status === "COMPLETED";

    return [
      { label: "Pesanan dibuat", note: "Kode order diterbitkan", state: "is-done" },
      {
        label: "Pembayaran",
        note: stopped ? "Tidak diselesaikan" : paid ? "Sudah dibayar" : "Menunggu pembayaran",
        state: stopped ? "" : paid ? "is-done" : "is-current",
      },
      {
        label: "Verifikasi",
        note: paid ? "Pembayaran terverifikasi" : "Menunggu pembayaran masuk",
        state: paid ? "is-done" : "",
      },
      {
        label: "Selesai",
        note: finished ? "Pesanan selesai" : "Diproses admin toko",
        state: finished ? "is-done" : paid ? "is-current" : "",
      },
    ];
  }

  function kv(label, value) {
    if (value === undefined || value === null || value === "") return "";
    return '<div class="kv"><span>' + MP.escapeHTML(label) + "</span><strong>" + MP.escapeHTML(String(value)) + "</strong></div>";
  }

  function renderDetail(order) {
    var steps = stepState(order)
      .map(function (s) {
        return '<div class="step ' + s.state + '"><i></i><b>' + s.label + "</b><span>" + s.note + "</span></div>";
      })
      .join("");

    var payment = "";
    if (order.paymentStatus === "PENDING" && (order.qrisUrl || order.payUrl)) {
      payment =
        '<div class="pay-box">' +
        "<h4>Selesaikan pembayaran</h4>" +
        (order.qrisUrl ? '<img class="qris" src="' + MP.escapeHTML(order.qrisUrl) + '" alt="Kode QRIS pembayaran">' : "") +
        (order.payUrl
          ? '<a class="btn btn-primary btn-block" href="' + MP.escapeHTML(order.payUrl) + '" target="_blank" rel="noopener">Buka halaman pembayaran</a>'
          : "") +
        (order.expiredAt ? '<p class="muted" style="font-size:12.5px;margin-top:12px">Berlaku sampai ' + MP.formatDate(order.expiredAt) + "</p>" : "") +
        "</div>";
    }

    var media = order.product && order.product.image
      ? '<img src="' + MP.escapeHTML(order.product.image) + '" alt="' + MP.escapeHTML(order.product.name) + '" style="width:100%;max-width:200px;border-radius:12px;display:block;margin-bottom:18px" loading="lazy" decoding="async">'
      : "";

    $("result").innerHTML =
      '<button class="btn btn-ghost btn-sm order-back" type="button" id="order-back">Kembali ke daftar pesanan</button>' +
      '<div class="panel order-card">' +
      '<div class="order-top"><span class="order-code">' +
      MP.escapeHTML(order.orderCode) +
      "</span>" +
      pill(order.paymentStatus) +
      "</div>" +
      '<div class="steps">' +
      steps +
      "</div>" +
      '<div style="padding-top:8px">' +
      media +
      kv("Produk", order.quantity > 1 ? order.product.name + " ×" + order.quantity : order.product.name) +
      kv("Order ID", order.orderCode) +
      kv("Email pemesan", order.customerEmail) +
      kv("Harga satuan", MP.formatIDR(order.price)) +
      kv("Total", MP.formatIDR(order.total)) +
      kv("Metode pembayaran", order.paymentMethod) +
      kv("Status", MP.STATUS_LABEL[order.status] || order.status) +
      kv("Dibuat", MP.formatDate(order.createdAt)) +
      (order.paidAt ? kv("Dibayar", MP.formatDate(order.paidAt)) : "") +
      (order.expiredAt ? kv("Kedaluwarsa", MP.formatDate(order.expiredAt)) : "") +
      "</div>" +
      payment +
      "</div>";
  }

  /* --------------------------------------------------------- pemanggilan */

  // `silent` dipakai oleh refresh realtime: kalau gagal, tampilan terakhir yang
  // masih benar dibiarkan berdiri daripada diganti pesan error yang mengagetkan.
  async function loadList(email, silent) {
    var btn = $("track-submit");
    if (!silent) {
      setNote("Mencari pesanan…");
      btn.disabled = true;
      btn.textContent = "Mencari…";
    }

    try {
      var res = await MP.post("/orders/lookup", { email: email });
      currentEmail = email;
      currentOrderCode = null;
      if (!silent) setNote("");
      renderList(res.data);
    } catch (err) {
      if (silent) return;
      currentEmail = null;
      currentOrderCode = null;
      $("result").innerHTML = "";
      setNote(err.message || "Pesanan tidak ditemukan untuk email tersebut.", true);
    } finally {
      if (!silent) {
        btn.disabled = false;
        btn.textContent = "Cek pesanan";
      }
    }
  }

  async function loadDetail(orderCode, silent) {
    if (!currentEmail) return;
    if (!silent) setNote("Membuka detail pesanan…");

    try {
      // Email ikut dikirim: backend hanya membalas kalau order itu memang milik
      // email tersebut, jadi kode order yang ditebak tidak membuka pesanan
      // orang lain.
      var res = await MP.post("/orders/detail", { email: currentEmail, orderCode: orderCode });
      currentOrderCode = orderCode;
      if (!silent) setNote("");
      renderDetail(res.data);
    } catch (err) {
      if (silent) return;
      setNote(err.message || "Detail pesanan tidak bisa dibuka.", true);
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    $("track-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var email = normalizeEmail($("order-email").value);
      if (!email) {
        setNote("Masukkan email yang kamu pakai saat checkout.", true);
        return;
      }
      loadList(email, false);
    });

    // Satu listener untuk seluruh area hasil: daftar boleh dirender ulang
    // berkali-kali tanpa pernah menumpuk handler.
    $("result").addEventListener("click", function (e) {
      var row = e.target.closest("[data-order]");
      if (row) return loadDetail(row.dataset.order, false);
      if (e.target.closest("#order-back") && currentEmail) return loadList(currentEmail, false);
    });

    // Realtime lewat Socket.IO existing. Yang dibaca ulang adalah tampilan yang
    // sedang terbuka — detail kalau sedang membuka detail, daftar kalau tidak.
    var refresh = MP.debounce(function (payload) {
      if (!currentEmail) return;
      if (currentOrderCode) {
        if (payload && payload.orderCode && payload.orderCode !== currentOrderCode) {
          // Order lain berubah: daftarnya tetap perlu ikut segar nanti, tapi
          // detail yang sedang dibaca tidak boleh tiba-tiba berganti isi.
          return;
        }
        return loadDetail(currentOrderCode, true);
      }
      loadList(currentEmail, true);
    }, 250);

    MP.on(["order:updated", "payment:updated"], refresh);
    MP.onReconnect(function () {
      if (!currentEmail) return;
      if (currentOrderCode) loadDetail(currentOrderCode, true);
      else loadList(currentEmail, true);
    });

    // Link dari halaman sukses / email boleh membawa emailnya, supaya pembeli
    // tidak perlu mengetik ulang. Kode order saja tidak lagi cukup untuk
    // membuka pesanan — kepemilikannya tetap harus dibuktikan lewat email.
    var params = new URLSearchParams(window.location.search);
    var presetEmail = normalizeEmail(params.get("email"));
    if (presetEmail) {
      $("order-email").value = presetEmail;
      loadList(presetEmail, false);
    }
  });
})();
