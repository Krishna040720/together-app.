// Optional-accounts persistence.
//
// This is intentionally separate from the in-memory `rooms` object in
// server.js. Live room state (who's connected, video position, chat, etc.)
// stays exactly as it was — ephemeral, in-memory, gone on restart. This
// file only persists the two things that need to survive a restart:
// user accounts, and which room IDs a logged-in user has created (so they
// can find their way back to a room even after the server restarts).
const path = require("path");
const fs = require("fs");
const Database = require("better-sqlite3");

const DATA_DIR = path.join(__dirname, "data");
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, "together.db"));
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS owned_rooms (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    room_id TEXT NOT NULL,
    label TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );
  CREATE INDEX IF NOT EXISTS idx_owned_rooms_user ON owned_rooms(user_id);

  -- Deliberately just a handful of cumulative counters, not per-visitor
  -- tracking — no IPs, no cookies, no analytics vendor. Enough to answer
  -- "how many people have used this," nothing that looks like surveillance
  -- for a two-person app.
  CREATE TABLE IF NOT EXISTS stats_counters (
    key TEXT PRIMARY KEY,
    value INTEGER NOT NULL DEFAULT 0
  );
`);

const statements = {
  insertUser: db.prepare(
    "INSERT INTO users (username, password_hash, created_at) VALUES (?, ?, ?)"
  ),
  getUserByUsername: db.prepare("SELECT * FROM users WHERE username = ?"),
  getUserById: db.prepare("SELECT id, username, created_at FROM users WHERE id = ?"),
  insertOwnedRoom: db.prepare(
    "INSERT INTO owned_rooms (user_id, room_id, label, created_at) VALUES (?, ?, ?, ?)"
  ),
  getOwnedRoomsForUser: db.prepare(
    "SELECT room_id, label, created_at FROM owned_rooms WHERE user_id = ? ORDER BY created_at DESC LIMIT 50"
  ),
  getUserCount: db.prepare("SELECT COUNT(*) AS count FROM users"),
  bumpCounter: db.prepare(
    "INSERT INTO stats_counters (key, value) VALUES (?, 1) ON CONFLICT(key) DO UPDATE SET value = value + 1"
  ),
  getCounter: db.prepare("SELECT value FROM stats_counters WHERE key = ?"),
};

module.exports = { db, statements };
