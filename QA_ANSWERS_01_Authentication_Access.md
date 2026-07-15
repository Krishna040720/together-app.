# QA Testing — Category 1: Authentication & Access

Tested against the actual code in `server/server.js` and `client/app.js`. Where a real gap was found, it's fixed in this drop (see "Fix" notes) and verified with a live server + socket.io test client — not just discussed.

---

### Can a user join a room without logging in?
**Yes, by design.** There's no account system — you type a name and a room code and you're in. This is intentional for a "call two people, watch/listen together" app, not a gap.

### Can two users use the same account simultaneously?
**N/A — there are no accounts.** Two browser tabs *can* join the same room with the same typed name; the server doesn't dedupe by name, only by socket connection. Each gets its own `socket.id` and is treated as a separate participant. Not a bug, just worth knowing if you test with two tabs open under "Krishna" — the app will show two "Krishna"s in that room.

### Is there a host and guest role?
**Fixed.** Before: `amHost` was a purely client-side guess (`peers.length === 0` at join time) used only to decide who goes first in games — it had no real permissions attached and wasn't visible to the server at all.
**Now:** the server tracks a real `room.hostId` (first person to join), sends it to every client in `room-state`/`host-update`, and it's what actually gates the new kick permission below. If the host disconnects, the next remaining person is automatically promoted.

### Can a host kick a user?
**Fixed — this didn't exist at all before.** Added:
- A `kick-user` socket event, server-enforced so only the current `hostId` can trigger it, and only against someone else in the same room.
- A red **🚪 Remove** button that appears next to the other person's name bubble, but *only* if you're the host and someone else is actually in the room.
- The removed person gets a `kicked` event, sees an explanation, and their socket is force-disconnected — they can't keep acting in the room after being removed.
- Verified with a live test: host kick succeeds; a non-host trying to kick the host is silently ignored.

### Are room IDs unique?
**Fixed.** Before: the *client* picked a code locally (`word-3digits`, e.g. `glow-482`) from 8 words × 900 numbers = ~7,200 combinations, with **zero check** against rooms already in use. Two people creating rooms around the same time had a real (if small) chance of colliding.
**Now:** room codes are minted by the **server** via a new `POST /api/create-room` endpoint, which checks the code against all currently-active rooms and regenerates on collision — uniqueness is guaranteed, not just "unlikely to collide." Verified with 500 consecutive creates → 500 unique codes.

### Can room IDs be guessed or brute-forced?
**Improved, and mitigated.**
- The code space is now ~20 words × 9,000 numbers = **180,000** combinations (up from ~7,200) — still human-typeable, but a meaningfully bigger haystack.
- Added a **join-attempt rate limiter**: max 20 join attempts per minute per IP, after which further attempts get a `join-denied` (`rate-limited`) response. This doesn't stop a slow, patient guesser, but it kills the realistic "script hammers hundreds of codes a second" case. Verified live: 21st attempt in a minute gets denied.
- Combined with the new optional PIN (below), a guessed code alone is no longer sufficient for a *private* room.

### What happens when an unauthorized user tries to access a private room?
**Fixed — there was no concept of "private" at all before; any correct or guessed code got you straight in.**
**Now:** when creating a room you can optionally set a PIN (shown as an "Optional PIN (make it private)" field). If set, the server stores it with the room and rejects any `join-room` whose PIN doesn't match with a `join-denied` (`wrong-pin`) event — the client shows a clear message and returns to the landing screen without ever exposing room state (chat, video position, etc.) to the wrong PIN. Verified live: wrong PIN → denied before any room data is sent; correct PIN → joins normally. Rooms created without a PIN behave exactly as before (anyone with the code can join) — this is opt-in, not a forced change.

---

## Files touched
- `server/server.js` — `POST /api/create-room`, PIN check + `hostId` tracking in `join-room`, new `kick-user` handler, host reassignment on disconnect, join-attempt rate limiter.
- `client/app.js` — create/join now talk to the new endpoint and pass PIN, `join-denied`/`kicked`/`host-update` handlers, `updateKickButton()`.
- `client/index.html` — PIN inputs on both landing tickets, new `#kickBtn`.
- `client/style.css` — styling for `#kickBtn`.

## Not changed (out of scope for this category)
Room size limits, room renaming, ownership-transfer-on-leave-*while active*-beyond-host-flag, and inactive-room cleanup are Category 2 (Room Management) questions — next up.
