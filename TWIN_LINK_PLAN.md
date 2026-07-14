# Plan v2 (PROPOSAL — not implemented): decouple language-twin identity from photos

Status: **draft for a second review.** Nothing here is built. v1 of this plan was
reviewed and substantially rejected; this version incorporates that review.

## 1. The problem (verified in code at v41)

A word's twin (the same concept in the other language) is identified **only** by
a shared `photoId`:

- `js/admin.js:353` — the "➕ Add missing translations" filter requires `w.photoId`.
- `js/admin.js:858` — the word editor's `pairedWord` matches on `photoId`.
- `js/admin.js:2239`, `js/admin.js:2546` — the v41 conflict and linked-twin checks, same rule.
- `js/admin.js:2264` — `createNewTwin` links by copying the source's `photoId`; if the
  source has none, the new word is created but **no enduring relationship exists**.
- `CLAUDE.md` states it: "`photoId` … is what links language twins — don't break that".

**Consequence:** a word with no picture can never have a recognised twin. The
parent's real case — "I recorded this in Dutch, now let me quickly add the
Polish" — is impossible for any photo-less word, and such words are silently
absent from the translations count.

Secondary consequence: twins are forced to share one picture. Giving the Polish
word its own primary photo breaks the link.

### Correction carried over from review v1

An earlier draft argued a photo-less word "isn't playable anyway", which was
**false**. `isSessionEligible()` (`js/db.js:293`) requires only recorded audio and
not-excluded; `wordVisual()` (`js/session.js:210`) falls back to
`placeholderEmoji`. Audio-plus-emoji words play fine. Any option that *forces* a
photo therefore imposes a NEW product requirement rather than satisfying an
existing one — which is why the "just require a photo" option is rejected.

## 2. Decision

Adopt an explicit **`conceptId`**.

- Add `conceptId` (string) to word records. **Two words are twins iff they share a
  `conceptId` and are in different languages.**
- **Invariant: at most one word per language per `conceptId`.**
- `photoId` / `extraPhotoIds` keep their current meaning (pictures, still
  shareable) but **stop being identity**. Sharing the source's photo with a new
  twin remains the default; it is no longer required.
- Expose a single domain helper `findTwin(words, word)` so call sites never
  re-implement concept lookup.

Rejected alternative: a reciprocal `twinId` on each word. Two mutable pointers
can disagree (stale pointer after a delete, half-written link, reciprocity repair
on restore). A shared id is symmetric, and an untranslated word is naturally just
a concept with one member.

## 3. Migration — evidence only, never inference

The v1 rule ("group by photoId, pair the first `nl` with the first `pl`") is
**withdrawn**. It invents semantics: one family photo on `mama`/`papa` (nl) and
`mama`/`tata` (pl) could permanently marry "papa" to "mama". Creation-time is a
tie-breaker, not evidence — and seed words all share one `createdAt`
(`js/db.js:596`), so ties are the norm, not the exception.

A pairing is only made where there is **actual evidence**:

**Rule A — unambiguous photo group.** A `photoId` shared by *exactly one* Dutch
and *exactly one* Polish word → one concept. Any group with 2+ words in either
language is **ambiguous**: no automatic pairing.

**Rule B — the authored seed mapping (new; missed by review v1).** `SEED_DATA`
(`js/db.js:517`) defines the Dutch and Polish starter sets as exact parallels —
same order, same category, same `placeholderEmoji` (`banaan`/`banan` 🍌,
`brood`/`chleb` 🍞, `beer`/`miś` 🧸 …). That correspondence is **authored evidence
in our own source**, merely discarded at write time (`id: newId()`, no link
stored). Recovering it is not a guess.

- Add a stable `key` to each seed word entry, shared across languages
  (`{ key: 'banana', word: 'banaan' }` / `{ key: 'banana', word: 'banan' }`).
- Seed concepts get a **deterministic** id: `conceptId = "seed:" + key`. This also
  makes seed concepts stable **across devices**, which removes the review's
  concern about two devices minting unrelated UUIDs for the same records.
- For words already on the phone (seeded before this change, so carrying no key):
  match `(language, categoryId, exact word text)` against `SEED_DATA`. On an
  unambiguous match, assign `seed:<key>`. A word the parent has since renamed
  simply won't match, and is left alone.

**Rule C — unambiguous inheritance (fixes the mixed-state bug).** v1's "skip words
that already have a `conceptId`" is **not idempotent** for mixed data: if Dutch A
has concept X and its Polish photo-partner B has none (older import, partial
run), v1 would mint a fresh concept for B and *destroy the existing link*. So:
a word lacking a `conceptId` whose **sole** opposite-language partner (by Rule A
or B) already holds a concept **inherits** it — provided that does not put two
words of the same language in one concept.

**Everything else** gets its own fresh `conceptId`. That is not an error state: a
single-member concept simply means "not translated yet", and the UI must read it
that way.

**Ambiguous cases are surfaced to the parent, never auto-resolved.**

### Execution (staged — see §6)

The migration must be **one atomic transaction**. "Version bump" and "idempotent"
do not by themselves buy atomicity: if it runs as a series of `saveWord()` calls
after open, an interruption leaves the database half-migrated. It must either run
entirely inside the `versionchange` transaction, or as a single
`putAllTransactional`-style write after an explicit, validated preparation step.

## 4. Enforcing the invariant

`saveWord()` **cannot** be the authority — several paths write words around it:

- backup restore → `putAllTransactional()` (`js/backup.js:204`)
- seeding → raw `put()` (`js/db.js:601`)
- any future bulk write (`js/db.js:103`)

A read-then-write check inside `saveWord()` also races with concurrent saves.

