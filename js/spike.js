import { requestPersistentStorage, get, put, remove } from './db.js?v=50';
import { downscaleImage, recordAudio, playBlob, unlockAudio } from './media.js?v=50';

const logEl = document.getElementById('log');
function logLine(msg) {
  const time = new Date().toLocaleTimeString();
  logEl.textContent += `[${time}] ${msg}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

// --- 1. Install / standalone check -----------------------------------

function checkStandalone() {
  const isStandalone =
    window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
  document.getElementById('install-status').textContent = isStandalone
    ? '✅ Running standalone (installed to Home Screen).'
    : '➖ Running in the browser tab, not installed yet.';
  return isStandalone;
}
checkStandalone();

// --- 2. Persistent storage check -----------------------------------

document.getElementById('check-storage-btn').addEventListener('click', async () => {
  const el = document.getElementById('storage-status');
  try {
    const { supported, persisted, estimate } = await requestPersistentStorage();
    if (!supported) {
      el.textContent = '⚠️ Storage persistence API not supported here.';
      logLine('Storage: persistence API unsupported');
      return;
    }
    const usedMB = estimate ? (estimate.usage / 1024 / 1024).toFixed(2) : '?';
    const quotaMB = estimate ? (estimate.quota / 1024 / 1024).toFixed(0) : '?';
    el.textContent = `${persisted ? '✅ Persisted' : '⚠️ Not persisted (may be evicted)'} — using ${usedMB} MB of ${quotaMB} MB.`;
    logLine(`Storage: persisted=${persisted}, usage=${usedMB}MB, quota=${quotaMB}MB`);
  } catch (err) {
    el.textContent = `❌ Error: ${err.message}`;
    logLine(`Storage check error: ${err.message}`);
  }
});

// --- 3. Photo capture -----------------------------------

let lastPhotoBlob = null;
const photoPreview = document.getElementById('photo-preview');
const photoStatus = document.getElementById('photo-status');

async function handlePhotoInput(file, source) {
  unlockAudio();
  if (!file) return;
  try {
    const originalKB = (file.size / 1024).toFixed(0);
    const downscaled = await downscaleImage(file);
    const finalKB = (downscaled.size / 1024).toFixed(0);
    lastPhotoBlob = downscaled;
    photoPreview.src = URL.createObjectURL(downscaled);
    photoPreview.hidden = false;
    photoStatus.textContent = `✅ ${source}: ${originalKB}KB → ${finalKB}KB after downscale.`;
    logLine(`Photo (${source}): ${originalKB}KB -> ${finalKB}KB`);
    updateSaveButtonState();
  } catch (err) {
    photoStatus.textContent = `❌ Error: ${err.message}`;
    logLine(`Photo error: ${err.message}`);
  }
}

document.getElementById('take-photo-input').addEventListener('change', (e) => {
  handlePhotoInput(e.target.files[0], 'Take Photo');
  e.target.value = '';
});
document.getElementById('choose-photo-input').addEventListener('change', (e) => {
  handlePhotoInput(e.target.files[0], 'Choose Photo');
  e.target.value = '';
});

// --- 4. Audio recording -----------------------------------

let lastAudioBlob = null;
const recordBtn = document.getElementById('record-word-btn');
const playBtn = document.getElementById('play-word-btn');
const audioStatus = document.getElementById('audio-status');
let activeController = null;

recordBtn.addEventListener('click', async () => {
  unlockAudio();
  if (activeController) {
    activeController.stop();
    return;
  }
  try {
    audioStatus.textContent = '🔴 Recording… (auto-stops at 6s)';
    recordBtn.textContent = 'Stop recording';
    const controller = await recordAudio({ maxMs: 6000 });
    activeController = controller;
    const { blob, mimeType, durationMs } = await controller.result;
    activeController = null;
    recordBtn.textContent = 'Record word (max 6s)';
    lastAudioBlob = blob;
    const sizeKB = (blob.size / 1024).toFixed(0);
    audioStatus.textContent = `✅ Recorded ${(durationMs / 1000).toFixed(1)}s, ${mimeType || 'unknown type'}, ${sizeKB}KB.`;
    logLine(`Audio: ${mimeType}, ${(durationMs / 1000).toFixed(1)}s, ${sizeKB}KB`);
    playBtn.disabled = false;
    updateSaveButtonState();
  } catch (err) {
    recordBtn.textContent = 'Record word (max 6s)';
    audioStatus.textContent = `❌ ${err.message}`;
    logLine(`Audio error: ${err.message}`);
    activeController = null;
  }
});

playBtn.addEventListener('click', () => {
  if (!lastAudioBlob) return;
  playBlob(lastAudioBlob).catch((err) => logLine(`Playback error: ${err.message}`));
});

// --- 5. IndexedDB persistence test -----------------------------------

const TEST_DATA_KEY = 'spike-test-data';
const saveBtn = document.getElementById('save-test-word-btn');
const clearBtn = document.getElementById('clear-test-word-btn');
const dbStatus = document.getElementById('db-status');

function updateSaveButtonState() {
  saveBtn.disabled = !(lastPhotoBlob || lastAudioBlob);
}

saveBtn.addEventListener('click', async () => {
  try {
    await put('meta', {
      key: TEST_DATA_KEY,
      value: {
        photo: lastPhotoBlob,
        audioWord: lastAudioBlob,
        savedAt: Date.now(),
      },
    });
    dbStatus.textContent =
      '✅ Saved to IndexedDB. Force-quit the app and reopen this page to confirm it survives.';
    logLine(
      `IndexedDB: saved test word (photo=${lastPhotoBlob ? 'yes' : 'no'}, audio=${lastAudioBlob ? 'yes' : 'no'})`
    );
  } catch (err) {
    dbStatus.textContent = `❌ ${err.message}`;
    logLine(`IndexedDB save error: ${err.message}`);
  }
});

clearBtn.addEventListener('click', async () => {
  await remove('meta', TEST_DATA_KEY);
  dbStatus.textContent = 'Test data cleared.';
  logLine('IndexedDB: cleared test data');
});

async function checkExistingTestWord() {
  const existing = await get('meta', TEST_DATA_KEY);
  if (existing) {
    const photoKB = existing.value.photo ? (existing.value.photo.size / 1024).toFixed(0) : null;
    const audioKB = existing.value.audioWord ? (existing.value.audioWord.size / 1024).toFixed(0) : null;
    dbStatus.textContent = `✅ Found previously saved test data (photo: ${
      photoKB ? photoKB + 'KB' : 'none'
    }, audio: ${audioKB ? audioKB + 'KB' : 'none'}) — persistence confirmed across reload.`;
    logLine('IndexedDB: found existing test data on load — persistence confirmed');
  } else {
    dbStatus.textContent = 'No saved test data found yet. Capture a photo/audio above, then tap "Save".';
  }
}

// --- Init -----------------------------------

(async () => {
  logLine('Spike test harness loaded.');
  await checkExistingTestWord();
})();
