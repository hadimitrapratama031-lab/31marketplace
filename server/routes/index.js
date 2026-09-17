const express = require("express");
const router = express.Router();

router.use("/health", require("./health.routes"));
router.use("/auth", require("./auth.routes"));
router.use("/categories", require("./category.routes"));
router.use("/products", require("./product.routes"));
router.use("/orders", require("./order.routes"));
router.use("/customers", require("./customer.routes"));
router.use("/payments", require("./payment.routes"));
router.use("/settings", require("./settings.routes"));
router.use("/faq", require("./faq.routes"));
router.use("/ratings", require("./rating.routes"));
router.use("/statistics", require("./statistics.routes"));
router.use("/integrations", require("./integration.routes"));
router.use("/admins", require("./admin.routes"));
router.use("/webhooks", require("./webhook.routes"));
router.use("/assets", require("./asset.routes"));
router.use("/chat", require("./chat.routes"));

module.exports = router;
