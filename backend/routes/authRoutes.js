const express = require("express");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const rateLimit = require("express-rate-limit");
const Admin = require("../models/Admin");
const { audit } = require("../config/audit");

const router = express.Router();

// Login gets its own tighter limiter than the global one, since it's
// the highest-value brute-force target in the system.
const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many login attempts. Try again later." }
});

router.post("/login", loginLimiter, async (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: "username and password required" });
  }

  const admin = await Admin.findOne({ username });
  if (!admin) {
    await audit({ actorType: "admin", actor: username, action: "login_failed", ip: req.ip });
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const match = await bcrypt.compare(password, admin.password);
  if (!match) {
    await audit({ actorType: "admin", actor: username, action: "login_failed", ip: req.ip });
    return res.status(401).json({ error: "Invalid credentials" });
  }

  const token = jwt.sign(
    { id: admin._id, username: admin.username },
    process.env.JWT_SECRET,
    { expiresIn: "12h" }
  );

  await audit({ actorType: "admin", actor: username, action: "login_success", ip: req.ip });

  res.json({ token, username: admin.username });
});

module.exports = router;
