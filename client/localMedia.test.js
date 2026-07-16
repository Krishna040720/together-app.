// Real unit test for localMedia.js — requires the actual shipped function
// (not a copy/mirror) and drives it with mock getUserMedia implementations.
// Run with: node localMedia.test.js

const assert = require("assert");
const { acquireLocalMedia, CALL_VIDEO_CONSTRAINTS, CALL_AUDIO_CONSTRAINTS } = require("./localMedia");

function fakeStream(kinds) {
  const tracks = kinds.map((kind) => ({ kind }));
  return { getTracks: () => tracks };
}

let passed = 0;
async function check(label, fn) {
  try {
    await fn();
    console.log(`PASS - ${label}`);
    passed++;
  } catch (err) {
    console.error(`FAIL - ${label}`);
    console.error(err);
    process.exitCode = 1;
  }
}

async function main() {
  await check("both permissions granted -> combined request succeeds, both tracks returned", async () => {
    const requestMedia = async (c) => {
      assert.deepStrictEqual(c, { video: CALL_VIDEO_CONSTRAINTS, audio: CALL_AUDIO_CONSTRAINTS });
      return fakeStream(["audio", "video"]);
    };
    const result = await acquireLocalMedia(requestMedia);
    assert.strictEqual(result.gotVideo, true);
    assert.strictEqual(result.gotAudio, true);
    assert.strictEqual(result.tracks.length, 2);
    assert.strictEqual(result.error, null);
  });

  // The bug case: camera individually blocked (via site settings), mic
  // individually allowed. Old code: combined request throws -> whole call
  // fails, even though mic permission was actually granted.
  await check("camera blocked, mic allowed -> falls back to audio-only instead of failing entirely", async () => {
    const requestMedia = async (c) => {
      if (c.video && c.audio) throw new Error("NotAllowedError: combined request denied");
      if (c.video) throw new Error("NotAllowedError: camera blocked");
      if (c.audio) return fakeStream(["audio"]);
      throw new Error("unexpected constraints");
    };
    const result = await acquireLocalMedia(requestMedia);
    assert.strictEqual(result.gotAudio, true);
    assert.strictEqual(result.gotVideo, false);
    assert.strictEqual(result.tracks.length, 1);
    assert.strictEqual(result.tracks[0].kind, "audio");
    assert.strictEqual(result.error, null);
  });

  await check("mic blocked, camera allowed -> falls back to video-only instead of failing entirely", async () => {
    const requestMedia = async (c) => {
      if (c.video && c.audio) throw new Error("NotAllowedError: combined request denied");
      if (c.audio) throw new Error("NotAllowedError: mic blocked");
      if (c.video) return fakeStream(["video"]);
      throw new Error("unexpected constraints");
    };
    const result = await acquireLocalMedia(requestMedia);
    assert.strictEqual(result.gotVideo, true);
    assert.strictEqual(result.gotAudio, false);
    assert.strictEqual(result.tracks.length, 1);
    assert.strictEqual(result.tracks[0].kind, "video");
    assert.strictEqual(result.error, null);
  });

  await check("both permissions denied -> reports total failure with the original error, no crash", async () => {
    const originalErr = new Error("NotAllowedError: denied");
    const requestMedia = async () => {
      throw originalErr;
    };
    const result = await acquireLocalMedia(requestMedia);
    assert.strictEqual(result.gotVideo, false);
    assert.strictEqual(result.gotAudio, false);
    assert.strictEqual(result.tracks.length, 0);
    assert.strictEqual(result.error, originalErr);
  });

  await check("no camera hardware at all (NotFoundError), mic fine -> still gets audio-only", async () => {
    const requestMedia = async (c) => {
      if (c.video && c.audio) throw new Error("NotFoundError: no camera device");
      if (c.video) throw new Error("NotFoundError: no camera device");
      if (c.audio) return fakeStream(["audio"]);
      throw new Error("unexpected constraints");
    };
    const result = await acquireLocalMedia(requestMedia);
    assert.strictEqual(result.gotAudio, true);
    assert.strictEqual(result.gotVideo, false);
  });

  console.log(`\n${passed} test(s) passed.`);
}

main();
