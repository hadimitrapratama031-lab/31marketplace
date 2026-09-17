# Floating Order Success & Live Chat

Dokumen ini menjelaskan apa yang ditambahkan, di file mana, dan bagaimana cara
mengetesnya. Semua fitur memakai infrastruktur yang sudah ada — tidak ada
service, koneksi realtime, atau storage baru.

---

## 1. Floating Order Success (kiri bawah)

### Alur

```
customer bayar
  -> webhook KlikQRIS (atau sweeper kedaluwarsa / refresh manual)
  -> applyPaymentStatus() menyimpan Order.paymentStatus = SUCCESS
  -> emit "order:success:public"
  -> assets/js/widgets.js menampilkan kartu
```

Titik emit-nya **satu**, di dalam `applyPaymentStatus()` setelah `order.save()`.
Karena penjaga idempotency yang sudah ada di fungsi itu keluar lebih awal saat
status tidak berubah, webhook yang dikirim ulang KlikQRIS tidak pernah
memunculkan kartu kedua.

Status selain SUCCESS tidak punya event ini sama sekali, jadi tidak ada yang
perlu disaring di browser: PENDING / FAILED / EXPIRED / CANCELLED memang tidak
akan pernah muncul.

### Data yang disiarkan

`server/services/orderFeed.service.js` memangkas order sebelum keluar:

| Field | Perlakuan |
|---|---|
| email, WhatsApp, customerId | **dibuang** |
| `orderCode` | **dibuang** |
| nama pembeli | disamarkan: `Hadi Saputra` → `Hadi S.` |
| nama produk, gambar, slug | apa adanya |
| `total` | harga transaksi asli dari order, bukan harga katalog hari ini |

`orderCode` sengaja tidak ikut karena `GET /api/orders/track/:orderCode` adalah
endpoint publik: menyiarkan kode order ke semua pengunjung sama dengan
membocorkan detail pesanan orang lain. Untuk dedupe di browser dipakai `id`
hasil HMAC-SHA256 yang stabil tapi tidak bisa dibalik.

### Perilaku

- Antrean maksimal 3, satu kartu tampil pada satu waktu, jeda 2,6 detik antar kartu.
- Auto-hide 6,5 detik; hitungan mundurnya berhenti saat kursor menyentuh kartu.
- Muat pertama mengambil satu order sukses terbaru dari `GET /api/orders/recent-success`.
  Kartunya menulis waktu relatif ("2 jam lalu"), jadi order lama tidak menyamar
  sebagai pembelian yang baru terjadi.
- Mobile: lebar disisakan untuk tombol chat, dan kartu disembunyikan saat panel
  chat terbuka penuh layar.

---

## 2. Live Chat (kanan bawah)

### Identitas — anonim

Percakapan tidak ditautkan ke akun mana pun. Kuncinya `sessionId` acak yang
dibuat **server** (`crypto.randomBytes`) dan dikembalikan sebagai JWT bertanda
`typ: "chat"`.

ID-nya dibuat server, bukan browser, karena ID ini satu-satunya kunci ke isi
percakapan. Kalau browser yang mengarangnya, siapa pun bisa mengirim ObjectId
orang lain dan membaca thread orang itu. Nama panggilan dan email opsional
murni catatan tampilan untuk admin — tidak pernah menentukan hak akses.

### Realtime

Socket.IO yang sama, tapi memakai **room**, bukan `io.emit`:

- `chat:<conversationId>` — hanya pemilik thread
- `admin` — semua admin yang login

Masuk room harus lewat `chat:auth` / `admin:auth` dengan token bertanda tangan.
Kalau chat memakai siaran global, isi percakapan pelanggan akan sampai ke
browser setiap pengunjung Marketplace.

Klien mengirim ulang token setiap event `connect`, jadi keanggotaan room pulih
sendiri setelah reconnect — dan setelah reconnect isi thread dimuat ulang dari
database, bukan dari sisa state di memori.

### Anti-duplikat

- Setiap pesan membawa `clientMessageId`.
- Index unik parsial `{conversationId, clientMessageId}` di MongoDB menolak
  kiriman ganda di level database, bukan sekadar di memori (yang akan bocor
  begitu ada dua instance server).
