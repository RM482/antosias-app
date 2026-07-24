import {
  get,
  getAll,
  put,
  putAllTransactional,
  readSnapshot,
  newId,
  SEED_DATA,
  wordLabel,
  wordRecordingId,
  carrierRecordingId,
} from './db.js?v=50';
import { mediaProblem } from './media.js?v=50';

const CONTENT_STORES = ['categories', 'words', 'photos', 'people', 'recordings'];
const SNAPSHOT_STORES = [...CONTENT_STORES, 'meta'];
const BLOB_TAG = '__antosiaBlobV1';
const SHARE_SIZE_WARN_MB = 8;
const MEDIA_MIME_RE = /^(image|audio|video)\/[^\s;,]+/i;
const MEDIA_FIELDS = {
  words: ['photo', 'audioWord', 'audioPhrase'],
  people: ['photo', 'introAudio'],
  recordings: ['audioWord', 'audioPhrase', 'blob'],
  photos: ['blob'],
  categories: [],
};
const SETTINGS_BACKUP_FIELDS = ['language', 'testOptionCount'];
const INTAKE_META_RE = /^(photoIntake|photoIntake:|intake:)/;
const LEGACY_PHRASE_SLOTS = {
  'phrase-clickon-de': 'clickOnDe',
  'phrase-clickon-het': 'clickOnHet',
  'phrase-correction-een': 'correctionEen',
  'phrase-correction': 'correction',
  'phrase-goed-zo': 'goed',
  'phrase-pl-prompt': 'prompt',
  'phrase-pl-correction': 'correction',
  'phrase-pl-goed': 'goed',
};

const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
const keyFor = (store, row) => (store === 'meta' ? row.key : row.id);
const lexicalCompare = (a, b) => (String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0);
const withoutRev = (row) => {
  if (!row || typeof row !== 'object') return row;
  const copy = { ...row };
  delete copy.rev;
  return copy;
};

export function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

function dataUrlToBlob(dataUrl, { expectedType = null } = {}) {
  if (typeof dataUrl !== 'string') {
    throw new Error('A media value is not a local image/audio data URL.');
  }
  // FileReader is allowed to preserve MIME parameters exactly as supplied by
  // the browser. iOS recordings can therefore produce headers such as
  // `audio/mp4; codecs=mp4a.40.2;base64,...`; the previous all-in-one regex
  // rejected the harmless space. Parse the structural delimiters instead.
  const match =
    /^data:((?:image|audio|video)\/[^\s;,]+(?:;[^,]*)?);base64,([\s\S]*)$/i.exec(dataUrl);
  if (!match) {
    throw new Error('A media value is not a local image/audio data URL.');
  }
  const declaredType = match[1];
  if (
    expectedType != null &&
    (typeof expectedType !== 'string' ||
      !MEDIA_MIME_RE.test(expectedType) ||
      declaredType.match(MEDIA_MIME_RE)?.[1].toLowerCase() !==
        expectedType.match(MEDIA_MIME_RE)?.[1].toLowerCase())
  ) {
    throw new Error('A media value does not match its image/audio type.');
  }
  const base64 = match[2].replace(/[\t\n\f\r ]/g, '');
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(base64)) {
    throw new Error('A media value has invalid base64 data.');
  }
  let binary;
  try {
    binary = atob(base64);
  } catch {
    throw new Error('A media value has invalid base64 data.');
  }
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  // A v4 integrity tag records the original Blob.type separately. Prefer that
  // manifest-bound value: Safari may normalise or omit codec parameters in the
  // FileReader prefix even though the original Blob retained them.
  return new Blob([bytes], { type: expectedType || declaredType });
}

