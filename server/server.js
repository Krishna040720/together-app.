// Together — backend
// Handles: WebRTC signaling relay, room/media sync state, chat, reactions,
// video file uploads, and "watched together" time tracking.

const path = require("path");
const fs = require("fs");
const express = require("express");
const cors = require("cors");
const multer = require("multer");
const http = require("http");
const { Server } = require("socket.io");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");
const cookieParser = require("cookie-parser");
const { ensureCsrfCookie, attachUser } = require("./auth");
const authRoutes = require("./routes-auth");
const { sanitizeChatText } = require("./chatSanitize");

const PORT = process.env.PORT || 4000;
const UPLOAD_DIR = path.join(__dirname, "uploads");
if (!fs.existsSync(UPLOAD_DIR)) fs.mkdirSync(UPLOAD_DIR, { recursive: true });

const app = express();
app.set("trust proxy", true); // so req.ip is the real visitor, not the proxy, when deployed behind Render/etc.
// Accounts are optional and cookie-based, which means credentials-mode CORS:
// a wildcard "*" origin (the previous default) is rejected by browsers for
// any request that carries cookies. Reflecting the request's own Origin
// back (rather than a fixed one) keeps "host client and server separately"
// deployments working without needing a CLIENT_ORIGIN env var for the
// common case — set CORS_ORIGIN if you want to lock this down to a single
// known frontend origin instead.
app.use(
  cors({
    origin: process.env.CORS_ORIGIN || true,
    credentials: true,
  })
);
app.use(cookieParser());
app.use(express.json());
app.use(ensureCsrfCookie);
app.use(attachUser);
// Helmet's default Content-Security-Policy is built for apps that only ever
// load same-origin scripts/styles. This app intentionally pulls in
// cross-origin resources it needs to work — Google Fonts, the YouTube
// iframe API, the Spotify embed API — so the default CSP would break all of
// those. Keep every other helmet protection (noSniff, frameguard, hidden
// X-Powered-By, HSTS, etc.) and leave CSP off rather than shipping a policy
// that either breaks features or is so loose it doesn't add protection.
app.use(helmet({ contentSecurityPolicy: false }));

// General API rate limit — a safety net against basic abuse/scraping on top
// of the upload-specific limiter below (which needs its own, much stricter
// numbers). Scoped to /api rather than app-wide: applying it globally would
// also throttle the static HTML/CSS/JS/font requests a single page load
// makes, and Socket.IO's initial handshake polls over plain HTTP through
// this same server, so a blanket limit could break real-time sync for
// perfectly normal usage.
app.use(
  "/api",
  rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    standardHeaders: true,
    legacyHeaders: false,
  })
);

app.use("/api/auth", authRoutes);

app.use("/uploads", express.static(UPLOAD_DIR));

// Serve the client as static files too, so you can deploy this as ONE app
// if you don't want to host front + back separately.
// Cache-Control: no-cache means "always ask the server if this changed" —
// small perf cost, but it guarantees every redeploy actually takes effect
// right away. Without this, some browsers (especially in-app browsers like
// Instagram/Facebook's) aggressively cache JS/CSS and can keep serving an
// old version for a long time after you've pushed a fix.
const CLIENT_DIR = path.join(__dirname, "..", "client");
if (fs.existsSync(CLIENT_DIR)) {
  app.use(express.static(CLIENT_DIR, { setHeaders: (res) => res.set("Cache-Control", "no-cache") }));
}

// Runtime config for the client — lets you set your OWN free TURN
// credentials (see README) as plain Render/host environment variables
// instead of hand-editing index.html. Falls back to empty strings, which
// makes app.js fall back to its own shared public-demo default.
app.get("/config.js", (req, res) => {
  res.type("application/javascript");
  res.send(
    `window.TOGETHER_TURN_USERNAME = ${JSON.stringify(process.env.TURN_USERNAME || "")};\n` +
    `window.TOGETHER_TURN_CREDENTIAL = ${JSON.stringify(process.env.TURN_CREDENTIAL || "")};\n`
  );
});

