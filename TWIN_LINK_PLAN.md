# Plan v3 (BUILD-READY PROPOSAL): decouple language-twin identity from photos

Status: **approved with changes by review; this is the revised, build-ready
plan.** Not yet implemented. v1 was largely rejected; v2 was approved with
required changes; v3 folds those in.

## 1. The problem (verified in code at v41)

A word's twin is identified **only** by a shared `photoId`:
`js/admin.js:353` (translations filter requires `w.photoId`), `js/admin.js:858`
(editor `pairedWord`), `js/admin.js:2239`, `js/admin.js:2546` (v41 conflict /
linked-twin checks), `js/admin.js:2264` (`createNewTwin` links by copying
`photoId`). `CLAUDE.md` states the rule outright.

**Consequence:** a word with no picture can never have a recognised twin. The
parent cannot quickly add the Polish for a Dutch word she has recorded but not
photographed, and such words are silently missing from the translations count.
Twins are also forced to share one picture.

**Rejected: "just require a photo."** A photo-less word is playable today —
`isSessionEligible()` needs only audio (`js/db.js:293`) and `wordVisual()` falls
back to `placeholderEmoji` (`js/session.js:210`). Forcing a photo would invent a
new product requirement, keep identity coupled to mutable media, and still forbid
independent pictures.

## 2. Decision

Add **`conceptId`** (string) to word records.

- **Two words are twins iff they share a `conceptId` and are in different languages.**
- **Invariant: at most one word per language per `conceptId`.**
- `photoId` / `extraPhotoIds` stay as pictures — shareable, but **no longer identity**.
- Single domain helper `findTwin(words, word)`; no call site re-implements lookup.
- A single-member concept is normal and means "not translated yet" — never an error.

Rejected: reciprocal `twinId` (two mutable pointers that can disagree; stale
pointers after delete; reciprocity repair on restore).

## 3. Two things the migration MUST normalise

### 3a. `language` — the enforcement hole (was missed until review v2)

The code reads language as `(w.language ?? 'nl')` (`js/admin.js:220`,
`js/session.js:144`, and ~10 more). Words therefore **can lack a `language`
property**, and nothing backfills it.

**IndexedDB does not index a record when a component of a compound key path is
absent.** So a unique index on `[conceptId, language]` would **silently skip**
every legacy word with no stored `language` — the enforcement hole sits exactly
where the oldest Dutch words are.

**Required:** the migration must persist a normalised `language` on **every** word
(and a valid `conceptId`), and **verify before commit** that every word has a
non-empty string `conceptId` and a supported `language`. Abort the transaction if
any record fails.

### 3b. Assignments are a snapshot

Compute the **complete assignment plan before issuing any write.** Never mutate a
word and then let that new state influence the next decision — processing order
would otherwise change the outcome for ambiguous groups.

## 4. Pairing rules — evidence only

v1's "pair the first `nl` with the first `pl` in each photo group" is
**withdrawn**: one family photo across `mama`/`papa` (nl) and `mama`/`tata` (pl)
would permanently marry "papa" to "mama", and seed words share one `createdAt`
(`js/db.js:596`) so the tie-break is arbitrary.

**Rule A — unambiguous photo group.** A `photoId` shared by *exactly one* Dutch and
*exactly one* Polish word → one concept. Any group with 2+ words in either
language is **ambiguous** → no automatic pairing (goes to the audit, §6).

Caveat accepted: this is strong evidence only because the app itself creates twins
by sharing `photoId` (`js/admin.js:2250`, `js/admin.js:2264`). It is not universal
semantic proof, but it is sound for this controlled dataset.

**Rule B — the authored seed mapping (DOWNGRADED after review).**
`SEED_DATA` (`js/db.js:517`) defines the Dutch and Polish starter sets as exact
parallels (`banaan`/`banan` 🍌, `brood`/`chleb` 🍞, `beer`/`miś` 🧸 …). That
correspondence is authored, but it is discarded at write time (`id: newId()`, no
link stored).

- **New seeds:** add a shared `key` to each seed entry across both languages and
  write a **deterministic** `conceptId = "seed:" + key` at seed time
  (`js/db.js:601`). This closes the fresh-install gap (an upgrade migration cannot
  assign ids to words that do not exist yet).
