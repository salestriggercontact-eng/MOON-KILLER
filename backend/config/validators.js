// Small dependency-free validators. Each returns an error string or null.

const DEVICE_CODE_RE = /^[A-Za-z0-9_-]{4,64}$/;
const USERNAME_RE = /^[A-Za-z0-9_.-]{3,32}$/;
const PAIRING_CODE_RE = /^\d{6}$/;

function validateDeviceCode(v) {
  if (typeof v !== "string" || !DEVICE_CODE_RE.test(v)) return "Invalid deviceCode";
  return null;
}

function validateUsername(v) {
  if (typeof v !== "string" || !USERNAME_RE.test(v)) return "Invalid username";
  return null;
}

function validatePairingCode(v) {
  if (typeof v !== "string" || !PAIRING_CODE_RE.test(v)) return "Invalid pairingCode";
  return null;
}

function validateNonEmptyString(v, maxLen = 256) {
  if (typeof v !== "string" || v.length === 0 || v.length > maxLen) return "Invalid string field";
  return null;
}

// Express middleware factory: pass a map of { field: validatorFn }, checks req.body
function validateBody(spec) {
  return (req, res, next) => {
    for (const [field, validator] of Object.entries(spec)) {
      const err = validator(req.body?.[field]);
      if (err) return res.status(400).json({ error: `${field}: ${err}` });
    }
    next();
  };
}

module.exports = {
  validateDeviceCode,
  validateUsername,
  validatePairingCode,
  validateNonEmptyString,
  validateBody
};