// ---- File upload endpoint (for "upload a video/reel" sync mode) ----
const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOAD_DIR),
  filename: (req, file, cb) => {
    const safeName = `${Date.now()}-${file.originalname.replace(/[^a-zA-Z0-9.\-_]/g, "_")}`;
    cb(null, safeName);
  },
});
// 500MB was unrealistic on free hosting tiers (Render/Railway free plans cap
// request bodies and idle connections well below that, so big files were
// dying mid-upload with a generic error instead of actually completing).
// 150MB is a size a phone clip realistically finishes uploading at.
const MAX_UPLOAD_BYTES = 150 * 1024 * 1024;

// QA fix (Video Features #1 supported formats / #3 corrupted files): the
// client's `accept="video/*"` on the file picker is only a UI hint —
// nothing stopped someone from choosing "All files" (or dragging a file
// in, on browsers that support it) and uploading something that isn't a
// video at all. This isn't bulletproof — the mimetype multer sees here is
// itself supplied by the browser for that form part and could in theory be
// spoofed — but it catches the realistic case (wrong file picked by
// accident) and refuses the obvious ones outright instead of silently
// storing arbitrary files under `/uploads`.
const fileFilter = (req, file, cb) => {
  if (!file.mimetype || !file.mimetype.startsWith("video/")) {
    cb(new Error("NOT_A_VIDEO"));
    return;
  }
  cb(null, true);
};
const upload = multer({ storage, fileFilter, limits: { fileSize: MAX_UPLOAD_BYTES } });

// Minimal in-memory rate limiter (no extra dependency needed) — caps each
// IP to a handful of uploads per window so the endpoint can't be used to
// fill up disk or saturate bandwidth by hammering it repeatedly. This is on
// top of (tighter than) the general /api rate limit above, since uploads
// are far more expensive per-request than a typical API call.
const UPLOAD_RATE_LIMIT = 8;
const UPLOAD_RATE_WINDOW_MS = 10 * 60 * 1000;
const uploadHits = new Map(); // ip -> [timestamps]
function uploadRateLimiter(req, res, next) {
  const ip = req.ip || req.connection.remoteAddress || "unknown";
  const now = Date.now();
  const hits = (uploadHits.get(ip) || []).filter((t) => now - t < UPLOAD_RATE_WINDOW_MS);
  if (hits.length >= UPLOAD_RATE_LIMIT) {
    return res.status(429).json({ error: "Too many uploads from this connection — wait a bit and try again." });
  }
  hits.push(now);
  uploadHits.set(ip, hits);
  next();
}

app.post("/api/upload/:roomId", uploadRateLimiter, (req, res) => {
  upload.single("video")(req, res, (err) => {
    if (err instanceof multer.MulterError) {
      if (err.code === "LIMIT_FILE_SIZE") {
        return res.status(413).json({ error: `That file is over the ${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)}MB limit. Try a shorter clip or compress it first.` });
      }
      return res.status(400).json({ error: err.message });
    }
    if (err) {
      if (err.message === "NOT_A_VIDEO") {
        return res.status(400).json({ error: "That doesn't look like a video file. Pick a video (MP4, MOV, WebM, etc.)." });
      }
      return res.status(500).json({ error: "Upload failed on the server side. Try again." });
    }
    if (!req.file) return res.status(400).json({ error: "No file received" });

    // QA fix (Video Features #3 — corrupted files): a 0-byte upload isn't a
    // video by any definition and used to sail straight through — saved,
    // handed back as a success, and only failed later and silently, when
    // the OTHER person's <video> tag tried to play a URL with nothing in
    // it (see the new client-side "error" handling for that half of this,
    // in app.js). Catch the unambiguous case here instead of leaving it to
    // surface downstream with no explanation.
    if (req.file.size === 0) {
      fs.unlink(req.file.path, () => {});
      return res.status(400).json({ error: "That file is empty (0 bytes) — it looks like it didn't upload correctly. Try again." });
    }

    const fileUrl = `/uploads/${req.file.filename}`;

    // QA fix (Video Features #5 — stored permanently): track which files
    // belong to which room so they can be cleaned up when the room is —
    // previously nothing ever used the `:roomId` in this route at all, so
    // every uploaded file just accumulated on disk forever, for every room
    // that ever existed, long after the room and everyone in it were gone.
    // See the janitor sweep and disconnect cleanup below for the other half.
    const room = getRoom(req.params.roomId);
    room.uploadedFiles.push(req.file.filename);

    res.json({ url: fileUrl, name: req.file.originalname });
  });
});

