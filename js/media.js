// --- Photo capture -----------------------------------------------------

// `imageOrientation: 'from-image'` makes createImageBitmap honor EXIF
// rotation instead of drawing the raw sensor orientation (iPhone photos
// taken in portrait are otherwise stored "sideways" with a rotation flag).
export async function downscaleImage(file, maxDimension = 1024, quality = 0.85) {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, maxDimension / Math.max(bitmap.width, bitmap.height));
  const width = Math.round(bitmap.width * scale);
  const height = Math.round(bitmap.height * scale);

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(bitmap, 0, 0, width, height);
  if (bitmap.close) bitmap.close();

  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (blob) => (blob ? resolve(blob) : reject(new Error('Could not encode image'))),
      'image/jpeg',
      quality
    );
  });
}

// --- Audio recording -----------------------------------------------------

const AUDIO_MIME_CANDIDATES = [
  'audio/mp4',
  'audio/mp4;codecs=mp4a.40.2',
  'audio/webm;codecs=opus',
  'audio/webm',
];

export function pickSupportedMimeType() {
  if (typeof MediaRecorder === 'undefined' || !MediaRecorder.isTypeSupported) return '';
  return AUDIO_MIME_CANDIDATES.find((type) => MediaRecorder.isTypeSupported(type)) || '';
}

/**
 * Starts recording immediately and auto-stops after `maxMs`.
 * Returns a controller: call stop() to end early, or await result
 * for { blob, mimeType, durationMs }. Always releases the mic track,
 * whether stopped, cancelled, or auto-capped.
 */
// The microphone stream is acquired once and kept open, so recording several
// words in a row only triggers iOS's permission prompt once (per app launch)
// instead of on every single recording. It's released when the app is
// backgrounded/closed (see the listeners below), which also clears the "mic
// in use" indicator; the next visit asks once more.
let micStream = null;

// A cached stream is only reusable while it still has a LIVE, UNMUTED track.
// iOS mutes the track (readyState stays 'live') when something interrupts the
// mic mid-session — a notification, Siri, an incoming call. A muted track keeps
// "recording" but captures zero audio, so it must count as unusable: otherwise
// every take after the interruption is silently empty (the mic looks fine).
function micStreamUsable(stream) {
  if (!stream || !stream.active) return false;
  return stream.getAudioTracks().some((t) => t.readyState === 'live' && !t.muted);
}

async function getMicStream() {
  if (micStreamUsable(micStream)) return micStream;
  // Drop a stale/interrupted stream before re-acquiring, so iOS hands us a
  // fresh live capture instead of handing back the muted one it was holding.
  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
  }
  micStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  return micStream;
}

export function releaseMicrophone() {
  if (micStream) {
    micStream.getTracks().forEach((track) => track.stop());
    micStream = null;
  }
}

if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') releaseMicrophone();
  });
  window.addEventListener('pagehide', releaseMicrophone);
}

export async function recordAudio({ maxMs = 6000 } = {}) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('This browser has no microphone API available.');
  }

  let stream;
  try {
    stream = await getMicStream();
  } catch (err) {
    throw new Error('Microphone permission was denied, or no microphone is available.');
  }

  const mimeType = pickSupportedMimeType();
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  const chunks = [];
  const startedAt = Date.now();
  // Note: we intentionally do NOT stop the stream's tracks here — the stream is
  // reused across recordings and only released on background/close.

  recorder.addEventListener('dataavailable', (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  });

  const result = new Promise((resolve, reject) => {
    recorder.addEventListener('stop', () => {
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
      if (blob.size === 0) {
        reject(new Error('No audio was captured. Please try recording again.'));
        return;
      }
      resolve({ blob, mimeType: blob.type, durationMs: Date.now() - startedAt });
    });
  });

  recorder.start();
  const capTimer = setTimeout(() => {
    if (recorder.state !== 'inactive') recorder.stop();
  }, maxMs);

  return {
    stop() {
      clearTimeout(capTimer);
      if (recorder.state !== 'inactive') recorder.stop();
    },
    cancel() {
      clearTimeout(capTimer);
      if (recorder.state !== 'inactive') recorder.stop();
    },
    result,
  };
}

