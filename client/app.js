/* ============ CONFIG ============ */
// If you host the frontend separately from the backend (e.g. client on Netlify,
// server on Render/Railway), set this to your backend's full URL, e.g.
// const SERVER_URL = "https://together-server.onrender.com";
const SERVER_URL = window.TOGETHER_SERVER_URL || "";

/* ============ STATE ============ */
let socket = null;
let roomId = null;
let myName = "You";
let localStream = null;
let pc = null;
let remoteSocketId = null;
let sourceType = "youtube"; // 'youtube' | 'upload'
let ytPlayer = null;
let ytReady = false;
let suppressSync = false;
let togetherSeconds = 0;
let togetherInterval = null;
let currentDuration = 0;

const ICE_SERVERS = [{ urls: "stun:stun.l.google.com:19302" }];

/* ============ DOM ============ */
const $ = (id) => document.getElementById(id);

/* ============ LANDING ============ */
function randomRoomCode() {
  const words = ["glow", "reel", "dusk", "cozy", "spark", "nova", "warm", "lume"];
  const w = words[Math.floor(Math.random() * words.length)];
  const n = Math.floor(100 + Math.random() * 900);
  return `${w}-${n}`;
}

$("createRoomBtn").addEventListener("click", () => {
  const name = $("nameInputCreate").value.trim() || "Someone";
  enterRoom(randomRoomCode(), name);
});

$("joinRoomBtn").addEventListener("click", () => {
  const name = $("nameInputJoin").value.trim() || "Someone";
  const code = $("roomCodeInput").value.trim();
  if (!code) {
    $("landingHint").textContent = "Enter the room code they sent you.";
    return;
  }
  enterRoom(code, name);
});

/* ============ ENTER ROOM ============ */
async function enterRoom(id, name) {
  roomId = id;
  myName = name;

  $("landing").classList.add("hidden");
  $("room").classList.remove("hidden");
  $("copyCodeBtn").textContent = roomId;

  try {
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    $("localVideo").srcObject = localStream;
  } catch (err) {
    alert("Camera/mic access is needed for the call to work. You can still watch together without it.");
  }

  socket = io(SERVER_URL || undefined);
  wireSocketEvents();
  socket.emit("join-room", { roomId, name: myName });
}

$("copyCodeBtn").addEventListener("click", () => {
  navigator.clipboard.writeText(roomId).then(() => {
    const original = $("copyCodeBtn").textContent;
    $("copyCodeBtn").textContent = "Copied!";
    setTimeout(() => ($("copyCodeBtn").textContent = original), 1200);
  });
});

$("leaveBtn").addEventListener("click", () => window.location.reload());

/* ============ SOCKET EVENTS ============ */
function wireSocketEvents() {
  socket.on("room-state", ({ video, chat, theme, peers }) => {
    applyTheme(theme);
    chat.forEach(renderChatMessage);
    if (video && video.type) applyRemoteVideoState(video, true);
    if (peers.length > 0) {
      remoteSocketId = peers[0].id;
      $("remoteName").textContent = peers[0].name;
      startPeerConnection(true, remoteSocketId);
      startTogetherTimer();
    }
  });

  socket.on("peer-joined", ({ id, name }) => {
    remoteSocketId = id;
    $("remoteName").textContent = name;
    startPeerConnection(false, id); // we are the existing peer -> we initiate the offer
    startTogetherTimer();
  });

  socket.on("peer-left", () => {
    remoteSocketId = null;
    $("remoteName").textContent = "Waiting for them…";
    $("glowRingRemote").classList.remove("connected");
    $("glowRingLocal").classList.remove("connected");
    $("remoteVideo").srcObject = null;
    if (pc) {
      pc.close();
      pc = null;
    }
    stopTogetherTimer();
  });

  socket.on("signal", async ({ from, data }) => {
    if (!pc) startPeerConnection(false, from);
    if (data.type === "offer") {
      await pc.setRemoteDescription(new RTCSessionDescription(data));
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      socket.emit("signal", { to: from, data: pc.localDescription });
    } else if (data.type === "answer") {
      await pc.setRemoteDescription(new RTCSessionDescription(data));
    } else if (data.candidate) {
      try {
        await pc.addIceCandidate(data.candidate);
      } catch (e) {}
    }
  });

  socket.on("video-action", (state) => applyRemoteVideoState(state, false));
  socket.on("chat-message", renderChatMessage);
  socket.on("reaction", ({ emoji }) => spawnFloatingEmoji(emoji));
  socket.on("moment", renderMoment);
  socket.on("theme-change", ({ theme }) => applyTheme(theme));
}