app.get("/api/health", (req, res) => res.json({ ok: true }));

// ---- Room creation (QA fix: Auth & Access #5/#6/#7) ----
// Previously the client picked its own room code locally (8 words x 900
// numbers = ~7,200 possibilities) with no check against rooms that already
// existed, so codes could collide AND were realistically brute-forceable.
// Now the server mints the code, guarantees it isn't already in use, and
// draws from a much bigger space. An optional PIN can also be set, turning
// the room into a "private" one that a guessed/brute-forced code alone
// can't get into.
const ROOM_WORDS = [
  "glow", "reel", "dusk", "cozy", "spark", "nova", "warm", "lume",
  "echo", "tide", "haze", "calm", "fern", "rust", "opal", "mist",
  "peak", "dawn", "glen", "frost",
];
function generateRoomCode() {
  const w = ROOM_WORDS[Math.floor(Math.random() * ROOM_WORDS.length)];
  const n = Math.floor(1000 + Math.random() * 9000); // 4 digits: 20 * 9000 = 180,000 combos
  return `${w}-${n}`;
}
function uniqueRoomCode() {
  let code;
  let attempts = 0;
  do {
    code = generateRoomCode();
    attempts++;
  } while (rooms[code] && attempts < 50);
  return code;
}

const createAttempts = {}; // ip -> [timestamps]
const CREATE_WINDOW_MS = 60 * 60 * 1000; // 1 hour
const CREATE_LIMIT = 20; // rooms per IP per hour

app.post("/api/create-room", (req, res) => {
  // Room creation used to have no limit at all — a script could hammer this
  // endpoint and fill server memory with thousands of empty rooms. 20/hour
  // per IP is generous for real use (nobody legitimately starts 20 movie
  // nights an hour) while stopping that kind of abuse.
  const ip = req.ip || "unknown";
  const now = Date.now();
  createAttempts[ip] = (createAttempts[ip] || []).filter((t) => now - t < CREATE_WINDOW_MS);
  if (createAttempts[ip].length >= CREATE_LIMIT) {
    return res.status(429).json({ error: "Too many rooms created from this connection recently. Try again in a bit." });
  }
  createAttempts[ip].push(now);

  const rawPin = req.body && req.body.pin ? String(req.body.pin).trim() : "";
  const pin = rawPin ? rawPin.slice(0, 12) : null;
  const roomId = uniqueRoomCode();
  rooms[roomId] = makeRoom(pin);
  res.json({ roomId });
});

// Any other unhandled error: still respond with JSON, not Express's default
// HTML error page — an HTML response was what made the client's res.json()
// throw and show a generic "error occurred" with no useful detail.
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: "Something went wrong on the server." });
});

const server = http.createServer(app);
// QA fix (Deployment Checks — "Are environment variables configured?"):
// this was hardcoded to `origin: "*"` regardless of CORS_ORIGIN — so locking
// the REST API down to a specific frontend origin via CORS_ORIGIN did
// nothing for the Socket.IO signaling channel, which stayed wide open to
// any origin. Both now honor the same env var/default.
const io = new Server(server, { cors: { origin: process.env.CORS_ORIGIN || true, credentials: true } });

// ---- In-memory room state ----
// rooms[roomId] = {
//   users: { socketId: { name } },
//   video: { type, source, isPlaying, currentTime, updatedAt },
//   chat: [ { name, text, at } ],
//   theme: 'midnight',
//   createdAt, bothJoinedAt, togetherSeconds
// }
const rooms = {};

