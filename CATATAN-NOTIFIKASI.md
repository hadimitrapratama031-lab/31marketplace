# Perbaikan sistem notifikasi order & payment

Tidak ada service, model, atau kanal realtime baru. Semua perubahan memperbaiki
dan memperluas yang sudah ada: `notification.service.js`, `template.service.js`,
`fonnte.service.js`, `resend.service.js`, `NotificationLog`, dan Socket.IO existing.

---

## Langkah deploy (urutannya penting)

1. **Rotasi semua kredensial.** File `server/.env` ikut ter-commit di arsip yang
   dikirim, lengkap dengan MongoDB URI, JWT secret, session secret, encryption
   secret, Fonnte token, Resend API key, dan KlikQRIS API key. Semuanya harus
   dianggap bocor. `.gitignore` sudah benar, jadi ini kemungkinan file yang
   tidak sengaja ikut ter-zip — tetapi rotasinya tetap wajib.

2. **Lengkapi variabel R2 di Railway.** `.env` tersebut tidak memuat satu pun
   `R2_*`. `isR2Configured()` mensyaratkan kelimanya
   (`R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`,
   `R2_BUCKET_NAME`, `R2_PUBLIC_URL`), dan tanpa itu setiap upload logo gagal
   503. Kalau logo kontak tidak pernah muncul di Marketplace, periksa ini lebih
   dulu sebelum menyalahkan frontend.

3. **Jalankan migrasi database:**

   ```bash
   npm --prefix server run migrate:notiflog
   npm --prefix server run migrate:contact   # hanya jika belum pernah dijalankan
   ```

   `migrate:notiflog` menghapus index unik parsial lama pada
   `notificationlogs`, mengisi field baru pada baris historis, dan mereset baris
   yang menggantung di status `sending`. Index baru dibuat otomatis saat server
   start.

4. **Deploy, lalu verifikasi lewat Admin Web** → Integrasi → Notifikasi →
   Riwayat pengiriman. Tabel itu adalah hasil nyata dari provider, bukan asumsi.

---

## Yang berubah dan alasannya

### Idempotency: claim sebelum kirim

Alur lama `alreadySent()` → kirim → `markSent()` adalah tiga langkah terpisah.
Webhook kedua yang masuk di antara langkah 1 dan 3 lolos pengecekan, dan
WhatsApp benar-benar terkirim dua kali; unique index baru menolak di langkah 3,
setelah pesan sudah keluar.

Sekarang slot `(orderId, event, channel)` di-**claim** dengan satu operasi
atomic sebelum provider disentuh. Claim kedua ditolak database, bukan oleh
pengecekan di memori.

Karena kuncinya per-channel, WhatsApp yang gagal bisa di-retry sendiri tanpa
mengirim ulang Email yang sudah sukses.

### Status per channel, dan kegagalan yang tercatat

`markSent()` lama hanya dipanggil kalau pengiriman sukses. Kegagalan tidak
menulis apa pun — tidak ada status, error, maupun respons provider. Itulah
sebabnya "kadang tidak terkirim" terasa acak: sistem memang tidak punya
jejaknya.

`NotificationLog` sekarang menyimpan `status` (`pending`/`sending`/`sent`/
`failed`), `recipient`, `attempts`, `error`, `providerResponse`, `sentAt`,
`failedAt`, dan `permanentFailure`.

### Retry terbatas, dengan pembedaan jenis error

Tiga percobaan, backoff 2 detik lalu 6 detik, kemudian berhenti. Error
sementara (timeout, error jaringan, HTTP 5xx, 429) diulang. Error permanen
(token ditolak, nomor/email tidak valid, domain pengirim belum diverifikasi)
tidak diulang sama sekali — mengulangnya hanya menghasilkan kegagalan yang
persis sama.

### Respons provider benar-benar diperiksa

Fonnte bisa membalas HTTP 200 dengan `status: true` tanpa id pesan — artinya
pesan tidak masuk antrean. Resend bisa membalas 200 tanpa id. Keduanya kini
dihitung sebagai gagal, bukan sukses.

### Notifikasi tidak lagi menahan respons webhook

Dua panggilan provider (masing-masing sampai 20 detik, ditambah retry) dulu
di-`await` di dalam handler webhook KlikQRIS. Gateway menganggap webhook gagal
lalu mengirimnya ulang — justru memperbanyak duplikat yang ingin dihindari.
Sekarang status pembayaran disimpan lebih dulu, lalu notifikasi diantre;
jaminan terkirimnya ada di `NotificationLog`, bukan di lamanya request
digantung.

