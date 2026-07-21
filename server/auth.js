// Optional-accounts auth layer.
//
// Design choices, and why:
//
// - Session token is a JWT kept in an httpOnly cookie (not localStorage).
//   httpOnly means client-side JS (including any XSS payload that slips
//   through) can't read the token at all — the browser just sends it
//   automatically. That's the standard trade a cookie-based session makes
//   over a localStorage-held bearer token.
//
// - httpOnly cookies are sent automatically on *every* request to this
//   origin, including ones a malicious third-party page tricks the user's
//   browser into making (classic CSRF). SameSite=Lax already blocks the
//   cross-site POST case, but as defense-in-depth this also implements the
//   standard double-submit-cookie pattern: a second, non-httpOnly cookie
//   holding a random token that the client must echo back in a request
//   header. A cross-site attacker can trigger the cookie-carrying request,
//   but can't read the cookie's value to also set the matching header
//   (same-origin policy blocks that), so the two won't match.
//
// - Passwords are hashed with bcryptjs (pure JS — no native build step,
//   so it installs the same way everywhere Node runs) before ever touching
//   disk.
const crypto = require("crypto");
const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const { statements } = require("./db");

// A JWT_SECRET should be set in production (see README). Falling back to a
// random secret keeps the app usable out of the box for local dev/demo use
// — it just means every restart invalidates existing sessions, which is a
// reasonable trade for "works immediately with zero setup."
if (!process.env.JWT_SECRET) {
  console.warn(
    "[auth] JWT_SECRET is not set — using a random secret generated at startup. " +
      "Every server restart will log everyone out. Set JWT_SECRET in your environment for real deployments."
  );
}
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString("hex");
const TOKEN_COOKIE = "together_auth";
const CSRF_COOKIE = "together_csrf";
const SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

const isProd = process.env.NODE_ENV === "production";
const baseCookieOpts = {
  sameSite: "lax",
  secure: isProd, // over plain http in local dev, "secure" cookies wouldn't be sent at all
  path: "/",
};

function hashPassword(password) {
  return bcrypt.hash(password, 10);
}

function verifyPassword(password, hash) {
  return bcrypt.compare(password, hash);
}

function signSession(user) {
  return jwt.sign({ sub: user.id, username: user.username }, JWT_SECRET, {
    expiresIn: SESSION_MAX_AGE_MS / 1000,
  });
}

// Sets both the session cookie and a matching CSRF cookie. Called on
// signup/login (new session) — logout clears both instead.
function issueSession(res, user) {
  const token = signSession(user);
  const csrfToken = crypto.randomBytes(24).toString("hex");
  res.cookie(TOKEN_COOKIE, token, {
    ...baseCookieOpts,
    httpOnly: true,
    maxAge: SESSION_MAX_AGE_MS,
  });
  res.cookie(CSRF_COOKIE, csrfToken, {
    ...baseCookieOpts,
    httpOnly: false, // client JS needs to read this one to echo it back in a header
    maxAge: SESSION_MAX_AGE_MS,
  });
}

function clearSession(res) {
  res.clearCookie(TOKEN_COOKIE, { ...baseCookieOpts, httpOnly: true });
  res.clearCookie(CSRF_COOKIE, { ...baseCookieOpts, httpOnly: false });
}

// Populates req.user if a valid session cookie is present; never blocks the
// request either way. Routes that actually require login use requireAuth
// below on top of this.
function attachUser(req, res, next) {
  const token = req.cookies && req.cookies[TOKEN_COOKIE];
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      const user = statements.getUserById.get(payload.sub);
      if (user) req.user = user;
    } catch (e) {
      // expired/invalid token — treat as logged out rather than erroring
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: "Log in to do that." });
  next();
}

// For the one account you designate as yours via ADMIN_USERNAME. Returns a
// plain 404 (not 401/403) for everyone else — no point telling random
// visitors an admin endpoint even exists here.
function requireAdmin(req, res, next) {
  if (!process.env.ADMIN_USERNAME || !req.user || req.user.username !== process.env.ADMIN_USERNAME) {
    return res.status(404).end();
  }
  next();
}

// Every request (not just mutating ones) gets a CSRF cookie if it doesn't
// already have one, so the token is available on the very first page load
// — including for the signup/login requests themselves, before any
// authenticated session exists yet.
function ensureCsrfCookie(req, res, next) {
  if (!req.cookies || !req.cookies[CSRF_COOKIE]) {
    res.cookie(CSRF_COOKIE, crypto.randomBytes(24).toString("hex"), {
      ...baseCookieOpts,
      httpOnly: false,
      maxAge: SESSION_MAX_AGE_MS,
    });
  }
  next();
}

function requireCsrf(req, res, next) {
  const cookieToken = req.cookies && req.cookies[CSRF_COOKIE];
  const headerToken = req.headers["x-csrf-token"];
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: "Request could not be verified. Refresh the page and try again." });
  }
  next();
}

module.exports = {
  hashPassword,
  verifyPassword,
  issueSession,
  clearSession,
  attachUser,
  requireAuth,
  requireAdmin,
  ensureCsrfCookie,
  requireCsrf,
};
