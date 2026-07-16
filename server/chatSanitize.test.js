// Plain-Node test (no test framework / deps needed) for chatSanitize.js.
// Run with: node chatSanitize.test.js

const assert = require("assert");
const { sanitizeChatText, MAX_CHAT_LENGTH } = require("./chatSanitize");

let passed = 0;
function check(label, fn) {
  try {
    fn();
    console.log(`PASS - ${label}`);
    passed++;
  } catch (err) {
    console.error(`FAIL - ${label}`);
    console.error(err);
    process.exitCode = 1;
  }
}

// --- "Are empty messages blocked?" ---
check("empty string is rejected", () => {
  assert.strictEqual(sanitizeChatText(""), null);
});
check("whitespace-only string is rejected", () => {
  assert.strictEqual(sanitizeChatText("   "), null);
  assert.strictEqual(sanitizeChatText("\n\t  \n"), null);
});
check("null/undefined/non-string payloads are rejected", () => {
  assert.strictEqual(sanitizeChatText(null), null);
  assert.strictEqual(sanitizeChatText(undefined), null);
  assert.strictEqual(sanitizeChatText(42), null);
  assert.strictEqual(sanitizeChatText({ toString: () => "hi" }), null);
});

// --- "Is there a character limit?" ---
check("messages over the limit are truncated, not rejected", () => {
  const huge = "a".repeat(MAX_CHAT_LENGTH + 500);
  const result = sanitizeChatText(huge);
  assert.strictEqual(result.length, MAX_CHAT_LENGTH);
});
check("messages under the limit pass through untruncated", () => {
  const msg = "hello there!";
  assert.strictEqual(sanitizeChatText(msg), msg);
});

// --- "Can users send emojis?" ---
check("emoji messages pass through unchanged", () => {
  assert.strictEqual(sanitizeChatText("great movie 🎬🍿"), "great movie 🎬🍿");
});

// --- "Can malicious HTML/JavaScript be injected?" ---
// The server intentionally does NOT strip markup — it stores/relays plain
// text as-is. The actual injection defense is the client always rendering
// through escapeHtml() before insertion into the DOM (client/app.js). What
// the server IS responsible for is not choking on / mangling these payloads,
// and not letting them slip through as "empty" via whitespace tricks.
check("script/markup payloads are preserved as inert text, not stripped or crashed on", () => {
  const payloads = [
    "<script>alert(1)</script>",
    "<img src=x onerror=alert(1)>",
    "\"><svg onload=alert(1)>",
    "<a href=\"javascript:alert(1)\">click</a>",
  ];
  for (const p of payloads) {
    assert.strictEqual(sanitizeChatText(p), p);
  }
});
check("a payload that is ONLY whitespace around tags still requires real content", () => {
  // sanity check: trimming only removes leading/trailing whitespace, it
  // must not accidentally treat markup-only text as blank
  assert.strictEqual(sanitizeChatText("   <b>hi</b>   "), "<b>hi</b>");
});

console.log(`\n${passed} test(s) passed.`);
