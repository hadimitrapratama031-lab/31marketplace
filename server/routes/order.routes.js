const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/order.controller");
const { requireAdminAuth } = require("../middlewares/auth");
const { checkoutLimiter } = require("../middlewares/rateLimit");

router.post("/", checkoutLimiter, ctrl.createOrder);
router.get("/track/:orderCode", ctrl.getByOrderCode);
router.get("/admin/all", requireAdminAuth, ctrl.listAdmin);
router.get("/admin/summary", requireAdminAuth, ctrl.summaryAdmin);
router.get("/admin/:id", requireAdminAuth, ctrl.getAdminById);

module.exports = router;