- **Legacy records: NOT auto-assigned.** Matching a stored word by
  `(language, categoryId, exact word text)` proves only that a record *currently
  looks like* a seed entry — not that it *originated* from it. It breaks when the
  parent renamed the original and later created a new word with the seed's text,
  when duplicate seeding left two canonical words, or when a restore introduced a
  canonical-looking record. **"Unambiguous match" ≠ provenance.**
- **Instead:** detect an *intact canonical cohort* — seed marker present, complete
  category set, and **exactly one** match for **every** seed entry — and present
  the whole batch to the parent **as one confirmation** in the audit ("These 13
  starter pairs look like the originals — link them?"). One tap, not thirteen
  prompts, and no silent inference.

**Rule C — unambiguous inheritance (fixes v1's idempotency bug).** v1's "skip words
that already have a `conceptId`" was **not idempotent in mixed state**: if Dutch A
held concept X and its Polish partner B had none (older import, partial run), v1
would mint a fresh concept for B and **destroy the existing link**. So: a word
lacking a `conceptId` whose **sole** partner (by Rule A) already holds a concept
**inherits** it — provided that does not put two words of one language in one
concept.

**Everything else** gets a fresh `conceptId`.

**Deterministic seed ids never authorise merging.** `"seed:banana"` is not permission
to deduplicate: **word id remains record identity.** Two same-language words under
one concept on restore is a **collision for the parent to resolve**, never a silent
overwrite.

## 5. Enforcing the invariant

`saveWord()` **cannot** be the authority — words are written around it by backup
restore (`js/backup.js:204`), seeding (`js/db.js:601`), and bulk writes
(`js/db.js:103`); a read-then-write check also races.

- **Authority:** a unique IndexedDB index on `[conceptId, language]`, created in the
  same transaction that normalises the data (§3a).
- `saveWord()` does a friendly **preflight** and turns a constraint violation into a
  parent-readable message.
- Import and seeding must **validate before writing**, or the index aborts the whole
  transaction with an opaque storage error.

## 6. Rollout — TWO releases (not three)

`onupgradeneeded` fires before any UI can render (`js/db.js:17-18`), so
"auto-migrate" and "prompt for a backup first" cannot ship together. But Releases 2
and 3 of v2 **merge**: there is no value in committing concept ids and *then*
leaving a window in which ordinary use can create invalid data.

**Release 1 — Prepare (no schema change, non-destructive).**
1. Require and confirm a **fresh backup**.
2. Audit: compute the proposed assignments; show the parent (a) the intact-cohort
   seed batch to confirm, and (b) any **ambiguous** photo groups.
3. Let the parent resolve ambiguous groups explicitly — show language, category,
   label and photo; permit only valid one-Dutch/one-Polish selections; **"leave
   separate" is the safe default**.
4. Store decisions **by word id**, with an audit version and a validation
   count/hash, plus a readiness marker tied to this dataset.

**Release 2 — Migrate and enforce (ONE `versionchange` transaction).**
1. Re-read and **revalidate** every word (and every recorded decision — discard any
   whose word id now points at a different word or language).
2. Assign every `conceptId`; normalise every `language`.
3. Create the unique `[conceptId, language]` index.
4. Verify: no word lacks a concept or language; no concept holds two words of one
   language.
5. Commit only if all of the above succeed — otherwise **abort**.

This is feasible inside `versionchange`: the upgrade transaction can `getAll()` /
cursor over `words`, compute the plan in the request callback, queue `put()`s, and
create the index — all in the same transaction. Constraints: **no awaiting non-IDB
promises**, never let the transaction go inactive between requests, generate all
random ids **synchronously** before queueing writes, abort explicitly on validation
failure.

**Force-quit mid-migration → the whole transaction aborts.** Neither the new version
nor half the rewritten words commit; the next open retries. This is materially safer
than a post-open loop of `saveWord()` calls.

### Migration failure UI (required)

If the upgrade aborts, the old database survives but the **new JavaScript is already
installed** and will retry on next open. A deterministic failure (unresolved
collision, malformed record, quota) would otherwise **fail on every launch** — a
bricked app. `openDB` currently rejects with a generic storage error
(`js/db.js:17`, `js/db.js:49`) and has no migration-specific recovery.

Define a startup screen distinguishing:
- **interrupted → safe retry**;
- **out of space / backup problem**;
- **data conflict → return to the audit/repair step**.

The concept-only admin UI must **never** run against an old or partially prepared
schema.

## 7. Photo forking

`saveWord()` writes an inline `photo` blob into whatever `photoId` the record
already carries (`js/db.js:233-236`), so editing *only* the Polish word's picture
today **overwrites the shared blob and silently changes the Dutch word too**.
Decoupling identity does not by itself deliver independent photos.

- Offer the choice **only when the current `photoId` is actually referenced by another
  word**; otherwise a plain replacement is correct and the parent shouldn't be asked.
  - **"Replace this picture for both words"** → overwrite the shared blob.
  - **"Use a separate picture for this language"** → allocate a **new** `photoId` for
    this word only; the twin's photo is untouched.
- **Must be one transactional db helper** ("fork/replace primary photo and save
  word"), with reference-aware cleanup of the old primary. Do **not** implement it as
  `savePhoto()` then `saveWord()` — a failed word save would orphan the new photo
  (`js/db.js:217`, `js/db.js:233`).

## 8. Behavioural rules

**Linking (`linkExistingAsTwin`) must validate BOTH concepts before mutating anything:**
- S's concept must not already contain a different word in T's language;
- T's concept must not already contain a different word in S's language;
- neither concept may already be structurally invalid;
- **if S and T already share a concept → it's an update, not a conflict.**

Refuse and explain (do not silently re-point a concept — that orphans an existing
twin). The unique index would block a bad commit anyway, but the UI must detect and
explain it **before** any category or photo mutation begins.

**No unconfirmed name merges.** The full word editor still adopts the first same-name
other-language record silently (`js/admin.js:1259-1270`) — under `conceptId` that
would *permanently merge unrelated meanings*. It must route through the same conflict
screen the v41 wizard uses. **A `conceptId` is never assigned on an unconfirmed
global name match.**

## 9. Touchpoints

Twin resolution → `conceptId` (via `findTwin`): `js/admin.js:353` (**drop the
`w.photoId &&` clause**), `js/admin.js:858`, `js/admin.js:2239`, `js/admin.js:2546`.

Twin creation sets `conceptId`: `createNewTwin`, `linkExistingAsTwin`, the editor's
paired-word Save handler.

Also required:
- **Seeding** (`js/db.js:517`, `js/db.js:601`) — shared `key` + deterministic `conceptId`.
- **Word-editor conflict handling** (`js/admin.js:1259-1270`) — §8.
- **Photo replacement** (`js/admin.js:114`, `js/db.js:233`) — §7.
- **Backup** — `formatVersion` 4, carry `conceptId`. Restore is **merge-by-ID**
  (`js/backup.js:154`), so derive/validate against the **complete proposed post-merge
  set**, not just the payload. Distinguish three outcomes: safe overwrite by identical
  word id; resolvable old-format relationship; **genuine concept collision → report to
  the parent**, never silently remap or abort with a generic error. Backups do **not**
  carry `meta` (`js/backup.js:31`), so a restore invalidates the Release-1 audit — it
  must be re-run.

Confirmed **not** affected (do not change):
- Sessions / child mode (`js/session.js:199`, `js/child.js:118`) — act on individual
  words; never resolve twins.
- Photo cleanup (`js/db.js:125-145`) — counts `photoId`/`extraPhotoIds` references;
  still correct, and **must not** be changed to assume twins share media.
- Family recording requests (`js/admin.js:2767`) — keyed by word id, not concept.

## 10. Test plan

- Migration: photo-less seed words; a clean photo-linked pair; a photo shared by two
  same-language words (**must not auto-pair**); mixed state (one twin migrated, one not
  — **the link must survive**); a word with **no `language` field** (**must be
  normalised and indexed**); an already-migrated database (runs twice, no change).
- Force-quit mid-migration → database intact at the old version; next open retries.
- Deterministic failure → the migration failure screen appears; the app is **not bricked**.
- Seed cohort: intact cohort → one batch confirmation links all starter pairs; a renamed
  seed word → left alone, never mis-paired.
- **Translate a photo-less word → twin created, linked, and appears in "Record missing
  audio" for its language.** (The parent's original request.)
- Twin with its own photo → links without destroying either picture.
- Photo fork → the other twin's photo is unchanged; no orphaned photo on a failed save.
- Three-way link attempt → refused and explained before any mutation.
- Editor's same-name adoption → now asks, like the wizard.
- Backup: v4 round-trip keeps twins; a v3 file derives against the post-merge set; a
  concept collision is reported, not swallowed.
- Category delete cascade (v41 safety) still fires only on a strong link.