async function sha256(value) {
  const bytes =
    value instanceof Blob
      ? new Uint8Array(await value.arrayBuffer())
      : new TextEncoder().encode(String(value));
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function assertDecodableBlob(blob, path) {
  const imageField =
    path.startsWith('photos[') ||
    /\.photo(?:$|\.)/.test(path) ||
    /\.personPhoto(?:$|\.)/.test(path);
  const problem = await mediaProblem(blob, imageField ? 'image' : 'audio');
  if (problem === 'not-media' || problem === 'empty') {
    throw new Error(`${path} is empty or is not stored as media.`);
  }
  if (problem === 'wrong-type' && imageField) {
    throw new Error(`${path} is not stored as an image.`);
  }
  if (problem === 'wrong-type') {
    throw new Error(`${path} is not stored as audio.`);
  }
  if (problem === 'undecodable-image') {
    throw new Error(`${path} is not a decodable image.`);
  }
  if (problem === 'unplayable-audio') {
    throw new Error(`${path} is not playable audio.`);
  }
}

function filteredMeta(rows) {
  return rows
    .filter((row) => {
      const key = row && row.key;
      return (
        typeof key === 'string' &&
        (key.startsWith('phrase-') ||
          key === 'stickers' ||
          key === 'settings' ||
          key === 'twinAudit' ||
          INTAKE_META_RE.test(key))
      );
    })
    .map((row) => {
      const clean = withoutRev(row);
      if (clean.key !== 'settings') return clean;
      const value = {};
      for (const field of SETTINGS_BACKUP_FIELDS) {
        if (clean.value && own(clean.value, field)) value[field] = clean.value[field];
      }
      return { key: 'settings', value };
    });
}

function sortedRows(store, rows) {
  return [...rows]
    .map((row) => {
      const clean = withoutRev(row);
      if (store === 'words') {
        // `attachPhotos()` decorates words with display-only Blob copies.
        // Older edit flows could accidentally persist `extraPhotos`; the
        // canonical pictures remain in the photos store via extraPhotoIds.
        // Exclude only that derived cache from backup/share/digest data.
        delete clean.extraPhotos;
      }
      return clean;
    })
    .sort((a, b) => lexicalCompare(keyFor(store, a), keyFor(store, b)));
}

function logicalBackupSnapshot(snapshot) {
  const logical = {};
  for (const store of CONTENT_STORES) logical[store] = sortedRows(store, snapshot[store] || []);
  logical.meta = sortedRows('meta', filteredMeta(snapshot.meta || []));
  return logical;
}

const healthReason = {
  'not-media': 'is not stored as media',
  empty: 'is empty',
  'wrong-type': 'has the wrong media type',
  'undecodable-image': 'cannot be opened as an image',
  'unplayable-audio': 'cannot be played on this device',
};

function healthIssue({ id, title, detail, impact, repair }) {
  return {
    id,
    title,
    detail,
    impact,
    repairable: !!repair,
    repair,
  };
}

async function inspectBackupSnapshot(snapshot) {
  const issues = [];
  const categories = new Map((snapshot.categories || []).map((row) => [row.id, row]));
  const words = new Map((snapshot.words || []).map((row) => [row.id, row]));
  const photos = new Map((snapshot.photos || []).map((row) => [row.id, row]));
  const people = new Map((snapshot.people || []).map((row) => [row.id, row]));
  const meta = new Map(filteredMeta(snapshot.meta || []).map((row) => [row.key, row]));

  const add = (issue) => issues.push(healthIssue(issue));
  const checkMedia = async ({
    store,
    key,
    field,
    value,
    kind,
    title,
    impact,
    repair,
    required = false,
  }) => {
    if (value == null && !required) return;
    const problem = await mediaProblem(value, kind);
    if (!problem) return;
    add({
      id: `${store}:${key}:${field}:${problem}`,
      title,
      detail: healthReason[problem] || 'is unusable',
      impact,
      repair,
    });
  };

  for (const category of snapshot.categories || []) {
    if (typeof category.name !== 'string' || !category.name.trim()) {
      add({
        id: `categories:${category.id}:name`,
        title: 'A category has no name',
        detail: `Saved category ${category.id || '(unknown)'}`,
        impact: 'It will be kept as “Recovered category” so its words remain together.',
        repair: { type: 'set-field', store: 'categories', key: category.id, field: 'name', value: 'Recovered category' },
      });
    }
  }

  for (const word of snapshot.words || []) {
    const label = (word.word || word.id || 'Recovered word').trim?.() || 'Recovered word';
    if (
      word.id === 'spike-test-word' &&
      word.word === 'spike-test' &&
      !categories.has(word.categoryId)
    ) {
      add({
        id: 'words:spike-test-word:legacy-test',
        title: 'Old setup test',
        detail: 'The early camera/microphone test is not one of Antosia’s words.',
        impact: 'Only that exact setup-test record and its test-only media will be removed.',
        repair: { type: 'remove-spike', wordId: word.id },
      });
      continue;
    }
    if (typeof word.word !== 'string' || !word.word.trim()) {
      add({
        id: `words:${word.id}:word`,
        title: 'A saved word has no text',
        detail: `Word record ${word.id}`,
        impact: 'Its photos and recordings will be kept under the temporary name “Recovered word”.',
        repair: { type: 'set-field', store: 'words', key: word.id, field: 'word', value: 'Recovered word' },
      });
    }
    if (typeof word.categoryId !== 'string' || !categories.has(word.categoryId)) {
      add({
        id: `words:${word.id}:category`,
        title: `“${label}” has no usable category`,
        detail: 'The word itself and all of its media still exist.',
        impact: 'It will be moved to a new “Recovered words” category in the same language.',
        repair: { type: 'recover-word-category', wordId: word.id, language: word.language === 'pl' ? 'pl' : 'nl' },
      });
    }
    if (word.extraPhotoIds != null && !Array.isArray(word.extraPhotoIds)) {
      add({
        id: `words:${word.id}:extraPhotoIds`,
        title: `“${label}” has a damaged extra-photo list`,
        detail: 'The list is not stored in the expected format.',
        impact: 'The damaged list will be cleared; the word and its primary photo remain.',
        repair: { type: 'set-field', store: 'words', key: word.id, field: 'extraPhotoIds', value: [] },
      });
    }
    if (
      word.photoId != null &&
      (typeof word.photoId !== 'string' || !word.photoId.trim())
    ) {
      add({
        id: `words:${word.id}:photoId-shape`,
        title: `“${label}” has a damaged primary-photo link`,
        detail: 'The link is not stored in the expected format.',
        impact: 'Only the broken link will be cleared; the word and all recordings remain.',
        repair: { type: 'set-field', store: 'words', key: word.id, field: 'photoId', value: null },
      });
    }
    if (Array.isArray(word.extraPhotoIds)) {
      const invalidIds = word.extraPhotoIds.filter(
        (photoId) => typeof photoId !== 'string' || !photoId.trim()
      );
      if (invalidIds.length) {
        add({
          id: `words:${word.id}:extraPhotoIds-items`,
          title: `“${label}” has ${invalidIds.length} damaged extra-photo link${invalidIds.length === 1 ? '' : 's'}`,
          detail: 'The affected link values are not stored in the expected format.',
          impact: 'Only the broken links will be cleared; usable photos, the word and all recordings remain.',
          repair: { type: 'normalize-extra-photo-ids', wordId: word.id },
        });
      }
    }
    const referencedIds = [
      typeof word.photoId === 'string' ? word.photoId : null,
      ...(Array.isArray(word.extraPhotoIds)
        ? word.extraPhotoIds.filter((photoId) => typeof photoId === 'string')
        : []),
    ].filter(Boolean);
    for (const photoId of referencedIds) {
      if (!photos.has(photoId)) {
        add({
          id: `words:${word.id}:missing-photo:${photoId}`,
          title: `“${label}” refers to a missing photo`,
          detail: `Missing photo ${photoId}`,
          impact: 'Only the broken reference will be cleared; the word and all recordings remain.',
          repair: { type: 'clear-photo-reference', wordId: word.id, photoId },
        });
      }
    }
    await checkMedia({
      store: 'words',
      key: word.id,
      field: 'photo',
      value: word.photo,
      kind: 'image',
      title: `Legacy photo for “${label}”`,
      impact: 'Only the unusable inline photo will be cleared; the word and recordings remain.',
      repair: { type: 'clear-field', store: 'words', key: word.id, field: 'photo' },
    });
    await checkMedia({
      store: 'words',
      key: word.id,
      field: 'audioWord',
      value: word.audioWord,
      kind: 'audio',
      title: `Word recording for “${label}”`,
      impact: 'Only this unusable recording will be cleared; the word will need recording again before sessions.',
      repair: { type: 'clear-field', store: 'words', key: word.id, field: 'audioWord' },
    });
    await checkMedia({
      store: 'words',
      key: word.id,
      field: 'audioPhrase',
      value: word.audioPhrase,
      kind: 'audio',
      title: `Optional phrase for “${label}”`,
      impact: 'Only the unusable optional phrase will be cleared.',
      repair: { type: 'clear-field', store: 'words', key: word.id, field: 'audioPhrase' },
    });
  }

  for (const photo of snapshot.photos || []) {
    const usedBy = (snapshot.words || [])
      .filter(
        (word) =>
          word.photoId === photo.id ||
          (Array.isArray(word.extraPhotoIds) && word.extraPhotoIds.includes(photo.id))
      )
      .map((word) => word.word || word.id);
    await checkMedia({
      store: 'photos',
      key: photo.id,
      field: 'blob',
      value: photo.blob,
      kind: 'image',
      title: usedBy.length
        ? `Photo used by ${usedBy.map((name) => `“${name}”`).join(', ')}`
        : 'An unassigned saved photo',
      impact: usedBy.length
        ? 'The unusable photo will be removed and only its broken references cleared; words and recordings remain.'
        : 'The unusable unassigned photo will be removed.',
      repair: { type: 'remove-photo', photoId: photo.id },
      required: true,
    });
  }

  for (const person of snapshot.people || []) {
    const name = (person.name || person.id || 'Recovered person').trim?.() || 'Recovered person';
    if (typeof person.name !== 'string' || !person.name.trim()) {
      add({
        id: `people:${person.id}:name`,
        title: 'A person has no name',
        detail: `Person record ${person.id}`,
        impact: 'Their profile and recordings will be kept under the temporary name “Recovered person”.',
        repair: { type: 'set-field', store: 'people', key: person.id, field: 'name', value: 'Recovered person' },
      });
    }
    await checkMedia({
      store: 'people',
      key: person.id,
      field: 'photo',
      value: person.photo,
      kind: 'image',
      title: `${name}’s profile photo`,
      impact: 'Only the unusable photo will be cleared; their profile, intro and every word recording remain.',
      repair: { type: 'clear-field', store: 'people', key: person.id, field: 'photo' },
    });
    await checkMedia({
      store: 'people',
      key: person.id,
      field: 'introAudio',
      value: person.introAudio,
      kind: 'audio',
      title: `${name}’s language introduction`,
      impact: 'Only the unusable intro clip will be cleared; their profile, photo and word recordings remain.',
      repair: { type: 'clear-field', store: 'people', key: person.id, field: 'introAudio' },
    });
  }

  for (const recording of snapshot.recordings || []) {
    const person = people.get(recording.personId);
    const word = words.get(recording.wordId);
    const personName = (person && person.name) || recording.personId || 'unknown person';
    const wordName = (word && word.word) || recording.wordId || recording.name || 'recording';
    if (typeof recording.personId !== 'string' || !person) {
      add({
        id: `recordings:${recording.id}:person`,
        title: `Orphaned recording for ${wordName}`,
        detail: 'The person this recording belonged to is missing.',
        impact: 'Only this unusable orphaned recording row will be removed.',
        repair: { type: 'delete-row', store: 'recordings', key: recording.id },
      });
      continue;
    }
    if (recording.wordId && !word) {
      add({
        id: `recordings:${recording.id}:word`,
        title: `Orphaned word recording by ${personName}`,
        detail: 'The word this recording belonged to is missing.',
        impact: 'Only this unusable orphaned recording row will be removed.',
        repair: { type: 'delete-row', store: 'recordings', key: recording.id },
      });
      continue;
    }
    await checkMedia({
      store: 'recordings',
      key: recording.id,
      field: 'audioWord',
      value: recording.audioWord,
      kind: 'audio',
      title: `${personName} saying “${wordName}”`,
      impact: 'Only this unusable family word clip will be cleared.',
      repair: { type: 'clear-field', store: 'recordings', key: recording.id, field: 'audioWord' },
    });
    await checkMedia({
      store: 'recordings',
      key: recording.id,
      field: 'audioPhrase',
      value: recording.audioPhrase,
      kind: 'audio',
      title: `${personName}’s optional phrase for “${wordName}”`,
      impact: 'Only this unusable optional phrase will be cleared.',
      repair: { type: 'clear-field', store: 'recordings', key: recording.id, field: 'audioPhrase' },
    });
    await checkMedia({
      store: 'recordings',
      key: recording.id,
      field: 'blob',
      value: recording.blob,
      kind: 'audio',
      title: `${personName}’s game phrase “${recording.name || recording.id}”`,
      impact: 'Only this unusable game phrase will be cleared.',
      repair: { type: 'clear-field', store: 'recordings', key: recording.id, field: 'blob' },
    });
  }

  for (const row of meta.values()) {
    if (row.key === 'stickers' && !Array.isArray(row.value)) {
      add({
        id: 'meta:stickers:shape',
        title: 'The sticker collection is damaged',
        detail: 'The collection is not stored as a list.',
        impact: 'The damaged collection will be reset; words, photos and recordings are not affected.',
        repair: { type: 'set-field', store: 'meta', key: row.key, field: 'value', value: [] },
      });
    }
    if (row.key === 'twinAudit' && (!row.value || typeof row.value !== 'object')) {
      add({
        id: 'meta:twinAudit:shape',
        title: 'The translation-linking review is damaged',
        detail: 'Its saved review state is not readable.',
        impact: 'Only the review state will be reset; no words or translations will be changed.',
        repair: {
          type: 'set-field',
          store: 'meta',
          key: row.key,
          field: 'value',
          value: { ready: false },
        },
      });
    }
    if (row.key.startsWith('phrase-')) {
      if (row.value instanceof Blob) {
        await checkMedia({
          store: 'meta',
          key: row.key,
          field: 'value',
          value: row.value,
          kind: 'audio',
          title: `Saved game phrase “${row.key.slice(7)}”`,
          impact: 'Only this unusable game phrase will be removed.',
          repair: { type: 'delete-row', store: 'meta', key: row.key },
        });
      } else if (Array.isArray(row.value)) {
        for (let index = 0; index < row.value.length; index += 1) {
          const variant = row.value[index];
          if (!variant || typeof variant.id !== 'string') {
            add({
              id: `meta:${row.key}:variant:${index}:shape`,
              title: `A “${row.key.slice(7)}” phrase variant is damaged`,
              detail: 'The variant has no usable identity.',
              impact: 'Only this damaged variant will be removed; other variants remain.',
              repair: { type: 'remove-phrase-variant', key: row.key, index },
            });
            continue;
          }
          await checkMedia({
            store: 'meta',
            key: row.key,
            field: `variant:${index}`,
            value: variant.blob,
            kind: 'audio',
            title: `Game phrase variant “${variant.label || variant.id}”`,
            impact: 'Only this unusable variant will be removed; other variants remain.',
            repair: { type: 'remove-phrase-variant', key: row.key, index },
            required: true,
          });
        }
      } else {
        add({
          id: `meta:${row.key}:shape`,
          title: `Saved game phrase “${row.key.slice(7)}” is damaged`,
          detail: 'It is not stored as a recording or a phrase-variant list.',
          impact: 'Only this unusable game phrase entry will be removed.',
          repair: { type: 'delete-row', store: 'meta', key: row.key },
        });
      }
    }

    if (row.key.startsWith('photoIntake:item:')) {
      const value = row.value;
      if (!value || typeof value !== 'object' || !value.photoId || !photos.has(value.photoId)) {
        add({
          id: `meta:${row.key}:photo`,
          title: 'A Photo Inbox item has no usable photo',
          detail: `Inbox item ${(value && value.id) || row.key}`,
          impact: 'The unusable Inbox item will be removed; committed words are not touched.',
          repair: { type: 'delete-intake-item', key: row.key },
        });
        continue;
      }
      const audio = value.draft && value.draft.audio;
      if (audio && typeof audio === 'object') {
        for (const [language, blob] of Object.entries(audio)) {
          await checkMedia({
            store: 'meta',
            key: row.key,
            field: `draft.audio.${language}`,
            value: blob,
            kind: 'audio',
            title: `Photo Inbox ${language.toUpperCase()} draft recording`,
            impact: 'Only this unusable draft recording will be cleared; the Inbox photo and text remain.',
            repair: { type: 'remove-intake-audio', key: row.key, language },
          });
        }
      }
    }

    if (
      INTAKE_META_RE.test(row.key) &&
      row.key !== 'photoIntake' &&
      !row.key.startsWith('photoIntake:item:') &&
      (!row.value || typeof row.value !== 'object')
    ) {
      add({
        id: `meta:${row.key}:shape`,
        title: 'A legacy Photo Inbox record is damaged',
        detail: `Inbox record ${row.key}`,
        impact: 'Only this unreadable Inbox metadata will be removed; committed words are not touched.',
        repair: { type: 'delete-row', store: 'meta', key: row.key },
      });
    }
  }

  const intakeHeader = meta.get('photoIntake');
  if (intakeHeader && (!intakeHeader.value || typeof intakeHeader.value !== 'object')) {
    add({
      id: 'meta:photoIntake:shape',
      title: 'The Photo Inbox header is damaged',
      detail: 'The list of open Inbox items is not readable.',
      impact: 'Only the unreadable header will be removed; photos and standalone deferred items remain.',
      repair: { type: 'delete-row', store: 'meta', key: 'photoIntake' },
    });
  } else if (intakeHeader) {
    const itemIds = Array.isArray(intakeHeader.value.itemIds)
      ? intakeHeader.value.itemIds
      : [];
    const invalid = itemIds.filter((id) => typeof id !== 'string' || !id);
    const missing = itemIds.filter(
      (id) => typeof id === 'string' && !meta.has(`photoIntake:item:${id}`)
    );
    if (!Array.isArray(intakeHeader.value.itemIds) || invalid.length || missing.length) {
      const brokenCount = Math.max(1, invalid.length + missing.length);
      add({
        id: 'meta:photoIntake:itemIds',
        title: 'The Photo Inbox list contains damaged or missing items',
        detail: `${brokenCount} broken item reference${brokenCount === 1 ? '' : 's'}`,
        impact: 'Only the broken list entries will be removed.',
        repair: { type: 'normalize-intake-header' },
      });
    }
  }

  return { issues };
}

export class BackupHealthError extends Error {
  constructor(issues) {
    super(
      `${issues.length} backup problem${issues.length === 1 ? '' : 's'} found. Review all of them before saving.`
    );
    this.name = 'BackupHealthError';
    this.issues = issues;
  }
}

function backupHealthReviewToken(snapshot) {
  return JSON.stringify(
    SNAPSHOT_STORES.map((store) => [
      store,
      [...(snapshot[store] || [])]
        .map((row) => [
          keyFor(store, row),
          own(row, 'rev') ? row.rev : null,
        ])
        .sort((a, b) => lexicalCompare(a[0], b[0])),
    ])
  );
}

export async function inspectBackupHealth() {
  const snapshot = await readSnapshot(SNAPSHOT_STORES);
  const health = await inspectBackupSnapshot(snapshot);
  return { ...health, reviewToken: backupHealthReviewToken(snapshot) };
}

function cloneForRepair(value) {
  if (value instanceof Blob) return value;
  if (Array.isArray(value)) return value.map(cloneForRepair);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, cloneForRepair(item)]));
  }
  return value;
}

