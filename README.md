# Together

A private, just-the-two-of-you app: video/voice call + perfectly synced video watching (YouTube or your own uploaded clips/reels) + chat + reactions — without screen-share lag or "wait, pause it" mismatches.

## How it works

- **Call**: direct WebRTC connection between you two (peer-to-peer, so video/audio quality depends only on your two connections, not a server relaying it).
- **Sync**: instead of screen-sharing (which re-encodes video and causes lag/quality loss), each of you loads the *same source* — a YouTube link, or a video file one of you uploads — and the server just broadcasts "play / pause / seek" events so both players stay locked together within ~1 second.
- **Chat + reactions + moments**: run over the same lightweight realtime connection (Socket.io).

⚠️ **Important limitation**: this can't sync Netflix/Prime/Hotstar/Disney+ etc. Those platforms are DRM-locked to their own apps — there's no legal or stable way to pipe their video into a custom player. This app works great for YouTube and any video file either of you has (downloaded clips, phone recordings, exported reels, etc).

## Project structure

```
together-app/
  server/       Node.js + Express + Socket.io backend (signaling, sync, chat, uploads)
  client/       Plain HTML/CSS/JS frontend — no build step needed
```

## Run it locally

```bash
cd server
npm install
npm start
```

The server runs on `http://localhost:4000` and **also serves the client** automatically — so just open `http://localhost:4000` in two browser tabs (or send the link to your partner if you're on the same network / already deployed).

## Deploying so you two can actually use it remotely

**Simplest option — one deploy:**
1. Push this whole folder to a GitHub repo.
2. Deploy the `server/` folder to [Render](https://render.com) or [Railway](https://railway.app) (free tier works) — set the start command to `npm start`, root directory to `server`.
3. Because the server also serves `client/`, once it's live, the URL Render/Railway gives you (e.g. `https://together-yourname.onrender.com`) is the link you both open. Done.

**If you'd rather keep frontend/backend separate** (e.g. client on Netlify like your apology page, server on Render):
1. Deploy `server/` to Render/Railway as above — note its URL.
2. In `client/app.js`, set the config line at the top:
   ```js
   const SERVER_URL = "https://your-backend-url.onrender.com";
   ```
3. Deploy the `client/` folder to Netlify Drop, same as before.

## Notes & honest limitations (things to improve if you keep building this)

- **NAT traversal**: the call uses only a public STUN server. That works for most home/mobile networks, but if one of you is behind a strict corporate/college firewall, the direct call may fail to connect. Fixing this properly needs a TURN server (e.g. via [Twilio's Network Traversal Service](https://www.twilio.com/stun-turn) or [metered.ca](https://www.metered.ca/tools/openrelay/) free tier) — happy to wire that in if it becomes an issue.
- **Uploaded videos** are stored on the server's disk. Free hosting tiers often wipe disk storage on redeploy/restart — fine for a movie night, not for long-term storage. For anything you want to keep, download it after.
- **Room state lives in memory**, so if the server restarts mid-session you'd need to rejoin. Good enough for two people on a call together; would need a real database for anything more persistent.
- **Reconnect handling** is basic — if you refresh your tab, you'll rejoin the room and re-sync, but the call itself needs to re-negotiate.

## Feature ideas if you want to keep adding to this

- A "director's chair" toggle — lock control of play/pause/seek to just one person for movies that need less back-and-forth fiddling.
- Saved moments could capture an actual thumbnail (canvas snapshot of the video at that timestamp) instead of just a time + note.
- A shared watchlist so you can queue up what's next without leaving the call.
- Push notification / SMS link when one of you creates a room, so the other doesn't have to be already waiting.
