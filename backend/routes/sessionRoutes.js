const express = require("express");
const Session = require("../models/Session");
const authMiddleware = require("../config/authMiddleware");
const { audit } = require("../config/audit");
const { validateDeviceCode, validateBody } = require("../config/validators");

const router = express.Router();

router.post(
  "/",
  authMiddleware,
  validateBody({ deviceCode: validateDeviceCode }),
  async (req, res) => {
    const { deviceCode, signalingRoom } = req.body;
    if (!signalingRoom || typeof signalingRoom !== "string") {
      return res.status(400).json({ error: "signalingRoom required" });
    }

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
      action: "session_started",
      deviceCode,
      metadata: { sessionId: session._id }
    });

    res.json(session);
  }
);

router.put("/:id", authMiddleware, async (req, res) => {
  const { status, cameraUsed, disconnectReason } = req.body;
  const allowed = ["active", "ended", "denied"];
  if (!allowed.includes(status)) {
    return res.status(400).json({ error: `status must be one of ${allowed.join(", ")}` });
  }

  const session = await Session.findById(req.params.id);
  if (!session) return res.status(404).json({ error: "Session not found" });
  if (session.requestedByAdmin !== req.admin.username) {
    return res.status(403).json({ error: "Not your session" });
  }

  session.status = status;
  if (typeof cameraUsed === "boolean") session.cameraUsed = cameraUsed;
  if (status === "ended") {
    session.endedAt = new Date();
    const validReasons = ["admin_stopped", "phone_disconnected", "ice_failed", "timeout"];
    session.disconnectReason = validReasons.includes(disconnectReason) ? disconnectReason : "admin_stopped";
  }
  await session.save();

  if (status === "ended") {
    await audit({
      actorType: "admin",
      actor: req.admin.username,
      action: "session_ended",
      deviceCode: session.deviceCode,
      metadata: { sessionId: session._id }
    });
  }

  res.json(session);
});

router.get("/", authMiddleware, async (req, res) => {
  const sessions = await Session.find({ requestedByAdmin: req.admin.username })
    .sort({ createdAt: -1 })
    .limit(100);
  res.json(sessions);
});

module.exports = router;