export async function repairBackupHealth(reviewToken) {
  const snapshot = await readSnapshot(SNAPSHOT_STORES);
  if (
    typeof reviewToken !== 'string' ||
    reviewToken !== backupHealthReviewToken(snapshot)
  ) {
    throw new Error(
      'The app data changed while the repair was being reviewed. Nothing was repaired; please review it again.'
    );
  }
  const { issues } = await inspectBackupSnapshot(snapshot);
  const rawMaps = Object.fromEntries(
    SNAPSHOT_STORES.map((store) => [
      store,
      new Map((snapshot[store] || []).map((row) => [keyFor(store, row), row])),
    ])
  );
  const changed = Object.fromEntries(SNAPSHOT_STORES.map((store) => [store, new Map()]));
  const deleted = Object.fromEntries(SNAPSHOT_STORES.map((store) => [store, new Set()]));
  const phraseVariantRemovals = new Map();
  const deletedIntakeIds = new Set();

  const mutable = (store, key) => {
    if (deleted[store].has(key)) return null;
    if (!changed[store].has(key)) {
      const raw = rawMaps[store].get(key);
      if (!raw) return null;
      changed[store].set(key, cloneForRepair(raw));
    }
    return changed[store].get(key);
  };
  const removeRow = (store, key) => {
    if (!rawMaps[store].has(key)) return;
    changed[store].delete(key);
    deleted[store].add(key);
  };

  for (const issue of issues) {
    const repair = issue.repair;
    if (!repair) continue;
    if (repair.type === 'clear-field') {
      const row = mutable(repair.store, repair.key);
      if (row) row[repair.field] = null;
    } else if (repair.type === 'set-field') {
      const row = mutable(repair.store, repair.key);
      if (row) row[repair.field] = cloneForRepair(repair.value);
    } else if (repair.type === 'delete-row') {
      removeRow(repair.store, repair.key);
    } else if (repair.type === 'clear-photo-reference') {
      const word = mutable('words', repair.wordId);
      if (word) {
        if (word.photoId === repair.photoId) word.photoId = null;
        if (Array.isArray(word.extraPhotoIds)) {
          word.extraPhotoIds = word.extraPhotoIds.filter((id) => id !== repair.photoId);
        }
      }
    } else if (repair.type === 'normalize-extra-photo-ids') {
      const word = mutable('words', repair.wordId);
      if (word && Array.isArray(word.extraPhotoIds)) {
        word.extraPhotoIds = word.extraPhotoIds.filter(
          (id) => typeof id === 'string' && id.trim()
        );
      }
    } else if (repair.type === 'remove-photo') {
      removeRow('photos', repair.photoId);
      for (const word of snapshot.words || []) {
        if (
          word.photoId === repair.photoId ||
          (Array.isArray(word.extraPhotoIds) && word.extraPhotoIds.includes(repair.photoId))
        ) {
          const draft = mutable('words', word.id);
          if (draft) {
            if (draft.photoId === repair.photoId) draft.photoId = null;
            if (Array.isArray(draft.extraPhotoIds)) {
              draft.extraPhotoIds = draft.extraPhotoIds.filter((id) => id !== repair.photoId);
            }
          }
        }
      }
      for (const row of filteredMeta(snapshot.meta || [])) {
        if (row.key.startsWith('photoIntake:item:') && row.value && row.value.photoId === repair.photoId) {
          removeRow('meta', row.key);
          deletedIntakeIds.add(row.key.slice('photoIntake:item:'.length));
        }
      }
    } else if (repair.type === 'remove-phrase-variant') {
      if (!phraseVariantRemovals.has(repair.key)) phraseVariantRemovals.set(repair.key, new Set());
      phraseVariantRemovals.get(repair.key).add(repair.index);
    } else if (repair.type === 'remove-intake-audio') {
      const row = mutable('meta', repair.key);
      const audio = row && row.value && row.value.draft && row.value.draft.audio;
      if (audio && typeof audio === 'object') delete audio[repair.language];
    } else if (repair.type === 'delete-intake-item') {
      removeRow('meta', repair.key);
      deletedIntakeIds.add(repair.key.slice('photoIntake:item:'.length));
    } else if (repair.type === 'recover-word-category') {
      const categoryId = `recovered:${repair.language}:backup-health`;
      if (!rawMaps.categories.has(categoryId) && !changed.categories.has(categoryId)) {
        changed.categories.set(categoryId, {
          id: categoryId,
          name: 'Recovered words',
          emoji: '🧰',
          order: 999,
          language: repair.language,
          createdAt: Date.now(),
        });
      }
      const word = mutable('words', repair.wordId);
      if (word) word.categoryId = categoryId;
    } else if (repair.type === 'remove-spike') {
      const spike = rawMaps.words.get(repair.wordId);
      removeRow('words', repair.wordId);
      for (const recording of snapshot.recordings || []) {
        if (recording.wordId === repair.wordId) removeRow('recordings', recording.id);
      }
      const spikePhotoIds = [
        spike && spike.photoId,
        ...(spike && Array.isArray(spike.extraPhotoIds) ? spike.extraPhotoIds : []),
      ].filter(Boolean);
      for (const photoId of spikePhotoIds) {
        const usedElsewhere = (snapshot.words || []).some(
          (word) =>
            word.id !== repair.wordId &&
            (word.photoId === photoId ||
              (Array.isArray(word.extraPhotoIds) && word.extraPhotoIds.includes(photoId)))
        );
        if (!usedElsewhere) removeRow('photos', photoId);
      }
    }
  }

  for (const [key, indexes] of phraseVariantRemovals) {
    const row = mutable('meta', key);
    if (!row || !Array.isArray(row.value)) continue;
    row.value = row.value.filter((_variant, index) => !indexes.has(index));
    if (row.value.length === 0) removeRow('meta', key);
  }

  const header = rawMaps.meta.get('photoIntake');
  const headerNeedsNormalizing =
    deletedIntakeIds.size > 0 ||
    issues.some((issue) => issue.repair && issue.repair.type === 'normalize-intake-header');
  if (header && headerNeedsNormalizing) {
    const row = mutable('meta', 'photoIntake');
    if (row && row.value && typeof row.value === 'object') {
      const listedIds = Array.isArray(row.value.itemIds)
        ? row.value.itemIds
        : [...rawMaps.meta.keys()]
            .filter((key) => key.startsWith('photoIntake:item:'))
            .map((key) => key.slice('photoIntake:item:'.length));
      row.value.itemIds = [
        ...new Set(
          listedIds.filter(
            (id) =>
              typeof id === 'string' &&
              id &&
              !deletedIntakeIds.has(id) &&
              rawMaps.meta.has(`photoIntake:item:${id}`) &&
              !deleted.meta.has(`photoIntake:item:${id}`)
          )
        ),
      ];
    }
  }

  const writes = Object.fromEntries(SNAPSHOT_STORES.map((store) => [store, []]));
  const expectedRevs = Object.fromEntries(SNAPSHOT_STORES.map((store) => [store, new Map()]));
  const deleteExpectedRevs = {};
  for (const store of SNAPSHOT_STORES) {
    for (const [key, row] of changed[store]) {
      if (deleted[store].has(key)) continue;
      const raw = rawMaps[store].get(key);
      expectedRevs[store].set(
        key,
        raw ? (own(raw, 'rev') ? raw.rev : null) : undefined
      );
      writes[store].push(withoutRev(row));
    }
    if (deleted[store].size) {
      deleteExpectedRevs[store] = new Map(
        [...deleted[store]].map((key) => {
          const raw = rawMaps[store].get(key);
          return [key, raw && own(raw, 'rev') ? raw.rev : null];
        })
      );
    }
  }

  if (!issues.length) return { repaired: 0, issues: [] };
  await putAllTransactional(writes, 'repairing backup data', {
    expectedRevs,
    deleteExpectedRevs,
    abortOnMismatch: true,
  });
  const after = await inspectBackupHealth();
  return {
    repaired: issues.filter((issue) => issue.repairable).length,
    issues: after.issues,
  };
}

