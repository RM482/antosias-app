import { SEED_DATA } from './db.js?v=46';

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

// Returns the normalised language, or NULL when the record carries an explicit
// value this app does not support. The two cases are genuinely different:
//
// MISSING — legacy words that never stored one. The app has always papered over
// this with `language ?? 'nl'`, and those really are the oldest Dutch words, so
// 'nl' is the right answer. It matters enormously that the migration PERSISTS
// that value rather than just reading through it: IndexedDB will not index a
// record whose compound key path has a missing component, so a unique
// [conceptId, language] index would silently SKIP exactly these words.
//
// EXPLICIT BUT UNSUPPORTED — 'NL', 'de', '' — a record nobody can interpret.
// This used to be coerced to Dutch, which made it invisible and would have let
// the migration persist that guess, permanently relabelling her data. Null
// propagates safely through every caller here: such a word matches no twin,
// joins no clean photo pair, and satisfies no seed entry, so it is excluded
// from pairing and reported instead (see collectLanguageIssues).
export function wordLanguage(word) {
  if (word.language == null) return 'nl'; // legacy: never stored one
  return SUPPORTED_LANGUAGES.includes(word.language) ? word.language : null;
}

// Words whose stored language cannot be interpreted. The planner reports these
// rather than guessing; the audit must not be saved while any exist, and the
// migration must abort rather than normalise them to Dutch.
export function collectLanguageIssues(words) {
  return words
    .filter((w) => wordLanguage(w) === null)
    .map((w) => ({ id: w.id, word: w.word || '', language: w.language }));
}

export function otherLanguage(lang) {
  return lang === 'nl' ? 'pl' : 'nl';
}

