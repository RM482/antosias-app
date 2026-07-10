import { getAll, putAllTransactional, newId, wordLabel, wordRecordingId, carrierRecordingId } from './db.js?v=34';
import { canDecodeAudio } from './media.js?v=34';

// Import order is strict: (1) validate the whole file, (2) decode every
// photo/audio back into Blobs, (3) only then write — in a single
// all-or-nothing transaction. Nothing touches the database until steps
// 1 and 2 have fully succeeded, so a bad or oversized file can never
// leave it half-imported. (Step order also matters technically: an
// IndexedDB transaction auto-commits the moment you await anything
// non-IndexedDB, so all decoding must finish before the write begins.)
// v1: photos inline on each word. v2 adds the shared photos store (words may
// carry a photoId instead of an inline photo). v3 adds `people` and
// `recordings` (Stage 6 family voices). Older files still import fine — the
// missing sections just default to empty.
const SUPPORTED_FORMAT_VERSIONS = [1, 2, 3];

export function blobToDataUrl(blob) {
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
  const [categories, words, photos, people, recordings] = await Promise.all([
    getAll('categories'),
    getAll('words'),
    getAll('photos'),
    getAll('people'),
    getAll('recordings'),
  ]);
  const exportedWords = await Promise.all(
    words.map(async (w) => ({
      ...w,
      photo: w.photo ? await blobToDataUrl(w.photo) : null,
      audioWord: w.audioWord ? await blobToDataUrl(w.audioWord) : null,
      audioPhrase: w.audioPhrase ? await blobToDataUrl(w.audioPhrase) : null,
    }))
  );
  // The shared photos store: exported once per photo, even when several words
  // (Dutch + Polish) reference the same picture via photoId.
  const exportedPhotos = await Promise.all(
    photos.map(async (p) => ({ id: p.id, blob: p.blob ? await blobToDataUrl(p.blob) : null }))
  );
  const exportedPeople = await Promise.all(
    people.map(async (p) => ({
      ...p,
      photo: p.photo ? await blobToDataUrl(p.photo) : null,
      introAudio: p.introAudio ? await blobToDataUrl(p.introAudio) : null,
    }))
  );
  const exportedRecordings = await Promise.all(
    recordings.map(async (r) => ({
      ...r,
      audioWord: r.audioWord ? await blobToDataUrl(r.audioWord) : null,
      audioPhrase: r.audioPhrase ? await blobToDataUrl(r.audioPhrase) : null,
      blob: r.blob ? await blobToDataUrl(r.blob) : null,
    }))
  );
  return {
    formatVersion: 3,
    exportedAt: Date.now(),
    categories,
    words: exportedWords,
    photos: exportedPhotos,
    people: exportedPeople,
    recordings: exportedRecordings,
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
  return shareJsonFile({ json, filename: 'antosias-app-export.json', title: "Antosia's app export", sizeMB });
}

// Offers a JSON file through the native share sheet (AirDrop/WhatsApp/etc. on
// phones), falling back to a plain download. Shared by backups, recording
// requests, and the family recording page's "send back" step.
export async function shareJsonFile({ json, filename, title, sizeMB = null }) {
  const blob = new Blob([json], { type: 'application/json' });
  const file = new File([blob], filename, { type: 'application/json' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title });
      return { method: 'share', sizeMB };
    } catch (err) {
      if (err.name === 'AbortError') return { method: 'cancelled', sizeMB };
      // fall through to the download fallback below
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
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
  // photos is absent in v1 files; each entry needs an id and image data.
  const usablePhotos = (payload.photos || []).filter(
    (p) => p && typeof p.id === 'string' && typeof p.blob === 'string'
  );
  // people/recordings are absent in v1/v2 files.
  const usablePeople = (payload.people || []).filter(
    (p) => p && typeof p.id === 'string' && typeof p.name === 'string'
  );
  const usableRecordings = (payload.recordings || []).filter(
    (r) => r && typeof r.id === 'string' && typeof r.personId === 'string'
  );
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
  const photos = await Promise.all(
    usablePhotos.map(async (p) => ({ id: p.id, blob: await dataUrlToBlob(p.blob) }))
  );
  const people = await Promise.all(
    usablePeople.map(async (p) => ({
      ...p,
      photo: p.photo ? await dataUrlToBlob(p.photo) : null,
      introAudio: p.introAudio ? await dataUrlToBlob(p.introAudio) : null,
    }))
  );
  const recordings = await Promise.all(
    usableRecordings.map(async (r) => ({
      ...r,
      audioWord: r.audioWord ? await dataUrlToBlob(r.audioWord) : null,
      audioPhrase: r.audioPhrase ? await dataUrlToBlob(r.audioPhrase) : null,
      blob: r.blob ? await dataUrlToBlob(r.blob) : null,
    }))
  );

  await putAllTransactional({ categories, words, photos, people, recordings });
  return {
    categories: categories.length,
    words: words.length,
    people: people.length,
    recordings: recordings.length,
    skipped,
  };
}

// Secret Gists are readable by anyone with the exact ID via GitHub's public
// API, with no auth needed — that's what makes an unlisted link work.
// Returns the raw file TEXT (callers parse it themselves — the recording
// page checks size limits on the raw text before JSON.parse).
export async function fetchGistText(gistId) {
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
  return text;
}

export async function importFromGist(gistId) {
  const payload = JSON.parse(await fetchGistText(gistId));
  await importPayload(payload);
}

// --- Family recording responses (Stage 6 Phase C) -------------------------------
// Two stages so the UI can put its confirm dialogs in between:
// analyzeRecordingResponse validates + decodes + decode-checks EVERYTHING
// without touching the database; applyRecordingResponse then writes the
// person + recordings in one transaction (contracts C3/C6).

export async function analyzeRecordingResponse(payload) {
  if (!payload || typeof payload !== 'object' || payload.formatVersion !== 'recording-response-1') {
    throw new Error('This file is not a family recording response from this app.');
  }
  if (typeof payload.personName !== 'string' || !payload.personName.trim()) {
    throw new Error('This recording file is damaged (no person name).');
  }
  const language = payload.language === 'pl' ? 'pl' : 'nl';
  const personName = payload.personName.trim();

  const [words, people] = await Promise.all([getAll('words'), getAll('people')]);
  const wordById = new Map(words.map((w) => [w.id, w]));
  const existingPerson =
    people.find(
      (p) => p.language === language && (p.name || '').trim().toLowerCase() === personName.toLowerCase()
    ) || null;

  const unplayable = []; // labels of clips this phone can't decode
  const skippedWordIds = []; // recorded for words deleted since the request
  const wordRows = [];
  for (const item of payload.words || []) {
    if (!item || typeof item.wordId !== 'string' || typeof item.audioWord !== 'string') continue;
    const word = wordById.get(item.wordId);
    if (!word) {
      skippedWordIds.push(item.wordId);
      continue;
    }
    const audioWord = await dataUrlToBlob(item.audioWord);
    if (!(await canDecodeAudio(audioWord))) {
      unplayable.push(wordLabel(word) || word.word);
      continue;
    }
    let audioPhrase = null;
    if (typeof item.audioPhrase === 'string') {
      audioPhrase = await dataUrlToBlob(item.audioPhrase);
      if (!(await canDecodeAudio(audioPhrase))) audioPhrase = null; // keep the word, drop the phrase
    }
    wordRows.push({ wordId: item.wordId, audioWord, audioPhrase });
  }

  const carrierRows = [];
  for (const item of payload.carriers || []) {
    if (!item || typeof item.name !== 'string' || typeof item.blob !== 'string') continue;
    const blob = await dataUrlToBlob(item.blob);
    if (!(await canDecodeAudio(blob))) {
      unplayable.push(`game phrase "${item.name}"`);
      continue;
    }
    carrierRows.push({ name: item.name, blob });
  }

  let personPhoto = null;
  if (typeof payload.personPhoto === 'string') personPhoto = await dataUrlToBlob(payload.personPhoto);
  let introAudio = null;
  if (typeof payload.introAudio === 'string') {
    introAudio = await dataUrlToBlob(payload.introAudio);
    if (!(await canDecodeAudio(introAudio))) {
      unplayable.push('the intro clip');
      introAudio = null;
    }
  }

  return {
    language,
    personName,
    existingPerson,
    personPhoto,
    introAudio,
    wordRows,
    carrierRows,
    unplayable,
    skippedCount: skippedWordIds.length,
  };
}

export async function applyRecordingResponse(analysis) {
  const now = Date.now();
  const base = analysis.existingPerson;
  // Contract C6: a null photo/intro in the response never wipes an existing one.
  const person = base
    ? {
        ...base,
        photo: analysis.personPhoto || base.photo,
        introAudio: analysis.introAudio || base.introAudio,
        updatedAt: now,
      }
    : {
        id: newId(),
        name: analysis.personName,
        language: analysis.language,
        photo: analysis.personPhoto,
        introAudio: analysis.introAudio,
        inCollage: true,
        isDefaultVoice: false,
        createdAt: now,
        updatedAt: now,
      };

  const recordings = [
    ...analysis.wordRows.map((r) => ({
      id: wordRecordingId(person.id, r.wordId),
      personId: person.id,
      type: 'word',
      wordId: r.wordId,
      audioWord: r.audioWord,
      audioPhrase: r.audioPhrase,
      updatedAt: now,
    })),
    ...analysis.carrierRows.map((r) => ({
      id: carrierRecordingId(person.id, analysis.language, r.name),
      personId: person.id,
      type: 'carrier',
      language: analysis.language,
      name: r.name,
      blob: r.blob,
      updatedAt: now,
    })),
  ];

  await putAllTransactional({ people: [person], recordings });
  return { person, words: analysis.wordRows.length, carriers: analysis.carrierRows.length };
}
