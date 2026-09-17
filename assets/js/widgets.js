/* ============================================================================
   31 Store — Floating Order Success + Floating Live Chat
   Memakai MP (assets/js/common.js) untuk REST dan Socket.IO yang sudah ada.
   Tidak ada koneksi realtime kedua, tidak ada polling, tidak ada data karangan.

   Aktivasi per halaman lewat atribut body:
     data-widgets="order chat"   (default kalau atributnya tidak ada)
     data-widgets="chat"         hanya Live Chat (dipakai halaman pembayaran)
     data-widgets="none"         matikan keduanya
   ========================================================================= */
(function (window, document) {
  "use strict";

  if (!window.MP) return;

  var TOKEN_KEY = "mp_chat_token";
  var PROFILE_KEY = "mp_chat_profile";
  var EMOJI = ["😀", "😁", "😊", "🙏", "👍", "👌", "🔥", "❤️", "😍", "🤔", "😅", "😭", "🎮", "💳", "✅", "❓"];

  var enabled = String(document.body.dataset.widgets || "order chat").toLowerCase();
  var wantOrder = enabled.indexOf("order") >= 0;
  var wantChat = enabled.indexOf("chat") >= 0;
  if (enabled === "none") {
    wantOrder = false;
    wantChat = false;
  }

  /* --------------------------------------------------------------- utils */
  function el(tag, cls, html) {
    var node = document.createElement(tag);
    if (cls) node.className = cls;
    if (html !== undefined) node.innerHTML = html;
    return node;
  }

  function relativeTime(value) {
    var then = new Date(value).getTime();
    if (!then || Number.isNaN(then)) return "";
    var diff = Math.max(0, Date.now() - then);
    var mins = Math.floor(diff / 60000);
    if (mins < 1) return "Baru saja";
    if (mins < 60) return mins + " menit lalu";
    var hours = Math.floor(mins / 60);
    if (hours < 24) return hours + " jam lalu";
    return Math.floor(hours / 24) + " hari lalu";
  }

  function clockTime(value) {
    var d = new Date(value);
    if (Number.isNaN(d.getTime())) return "";
    return d.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit" });
  }

  function dayLabel(value) {
    var d = new Date(value);
    var today = new Date();
    if (d.toDateString() === today.toDateString()) return "Hari ini";
    return d.toLocaleDateString("id-ID", { day: "numeric", month: "long" });
  }

  // Kunci idempotency per pesan. Dipakai server untuk menolak kiriman ganda
  // (index unik di MongoDB), jadi retry setelah reconnect tidak pernah
  // menghasilkan dua pesan.
  function newClientId() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return "c" + Date.now() + Math.random().toString(16).slice(2, 10);
  }

  function store(key, value) {
    try {
      if (value === null) localStorage.removeItem(key);
      else localStorage.setItem(key, value);
    } catch (err) {
      /* penyimpanan lokal diblokir — chat tetap jalan untuk sesi ini */
    }
  }

  function read(key) {
    try {
      return localStorage.getItem(key);
    } catch (err) {
      return null;
    }
  }

  /* =======================================================================
     1. FLOATING ORDER SUCCESS (kiri bawah)
     Sumber tunggalnya event Socket.IO "order:success:public", yang hanya
     dikirim backend setelah pembayaran benar-benar terverifikasi SUCCESS.
     Order pending/failed/expired/cancelled tidak pernah punya event ini,
     jadi tidak ada yang perlu disaring di sisi browser.
     ==================================================================== */
  var orderFeed = (function () {
    var HOLD_MS = 6500; // lama satu kartu tampil
    var GAP_MS = 2600; // jeda antar kartu, supaya tidak terasa spam
    var MAX_QUEUE = 3; // antrean pendek: order ke-4 yang datang beruntun dibuang

    var host = null;
    var queue = [];
    var seen = new Set(); // dedupe: id yang sama tidak pernah tampil dua kali
    var showing = false;
    var timer = null;

    function mount() {
      host = el("div", "mp-float mp-float-order");
      host.setAttribute("aria-live", "polite");
      document.body.appendChild(host);
    }

    function card(order) {
      var href = order.productSlug ? basePath() + "product.html?slug=" + encodeURIComponent(order.productSlug) : null;
      var node = el(href ? "a" : "div", "mp-order-card");
      if (href) node.href = href;
      node.style.setProperty("--mp-hold", HOLD_MS + "ms");

      var media = order.productImage
        ? '<img src="' + MP.escapeHTML(order.productImage) + '" alt="" loading="lazy">'
        : MP.escapeHTML(MP.initials(order.productName));

      node.innerHTML =
        '<div class="mp-order-media">' + media + "</div>" +
        '<div class="mp-order-body">' +
        '<div class="mp-order-line"><b>' + MP.escapeHTML(order.customerName) + "</b> membeli " +
        MP.escapeHTML(order.productName) + (order.quantity > 1 ? " ×" + order.quantity : "") + "</div>" +
        '<div class="mp-order-price">' + MP.formatIDR(order.total) + "</div>" +
        '<div class="mp-order-meta"><span class="mp-order-dot"></span>Pembayaran berhasil' +
        '<span class="mp-order-time">' + MP.escapeHTML(relativeTime(order.paidAt)) + "</span></div>" +
        "</div>" +
        '<span class="mp-order-rail"></span>' +
        '<button class="mp-order-close" type="button" aria-label="Tutup">×</button>';

      node.querySelector(".mp-order-close").addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        hide(node);
      });

      // Hover menahan hitungan mundur — pembeli yang sedang membaca kartunya
      // tidak kehilangan isinya di tengah kalimat.
      node.addEventListener("mouseenter", function () {
        clearTimeout(timer);
      });
      node.addEventListener("mouseleave", function () {
        timer = setTimeout(function () {
          hide(node);
        }, 1200);
      });

      return node;
    }

    function basePath() {
      // rating/ dan cek-pesanan/ berada satu folder lebih dalam.
      return /\/(rating|cek-pesanan)\//.test(window.location.pathname) ? "../" : "";
    }

    function hide(node) {
      clearTimeout(timer);
      if (!node || !node.isConnected) {
        showing = false;
        setTimeout(next, GAP_MS);
        return;
      }
      node.classList.add("is-out");
      setTimeout(function () {
        node.remove();
        showing = false;
        setTimeout(next, GAP_MS);
      }, 200);
    }

    function next() {
      if (showing || !queue.length || !host) return;
      showing = true;
      var node = card(queue.shift());
      host.appendChild(node);
      timer = setTimeout(function () {
        hide(node);
      }, HOLD_MS);
    }

    function push(order) {
      if (!order || !order.id || seen.has(order.id)) return;
      seen.add(order.id);
      if (queue.length >= MAX_QUEUE) queue.shift();
      queue.push(order);
      next();
    }

    async function init() {
      mount();

      // Muat pertama: satu order sukses terbaru yang benar-benar ada di
      // database. Kartunya menulis waktu relatif ("2 jam lalu"), jadi order
      // lama tidak pernah menyamar sebagai pembelian yang baru terjadi.
      try {
        var res = await MP.get("/orders/recent-success?limit=3");
        var rows = (res && res.data) || [];
        if (rows.length) {
          setTimeout(function () {
            push(rows[0]);
          }, 4000);
          // Sisanya cukup ditandai sudah terlihat supaya tidak muncul lagi
          // kalau backend mengirim ulang riwayat setelah reconnect.
          rows.slice(1).forEach(function (row) {
            seen.add(row.id);
          });
        }
      } catch (err) {
        /* riwayat opsional — realtime di bawah tetap jalan */
      }

      MP.on("order:success:public", push);
    }

    return { init: init };
  })();

  /* =======================================================================
     2. FLOATING LIVE CHAT (kanan bawah)
     ==================================================================== */
  var liveChat = (function () {
    var token = read(TOKEN_KEY);
    var conversation = null;
    var messages = [];
    var seenIds = new Set();
    var unread = 0;
    var open = false;
    var loaded = false;
    var emojiOpen = false;

    var nodes = {};

    /* ---------------------------------------------------------- markup */
    function mount() {
      var host = el("div", "mp-float mp-float-chat");

      var btn = el("button", "mp-chat-btn");
      btn.type = "button";
      btn.setAttribute("aria-label", "Buka live chat");
      btn.innerHTML =
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 12a7.5 7.5 0 0 1-10.9 6.7L4 20l1.4-4.2A7.5 7.5 0 1 1 20 12Z"/></svg>' +
        '<span class="mp-chat-badge" hidden>0</span>';

      var panel = el("div", "mp-chat-panel");
      panel.hidden = true;
      panel.setAttribute("role", "dialog");
      panel.setAttribute("aria-label", "Live chat dengan admin");
      panel.innerHTML =
        '<div class="mp-chat-head">' +
        '<span class="mp-chat-mark" data-mark></span>' +
        '<span class="mp-chat-head-text">' +
        '<span class="mp-chat-title" data-title>Live Chat</span>' +
        '<span class="mp-chat-state" data-state="connecting"><i></i><span data-state-text>Menghubungkan…</span></span>' +
        "</span>" +
        '<button class="mp-chat-x" type="button" aria-label="Tutup">×</button>' +
        "</div>" +
        '<div class="mp-chat-log" data-log></div>' +
        '<div class="mp-emoji" data-emoji hidden></div>' +
        '<div class="mp-chat-foot" data-foot hidden>' +
        '<div class="mp-chat-note" data-note hidden></div>' +
        '<div class="mp-upload" data-upload hidden><span>Mengunggah foto…</span><span class="mp-upload-bar"><i data-upload-bar></i></span></div>' +
        '<div class="mp-chat-row">' +
        '<button class="mp-chat-tool" type="button" data-emoji-toggle aria-label="Emoji">🙂</button>' +
        '<button class="mp-chat-tool" type="button" data-attach aria-label="Kirim foto">' +
        '<svg viewBox="0 0 24 24"><path d="M21 11.5 12.5 20a5 5 0 0 1-7-7l8-8a3.5 3.5 0 0 1 5 5l-8 8a2 2 0 0 1-3-3l7.5-7.5"/></svg>' +
        "</button>" +
        '<textarea class="mp-chat-input" data-input rows="1" placeholder="Tulis pesan…" maxlength="2000"></textarea>' +
        '<button class="mp-chat-send" type="button" data-send aria-label="Kirim">' +
        '<svg viewBox="0 0 24 24"><path d="m4 12 16-8-5 16-3-6-8-2Z"/></svg>' +
        "</button>" +
        "</div>" +
        '<input type="file" accept="image/jpeg,image/png,image/webp,image/gif" hidden data-file>' +
        "</div>";

      host.appendChild(panel);
      host.appendChild(btn);
      document.body.appendChild(host);

      nodes = {
        host: host,
        btn: btn,
        panel: panel,
        badge: btn.querySelector(".mp-chat-badge"),
        mark: panel.querySelector("[data-mark]"),
        title: panel.querySelector("[data-title]"),
        state: panel.querySelector(".mp-chat-state"),
        stateText: panel.querySelector("[data-state-text]"),
        log: panel.querySelector("[data-log]"),
        foot: panel.querySelector("[data-foot]"),
        note: panel.querySelector("[data-note]"),
        upload: panel.querySelector("[data-upload]"),
        uploadBar: panel.querySelector("[data-upload-bar]"),
        input: panel.querySelector("[data-input]"),
        send: panel.querySelector("[data-send]"),
        file: panel.querySelector("[data-file]"),
        attach: panel.querySelector("[data-attach]"),
        emoji: panel.querySelector("[data-emoji]"),
        emojiToggle: panel.querySelector("[data-emoji-toggle]"),
        close: panel.querySelector(".mp-chat-x"),
      };

      nodes.emoji.innerHTML = EMOJI.map(function (e) {
        return '<button type="button">' + e + "</button>";
      }).join("");

      bind();
      applyBranding(MP.getSettings());
      MP.onSettings(applyBranding);
    }

    function applyBranding(settings) {
      if (!settings || !nodes.title) return;
      var general = settings.general || {};
      var name = general.storeName || "Live Chat";
      nodes.title.textContent = name;
      nodes.mark.innerHTML = general.logo
        ? '<img src="' + MP.escapeHTML(general.logo) + '" alt="">'
        : MP.escapeHTML(MP.initials(name));
    }

    /* ------------------------------------------------------- tampilan */
    function setState(state, text) {
      if (!nodes.state) return;
      nodes.state.dataset.state = state;
      nodes.stateText.textContent = text;
    }

    function note(text, isError) {
      if (!nodes.note) return;
      nodes.note.textContent = text || "";
      nodes.note.hidden = !text;
      nodes.note.classList.toggle("is-error", Boolean(isError));
    }

    function setBadge(count) {
      unread = Math.max(0, count);
      nodes.badge.textContent = unread > 9 ? "9+" : String(unread);
      nodes.badge.hidden = unread === 0;
    }

    function renderEmpty() {
      nodes.log.innerHTML =
        '<div class="mp-chat-empty"><b>Belum ada pesan</b>Tulis pertanyaanmu tentang produk atau pesanan — admin akan membalas di sini.</div>';
    }

    function render() {
      if (!messages.length) {
        renderEmpty();
        return;
      }

      nodes.log.innerHTML = "";
      var lastDay = "";
      messages.forEach(function (msg) {
        var label = dayLabel(msg.createdAt);
        if (label !== lastDay) {
          lastDay = label;
          nodes.log.appendChild(el("div", "mp-chat-day", MP.escapeHTML(label)));
        }
        nodes.log.appendChild(bubble(msg));
      });
      nodes.log.scrollTop = nodes.log.scrollHeight;
    }

    function bubble(msg) {
      var wrap = el("div", "mp-msg " + (msg.sender === "customer" ? "is-me" : "is-them"));
      if (msg.pending) wrap.classList.add("is-sending");
      if (msg.failed) wrap.classList.add("is-failed");

      if (msg.attachment && msg.attachment.url) {
        var img = el("img", "mp-msg-photo");
        img.src = msg.attachment.url;
        img.alt = "Foto dari " + (msg.sender === "customer" ? "kamu" : "admin");
        img.loading = "lazy";
        img.addEventListener("click", function () {
          lightbox(msg.attachment.url);
        });
        wrap.appendChild(img);
      }

      if (msg.text) {
        // textContent, bukan innerHTML: isi pesan tidak pernah dirender
        // sebagai HTML, jadi tag/skrip yang diketik pengirim tampil apa
        // adanya sebagai teks.
        var b = el("div", "mp-bubble");
        b.textContent = msg.text;
        wrap.appendChild(b);
      }

      var time = el("span", "mp-msg-time");
      time.textContent = msg.failed ? "Gagal terkirim" : clockTime(msg.createdAt);
      wrap.appendChild(time);
      return wrap;
    }

    function lightbox(url) {
      var box = el("div", "mp-lightbox");
      var img = document.createElement("img");
      img.src = url;
      img.alt = "";
      box.appendChild(img);
      box.addEventListener("click", function () {
        box.remove();
      });
      document.body.appendChild(box);
    }

    /* -------------------------------------------------- formulir mulai */
    function renderStart() {
      nodes.foot.hidden = true;
      var saved = {};
      try {
        saved = JSON.parse(read(PROFILE_KEY) || "{}");
      } catch (err) {
        saved = {};
      }

      nodes.log.innerHTML = "";
      var form = el("div", "mp-chat-start");
      form.innerHTML =
        "<p>Tulis nama panggilanmu supaya admin tahu sedang bicara dengan siapa. Percakapan ini anonim dan tersimpan 24 jam.</p>" +
        '<input data-name type="text" maxlength="60" placeholder="Nama panggilan" value="' +
        MP.escapeHTML(saved.name || "") +
        '">' +
        '<input data-email type="email" maxlength="120" placeholder="Email (opsional, kalau ingin dihubungi balik)" value="' +
        MP.escapeHTML(saved.email || "") +
        '">' +
        "<button type=\"button\" data-start>Mulai chat</button>";
      nodes.log.appendChild(form);

      var nameInput = form.querySelector("[data-name]");
      var emailInput = form.querySelector("[data-email]");
      var btn = form.querySelector("[data-start]");

      btn.addEventListener("click", async function () {
        var name = nameInput.value.trim();
        if (!name) {
          nameInput.focus();
          return;
        }
        btn.disabled = true;
        btn.textContent = "Membuka…";
        try {
          var res = await MP.post("/chat/session", {
            name: name,
            email: emailInput.value.trim(),
            startedFrom: window.location.pathname,
          });
          token = res.data.token;
          store(TOKEN_KEY, token);
          store(PROFILE_KEY, JSON.stringify({ name: name, email: emailInput.value.trim() }));
          conversation = res.data.conversation;
          messages = [];
          seenIds = new Set();
          loaded = true;
          nodes.foot.hidden = false;
          renderEmpty();
          joinRoom();
          nodes.input.focus();
        } catch (err) {
          btn.disabled = false;
          btn.textContent = "Mulai chat";
          note(err.message || "Gagal membuka chat.", true);
        }
      });

      nameInput.focus();
    }

    /* ---------------------------------------------------------- data */
    function authHeaders() {
      return token ? { "X-Chat-Token": token } : {};
    }

    async function request(path, options) {
      options = options || {};
      var res = await fetch("/api" + path, {
        method: options.method || "GET",
        headers: Object.assign(
          options.body instanceof FormData ? {} : { "Content-Type": "application/json" },
          authHeaders()
        ),
        body: options.body,
        credentials: "same-origin",
      });
      var payload = null;
      try {
        payload = await res.json();
      } catch (err) {
        payload = null;
      }
      if (!res.ok || (payload && payload.status === false)) {
        var error = new Error((payload && payload.message) || "Terjadi kesalahan (" + res.status + ").");
        error.status = res.status;
        throw error;
      }
      return payload;
    }

    // Selalu memuat ulang dari database — bukan dari state di browser. Ini yang
    // membuat pesan yang terlewat selagi socket putus tetap muncul, dan pesan
    // yang sudah lewat 24 jam tidak pernah ikut tampil lagi.
    async function load() {
      if (!token) {
        renderStart();
        return;
      }
      nodes.log.innerHTML = '<div class="mp-chat-loading">Memuat percakapan…</div>';
      try {
        var res = await request("/chat/session");
        conversation = res.data.conversation;
        messages = res.data.messages || [];
        seenIds = new Set(messages.map(function (m) {
          return m.id;
        }));
        loaded = true;
        nodes.foot.hidden = false;
        render();
        joinRoom();
        markRead();
      } catch (err) {
        if (err.status === 401) {
          // Sesi kedaluwarsa (24 jam) atau dicabut: mulai bersih.
          token = null;
          store(TOKEN_KEY, null);
          renderStart();
          return;
        }
        nodes.log.innerHTML = '<div class="mp-chat-empty"><b>Gagal memuat</b>' + MP.escapeHTML(err.message) + "</div>";
      }
    }

    function joinRoom() {
      var socket = MP.getSocket();
      if (!socket || !token) return;
      socket.emit("chat:auth", { token: token }, function (ack) {
        if (ack && ack.ok) setState("online", "Terhubung");
      });
    }

    async function markRead() {
      setBadge(0);
      if (!token) return;
      try {
        await request("/chat/read", { method: "POST", body: JSON.stringify({}) });
      } catch (err) {
        /* penanda baca bukan hal kritis */
      }
    }

    /* --------------------------------------------------------- kirim */
    async function sendText() {
      var text = nodes.input.value.trim();
      if (!text || !token) return;

      var clientId = newClientId();
      var optimistic = {
        id: "local-" + clientId,
        sender: "customer",
        text: text,
        createdAt: new Date().toISOString(),
        pending: true,
        clientMessageId: clientId,
      };
      messages.push(optimistic);
      render();

      nodes.input.value = "";
      nodes.input.style.height = "auto";
      note("");

      try {
        var res = await request("/chat/messages", {
          method: "POST",
          body: JSON.stringify({ text: text, clientMessageId: clientId }),
        });
        replaceOptimistic(clientId, res.data);
      } catch (err) {
        optimistic.pending = false;
        optimistic.failed = true;
        render();
        note(err.message || "Pesan gagal terkirim.", true);
      }
    }

    // Menukar gelembung sementara dengan pesan asli dari database. Kalau event
    // Socket.IO untuk pesan itu tiba lebih dulu, `seenIds` sudah memuat id-nya
    // sehingga tidak pernah ada dua gelembung untuk satu pesan.
    function replaceOptimistic(clientId, real) {
      var index = messages.findIndex(function (m) {
        return m.clientMessageId === clientId && m.pending;
      });
      if (index >= 0) messages.splice(index, 1);
      if (!seenIds.has(real.id)) {
        seenIds.add(real.id);
        messages.push(real);
      }
      messages.sort(function (a, b) {
        return new Date(a.createdAt) - new Date(b.createdAt);
      });
      render();
    }

    async function sendPhoto(file) {
      if (!file || !token) return;
      if (file.size > 5 * 1024 * 1024) {
        note("Ukuran foto maksimal 5MB.", true);
        return;
      }
      if (["image/jpeg", "image/png", "image/webp", "image/gif"].indexOf(file.type) < 0) {
        note("Kirim foto JPG, PNG, WEBP, atau GIF.", true);
        return;
      }

      var clientId = newClientId();
      var form = new FormData();
      form.append("photo", file);
      form.append("clientMessageId", clientId);

      nodes.upload.hidden = false;
      nodes.uploadBar.style.width = "15%";
      note("");

      try {
        nodes.uploadBar.style.width = "65%";
        var res = await request("/chat/messages/photo", { method: "POST", body: form });
        nodes.uploadBar.style.width = "100%";
        if (!seenIds.has(res.data.id)) {
          seenIds.add(res.data.id);
          messages.push(res.data);
          render();
        }
      } catch (err) {
        note(err.message || "Foto gagal dikirim.", true);
      } finally {
        setTimeout(function () {
          nodes.upload.hidden = true;
          nodes.uploadBar.style.width = "0";
        }, 400);
      }
    }

    /* -------------------------------------------------------- realtime */
    function onMessage(msg) {
      if (!conversation || String(msg.conversationId) !== String(conversation.id)) return;
      if (seenIds.has(msg.id)) return; // dedupe: event yang sama tidak dirender dua kali

      // Kalau ini gema dari pesan kita sendiri yang sedang menunggu balasan
      // HTTP, buang gelembung sementaranya supaya tidak dobel.
      if (msg.clientMessageId) {
        var idx = messages.findIndex(function (m) {
          return m.pending && m.clientMessageId === msg.clientMessageId;
        });
        if (idx >= 0) messages.splice(idx, 1);
      }

      seenIds.add(msg.id);
      messages.push(msg);
      render();

      if (msg.sender === "admin") {
        if (open) markRead();
        else setBadge(unread + 1);
      }
    }

    function toggle(next) {
      open = next === undefined ? !open : next;
      nodes.panel.hidden = !open;
      document.body.classList.toggle("mp-chat-open", open);
      nodes.btn.setAttribute("aria-label", open ? "Tutup live chat" : "Buka live chat");
      if (open) {
        if (!loaded) load();
        else {
          // Buka ulang = sinkron ulang dari database, bukan percaya state lama.
          load();
        }
      } else {
        nodes.emoji.hidden = true;
        emojiOpen = false;
      }
    }

    /* ------------------------------------------------------------ bind */
    function bind() {
      nodes.btn.addEventListener("click", function () {
        toggle();
      });
      nodes.close.addEventListener("click", function () {
        toggle(false);
      });

      nodes.send.addEventListener("click", sendText);

      nodes.input.addEventListener("keydown", function (e) {
        if (e.key === "Enter" && !e.shiftKey) {
          e.preventDefault();
          sendText();
        }
      });

      nodes.input.addEventListener("input", function () {
        nodes.input.style.height = "auto";
        nodes.input.style.height = Math.min(96, nodes.input.scrollHeight) + "px";
      });

      nodes.attach.addEventListener("click", function () {
        nodes.file.click();
      });

      nodes.file.addEventListener("change", function () {
        var file = nodes.file.files && nodes.file.files[0];
        nodes.file.value = "";
        sendPhoto(file);
      });

      nodes.emojiToggle.addEventListener("click", function () {
        emojiOpen = !emojiOpen;
        nodes.emoji.hidden = !emojiOpen;
      });

      nodes.emoji.addEventListener("click", function (e) {
        if (e.target.tagName !== "BUTTON") return;
        nodes.input.value += e.target.textContent;
        nodes.emoji.hidden = true;
        emojiOpen = false;
        nodes.input.focus();
      });

      document.addEventListener("keydown", function (e) {
        if (e.key === "Escape" && open) toggle(false);
      });

      var socket = MP.getSocket();
      if (socket) {
        socket.on("connect", function () {
          setState("online", "Terhubung");
          joinRoom();
          // Setelah reconnect, database yang menentukan isi percakapan —
          // bukan apa pun yang tersisa di memori browser.
          if (open && token) load();
        });
        socket.on("disconnect", function () {
          setState("offline", "Koneksi terputus");
        });
        socket.io.on("reconnect_attempt", function () {
          setState("connecting", "Menghubungkan ulang…");
        });
      }

      MP.on("chat:message", onMessage);
    }

    function init() {
      mount();
      setState("connecting", "Menghubungkan…");
      if (token) {
        // Panel tertutup pun tetap bergabung ke room, supaya balasan admin
        // memunculkan badge tanpa perlu membuka panel lebih dulu.
        joinRoom();
        var socket = MP.getSocket();
        if (socket && socket.connected) setState("online", "Terhubung");
      }
    }

    return { init: init };
  })();

  /* ------------------------------------------------------------ bootstrap */
  document.addEventListener("DOMContentLoaded", function () {
    if (wantOrder) orderFeed.init();
    if (wantChat) liveChat.init();
  });
})(window, document);
