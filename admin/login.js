(function () {
  "use strict";
  const TOKEN_KEY = "mp_admin_token";
  const form = document.getElementById("loginForm");
  const errorBox = document.getElementById("loginError");
  const errorText = document.getElementById("loginErrorText");
  const submitBtn = document.getElementById("submitBtn");

  function showError(message) {
    errorText.textContent = message;
    errorBox.classList.add("show");
  }

  // Tombol lihat/sembunyikan password.
  const pwInput = document.getElementById("password");
  const pwToggle = document.getElementById("pwToggle");
  pwToggle.addEventListener("click", () => {
    const shown = pwInput.type === "text";
    pwInput.type = shown ? "password" : "text";
    pwToggle.setAttribute("aria-label", shown ? "Tampilkan password" : "Sembunyikan password");
    pwToggle.querySelector("use").setAttribute("href", shown ? "#i-eye" : "#i-eye-off");
    pwInput.focus();
  });

  // Pull real store branding so the login page is not hardcoded to one store name.
  fetch("/api/settings")
    .then((r) => (r.ok ? r.json() : null))
    .then((payload) => {
      const general = payload && payload.data && payload.data.general;
      if (!general) return;
      if (general.storeName) {
        document.getElementById("brandName").textContent = general.storeName;
        document.title = "Masuk — " + general.storeName;
        document.getElementById("brandMark").textContent = general.storeName.trim().charAt(0).toUpperCase();
      }
      if (general.favicon) {
        const link = document.createElement("link");
        link.rel = "icon";
        link.href = general.favicon;
        document.head.appendChild(link);
      }
    })
    .catch(() => {});

  // If a valid session already exists, skip the login form.
  const existing = sessionStorage.getItem(TOKEN_KEY);
  if (existing) {
    fetch("/api/auth/me", { headers: { Authorization: "Bearer " + existing } })
      .then((r) => {
        if (r.ok) window.location.replace("./index.html");
        else sessionStorage.removeItem(TOKEN_KEY);
      })
      .catch(() => {});
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    errorBox.classList.remove("show");
    submitBtn.disabled = true;
    submitBtn.textContent = "Memproses...";

    try {
      const res = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          email: document.getElementById("email").value.trim(),
          password: document.getElementById("password").value,
        }),
      });
      const payload = await res.json().catch(() => null);

      if (!res.ok || !payload || payload.status === false) {
        throw new Error((payload && payload.message) || "Login gagal. Coba lagi.");
      }

      sessionStorage.setItem(TOKEN_KEY, payload.data.token);
      window.location.replace("./index.html");
    } catch (err) {
      showError(err.message);
      submitBtn.disabled = false;
      submitBtn.textContent = "Masuk";
    }
  });
})();
