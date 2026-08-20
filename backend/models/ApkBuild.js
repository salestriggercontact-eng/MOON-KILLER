const mongoose = require("mongoose");

const ApkBuildSchema = new mongoose.Schema(
  {
    originalName: { type: String, required: true },
    storedFilename: { type: String, required: true, unique: true },
    sizeBytes: { type: Number, required: true },
    uploadedByAdmin: { type: String, required: true },
    downloadCount: { type: Number, default: 0 }
  },
  { timestamps: true }
);

module.exports = mongoose.model("ApkBuild", ApkBuildSchema);
