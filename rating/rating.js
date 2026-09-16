(function () {
  const $ = (id) => document.getElementById(id);

  function reviewCard(r) {
    const stars = "★".repeat(r.rating) + "☆".repeat(5 - r.rating);
    return `<article class="feature-card">
      <div class="icon">★</div>
      <h3>${MP.escapeHTML(r.user)}</h3>
      <p style="color:#7650bd;font-weight:800;margin:10px 0">${stars}</p>
      <p>${MP.escapeHTML(r.review)}</p>
      <small style="display:block;margin-top:15px;color:#aaa">${MP.formatDate(r.createdAt)}</small>
    </article>`;
  }

  async function loadReviews() {
    try {
      const res = await MP.get("/ratings");
      const reviews = res.data || [];
      $("reviews").innerHTML = reviews.length
        ? reviews.map(reviewCard).join("")
        : `<p style="color:#8a8093;font-size:13px">Belum ada ulasan. Jadilah yang pertama memberi review!</p>`;
    } catch (err) {
      $("reviews").innerHTML = `<p style="color:#c0392b;font-size:13px">Gagal memuat ulasan.</p>`;
      console.error(err);
    }
  }

  $("review-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const btn = $("review-submit");
    const msg = $("review-msg");
    msg.style.color = "#7d7485";
    msg.textContent = "";
    btn.disabled = true;
    btn.textContent = "Mengirim...";
    try {
      const res = await MP.post("/ratings", {
        user: $("rv-user").value.trim(),
        rating: Number($("rv-rating").value),
        review: $("rv-review").value.trim(),
      });
      msg.style.color = "#1b8a4c";
      msg.textContent = res.message || "Terima kasih! Review kamu menunggu moderasi.";
      e.target.reset();
    } catch (err) {
      msg.style.color = "#c0392b";
      msg.textContent = err.message || "Gagal mengirim review.";
    } finally {
      btn.disabled = false;
      btn.textContent = "Kirim Review";
    }
  });

  loadReviews();
  const socket = MP.getSocket();
  if (socket) socket.on("rating:updated", MP.debounce(loadReviews, 300));
})();