// --- Playback -----------------------------------------------------

// One shared <audio> element, reused so an initial user-gesture tap can
// "unlock" it for later programmatic playback under iOS's autoplay policy.
let sharedAudio = null;
function getSharedAudioElement() {
  if (!sharedAudio) {
    sharedAudio = new Audio();
    sharedAudio.playsInline = true;
  }
  return sharedAudio;
}

// A single Web Audio context, used to play clip sequences gaplessly (see
// playBlobSequence). Created lazily; starts suspended on iOS until resumed
// inside a user gesture — unlockAudio() does that.
let audioCtx = null;
function getAudioContext() {
  if (!audioCtx) {
    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (Ctx) audioCtx = new Ctx();
  }
  return audioCtx;
}

// Call once, directly inside a user-gesture (tap) handler, before any
// programmatic (non-gesture) playback is attempted later in the session.
// Unlocks both the shared <audio> element (single-clip preview) and the
// Web Audio context (gapless sequences).
export function unlockAudio() {
  const audio = getSharedAudioElement();
  audio.muted = true;
  const p = audio.play();
  if (p && p.catch) p.catch(() => {});
  audio.pause();
  audio.muted = false;

  const ctx = getAudioContext();
  if (ctx && ctx.state === 'suspended') ctx.resume().catch(() => {});
}

// --- Single-playback rule -----------------------------------------------------
// Only one sound ever plays at a time (overlapping clips genuinely confused
// the toddler). Every playBlobSequence call carries a `key` naming what it
// is (e.g. 'prompt:<wordId>'). Starting a DIFFERENT sound cuts the current
// one off; re-triggering the SAME key while it plays is ignored so the clip
// finishes naturally instead of stacking or restarting.
let activeSequence = null; // { key, sources, element, cancelled, settle }

export function stopPlayback() {
  const seq = activeSequence;
  if (!seq) return;
  activeSequence = null;
  seq.cancelled = true;
  for (const src of seq.sources) {
    try {
      src.onended = null;
      src.stop();
    } catch {
      /* already stopped */
    }
  }
  if (seq.element) {
    seq.element.pause();
    seq.element.src = '';
  }
  seq.settle({ cancelled: true });
}

export function playBlob(blob) {
  stopPlayback(); // previews obey the one-sound rule too
  const audio = getSharedAudioElement();
  const url = URL.createObjectURL(blob);
  audio.src = url;
  audio.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true });
  return audio.play();
}

// Decoded audio, cached per Blob so replaying a clip (or reusing a carrier
// phrase across many words) doesn't re-decode. WeakMap so it's freed with the
// Blob.
const decodedCache = new WeakMap();
async function decodeBlob(ctx, blob) {
  const cached = decodedCache.get(blob);
  if (cached) return cached;
  const arrayBuffer = await blob.arrayBuffer();
  // Safari historically only supports the callback form of decodeAudioData.
  const buffer = await new Promise((resolve, reject) => {
    const p = ctx.decodeAudioData(arrayBuffer, resolve, reject);
    if (p && p.then) p.then(resolve, reject);
  });
  decodedCache.set(blob, buffer);
  return buffer;
}

// Can this device actually decode (and therefore play) the clip? Used by the
// family-recordings import to keep unplayable audio out of the database —
// e.g. an Android phone records webm/opus, which older iOS Safari can't play.
// Decodes a copy; the blob itself is untouched.
export async function canDecodeAudio(blob) {
  const ctx = getAudioContext();
  if (!ctx) return true; // nothing to check with — let it through
  try {
    const arrayBuffer = await blob.arrayBuffer();
    await new Promise((resolve, reject) => {
      const p = ctx.decodeAudioData(arrayBuffer, resolve, reject);
      if (p && p.then) p.then(resolve, reject);
    });
    return true;
  } catch {
    return false;
  }
}

