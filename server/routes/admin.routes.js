const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/admin.controller");
const { requireAdminAuth, requireRole } = require("../middlewares/auth");

router.use(requireAdminAuth, requireRole("superadmin"));

router.get("/", ctrl.list);
router.post("/", ctrl.create);
router.patch("/:id/active", ctrl.updateActive);

module.exports = router;
