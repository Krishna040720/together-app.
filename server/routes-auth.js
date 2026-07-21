const express = require("express");
const rateLimit = require("express-rate-limit");
const { statements } = require("./db");
const {
  hashPassword,
  verifyPassword,
  issueSession,
  clearSession,
  requireAuth,
  requireCsrf,
} = require("./auth");

const router = express.Router();

const USERNAME_RE = /^[a-zA-Z0-9_-]{3,20}$/;

// Signup/login are the highest-value target for brute-forcing / credential
// stuffing, so they get a tighter limit than the general /api one above.
const authAttemptLimiter = rateLimit({
  windowMs: 10 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many attempts — wait a bit and try again." },
});

router.post("/signup", authAttemptLimiter, requireCsrf, async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== "string" || !USERNAME_RE.test(username)) {
    return res.status(400).json({ error: "Username must be 3-20 characters: letters, numbers, _ or -." });
  }
  if (typeof password !== "string" || password.length < 8) {
    return res.status(400).json({ error: "Password must be at least 8 characters." });
  }
  const existing = statements.getUserByUsername.get(username);
  if (existing) {
    return res.status(409).json({ error: "That username is taken." });
  }
  try {
    const passwordHash = await hashPassword(password);
    const info = statements.insertUser.run(username, passwordHash, Date.now());
    const user = { id: info.lastInsertRowid, username };
    issueSession(res, user);
    res.json({ username: user.username });
  } catch (e) {
    res.status(500).json({ error: "Could not create account. Try again." });
  }
});

router.post("/login", authAttemptLimiter, requireCsrf, async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== "string" || typeof password !== "string") {
    return res.status(400).json({ error: "Username and password are required." });
  }
  const user = statements.getUserByUsername.get(username);
  // Same generic error whether the username doesn't exist or the password
  // is wrong — confirming which one it was would let an attacker enumerate
  // valid usernames.
  const invalid = () => res.status(401).json({ error: "Incorrect username or password." });
  if (!user) return invalid();
  const ok = await verifyPassword(password, user.password_hash);
  if (!ok) return invalid();
  issueSession(res, user);
  res.json({ username: user.username });
});

router.post("/logout", requireCsrf, (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

router.get("/me", (req, res) => {
  if (!req.user) return res.json({ user: null });
  res.json({ user: { username: req.user.username } });
});

router.get("/my-rooms", requireAuth, (req, res) => {
  const rooms = statements.getOwnedRoomsForUser.all(req.user.id);
  res.json({ rooms });
});

router.post("/my-rooms", requireAuth, requireCsrf, (req, res) => {
  const { roomId, label } = req.body || {};
  if (typeof roomId !== "string" || !roomId.trim()) {
    return res.status(400).json({ error: "roomId is required." });
  }
  statements.insertOwnedRoom.run(req.user.id, roomId.trim(), String(label || "").slice(0, 100), Date.now());
  res.json({ ok: true });
});

module.exports = router;