async function encodeRecursive(value, path, manifest) {
  if (value instanceof Blob) {
    await assertDecodableBlob(value, path);
    const hash = await sha256(value);
    const tagged = {
      [BLOB_TAG]: true,
      data: await blobToDataUrl(value),
      sha256: hash,
      size: value.size,
      type: value.type,
    };
    manifest.push({ path, sha256: hash, size: value.size, type: value.type });
    return tagged;
  }
  if (Array.isArray(value)) {
    const out = [];
    for (let i = 0; i < value.length; i += 1) {
      out.push(await encodeRecursive(value[i], `${path}[${i}]`, manifest));
    }
    return out;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      if (key === 'rev' || value[key] == null) continue;
      out[key] = await encodeRecursive(value[key], `${path}.${key}`, manifest);
    }
    return out;
  }
  return value;
}

function canonicalValue(value) {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value && typeof value === 'object') {
    if (value[BLOB_TAG] === true) {
      return {
        [BLOB_TAG]: true,
        sha256: value.sha256,
        size: value.size,
        type: value.type,
      };
    }
    const out = {};
    for (const key of Object.keys(value).sort()) {
      if (key === 'rev' || value[key] == null) continue;
      out[key] = canonicalValue(value[key]);
    }
    return out;
  }
  return value;
}