/* ============ WEBRTC ============ */
function startPeerConnection(isAnswerer, targetId) {
  if (pc) return;
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

  if (localStream) {
    localStream.getTracks().forEach((track) => pc.addTrack(track, localStream));
  }

  pc.onicecandidate = (e) => {
    if (e.candidate) socket.emit("signal", { to: targetId, data: { candidate: e.candidate } });
  };

  pc.ontrack = (e) => {
    $("remoteVideo").srcObject = e.streams[0];
    $("glowRingRemote").classList.add("connected");
    $("glowRingLocal").classList.add("connected");
  };

  pc.onconnectionstatechange = () => {
    if (pc.connectionState === "disconnected" || pc.connectionState === "failed") {
      $("glowRingRemote").classList.remove("connected");
      $("glowRingLocal").classList.remove("connected");
    }
  };

  if (!isAnswerer) {
    // We were already in the room; the newcomer needs an offer from us.
    pc.createOffer().then((offer) => {
      pc.setLocalDescription(offer);
      socket.emit("signal", { to: targetId, data: offer });
    });
  }
}

/* ============ TOGETHER TIMER ============ */
function startTogetherTimer() {
  if (togetherInterval) return;
  togetherInterval = setInterval(() => {
    togetherSeconds++;
    const m = String(Math.floor(togetherSeconds / 60)).padStart(2, "0");
    const s = String(togetherSeconds % 60).padStart(2, "0");
    $("togetherTimer").textContent = `${m}:${s}`;
  }, 1000);
}
function stopTogetherTimer() {
  clearInterval(togetherInterval);
  togetherInterval = null;
}

/* ============ CALL CONTROLS ============ */
$("micBtn").addEventListener("click", () => {
  if (!localStream) return;
  const track = localStream.getAudioTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  $("micBtn").classList.toggle("off", !track.enabled);
});
$("camBtn").addEventListener("click", () => {
  if (!localStream) return;
  const track = localStream.getVideoTracks()[0];
  if (!track) return;
  track.enabled = !track.enabled;
  $("camBtn").classList.toggle("off", !track.enabled);
});
$("chatToggleBtn").addEventListener("click", () => $("chatPanel").classList.toggle("hidden"));

/* ============ CHAT ============ */
$("chatForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("chatInput").value.trim();
  if (!text) return;
  socket.emit("chat-message", { text });
  $("chatInput").value = "";
});

function renderChatMessage(msg) {
  const div = document.createElement("div");
  div.className = "chat-msg";
  div.innerHTML = `<span class="who">${escapeHtml(msg.name)}</span>${escapeHtml(msg.text)}`;
  $("chatMessages").appendChild(div);
  $("chatMessages").scrollTop = $("chatMessages").scrollHeight;
}

function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = str;
  return d.innerHTML;
}

/* ============ REACTIONS ============ */
document.querySelectorAll(".reaction-btn").forEach((btn) => {
  btn.addEventListener("click", () => {
    const emoji = btn.dataset.emoji;
    socket.emit("reaction", { emoji });
    spawnFloatingEmoji(emoji);
  });
});

function spawnFloatingEmoji(emoji) {
  const el = document.createElement("div");
  el.className = "floating-emoji";
  el.textContent = emoji;
  el.style.left = `${10 + Math.random() * 80}%`;
  el.style.bottom = `${10 + Math.random() * 10}%`;
  $("reactionLayer").appendChild(el);
  setTimeout(() => el.remove(), 2300);
}

/* ============ MOMENTS ============ */
$("momentBtn").addEventListener("click", () => {
  const note = prompt("What's happening right now? (optional note)") || "";
  const videoTime = getCurrentPlaybackTime();
  socket.emit("moment", { note, videoTime });
});

