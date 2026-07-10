const DB_NAME = 'antosia-app';
const DB_VERSION = 3;

let dbPromise = null;

// IndexedDB failure objects (req.error / transaction.error) can be null in
// some situations — e.g. aborted transactions, or storage restrictions in
// private browsing — so always substitute a real Error with a readable
// message rather than rejecting with null.
function storageError(rawError, context) {
  return rawError || new Error(`Storage failed during "${context}" — the browser may be blocking or limiting storage (this can happen in private browsing).`);
}

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains('meta')) {
        db.createObjectStore('meta', { keyPath: 'key' });
      }
      if (!db.objectStoreNames.contains('categories')) {
        const store = db.createObjectStore('categories', { keyPath: 'id' });
        store.createIndex('order', 'order');
      }
      if (!db.objectStoreNames.contains('words')) {
        const store = db.createObjectStore('words', { keyPath: 'id' });
        store.createIndex('categoryId', 'categoryId');
        store.createIndex('lastPracticed', 'lastPracticed');
      }
      if (!db.objectStoreNames.contains('photos')) {
        db.createObjectStore('photos', { keyPath: 'id' });
      }
      // v3 (Stage 6): family members. `people` holds who they are (photo +
      // intro clip inline — never shared between records); `recordings` holds
      // their per-word and carrier-phrase audio, with deterministic ids
      // (`${personId}:word:${wordId}` / `${personId}:carrier:${language}:${name}`)
      // so a re-record or re-import is an overwrite, never a duplicate.
      if (!db.objectStoreNames.contains('people')) {
        db.createObjectStore('people', { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains('recordings')) {
        const store = db.createObjectStore('recordings', { keyPath: 'id' });
        store.createIndex('personId', 'personId');
        store.createIndex('wordId', 'wordId');
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(storageError(req.error, 'opening the database'));
  });
  return dbPromise;
}

function reqToPromise(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(storageError(req.error, 'reading data'));
  });
}

