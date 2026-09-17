/* ============================================================================
   31 Store — Cek Pesanan.

   Satu kolom pencarian yang menerima ORDER ID maupun EMAIL. Ini memperbaiki
   akar masalah halaman ini: sebelumnya kolomnya bertipe email dan divalidasi
   sebagai email, sementara yang dipegang pembeli setelah checkout justru Order
   ID — sehingga menempelkannya di sini selalu berakhir "Format email tidak
   valid", dan endpoint publik yang bisa mencari lewat Order ID tidak pernah
   dipanggil dari halaman ini.

   MongoDB tetap satu-satunya sumber kebenaran: tidak ada LocalStorage, tidak
   ada data dummy. Semua status yang tampil berasal dari POST /api/orders/search.

   Realtime memakai Socket.IO yang sudah ada lewat MP.on(): tidak ada koneksi
   atau sistem realtime kedua. Saat order:updated / payment:updated datang,
   tampilan yang sedang terbuka dibaca ulang dari backend.
   ========================================================================= */
(function () {
  "use strict";

  var $ = function (id) {
    return document.getElementById(id);
  };

  // Pencarian terakhir yang berhasil, supaya refresh realtime bisa mengulanginya
  // persis. Hanya ada di memori halaman ini.
  var currentQuery = null; // { query, email }
  var currentMode = null; // "email" | "order"
  var currentEmail = null; // email pemilik, kalau memang sudah terbukti
  var currentOrderCode = null; // kode order yang sedang dibuka detailnya

  var DONE = ["PAID", "SUCCESS", "COMPLETED"];
  var BAD = ["FAILED", "EXPIRED", "CANCELLED"];

  function normalizeEmail(value) {
    return String(value || "").trim().toLowerCase();
  }

  function isPaid(order) {
    return DONE.indexOf(order.paymentStatus) !== -1 || DONE.indexOf(order.status) !== -1;
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

  /* --------------------------------------------------------- kontak admin */

  // Tombol WhatsApp & Discord memakai konfigurasi kontak yang SAMA dengan
  // homepage dan halaman Order Success (WebsiteSettings.contact lewat
  // MP.contactChannels) — nomor, URL, dan logonya berasal dari Admin Web,
  // tidak ada satu pun yang di-hardcode di sini. Kalau admin belum mengunggah
  // logo, badge teks dipakai sebagai fallback, bukan aset acak dari internet.
  function channelGlyph(iconUrl, fallbackText) {
    return iconUrl
      ? '<i><img src="' + MP.escapeHTML(iconUrl) + '" alt=""></i>'
      : "<i>" + fallbackText + "</i>";
  }

  function contactHTML() {
    var channels = MP.contactChannels(MP.getSettings());
    var buttons = "";

    if (channels.whatsapp.href) {
      buttons +=
        '<a class="order-contact-btn is-wa" href="' +
        MP.escapeHTML(channels.whatsapp.href) +
        '" target="_blank" rel="noopener">' +
        channelGlyph(channels.whatsapp.icon, "WA") +
        "Hubungi Admin</a>";
    }
    if (channels.discord.href) {
      buttons +=
        '<a class="order-contact-btn is-discord" href="' +
        MP.escapeHTML(channels.discord.href) +
        '" target="_blank" rel="noopener">' +
        channelGlyph(channels.discord.icon, "DC") +
        "Discord</a>";
    }
    if (!buttons) return "";

    return (
      '<div class="order-contact" id="order-contact">' +
      "<h4>Butuh bantuan dengan pesanan ini?</h4>" +
      "<p>Sebutkan Order ID kamu supaya admin bisa langsung mengeceknya.</p>" +
      '<div class="order-contact-row">' +
      buttons +
      "</div></div>"
    );
  }

  // Dipanggil ulang saat pengaturan kontak berubah dari Admin Web (Socket.IO).
  // Hanya menyentuh blok kontaknya, jadi detail pesanan yang sedang dibaca
  // tidak ikut dirender ulang.
  function refreshContact() {
    var host = $("order-contact-host");
    if (host) host.innerHTML = contactHTML();
  }

  /* ------------------------------------------------------------- daftar */

  function renderList(payload) {
    var orders = payload.orders || [];

    if (!orders.length) {
      $("result").innerHTML =
        '<div class="panel order-card">' +
        "<h3>Belum ada pesanan untuk email ini</h3>" +
        '<p class="muted" style="margin-top:8px">Pastikan email yang kamu masukkan sama persis dengan yang dipakai saat checkout. ' +
        "Kalau kamu memakai email lain, coba email tersebut, atau cari dengan Order ID.</p>" +
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
    var paid = isPaid(order);
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

  function renderDetail(order, showBack) {
    var steps = stepState(order)
      .map(function (s) {
        return '<div class="step ' + s.state + '"><i></i><b>' + s.label + "</b><span>" + s.note + "</span></div>";
      })
      .join("");

    // Blok pembayaran hanya untuk order yang MASIH menunggu pembayaran.
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

    // Tombol kontak HANYA untuk order yang sudah SUCCESS/PAID/COMPLETED, dan
    // sengaja dipisahkan dari blok pembayaran di atas supaya tidak pernah
    // terbaca sebagai tombol bayar.
    var contact = isPaid(order) ? '<div id="order-contact-host">' + contactHTML() + "</div>" : "";

    var media = order.product && order.product.image
      ? '<img src="' + MP.escapeHTML(order.product.image) + '" alt="' + MP.escapeHTML(order.product.name) + '" style="width:100%;max-width:200px;border-radius:12px;display:block;margin-bottom:18px" loading="lazy" decoding="async">'
      : "";

    $("result").innerHTML =
      (showBack
        ? '<button class="btn btn-ghost btn-sm order-back" type="button" id="order-back">Kembali ke daftar pesanan</button>'
        : "") +
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
      kv("Nama pembeli", order.customerName) +
      kv("Email pemesan", order.customerEmail) +
      kv("Harga satuan", MP.formatIDR(order.price)) +
      kv("Total", MP.formatIDR(order.total)) +
      kv("Metode pembayaran", order.paymentMethod) +
      kv("Status", MP.STATUS_LABEL[order.status] || order.status) +
      kv("Tanggal order", MP.formatDate(order.createdAt)) +
      (order.paidAt ? kv("Dibayar", MP.formatDate(order.paidAt)) : "") +
      (order.expiredAt ? kv("Kedaluwarsa", MP.formatDate(order.expiredAt)) : "") +
      "</div>" +
      // Email disamarkan kalau pesanan dibuka hanya dengan Order ID. Yang
      // ditampilkan di sini menjelaskan caranya membuka versi lengkapnya.
      (order.emailMasked
        ? '<p class="muted" style="font-size:12.5px;margin-top:14px">Email disamarkan karena pesanan ini dibuka dengan Order ID. Cari dengan emailmu untuk melihatnya lengkap.</p>'
        : "") +
      payment +
      contact +
      "</div>";
  }

  /* --------------------------------------------------------- pemanggilan */

  // `silent` dipakai oleh refresh realtime: kalau gagal, tampilan terakhir yang
  // masih benar dibiarkan berdiri daripada diganti pesan error yang mengagetkan.
  async function runSearch(params, silent) {
    var btn = $("track-submit");
    if (!silent) {
      setNote("Mencari pesanan…");
      btn.disabled = true;
      btn.textContent = "Mencari…";
    }

    try {
      var res = await MP.post("/orders/search", params);
      var data = res.data;

      currentQuery = params;
      currentMode = data.mode;

      if (data.mode === "email") {
        currentEmail = data.email;
        currentOrderCode = null;
        renderList(data);
      } else {
        // Detail langsung: tidak ada daftar di belakangnya, jadi tidak ada
        // tombol "kembali ke daftar" yang mengarah ke halaman kosong.
        currentOrderCode = data.order.orderCode;
        if (!data.order.emailMasked) currentEmail = data.order.customerEmail;
        renderDetail(data.order, false);
      }

      if (!silent) setNote("");
    } catch (err) {
      if (silent) return;
      $("result").innerHTML = "";
      setNote(err.message || "Pesanan tidak ditemukan.", true);
    } finally {
      if (!silent) {
        btn.disabled = false;
        btn.textContent = "Cek pesanan";
      }
    }
  }

  // Membuka satu pesanan dari daftar hasil pencarian email. Emailnya ikut
  // dikirim, jadi backend hanya membalas kalau order itu memang miliknya —
  // dan email pemesan boleh ditampilkan lengkap.
  async function loadDetail(orderCode, silent) {
    if (!currentEmail) return;
    if (!silent) setNote("Membuka detail pesanan…");

    try {
      var res = await MP.post("/orders/search", { query: orderCode, email: currentEmail });
      currentOrderCode = orderCode;
      if (!silent) setNote("");
      renderDetail(res.data.order, true);
    } catch (err) {
      if (silent) return;
      setNote(err.message || "Detail pesanan tidak bisa dibuka.", true);
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    $("track-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var query = String($("order-query").value || "").trim();

      if (!query) {
        setNote("Masukkan Email atau Order ID kamu.", true);
        return;
      }
      // SATU kolom, dua kemungkinan isi. Backend yang menentukan apakah isinya
      // email atau Order ID — tidak ada kolom kedua yang wajib diisi, dan tidak
      // ada kombinasi yang dipaksakan.
      runSearch({ query: query }, false);
    });

    // Satu listener untuk seluruh area hasil: daftar boleh dirender ulang
    // berkali-kali tanpa pernah menumpuk handler.
    $("result").addEventListener("click", function (e) {
      var row = e.target.closest("[data-order]");
      if (row) return loadDetail(row.dataset.order, false);
      if (e.target.closest("#order-back") && currentEmail) {
        currentOrderCode = null;
        return runSearch({ query: currentEmail }, false);
      }
    });

    // Realtime lewat Socket.IO existing. Yang dibaca ulang adalah tampilan yang
    // sedang terbuka — detail kalau sedang membuka detail, daftar kalau tidak.
    var refresh = MP.debounce(function (payload) {
      if (!currentQuery) return;
      if (currentOrderCode) {
        if (payload && payload.orderCode && payload.orderCode !== currentOrderCode) {
          // Order lain berubah: detail yang sedang dibaca tidak boleh
          // tiba-tiba berganti isi.
          return;
        }
        if (currentMode === "email") return loadDetail(currentOrderCode, true);
        return runSearch(currentQuery, true);
      }
      runSearch(currentQuery, true);
    }, 250);

    MP.on(["order:updated", "payment:updated"], refresh);
    MP.onReconnect(function () {
      if (!currentQuery) return;
      if (currentOrderCode && currentMode === "email") return loadDetail(currentOrderCode, true);
      runSearch(currentQuery, true);
    });

    // Kontak admin bisa diubah kapan saja dari Admin Web; blok tombolnya ikut
    // segar tanpa perlu memuat ulang halaman.
    MP.onSettings(refreshContact);

    // Link dari halaman sukses / email boleh membawa email atau Order ID,
    // supaya pembeli tidak perlu mengetik ulang.
    var params = new URLSearchParams(window.location.search);
    var presetEmail = normalizeEmail(params.get("email"));
    var presetOrder = String(params.get("order") || "").trim();

    var preset = presetOrder || presetEmail;
    if (preset) {
      $("order-query").value = preset;
      runSearch({ query: preset }, false);
    }
  });
})();
