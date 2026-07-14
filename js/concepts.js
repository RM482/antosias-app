import { SEED_DATA } from './db.js?v=42';

// Language-twin planning (TWIN_LINK_PLAN.md).
//
// EVERYTHING HERE IS PURE AND SYNCHRONOUS — no IndexedDB, no await, no promises.
// That is a hard requirement, not a style choice: Release 2 runs this planner
// INSIDE an IndexedDB `versionchange` transaction, and awaiting any non-IDB
// promise there lets the transaction go inactive and auto-commit half a
// migration. Keep it that way.
//
// The rules (plan §4) pair words only on EVIDENCE, never on inference:
//   Rule A  a photoId shared by exactly ONE Dutch and ONE Polish word.
//   Rule B  an intact seed cohort — proposed to the parent as one batch, never
//           auto-applied (a word that merely *looks* like a seed entry today is
//           not proof it *came* from one).
//   Rule C  a word with no concept whose sole partner already has one inherits it.
// Anything else is its own concept ("not translated yet" — a normal state).

export const SUPPORTED_LANGUAGES = ['nl', 'pl'];

// Legacy words can have NO `language` field at all — the app has always papered
// over this with `language ?? 'nl'`. That matters enormously here: IndexedDB
// will not index a record whose compound key path has a missing component, so a
// unique [conceptId, language] index would silently SKIP exactly those legacy
// Dutch words. The migration must PERSIST this normalised value, not just read
// through it.
export function wordLanguage(word) {
  const lang = word.language ?? 'nl';
  return SUPPORTED_LANGUAGES.includes(lang) ? lang : 'nl';
}

export function otherLanguage(lang) {
  return lang === 'nl' ? 'pl' : 'nl';
}

// The twin of a word: same conceptId, different language. Single source of
// truth — no call site should re-implement this.
export function findTwin(words, word) {
  if (!word || !word.conceptId) return null;
  const lang = wordLanguage(word);
  return (
    words.find((w) => w.id !== word.id && w.conceptId === word.conceptId && wordLanguage(w) !== lang) || null
  );
}

// --- Rule A: photo groups ----------------------------------------------------

// Words sharing a primary photoId. Extra photos are NOT identity and are ignored
// here. Words with no photo form no group.
export function photoGroups(words) {
  const groups = new Map();
  for (const w of words) {
    if (!w.photoId) continue;
    if (!groups.has(w.photoId)) groups.set(w.photoId, []);
    groups.get(w.photoId).push(w);
  }
  return groups;
}

// Classify every photo group as a clean pair (exactly one word per language) or
// ambiguous (2+ words of some language sharing one picture — e.g. one family
// photo used for "mama" and "papa"). Ambiguous groups are NEVER auto-paired:
// "earliest created" is a tie-break, not evidence, and seed words all share one
// createdAt anyway.
export function classifyPhotoGroups(words) {
  const pairs = [];
  const ambiguous = [];
  for (const [photoId, group] of photoGroups(words)) {
    const nl = group.filter((w) => wordLanguage(w) === 'nl');
    const pl = group.filter((w) => wordLanguage(w) === 'pl');
    if (nl.length === 1 && pl.length === 1) {
      pairs.push({ photoId, nl: nl[0], pl: pl[0] });
    } else if (group.length > 1) {
      ambiguous.push({ photoId, words: group, nl, pl });
    }
    // A group of one word (its own photo, no twin) needs no decision.
  }
  return { pairs, ambiguous };
}

// --- Rule B: the authored seed cohort ----------------------------------------