export function newId() {
  return (crypto.randomUUID && crypto.randomUUID())
    || `id-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

export async function getAll(storeName) {
  const db = await openDB();
  return reqToPromise(db.transaction(storeName).objectStore(storeName).getAll());
}

export async function get(storeName, id) {
  const db = await openDB();
  return reqToPromise(db.transaction(storeName).objectStore(storeName).get(id));
}

export async function put(storeName, value) {
  const db = await openDB();
  const t = db.transaction(storeName, 'readwrite');
  t.objectStore(storeName).put(value);
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve(value);
    t.onerror = () => reject(storageError(t.error, 'saving data'));
    t.onabort = () => reject(storageError(t.error, 'saving data (transaction aborted, possibly out of storage space)'));
  });
}

export async function remove(storeName, id) {
  const db = await openDB();
  const t = db.transaction(storeName, 'readwrite');
  t.objectStore(storeName).delete(id);
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(storageError(t.error, 'deleting data'));
    t.onabort = () => reject(storageError(t.error, 'deleting data (transaction aborted)'));
  });
}

// Writes many records across stores in ONE transaction: either every record
// commits or none do. Used by backup restore so a failure partway through
// (bad file, out of storage) can never leave a half-imported database.
// `writes` looks like: { categories: [...], words: [...] }
export async function putAllTransactional(writes) {
  const db = await openDB();
  const storeNames = Object.keys(writes);
  const t = db.transaction(storeNames, 'readwrite');
  for (const storeName of storeNames) {
    const store = t.objectStore(storeName);
    for (const record of writes[storeName]) store.put(record);
  }
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(storageError(t.error, 'restoring data'));
    t.onabort = () => reject(storageError(t.error, 'restoring data (transaction aborted, possibly out of storage space)'));
  });
}

// Deletes a word AND everything only it owns: its photos-store blob when no
// other word — in either language, twins share photos — still references the
// same photoId, plus (once the Stage-6 recordings store exists) any per-person
// recordings of it. Everything runs inside ONE readwrite transaction using raw
// IDB requests: IndexedDB auto-commits the moment you await anything non-IDB,
// so splitting this into separate remove() calls could leave an orphan behind
// if a later step failed.
export async function deleteWordAndCleanup(wordId) {
  const db = await openDB();
  const storeNames = ['words', 'photos'];
  const hasRecordings = db.objectStoreNames.contains('recordings');
  if (hasRecordings) storeNames.push('recordings');
  const t = db.transaction(storeNames, 'readwrite');
  const words = t.objectStore('words');

  const getReq = words.get(wordId);
  getReq.onsuccess = () => {
    const word = getReq.result;
    words.delete(wordId);
    if (word && word.photoId) {
      // Requests in a transaction run in order, so this getAll already
      // excludes the word deleted above — it no longer counts as a reference.
      const allReq = words.getAll();
      allReq.onsuccess = () => {
        const stillReferenced = allReq.result.some((w) => w.photoId === word.photoId);
        if (!stillReferenced) t.objectStore('photos').delete(word.photoId);
      };
    }
    if (hasRecordings) {
      const recStore = t.objectStore('recordings');
      const keysReq = recStore.index('wordId').getAllKeys(wordId);
      keysReq.onsuccess = () => {
        for (const key of keysReq.result) recStore.delete(key);
      };
    }
  };

  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(storageError(t.error, 'deleting a word'));
    t.onabort = () => reject(storageError(t.error, 'deleting a word (transaction aborted)'));
  });
}

// --- People (Stage 6: family members whose voices/photos appear in child mode) ---

// Saves a person, enforcing at most one default voice per language: marking
// someone as the default clears the flag on whoever held it before, inside
// the same transaction so an interruption can't leave two defaults behind.
export async function savePerson(person) {
  const db = await openDB();
  const t = db.transaction('people', 'readwrite');
  const store = t.objectStore('people');
  if (person.isDefaultVoice) {
    const allReq = store.getAll();
    allReq.onsuccess = () => {
      for (const p of allReq.result) {
        if (p.id !== person.id && p.language === person.language && p.isDefaultVoice) {
          store.put({ ...p, isDefaultVoice: false, updatedAt: Date.now() });
        }
      }
      store.put(person);
    };
  } else {
    store.put(person);
  }
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve(person);
    t.onerror = () => reject(storageError(t.error, 'saving a person'));
    t.onabort = () => reject(storageError(t.error, 'saving a person (transaction aborted, possibly out of storage space)'));
  });
}

// Deletes a person and every recording of their voice, in one transaction
// (contract C4). Word records are untouched — the default parent's audio
// lives on the words themselves, not in `recordings`.
export async function deletePersonAndCleanup(personId) {
  const db = await openDB();
  const t = db.transaction(['people', 'recordings'], 'readwrite');
  t.objectStore('people').delete(personId);
  const recStore = t.objectStore('recordings');
  const keysReq = recStore.index('personId').getAllKeys(personId);
  keysReq.onsuccess = () => {
    for (const key of keysReq.result) recStore.delete(key);
  };
  return new Promise((resolve, reject) => {
    t.oncomplete = () => resolve();
    t.onerror = () => reject(storageError(t.error, 'deleting a person'));
    t.onabort = () => reject(storageError(t.error, 'deleting a person (transaction aborted)'));
  });
}

// --- Photo storage (shared across languages) ---

export async function savePhoto(blob) {
  const id = newId();
  await put('photos', { id, blob });
  return id;
}

export async function getPhoto(photoId) {
  return get('photos', photoId);
}

// Save a word, handling photo migration: an inline photo Blob moves to the
// photos store and the word keeps only a photoId reference. The photoId is
// written back onto the caller's draft (callers rely on it — e.g. to give a
// paired-language word the same photo). Retaking a photo overwrites the SAME
// photo record, so every word sharing that photoId sees the new picture.
// Backward compatible: old words with inline photo still load, migrate on save.
export async function saveWord(wordDraft) {
  if (wordDraft.photo) {
    if (wordDraft.photoId) {
      await put('photos', { id: wordDraft.photoId, blob: wordDraft.photo });
    } else {
      wordDraft.photoId = await savePhoto(wordDraft.photo);
    }
  }
  const record = { ...wordDraft };
  delete record.photo; // the blob lives in the photos store, not on the word
  await put('words', record);
  return wordDraft;
}

// Loads photos-store blobs onto `word.photo` for display, for every word in
// the list that carries a photoId. Legacy words with an inline photo are left
// untouched. Mutates and returns the same array.
export async function attachPhotos(words) {
  const ids = [...new Set(words.map((w) => w.photoId).filter(Boolean))];
  await Promise.all(
    ids.map(async (id) => {
      let rec = null;
      try {
        rec = await get('photos', id);
      } catch {
        return; // photo just won't display
      }
      if (!rec || !rec.blob) return;
      for (const w of words) {
        if (w.photoId === id) w.photo = rec.blob;
      }
    })
  );
  return words;
}

export function wordLabel(word) {
  return [word.article, word.word].filter(Boolean).join(' ');
}

// A word can appear in a session only if it has word audio AND the parent
// hasn't marked it "skip". This is the single source of truth used
// everywhere words are counted or picked (session targets, distractors,
// ready-counts, Start-button state) so an excluded word can never slip in
// as, say, a distractor.
export function isSessionEligible(word) {
  return !!word.audioWord && word.excluded !== true;
}

// Spaced repetition: a word is "due" when it has never been scheduled
// (nextReviewDate absent) or its scheduled time has arrived. Old records
// from before SRS existed have no nextReviewDate, so they read as due —
// an intentional, one-time fresh start for scheduling that leaves all
// existing practice history (timesPracticed, statuses) untouched.
export function isDue(word, now = Date.now()) {
  return word.nextReviewDate == null || word.nextReviewDate <= now;
}

// Days to wait before a word is due again, indexed by srsLevel (0..3).
// Advancing only happens on a positive observation; see session.js.
export const SRS_INTERVAL_DAYS = [1, 3, 7, 14];

// Milliseconds from `now` to the start of the local calendar day + N days.
// Calendar-day based so an evening session makes a word due the next
// morning, and daylight-saving shifts can't cause off-by-hours surprises.
export function nextReviewAfterDays(days, now = Date.now()) {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0); // start of today, local time
  d.setDate(d.getDate() + days);
  return d.getTime();
}

// navigator.storage.persist() only *requests* persistence — it's a heuristic,
// not a guarantee, so callers should surface `persisted` to the parent rather
// than assume it succeeded.
export async function requestPersistentStorage() {
  if (!navigator.storage || !navigator.storage.persist) {
    return { supported: false, persisted: false, estimate: null };
  }
  const alreadyPersisted = await navigator.storage.persisted();
  const persisted = alreadyPersisted || await navigator.storage.persist();
  const estimate = navigator.storage.estimate ? await navigator.storage.estimate() : null;
  return { supported: true, persisted, estimate };
}

// Read-only status for the settings screen — never re-requests persistence,
// just reports what's true now. Every call tolerates the API being missing
// or rejecting (e.g. in private-browsing contexts) rather than throwing.
export async function getStorageStatus() {
  const status = { supported: false, persisted: false, usageBytes: null };
  if (!navigator.storage) return status;
  status.supported = true;
  try {
    if (navigator.storage.persisted) status.persisted = await navigator.storage.persisted();
  } catch {
    /* leave persisted=false */
  }
  try {
    if (navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      if (est && typeof est.usage === 'number') status.usageBytes = est.usage;
    }
  } catch {
    /* leave usageBytes=null */
  }
  return status;
}

// --- Settings (stored as a single record in the existing `meta` store, so no
// IndexedDB version upgrade is needed) -----------------------------------------

const DEFAULT_SETTINGS = {
  language: 'nl',      // reserved for future Polish support; only Dutch today
  lastBackupAt: null,  // epoch ms of the last "Save backup", or null if never
};

// Defaults win for any key the stored record is missing, so settings written
// by an older version of the app never leave a newer field undefined.
export async function getSettings() {
  const rec = await get('meta', 'settings');
  return { ...DEFAULT_SETTINGS, ...(rec && rec.value) };
}

export async function saveSettings(partial) {
  const merged = { ...(await getSettings()), ...partial };
  await put('meta', { key: 'settings', value: merged });
  return merged;
}

// --- Standard game phrases (reusable carrier recordings) ----------------------
// Short carrier clips in the parent's own voice, recorded once and stitched
// onto each word's recording during the find-it game. Stored as Blobs in the
// meta store; an absent clip just means the game plays the bare word.
//
// The set differs by language. Dutch uses article-aware prompts and an
// een/mass correction split. Polish has no articles and is case-inflected, so
// the parent records two whole-phrase carriers whose wording works with the
// bare (nominative) word — e.g. prompt "Gdzie jest …?", correction "To jest …".
//
// Dutch keys are the original unprefixed ones so previously recorded Dutch
// clips keep working; other languages are prefixed.
const PHRASE_SCHEMA = {
  nl: {
    clickOnDe: 'phrase-clickon-de',
    clickOnHet: 'phrase-clickon-het',
    correctionEen: 'phrase-correction-een',
    correction: 'phrase-correction',
    goed: 'phrase-goed-zo',
  },
  pl: {
    prompt: 'phrase-pl-prompt',
    correction: 'phrase-pl-correction',
    goed: 'phrase-pl-goed',
  },
};

export function phraseNames(language) {
  return Object.keys(PHRASE_SCHEMA[language] || {});
}

export async function getStandardPhrases(language = 'nl') {
  const schema = PHRASE_SCHEMA[language] || {};
  const entries = await Promise.all(
    Object.entries(schema).map(async ([name, key]) => {
      const rec = await get('meta', key);
      return [name, (rec && rec.value) || null];
    })
  );
  return Object.fromEntries(entries);
}

export async function saveStandardPhrase(language, name, blob) {
  const key = (PHRASE_SCHEMA[language] || {})[name];
  if (!key) throw new Error(`Unknown standard phrase: ${language}/${name}`);
  await put('meta', { key, value: blob });
}

// Common Dutch mass/uncountable nouns a toddler meets — mostly drinks, foods
// and substances that are named without "een" ("dit is melk", "dit is brood").
// Used only to pick a sensible default for a word's `useEen` flag; the parent
// can always override. Countability is genuinely context-dependent, so
// ambiguous homonyms (bloem = flower/flour, ijs = ice/ice-cream) are left OUT
// on purpose and default to "een".
const DUTCH_MASS_NOUNS = new Set([
  'water', 'melk', 'sap', 'appelsap', 'sinaasappelsap', 'druivensap', 'thee', 'koffie',
  'limonade', 'chocolademelk', 'brood', 'rijst', 'pasta', 'macaroni', 'kaas', 'boter',
  'yoghurt', 'kwark', 'suiker', 'zout', 'peper', 'honing', 'jam', 'pindakaas', 'hagelslag',
  'muesli', 'pap', 'soep', 'saus', 'ketchup', 'mayonaise', 'mosterd', 'vlees', 'gehakt',
  'fruit', 'chocola', 'chocolade', 'snoep', 'zand', 'sneeuw', 'regen', 'modder', 'klei',
  'verf', 'lijm', 'zeep', 'shampoo', 'tandpasta', 'speelgoed', 'papier', 'wol', 'muziek',
]);

// Best-effort default: true = named with "een" (countable), false = mass noun.
// Empty input defaults to "een".
export function guessUsesEen(word) {
  const w = (word || '').trim().toLowerCase();
  return w ? !DUTCH_MASS_NOUNS.has(w) : true;
}

// The effective "een" choice for a word: its saved flag when explicitly set,
// otherwise the best-effort guess. This is the single source of truth so the
// game and the word editor always agree — including for older words saved
// before the flag existed (their flag is blank, so both fall back to the
// guess rather than defaulting inconsistently).
export function usesEen(word) {
  return typeof word.useEen === 'boolean' ? word.useEen : guessUsesEen(word.word);
}

// Seed content, keyed by language. Category ids are language-prefixed so a
// future second language can't collide with Dutch. Polish is intentionally
// empty for now — the plumbing is ready, the content lands in a later stage.
// (Note: a real Polish set needs its own display rules — Polish has no de/het
// article system — so it is deliberately NOT a mechanical translation here.)
const SEED_DATA = {
  nl: {
    categories: [
      { id: 'nl-cat-breakfast', name: 'Ontbijt', emoji: '🍳', order: 0 },
      { id: 'nl-cat-clothes', name: 'Kleren', emoji: '👕', order: 1 },
      { id: 'nl-cat-toys', name: 'Speelgoed', emoji: '🧸', order: 2 },
    ],
    words: [
      { categoryId: 'nl-cat-breakfast', article: 'de', word: 'banaan', placeholderEmoji: '🍌' },
      { categoryId: 'nl-cat-breakfast', article: 'de', word: 'melk', placeholderEmoji: '🥛' },
      { categoryId: 'nl-cat-breakfast', article: 'het', word: 'brood', placeholderEmoji: '🍞' },
      { categoryId: 'nl-cat-breakfast', article: 'de', word: 'lepel', placeholderEmoji: '🥄' },
      { categoryId: 'nl-cat-breakfast', article: 'de', word: 'beker', placeholderEmoji: '🥤' },
      { categoryId: 'nl-cat-clothes', article: 'de', word: 'sok', placeholderEmoji: '🧦' },
      { categoryId: 'nl-cat-clothes', article: 'de', word: 'schoen', placeholderEmoji: '👟' },
      { categoryId: 'nl-cat-clothes', article: 'de', word: 'jas', placeholderEmoji: '🧥' },
      { categoryId: 'nl-cat-clothes', article: 'de', word: 'broek', placeholderEmoji: '👖' },
      { categoryId: 'nl-cat-toys', article: 'de', word: 'bal', placeholderEmoji: '⚽' },
      { categoryId: 'nl-cat-toys', article: 'de', word: 'beer', placeholderEmoji: '🧸' },
      { categoryId: 'nl-cat-toys', article: 'het', word: 'boek', placeholderEmoji: '📖' },
      { categoryId: 'nl-cat-toys', article: 'de', word: 'auto', placeholderEmoji: '🚗' },
    ],
  },
  pl: {
    // Polish has no de/het articles — words carry an empty article and display
    // as just the word. Starter set mirrors the Dutch categories; audio is
    // recorded by the parent later.
    categories: [
      { id: 'pl-cat-breakfast', name: 'Śniadanie', emoji: '🍳', order: 0 },
      { id: 'pl-cat-clothes', name: 'Ubrania', emoji: '👕', order: 1 },
      { id: 'pl-cat-toys', name: 'Zabawki', emoji: '🧸', order: 2 },
    ],
    words: [
      { categoryId: 'pl-cat-breakfast', article: '', word: 'banan', placeholderEmoji: '🍌' },
      { categoryId: 'pl-cat-breakfast', article: '', word: 'mleko', placeholderEmoji: '🥛' },
      { categoryId: 'pl-cat-breakfast', article: '', word: 'chleb', placeholderEmoji: '🍞' },
      { categoryId: 'pl-cat-breakfast', article: '', word: 'łyżka', placeholderEmoji: '🥄' },
      { categoryId: 'pl-cat-breakfast', article: '', word: 'kubek', placeholderEmoji: '🥤' },
      { categoryId: 'pl-cat-clothes', article: '', word: 'skarpetka', placeholderEmoji: '🧦' },
      { categoryId: 'pl-cat-clothes', article: '', word: 'but', placeholderEmoji: '👟' },
      { categoryId: 'pl-cat-clothes', article: '', word: 'kurtka', placeholderEmoji: '🧥' },
      { categoryId: 'pl-cat-clothes', article: '', word: 'spodnie', placeholderEmoji: '👖' },
      { categoryId: 'pl-cat-toys', article: '', word: 'piłka', placeholderEmoji: '⚽' },
      { categoryId: 'pl-cat-toys', article: '', word: 'miś', placeholderEmoji: '🧸' },
      { categoryId: 'pl-cat-toys', article: '', word: 'książka', placeholderEmoji: '📖' },
      { categoryId: 'pl-cat-toys', article: '', word: 'samochód', placeholderEmoji: '🚗' },
    ],
  },
};

// Languages offered in the home-screen switcher (order = display order).
export const LANGUAGES = [
  { code: 'nl', flag: '🇳🇱', label: 'Dutch' },
  { code: 'pl', flag: '🇵🇱', label: 'Polish' },
];

const SEED_VERSION = 1;
const seedMarkerKey = (language) => `seed:${language}:v${SEED_VERSION}`;

// Seed one language's starter content, at most once per language+version.
// Per-language markers (instead of one global flag) mean Polish content added
// later will still seed on devices that were set up in Dutch-only days.
//
// Legacy backfill: installs from before multi-language used a single 'seeded'
// flag and already hold the Dutch starter set (or the parent's own words). For
// those we record the Dutch marker WITHOUT re-seeding, so we never dump seed
// words on top of real data.
export async function ensureSeeded(language = 'nl') {
  const data = SEED_DATA[language];
  if (!data || data.categories.length === 0) return false; // nothing to seed yet (e.g. Polish)

  const marker = seedMarkerKey(language);
  if (await get('meta', marker)) return false;

  const legacySeeded = await get('meta', 'seeded');
  if (legacySeeded && language === 'nl') {
    await put('meta', { key: marker, value: true });
    return false;
  }

  const now = Date.now();
  for (const category of data.categories) {
    await put('categories', { ...category, language, createdAt: now });
  }
  for (const w of data.words) {
    await put('words', {
      id: newId(),
      categoryId: w.categoryId,
      language,
      article: w.article,
      word: w.word,
      photo: null,
      placeholderEmoji: w.placeholderEmoji,
      audioWord: null,
      audioPhrase: null,
      phraseText: '',
      realWorldPrompt: `Find ${[w.article, w.word].filter(Boolean).join(' ')}`,
      understandingStatus: 'not_introduced',
      speechStatus: 'none',
      excluded: false,
      srsLevel: 0,
      nextReviewDate: null,
      dateIntroduced: null,
      lastPracticed: null,
      timesPracticed: 0,
      createdAt: now,
      updatedAt: now,
    });
  }
  await put('meta', { key: marker, value: true });
  // Keep the legacy flag current so the shared-import gate (first-ever open)
  // still behaves and future backfills short-circuit.
  await put('meta', { key: 'seeded', value: true });
  return true;
}

// One-time rename of the three seeded Dutch categories from their original
// English names to Dutch ones. Only rewrites a category whose name still
// EXACTLY matches the old English default — so a category the parent renamed
// themselves is left untouched. Only the name field changes; ids, words,
// photos are all unaffected.
//
// This is pass v2: the first pass (v1, shipped in ?v=28) looked categories up
// by the multi-language ids (nl-cat-…), but phones seeded before Stage 5
// still carry the original unprefixed ids (cat-…), so nothing matched — and
// the done-marker was written anyway, so it never retried. Matching by NAME
// works for both id generations.
const NL_CATEGORY_RENAMES_BY_NAME = {
  Breakfast: 'Ontbijt',
  Clothes: 'Kleren',
  'Toys / play': 'Speelgoed',
};

export async function migrateDutchCategoryNames() {
  if (await get('meta', 'migrate:nl-cat-names:v2')) return;
  const cats = await getAll('categories');
  for (const cat of cats) {
    if ((cat.language ?? 'nl') !== 'nl') continue;
    const to = NL_CATEGORY_RENAMES_BY_NAME[cat.name];
    if (to) await put('categories', { ...cat, name: to });
  }
  await put('meta', { key: 'migrate:nl-cat-names:v2', value: true });
}