function makeRoom(pin) {
  return {
    users: {},
    video: { type: null, source: null, isPlaying: false, currentTime: 0, updatedAt: Date.now() },
    chat: [],
    game: { id: null, state: null }, // whatever's currently loaded in the Games tab
    theme: "midnight",
    director: null, // { id: socketId, name } — when set, only this socket's play/pause/seek actions count
    watchlist: [], // [{ id, type, source, title, addedBy, at }] — queued things to watch/listen to next
    createdAt: Date.now(),
    bothJoinedAt: null,
    togetherSeconds: 0,
    hostId: null, // first socket to join — allowed to kick, and used for game "who goes first" rules
    pin: pin || null, // optional PIN for private rooms; null means anyone with the code can join
    displayName: null, // optional host-set label shown alongside the room code
    uploadedFiles: [], // filenames (relative to UPLOAD_DIR) uploaded via this room — QA fix, Video Features #5
  };
}

// QA fix (Video Features #5 — stored permanently): deletes this room's
// uploaded files from disk. Best-effort — a file that's already gone (or
// was on a filesystem wiped by a host redeploy, see README) just fails
// silently rather than crashing the janitor sweep over it.
function deleteRoomFiles(room) {
  (room.uploadedFiles || []).forEach((filename) => {
    fs.unlink(path.join(UPLOAD_DIR, filename), () => {});
  });
}

// Lazy-created for codes that were never minted through /api/create-room
// (e.g. two people just agreeing on a custom word verbally, or an older
// client) — these have no PIN, matching the previous "anyone with the code
// gets in" behavior.
function getRoom(roomId) {
  if (!rooms[roomId]) {
    rooms[roomId] = makeRoom(null);
  }
  return rooms[roomId];
}

function otherSocketsInRoom(roomId, excludeId) {
  return Object.keys(getRoom(roomId).users).filter((id) => id !== excludeId);
}

// "call" role = wants WebRTC (the native Android app's video/audio/screen-share
// connection). "media" role = the web client used just for chat/YouTube/Spotify/
// reactions once the native app is handling the call itself. Old web-only
// clients that never send a role are treated as "call" so nothing breaks for
// people still using this purely as a browser app.
function otherCallSocketsInRoom(roomId, excludeId) {
  const room = getRoom(roomId);
  return Object.keys(room.users).filter((id) => id !== excludeId && room.users[id].role === "call");
}

// Rooms auto-expire 24h after creation — the actual fix for "an old invite
// link shouldn't work forever." Rotating the code on every refresh (the
// original ask) would've broken the refresh-stays-connected fix from
// before, since a refresh IS a rejoin from the server's perspective. A
// 24h window is generous for actual use (nobody's on a single movie night
// that long) while still meaning a leaked link goes stale on its own.
const MAX_ROOM_AGE_MS = 24 * 60 * 60 * 1000;

// Room size cap (QA fix: Room Management #5). This app is built for two
// people, but a hard cap of exactly 2 would bounce a legitimate refresh —
// the old socket doesn't always disconnect before the new one joins, and
// native mode adds an extra "media" role socket for the same person. 4
// gives that real-world headroom while still refusing to let a room turn
// into an open party if a code leaks or gets guessed.
const MAX_ROOM_USERS = 4;

// Inactive-room cleanup (QA fix: Room Management #2). Rooms only used to
// get removed from memory if someone actually connected and then
// disconnected (via the 10-minute timeout further down) — a room created
// through /api/create-room that nobody ever joined stuck around forever,
// and a room whose 24h invite link expired was rejected on join but never
// actually deleted. This sweep catches both.
const ROOM_JANITOR_INTERVAL_MS = 15 * 60 * 1000;
const EMPTY_ROOM_MAX_AGE_MS = 30 * 60 * 1000;
setInterval(() => {
  const now = Date.now();
  Object.keys(rooms).forEach((id) => {
    const room = rooms[id];
    const isEmpty = Object.keys(room.users).length === 0;
    const expiredByAge = now - room.createdAt > MAX_ROOM_AGE_MS;
    const abandonedEmpty = isEmpty && now - room.createdAt > EMPTY_ROOM_MAX_AGE_MS;
    if (expiredByAge || abandonedEmpty) {
      deleteRoomFiles(room);
      delete rooms[id];
    }
  });
}, ROOM_JANITOR_INTERVAL_MS);

