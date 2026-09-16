const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/rating.controller");
const { requireAdminAuth } = require("../middlewares/auth");
const upload = require("../middlewares/upload");

router.get("/", ctrl.listPublic);
router.post("/", upload.single("avatar"), ctrl.create);
router.get("/admin/all", requireAdminAuth, ctrl.listAdmin);
router.patch("/admin/:id/status", requireAdminAuth, ctrl.updateStatus);
router.delete("/admin/:id", requireAdminAuth, ctrl.remove);

module.exports = router;
