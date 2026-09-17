const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/product.controller");
const { requireAdminAuth } = require("../middlewares/auth");
const upload = require("../middlewares/upload");

router.get("/", ctrl.listPublic);
// Keep the admin collection route before /:slug so "admin" is not consumed as a slug.
router.get("/admin/all", requireAdminAuth, ctrl.listAdmin);
router.get("/:slug", ctrl.getPublicBySlug);
router.post("/admin", requireAdminAuth, upload.single("image"), ctrl.create);
router.put("/admin/:id", requireAdminAuth, upload.single("image"), ctrl.update);
router.delete("/admin/:id", requireAdminAuth, ctrl.remove);

module.exports = router;