**Therefore:** a **unique IndexedDB index on `[conceptId, language]`** is the
authoritative constraint. `saveWord()` performs a friendly preflight and turns a
constraint violation into a parent-readable message. Import and seeding must
validate *before* writing, because the index will otherwise abort the whole
transaction with an opaque storage error.

## 5. Photo forking (the promise v1 couldn't keep)

v1 claimed twins may have separate photos, but `saveWord()` writes an inline
`photo` blob into whatever `photoId` the record already carries
(`js/db.js:233-236`). So a parent editing *only* the Polish word's picture would
**overwrite the shared blob and silently change the Dutch word too**.

Decoupling identity does not by itself deliver independent photos. The photo
editor must therefore distinguish:

- **"Replace this picture for both words"** → overwrite the shared `photoId` blob.
- **"Use a separate picture for this language"** → allocate a **new** `photoId` for
  this word only, leaving the twin's photo untouched.

## 6. Staged rollout

`onupgradeneeded` fires **before** the app can render anything
(`js/db.js:17-18`), so "automatic schema migration" and "prompt for a backup
first" cannot ship in the same release. Given this is the parent's only copy of
irreplaceable recordings:

1. **Release 1 — prepare.** No schema change. Confirm a fresh backup. Audit the
   existing data and show the parent any ambiguous photo groups. Record the
   resolved pairings.
2. **Release 2 — migrate.** Assign concepts in one atomic transaction using Rules
   A/B/C plus any parent-resolved pairings. Verify afterwards: no word lacks a
   `conceptId`; no concept holds two words of one language.
3. **Release 3 — enforce.** Only once the data is known valid, add the unique
   `[conceptId, language]` index.

## 7. Behavioural rules

- **Refuse three-way links.** If the parent confirms "same thing" for a word that
  is *already* paired in the source language, **refuse and explain** — do not
  silently re-point either concept (that would orphan the existing twin). An
  explicit "change pairing" flow can come later if actually needed.
- **No unconfirmed name merges.** The full word editor still adopts the first
  same-name other-language record silently (`js/admin.js:1259-1270`). Under
  `conceptId` that would *permanently merge unrelated meanings*. It must route
  through the same conflict screen the v41 wizard uses. **A `conceptId` is never
  assigned on an unconfirmed global name match.**

## 8. Touchpoints

Twin resolution → `conceptId` (via `findTwin`):
`js/admin.js:353` (translations filter — **and drop the `w.photoId &&` clause**),
`js/admin.js:858` (editor `pairedWord`), `js/admin.js:2239` (conflict check),
`js/admin.js:2546` (linked-twin check).

Twin creation must set `conceptId`: `createNewTwin`, `linkExistingAsTwin`, and the
word editor's paired-word Save handler.

Also required, and **missing from v1**:
- **Seeding** (`js/db.js:517`, `js/db.js:601`) — both language seed sets need the
  shared `key` and must write a `conceptId`. Fresh installs otherwise create words
  with no concept, immediately violating the index.
- **Word editor conflict handling** (`js/admin.js:1259-1270`) — see §7.
- **Photo replacement semantics** (`js/admin.js:114`, `js/db.js:233`) — see §5.
- **Backup** — bump `formatVersion` to 4 and carry `conceptId`. Restore is
  **merge-by-ID** (`js/backup.js:154`), so derivation must run against the
  **complete proposed post-merge word set**, not just the incoming payload;
  otherwise an incoming old-format word gets a fresh concept and an existing link
  is lost. Concept collisions must be reported to the parent, not silently
  remapped or aborted with a generic storage error.

Confirmed **not** affected (do not change):
- Sessions / child mode (`js/session.js:199`, `js/child.js:118`) — they act on
  individual words and their media; they never resolve twins.
- Photo cleanup (`js/db.js:125-145`) — counts `photoId`/`extraPhotoIds`
  references. Still correct, and **must not** be changed to assume twins share
  media.
- Family recording requests (`js/admin.js:2767`) — keyed by word id, not concept.

## 9. Test plan (must pass before shipping)

- Migration over: photo-less seed words; a clean photo-linked pair; a photo shared
  by two same-language words (**must not auto-pair**); mixed state (one twin
  already migrated, one not — **the link must survive**); an already-migrated
  database (runs twice, no change).
- Seed recovery: a fresh install and an existing phone both end with `banaan`↔`banan`
  linked automatically; a renamed seed word is left alone rather than mis-paired.
- Translate a **photo-less** word → twin created, linked, and appears in "Record
  missing audio" for its language. (This is the parent's original request.)
- Twin with its own photo → links without destroying either picture.
- Photo fork: give one twin a separate picture → the other twin's photo is
  unchanged.
- Three-way link attempt → refused with an explanation.
- v41 conflict screen still asks rather than guesses; the word editor now does too.
- Backup: v4 round-trip keeps twins; importing a v3 file derives them against the
  post-merge set; a concept collision is reported, not silently swallowed.
- Category delete cascade (v41 safety) still fires only on a strong link.

## 10. Open questions for this review

1. Is deterministic `conceptId = "seed:" + key` for seed words right, or should
   even seed concepts be random UUIDs (losing cross-device stability)?
2. Rule B matches on `(language, categoryId, exact word text)`. Is that specific
   enough, given the parent may have edited a word's category or article?
3. Should Release 1's audit also offer to pair the *ambiguous* groups, or only
   report them and leave them as separate concepts?
4. Is a unique index on `[conceptId, language]` safe given some words may briefly
   have an undefined `conceptId` during upgrade? Does IndexedDB skip records where
   the key path is absent (and is relying on that wise)?
5. Is three releases overkill for a single user who can be told "take a backup and
   don't touch the phone for five minutes"? Could Releases 2 and 3 merge safely?
