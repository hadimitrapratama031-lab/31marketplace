# Marketplace + Admin Web — Full Stack

Marketplace produk digital dengan Admin Web, dibangun sebagai satu sistem end-to-end:

```
Marketplace / Admin Web  →  Express  →  MongoDB
                              ↓
                          Socket.IO  →  Marketplace + Admin Web (realtime, tanpa refresh)
                              ↓
        Cloudflare R2 (file)  ·  KlikQRIS (payment)  ·  Fonnte (WhatsApp)  ·  Resend (email)
```

Tidak ada data dummy, harga hardcoded, atau simulasi pembayaran. MongoDB adalah satu-satunya source of truth; harga, stok, dan status pembayaran tidak pernah dipercaya dari frontend.

---

## Daftar Isi

1. [Struktur Folder](#struktur-folder)
2. [Stack](#stack)
3. [Instalasi](#instalasi)
4. [Environment Variables](#environment-variables)
5. [Setup MongoDB Atlas](#setup-mongodb-atlas)
6. [Setup Cloudflare R2](#setup-cloudflare-r2)
7. [Setup KlikQRIS](#setup-klikqris)
8. [Setup Fonnte](#setup-fonnte)
9. [Setup Resend](#setup-resend)
10. [Menjalankan (development & production)](#menjalankan)
11. [Akun Admin Pertama](#akun-admin-pertama)
12. [Deploy ke Railway](#deploy-ke-railway)
13. [Webhook KlikQRIS](#webhook-klikqris)
14. [Payment Flow](#payment-flow)
15. [Notification Flow](#notification-flow)
16. [Socket.IO Events](#socketio-events)
17. [API Reference](#api-reference)
18. [Admin Web](#admin-web)
19. [Marketplace](#marketplace)
20. [Checklist Testing End-to-End](#checklist-testing-end-to-end)
21. [Troubleshooting](#troubleshooting)

---

## Struktur Folder

```
.
├── index.html                  # Marketplace — homepage
├── product.html                # Marketplace — detail produk + checkout QRIS
├── cek-pesanan/index.html      # Lacak order by orderCode (realtime)
├── rating/index.html           # Daftar review + form submit review
├── assets/
│   ├── css/style.css
│   ├── css/product.css
│   └── js/
│       ├── common.js           # Helper bersama: fetch /api, format Rupiah/tanggal, Socket.IO
│       ├── app.js              # Homepage: settings, kategori, produk, FAQ, statistik
│       └── product.js          # Detail produk, checkout, QRIS, watcher pembayaran
├── admin/
│   ├── login.html              # Login admin (JWT → sessionStorage)
│   ├── index.html              # Admin Web (SPA sederhana, 10 halaman)
│   ├── admin.js                # Semua logika admin (API + Socket.IO)
│   └── admin.css
└── server/
    ├── server.js               # Entry point: Express + Socket.IO + static frontend
    ├── config/
    │   ├── db.js               # Koneksi MongoDB
    │   └── r2.js               # S3 client untuk Cloudflare R2
    ├── models/                 # Product, Category, Order, Transaction, Customer,
    │                           # Rating, FAQ, WebsiteSettings, IntegrationSettings,
    │                           # Admin, NotificationLog
    ├── controllers/            # Handler per resource
    ├── routes/                 # Definisi endpoint
    ├── services/               # klikqris, fonnte, resend, r2, notification,
    │                           # template, integration, socket
    ├── middlewares/            # auth (JWT), upload (multer), rateLimit, errorHandler
    ├── utils/                  # crypto (AES-256-GCM), logger, phone, orderCode
    ├── scripts/seedAdmin.js    # Bikin superadmin pertama
    ├── .env.example
    └── package.json
```

Frontend di-serve oleh Express yang sama (`express.static`), jadi tidak ada masalah CORS di production dan Socket.IO bisa diambil dari `/socket.io/socket.io.js` tanpa CDN.

---

## Stack

| Bagian | Teknologi |
|---|---|
| Marketplace & Admin Web | HTML, CSS, JavaScript (tanpa framework) |
| Backend | Node.js ≥ 18, Express 4 |
| Database | MongoDB (Mongoose 8) |
| Realtime | Socket.IO 4 |
| Storage | Cloudflare R2 (via AWS S3 SDK) |
| Payment | KlikQRIS |
| WhatsApp | Fonnte |
| Email | Resend |
| Deployment | Railway |
| Keamanan | JWT, bcrypt, Helmet, CORS whitelist, rate limit, AES-256-GCM |

---

## Instalasi

```bash
git clone <repo-url>
cd <repo>/server
npm install
cp .env.example .env
# isi .env sesuai bagian di bawah
```

Semua dependency ada di folder `server`. Frontend tidak butuh build step.

---

## Environment Variables

Isi `server/.env` (di Railway: **Variables**). Jangan pernah commit `.env` — sudah masuk `.gitignore`.

### Server

| Variable | Wajib | Keterangan |
|---|---|---|
| `NODE_ENV` | — | `development` / `production` |
| `PORT` | — | Railway mengisinya otomatis; default `4000` |
| `CLIENT_URL` | ✅ (prod) | Origin Marketplace, dipakai whitelist CORS |
| `ADMIN_URL` | ✅ (prod) | Origin Admin Web |
| `SERVER_PUBLIC_URL` | ✅ (prod) | URL publik server |
| `EXTRA_CORS_ORIGINS` | — | Origin tambahan, dipisah koma |

> Kalau `CLIENT_URL`/`ADMIN_URL` kosong, CORS terbuka — hanya boleh untuk development lokal.

### Database & Keamanan

| Variable | Wajib | Keterangan |
|---|---|---|
| `MONGODB_URI` | ✅ | Connection string MongoDB Atlas |
| `JWT_SECRET` | ✅ | String acak panjang untuk menandatangani token admin |
| `JWT_EXPIRES_IN` | — | Default `7d` |
| `SESSION_SECRET` | ✅ | String acak |
| `ENCRYPTION_SECRET` | ✅ | Kunci enkripsi kredensial integrasi di DB. **Kalau diganti, semua kredensial yang tersimpan tidak bisa didekripsi lagi** dan harus diisi ulang dari Admin Web |

Generate secret:

```bash
node -e "console.log(require('crypto').randomBytes(48).toString('hex'))"
```

### Bootstrap Admin

| Variable | Keterangan |
|---|---|
| `ADMIN_BOOTSTRAP_EMAIL` | Email superadmin pertama |
| `ADMIN_BOOTSTRAP_PASSWORD` | Password awal — ganti lewat Admin Web setelah login pertama |
| `ADMIN_BOOTSTRAP_NAME` | Nama tampilan |

Hanya dipakai oleh `npm run seed:admin`, tidak dibaca saat runtime.

### Cloudflare R2

| Variable | Keterangan |
|---|---|
| `R2_ACCOUNT_ID` | Account ID Cloudflare |
| `R2_ACCESS_KEY_ID` | API token R2 |
| `R2_SECRET_ACCESS_KEY` | Secret token R2 |
| `R2_BUCKET_NAME` | Nama bucket |
| `R2_PUBLIC_URL` | Base URL publik bucket, mis. `https://pub-xxxx.r2.dev` |

### KlikQRIS

| Variable | Keterangan |
|---|---|
| `KLIKQRIS_MODE` | `production` atau `sandbox` |
| `KLIKQRIS_BASE_URL` | `https://klikqris.com/api` (sandbox: `https://klikqris.com/api/sandbox`) |
| `KLIKQRIS_API_KEY` | Dikirim sebagai header `x-api-key` |
| `KLIKQRIS_MERCHANT_ID` | Dikirim sebagai header `id_merchant` |
| `KLIKQRIS_WEBHOOK_URL` | URL publik callback, mis. `https://app.up.railway.app/api/payments/klikqris/webhook` |

### Fonnte & Resend

| Variable | Keterangan |
|---|---|
| `FONNTE_TOKEN` | Token device Fonnte |
| `RESEND_API_KEY` | API key Resend |
| `RESEND_FROM_EMAIL` | Alamat pengirim (domainnya harus terverifikasi di Resend) |
| `RESEND_FROM_NAME` | Nama pengirim |

### ENV vs Admin Web

Kredensial KlikQRIS, Fonnte, dan Resend bisa diisi dari **dua** tempat:

1. **Railway ENV** — dipakai sebagai fallback supaya sistem langsung jalan setelah deploy.
2. **Admin Web → Integrasi** — disimpan terenkripsi AES-256-GCM di MongoDB. **Nilai dari database menang** kalau ada.

Yang **tidak** bisa diatur dari Admin Web (memang seharusnya tetap di server): `MONGODB_URI`, `JWT_SECRET`, `SESSION_SECRET`, `ENCRYPTION_SECRET`, dan kredensial R2 (dibutuhkan saat boot untuk inisialisasi S3 client).

Secret tidak pernah dikirim balik ke browser. Admin Web hanya menerima versi ter-mask (`••••••••ab12`).

---

## Setup MongoDB Atlas

1. Buat cluster gratis di [cloud.mongodb.com](https://cloud.mongodb.com).
2. **Database Access** → buat user dengan role `readWrite`.
3. **Network Access** → tambahkan `0.0.0.0/0` (Railway memakai IP dinamis).
4. **Connect** → **Drivers** → salin connection string, ganti `<password>` dan tambahkan nama database:
   `mongodb+srv://user:pass@cluster.mongodb.net/marketplace?retryWrites=true&w=majority`
5. Isi ke `MONGODB_URI`.

Index dibuat otomatis oleh Mongoose: `Product.slug`/`categoryId`/`status`, `Order.orderCode`/`status`/`paymentStatus`/`createdAt`, `Transaction.transactionId`/`externalPaymentId`/`status`, `Rating.status`, `Customer.email`/`whatsapp`, dan unique compound index pada `NotificationLog` untuk idempotensi notifikasi.

---

## Setup Cloudflare R2

1. Cloudflare Dashboard → **R2** → **Create bucket**.
2. **Settings** bucket → **Public access** → aktifkan r2.dev subdomain (atau pasang custom domain). Salin URL-nya ke `R2_PUBLIC_URL`.
3. **Manage R2 API Tokens** → **Create API token** dengan permission *Object Read & Write* pada bucket tersebut. Salin Access Key ID & Secret Access Key.
4. Account ID ada di sidebar kanan halaman R2.

Semua gambar (produk, logo, favicon, background, avatar review) diupload lewat backend ke R2; MongoDB hanya menyimpan URL + object key. Tidak ada binary image di database.

---

## Setup KlikQRIS

Dokumentasi resmi: <https://klikqris.com/dokumentasi-api>

1. Daftar merchant di KlikQRIS, ambil **API Key** dan **Merchant ID** dari dashboard.
2. Isi ke ENV, atau lebih baik lewat **Admin Web → Integrasi → KlikQRIS** (tersimpan terenkripsi).
3. Daftarkan webhook URL (lihat bagian [Webhook KlikQRIS](#webhook-klikqris)).
4. Klik **Test Connection** di Admin Web untuk memastikan kredensial diterima.

Endpoint yang dipakai backend:

| Method | Endpoint | Fungsi |
|---|---|---|
| `POST` | `/qris/create` | Membuat transaksi QRIS dinamis |
| `GET` | `/qris/status/{order_id}` | Cek status manual |
| `GET` | `/qris/history` | Dipakai untuk Test Connection (tanpa efek samping) |

Autentikasi: header `x-api-key` dan `id_merchant` di setiap request.

---

## Setup Fonnte

1. Daftar di [fonnte.com](https://fonnte.com), hubungkan device WhatsApp.
2. Salin **Token** device.
3. Isi lewat **Admin Web → Integrasi → Fonnte**, aktifkan toggle, lalu **Test WhatsApp** dengan nomor sendiri.

Nomor customer dinormalisasi ke format `62xxxxxxxxx` oleh `utils/phone.js` sebelum dikirim.

---

## Setup Resend

1. Daftar di [resend.com](https://resend.com).
2. **Domains** → tambahkan domain dan verifikasi record DNS-nya. Tanpa ini email akan ditolak.
3. **API Keys** → buat key dengan permission *Sending access*.
4. Isi lewat **Admin Web → Integrasi → Resend** (API key, From Email, From Name), lalu **Test Email**.

---

## Menjalankan

```bash
cd server

npm run dev     # development — nodemon, auto-restart, log morgan "dev"
npm run start   # production  — node server.js, log morgan "combined"
```

Buka:

- Marketplace: `http://localhost:4000/`
- Admin Web: `http://localhost:4000/admin`
- Health check: `http://localhost:4000/api/health`

Express men-serve frontend statis dari root project, jadi cukup satu proses untuk keduanya.

---

## Akun Admin Pertama

Isi `ADMIN_BOOTSTRAP_*` di `.env`, lalu:

```bash
cd server
npm run seed:admin
```

Script ini membuat satu akun dengan role `superadmin`. Kalau email tersebut sudah ada, script berhenti tanpa mengubah apa pun (aman dijalankan ulang).

Login di `/admin/login`, lalu **segera ganti password** lewat **Pengaturan → Akun Saya → Ubah Password**. Setelah itu kosongkan `ADMIN_BOOTSTRAP_PASSWORD` dari environment.

Superadmin bisa menambah akun admin lain di **Pengaturan → Admin**.

---

## Deploy ke Railway

1. **New Project** → **Deploy from GitHub repo**.
2. **Settings** → **Root Directory**: `server`. Railway akan mendeteksi Node dan menjalankan `npm install` lalu `npm run start`.
3. **Variables** → isi semua environment variable di atas.
   - `PORT` diisi Railway otomatis, jangan di-hardcode.
   - `NODE_ENV=production`.
4. **Settings** → **Networking** → **Generate Domain**. Salin domainnya.
5. Update variable yang butuh URL publik, lalu redeploy:
   ```
   CLIENT_URL=https://app.up.railway.app
   ADMIN_URL=https://app.up.railway.app
   SERVER_PUBLIC_URL=https://app.up.railway.app
   KLIKQRIS_WEBHOOK_URL=https://app.up.railway.app/api/payments/klikqris/webhook
   ```
6. Jalankan seed admin sekali lewat Railway shell: `npm run seed:admin`.
7. Cek `https://app.up.railway.app/api/health`.

Tidak boleh ada `localhost` di variable production. Socket.IO berjalan di HTTP server yang sama, jadi tidak butuh konfigurasi tambahan di Railway.

Kalau Railway restart, frontend otomatis reconnect (Socket.IO `reconnection: true`) dan melakukan sync ulang data pada event `connect`.

---

## Webhook KlikQRIS

```
POST https://<domain-publik>/api/payments/klikqris/webhook
```

URL persisnya ditampilkan juga di **Admin Web → Integrasi → KlikQRIS**.

Pengamanan dan perilaku:

- **Signature** dari payload dicocokkan dengan signature yang dikeluarkan saat `/qris/create`. Kalau beda → ditolak dan dicatat di log.
- **Idempoten**: kalau status transaksi sudah sama, callback diabaikan. Status `SUCCESS` tidak pernah bisa turun lagi. Jadi callback ganda tidak menggandakan pengurangan stok, penambahan sold, ataupun notifikasi.
- Selalu membalas **HTTP 200** supaya KlikQRIS berhenti retry, termasuk saat payload tidak dikenali.
- Setiap payload mentah disimpan di `Transaction.rawWebhookPayloads` untuk audit.

Sebagai cadangan kalau webhook telat, halaman pembayaran juga memanggil `GET /api/payments/:orderCode/refresh` yang melakukan verifikasi langsung ke KlikQRIS (`/qris/status/{order_id}`). Ini verifikasi nyata ke gateway, bukan pengganti realtime — update instan tetap datang lewat Socket.IO.

---

## Payment Flow

```
Customer pilih produk
   ↓  POST /api/orders  { productId, quantity, name, email, whatsapp }
Backend validasi email + normalisasi nomor WhatsApp
   ↓
Backend baca Product dari MongoDB → ambil price, name, stock, status
   ↓  (harga TIDAK PERNAH diterima dari frontend)
Validasi stok ≥ quantity, produk berstatus active
   ↓
Upsert Customer → buat Order (status PENDING) → emit order:created
   ↓
POST KlikQRIS /qris/create → simpan Transaction (qrisUrl, signature, expiredAt)
   ↓
Response ke customer: QR image + total yang harus dibayar
   ↓
Customer bayar
   ↓
KlikQRIS → webhook → validasi signature → cek idempotensi
   ↓
Transaction.status = SUCCESS, Order.status = PAID
   ↓
Product: $inc stock -qty, sold +qty  (atomic, dengan guard stock ≥ qty → tidak mungkin minus)
   ↓
emit stock:updated, order:updated, payment:updated
   ↓
Notifikasi WhatsApp (Fonnte) + Email (Resend)
```

Status yang dipakai:

| Order.status | Order.paymentStatus | Transaction.status |
|---|---|---|
| `PENDING` | `PENDING` | `PENDING` |
| `PAID` | `SUCCESS` | `SUCCESS` |
| `FAILED` | `FAILED` | `FAILED` |
| `EXPIRED` | `EXPIRED` | `EXPIRED` |
| `CANCELLED` | `CANCELLED` | `CANCELLED` |
| `COMPLETED` | `SUCCESS` | `SUCCESS` |

---

## Notification Flow

Database selalu diupdate **sebelum** notifikasi dikirim. Notifikasi yang gagal tidak pernah mengubah status pembayaran — source of truth tetap KlikQRIS + verifikasi backend + MongoDB.

| Event | WhatsApp | Email |
|---|---|---|
| `orderCreated` | ✅ | ✅ |
| `paymentPending` | ✅ | ✅ |
| `paymentSuccess` | ✅ | ✅ |
| `paymentFailed` | ✅ | ✅ |
| `paymentExpired` | ✅ | ✅ |
| `orderCompleted` | opsional | opsional |

**Anti-duplikat**: setiap pengiriman dicatat di collection `NotificationLog` dengan unique index `(orderId, channel, event)` untuk record berstatus `sent`. Webhook yang dikirim berkali-kali tidak akan menghasilkan WhatsApp/email ganda.

**Template** diatur dari **Admin Web → Integrasi → Template**, dirender di backend. Placeholder yang tersedia:

```
{{customer_name}}  {{order_code}}  {{product_name}}  {{quantity}}
{{total}}          {{payment_status}}                {{store_name}}
```

Branding (nama store, logo, kontak) diambil dari `WebsiteSettings`, bukan hardcoded.

---

## Socket.IO Events

Semua event di-emit **setelah** operasi database berhasil. Kalau DB gagal, tidak ada event sukses yang dikirim.

| Event | Payload | Konsumen |
|---|---|---|
| `website:settings:updated` | `{ section }` | Marketplace, Admin |
| `navbar:updated` | `{ section, data }` | Marketplace |
| `home:updated` | `{ section, data }` | Marketplace |
| `contact:updated` | `{ section, data }` | Marketplace |
| `statistics:updated` | `{}` | Marketplace, Admin |
| `products:updated` | `{ action, productId }` | Marketplace, Admin |
| `product:created` / `product:updated` / `product:deleted` | `{ product }` / `{ productId }` | Marketplace, Admin |
| `categories:updated` | `{ action, category }` | Marketplace, Admin |
| `stock:updated` | `{ productId, stock, sold }` | Marketplace, Admin |
| `faq:updated` | `{ action, faq }` | Marketplace, Admin |
| `rating:updated` | `{ action, rating }` | Marketplace, Admin |
| `order:created` | `{ orderId, orderCode }` | Admin |
| `order:updated` | `{ orderId, orderCode, status }` | Admin, Cek Pesanan |
| `payment:updated` | `{ orderCode, paymentStatus }` | Admin, Marketplace, Cek Pesanan |
| `integration:updated` | `{ provider }` | Admin |
| `notification:updated` | `{}` | Admin |

Di sisi client, listener dipasang **sekali** saat init (bukan setiap pindah halaman) supaya tidak ada duplikasi. Pada event `connect` (termasuk setelah reconnect), halaman yang sedang aktif melakukan fetch ulang agar state tetap konsisten.

---

## API Reference

`POST`/`PUT`/`PATCH`/`DELETE` bertanda 🔒 memerlukan header `Authorization: Bearer <jwt>`.

### Auth

| Method | Endpoint | Keterangan |
|---|---|---|
| `POST` | `/api/auth/login` | Login admin, rate-limited (20 percobaan / 15 menit) |
| `GET` | `/api/auth/me` 🔒 | Profil admin saat ini |
| `POST` | `/api/auth/change-password` 🔒 | Ganti password |

### Produk & Kategori

| Method | Endpoint | Keterangan |
|---|---|---|
| `GET` | `/api/products` | Produk aktif, filter `?category=<slug>` |
| `GET` | `/api/products/:slug` | Detail produk aktif |
| `GET` | `/api/products/admin/all` 🔒 | Semua produk |
| `POST` | `/api/products/admin` 🔒 | Buat produk (`multipart/form-data`, field file `image`) |
| `PUT` | `/api/products/admin/:id` 🔒 | Update produk (`multipart/form-data`) |
| `DELETE` | `/api/products/admin/:id` 🔒 | Hapus produk + objek R2-nya |
| `GET` | `/api/categories` | Kategori aktif |
| `GET` | `/api/categories/admin/all` 🔒 | Semua kategori |
| `POST` `PUT` `DELETE` | `/api/categories/admin[/:id]` 🔒 | CRUD kategori |

### Order, Payment, Customer

| Method | Endpoint | Keterangan |
|---|---|---|
| `POST` | `/api/orders` | Checkout (rate-limited). Hanya menerima `productId`, `quantity`, `name`, `email`, `whatsapp` |
| `GET` | `/api/orders/track/:orderCode` | Lacak order (publik) |
| `GET` | `/api/orders/admin/all` 🔒 | Filter `status`, `paymentStatus`, paginasi `page`/`limit` |
| `GET` | `/api/orders/admin/summary` 🔒 | Agregat dashboard: revenue, delta bulanan, seri 7 hari |
| `GET` | `/api/orders/admin/:id` 🔒 | Detail order + transaksi |
| `GET` | `/api/customers/admin/all` 🔒 | Filter `search`, paginasi |
| `GET` | `/api/customers/admin/:id` 🔒 | Detail customer + riwayat order |
| `POST` | `/api/payments/klikqris/webhook` | Callback KlikQRIS (publik, signature divalidasi) |
| `GET` | `/api/payments/:orderCode/refresh` | Verifikasi status langsung ke KlikQRIS |

### Konten

| Method | Endpoint | Keterangan |
|---|---|---|
| `GET` | `/api/settings` | Semua WebsiteSettings (publik) |
| `GET` | `/api/settings/admin` 🔒 | Sama, untuk form admin |
| `PATCH` | `/api/settings/admin/:section` 🔒 | Section: `general`, `navbar`, `home`, `statistics`, `highlights`, `contact`, `footer`, `background`, `theme`, `typography` |
| `POST` | `/api/settings/admin/upload` 🔒 | Upload aset ke R2 (`file`, `folder`) |
| `GET` | `/api/faq` · `/api/faq/admin/all` 🔒 | FAQ |
| `POST` `PUT` `DELETE` | `/api/faq/admin[/:id]` 🔒 | CRUD FAQ |
| `GET` | `/api/ratings` | Review approved |
| `POST` | `/api/ratings` | Submit review (masuk antrian `pending`) |
| `GET` | `/api/ratings/admin/all?status=` 🔒 | Moderasi |
| `PATCH` | `/api/ratings/admin/:id/status` 🔒 | `pending` / `approved` / `hidden` |
| `DELETE` | `/api/ratings/admin/:id` 🔒 | Hapus review |
| `GET` | `/api/contact` · `/api/statistics` · `/api/health` | Publik |

### Integrasi

| Method | Endpoint | Keterangan |
|---|---|---|
| `GET` | `/api/integrations/status` 🔒 | Status per provider (kredensial ter-mask) |
| `PUT` | `/api/integrations/klikqris` · `/fonnte` · `/resend` 🔒 | Update kredensial (dienkripsi) |
| `POST` | `/api/integrations/{klikqris,fonnte,resend,r2}/test` 🔒 | Test dari backend |
| `PUT` | `/api/integrations/notifications` 🔒 | Toggle channel & event |
| `GET` `PUT` | `/api/integrations/templates` 🔒 | Template WhatsApp & email |
| `GET` `POST` | `/api/admins` 🔒 superadmin | Kelola akun admin |
| `PATCH` | `/api/admins/:id/active` 🔒 superadmin | Aktif/nonaktif |

---

## Admin Web

`/admin` — token JWT disimpan di `sessionStorage` (hilang saat tab ditutup, tidak ikut terkirim otomatis seperti cookie sehingga aman dari CSRF). Kalau token tidak ada atau `GET /api/auth/me` gagal, browser langsung diarahkan ke `/admin/login`.

| Halaman | Isi |
|---|---|
| **Dashboard** | Total penjualan, jumlah order, buyer, rating — semua hasil agregasi MongoDB. Mini chart = pendapatan 7 hari terakhir yang sebenarnya. Delta "vs bulan lalu" dihitung dari data, bukan angka tetap |
| **Pesanan** | Tabel order dengan filter order status & payment status, paginasi, pencarian, detail order + transaksi. Update realtime |
| **Produk** | Grid produk, CRUD penuh, upload gambar ke R2 lewat `multipart/form-data` |
| **Kategori** | CRUD kategori. Kategori yang masih dipakai produk tidak bisa dihapus |
| **Customer** | Daftar customer dengan jumlah order, order PAID, dan total belanja dari agregasi order |
| **Konten Marketplace** | 10 tab sesuai section `WebsiteSettings`, masing-masing disimpan lewat `PATCH /api/settings/admin/:section` |
| **FAQ** | CRUD, urutan, enable/disable |
| **Rating** | Moderasi approve/hide/delete, distribusi bintang dari data asli |
| **Integrasi** | Status dot per provider, update kredensial (ter-mask), test connection, toggle notifikasi, editor template |
| **Pengaturan** | Profil, ganti password, kelola akun admin (superadmin), health check server |

Badge "Pesanan" menampilkan jumlah pembayaran yang masih `PENDING` dan ikut berubah realtime saat ada order baru atau pembayaran masuk.

---

## Marketplace

| Halaman | Sumber data |
|---|---|
| `/` | `GET /api/settings`, `/api/categories`, `/api/products`, `/api/faq`, `/api/statistics` — dirender paralel, lalu diperbarui lewat Socket.IO |
| `/product.html?slug=...` | `GET /api/products/:slug`. Quantity dibatasi stok asli; checkout mengirim `productId` + `quantity` + data customer saja |
| `/cek-pesanan/` | `GET /api/orders/track/:orderCode`, mendukung deep link `?order=KODE`, auto-update via Socket.IO |
| `/rating/` | `GET /api/ratings` + `POST /api/ratings` |

Halaman pembayaran menampilkan QR dari KlikQRIS dan memperbarui status secara otomatis sampai `PAID`/`FAILED`/`EXPIRED` — tanpa refresh dan tanpa delay palsu.

---

## Checklist Testing End-to-End

1. `npm run seed:admin` → login di `/admin/login`.
2. Buat kategori → buka Marketplace di tab lain → kategori muncul tanpa refresh.
3. Buat produk + upload gambar → cek URL gambar mengarah ke domain R2 → produk muncul realtime di Marketplace.
4. Ubah harga produk di Admin → harga berubah realtime di Marketplace.
5. Checkout dari Marketplace (isi nama, email, WhatsApp) → order muncul di Admin tanpa refresh.
6. Bayar QRIS → webhook masuk → Admin menampilkan `PAID` tanpa refresh, Marketplace menampilkan stok baru.
7. Cek stok berkurang dan sold bertambah sesuai quantity.
8. Cek WhatsApp dan email masuk.
9. Kirim ulang webhook yang sama → pastikan stok, sold, dan notifikasi **tidak** bertambah lagi.
10. Buka `/cek-pesanan/?order=KODE` → status terbaru tampil dan ikut berubah realtime.
11. Restart server → frontend reconnect otomatis dan data tetap konsisten.

---

## Troubleshooting

| Gejala | Penyebab & solusi |
|---|---|
| `ENCRYPTION_SECRET is not set` | Isi `ENCRYPTION_SECRET` di environment, lalu restart |
| Kredensial integrasi tiba-tiba tidak valid | `ENCRYPTION_SECRET` berubah. Isi ulang kredensial dari Admin Web |
| `KlikQRIS belum diaktifkan/dikonfigurasi` saat checkout | Toggle *Aktifkan KlikQRIS* di Admin belum menyala, atau API key/Merchant ID kosong |
| Upload gambar gagal | R2 belum dikonfigurasi. Cek `/api/health` dan tombol **Test Storage** |
| Gambar terupload tapi tidak tampil | `R2_PUBLIC_URL` salah atau public access bucket belum aktif |
| Webhook tidak pernah masuk | `KLIKQRIS_WEBHOOK_URL` masih localhost, atau belum didaftarkan di dashboard KlikQRIS |
| Status pembayaran tidak berubah | Cek log `signature mismatch`; pastikan callback datang dari merchant yang benar |
| Email tidak terkirim | Domain pengirim belum diverifikasi di Resend |
| Admin Web terus balik ke login | `JWT_SECRET` berubah setelah redeploy sehingga token lama invalid. Login ulang |
| Realtime pill "offline" | Socket.IO terblokir. Pastikan origin ada di `CLIENT_URL`/`ADMIN_URL`/`EXTRA_CORS_ORIGINS` |
| Error CORS | Origin frontend belum masuk whitelist |

Log server mencatat start-up, koneksi MongoDB, upload R2, pembuatan dan verifikasi pembayaran, order dibuat/dibayar, perubahan stok, pengiriman Fonnte/Resend, koneksi socket, dan error. Password, token, API key, dan kredensial tidak pernah ikut ter-log.
