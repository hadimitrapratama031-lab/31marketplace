/* ==========================================================================
   ADMIN SESSION — satu sumber tunggal untuk penyimpanan token, batas waktu
   session, dan idle timeout Admin Web. Dipakai oleh login.js DAN admin.js
   supaya tidak ada 2 kunci/2 aturan berbeda (itulah yang sebelumnya membuat
   admin.js dan login.js bisa "tidak sepakat" soal status login).

   Kenapa localStorage, bukan sessionStorage:
   sessionStorage otomatis dikosongkan begitu TAB/BROWSER ditutup — itulah
   root cause "logout hanya karena menutup web". localStorage bertahan lintas
   tab & lintas reopen; masa berlaku session (2 jam absolut + 2 jam idle)
   sepenuhnya kita kontrol sendiri lewat EXPIRES_KEY/ACTIVITY_KEY di bawah,
   bukan mengandalkan browser menutup tab.

   Tidak ada password yang pernah disimpan di sini — hanya JWT token.
   ========================================================================== */
(function () {
  "use strict";

  // Konfigurasi terpusat — SATU-SATUNYA tempat "2 jam" ditulis di frontend.
  // Diselaraskan dengan server/config/session.js (SESSION_MAX_AGE_MS &
  // SESSION_IDLE_TIMEOUT_MS) yang dipakai sebagai JWT expiresIn di backend
  // DAN divalidasi ulang di backend (requireAdminAuth) — frontend bukan
  // satu-satunya penjaga.
  var SESSION_MAX_AGE_MS = 2 * 60 * 60 * 1000; // batas absolut sejak login
  var SESSION_IDLE_TIMEOUT_MS = 2 * 60 * 60 * 1000; // tanpa aktivitas nyata

  var TOKEN_KEY = "mp_admin_token";
  var EXPIRES_KEY = "mp_admin_token_expires_at";
  var ACTIVITY_KEY = "mp_admin_last_activity";

  function now() {
    return Date.now();
  }

  // Mengembalikan token HANYA kalau belum lewat batas absolut maupun idle.
  // Kalau sudah lewat, bersihkan session sekalian (bukan sekadar bilang
  // "tidak ada token" tapi meninggalkan sisa data lama).
  function getToken() {
    var token = localStorage.getItem(TOKEN_KEY);
    if (!token) return null;

    var expiresAt = Number(localStorage.getItem(EXPIRES_KEY) || 0);
    if (!expiresAt || now() > expiresAt) {
      clearToken();
      return null;
    }

    var lastActivity = Number(localStorage.getItem(ACTIVITY_KEY) || 0);
    if (!lastActivity || now() - lastActivity > SESSION_IDLE_TIMEOUT_MS) {
      clearToken();
      return null;
    }

    return token;
  }

  function setToken(token) {
    localStorage.setItem(TOKEN_KEY, token);
    localStorage.setItem(EXPIRES_KEY, String(now() + SESSION_MAX_AGE_MS));
    markActivity();
  }

  // Dipanggil dari event aktivitas NYATA saja (lihat wireActivityTracking) —
  // Socket.IO heartbeat/reconnect/polling TIDAK pernah memanggil ini,
  // sehingga proses background tidak memperpanjang idle timeout (spec).
  function markActivity() {
    if (localStorage.getItem(TOKEN_KEY)) {
      localStorage.setItem(ACTIVITY_KEY, String(now()));
    }
  }

  function clearToken() {
    localStorage.removeItem(TOKEN_KEY);
    localStorage.removeItem(EXPIRES_KEY);
    localStorage.removeItem(ACTIVITY_KEY);
  }

  var ACTIVITY_EVENTS = ["click", "keydown", "submit", "pointerdown"];
  var wired = false;

  // Idempoten — aman dipanggil berkali-kali, tidak pernah memasang listener
  // dobel (spec: jangan membuat duplicate timer/event listener).
  function wireActivityTracking() {
    if (wired) return;
    wired = true;

    ACTIVITY_EVENTS.forEach(function (ev) {
      document.addEventListener(ev, markActivity, { passive: true, capture: true });
    });
    window.addEventListener("hashchange", markActivity);

    // Sinkronisasi antar tab: kalau tab lain logout (token dihapus dari
    // localStorage), event "storage" ini terpicu di tab-tab lainnya —
    // sehingga logout satu tab langsung tersinkron ke tab lain tanpa
    // membuat sistem realtime baru (event bawaan localStorage, bukan
    // Socket.IO tambahan).
    window.addEventListener("storage", function (e) {
      if (e.key === TOKEN_KEY && !e.newValue && window.MPAuth.onRemoteLogout) {
        window.MPAuth.onRemoteLogout();
      }
    });
  }

  window.MPAuth = {
    getToken: getToken,
    setToken: setToken,
    clearToken: clearToken,
    markActivity: markActivity,
    wireActivityTracking: wireActivityTracking,
    SESSION_IDLE_TIMEOUT_MS: SESSION_IDLE_TIMEOUT_MS,
    onRemoteLogout: null,
  };
})();
