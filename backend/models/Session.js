const mongoose = require("mongoose");

const SessionSchema = new mongoose.Schema(
  {
    deviceCode: { type: String, required: true },
    requestedByAdmin: { type: String, required: true },
    status: {
      type: String,
      enum: ["awaiting_consent", "active", "ended", "denied"],
      default: "awaiting_consent"
    },
    signalingRoom: { type: String, required: true },
    startedAt: { type: Date, default: null },
    endedAt: { type: Date, default: null },
    cameraUsed: { type: Boolean, default: false },
    disconnectReason: {
      type: String,
      enum: ["admin_stopped", "phone_disconnected", "ice_failed", "timeout", null],
      default: null
    }
  },
  { timestamps: true }
);

// duration in seconds, computed on read - not stored, so it's always
// consistent with startedAt/endedAt rather than able to drift.
SessionSchema.virtual("durationSeconds").get(function () {
  if (!this.startedAt) return null;
  const end = this.endedAt || new Date();
  return Math.round((end.getTime() - this.startedAt.getTime()) / 1000);
});
SessionSchema.set("toJSON", { virtuals: true });

module.exports = mongoose.model("Session", SessionSchema);
