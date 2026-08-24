const express = require("express");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const Device = require("../models/Device");
const PendingRequest = require("../models/PendingRequest");
const Session = require("../models/Session");
const Admin = require("../models/Admin");
const authMiddleware = require("../config/authMiddleware");
const { audit } = require("../config/audit");
const {
  validateDeviceCode,
  validatePairingCode,
  validateBody
} = require("../config/validators");

const router = express.Router();

const ALLOWED_CONTROL_COMMANDS = new Set([
  "tap", "long_press", "swipe", "scroll", "back", "home", "recents", "type_text"
]);

// ---------- PHONE-SIDE ENDPOINTS ----------

// 1. Register device (no pairing required)
router.post(
  "/register",
  validateBody({ deviceCode: validateDeviceCode }),
  async (req, res) => {
    const { deviceCode, deviceModel, androidVersion } = req.body;
    const device = await Device.findOneAndUpdate(
      { deviceCode },
      {
        deviceCode,
        deviceModel: deviceModel || "Unknown",
        androidVersion: androidVersion || "",
        isOnline: true,
        lastSeenAt: new Date()
      },
      { upsert: true, new: true }
    );
    res.json({ ok: true, deviceCode: device.deviceCode });
  }
);

// 2. Heartbeat
router.post(
  "/heartbeat",
  validateBody({ deviceCode: validateDeviceCode }),
  async (req, res) => {
    const { deviceCode } = req.body;
    const device = await Device.findOneAndUpdate(
      { deviceCode },
      { isOnline: true, lastSeenAt: new Date() },
      { new: true }
    );
    if (!device) return res.status(404).json({ error: "Device not registered" });
    res.json({ ok: true });
  }
);

// 3. Get pending request (phone polls this)
router.get("/pending-request", async (req, res) => {
  const { deviceCode } = req.query;
  const err = validateDeviceCode(deviceCode);
  if (err) return res.status(400).json({ error: err });
  const pending = await PendingRequest.findOne({
    deviceCode,
    status: "pending"
  }).sort({ createdAt: 1 });
  if (!pending) return res.json({ pending: null });
  res.json({
    pending: {
      id: pending._id,
      type: pending.type,
      adminUsername: pending.adminUsername,
      signalingRoom: pending.signalingRoom
    }
  });
});

// 4. Respond to pending request (phone approves)
router.post("/pending-request/:id/respond", async (req, res) => {
  const { approve } = req.body;
  if (typeof approve !== "boolean") {
    return res.status(400).json({ error: "approve must be boolean" });
  }
  const request = await PendingRequest.findById(req.params.id).catch(() => null);
  if (!request) return res.status(404).json({ error: "Request not found" });
  if (request.status !== "pending") {
    return res.status(409).json({ error: `Request already ${request.status}` });
  }
  request.status = approve ? "approved" : "denied";
  await request.save();
  if (approve && request.type === "pairing") {
    const admin = await Admin.findOne({ username: request.adminUsername });
    if (admin) {
      await Device.findOneAndUpdate(
        { deviceCode: request.deviceCode },
        { $addToSet: { pairedAdmins: admin._id }, pairingCode: null }
      );
    }
  }
  await audit({
    actorType: "device",
    actor: request.deviceCode,
    action: approve ? `${request.type}_approved` : `${request.type}_denied`,
    deviceCode: request.deviceCode,
    metadata: { adminUsername: request.adminUsername }
  });
  res.json({ ok: true, status: request.status });
});

// ---------- ADMIN-SIDE ENDPOINTS ----------

// Pairing code endpoint (kept for compatibility, but we'll auto-approve sessions)
router.post(
  "/pair",
  authMiddleware,
  validateBody({ pairingCode: validatePairingCode }),
  async (req, res) => {
    const { pairingCode } = req.body;
    const device = await Device.findOne({
      pairingCode,
      pairingCodeExpiresAt: { $gt: new Date() }
    });
    if (!device) {
      await audit({
        actorType: "admin",
        actor: req.admin.username,
        action: "pair_attempt_invalid_code",
        ip: req.ip
      });
      return res.status(404).json({ error: "Invalid or expired pairing code" });
    }
    const request = await PendingRequest.create({
      deviceCode: device.deviceCode,
      adminUsername: req.admin.username,
      type: "pairing",
      status: "pending"
    });
    res.json({ requestId: request._id, deviceCode: device.deviceCode });
  }
);

