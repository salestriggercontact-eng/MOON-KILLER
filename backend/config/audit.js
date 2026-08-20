const AuditLog = require("../models/AuditLog");

async function audit({ actorType, actor, action, deviceCode = null, ip = null, metadata = {} }) {
  try {
    await AuditLog.create({ actorType, actor, action, deviceCode, ip, metadata });
  } catch (err) {
    // Never let logging failures break the request
    console.error("Audit log write failed:", err.message);
  }
}

module.exports = { audit };
