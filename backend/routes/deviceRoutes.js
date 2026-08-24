const express = require("express");
const crypto = require("crypto");
const Device = require("../models/Device");
const PendingRequest = require("../models/PendingRequest");
const Session = require("../models/Session");
const Admin = require("../models/Admin");
const authMiddleware = require("../config/authMiddleware");
const { audit } = require("../config/audit");
const { validateDeviceCode, validateBody } = require("../config/validators");

const router = express.Router();

// ---------- PHONE (DEVICE) ENDPOINTS ----------
// Register device — auto-pair with any admin
router.post(
  "/register",
  validateBody({ deviceCode: validateDeviceCode }),
  async (req, res) => {
    const { deviceCode, deviceModel, androidVersion } = req.body;
    let device = await Device.findOne({ deviceCode });

    if (!device) {
      device = new Device({
        deviceCode,
        deviceModel: deviceModel || "Unknown",
        androidVersion: androidVersion || "",
        isOnline: true,
        lastSeenAt: new Date(),
        pairedAdmins: []
      });
      // Auto-pair with the first admin (any admin)
      const anyAdmin = await Admin.findOne({});
      if (anyAdmin) {
        device.pairedAdmins = [anyAdmin._id];
      }
      await device.save();
    } else {
      device.isOnline = true;
      device.lastSeenAt = new Date();
      if (deviceModel) device.deviceModel = deviceModel;
      if (androidVersion) device.androidVersion = androidVersion;
      await device.save();
    }
    res.json({ ok: true, deviceCode: device.deviceCode });
  }
);

// Heartbeat
router.post(
  "/heartbeat",
  validateBody({ deviceCode: validateDeviceCode }),
  async (req, res) => {
    const { deviceCode } = req.body;
    await Device.findOneAndUpdate(
      { deviceCode },
      { isOnline: true, lastSeenAt: new Date() }
    );
    res.json({ ok: true });
  }
);

// Get pending request (phone polls)
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

// Respond to pending request
router.post("/pending-request/:id/respond", async (req, res) => {
  const { approve } = req.body;
  if (typeof approve !== "boolean") {
    return res.status(400).json({ error: "approve must be boolean" });
  }
  const request = await PendingRequest.findById(req.params.id);
  if (!request) return res.status(404).json({ error: "Request not found" });
  if (request.status !== "pending") {
    return res.status(409).json({ error: `Request already ${request.status}` });
  }
  request.status = approve ? "approved" : "denied";
  await request.save();
  res.json({ ok: true, status: request.status });
});

// ---------- ADMIN ENDPOINTS ----------
// List all devices (no pairing filter)
router.get("/", authMiddleware, async (req, res) => {
  const devices = await Device.find({}).select(
    "deviceCode deviceModel androidVersion isOnline lastSeenAt"
  );
  const now = Date.now();
  const withStatus = devices.map((d) => ({
    ...d.toObject(),
    isOnline: d.isOnline && (now - new Date(d.lastSeenAt).getTime() < 60000)
  }));
  res.json(withStatus);
});

// Request session — auto-approve (no pairing code)
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
    const request = await PendingRequest.create({
      deviceCode,
      adminUsername: req.admin.username,
      type: "session",
      status: "approved",
      signalingRoom
    });
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
  const request = await PendingRequest.findById(req.params.id);
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

module.exports = router;
