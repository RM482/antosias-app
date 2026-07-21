import { getAll, putAllTransactional, newId, wordLabel, wordRecordingId, carrierRecordingId } from './db.js?v=44';
import { canDecodeAudio } from './media.js?v=44';

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

// How a record identifies itself in the omission report. Falls back to the
// store + position so a row with no id and no name is still nameable — "we
// dropped something, somewhere" is exactly the report this fix exists to stop.
function rowIdentity(store, row, index) {
  const id = row && typeof row.id === 'string' && row.id ? row.id : null;
  const label =
    row && typeof row.word === 'string' && row.word
      ? row.word
      : row && typeof row.name === 'string' && row.name
        ? row.name
        : null;
  if (id && label) return `${label} (${id})`;
  return id || label || `${store}[${index}]`;
}

// Splits "what would this file do" from "do it", so the parent can be shown
// exactly what is unusable BEFORE anything is written.
//
// Previously these rows were filtered away and only categories and words were
// even counted, so a damaged photo, person or recording vanished from an
// apparently successful restore without ever being mentioned. Silent loss in
// the one mechanism that exists to recover from loss.
//
// Pure and synchronous: no decoding, no database access. Returns the usable
// rows plus an itemised list of everything omitted and why.
// Media travels as a base64 `data:` URL with a real media type and a payload.
// Anything else — an empty string, `data:,`, a stray "null", an http URL — is
// damaged, and must never reach `fetch()`.
// Structural check only. Deliberately no minimum length: a 1×1 PNG is a valid
// ~70-character data URL, and rejecting media merely for being small would
// discard data we cannot show is bad. Proving the bytes actually DECODE is
// C-P6's job in the backup-hardening step — until then a correctly-labelled but
// corrupt clip still passes here.
// The type is restricted to image/audio because that is all these fields ever
// hold; `data:text/html;base64,…` is not media and must not be written over
// one. The payload length must be a valid base64 multiple of 4.
const DATA_URL_RE = /^data:(image|audio|video)\/[a-z0-9.+-]+(;[a-z0-9-]+=[^;,]*)*;base64,([A-Za-z0-9+/]{4})*([A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/i;
const isUsableMedia = (v) => {
  if (typeof v !== 'string' || !DATA_URL_RE.test(v)) return false;
  const payload = v.slice(v.indexOf(',') + 1);
  return payload.length > 0 && payload.length % 4 === 0;
};

const MEDIA_FIELDS = {
  words: ['photo', 'audioWord', 'audioPhrase'],
  people: ['photo', 'introAudio'],
  recordings: ['audioWord', 'audioPhrase', 'blob'],
  photos: ['blob'],
  categories: [],
};

const damagedFields = (store, row) =>
  (MEDIA_FIELDS[store] || []).filter((f) => row[f] != null && !isUsableMedia(row[f]));

// `existingIds` is `{ store: Set<id> }` for what the database already holds —
// read by the caller and passed in so this stays pure and write-free. It is
// what lets a damaged row be handled correctly: see the media rules below.
export function analyzeImportPayload(payload, { existingIds = {} } = {}) {
  assertStructurallyValid(payload);
  const omitted = [];
  const guardedIds = {};
  const has = (store, id) => !!(existingIds[store] && existingIds[store].has(id));

  const collect = (store, rows, isUsable, reason) => {
    const valid = [];
    (rows || []).forEach((row, index) => {
      if (!isUsable(row)) {
        omitted.push({ store, index, identity: rowIdentity(store, row, index), reason });
        return;
      }
      valid.push({ row, index });
    });

    // Two rows with one id: the transaction would put() both and the second
    // would silently replace the first, while the summary counted two. Pick the
    // copy that PRESERVES THE MOST MEDIA, not merely the first, and not the one
    // with the fewest damaged fields — by that measure a copy carrying no media
    // at all beats a copy with a good photo and one broken clip, and her only
    // photo would be thrown away. Ties keep the earlier copy.
    const usableCount = (row) => (MEDIA_FIELDS[store] || []).filter((f) => isUsableMedia(row[f])).length;
    const byId = new Map();
    for (const entry of valid) {
      const prev = byId.get(entry.row.id);
      if (!prev) { byId.set(entry.row.id, entry); continue; }
      const a = usableCount(entry.row);
      const b = usableCount(prev.row);
      const better =
        a > b || (a === b && damagedFields(store, entry.row).length < damagedFields(store, prev.row).length)
          ? entry
          : prev;
      const worse = better === entry ? prev : entry;
      byId.set(entry.row.id, better);
      omitted.push({
        store,
        index: worse.index,
        kind: 'duplicate',
        identity: rowIdentity(store, worse.row, worse.index),
        reason: 'a second copy of this same entry in the file; the more complete copy was used',
      });
    }

    // Rows whose media is damaged. Which way this goes depends on whether the
    // record already exists here, because `put()` REPLACES the whole record:
    //   • already on the phone → skip the row entirely. Writing it would blank
    //     a recording that is currently fine. The live copy is left untouched.
    //   • not on the phone (a wipe/reinstall restore) → keep it with the broken
    //     field emptied. The word's text is worth having; there is nothing live
    //     to protect.
    // Either way it is reported by name.
    const out = [];
    const guarded = new Set();
    for (const { row, index } of byId.values()) {
      const broken = damagedFields(store, row);
      if (broken.length === 0) { out.push(row); continue; }
      const live = has(store, row.id);
      omitted.push({
        store,
        index,
        field: broken.join(', '),
        kind: live ? 'skipped' : 'repaired',
        identity: rowIdentity(store, row, index),
        reason: live
          ? `its ${broken.join(' and ')} in this file is damaged — the copy already on the phone was left alone`
          : `its ${broken.join(' and ')} is damaged, so it comes back without that part`,
      });
      if (!live) {
        const cleaned = { ...row };
        for (const f of broken) cleaned[f] = null;
        out.push(cleaned);
        // Absent when analysed, but something could be written before the
        // restore transaction opens. Guarded rows are re-checked inside it.
        guarded.add(row.id);
      }
    }
    guardedIds[store] = guarded;
    return out;
  };

  const categories = collect('categories', payload.categories, isUsableCategory, 'missing an id or a name');
  const words = collect('words', payload.words, isUsableWord, 'missing an id, its text, or its category');
  // photos is absent in v1 files. A photo IS its image, so unlike a word there
  // is no salvageable remainder — a damaged one is rejected outright rather
  // than kept with an empty blob.
  const photos = collect(
    'photos',
    payload.photos,
    (p) => p && typeof p.id === 'string' && isUsableMedia(p.blob),
    'missing an id, or its picture is damaged'
  );
  // people/recordings are absent in v1/v2 files.
  const people = collect(
    'people',
    payload.people,
    (p) => p && typeof p.id === 'string' && typeof p.name === 'string',
    'missing an id or a name'
  );
  const recordings = collect(
    'recordings',
    payload.recordings,
    (r) => r && typeof r.id === 'string' && typeof r.personId === 'string',
    'missing an id or the person it belongs to'
  );

  return { usable: { categories, words, photos, people, recordings }, omitted, guardedIds };
}

// Decodes every photo/audio back into Blobs and writes them in ONE
// all-or-nothing transaction. Decoding happens first and outside the
// transaction (see the header note), so a decode failure aborts with zero
// writes rather than leaving a half-restored database.
export async function applyImportPayload(analysis) {
  const {
    categories,
    words: usableWords,
    photos: usablePhotos,
    people: usablePeople,
    recordings: usableRecordings,
  } = analysis.usable;

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

  await putAllTransactional(
    { categories, words, photos, people, recordings },
    'restoring data',
    { skipIfPresent: analysis.guardedIds || {} }
  );
  return {
    categories: categories.length,
    words: words.length,
    photos: photos.length,
    people: people.length,
    recordings: recordings.length,
    omitted: analysis.omitted,
    // Only rows that were genuinely NOT written count as skipped. A repaired
    // row (restored without its damaged clip) and a duplicate that lost to a
    // more complete copy are reported, but they are not losses of an entry.
    skipped: analysis.omitted.filter((o) => o.kind !== 'repaired' && o.kind !== 'duplicate').length,
    repaired: analysis.omitted.filter((o) => o.kind === 'repaired').length,
  };
}

// Existing records with the same id are overwritten; everything else is left
// alone (merge-by-id).
//
// REFUSES by default when any record would be omitted: a caller that cannot
// show the parent what is being dropped must not drop anything. The restore
// screen analyses first, lists the omissions, and only then calls this with
// `allowOmissions` after an explicit confirmation.
// Reads which ids the database already holds, so analysis can tell a
// wipe-recovery restore (nothing to protect) from a merge into live data
// (where writing a damaged row would destroy a good one).
export async function readExistingIds() {
  const stores = ['categories', 'words', 'photos', 'people', 'recordings'];
  const sets = await Promise.all(
    stores.map(async (s) => [s, new Set((await getAll(s)).map((r) => r.id))])
  );
  return Object.fromEntries(sets);
}

export async function importPayload(payload, { allowOmissions = false } = {}) {
  const analysis = analyzeImportPayload(payload, { existingIds: await readExistingIds() });
  if (analysis.omitted.length > 0 && !allowOmissions) {
    const names = analysis.omitted.slice(0, 5).map((o) => `${o.store}: ${o.identity}`).join(', ');
    const more = analysis.omitted.length > 5 ? `, and ${analysis.omitted.length - 5} more` : '';
    throw new Error(
      `This file has ${analysis.omitted.length} unusable entr${analysis.omitted.length === 1 ? 'y' : 'ies'} (${names}${more}). Nothing was imported.`
    );
  }
  return applyImportPayload(analysis);
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
