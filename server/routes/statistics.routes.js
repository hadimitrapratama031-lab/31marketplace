const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/statistics.controller");

router.get("/", ctrl.getPublic);

module.exports = router;
