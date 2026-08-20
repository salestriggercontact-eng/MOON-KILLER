const express = require("express");
const AuditLog = require("../models/AuditLog");
const authMiddleware = require("../config/authMiddleware");

const router = express.Router();

// Any authenticated admin can view the audit trail. If multi-tenant
// admin separation is ever needed, filter by actor/deviceCode here.
router.get("/", authMiddleware, async (req, res) => {
  const limit = Math.min(parseInt(req.query.limit) || 100, 500);
  const logs = await AuditLog.find().sort({ createdAt: -1 }).limit(limit);
  res.json(logs);
});

module.exports = router;