- Browser menyimpan `Set` id yang sudah dirender, jadi gema Socket.IO untuk
  pesan yang baru saja dikirim tidak menghasilkan gelembung kedua.
- Satu pesan hanya pernah memicu satu DM Discord (`message.discord.attempts`).

### Kedaluwarsa 24 jam

`expiresAt = createdAt + 24 jam`, dihitung **per pesan**. Dua lapis:

1. TTL index MongoDB (`expireAfterSeconds: 0`) menghapus dokumennya.
2. Setiap query baca memfilter `expiresAt: { $gt: now }`, jadi pesan yang sudah
   lewat 24 jam tidak pernah tampil walau penghapusan fisiknya baru terjadi
   semenit kemudian.

Thread ikut membawa `expiresAt` yang selalu disetel ulang ke expiry pesan
terbaru, sehingga pesan lama yang kedaluwarsa tidak menyeret pesan baru.

Contoh: pesan 17 Sep 13:00 WIB → hilang 18 Sep 13:00 WIB.

### Foto

```
Marketplace -> POST /api/chat/messages/photo -> R2 -> ChatMessage -> Socket.IO
```

Validasi berlapis di `server/middlewares/chatUpload.js`:

- MIME hanya JPG / PNG / WEBP / GIF (**SVG ditolak** — SVG adalah XML yang bisa
  memuat `<script>`, dan file itu akan dieksekusi di domain toko kalau dibuka
  langsung)
- ekstensi file
- ukuran maksimal 5MB
- **magic byte**: Content-Type dan nama file sama-sama berasal dari klien, jadi
  keduanya bisa dipalsukan. Byte pertama file diperiksa; HTML yang di-rename
  jadi `.png` ditolak sebelum menyentuh R2.
- URL hasil upload wajib HTTPS

Kredensial R2 tidak pernah keluar dari server.

### XSS

Pesan disimpan sebagai teks biasa dan **tidak pernah** dirender lewat
`innerHTML`. Marketplace dan Admin Web sama-sama memakai `textContent` untuk
isi pesan, jadi tag yang diketik pengirim tampil apa adanya sebagai teks.

---

## 3. Notifikasi

### Admin Web

- Badge unread di sidebar + pip per percakapan.
- Suara: nada pendek dari WebAudio (bukan file audio, jadi tidak ada aset biner
  baru). Berbunyi **hanya** saat pesan customer benar-benar masuk — tidak
  pernah saat render halaman. Jarak minimal 2 detik antar bunyi, tidak ada loop.
  Konteks audio dibuka pada interaksi pertama sesuai kebijakan autoplay browser.

### Discord DM

```
simpan pesan -> Socket.IO ke Admin Web -> baru coba DM Discord
```

Urutan ini tidak bisa dibalik: kalau DM gagal, pesan tetap tersimpan dan tetap
sampai ke Admin Web. Tidak ada rollback, dan error internal tidak pernah
dikirim ke customer — hanya dicatat dan ditampilkan di Admin Web sebagai
"DM Discord gagal" di bawah gelembung pesannya.

Retry maksimal **3 kali**, hanya untuk kegagalan sementara (timeout, 5xx, rate
limit). Kesalahan permanen (ID salah, DM ditutup, token tidak valid) berhenti
di percobaan pertama.

**DM wajib mode bot.** Discord tidak bisa mengirim DM lewat webhook channel.
Selain `DISCORD_BOT_TOKEN`, admin juga harus satu server dengan bot dan
mengizinkan direct message dari anggota server.

### Konfigurasi (Admin Web > Integrasi > Live Chat)

- Enable / disable
- Discord User ID admin (bukan rahasia, jadi boleh jadi konfigurasi aplikasi)
- Status bot
- Test DM

Token bot tetap di Railway ENV. `DISCORD_ADMIN_USER_ID` di ENV dipakai sebagai
nilai awal kalau admin belum pernah mengisi formulirnya.

---

## 4. Endpoint baru

