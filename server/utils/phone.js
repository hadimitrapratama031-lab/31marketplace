// Normalizes Indonesian WhatsApp numbers to the 62xxxxxxxxxx format Fonnte expects.
function normalizeWhatsApp(raw) {
  if (!raw) return null;
  let digits = String(raw).replace(/[^\d+]/g, "");
  digits = digits.replace(/^\+/, "");
  if (digits.startsWith("0")) {
    digits = "62" + digits.slice(1);
  } else if (digits.startsWith("8")) {
    digits = "62" + digits;
  }
  return digits;
}

function isValidWhatsApp(raw) {
  const normalized = normalizeWhatsApp(raw);
  if (!normalized) return false;
  return /^62\d{8,13}$/.test(normalized);
}

function isValidEmail(raw) {
  if (!raw) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(raw).trim());
}

module.exports = { normalizeWhatsApp, isValidWhatsApp, isValidEmail };
