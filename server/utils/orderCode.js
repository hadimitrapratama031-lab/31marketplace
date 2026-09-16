const { v4: uuidv4 } = require("uuid");

// Human-friendly, sortable, unique order code e.g. ORD-20260916-8F3K2C
function generateOrderCode() {
  const date = new Date();
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, "0");
  const d = String(date.getUTCDate()).padStart(2, "0");
  const rand = uuidv4().replace(/-/g, "").slice(0, 6).toUpperCase();
  return `ORD-${y}${m}${d}-${rand}`;
}

module.exports = { generateOrderCode };
