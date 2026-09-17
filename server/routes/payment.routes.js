const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/payment.controller");
const { requireAdminAuth } = require("../middlewares/auth");

// Webhook must be public (KlikQRIS calls it), signature is validated inside.
router.post("/klikqris/webhook", ctrl.klikqrisWebhook);

/* ------------------------------------------------------------------ admin */
// "reset" harus didaftarkan sebelum "/admin/:id", kalau tidak Express
// membacanya sebagai sebuah id.
router.delete("/admin/reset", requireAdminAuth, ctrl.resetPaymentsAdmin);
router.delete("/admin/:id", requireAdminAuth, ctrl.deletePaymentAdmin);

// Dibiarkan paling bawah: pola "/:orderCode/refresh" akan menelan "/admin/..."
// kalau didaftarkan lebih dulu.
router.get("/:orderCode/refresh", ctrl.refreshStatus);

module.exports = router;
