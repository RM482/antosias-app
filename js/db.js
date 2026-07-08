const DB_NAME = 'antosia-app';
const DB_VERSION = 1;

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

const SEED_CATEGORIES = [
  { id: 'cat-breakfast', name: 'Breakfast', emoji: '🍳', order: 0 },
  { id: 'cat-clothes', name: 'Clothes', emoji: '👕', order: 1 },
  { id: 'cat-toys', name: 'Toys / play', emoji: '🧸', order: 2 },
];

const SEED_WORDS = [
  { categoryId: 'cat-breakfast', article: 'de', word: 'banaan', placeholderEmoji: '🍌' },
  { categoryId: 'cat-breakfast', article: 'de', word: 'melk', placeholderEmoji: '🥛' },
  { categoryId: 'cat-breakfast', article: 'het', word: 'brood', placeholderEmoji: '🍞' },
  { categoryId: 'cat-breakfast', article: 'de', word: 'lepel', placeholderEmoji: '🥄' },
  { categoryId: 'cat-breakfast', article: 'de', word: 'beker', placeholderEmoji: '🥤' },
  { categoryId: 'cat-clothes', article: 'de', word: 'sok', placeholderEmoji: '🧦' },
  { categoryId: 'cat-clothes', article: 'de', word: 'schoen', placeholderEmoji: '👟' },
  { categoryId: 'cat-clothes', article: 'de', word: 'jas', placeholderEmoji: '🧥' },
  { categoryId: 'cat-clothes', article: 'de', word: 'broek', placeholderEmoji: '👖' },
  { categoryId: 'cat-toys', article: 'de', word: 'bal', placeholderEmoji: '⚽' },
  { categoryId: 'cat-toys', article: 'de', word: 'beer', placeholderEmoji: '🧸' },
  { categoryId: 'cat-toys', article: 'het', word: 'boek', placeholderEmoji: '📖' },
  { categoryId: 'cat-toys', article: 'de', word: 'auto', placeholderEmoji: '🚗' },
];

export async function ensureSeeded() {
  const seededFlag = await get('meta', 'seeded');
  if (seededFlag) return false;

  for (const category of SEED_CATEGORIES) {
    await put('categories', { ...category, createdAt: Date.now() });
  }
  for (const w of SEED_WORDS) {
    const now = Date.now();
    await put('words', {
      id: newId(),
      categoryId: w.categoryId,
      language: 'nl',
      article: w.article,
      word: w.word,
      photo: null,
      placeholderEmoji: w.placeholderEmoji,
      audioWord: null,
      audioPhrase: null,
      phraseText: '',
      realWorldPrompt: `Find ${w.article} ${w.word}`,
      understandingStatus: 'not_introduced',
      speechStatus: 'none',
      dateIntroduced: null,
      lastPracticed: null,
      timesPracticed: 0,
      createdAt: now,
      updatedAt: now,
    });
  }
  await put('meta', { key: 'seeded', value: true });
  return true;
}
