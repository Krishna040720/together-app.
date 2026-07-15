// chatSanitize.js
//
// Server-side validation for incoming chat messages.
//
// This is a defense-in-depth layer, not the primary XSS defense. The primary
// defense against "Can malicious HTML/JavaScript be injected?" lives in the
// client's renderChatMessage()/escapeHtml() (client/app.js), which renders
// every message through the browser's textContent -> innerHTML round trip
// before it ever touches the DOM, so `<script>`, `<img onerror=...>`, etc.
// are always displayed as inert text, never executed or parsed as markup.
//
// This module's job is to reject junk BEFORE it's stored or broadcast:
//   - non-string payloads (e.g. someone emitting { text: {} } directly over
//     the socket, bypassing the UI)
//   - empty messages
//   - whitespace-only messages (a gap in the previous check: the server only
//     tested `!text`, so " " or "\n" passed straight through since those are
//     truthy strings)
//   - absurdly long messages (belt-and-suspenders on top of the client's own
//     limit, which a modified/malicious client could ignore)

const MAX_CHAT_LENGTH = 1000;

/**
 * @param {*} rawText - whatever the client sent as `text`
 * @returns {string|null} cleaned text, or null if the message should be dropped
 */
function sanitizeChatText(rawText) {
  if (typeof rawText !== "string") return null;

  // Strip control characters (keep \n and \t, which the chat UI can display).
  const stripped = rawText.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, "");

  const trimmed = stripped.trim();
  if (!trimmed) return null; // blocks both empty AND whitespace-only messages

  return trimmed.slice(0, MAX_CHAT_LENGTH);
}

module.exports = { sanitizeChatText, MAX_CHAT_LENGTH };
