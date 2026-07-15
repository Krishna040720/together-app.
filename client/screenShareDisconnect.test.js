// Lightweight logic test for the "sharer disconnects" fix in the peer-left
// handler (client/app.js). There's no jsdom/browser available in this
// sandbox to load app.js directly, so this test reproduces the exact
// branching logic with minimal stubs and asserts the state transitions are
// correct for each disconnect scenario. Run with: node screenShareDisconnect.test.js

const assert = require("assert");

function makeFakeEl() {
  return {
    srcObject: "some-stale-frame",
    textContent: "old label",
    classList: { add() {}, remove() {}, toggle() {} },
  };
}

function runPeerLeftScreenShareCleanup(state) {
  // Mirrors the fix added to the peer-left handler:
  //
  //   if (screenStream) {
  //     stopScreenShare();
  //   } else if (screenShareActive) {
  //     screenShareActive = false;
  //     $("screenShareVideo").srcObject = null;
  //     $("screenShareLabel").textContent = "";
  //     refreshMediaVisibility();
  //   }
  if (state.screenStream) {
    state.stopScreenShareCalled = true;
    // stopScreenShare() itself sets these — modeled here for the assertion
    state.screenShareActive = false;
    state.screenShareVideo.srcObject = null;
  } else if (state.screenShareActive) {
    state.screenShareActive = false;
    state.screenShareVideo.srcObject = null;
    state.screenShareLabel.textContent = "";
    state.refreshCalled = true;
  }
  return state;
}

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

check("we were sharing when the peer disconnects -> our own share is stopped", () => {
  const state = {
    screenStream: { getTracks: () => [] }, // truthy = we're actively sharing
    screenShareActive: true,
    screenShareVideo: makeFakeEl(),
    screenShareLabel: makeFakeEl(),
  };
  runPeerLeftScreenShareCleanup(state);
  assert.strictEqual(state.stopScreenShareCalled, true);
  assert.strictEqual(state.screenShareActive, false);
  assert.strictEqual(state.screenShareVideo.srcObject, null);
});

check("they were sharing to us when they disconnect -> their stale frame is cleared", () => {
  const state = {
    screenStream: null, // we are NOT sharing
    screenShareActive: true, // but their feed was live
    screenShareVideo: makeFakeEl(),
    screenShareLabel: makeFakeEl(),
  };
  runPeerLeftScreenShareCleanup(state);
  assert.strictEqual(state.screenShareActive, false);
  assert.strictEqual(state.screenShareVideo.srcObject, null);
  assert.strictEqual(state.screenShareLabel.textContent, "");
  assert.strictEqual(state.refreshCalled, true);
});

check("no screen share was active -> cleanup is a no-op, nothing throws", () => {
  const state = {
    screenStream: null,
    screenShareActive: false,
    screenShareVideo: makeFakeEl(),
    screenShareLabel: makeFakeEl(),
  };
  runPeerLeftScreenShareCleanup(state);
  assert.strictEqual(state.screenShareActive, false);
  assert.strictEqual(state.stopScreenShareCalled, undefined);
  assert.strictEqual(state.refreshCalled, undefined);
});

console.log(`\n${passed} test(s) passed.`);
console.log(
  "\nNote: this validates the state-transition logic in isolation. There's no " +
    "jsdom/headless browser available in this environment to drive the real " +
    "app.js + WebRTC + socket.io stack end-to-end, so manual verification in " +
    "an actual two-browser test (kill one peer's tab/network mid-share) is " +
    "still worth doing before shipping."
);
