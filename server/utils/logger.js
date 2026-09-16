/**
 * Minimal structured logger. Never logs secrets/tokens/passwords — callers
 * must not pass those fields in `meta`.
 */
const REDACT_KEYS = ["password", "token", "secret", "apikey", "api_key", "authorization", "signature"];

function redact(meta) {
  if (!meta || typeof meta !== "object") return meta;
  const clone = {};
  for (const [key, value] of Object.entries(meta)) {
    if (REDACT_KEYS.some((k) => key.toLowerCase().includes(k))) {
      clone[key] = "[REDACTED]";
    } else {
      clone[key] = value;
    }
  }
  return clone;
}

function line(level, message, meta) {
  const payload = {
    time: new Date().toISOString(),
    level,
    message,
    ...(meta ? redact(meta) : {}),
  };
  const serialized = JSON.stringify(payload);
  if (level === "error") console.error(serialized);
  else if (level === "warn") console.warn(serialized);
  else console.log(serialized);
}

module.exports = {
  info: (message, meta) => line("info", message, meta),
  warn: (message, meta) => line("warn", message, meta),
  error: (message, meta) => line("error", message, meta),
};
