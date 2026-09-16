# Deployment Railway — 31 Store

## Root cause kenapa `/` menampilkan `{"status":false,"message":"Route not found"}`

Railway **Root Directory = `/server`** membuat Railway hanya meng-upload isi folder
`server/` ke container. Padahal file website ada di **luar** folder itu:

```
repo/
├── index.html          <- Homepage Marketplace   (DI LUAR /server)
├── product.html        (DI LUAR /server)
├── admin/              <- Admin Web              (DI LUAR /server)
├── assets/css, assets/js                          (DI LUAR /server)
├── rating/ , cek-pesanan/                         (DI LUAR /server)
└── server/             <- HANYA folder ini yang ter-deploy
```

Di dalam container, `express.static(path.join(__dirname, ".."))` menunjuk ke folder
induk yang **kosong**. Jadi tidak ada satu pun file HTML/CSS/JS yang bisa diserve,
semua request non-`/api` lolos ke `notFoundHandler`, dan browser menerima JSON
`Route not found`. API tetap hidup karena kodenya memang ada di `/server`.

Dengan kata lain: ini bukan bug route, tapi **file frontend-nya tidak ikut ter-deploy**.

## Perbaikan (pilih salah satu)

### Opsi A — Direkomendasikan: deploy dari root repo

1. Railway → Service → **Settings → Source → Root Directory**: **kosongkan** (hapus `/server`).
2. Build & Start Command: **kosongkan juga** — sudah diatur oleh `railway.json` +
   `package.json` di root:
   - install: otomatis (`postinstall` menjalankan `npm install --prefix server --omit=dev`)
   - start: `npm start` → `node server/server.js`
   - healthcheck: `/api/health`
3. Deploy ulang.

Struktur folder tidak berubah sama sekali, semua file tetap di tempatnya.

### Opsi B — Kalau Root Directory wajib tetap `/server`

Pindahkan file frontend ke dalam `server/public` supaya ikut ter-deploy:

```bash
mkdir -p server/public
git mv index.html product.html admin assets rating cek-pesanan server/public/
git commit -m "chore: pindahkan frontend ke server/public untuk Railway root dir /server"
```

Tidak perlu mengubah kode: `server/config/paths.js` otomatis mendeteksi
`server/public`. Untuk opsi ini, Start Command Railway cukup `npm start`
(dijalankan dari `/server`).

## Environment variable yang wajib ada di Railway

`MONGODB_URI`, `JWT_SECRET`, `SESSION_SECRET`, `ENCRYPTION_SECRET`
(server sengaja gagal-cepat dengan pesan jelas kalau salah satu kosong).

Selain itu, untuk domain custom:

```
NODE_ENV=production
CLIENT_URL=https://www.31store.site
ADMIN_URL=https://www.31store.site
SERVER_PUBLIC_URL=https://www.31store.site
KLIKQRIS_WEBHOOK_URL=https://www.31store.site/api/payments/klikqris/webhook
```

`PORT` **jangan** diisi manual — Railway yang menyuntikkannya.
`FRONTEND_DIR` biarkan kosong kecuali struktur folder tidak standar.

## Verifikasi setelah deploy

Di shell service Railway:

```bash
node server/scripts/checkPaths.js   # Opsi A
node scripts/checkPaths.js          # Opsi B
```

Script ini mencetak folder frontend yang terdeteksi dan mengecek satu per satu
keberadaan halaman + asset. Kalau frontend tidak ikut ter-deploy, script keluar
dengan status 1 dan menjelaskan sebabnya.

Lalu cek dari browser:

| URL | Harus menghasilkan |
|---|---|
| `https://www.31store.site/` | Homepage Marketplace |
| `https://www.31store.site/admin` | redirect 301 ke `/admin/` |
| `https://www.31store.site/admin/` | Admin Web lengkap dengan CSS |
| `https://www.31store.site/admin/login` | Halaman login admin |
| `https://www.31store.site/api/settings` | JSON dari API settings |
| `https://www.31store.site/api/health` | `{"status":true,...}` |
| `https://www.31store.site/assets/css/style.css` | CSS (`text/css`) |

## Urutan route di `server/server.js` (jangan diacak)

```
1. /api/*            -> apiRouter
2. /api/*            -> 404 JSON khusus API (berhenti di sini)
3. /assets, /css, /js, /admin/*.css|js  -> static asset
4. /, /admin/, /product, /cek-pesanan/, /rating/  -> halaman HTML
5. express.static(frontendDir)  -> sisa file statis
6. notFoundHandler -> errorHandler
```

Langkah 2 adalah kuncinya: endpoint `/api` yang tidak dikenal berhenti sebagai
JSON dan tidak pernah jatuh ke handler frontend, sementara halaman frontend tidak
pernah menelan request API.