// ---- Join-attempt rate limiting (QA fix: Auth & Access #6) ----
// Room codes are short and human-guessable by design, so we can't rely on
// entropy alone. Cap how many join attempts a single IP can make per
// minute — this doesn't stop a slow/patient brute force, but it kills the
// realistic "script tries hundreds of codes a second" case.
const joinAttempts = {}; // ip -> [timestamps]
const JOIN_WINDOW_MS = 60 * 1000;
const JOIN_ATTEMPT_LIMIT = 20;

io.on("connection", (socket) => {
  let currentRoom = null;
  let currentName = null;

  socket.on("join-room", ({ roomId, name, role, pin }) => {
    if (!roomId) return;

    const existingRoom = rooms[roomId];
    if (existingRoom && Date.now() - existingRoom.createdAt > MAX_ROOM_AGE_MS) {
      socket.emit("room-expired");
      return;
    }

    const ip = socket.handshake.address || "unknown";
    const now = Date.now();
    joinAttempts[ip] = (joinAttempts[ip] || []).filter((t) => now - t < JOIN_WINDOW_MS);
    joinAttempts[ip].push(now);
    if (joinAttempts[ip].length > JOIN_ATTEMPT_LIMIT) {
      socket.emit("join-denied", { reason: "rate-limited" });
      return;
    }

    const room = getRoom(roomId);
    if (room.pin && room.pin !== pin) {
      socket.emit("join-denied", { reason: "wrong-pin" });
      return;
    }

    if (Object.keys(room.users).length >= MAX_ROOM_USERS) {
      socket.emit("join-denied", { reason: "room-full" });
      return;
    }

    currentRoom = roomId;
    currentName = (name || "Someone").slice(0, 40);
    const myRole = role === "media" ? "media" : "call";
    socket.join(roomId);

    room.users[socket.id] = { name: currentName, role: myRole };
    if (!room.hostId) room.hostId = socket.id; // first to arrive is host — can kick, and goes first in games

    const others = otherSocketsInRoom(roomId, socket.id);
    const callPeers = otherCallSocketsInRoom(roomId, socket.id);

    // Tell the new joiner the current state so they land in sync, not at zero.
    // "peers" here is call-role only — that's what WebRTC offer/answer needs.
    socket.emit("room-state", {
      video: room.video,
      chat: room.chat.slice(-100),
      game: room.game,
      theme: room.theme,
      director: room.director,
      watchlist: room.watchlist,
      peers: callPeers.map((id) => ({ id, name: room.users[id]?.name })),
      hostId: room.hostId,
      isHost: room.hostId === socket.id,
      displayName: room.displayName,
    });

    // Only call-role peers need to know about each other for WebRTC purposes.
    if (myRole === "call") {
      callPeers.forEach((id) => {
        io.to(id).emit("peer-joined", { id: socket.id, name: currentName, role: myRole });
      });
    }

    if (others.length > 0 && !room.bothJoinedAt) {
      room.bothJoinedAt = Date.now();
    }
  });

  // ---- WebRTC signaling relay (offer/answer/ICE candidates) ----
  socket.on("signal", ({ to, data }) => {
    if (!to) return;
    io.to(to).emit("signal", { from: socket.id, data });
  });

  // ---- Media sync: play / pause / seek / load-new-source ----
  socket.on("video-action", (action) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    room.video = {
      ...room.video,
      ...action,
      updatedAt: Date.now(),
    };
    socket.to(currentRoom).emit("video-action", room.video);
  });

  // Periodic drift-correction ping from whichever client is "source of truth"
  // QA fix (Synchronization #4/#6): the client used to figure out who's
  // "authoritative" by comparing socket ids via a WebRTC-call-only
  // remoteSocketId, which is never set for native-mode "media" role
  // sockets (see app.js applySyncPing) — attaching the sender's own id
  // here lets the client do that comparison directly, for any pair of
  // sync participants, regardless of whether they're also connected via
  // a WebRTC call.
  socket.on("sync-ping", (state) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit("sync-ping", { ...state, from: socket.id });
  });

  // ---- Games: Tic-Tac-Toe / Connect Four / Draw & Guess ----
  // Same lightweight "trust the two people in the room" model as video-action:
  // the server just stores the latest state and relays it, all game logic
  // (whose turn, who won) is computed identically on both clients.
  socket.on("game-select", ({ id, state }) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    room.game = { id: id || null, state: state || null };
    io.to(currentRoom).emit("game-select", room.game); // both clients init from the same payload
  });

  socket.on("game-action", (state) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (!room.game.id) return; // no game loaded, ignore stray actions
    room.game.state = state;
    socket.to(currentRoom).emit("game-action", state);
  });

  // Draw & Guess: strokes are ephemeral (not stored) — just like reactions,
  // they're relayed live and re-drawn on the other screen as they happen.
  socket.on("draw-stroke", (stroke) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit("draw-stroke", stroke);
  });

  socket.on("draw-clear", () => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit("draw-clear");
  });

  // ---- Chat ----
  socket.on("chat-message", ({ text } = {}) => {
    if (!currentRoom) return;
    // Rejects non-strings, empty messages, and whitespace-only messages
    // (the old `!text` check let " " / "\n" through since they're truthy).
    // Note: this does NOT need to strip HTML/script tags — messages are
    // stored and relayed as plain text, and the client always renders chat
    // through escapeHtml() (see client/app.js), which neutralizes any
    // markup at display time. Sanitizing here too would just mean double
    // escaping down the line.
    const clean = sanitizeChatText(text);
    if (!clean) return;
    const room = getRoom(currentRoom);
    const msg = { name: currentName, text: clean, at: Date.now() };
    room.chat.push(msg);
    io.to(currentRoom).emit("chat-message", msg);
  });

  // ---- Mic/camera status (so the other person sees a clear muted/off badge) ----
  socket.on("media-status", (status) => {
    if (!currentRoom) return;
    socket.to(currentRoom).emit("media-status", { ...status, from: socket.id });
  });

  // ---- Reactions (floating emoji bursts) ----
  socket.on("reaction", ({ emoji }) => {
    if (!currentRoom) return;
    io.to(currentRoom).emit("reaction", { emoji, from: currentName });
  });

  // ---- Live captions ----
  // Speech recognition runs entirely client-side (each person transcribes
  // their OWN mic) — the server's only job is relaying the resulting text to
  // the other person, the same as a reaction. Nothing is stored: no room.chat
  // entry, no persistence, no video/audio ever touches the server.
  socket.on("caption", ({ text, final }) => {
    if (!currentRoom) return;
    if (typeof text !== "string" || text.length > 300) return;
    socket.to(currentRoom).emit("caption", { text, final: !!final, from: currentName, fromId: socket.id });
  });

  // ---- Spark a conversation (shared icebreaker prompt) ----
  socket.on("icebreaker", ({ text }) => {
    if (!currentRoom) return;
    if (typeof text !== "string" || text.length > 200) return;
    io.to(currentRoom).emit("icebreaker", { text, from: currentName });
  });

  // ---- Moments (saved timestamp + note, shown to both) ----
  socket.on("moment", ({ note, videoTime }) => {
    if (!currentRoom) return;
    io.to(currentRoom).emit("moment", { note, videoTime, name: currentName, at: Date.now() });
  });

  // ---- Director's chair: lock play/pause/seek control to one person ----
  // "take: true" claims it (only allowed if nobody currently holds it, or
  // the claimer already holds it — prevents a race where both people think
  // they just took control at the same instant). "take: false" releases it.
  // Enforcement of what counts as an allowed video-action happens client
  // side (same trust model as the rest of this app); this just tracks and
  // broadcasts who currently holds it so both UIs agree.
  socket.on("director-set", ({ take }) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (take) {
      if (!room.director || room.director.id === socket.id) {
        room.director = { id: socket.id, name: currentName };
      }
    } else if (room.director && room.director.id === socket.id) {
      room.director = null;
    }
    io.to(currentRoom).emit("director-update", room.director);
  });

  // ---- Watchlist: queue of things to watch/listen to next ----
  socket.on("watchlist-add", ({ type, source, title }) => {
    if (!currentRoom || !type || !source) return;
    const room = getRoom(currentRoom);
    const item = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      type,
      source,
      title: String(title || source).slice(0, 200),
      addedBy: currentName,
      at: Date.now(),
    };
    room.watchlist.push(item);
    io.to(currentRoom).emit("watchlist-update", room.watchlist);
  });

  socket.on("watchlist-remove", ({ id }) => {
    if (!currentRoom || !id) return;
    const room = getRoom(currentRoom);
    room.watchlist = room.watchlist.filter((it) => it.id !== id);
    io.to(currentRoom).emit("watchlist-update", room.watchlist);
  });

  // ---- Host: remove someone from the room (QA fix: Auth & Access #4) ----
  // Only the current host can do this, and only for someone else in the
  // same room. The target gets a "kicked" event so their UI can show why,
  // then we forcibly close their socket so they can't keep acting in the room.
  socket.on("kick-user", ({ targetId }) => {
    if (!currentRoom || !targetId || targetId === socket.id) return;
    const room = getRoom(currentRoom);
    if (room.hostId !== socket.id) return; // not the host — ignore
    if (!room.users[targetId]) return; // not actually in this room

    io.to(targetId).emit("kicked");
    const targetSocket = io.sockets.sockets.get(targetId);
    if (targetSocket) targetSocket.disconnect(true);
  });

  // ---- Host: rename the room (QA fix: Room Management #3) ----
  // The room CODE never changes (that would break invite links already
  // sent out) — this is just a friendly display label shown alongside it.
  // Host-only so the two people can't fight over what it's called.
  socket.on("room-rename", ({ name }) => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    if (room.hostId !== socket.id) return;
    room.displayName = String(name || "").trim().slice(0, 60) || null;
    io.to(currentRoom).emit("room-renamed", { displayName: room.displayName });
  });

  // ---- Ambient theme ----
  socket.on("theme-change", ({ theme }) => {
    if (!currentRoom) return;
    getRoom(currentRoom).theme = theme;
    socket.to(currentRoom).emit("theme-change", { theme });
  });

  socket.on("disconnect", () => {
    if (!currentRoom) return;
    const room = getRoom(currentRoom);
    const leavingRole = room.users[socket.id]?.role || "call";
    delete room.users[socket.id];

    if (room.director && room.director.id === socket.id) {
      room.director = null;
      io.to(currentRoom).emit("director-update", null);
    }

    if (room.hostId === socket.id) {
      const remaining = Object.keys(room.users);
      room.hostId = remaining.length > 0 ? remaining[0] : null;
      io.to(currentRoom).emit("host-update", { hostId: room.hostId });
    }

    if (leavingRole === "call") {
      otherCallSocketsInRoom(currentRoom, socket.id).forEach((id) => {
        io.to(id).emit("peer-left", { id: socket.id });
      });
    }

    if (Object.keys(room.users).length === 0) {
      // Keep the room around briefly in case of refresh/reconnect, then clean up.
      setTimeout(() => {
        if (rooms[currentRoom] && Object.keys(rooms[currentRoom].users).length === 0) {
          deleteRoomFiles(rooms[currentRoom]);
          delete rooms[currentRoom];
        }
      }, 10 * 60 * 1000);
    }
  });
});

server.listen(PORT, () => {
  console.log(`Together server running on port ${PORT}`);
});

// QA fix (Deployment Checks — "Are logs free of errors?" / "Is uptime
// acceptable?"): previously an uncaught exception or unhandled promise
// rejection anywhere would either crash the process with a bare Node stack
// trace (no context about which room/request triggered it) or, worse, get
// silently swallowed depending on how it surfaced. Now both are logged with
// a clear tag before the process exits, so a host's restart policy
// (Render/Railway auto-restart the dyno on crash) kicks in against a clean,
// searchable log line instead of an ambiguous one — and nothing hides an
// error that should have been visible.
process.on("uncaughtException", (err) => {
  console.error("[fatal] uncaughtException:", err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[fatal] unhandledRejection:", reason);
  process.exit(1);
});
// Node's default (2 min) can cut off a big video upload over slow mobile
// data before it finishes. 10 minutes gives a phone clip real room.
server.requestTimeout = 10 * 60 * 1000;
server.headersTimeout = 10 * 60 * 1000 + 1000;
