const mongoose = require("mongoose");

const AuditLogSchema = new mongoose.Schema(
  {
    actorType: { type: String, enum: ["admin", "device", "system"], required: true },
    actor: { type: String, required: true }, // admin username or deviceCode
    action: { type: String, required: true }, // e.g. "login", "pair_approved", "session_started"
    deviceCode: { type: String, default: null },
    ip: { type: String, default: null },
    metadata: { type: mongoose.Schema.Types.Mixed, default: {} },
    createdAt: { type: Date, default: Date.now }
  },
  { timestamps: false }
);

AuditLogSchema.index({ createdAt: -1 });
AuditLogSchema.index({ actor: 1, createdAt: -1 });

module.exports = mongoose.model("AuditLog", AuditLogSchema);
