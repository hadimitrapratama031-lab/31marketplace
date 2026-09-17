const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/webhook.controller");

// Publik (Resend yang memanggil) — keasliannya diverifikasi di dalam lewat
// signature Svix, bukan lewat auth admin. Sama seperti pola webhook KlikQRIS
// di routes/payment.routes.js.
router.post("/resend", ctrl.resendWebhook);

module.exports = router;
