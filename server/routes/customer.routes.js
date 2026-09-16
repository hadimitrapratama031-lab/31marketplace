const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/customer.controller");
const { requireAdminAuth } = require("../middlewares/auth");

router.get("/admin/all", requireAdminAuth, ctrl.listAdmin);
router.get("/admin/:id", requireAdminAuth, ctrl.getAdminById);

module.exports = router;