function renderMoment({ note, videoTime, name, at }) {
  const div = document.createElement("div");
  div.className = "moment";
  const timeLabel = formatTime(videoTime || 0);
  div.innerHTML = `<span class="m-name">${escapeHtml(name)}</span> saved <b>${timeLabel}</b>${note ? " — " + escapeHtml(note) : ""}`;
  $("momentsList").prepend(div);
}

function formatTime(sec) {
  sec = Math.floor(sec || 0);
  const m = String(Math.floor(sec / 60)).padStart(2, "0");
  const s = String(sec % 60).padStart(2, "0");
  return `${m}:${s}`;
}

/* ============ THEME ============ */
document.querySelectorAll(".swatch").forEach((btn) => {
  btn.addEventListener("click", () => {
    const theme = btn.dataset.theme;
    applyTheme(theme);
    socket.emit("theme-change", { theme });
  });
});

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  document.querySelectorAll(".swatch").forEach((s) => s.classList.toggle("active", s.dataset.theme === theme));
}

/* ============ SOURCE TABS ============ */
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
    tab.classList.add("active");
    sourceType = tab.dataset.source;
    $("youtubeControls").classList.toggle("hidden", sourceType !== "youtube");
    $("uploadControls").classList.toggle("hidden", sourceType !== "upload");
  });
});

