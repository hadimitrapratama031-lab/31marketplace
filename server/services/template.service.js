// Replaces {{placeholder}} tokens with real values. Backend-only rendering
// (spec section 34) so admin templates can never break the system.
function renderTemplate(template, data) {
  if (!template) return "";
  return template.replace(/{{\s*([a-zA-Z_]+)\s*}}/g, (_match, key) => {
    const value = data[key];
    return value === undefined || value === null ? "" : String(value);
  });
}

function formatIDR(amount) {
  const number = Number(amount) || 0;
  return "Rp " + number.toLocaleString("id-ID");
}

module.exports = { renderTemplate, formatIDR };
