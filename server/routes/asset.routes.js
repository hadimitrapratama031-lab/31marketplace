const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/asset.controller");

// Publik dan tanpa auth dengan sengaja: Gmail dan Discord mengambil gambar
// tanpa mengirim cookie/token admin apa pun. Perlindungannya bukan auth,
// tapi allowlist host di controller (lihat asset.controller.js).
router.get("/proxy", ctrl.proxyAsset);
router.head("/proxy", ctrl.proxyAsset);

module.exports = router;