function datasetFrom(payload) {
  // Array-of-tuples preserves the contract's fixed store order; record arrays
  // are already sorted by each store's own key path before encoding.
  return SNAPSHOT_STORES.map((store) => [store, payload[store] || []]);
}

async function datasetDigest(payload) {
  return sha256(JSON.stringify(canonicalValue(datasetFrom(payload))));
}

async function encodeBackupSnapshot(snapshot) {
  const manifest = [];
  const health = await inspectBackupSnapshot(snapshot);
  if (health.issues.length) throw new BackupHealthError(health.issues);
  const logical = logicalBackupSnapshot(snapshot);
  assertLogicalDataset(logical);
  const payload = {
    formatVersion: 4,
    payloadKind: 'backup',
    exportedAt: Date.now(),
  };
  for (const store of CONTENT_STORES) {
    payload[store] = await encodeRecursive(logical[store], store, manifest);
  }
  payload.meta = await encodeRecursive(logical.meta, 'meta', manifest);
  const digest = await datasetDigest(payload);
  payload.manifest = {
    algorithm: 'SHA-256',
    digest,
    blobs: manifest.sort((a, b) => lexicalCompare(a.path, b.path)),
  };
  return payload;
}

async function digestRecursive(value) {
  if (value instanceof Blob) {
    return {
      [BLOB_TAG]: true,
      sha256: await sha256(value),
      size: value.size,
      type: value.type,
    };
  }
  if (Array.isArray(value)) {
    const out = [];
    for (const item of value) out.push(await digestRecursive(item));
    return out;
  }
  if (value && typeof value === 'object') {
    const out = {};
    for (const key of Object.keys(value)) {
      if (key === 'rev' || value[key] == null) continue;
      out[key] = await digestRecursive(value[key]);
    }
    return out;
  }
  return value;
}

async function currentDatasetDigest() {
  const snapshot = await readSnapshot(SNAPSHOT_STORES);
  const payload = {};
  for (const store of CONTENT_STORES) {
    payload[store] = await digestRecursive(sortedRows(store, snapshot[store] || []));
  }
  payload.meta = await digestRecursive(sortedRows('meta', filteredMeta(snapshot.meta || [])));
  return datasetDigest(payload);
}

export async function buildBackupPayload() {
  return encodeBackupSnapshot(await readSnapshot(SNAPSHOT_STORES));
}

async function encodeLegacyRecord(store, row, index) {
  const out = withoutRev(row);
  for (const field of MEDIA_FIELDS[store] || []) {
    if (out[field] == null) continue;
    await assertDecodableBlob(out[field], `${store}[${index}].${field}`);
    out[field] = await blobToDataUrl(out[field]);
  }
  return out;
}

export async function buildSharePayload() {
  const snapshot = await readSnapshot(CONTENT_STORES);
  const words = sortedRows('words', snapshot.words || []);
  const referencedPhotos = new Set(
    words.flatMap((word) => [word.photoId, ...(word.extraPhotoIds || [])]).filter(Boolean)
  );
  const source = {
    categories: sortedRows('categories', snapshot.categories || []),
    words,
    photos: sortedRows('photos', snapshot.photos || []).filter((photo) => referencedPhotos.has(photo.id)),
    people: sortedRows('people', snapshot.people || []),
    recordings: sortedRows('recordings', snapshot.recordings || []),
    meta: [],
  };
  const health = await inspectBackupSnapshot(source);
  if (health.issues.length) throw new BackupHealthError(health.issues);
  assertLogicalDataset(source);
  const payload = { formatVersion: 3, payloadKind: 'share', exportedAt: Date.now() };
  for (const store of CONTENT_STORES) {
    payload[store] = [];
    for (let i = 0; i < source[store].length; i += 1) {
      payload[store].push(await encodeLegacyRecord(store, source[store][i], i));
    }
  }
  return payload;
}

// Kept as the private-backup default for older module callers. New UI code
// passes an explicit kind, so a share can never accidentally inherit meta.
export async function buildExportPayload() {
  return buildBackupPayload();
}

