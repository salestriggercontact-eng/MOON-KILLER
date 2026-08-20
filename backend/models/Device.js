const mongoose = require("mongoose");

const DeviceSchema = new mongoose.Schema(
  {
    deviceCode: { type: String, required: true, unique: true }, // permanent device id
    deviceModel: { type: String, default: "Unknown" },
    androidVersion: { type: String, default: "" },
    isOnline: { type: Boolean, default: false },
    lastSeenAt: { type: Date, default: Date.now },

    // Extended device info (hardware/OS facts only - no personal data),
    // refreshed on each /register call.
    deviceInfo: {
      manufacturer: { type: String, default: "" },
      sdkInt: { type: Number, default: 0 },
      ramTotalBytes: { type: Number, default: 0 },
      ramAvailableBytes: { type: Number, default: 0 },
      storageTotalBytes: { type: Number, default: 0 },
      storageFreeBytes: { type: Number, default: 0 },
      batteryPercent: { type: Number, default: -1 },
      isCharging: { type: Boolean, default: false },
      appVersion: { type: String, default: "" }
    },

    // Pairing: device is only controllable by admins who completed
    // the one-time pairing-code + on-device consent flow.
    pairingCode: { type: String, default: null }, // rotating 6-digit code shown on phone
    pairingCodeExpiresAt: { type: Date, default: null },
    pairedAdmins: [{ type: mongoose.Schema.Types.ObjectId, ref: "Admin" }]
  },
  { timestamps: true }
);

module.exports = mongoose.model("Device", DeviceSchema);
