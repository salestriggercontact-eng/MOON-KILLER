require("dotenv").config();
const express = require("express");
const path = require("path");
const cors = require("cors");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const connectDB = require("./config/db");

const authRoutes = require("./routes/authRoutes");
const deviceRoutes = require("./routes/deviceRoutes");
const sessionRoutes = require("./routes/sessionRoutes");
const deployRoutes = require("./routes/deployRoutes");
const auditRoutes = require("./routes/auditRoutes");

const app = express();

// Render (and most PaaS hosts) sit behind a reverse proxy that sets
// X-Forwarded-For. Without this, express-rate-limit can't safely trust
// that header and throws on every request.
app.set("trust proxy", 1);

connectDB();

const allowedOrigins = (process.env.ALLOWED_ORIGINS || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

app.use(
  helmet({
    crossOriginResourcePolicy: { policy: "cross-origin" }
  })
);
app.use(
  cors({
    origin: allowedOrigins.length ? allowedOrigins : true
  })
);

// JSON body limit - generous enough for normal API calls, but bounded
// so a malicious client can't send an enormous payload. File uploads
// (APKs) go through multer separately, not through this JSON parser.
app.use(express.json({ limit: "2mb" }));

const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 120,
  standardHeaders: true,
  legacyHeaders: false
});
app.use(limiter);

app.get("/health", (req, res) => res.json({ ok: true }));

app.use("/api/auth", authRoutes);
app.use("/api/devices", deviceRoutes);
app.use("/api/sessions", sessionRoutes);
app.use("/api/deploy", deployRoutes);
app.use("/api/apk", deployRoutes); // exposes the exact spec path POST /api/apk/upload (same router/handlers)
app.use("/api/audit-logs", auditRoutes);

// Centralized error handler - keeps stack traces out of responses.
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.message || "Internal server error" });
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => console.log(`Backend running on port ${PORT}`));