// SEED_DATA defines the Dutch and Polish starter sets as exact parallels, keyed
// by a shared `key` (banaan/banan = 'banana'). That mapping is authored evidence
// — but it is discarded at write time (random word ids, no stored link), so we
// can only RECOVER it, and recovery is not proof of provenance.
//
// We therefore only propose the cohort when it is INTACT: for every seed entry,
// in both languages, exactly one stored word still matches it on
// (language, categoryId, exact word text). One renamed or duplicated word makes
// the cohort not-intact, and we propose nothing rather than guess.
//
// Even when intact, the result is a PROPOSAL for the parent to confirm as a
// batch — it is never applied silently.
export function detectSeedCohort(words) {
  const matchesFor = (lang) => {
    const entries = (SEED_DATA[lang] && SEED_DATA[lang].words) || [];
    const byKey = new Map();
    for (const entry of entries) {
      const hits = words.filter(
        (w) =>
          wordLanguage(w) === lang &&
          w.categoryId === entry.categoryId &&
          (w.word || '').trim().toLowerCase() === entry.word.toLowerCase()
      );
      byKey.set(entry.key, hits);
    }
    return { entries, byKey };
  };

  const nl = matchesFor('nl');
  const pl = matchesFor('pl');

  // A cohort needs both language sets to exist at all.
  if (nl.entries.length === 0 || pl.entries.length === 0) {
    return { intact: false, reason: 'no-seed-set', pairs: [] };
  }

  const pairs = [];
  for (const entry of nl.entries) {
    const nlHits = nl.byKey.get(entry.key) || [];
    const plHits = pl.byKey.get(entry.key) || [];
    // Exactly one match on each side, or the cohort is not intact.
    if (nlHits.length !== 1 || plHits.length !== 1) {
      return {
        intact: false,
        reason: nlHits.length === 0 || plHits.length === 0 ? 'missing-word' : 'duplicate-word',
        detail: entry.key,
        pairs: [],
      };
    }
    pairs.push({ key: entry.key, nl: nlHits[0], pl: plHits[0] });
  }

  // A word may not appear in two proposed pairs.
  const seen = new Set();
  for (const p of pairs) {
    if (seen.has(p.nl.id) || seen.has(p.pl.id)) {
      return { intact: false, reason: 'overlapping-match', pairs: [] };
    }
    seen.add(p.nl.id);
    seen.add(p.pl.id);
  }

  return { intact: true, reason: 'ok', pairs };
}

// --- Dataset signature -------------------------------------------------------

// Release 1 records the parent's decisions; Release 2 must not act on them if the
// data changed in between (a word deleted, a twin added). Deterministic and
// SYNCHRONOUS (crypto.subtle is async, and we cannot await inside versionchange).
export function datasetSignature(words) {
  const ids = words.map((w) => w.id).sort();
  let hash = 5381;
  for (const id of ids) {
    for (let i = 0; i < id.length; i++) {
      hash = ((hash << 5) + hash + id.charCodeAt(i)) >>> 0; // djb2
    }
  }
  return { wordCount: ids.length, hash: hash.toString(16) };
}

export function signaturesMatch(a, b) {
  return !!a && !!b && a.wordCount === b.wordCount && a.hash === b.hash;
}

// --- The audit (Release 1) ---------------------------------------------------

// A read-only view of what the migration WOULD do, and what it cannot decide
// alone. Pure: computes nothing into the database.
export function buildAuditPlan(words) {
  const { pairs, ambiguous } = classifyPhotoGroups(words);
  const cohort = detectSeedCohort(words);

  // Words already spoken for by an automatic (evidence-backed) pairing.
  const paired = new Set();
  for (const p of pairs) {
    paired.add(p.nl.id);
    paired.add(p.pl.id);
  }
  // Cohort pairs only count once the parent confirms them, but for the summary
  // we show what they would cover — excluding any word a photo pair already took.
  const cohortPairs = cohort.intact
    ? cohort.pairs.filter((p) => !paired.has(p.nl.id) && !paired.has(p.pl.id))
    : [];

  const covered = new Set(paired);
  for (const p of cohortPairs) {
    covered.add(p.nl.id);
    covered.add(p.pl.id);
  }
  const ambiguousIds = new Set();
  for (const g of ambiguous) for (const w of g.words) ambiguousIds.add(w.id);

  const untranslated = words.filter((w) => !covered.has(w.id) && !ambiguousIds.has(w.id));

  return {
    photoPairs: pairs,
    cohort: { ...cohort, pairs: cohortPairs },
    ambiguous,
    untranslated,
    signature: datasetSignature(words),
    // Legacy words with no stored `language` — the migration must normalise
    // these or the unique index silently won't cover them.
    missingLanguage: words.filter((w) => w.language == null).length,
  };
}

// Is a parent-chosen pairing legal? (Exactly one word per language, both real,
// neither already spoken for.)
export function validateManualPair(nlWord, plWord) {
  if (!nlWord || !plWord) return 'Pick one Dutch word and one Polish word.';
  if (wordLanguage(nlWord) === wordLanguage(plWord)) {
    return 'A pair must be one Dutch word and one Polish word.';
  }
  if (nlWord.id === plWord.id) return 'A word cannot be paired with itself.';
  return null;
}
