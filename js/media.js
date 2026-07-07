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
export async function recordAudio({ maxMs = 6000 } = {}) {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
    throw new Error('This browser has no microphone API available.');
  }

  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (err) {
    throw new Error('Microphone permission was denied, or no microphone is available.');
  }

  const mimeType = pickSupportedMimeType();
  const recorder = mimeType ? new MediaRecorder(stream, { mimeType }) : new MediaRecorder(stream);
  const chunks = [];
  const startedAt = Date.now();
  const stopAllTracks = () => stream.getTracks().forEach((track) => track.stop());

  recorder.addEventListener('dataavailable', (e) => {
    if (e.data && e.data.size > 0) chunks.push(e.data);
  });

  const result = new Promise((resolve) => {
    recorder.addEventListener('stop', () => {
      stopAllTracks();
      const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || 'audio/webm' });
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
      stopAllTracks();
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

// Call once, directly inside a user-gesture (tap) handler, before any
// programmatic (non-gesture) playback is attempted later in the session.
export function unlockAudio() {
  const audio = getSharedAudioElement();
  audio.muted = true;
  const p = audio.play();
  if (p && p.catch) p.catch(() => {});
  audio.pause();
  audio.muted = false;
}

export function playBlob(blob) {
  const audio = getSharedAudioElement();
  const url = URL.createObjectURL(blob);
  audio.src = url;
  audio.addEventListener('ended', () => URL.revokeObjectURL(url), { once: true });
  return audio.play();
}

// Plays blobs one after another on the shared element (e.g. word audio then
// phrase audio). Falsy entries are skipped. Resolves once the last one ends.
export function playBlobSequence(blobs) {
  const queue = blobs.filter(Boolean);
  if (queue.length === 0) return Promise.resolve();
  const audio = getSharedAudioElement();

  return new Promise((resolve, reject) => {
    let i = 0;
    function playNext() {
      if (i >= queue.length) {
        resolve();
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
      audio.play().catch((err) => {
        audio.removeEventListener('ended', onEnded);
        reject(err);
      });
    }
    playNext();
  });
}
