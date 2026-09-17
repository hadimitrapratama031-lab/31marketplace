/* ============================================================================
   31 Store — ulasan pembeli.
   Reviews come from /api/ratings (approved only) and the headline score from
   /api/statistics. New reviews go through the same moderation queue as before.
   ========================================================================= */
(function () {
  "use strict";

  var $ = function (id) {
    return document.getElementById(id);
  };

  var PAGE = 9;
  var state = { reviews: [], stats: null, shown: PAGE, rating: 5 };

  function starRow(value) {
    var full = Math.round(Number(value) || 0);
    return "★★★★★".slice(0, full) + "☆☆☆☆☆".slice(0, 5 - full);
  }

  /* -------------------------------------------------------------- summary */
  function renderSummary() {
    var avg = state.stats && state.stats.averageRating ? Number(state.stats.averageRating) : 0;
    var count = state.stats && state.stats.ratingCount ? Number(state.stats.ratingCount) : state.reviews.length;

    $("score").textContent = avg ? avg.toFixed(1) : "—";
    $("score-stars").textContent = starRow(avg);
    $("score-count").textContent = count ? MP.formatNumber(count) + " ulasan disetujui" : "belum ada ulasan";

    var buckets = [0, 0, 0, 0, 0];
    state.reviews.forEach(function (r) {
      var i = Math.min(5, Math.max(1, Number(r.rating) || 0)) - 1;
      buckets[i] += 1;
    });
    var max = Math.max.apply(null, buckets.concat([1]));

    $("distribution").innerHTML = [5, 4, 3, 2, 1]
      .map(function (star) {
        var n = buckets[star - 1];
        return (
          '<div class="bar-row"><span>' + star + "★</span>" +
          '<span class="bar"><i style="width:' + Math.round((n / max) * 100) + '%"></i></span>' +
          "<span>" + n + "</span></div>"
        );
      })
      .join("");
  }

  /* -------------------------------------------------------------- reviews */
  function renderReviews() {
    var grid = $("review-grid");

    if (!state.reviews.length) {
      grid.innerHTML = '<div class="notice" style="grid-column:1/-1"><b>Belum ada ulasan</b>Jadi yang pertama menulis pengalaman belanja kamu.</div>';
      $("review-count").textContent = "0 ulasan";
      $("load-more").hidden = true;
      return;
    }

    var page = state.reviews.slice(0, state.shown);
    grid.innerHTML = page
      .map(function (r) {
        var avatar = r.avatar
          ? '<img src="' + MP.escapeHTML(r.avatar) + '" alt="" loading="lazy">'
          : MP.escapeHTML(MP.initials(r.user));
        return (
          '<article class="review">' +
          '<div class="review-top">' +
          '<div class="avatar">' + avatar + "</div>" +
          '<div class="review-who"><b>' + MP.escapeHTML(r.user) + "</b><small>" + MP.formatDate(r.createdAt) + "</small></div>" +
          "</div>" +
          '<div class="stars">' + starRow(r.rating) + "</div>" +
          "<p>" + MP.escapeHTML(r.review) + "</p>" +
          "</article>"
        );
      })
      .join("");

    $("review-count").textContent =
      page.length < state.reviews.length
        ? "Menampilkan " + page.length + " dari " + MP.formatNumber(state.reviews.length) + " ulasan"
        : MP.formatNumber(state.reviews.length) + " ulasan";

    $("load-more").hidden = page.length >= state.reviews.length;
  }

  /* ----------------------------------------------------------------- data */
  async function load() {
    var results = await Promise.allSettled([MP.get("/ratings"), MP.get("/statistics")]);
    if (results[0].status === "fulfilled") state.reviews = results[0].value.data || [];
    if (results[1].status === "fulfilled") state.stats = results[1].value.data;

    if (results[0].status === "rejected") {
      console.error("Gagal memuat ulasan:", results[0].reason);
      $("review-grid").innerHTML = '<div class="notice" style="grid-column:1/-1"><b>Ulasan gagal dimuat</b>Periksa koneksi, lalu muat ulang halaman.</div>';
      $("review-count").textContent = "Gagal memuat";
      return;
    }

    renderReviews();
    renderSummary();
  }

  /* ----------------------------------------------------------------- form */
  function setStars(value) {
    state.rating = value;
    Array.prototype.forEach.call($("star-picker").children, function (btn) {
      btn.classList.toggle("is-on", Number(btn.dataset.star) <= value);
    });
  }

  async function submitReview(e) {
    e.preventDefault();
    var note = $("rv-note");
    var btn = $("rv-submit");

    var user = $("rv-user").value.trim();
    var review = $("rv-review").value.trim();

    if (!user || !review) {
      note.className = "form-note is-error";
      note.textContent = "Nama dan ulasan wajib diisi.";
      return;
    }

    note.className = "form-note";
    note.textContent = "Mengirim…";
    btn.disabled = true;

    try {
      var res = await MP.post("/ratings", { user: user, rating: state.rating, review: review });
      note.className = "form-note is-ok";
      note.textContent = res.message || "Terima kasih. Ulasan kamu menunggu moderasi.";
      $("review-form").reset();
      setStars(5);
    } catch (err) {
      note.className = "form-note is-error";
      note.textContent = err.message || "Ulasan gagal dikirim. Coba lagi.";
    } finally {
      btn.disabled = false;
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    setStars(5);

    $("star-picker").addEventListener("click", function (e) {
      var btn = e.target.closest("[data-star]");
      if (btn) setStars(Number(btn.dataset.star));
    });

    $("review-form").addEventListener("submit", submitReview);

    $("load-more-btn").addEventListener("click", function () {
      state.shown += PAGE;
      renderReviews();
    });

    load();

    var refresh = MP.debounce(load, 300);
    MP.on(["rating:updated", "statistics:updated"], refresh);
    MP.onReconnect(refresh);
  });
})();
