const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/order.controller");
const profitCtrl = require("../controllers/profit.controller");
const { requireAdminAuth } = require("../middlewares/auth");
const { checkoutLimiter, lookupLimiter } = require("../middlewares/rateLimit");

router.post("/", checkoutLimiter, ctrl.createOrder);
router.get("/track/:orderCode", lookupLimiter, ctrl.getByOrderCode);

// Cek Pesanan. POST supaya alamat email tidak masuk access log / riwayat
// browser, dan dibatasi rate-nya karena endpoint ini bisa dipakai untuk
// menebak apakah sebuah alamat pernah berbelanja di sini.
//
// /search adalah pintu yang dipakai halaman Cek Pesanan sekarang: satu kolom,
// menerima Order ID maupun email. /lookup dan /detail dipertahankan apa adanya
// supaya tautan/integrasi lama tidak putus.
router.post("/search", lookupLimiter, ctrl.searchOrders);
router.post("/lookup", lookupLimiter, ctrl.lookupByEmail);
router.post("/detail", lookupLimiter, ctrl.getPublicDetail);

// Muat pertama Floating Order Success. Payload-nya sudah disamarkan (lihat
// services/orderFeed.service.js), jadi endpoint ini tidak membocorkan apa pun
// yang tidak boleh dilihat pengunjung lain.
router.get("/recent-success", ctrl.recentSuccess);

/* ------------------------------------------------------------------ admin */
// URUTAN PENTING: semua path admin yang literal ("all", "summary", "profit",
// "reset") harus berada DI ATAS "/admin/:id". Kalau tidak, Express mencocokkan
// "reset" sebagai :id dan request penghapusan berakhir di handler detail.
router.get("/admin/all", requireAdminAuth, ctrl.listAdmin);
router.get("/admin/summary", requireAdminAuth, ctrl.summaryAdmin);
router.get("/admin/profit", requireAdminAuth, profitCtrl.monthlyProfit);
router.delete("/admin/reset", requireAdminAuth, ctrl.resetAllAdmin);
router.get("/admin/:id", requireAdminAuth, ctrl.getAdminById);
router.delete("/admin/:id", requireAdminAuth, ctrl.deleteAdmin);

module.exports = router;
