const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/product.controller");
const redeemCtrl = require("../controllers/redeemCode.controller");
const { requireAdminAuth } = require("../middlewares/auth");
const upload = require("../middlewares/upload");

// Gambar utama + maksimal 5 gambar tambahan dalam satu submit form. maxCount
// ditegakkan multer sebelum satu byte pun sampai ke controller, jadi upload
// keenam ditolak tanpa pernah menyentuh R2. Batasnya diulang lagi di controller
// dan di schema, karena file baru bisa saja ditambahkan ke produk yang gambar
// tambahannya sudah terisi.
const productImages = upload.fields([
  { name: "image", maxCount: 1 },
  { name: "additionalImages", maxCount: 5 },
]);

router.get("/", ctrl.listPublic);
// Keep the admin collection route before /:slug so "admin" is not consumed as a slug.
router.get("/admin/all", requireAdminAuth, ctrl.listAdmin);
// Setelah /admin/all supaya "all" tidak pernah ditangkap sebagai :id.
// Sebelum /admin/:id juga tidak masalah — jumlah segmen path-nya berbeda
// (/admin/redeem-codes/sold = 3 segmen setelah /admin, /admin/:id = 1),
// jadi Express tidak pernah salah mencocokkannya ke :id.
router.get("/admin/redeem-codes/sold", requireAdminAuth, redeemCtrl.listSold);
router.get("/admin/:id", requireAdminAuth, ctrl.getAdminById);
router.get("/:slug", ctrl.getPublicBySlug);
router.post("/admin", requireAdminAuth, productImages, ctrl.create);
router.put("/admin/:id", requireAdminAuth, productImages, ctrl.update);
router.delete("/admin/:id", requireAdminAuth, ctrl.remove);

// Sistem Order Baru — Automatic Redeem Code (restock & statistik per produk).
router.post("/admin/:id/redeem-codes", requireAdminAuth, redeemCtrl.restock);
router.get("/admin/:id/redeem-codes/stats", requireAdminAuth, redeemCtrl.stats);

module.exports = router;