// Find the speech span within a clip by trimming leading/trailing near-silence,
// keeping a small guard margin so we don't clip the very edges of the sound.
// Returns { offset, duration } in seconds for AudioBufferSourceNode.start().
function speechSpan(buffer, threshold = 0.02, guardSec = 0.03) {
  const data = buffer.getChannelData(0);
  const n = data.length;
  let start = 0;
  while (start < n && Math.abs(data[start]) < threshold) start++;
  let end = n;
  while (end > start && Math.abs(data[end - 1]) < threshold) end--;
  if (start >= end) return { offset: 0, duration: buffer.duration }; // silent → play whole
  const guard = Math.floor(guardSec * buffer.sampleRate);
  start = Math.max(0, start - guard);
  end = Math.min(n, end + guard);
  return { offset: start / buffer.sampleRate, duration: (end - start) / buffer.sampleRate };
}

// Plays blobs one after another (e.g. "Klik op de" then "banaan"). Uses the
// Web Audio API to schedule the clips back-to-back with sample-accurate timing
// and trimmed silence, so there's no reload gap between them. Falls back to the
// simple <audio> element player if Web Audio or decoding isn't available.
// Falsy entries are skipped.
//
// Enforces the single-playback rule (see stopPlayback above) via `key`.
// Resolves with { completed: true } when the last clip finished,
// { cancelled: true } when a different sound cut this one off, or
// { duplicate: true } when this key was already playing (nothing started).
// Callers chaining follow-up audio should bail unless `completed`.
export async function playBlobSequence(blobs, { key = null } = {}) {
  const queue = blobs.filter(Boolean);
  if (queue.length === 0) return { completed: true };

  if (activeSequence && key != null && activeSequence.key === key) {
    return { duplicate: true }; // same sound already playing — let it finish
  }
  stopPlayback();

  // Register before any await so a competing call can cancel us mid-decode.
  const seq = { key, sources: [], element: null, cancelled: false, settle: null };
  const done = new Promise((resolve) => {
    seq.settle = resolve; // resolves at most once; later calls are no-ops
  });
  activeSequence = seq;
  const finish = () => {
    if (activeSequence === seq) activeSequence = null;
    seq.settle({ completed: true });
  };

  const ctx = getAudioContext();
  if (ctx) {
    try {
      if (ctx.state === 'suspended') await ctx.resume();
      const buffers = await Promise.all(queue.map((b) => decodeBlob(ctx, b)));
      if (seq.cancelled) return done;
      let when = ctx.currentTime + 0.03; // tiny lead-in so scheduling is reliable
      let last = null;
      for (const buffer of buffers) {
        const { offset, duration } = speechSpan(buffer);
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        src.start(when, offset, duration);
        when += duration; // next clip begins exactly as this one's speech ends
        seq.sources.push(src);
        last = src;
      }
      if (last) last.onended = finish;
      else finish();
      return done;
    } catch {
      // Fall through to the element-based player below.
    }
  }
  if (seq.cancelled) return done;
  playBlobSequenceViaElement(queue, seq, finish);
  return done;
}

// Fallback: sequential playback on the shared <audio> element (has an audible
// gap between clips, but always works). Checks seq.cancelled between clips so
// a cut-off can't keep the chain going.
function playBlobSequenceViaElement(queue, seq, finish) {
  const audio = getSharedAudioElement();
  seq.element = audio;
  let i = 0;
  function playNext() {
    if (seq.cancelled) return;
    if (i >= queue.length) {
      finish();
      return;
    }
    const url = URL.createObjectURL(queue[i++]);
    const onEnded = () => {
      URL.revokeObjectURL(url);
      audio.removeEventListener('ended', onEnded);
      playNext();
    };
    audio.addEventListener('ended', onEnded, { once: true });
    audio.src = url;
    audio.play().catch(() => {
      audio.removeEventListener('ended', onEnded);
      // Treat an unplayable clip like a finished one so callers still settle.
      if (!seq.cancelled) finish();
    });
  }
  playNext();
}
