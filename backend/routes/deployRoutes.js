const express = require("express");
const multer = require("multer");
const crypto = require("crypto");
const path = require("path");
const fs = require("fs");
const authMiddleware = require("../config/authMiddleware");
const ApkBuild = require("../models/ApkBuild");
const { audit } = require("../config/audit");

const router = express.Router();

const UPLOAD_DIR = path.join(__dirname, "..", "uploads", "apks");
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const MAX_APK_SIZE = 200 * 1024 * 1024; // 200MB

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    // Never trust the client-provided filename for the path on disk.
    const secureName = `${crypto.randomBytes(16).toString("hex")}.apk`;
    cb(null, secureName);
  }
});

function fileFilter(req, file, cb) {
  const ext = path.extname(file.originalname).toLowerCase();
  const validExt = ext === ".apk";
  const validMime =
    file.mimetype === "application/vnd.android.package-archive" ||
    file.mimetype === "application/octet-stream";

  if (!validExt || !validMime) {
    return cb(new Error("Only .apk files are accepted"));
  }
  cb(null, true);
}

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: MAX_APK_SIZE, files: 1 }
});

const uploadHandler = (req, res) => {
  upload.single("apk")(req, res, async (err) => {
    if (err) {
      return res.status(400).json({ error: err.message });
    }
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    // Reject path traversal in the client-supplied original name even
    // though we never use it for the on-disk path.
    const originalName = path.basename(req.file.originalname);

    const build = await ApkBuild.create({
      originalName,
      storedFilename: req.file.filename,
      sizeBytes: req.file.size,
      uploadedByAdmin: req.admin.username
    });

    await audit({
      actorType: "admin",
      actor: req.admin.username,
      action: "apk_uploaded",
      metadata: { originalName, sizeBytes: req.file.size }
    });

    res.json({
      id: build._id,
      originalName: build.originalName,
      downloadUrl: `/api/deploy/apk/${build._id}/download`,
      sizeBytes: build.sizeBytes
    });
  });
};

// Canonical route used by the admin app (kept for backward compat).
router.post("/apk", authMiddleware, uploadHandler);
// Exact path requested by spec (POST /api/apk/upload) - this router is
// also mounted at /api/apk in server.js, so this resolves to that path.
// Same handler, same validation, same audit log - not a separate
// implementation to keep in sync.
router.post("/upload", authMiddleware, uploadHandler);

router.get("/apk", authMiddleware, async (req, res) => {
  const builds = await ApkBuild.find().sort({ createdAt: -1 }).limit(50);
  res.json(
    builds.map((b) => ({
      id: b._id,
      originalName: b.originalName,
      sizeBytes: b.sizeBytes,
      uploadedByAdmin: b.uploadedByAdmin,
      createdAt: b.createdAt,
      downloadCount: b.downloadCount,
      downloadUrl: `/api/deploy/apk/${b._id}/download`
    }))
  );
});

// Download does not require the JWT header (so it can be opened
// directly in a browser/on the phone) but the URL itself is only ever
// handed out to an authenticated admin via the endpoints above, and
// the id is an unguessable Mongo ObjectId.
router.get("/apk/:id/download", async (req, res) => {
  const build = await ApkBuild.findById(req.params.id).catch(() => null);
  if (!build) return res.status(404).json({ error: "Not found" });

  const filePath = path.join(UPLOAD_DIR, build.storedFilename);
  // Defense in depth against path traversal even though storedFilename
  // is always server-generated.
  if (!filePath.startsWith(UPLOAD_DIR)) {
    return res.status(400).json({ error: "Invalid path" });
  }
  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "File missing on server" });
  }

  build.downloadCount += 1;
  await build.save();

  res.download(filePath, build.originalName);
});

router.delete("/apk/:id", authMiddleware, async (req, res) => {
  const build = await ApkBuild.findById(req.params.id);
  if (!build) return res.status(404).json({ error: "Not found" });

  const filePath = path.join(UPLOAD_DIR, build.storedFilename);
  if (filePath.startsWith(UPLOAD_DIR) && fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
  await build.deleteOne();

  await audit({
    actorType: "admin",
    actor: req.admin.username,
    action: "apk_deleted",
    metadata: { originalName: build.originalName }
  });

  res.json({ ok: true });
});

module.exports = router;
