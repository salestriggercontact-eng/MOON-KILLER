const express = require("express");
const crypto = require("crypto");
const rateLimit = require("express-rate-limit");
const Device = require("../models/Device");
const PendingRequest = require("../models/PendingRequest");
const Admin = require("../models/Admin");
const authMiddleware = require("../config/authMiddleware");
const { audit } = require("../config/audit");
const {
  validateDeviceCode,
  validatePairingCode,
  validateBody
} = require("../config/validators");

const router = express.Router();

function genCode(len = 6) {
  return Math.floor(Math.random() * Math.pow(10, len))
    .toString()
    .padStart(len, "0");
}

const ALLOWED_CONTROL_COMMANDS = new Set([
  "tap", "long_press", "swipe", "scroll", "back", "home", "recents", "type_text"
]);

// Pairing-code submission is the one place a brute-force guess could
// matter (6 digits = 1,000,000 possibilities). Limit it hard.
const pairAttemptLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 15,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many pairing attempts. Try again later." }
});

const auditEventLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many audit events." }
});

// ---- Phone-side endpoints (no admin auth - device identifies itself
// by deviceCode, a locally-generated UUID fragment) ----

router.post(
  "/register",
  validateBody({ deviceCode: validateDeviceCode }),
  async (req, res) => {
    const { deviceCode, deviceModel, androidVersion, deviceInfo } = req.body;

    // deviceInfo is optional and only ever hardware/OS facts (see
    // DeviceInfoCollector.kt) - trust the shape loosely but cap string
    // lengths and coerce numeric fields defensively.
    const safeInfo = deviceInfo && typeof deviceInfo === "object" ? {
      manufacturer: String(deviceInfo.manufacturer || "").slice(0, 64),
      sdkInt: Number(deviceInfo.sdkInt) || 0,
      ramTotalBytes: Number(deviceInfo.ramTotalBytes) || 0,
      ramAvailableBytes: Number(deviceInfo.ramAvailableBytes) || 0,
      storageTotalBytes: Number(deviceInfo.storageTotalBytes) || 0,
      storageFreeBytes: Number(deviceInfo.storageFreeBytes) || 0,
      batteryPercent: Number.isFinite(Number(deviceInfo.batteryPercent)) ? Number(deviceInfo.batteryPercent) : -1,
      isCharging: Boolean(deviceInfo.isCharging),
      appVersion: String(deviceInfo.appVersion || "").slice(0, 32)
    } : undefined;

    const update = {
      deviceCode,
      deviceModel: (deviceModel || "Unknown").slice(0, 128),
      androidVersion: (androidVersion || "").slice(0, 64),
      isOnline: true,
      lastSeenAt: new Date()
    };
    if (safeInfo) update.deviceInfo = safeInfo;

    const device = await Device.findOneAndUpdate(
      { deviceCode },
      update,
      { upsert: true, new: true }
    );

    res.json({ ok: true, deviceCode: device.deviceCode });
  }
);

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

router.post(
  "/pairing-code",
  validateBody({ deviceCode: validateDeviceCode }),
  async (req, res) => {
    const { deviceCode } = req.body;

    // If this device already has an unexpired code, return it instead of
    // rotating - otherwise every re-open of the pairing screen invalidates
    // whatever code the user was about to type into the admin app.
    const existing = await Device.findOne({
      deviceCode,
      pairingCode: { $ne: null },
      pairingCodeExpiresAt: { $gt: new Date() }
    });
    if (existing) {
      return res.json({
        pairingCode: existing.pairingCode,
        expiresAt: existing.pairingCodeExpiresAt
      });
    }

    const code = genCode(6);
    const expiresAt = new Date(Date.now() + 5 * 60 * 1000); // 5 min

    const device = await Device.findOneAndUpdate(
      { deviceCode },
      { pairingCode: code, pairingCodeExpiresAt: expiresAt },
      { new: true }
    );
    if (!device) return res.status(404).json({ error: "Device not registered" });

    res.json({ pairingCode: code, expiresAt });
  }
);

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

// ---- Admin-side endpoints (require JWT) ----

router.post(
  "/pair",
  authMiddleware,
  pairAttemptLimiter,
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

router.get("/", authMiddleware, async (req, res) => {
  const devices = await Device.find({ pairedAdmins: req.admin.id }).select(
    "deviceCode deviceModel androidVersion isOnline lastSeenAt deviceInfo"
  );

  const now = Date.now();
  const withStatus = devices.map((d) => ({
    ...d.toObject(),
    isOnline: d.isOnline && now - new Date(d.lastSeenAt).getTime() < 60000
  }));

  res.json(withStatus);
});

router.post(
  "/request-connect",
  authMiddleware,
  validateBody({ deviceCode: validateDeviceCode }),
  async (req, res) => {
    const { deviceCode } = req.body;

    const device = await Device.findOne({
      deviceCode,
      pairedAdmins: req.admin.id
    });

    if (!device) {
      return res.status(403).json({ error: "Device not paired with this admin" });
    }

    // Duplicate-request prevention: if this admin already has an
    // unexpired pending session request for this device, return it
    // instead of spawning a second consent prompt on the phone.
    const existing = await PendingRequest.findOne({
      deviceCode,
      adminUsername: req.admin.username,
      type: "session",
      status: "pending"
    });
    if (existing) {
      return res.json({ requestId: existing._id, signalingRoom: existing.signalingRoom });
    }

    const signalingRoom = `${deviceCode}-${crypto.randomBytes(4).toString("hex")}`;

    const request = await PendingRequest.create({
      deviceCode,
      adminUsername: req.admin.username,
      type: "session",
      status: "pending",
      signalingRoom
    });

    await audit({
      actorType: "admin",
      actor: req.admin.username,
      action: "session_requested",
      deviceCode,
      ip: req.ip
    });

    res.json({ requestId: request._id, signalingRoom });
  }
);

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

// Device self-reports privileged actions for the audit trail. Only a
// fixed allowlist of action names is accepted, and the metadata object
// is intentionally never populated with typed text, PINs, or any
// other field content - only which command ran and whether it
// succeeded.
router.post("/audit-event", auditEventLimiter, async (req, res) => {
  const { deviceCode, action, success } = req.body;

  const err = validateDeviceCode(deviceCode);
  if (err) return res.status(400).json({ error: err });

  const ALLOWED_ACTIONS = new Set([
    "screenshot_requested",
    "camera_started",
    "camera_stopped",
    "control_action" // metadata.command carries e.g. "tap"/"swipe" - never values
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
      // Only ever one of the fixed control-command names, never
      // free-form text - this closes off using this field to exfiltrate
      // typed content a few characters at a time.
      command: ALLOWED_CONTROL_COMMANDS.has(req.body.command) ? req.body.command : undefined
    }
  });

  res.json({ ok: true });
});

// TEMPORARY diagnostic-only endpoint: phone posts a short plain-text
// status line here so it shows up in this service's Render logs -
// used while debugging the offer/answer negotiation without needing
// USB/Logcat access. Remove once the black-screen issue is resolved.
router.post("/debug-log", async (req, res) => {
  const { deviceCode, msg } = req.body;
  console.log(`[phone-debug] device=${deviceCode} :: ${String(msg).slice(0, 300)}`);
  res.json({ ok: true });
});

module.exports = router;
