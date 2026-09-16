const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/auth.controller");
const { requireAdminAuth } = require("../middlewares/auth");
const { authLimiter } = require("../middlewares/rateLimit");

router.post("/login", authLimiter, ctrl.login);
router.get("/me", requireAdminAuth, ctrl.me);
router.post("/change-password", requireAdminAuth, ctrl.changePassword);

module.exports = router;
