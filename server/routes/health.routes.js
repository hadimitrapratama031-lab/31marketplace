const express = require("express");
const router = express.Router();
const ctrl = require("../controllers/health.controller");

router.get("/", ctrl.getHealth);

module.exports = router;
