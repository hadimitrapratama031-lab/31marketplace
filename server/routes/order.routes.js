const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/order.controller");
const { requireAdminAuth } = require("../middlewares/auth");
const { checkoutLimiter, lookupLimiter } = require("../middlewares/rateLimit");

router.post("/", checkoutLimiter, ctrl.createOrder);
router.get("/track/:orderCode", ctrl.getByOrderCode);

// Cek Pesanan lewat email. POST supaya alamat email tidak masuk access log /
// riwayat browser, dan dibatasi rate-nya karena endpoint ini bisa dipakai
// untuk menebak apakah sebuah alamat pernah berbelanja di sini.
router.post("/lookup", lookupLimiter, ctrl.lookupByEmail);
router.post("/detail", lookupLimiter, ctrl.getPublicDetail);
router.get("/admin/all", requireAdminAuth, ctrl.listAdmin);
router.get("/admin/summary", requireAdminAuth, ctrl.summaryAdmin);
router.get("/admin/:id", requireAdminAuth, ctrl.getAdminById);

module.exports = router;