/* ============ YOUTUBE ============ */
function extractYoutubeId(url) {
  const m = url.match(/(?:youtu\.be\/|v=|embed\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function onYouTubeIframeAPIReady() {
  ytReady = true;
}
window.onYouTubeIframeAPIReady = onYouTubeIframeAPIReady;

function ensureYoutubePlayer(videoId, cb) {
  $("emptyState").classList.add("hidden");
  $("youtubePlayer").classList.remove("hidden");
  $("localVideoPlayer").classList.add("hidden");

  const create = () => {
    if (ytPlayer) {
      ytPlayer.loadVideoById(videoId);
      if (cb) cb();
      return;
    }
    ytPlayer = new YT.Player("youtubePlayer", {
      videoId,
      playerVars: { autoplay: 0, controls: 1, rel: 0 },
      events: {
        onReady: () => { if (cb) cb(); },
        onStateChange: onYoutubeStateChange,
      },
    });
  };

  if (ytReady) create();
  else setTimeout(() => ensureYoutubePlayer(videoId, cb), 300);
}

let lastYtState = null;
function onYoutubeStateChange(e) {
  if (suppressSync) return;
  if (e.data === YT.PlayerState.PLAYING) {
    socket.emit("video-action", { type: "youtube", isPlaying: true, currentTime: ytPlayer.getCurrentTime() });
  } else if (e.data === YT.PlayerState.PAUSED) {
    socket.emit("video-action", { type: "youtube", isPlaying: false, currentTime: ytPlayer.getCurrentTime() });
  }
}

$("loadYoutubeBtn").addEventListener("click", () => {
  const url = $("youtubeUrlInput").value.trim();
  const videoId = extractYoutubeId(url);
  if (!videoId) {
    alert("That doesn't look like a valid YouTube link.");
    return;
  }
  ensureYoutubePlayer(videoId, () => {
    socket.emit("video-action", { type: "youtube", source: videoId, isPlaying: false, currentTime: 0 });
  });
});

/* ============ UPLOAD ============ */
$("fileInput").addEventListener("change", async (e) => {
  const file = e.target.files[0];
  if (!file || !roomId) return;
  $("uploadStatus").textContent = "Uploading…";
  const form = new FormData();
  form.append("video", file);
  try {
    const res = await fetch(`${SERVER_URL}/api/upload/${roomId}`, { method: "POST", body: form });
    const data = await res.json();
    if (!data.url) throw new Error("Upload failed");
    loadUploadedVideo(data.url);
    socket.emit("video-action", { type: "upload", source: data.url, isPlaying: false, currentTime: 0 });
    $("uploadStatus").textContent = `Loaded: ${data.name}`;
  } catch (err) {
    $("uploadStatus").textContent = "Upload failed. Check the server is running.";
  }
});

function loadUploadedVideo(url) {
  $("emptyState").classList.add("hidden");
  $("youtubePlayer").classList.add("hidden");
  const v = $("localVideoPlayer");
  v.classList.remove("hidden");
  v.src = url.startsWith("http") ? url : `${SERVER_URL}${url}`;
}

const videoEl = $("localVideoPlayer");
videoEl.addEventListener("play", () => {
  if (suppressSync) return;
  socket.emit("video-action", { type: "upload", isPlaying: true, currentTime: videoEl.currentTime });
});
videoEl.addEventListener("pause", () => {
  if (suppressSync) return;
  socket.emit("video-action", { type: "upload", isPlaying: false, currentTime: videoEl.currentTime });
});
videoEl.addEventListener("seeked", () => {
  if (suppressSync) return;
  socket.emit("video-action", { type: "upload", isPlaying: !videoEl.paused, currentTime: videoEl.currentTime });
});
videoEl.addEventListener("timeupdate", updateFilmstripFromLocal);

/* ============ APPLY REMOTE STATE ============ */
function applyRemoteVideoState(state, isInitialSync) {
  if (!state || !state.type) return;
  suppressSync = true;

  if (state.type === "youtube") {
    if (state.source) {
      ensureYoutubePlayer(state.source, () => {
        seekAndPlayYoutube(state);
      });
    } else if (ytPlayer) {
      seekAndPlayYoutube(state);
    }
  } else if (state.type === "upload") {
    if (state.source) {
      const fullUrl = state.source.startsWith("http") ? state.source : `${SERVER_URL}${state.source}`;
      if (videoEl.src !== fullUrl) loadUploadedVideo(state.source);
    }
    const drift = Math.abs(videoEl.currentTime - (state.currentTime || 0));
    const extraElapsed = isInitialSync ? (Date.now() - state.updatedAt) / 1000 : 0;
    const targetTime = (state.currentTime || 0) + Math.max(0, extraElapsed);
    if (drift > 1) videoEl.currentTime = targetTime;
    if (state.isPlaying) videoEl.play().catch(() => {});
    else videoEl.pause();
  }

  setTimeout(() => (suppressSync = false), 400);
}

function seekAndPlayYoutube(state) {
  if (!ytPlayer || !ytPlayer.getCurrentTime) return;
  const drift = Math.abs(ytPlayer.getCurrentTime() - (state.currentTime || 0));
  if (drift > 1.2) ytPlayer.seekTo(state.currentTime || 0, true);
  if (state.isPlaying) ytPlayer.playVideo();
  else ytPlayer.pauseVideo();
}

/* ============ FILMSTRIP SCRUBBER ============ */
function getCurrentPlaybackTime() {
  if (sourceType === "youtube" && ytPlayer && ytPlayer.getCurrentTime) return ytPlayer.getCurrentTime();
  if (sourceType === "upload") return videoEl.currentTime;
  return 0;
}
function getDuration() {
  if (sourceType === "youtube" && ytPlayer && ytPlayer.getDuration) return ytPlayer.getDuration() || 0;
  if (sourceType === "upload") return videoEl.duration || 0;
  return 0;
}

function updateFilmstripFromLocal() {
  const dur = getDuration();
  const cur = getCurrentPlaybackTime();
  if (!dur) return;
  const pct = (cur / dur) * 100;
  $("progressFill").style.width = `${pct}%`;
  $("scrubberInput").value = Math.floor((cur / dur) * 1000);
}

setInterval(updateFilmstripFromLocal, 500);

$("scrubberInput").addEventListener("input", (e) => {
  const dur = getDuration();
  if (!dur) return;
  const target = (e.target.value / 1000) * dur;
  if (sourceType === "youtube" && ytPlayer) ytPlayer.seekTo(target, true);
  else if (sourceType === "upload") videoEl.currentTime = target;
});
$("scrubberInput").addEventListener("change", () => {
  const cur = getCurrentPlaybackTime();
  socket.emit("video-action", { type: sourceType, isPlaying: sourceType === "upload" ? !videoEl.paused : true, currentTime: cur });
});

/* ============ DOUBLE-TAP REACTION ON SCREEN ============ */
document.querySelector(".screen-frame").addEventListener("dblclick", () => {
  socket.emit("reaction", { emoji: "❤️" });
  spawnFloatingEmoji("❤️");
});
