const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/payment.controller");

// Webhook must be public (KlikQRIS calls it), signature is validated inside.
router.post("/klikqris/webhook", ctrl.klikqrisWebhook);
router.get("/:orderCode/refresh", ctrl.refreshStatus);

module.exports = router;