// The twin of a word: same conceptId, different language. Single source of
// truth — no call site should re-implement this.
export function findTwin(words, word) {
  if (!word || !word.conceptId) return null;
  const lang = wordLanguage(word);
  if (lang === null) return null; // unreadable language: it is nobody's twin
  // The twin must be the EXACT opposite supported language. Testing `!== lang`
  // would match a word whose language is null (unsupported), since null is
  // never equal to 'nl' — so a broken record could be served up as a twin.
  const want = otherLanguage(lang);
  return words.find((w) => w.id !== word.id && w.conceptId === word.conceptId && wordLanguage(w) === want) || null;
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
    // A member whose language can't be read makes the whole group undecidable:
    // ignoring it would let {nl, pl, de} look like a clean 1-and-1 pair when a
    // third word is in fact sharing that picture.
    const unreadable = group.filter((w) => wordLanguage(w) === null);
    if (nl.length === 1 && pl.length === 1 && unreadable.length === 0) {
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
// `markers` is the meta seed markers (`seed:nl:v1` / `seed:pl:v1`) and
// `categories` the stored category records — both passed IN by the caller so
// this stays pure and synchronous (it runs inside a versionchange transaction).
//
// The seed marker is REQUIRED evidence (plan §4 Rule B) and was previously not
// consulted at all. Note it is still not provenance on its own: `ensureSeeded`
// back-fills the Dutch marker on pre-multi-language installs WITHOUT seeding
// (`js/db.js:579`), so an old phone can carry the Dutch marker over words that
// never came from the seed. That is exactly why the intact-cohort test below —
// every entry, both languages, exactly one exact match — has to carry the real
// weight, and why the parent still confirms the batch.
export function detectSeedCohort(words, { markers = {}, categories = [] } = {}) {
  const seedMarker = (lang) => !!markers[`seed:${lang}:v1`];
  if (!seedMarker('nl') || !seedMarker('pl')) {
    return { intact: false, reason: 'no-seed-marker', pairs: [] };
  }

  // Dutch categories seeded before the language prefix existed are `cat-x`
  // where SEED_DATA now says `nl-cat-x`. Only that one explicit alias is
  // accepted — never a general suffix match, which would let an unrelated
  // `pl-cat-toys` satisfy `nl-cat-toys`.
  const categoryAliases = (lang, seedCategoryId) =>
    lang === 'nl' && seedCategoryId.startsWith('nl-')
      ? [seedCategoryId, seedCategoryId.slice(3)]
      : [seedCategoryId];

  const categoryIds = new Set(categories.map((c) => c.id));
  // Only aliases that ACTUALLY EXIST count. Otherwise category presence could
  // be satisfied by `nl-cat-x` while a word points at a `cat-x` that is not in
  // the database at all — evidence from one generation vouching for the other.
  const presentAliases = (lang, seedCategoryId) =>
    categoryAliases(lang, seedCategoryId).filter((id) => categoryIds.has(id));
  const categoriesPresent = (lang) =>
    ((SEED_DATA[lang] && SEED_DATA[lang].categories) || []).every(
      (c) => presentAliases(lang, c.id).length > 0
    );
  if (!categoriesPresent('nl') || !categoriesPresent('pl')) {
    return { intact: false, reason: 'missing-seed-category', pairs: [] };
  }

  const matchesFor = (lang) => {
    const entries = (SEED_DATA[lang] && SEED_DATA[lang].words) || [];
    const byKey = new Map();
    for (const entry of entries) {
      const allowed = presentAliases(lang, entry.categoryId);
      const hits = words.filter(
        (w) =>
          wordLanguage(w) === lang &&
          allowed.includes(w.categoryId) &&
          // EXACT text: a re-cased or re-spaced word is an edit, and an edited
          // word is no longer evidence that this record came from the seed.
          w.word === entry.word
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
export function buildAuditPlan(words, { markers = {}, categories = [] } = {}) {
  const { pairs, ambiguous } = classifyPhotoGroups(words);
  const cohort = detectSeedCohort(words, { markers, categories });

  // Words already spoken for by an automatic (evidence-backed) pairing.
  const paired = new Set();
  for (const p of pairs) {
    paired.add(p.nl.id);
    paired.add(p.pl.id);
  }

  // Ambiguous ids must be known BEFORE the cohort is filtered. Previously this
  // set was built afterwards, so a cohort pair could claim a word that is also
  // sitting in an ambiguous photo group awaiting the parent's decision — and
  // the same word could then end up in two proposed pairs. The migration would
  // hit the unique [conceptId, language] index and abort deterministically, on
  // the one operation that must be all-or-nothing over her only copy.
  const ambiguousIds = new Set();
  for (const g of ambiguous) for (const w of g.words) ambiguousIds.add(w.id);

  // Cohort pairs only count once the parent confirms them, but for the summary
  // we show what they would cover — excluding any word a photo pair already
  // took, or that is still contested in an ambiguous group.
  const cohortPairs = cohort.intact
    ? cohort.pairs.filter(
        (p) =>
          !paired.has(p.nl.id) &&
          !paired.has(p.pl.id) &&
          !ambiguousIds.has(p.nl.id) &&
          !ambiguousIds.has(p.pl.id)
      )
    : [];

  const covered = new Set(paired);
  for (const p of cohortPairs) {
    covered.add(p.nl.id);
    covered.add(p.pl.id);
  }

  const untranslated = words.filter((w) => !covered.has(w.id) && !ambiguousIds.has(w.id));

  return {
    photoPairs: pairs,
    cohort: { ...cohort, pairs: cohortPairs },
    ambiguous,
    untranslated,
    signature: datasetSignature(words),
    // Every id already claimed by an automatic or cohort pair. Manual choices
    // are validated against this so two proposals can never share a word.
    reservedIds: covered,
    // Legacy words with no stored `language` — the migration must normalise
    // these or the unique index silently won't cover them.
    missingLanguage: words.filter((w) => w.language == null).length,
    // Explicit but unsupported languages: report, never coerce (see
    // wordLanguage). The audit must not be saved while any exist.
    languageIssues: collectLanguageIssues(words),
  };
}

// Is a parent-chosen pairing legal? Exactly one Dutch word and one Polish word,
// both real, and NEITHER already spoken for.
//
// `reservedIds` is the set of ids already claimed — by automatic pairs, by the
// confirmed cohort, and by manual pairs accepted earlier in this same audit.
// The "neither already spoken for" rule was previously only a comment: nothing
// enforced it, so the audit could save one word into two pairs.
export function validateManualPair(nlWord, plWord, reservedIds = new Set()) {
  if (!nlWord || !plWord) return 'Pick one Dutch word and one Polish word.';
  const nlLang = wordLanguage(nlWord);
  const plLang = wordLanguage(plWord);
  if (nlLang === null || plLang === null) {
    return 'One of these words has a language this app does not recognise — it needs fixing first.';
  }
  // Explicitly one of each, rather than merely "different".
  if (nlLang !== 'nl' || plLang !== 'pl') {
    return 'A pair must be one Dutch word and one Polish word.';
  }
  if (nlWord.id === plWord.id) return 'A word cannot be paired with itself.';
  if (reservedIds.has(nlWord.id) || reservedIds.has(plWord.id)) {
    return 'One of these words is already part of another pair.';
  }
  return null;
}
