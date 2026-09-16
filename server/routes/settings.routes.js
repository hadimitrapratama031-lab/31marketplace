const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/settings.controller");
const { requireAdminAuth } = require("../middlewares/auth");
const upload = require("../middlewares/upload");

router.get("/", ctrl.getPublic);
router.get("/admin", requireAdminAuth, ctrl.getAdmin);
router.patch("/admin/:section", requireAdminAuth, ctrl.updateSection);
router.post("/admin/upload", requireAdminAuth, upload.single("file"), ctrl.uploadAsset);

module.exports = router;