// Tries the native share sheet first (lets you AirDrop/Message/email the
// file directly on iOS); falls back to a plain download if unsupported.
// Pass { warnLargeShare: true } when the file is destined for the shared
//-link flow, so oversized exports get flagged before leaving the phone.
export async function exportAndShare({ kind = 'backup', warnLargeShare = false } = {}) {
  if (!['backup', 'share'].includes(kind)) throw new Error(`Unknown export kind: ${kind}`);
  const payload = kind === 'share' ? await buildSharePayload() : await buildBackupPayload();
  const json = JSON.stringify(payload);
  const sizeMB = (json.length / 1024 / 1024).toFixed(1);

  if (warnLargeShare && Number(sizeMB) > SHARE_SIZE_WARN_MB) {
    const proceed = confirm(
      `This export is large (~${sizeMB} MB). Shared links may fail above ${SHARE_SIZE_WARN_MB} MB. You can still save it as a backup, but sharing might not work. Continue anyway?`
    );
    if (!proceed) return { method: 'cancelled', sizeMB };
  }
  const filename = kind === 'share' ? 'antosias-app-share.json' : 'antosias-app-backup.json';
  const title = kind === 'share' ? "Antosia's app family share" : "Antosia's app private backup";
  return shareJsonFile({ json, filename, title, sizeMB });
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

function assertStructurallyValid(payload) {
  if (!payload || typeof payload !== 'object') {
    throw new Error('This file does not look like an export from this app.');
  }
  const pair = `${payload.formatVersion}:${payload.payloadKind || 'legacy'}`;
  const allowed = new Set(['1:legacy', '2:legacy', '3:legacy', '3:share', '4:backup']);
  if (!allowed.has(pair)) {
    throw new Error(
      'This backup was made by a newer version of the app than the one running now. Update the app first, then import again.'
    );
  }
  if (payload.payloadKind === 'share' && own(payload, 'meta')) {
    throw new Error('This share file contains private backup data and has been refused.');
  }
  if (payload.formatVersion === 4 && !Array.isArray(payload.meta)) {
    throw new Error('This private backup is incomplete or damaged (missing private app data).');
  }
  if (!Array.isArray(payload.categories) || !Array.isArray(payload.words)) {
    throw new Error('This export file is incomplete or damaged (missing categories or words).');
  }
}

const isUsableCategory = (c) => c && typeof c.id === 'string' && typeof c.name === 'string';
const isUsableWord = (w) =>
  w && typeof w.id === 'string' && typeof w.word === 'string' && typeof w.categoryId === 'string' && w.categoryId !== '';

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

function assertUniqueRows(store, rows) {
  const seen = new Set();
  let previous = null;
  for (let i = 0; i < rows.length; i += 1) {
    const key = keyFor(store, rows[i] || {});
    if (typeof key !== 'string' || !key) {
      throw new Error(`${rowIdentity(store, rows[i], i)} is missing its ${store === 'meta' ? 'key' : 'id'}.`);
    }
    if (seen.has(key)) throw new Error(`${store} contains the same id/key twice (${key}).`);
    if (previous != null && lexicalCompare(previous, key) > 0) {
      throw new Error(`${store} records are not in canonical key order.`);
    }
    seen.add(key);
    previous = key;
  }
}

function assertLogicalDataset(decoded, { references = true } = {}) {
  for (const store of SNAPSHOT_STORES) assertUniqueRows(store, decoded[store] || []);
  for (let i = 0; i < decoded.categories.length; i += 1) {
    if (!isUsableCategory(decoded.categories[i])) {
      throw new Error(`${rowIdentity('categories', decoded.categories[i], i)} is missing an id or name.`);
    }
  }
  for (let i = 0; i < decoded.words.length; i += 1) {
    if (!isUsableWord(decoded.words[i])) {
      throw new Error(`${rowIdentity('words', decoded.words[i], i)} is missing an id, text, or category.`);
    }
  }
  for (const store of CONTENT_STORES) {
    for (let i = 0; i < decoded[store].length; i += 1) {
      for (const field of MEDIA_FIELDS[store] || []) {
        const value = decoded[store][i][field];
        if (value != null && !(value instanceof Blob)) {
          throw new Error(`${store}[${i}].${field} is not valid encoded media.`);
        }
      }
    }
  }
  for (let i = 0; i < decoded.photos.length; i += 1) {
    if (!(decoded.photos[i].blob instanceof Blob)) {
      throw new Error(`${rowIdentity('photos', decoded.photos[i], i)} has no usable picture.`);
    }
  }
  for (let i = 0; i < decoded.people.length; i += 1) {
    if (typeof decoded.people[i].name !== 'string') {
      throw new Error(`${rowIdentity('people', decoded.people[i], i)} has no name.`);
    }
  }
  for (let i = 0; i < decoded.recordings.length; i += 1) {
    if (typeof decoded.recordings[i].personId !== 'string') {
      throw new Error(`${rowIdentity('recordings', decoded.recordings[i], i)} has no person.`);
    }
  }
  for (let i = 0; i < decoded.meta.length; i += 1) {
    const row = decoded.meta[i];
    const key = row.key;
    const allowed =
      key.startsWith('phrase-') ||
      key === 'stickers' ||
      key === 'settings' ||
      key === 'twinAudit' ||
      INTAKE_META_RE.test(key);
    if (!allowed) throw new Error(`Private backup data contains a key that is not allowed (${key}).`);
    if (key.startsWith('phrase-')) {
      const bare = row.value instanceof Blob;
      const variants =
        Array.isArray(row.value) &&
        row.value.every(
          (item) => item && typeof item.id === 'string' && item.blob instanceof Blob
        );
      if (!bare && !variants) throw new Error(`Private game phrase ${key} is damaged.`);
    } else if (key === 'stickers' && !Array.isArray(row.value)) {
      throw new Error('The sticker collection in this backup is damaged.');
    } else if (
      (key === 'settings' || key === 'twinAudit' || INTAKE_META_RE.test(key)) &&
      (!row.value || typeof row.value !== 'object')
    ) {
      throw new Error(`Private backup data ${key} is damaged.`);
    }
  }
  if (references) {
    const empty = Object.fromEntries(SNAPSHOT_STORES.map((store) => [store, []]));
    assertReferences(empty, decoded);
  }
}

async function decodeTagged(value, path, foundManifest) {
  if (Array.isArray(value)) {
    const out = [];
    for (let i = 0; i < value.length; i += 1) {
      out.push(await decodeTagged(value[i], `${path}[${i}]`, foundManifest));
    }
    return out;
  }
  if (value && typeof value === 'object') {
    if (value[BLOB_TAG] === true) {
      if (
        typeof value.data !== 'string' ||
        typeof value.sha256 !== 'string' ||
        typeof value.size !== 'number' ||
        typeof value.type !== 'string'
      ) {
        throw new Error(`${path} has a damaged media tag.`);
      }
      const blob = dataUrlToBlob(value.data, { expectedType: value.type });
      const hash = await sha256(blob);
      if (blob.size !== value.size || blob.type !== value.type || hash !== value.sha256) {
        throw new Error(`${path} does not match its integrity record.`);
      }
      await assertDecodableBlob(blob, path);
      foundManifest.push({ path, sha256: hash, size: blob.size, type: blob.type });
      return blob;
    }
    const out = {};
    for (const key of Object.keys(value)) {
      if (key === 'rev') continue;
      out[key] = await decodeTagged(value[key], `${path}.${key}`, foundManifest);
    }
    return out;
  }
  return value;
}

async function decodeLegacyRows(store, rows) {
  const decoded = [];
  for (let i = 0; i < rows.length; i += 1) {
    const out = withoutRev(rows[i]);
    for (const field of MEDIA_FIELDS[store] || []) {
      if (out[field] == null) continue;
      const path = `${store}[${i}].${field}`;
      const blob = dataUrlToBlob(out[field]);
      await assertDecodableBlob(blob, path);
      out[field] = blob;
    }
    decoded.push(out);
  }
  return decoded;
}

async function decodeAndValidatePayload(payload) {
  assertStructurallyValid(payload);
  for (const store of CONTENT_STORES) assertUniqueRows(store, payload[store] || []);
  if (payload.formatVersion === 4) assertUniqueRows('meta', payload.meta);

  const decoded = {};
  if (payload.formatVersion === 4) {
    if (!payload.manifest || payload.manifest.algorithm !== 'SHA-256') {
      throw new Error('This private backup has no supported integrity manifest.');
    }
    const actualDigest = await datasetDigest(payload);
    if (actualDigest !== payload.manifest.digest) {
      throw new Error('This backup’s data does not match its integrity manifest.');
    }
    const found = [];
    for (const store of SNAPSHOT_STORES) {
      decoded[store] = await decodeTagged(payload[store] || [], store, found);
    }
    const expectedBlobs = JSON.stringify(
      [...(payload.manifest.blobs || [])].sort((a, b) => lexicalCompare(a.path, b.path))
    );
    const actualBlobs = JSON.stringify(found.sort((a, b) => lexicalCompare(a.path, b.path)));
    if (expectedBlobs !== actualBlobs) {
      throw new Error('This backup’s media list does not match its integrity manifest.');
    }
  } else {
    for (const store of CONTENT_STORES) {
      decoded[store] = await decodeLegacyRows(store, payload[store] || []);
    }
    decoded.meta = [];
  }

  assertLogicalDataset(decoded, { references: false });
  return decoded;
}

function mergeByKey(store, current, incoming) {
  const merged = new Map(current.map((row) => [keyFor(store, row), row]));
  for (const row of incoming) merged.set(keyFor(store, row), row);
  return merged;
}

function assertReferences(current, writes) {
  const merged = {};
  for (const store of CONTENT_STORES) {
    merged[store] = mergeByKey(store, current[store] || [], writes[store] || []);
  }
  for (const word of merged.words.values()) {
    if (!merged.categories.has(word.categoryId)) {
      throw new Error(`Word “${word.word || word.id}” refers to a category that is not present.`);
    }
    for (const photoId of [word.photoId, ...(word.extraPhotoIds || [])].filter(Boolean)) {
      if (!merged.photos.has(photoId)) {
        throw new Error(`Word “${word.word || word.id}” refers to a picture that is not present.`);
      }
    }
  }
  for (const recording of merged.recordings.values()) {
    if (!merged.people.has(recording.personId)) {
      throw new Error(`Recording ${recording.id} refers to a person that is not present.`);
    }
    if (recording.wordId && !merged.words.has(recording.wordId)) {
      throw new Error(`Recording ${recording.id} refers to a word that is not present.`);
    }
  }
  const mergedMeta = mergeByKey('meta', current.meta || [], writes.meta || []);
  for (const row of mergedMeta.values()) {
    if (row.key.startsWith('photoIntake:item:')) {
      if (!row.value.photoId || !merged.photos.has(row.value.photoId)) {
        throw new Error(`Photo Inbox item ${row.value.id || row.key} refers to a picture that is not present.`);
      }
    }
  }
  const header = mergedMeta.get('photoIntake');
  if (header && Array.isArray(header.value.itemIds)) {
    for (const itemId of header.value.itemIds) {
      if (!mergedMeta.has(`photoIntake:item:${itemId}`)) {
        throw new Error(`The Photo Inbox refers to an item that is not present (${itemId}).`);
      }
    }
  }
}

function hasMedia(store, row) {
  return (MEDIA_FIELDS[store] || []).some((field) => row && row[field] instanceof Blob);
}

async function mediaDifference(store, live, incoming) {
  for (const field of MEDIA_FIELDS[store] || []) {
    const a = live && live[field];
    const b = incoming && incoming[field];
    if (!!a !== !!b) return true;
    if (a instanceof Blob && b instanceof Blob) {
      if (a.size !== b.size || a.type !== b.type || (await sha256(a)) !== (await sha256(b))) return true;
    }
  }
  return false;
}

function mergeMetaValue(key, live, incoming) {
  if (key.startsWith('phrase-')) {
    if (Array.isArray(live) || Array.isArray(incoming)) {
      const slot = LEGACY_PHRASE_SLOTS[key] || key.slice(7);
      const current = Array.isArray(live) ? live : live ? [{ id: `pv:1:${slot}`, blob: live, label: '' }] : [];
      const fromFile = Array.isArray(incoming)
        ? incoming
        : incoming
          ? [{ id: `pv:1:${slot}`, blob: incoming, label: '' }]
          : [];
      const byId = new Map(fromFile.map((item) => [item.id, item]));
      for (const item of current) byId.set(item.id, item);
      return [...byId.values()];
    }
    return live ?? incoming;
  }
  if (key === 'stickers') {
    const all = [...(Array.isArray(incoming) ? incoming : []), ...(Array.isArray(live) ? live : [])];
    const seen = new Set();
    return all.filter((item) => {
      const identity = JSON.stringify([item && item.emoji, item && item.earnedAt]);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    });
  }
  if (key === 'settings') {
    const value = {};
    for (const field of SETTINGS_BACKUP_FIELDS) {
      if (incoming && own(incoming, field)) value[field] = incoming[field];
      else if (live && own(live, field)) value[field] = live[field];
    }
    if (live && own(live, 'lastBackupAt')) value.lastBackupAt = live.lastBackupAt;
    return value;
  }
  if (key === 'twinAudit') {
    const base = live || incoming || {};
    return { ...base, ready: false, invalidatedAt: Date.now() };
  }
  if (INTAKE_META_RE.test(key)) return live ?? incoming;
  return live ?? incoming;
}

function buildMetaWrites(currentRows, incomingRows, finalWordIds) {
  const current = new Map(currentRows.map((row) => [row.key, row]));
  const incoming = new Map(incomingRows.map((row) => [row.key, row]));
  const keys = new Set([...incoming.keys()]);
  if (incoming.has('twinAudit') || current.has('twinAudit')) keys.add('twinAudit');
  const writes = [];
  for (const key of keys) {
    const live = current.get(key);
    const fromFile = incoming.get(key);
    if (key.startsWith('photoIntake:item:') && !live && fromFile) {
      const allocated = Object.values((fromFile.value && fromFile.value.wordIds) || {}).filter(Boolean);
      if (allocated.some((id) => finalWordIds.has(id))) continue;
    }
    writes.push({ key, value: mergeMetaValue(key, live && live.value, fromFile && fromFile.value) });
  }
  const itemIds = new Set(
    [
      ...current.keys(),
      ...writes.map((row) => row.key),
    ]
      .filter((key) => key.startsWith('photoIntake:item:'))
      .map((key) => key.slice('photoIntake:item:'.length))
  );
  const headerIndex = writes.findIndex((row) => row.key === 'photoIntake');
  if (headerIndex >= 0) {
    writes[headerIndex] = {
      ...writes[headerIndex],
      value: { ...writes[headerIndex].value, itemIds: [...itemIds].sort() },
    };
  }
  return writes;
}

// A brand-new install creates example words before the parent can reach
// Restore. Those examples have random word ids, so a normal merge would keep
// them beside the backed-up copies and the restored database could never match
// its own manifest. Treat the database as empty only when it is provably the
// untouched starter set: exact seed rows, no media or child progress, no custom
// content, and v45 revision tokens on every row. Anything less exact stays on
// the ordinary non-destructive merge path.
function pristineStarterReplacement(snapshot) {
  if (
    (snapshot.photos || []).length ||
    (snapshot.people || []).length ||
    (snapshot.recordings || []).length
  ) {
    return null;
  }
  const userMeta = (snapshot.meta || []).some((row) => {
    if (!row || typeof row.key !== 'string') return true;
    if (row.key.startsWith('phrase-') || row.key === 'twinAudit' || INTAKE_META_RE.test(row.key)) return true;
    if (row.key === 'stickers') return Array.isArray(row.value) ? row.value.length > 0 : true;
    return !(
      row.key === 'settings' ||
      row.key === 'backupVerification' ||
      row.key === 'spike-test-data' ||
      row.key === 'seeded' ||
      row.key.startsWith('seed:') ||
      row.key.startsWith('migrate:')
    );
  });
  if (userMeta) return null;

  const categories = snapshot.categories || [];
  const words = snapshot.words || [];
  if (!categories.length || !words.length) return null;
  if (![...categories, ...words].every((row) => typeof row.rev === 'string' && row.rev)) return null;
  const starterCategoryFields = new Set(['id', 'name', 'emoji', 'order', 'language', 'createdAt', 'rev']);
  const starterWordFields = new Set([
    'id',
    'categoryId',
    'language',
    'article',
    'word',
    'photo',
    'placeholderEmoji',
    'audioWord',
    'audioPhrase',
    'phraseText',
    'realWorldPrompt',
    'understandingStatus',
    'speechStatus',
    'excluded',
    'srsLevel',
    'nextReviewDate',
    'dateIntroduced',
    'lastPracticed',
    'timesPracticed',
    'createdAt',
    'updatedAt',
    'rev',
  ]);
  if (
    categories.some((row) => Object.keys(row).some((key) => !starterCategoryFields.has(key))) ||
    words.some((row) => Object.keys(row).some((key) => !starterWordFields.has(key)))
  ) {
    return null;
  }

  const expectedCategories = new Map();
  const expectedWords = new Map();
  for (const [language, data] of Object.entries(SEED_DATA)) {
    for (const category of data.categories) {
      expectedCategories.set(category.id, { ...category, language });
    }
    for (const word of data.words) {
      expectedWords.set(
        [language, word.categoryId, word.article, word.word, word.placeholderEmoji].join('\u0000'),
        word
      );
    }
  }

  const languages = new Set();
  for (const category of categories) {
    const expected = expectedCategories.get(category.id);
    const language = category.language ?? 'nl';
    if (
      !expected ||
      language !== expected.language ||
      category.name !== expected.name ||
      category.emoji !== expected.emoji ||
      category.order !== expected.order ||
      category.pairedCategoryId
    ) {
      return null;
    }
    languages.add(language);
  }
  for (const word of words) {
    const language = word.language ?? 'nl';
    const key = [language, word.categoryId, word.article ?? '', word.word, word.placeholderEmoji].join('\u0000');
    const expected = expectedWords.get(key);
    const defaultPrompt = `Find ${[expected && expected.article, expected && expected.word].filter(Boolean).join(' ')}`;
    if (
      !expected ||
      word.photo ||
      word.photoId ||
      (word.extraPhotoIds && word.extraPhotoIds.length) ||
      word.audioWord ||
      word.audioPhrase ||
      (word.phraseText ?? '') !== '' ||
      (word.realWorldPrompt ?? defaultPrompt) !== defaultPrompt ||
      (word.understandingStatus ?? 'not_introduced') !== 'not_introduced' ||
      (word.speechStatus ?? 'none') !== 'none' ||
      (word.excluded ?? false) !== false ||
      (word.srsLevel ?? 0) !== 0 ||
      (word.timesPracticed ?? 0) !== 0 ||
      word.nextReviewDate != null ||
      word.dateIntroduced != null ||
      word.lastPracticed != null
    ) {
      return null;
    }
    languages.add(language);
  }
  for (const language of languages) {
    const data = SEED_DATA[language];
    if (!data) return null;
    if (
      categories.filter((row) => (row.language ?? 'nl') === language).length !== data.categories.length ||
      words.filter((row) => (row.language ?? 'nl') === language).length !== data.words.length
    ) {
      return null;
    }
  }

  return {
    filtered: { ...snapshot, categories: [], words: [] },
    deleteExpectedRevs: {
      categories: new Map(categories.map((row) => [row.id, row.rev])),
      words: new Map(words.map((row) => [row.id, row.rev])),
    },
    summary: { categories: categories.length, words: words.length },
  };
}

export async function analyzeImportPayload(
  payload,
  { existingSnapshot = null, replacePristineStarter = false } = {}
) {
  const decoded = await decodeAndValidatePayload(payload);
  const originalCurrent = existingSnapshot || (await readSnapshot(SNAPSHOT_STORES));
  const starterReplacement = replacePristineStarter ? pristineStarterReplacement(originalCurrent) : null;
  const current = starterReplacement ? starterReplacement.filtered : originalCurrent;
  const writes = Object.fromEntries(CONTENT_STORES.map((store) => [store, []]));
  const expectedRevs = Object.fromEntries(SNAPSHOT_STORES.map((store) => [store, new Map()]));
  const conflicts = [];
  const protectedLegacy = [];
  const restored = [];

  for (const store of CONTENT_STORES) {
    const liveById = new Map((current[store] || []).map((row) => [row.id, row]));
    for (const incomingRaw of decoded[store] || []) {
      const incoming = withoutRev(incomingRaw);
      const live = liveById.get(incoming.id);
      if (!live) {
        restored.push({ store, id: incoming.id, identity: rowIdentity(store, incoming, 0) });
        expectedRevs[store].set(incoming.id, undefined);
        writes[store].push(incoming);
        continue;
      }
      if (!own(live, 'rev') && hasMedia(store, live)) {
        protectedLegacy.push({
          store,
          id: incoming.id,
          identity: rowIdentity(store, incoming, 0),
          reason: 'the copy already on this phone predates exact change tracking and contains media, so it was left untouched',
        });
        continue;
      }
      if (await mediaDifference(store, live, incoming)) {
        conflicts.push({
          store,
          id: incoming.id,
          identity: rowIdentity(store, incoming, 0),
          reason: 'the backup and the phone contain different media',
        });
      }
      expectedRevs[store].set(incoming.id, own(live, 'rev') ? live.rev : null);
      writes[store].push(incoming);
    }
  }

  const finalWordIds = new Set([
    ...(current.words || []).map((row) => row.id),
    ...writes.words.map((row) => row.id),
  ]);
  writes.meta = buildMetaWrites(current.meta || [], decoded.meta || [], finalWordIds);
  const liveMeta = new Map((current.meta || []).map((row) => [row.key, row]));
  for (const row of writes.meta) {
    const live = liveMeta.get(row.key);
    expectedRevs.meta.set(row.key, live ? (own(live, 'rev') ? live.rev : null) : undefined);
  }
  assertReferences(current, writes);
  return {
    payload,
    writes,
    expectedRevs,
    conflicts,
    protectedLegacy,
    restored,
    deleteExpectedRevs: starterReplacement ? starterReplacement.deleteExpectedRevs : {},
    replacedStarter: starterReplacement ? starterReplacement.summary : null,
    omitted: [],
  };
}

export async function applyImportPayload(analysis) {
  const { skipped = [] } = await putAllTransactional(
    analysis.writes,
    'restoring data',
    {
      expectedRevs: analysis.expectedRevs,
      deleteExpectedRevs: analysis.deleteExpectedRevs || {},
    }
  );
  const count = (store) =>
    (analysis.writes[store] || []).length - skipped.filter((item) => item.store === store).length;
  return {
    categories: count('categories'),
    words: count('words'),
    photos: count('photos'),
    people: count('people'),
    recordings: count('recordings'),
    meta: count('meta'),
    skipped: skipped.length + analysis.protectedLegacy.length,
    protectedLegacy: analysis.protectedLegacy,
    lateSkipped: skipped,
  };
}

export async function readExistingIds() {
  const snapshot = await readSnapshot(CONTENT_STORES);
  return Object.fromEntries(
    CONTENT_STORES.map((store) => [store, new Set(snapshot[store].map((row) => row.id))])
  );
}

export async function importPayload(payload) {
  const analysis = await analyzeImportPayload(payload);
  if (analysis.conflicts.length || analysis.protectedLegacy.length) {
    throw new Error('This import needs review in the Restore screen before anything can be written.');
  }
  return applyImportPayload(analysis);
}

export async function verifyBackupPayload(payload) {
  assertStructurallyValid(payload);
  if (payload.formatVersion !== 4 || payload.payloadKind !== 'backup') {
    throw new Error('Only a new private backup can be verified. Save a fresh backup first.');
  }
  await decodeAndValidatePayload(payload);
  const currentDigest = await currentDatasetDigest();
  if (payload.manifest.digest !== currentDigest) {
    throw new Error('This backup is valid, but it no longer matches the data currently on this phone.');
  }
  const receipt = {
    digest: payload.manifest.digest,
    verifiedAt: Date.now(),
    exportedAt: payload.exportedAt || null,
  };
  await put('meta', { key: 'backupVerification', value: receipt });
  return receipt;
}

export async function getBackupVerificationStatus() {
  const receiptRow = await get('meta', 'backupVerification');
  const receipt = receiptRow && receiptRow.value;
  if (!receipt || typeof receipt.digest !== 'string') return { verified: false, receipt: null };
  try {
    return { verified: (await currentDatasetDigest()) === receipt.digest, receipt };
  } catch {
    return { verified: false, receipt };
  }
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
    if (await mediaProblem(audioWord, 'audio')) {
      unplayable.push(wordLabel(word) || word.word);
      continue;
    }
    let audioPhrase = null;
    if (typeof item.audioPhrase === 'string') {
      audioPhrase = await dataUrlToBlob(item.audioPhrase);
      if (await mediaProblem(audioPhrase, 'audio')) {
        unplayable.push(`${wordLabel(word) || word.word} (optional phrase)`);
        audioPhrase = null; // keep the usable word recording
      }
    }
    wordRows.push({ wordId: item.wordId, audioWord, audioPhrase });
  }

  const carrierRows = [];
  for (const item of payload.carriers || []) {
    if (!item || typeof item.name !== 'string' || typeof item.blob !== 'string') continue;
    const blob = await dataUrlToBlob(item.blob);
    if (await mediaProblem(blob, 'audio')) {
      unplayable.push(`game phrase "${item.name}"`);
      continue;
    }
    carrierRows.push({ name: item.name, blob });
  }

  let personPhoto = null;
  if (typeof payload.personPhoto === 'string') {
    personPhoto = await dataUrlToBlob(payload.personPhoto);
    if (await mediaProblem(personPhoto, 'image')) {
      unplayable.push('the profile photo');
      personPhoto = null;
    }
  }
  let introAudio = null;
  if (typeof payload.introAudio === 'string') {
    introAudio = await dataUrlToBlob(payload.introAudio);
    if (await mediaProblem(introAudio, 'audio')) {
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