// Request session (auto-approve, no pairing needed)
router.post(
  "/request-connect",
  authMiddleware,
  validateBody({ deviceCode: validateDeviceCode }),
  async (req, res) => {
    const { deviceCode } = req.body;
    const device = await Device.findOne({ deviceCode });
    if (!device) {
      return res.status(404).json({ error: "Device not registered" });
    }

    // Check for existing pending request to avoid duplicates
    const existing = await PendingRequest.findOne({
      deviceCode,
      adminUsername: req.admin.username,
      type: "session",
      status: { $in: ["pending", "approved"] }
    });
    if (existing) {
      return res.json({
        requestId: existing._id,
        signalingRoom: existing.signalingRoom,
        sessionId: null
      });
    }

    const signalingRoom = `${deviceCode}-${crypto.randomBytes(4).toString("hex")}`;

    // Auto-approve: create pending request as "approved"
    const request = await PendingRequest.create({
      deviceCode,
      adminUsername: req.admin.username,
      type: "session",
      status: "approved",  // instantly approved
      signalingRoom
    });

    // Also create a session record
    const session = await Session.create({
      deviceCode,
      requestedByAdmin: req.admin.username,
      signalingRoom,
      status: "active",
      startedAt: new Date()
    });

    await audit({
      actorType: "admin",
      actor: req.admin.username,
      action: "session_auto_started",
      deviceCode,
      ip: req.ip,
      metadata: { sessionId: session._id }
    });

    res.json({
      requestId: request._id,
      signalingRoom,
      sessionId: session._id
    });
  }
);

// Get request status
router.get("/request-status/:id", authMiddleware, async (req, res) => {
  const request = await PendingRequest.findById(req.params.id).catch(() => null);
  if (!request) return res.status(404).json({ error: "Not found" });
  if (request.adminUsername !== req.admin.username) {
    return res.status(403).json({ error: "Not your request" });
  }
  res.json({
    status: request.status,
    type: request.type,
    deviceCode: request.deviceCode,
    signalingRoom: request.signalingRoom || null
  });
});

// List paired devices (admin sees all devices)
router.get("/", authMiddleware, async (req, res) => {
  const devices = await Device.find({}).select(
    "deviceCode deviceModel androidVersion isOnline lastSeenAt deviceInfo"
  );
  const now = Date.now();
  const withStatus = devices.map((d) => ({
    ...d.toObject(),
    isOnline: d.isOnline && now - new Date(d.lastSeenAt).getTime() < 60000
  }));
  res.json(withStatus);
});

// Unpair (keep)
router.post(
  "/unpair",
  authMiddleware,
  validateBody({ deviceCode: validateDeviceCode }),
  async (req, res) => {
    const { deviceCode } = req.body;
    await Device.findOneAndUpdate(
      { deviceCode },
      { $pull: { pairedAdmins: req.admin.id } }
    );
    await audit({
      actorType: "admin",
      actor: req.admin.username,
      action: "device_unpaired",
      deviceCode
    });
    res.json({ ok: true });
  }
);

// Audit event from phone (keep)
router.post("/audit-event", async (req, res) => {
  const { deviceCode, action, success } = req.body;
  const err = validateDeviceCode(deviceCode);
  if (err) return res.status(400).json({ error: err });
  const ALLOWED_ACTIONS = new Set([
    "screenshot_requested",
    "camera_started",
    "camera_stopped",
    "control_action"
  ]);
  if (!ALLOWED_ACTIONS.has(action)) {
    return res.status(400).json({ error: "Unsupported action" });
  }
  await audit({
    actorType: "device",
    actor: deviceCode,
    action,
    deviceCode,
    metadata: {
      success: Boolean(success),
      command: ALLOWED_CONTROL_COMMANDS.has(req.body.command) ? req.body.command : undefined
    }
  });
  res.json({ ok: true });
});

// Debug log (keep)
router.post("/debug-log", async (req, res) => {
  const { deviceCode, msg } = req.body;
  console.log(`[phone-debug] ${deviceCode}: ${String(msg).slice(0, 300)}`);
  res.json({ ok: true });
});

module.exports = router;
