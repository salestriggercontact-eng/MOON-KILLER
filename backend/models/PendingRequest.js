const mongoose = require("mongoose");

const PendingRequestSchema = new mongoose.Schema(
  {
    deviceCode: { type: String, required: true },
    adminUsername: { type: String, required: true },
    type: { type: String, enum: ["pairing", "session"], required: true },
    signalingRoom: { type: String, default: null }, // set for type "session"
    status: {
      type: String,
      enum: ["pending", "approved", "denied", "expired"],
      default: "pending"
    },
    createdAt: { type: Date, default: Date.now, expires: 90 } // TTL auto-delete after 90s
  },
  { timestamps: false }
);

module.exports = mongoose.model("PendingRequest", PendingRequestSchema);
