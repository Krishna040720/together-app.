// localMedia.js
//
// Handles acquiring the local camera/mic MediaStream for a call, with a fix
// for how permission denial is handled.
//
// Bug found: the mic and camera permission prompts were combined into a
// single getUserMedia({ video, audio }) call. Browsers let you grant/deny
// each device independently after the fact though (e.g. Chrome's site-info
// panel lets you set Camera: Block, Microphone: Allow separately). When that
// happens, the COMBINED request throws and fails entirely — even though one
// of the two permissions was actually granted — so someone who only blocked
// their camera lost audio too, and ended up with no call at all instead of a
// voice-only one.
//
// Fix: if the combined request fails, retry each device independently and
// use whichever permission(s) actually came through.
//
// `requestMedia` is injected (rather than this file calling
// navigator.mediaDevices directly) so it can be unit-tested in Node without
// a real browser — see localMedia.test.js.

const CALL_VIDEO_CONSTRAINTS = { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } };
const CALL_AUDIO_CONSTRAINTS = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, sampleRate: 48000 };

/**
 * @param {(constraints: object) => Promise<MediaStream>} requestMedia
 * @returns {Promise<{tracks: MediaStreamTrack[], gotVideo: boolean, gotAudio: boolean, error: Error|null}>}
 */
async function acquireLocalMedia(requestMedia) {
  try {
    const stream = await requestMedia({ video: CALL_VIDEO_CONSTRAINTS, audio: CALL_AUDIO_CONSTRAINTS });
    return { tracks: stream.getTracks(), gotVideo: true, gotAudio: true, error: null };
  } catch (fullErr) {
    let audioStream = null;
    let videoStream = null;
    try {
      audioStream = await requestMedia({ audio: CALL_AUDIO_CONSTRAINTS });
    } catch (e) {}
    try {
      videoStream = await requestMedia({ video: CALL_VIDEO_CONSTRAINTS });
    } catch (e) {}

    if (!audioStream && !videoStream) {
      return { tracks: [], gotVideo: false, gotAudio: false, error: fullErr };
    }
    const tracks = [
      ...(audioStream ? audioStream.getTracks() : []),
      ...(videoStream ? videoStream.getTracks() : []),
    ];
    return { tracks, gotVideo: !!videoStream, gotAudio: !!audioStream, error: null };
  }
}

// UMD-lite: works as a plain <script> (attaches to window, what app.js uses)
// and as a CommonJS module (what the Node test uses).
if (typeof module !== "undefined" && module.exports) {
  module.exports = { acquireLocalMedia, CALL_VIDEO_CONSTRAINTS, CALL_AUDIO_CONSTRAINTS };
} else {
  window.acquireLocalMedia = acquireLocalMedia;
  window.CALL_VIDEO_CONSTRAINTS = CALL_VIDEO_CONSTRAINTS;
  window.CALL_AUDIO_CONSTRAINTS = CALL_AUDIO_CONSTRAINTS;
}