| Method | Path | Akses |
|---|---|---|
| GET | `/api/orders/recent-success` | publik (sudah disamarkan) |
| POST | `/api/chat/session` | publik, 10/jam |
| GET | `/api/chat/session` | token chat |
| POST | `/api/chat/messages` | token chat, 30/menit |
| POST | `/api/chat/messages/photo` | token chat, 15/10 menit |
| POST | `/api/chat/read` | token chat |
| GET | `/api/chat/admin/conversations` | admin |
| GET | `/api/chat/admin/unread` | admin |
| GET | `/api/chat/admin/conversations/:id/messages` | admin |
| POST | `/api/chat/admin/conversations/:id/messages` | admin |
| POST | `/api/chat/admin/conversations/:id/messages/photo` | admin |
| POST | `/api/chat/admin/conversations/:id/read` | admin |
| GET/PUT | `/api/integrations/livechat` | admin |
| POST | `/api/integrations/livechat/test` | admin |

Tidak ada endpoint pelanggan yang menerima `conversationId` dari body atau
query — selalu dibaca dari isi token.

Batas per-IP di atas dilengkapi batas **per percakapan** (20 pesan/menit) di
controller, supaya satu sesi tidak bisa membanjiri admin dari banyak IP.

---

## 5. Event Socket.IO baru

| Event | Tujuan |
|---|---|
| `order:success:public` | global — floating order (payload sudah disamarkan) |
| `chat:message` | room thread + room admin |
| `chat:conversation` | room admin |
| `chat:read` | pihak lawan |
| `chat:discord` | room admin — status DM |

Event lama tidak diubah.

---

## 6. File

**Baru**

```
server/models/ChatConversation.js
server/models/ChatMessage.js
server/services/chat.service.js
server/services/orderFeed.service.js
server/controllers/chat.controller.js
server/routes/chat.routes.js
server/middlewares/chatUpload.js
assets/css/widgets.css
assets/js/widgets.js
```

**Diubah**

```
server/services/socket.service.js     room + verifikasi token
server/services/discord.service.js    DM (sendDirectMessage, sendLiveChatDM)
server/controllers/payment.controller.js   emit order:success:public
server/controllers/order.controller.js     GET /orders/recent-success
server/controllers/integration.controller.js  konfigurasi Live Chat
server/models/IntegrationSettings.js  blok liveChat
server/middlewares/rateLimit.js       3 limiter chat
server/routes/{index,order,integration}.routes.js
server/.env.example                   DISCORD_ADMIN_USER_ID
admin/{index.html,admin.js,admin.css} halaman Live Chat + tab integrasi
index / products / product / checkout / payment / order-success / rating / cek-pesanan
```

Checkout, payment, order, autentikasi, dan notifikasi existing tidak disentuh
logikanya.

---

## 7. Verifikasi end-to-end

### Floating order

1. Buat order asli sampai halaman pembayaran.
2. Bayar sampai webhook SUCCESS masuk.
3. Kartu muncul di kiri bawah tanpa refresh.
4. Cocokkan nama (tersamar), nama produk, dan harga dengan dokumen Order.
5. Buat order lalu biarkan expired — pastikan **tidak** muncul kartu.
6. Kirim ulang webhook yang sama — pastikan kartunya tidak dobel.
7. Buat beberapa order berurutan — pastikan mengantre, bukan menumpuk.

### Live Chat

1. Buka chat, isi nama, kirim teks.
2. Admin Web menerima realtime, badge bertambah, suara berbunyi sekali.
3. Cek DM Discord masuk (butuh bot + ID admin terisi).
4. Balas dari Admin Web — customer menerima tanpa refresh.
5. Kirim emoji dan foto dari kedua sisi.
6. Matikan jaringan sebentar lalu sambungkan lagi: pesan tidak hilang dan tidak dobel.
7. Coba kirim file non-gambar yang di-rename `.png` — harus ditolak.
8. Buka `GET /api/chat/session` tanpa token atau dengan token orang lain — harus 401.
9. Set `expiresAt` sebuah pesan ke masa lalu — pesan itu harus hilang dari
   Marketplace dan Admin Web, sementara pesan baru di thread yang sama tetap ada.
10. Tes di layar mobile.
