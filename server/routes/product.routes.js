const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/product.controller");
const { requireAdminAuth } = require("../middlewares/auth");
const upload = require("../middlewares/upload");

router.get("/", ctrl.listPublic);
router.get("/:slug", ctrl.getPublicBySlug);
router.get("/admin/all", requireAdminAuth, ctrl.listAdmin);
router.post("/admin", requireAdminAuth, upload.single("image"), ctrl.create);
router.put("/admin/:id", requireAdminAuth, upload.single("image"), ctrl.update);
router.delete("/admin/:id", requireAdminAuth, ctrl.remove);

module.exports = router;
