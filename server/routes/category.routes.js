const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/category.controller");
const { requireAdminAuth } = require("../middlewares/auth");

router.get("/", ctrl.listPublic);
router.get("/admin/all", requireAdminAuth, ctrl.listAdmin);
router.post("/admin", requireAdminAuth, ctrl.create);
router.put("/admin/:id", requireAdminAuth, ctrl.update);
router.delete("/admin/:id", requireAdminAuth, ctrl.remove);

module.exports = router;
