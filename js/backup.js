import { getAll, putAllTransactional } from './db.js?v=21';

// Import order is strict: (1) validate the whole file, (2) decode every
// photo/audio back into Blobs, (3) only then write — in a single
// all-or-nothing transaction. Nothing touches the database until steps
// 1 and 2 have fully succeeded, so a bad or oversized file can never
// leave it half-imported. (Step order also matters technically: an
// IndexedDB transaction auto-commits the moment you await anything
// non-IndexedDB, so all decoding must finish before the write begins.)
const SUPPORTED_FORMAT_VERSIONS = [1];

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

export async function buildExportPayload() {
  const [categories, words] = await Promise.all([getAll('categories'), getAll('words')]);
  const exportedWords = await Promise.all(
    words.map(async (w) => ({
      ...w,
      photo: w.photo ? await blobToDataUrl(w.photo) : null,
      audioWord: w.audioWord ? await blobToDataUrl(w.audioWord) : null,
      audioPhrase: w.audioPhrase ? await blobToDataUrl(w.audioPhrase) : null,
    }))
  );
  return {
    formatVersion: 1,
    exportedAt: Date.now(),
    categories,
    words: exportedWords,
  };
}

// Above this size, the Gist-based sharing flow becomes unreliable (GitHub
// stops serving big gist files the simple way well before 10 MB, and
// base64 already inflated the media by ~a third). Backups are never
// blocked by size — this only gates the sharing path.
const SHARE_SIZE_WARN_MB = 8;

// Tries the native share sheet first (lets you AirDrop/Message/email the
// file directly on iOS); falls back to a plain download if unsupported.
// Pass { warnLargeShare: true } when the file is destined for the shared
//-link flow, so oversized exports get flagged before leaving the phone.
export async function exportAndShare({ warnLargeShare = false } = {}) {
  const payload = await buildExportPayload();
  const json = JSON.stringify(payload);
  const sizeMB = (json.length / 1024 / 1024).toFixed(1);

  if (warnLargeShare && Number(sizeMB) > SHARE_SIZE_WARN_MB) {
    const proceed = confirm(
      `This export is large (~${sizeMB} MB). Shared links may fail above ${SHARE_SIZE_WARN_MB} MB. You can still save it as a backup, but sharing might not work. Continue anyway?`
    );
    if (!proceed) return { method: 'cancelled', sizeMB };
  }
  const blob = new Blob([json], { type: 'application/json' });
  const file = new File([blob], 'antosias-app-export.json', { type: 'application/json' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "Antosia's app export" });
      return { method: 'share', sizeMB };
    } catch (err) {
      if (err.name === 'AbortError') return { method: 'cancelled', sizeMB };
      // fall through to the download fallback below
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'antosias-app-export.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return { method: 'download', sizeMB };
}

// Whole-file integrity: if these fail the file isn't a usable export at all,
// so we refuse rather than guess. (Individual malformed records are handled
// separately below — one stray record must never sink an entire restore.)
function assertStructurallyValid(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('This file does not look like an export from this app.');
  }
  if (!SUPPORTED_FORMAT_VERSIONS.includes(payload.formatVersion)) {
    throw new Error(
      'This backup was made by a newer version of the app than the one running now. Update the app first, then import again.'
    );
  }
  if (!Array.isArray(payload.categories) || !Array.isArray(payload.words)) {
    throw new Error('This export file is incomplete or damaged (missing categories or words).');
  }
}

const isUsableCategory = (c) => c && typeof c.id === 'string' && typeof c.name === 'string';
// A word needs an id, a word text, and a real category to belong to. Records
// with a null/empty categoryId (e.g. leftover test entries) can never be
// shown in the app, so they're dropped rather than carried forward.
const isUsableWord = (w) =>
  w && typeof w.id === 'string' && typeof w.word === 'string' && typeof w.categoryId === 'string' && w.categoryId !== '';

// Existing records with the same id are overwritten; everything else is left
// alone (merge-by-id). Unusable individual records are skipped and counted;
// all usable records are written together in one all-or-nothing transaction.
// Returns a summary so callers can tell the user what happened.
export async function importPayload(payload) {
  assertStructurallyValid(payload);

  const categories = payload.categories.filter(isUsableCategory);
  const usableWords = payload.words.filter(isUsableWord);
  const skipped =
    (payload.categories.length - categories.length) + (payload.words.length - usableWords.length);

  const words = await Promise.all(
    usableWords.map(async (w) => ({
      ...w,
      photo: w.photo ? await dataUrlToBlob(w.photo) : null,
      audioWord: w.audioWord ? await dataUrlToBlob(w.audioWord) : null,
      audioPhrase: w.audioPhrase ? await dataUrlToBlob(w.audioPhrase) : null,
    }))
  );

  await putAllTransactional({ categories, words });
  return { categories: categories.length, words: words.length, skipped };
}

// Secret Gists are readable by anyone with the exact ID via GitHub's public
// API, with no auth needed — that's what makes an unlisted link work.
export async function importFromGist(gistId) {
  const res = await fetch(`https://api.github.com/gists/${gistId}`);
  if (!res.ok) throw new Error(`Could not load shared data (status ${res.status})`);
  const gist = await res.json();
  const file = Object.values(gist.files || {})[0];
  if (!file) throw new Error('Shared data file not found in that link');

  // The gists API truncates file content over ~1MB; real exports (with
  // photos/audio inlined) easily exceed that, so fetch the raw file instead.
  let text = file.content;
  if (file.truncated || !text) {
    const rawRes = await fetch(file.raw_url);
    if (!rawRes.ok) throw new Error(`Could not load shared data file (status ${rawRes.status})`);
    text = await rawRes.text();
  }

  const payload = JSON.parse(text);
  await importPayload(payload);
}