### PAYMENT_EXPIRED yang sebelumnya hampir tidak pernah terkirim

Satu-satunya pemicunya dulu adalah webhook EXPIRED dari KlikQRIS atau pembeli
yang kebetulan membuka ulang halaman pembayaran. Pembeli yang menutup tab
setelah checkout — kasus paling umum — tidak menerima apa pun.

Ditambahkan sweeper yang berjalan tiap 5 menit dan menutup transaksi `PENDING`
yang sudah lewat `expiredAt`. Sweeper ini memanggil `applyPaymentStatus()` yang
sama, jadi status, Socket.IO, dan idempotency-nya identik dengan jalur webhook.

### Template WhatsApp dan Email

Dibangun di `template.service.js`, satu tabel copy untuk kedua channel supaya
kata-katanya tidak pernah berbeda. Template custom yang sudah ditulis admin di
Admin Web tetap menang; builder bawaan hanya dipakai kalau field-nya kosong.

Logo toko, gambar produk, nomor WhatsApp admin, dan tautan Discord semuanya
dibaca dari `WebsiteSettings` — tidak ada yang di-hardcode. URL yang tidak
bisa dimuat email client (http polos, `blob:`, path relatif, `localhost`)
dibuang otomatis, dan email tetap rapi tanpa gambar.

WhatsApp dan Discord memakai logo masing-masing; kalau admin belum mengunggah
salah satunya, tombol itu jatuh ke lettermark, bukan ke logo channel lain.

Alasan kegagalan pembayaran tidak pernah dikarang — kalau provider tidak
memberikannya, email dan WhatsApp hanya menyebut pembayarannya tidak berhasil.

### Contact settings

- Saklar aktif/nonaktif terpisah untuk WhatsApp dan Discord
  (`contact.whatsapp.enabled`, `contact.discord.enabled`). Dokumen lama yang
  belum punya field ini tetap tampil.
- `waHref()` di `assets/js/common.js` dulu membuang semua karakter non-digit,
  sehingga URL `https://wa.me/628…` berubah jadi deretan angka acak dan
  menghasilkan tautan rusak. Sekarang URL lengkap diterima apa adanya, nomor
  polos tetap dinormalisasi, dan `08xx` diubah ke `628xx`.
- Menghapus logo kontak kini mengembalikan badge teks lewat Socket.IO. Dulu
  gambar lama bertahan sampai halaman di-reload manual.

### Admin Web

Tab Integrasi → Notifikasi kini punya tabel **Riwayat pengiriman**: order code,
kejadian, channel, tujuan, status, jumlah percobaan, waktu, dan keterangan
error. Bisa difilter, dan baris yang gagal punya tombol kirim ulang yang hanya
menyentuh channel itu.

Tabel ikut hidup lewat `notification:log` di Socket.IO existing, dan kegagalan
memunculkan notifikasi di lonceng Admin Web.

---

## Yang belum diverifikasi

Perubahan ini di-review dan diuji di level sumber: seluruh file lolos
`node --check`, keempat template dirender dengan data contoh, HTML email
divalidasi well-formed, dan referensi ID/ikon antara `admin.js` dan
`admin/index.html` dicocokkan.

Yang **belum** dijalankan: test end-to-end dengan MongoDB, Fonnte, Resend, dan
KlikQRIS sungguhan. Setelah deploy, jalankan sendiri skenario berikut dan
periksa hasilnya di tabel Riwayat pengiriman:

| Skenario | Yang diharapkan |
|---|---|
| Checkout baru | Dua baris `orderCreated` berstatus `sent` |
| Bayar sampai selesai | Dua baris `paymentSuccess` berstatus `sent` |
| Kirim ulang webhook yang sama | Tidak ada baris baru, tidak ada pesan kedua |
| Biarkan order lewat batas waktu | `paymentExpired` muncul dalam 5 menit tanpa membuka halaman apa pun |
| Order dengan email sengaja salah | Email `failed` permanen, WhatsApp tetap `sent` |
| Matikan token Fonnte lalu checkout | WhatsApp `failed` dengan keterangan dari provider, Email tetap `sent` |
| Ganti logo kontak di Admin Web | Marketplace berubah tanpa reload |
