const mongoose = require("mongoose");
const { getDbStatus } = require("../config/db");
const { isR2Configured } = require("../config/r2");
const IntegrationSettings = require("../models/IntegrationSettings");

// GET /api/health — never exposes secrets, only up/down status per spec section 45.
const getHealth = async (req, res) => {
  const dbStatus = getDbStatus();
  let integrations = { klikqris: "unknown", fonnte: "unknown", resend: "unknown" };

  try {
    const settings = await IntegrationSettings.getSingleton();
    integrations = {
      klikqris: settings.klikqris.enabled ? "configured" : "not_configured",
      fonnte: settings.fonnte.enabled ? "configured" : "not_configured",
      resend: settings.resend.enabled ? "configured" : "not_configured",
    };
  } catch (err) {
    // DB might be down; that's already reflected in dbStatus.
  }

  res.json({
    status: true,
    server: "ok",
    time: new Date().toISOString(),
    mongodb: dbStatus,
    r2: isR2Configured() ? "configured" : "not_configured",
    integrations,
  });
};

module.exports = { getHealth };
