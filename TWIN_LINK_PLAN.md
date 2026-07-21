# Plan v3.1: decouple language-twin identity from photos

Status: **NOT build-ready — amended 21 July 2026 and awaiting re-vet.** Not
implemented. v1 was largely rejected; v2 was approved with required changes; v3
folded those in and was called build-ready.

**v3.1 (21 July 2026) removes that build-ready status.** Review of
`VARIETY_AND_INTAKE_PLAN.md` found (a) the backup format number collided with
that plan's and is now **v5**, not v4 (§9); (b) Release 1's "fresh backup" gate
is not evidence that a usable backup exists, and its `count/hash` signature
cannot detect content changes under a stable word id (§6); and (c) **three
defects in the already-shipped v42 code** that would make this migration abort or
misbehave — see "Live defects" below. Those must be repaired *before* Release 2
is built, and this plan re-vetted, regardless of how sound §§2–5 remain.

## Live defects in shipped v42 code (found 21 July, confirmed twice)

None can corrupt words, photos or audio today — all three are read-only paths —
but each is a migration blocker, and the first two can record a *false* parent
decision that Release 2 would later act on.

1. **The seed cohort never checks its own evidence.** §4's Rule B requires the
   seed marker as evidence, but `detectSeedCohort` receives only words and checks
   neither the markers (`seed:<language>:v1`, `js/db.js:572-593`) nor the
   category records (`js/concepts.js:95-145`).
2. **A cohort pair can overlap an ambiguous photo group**, so the audit can save
   one word into two proposed pairs. `cohortPairs` excludes automatic photo pairs
   but **not ambiguous ids** (`js/concepts.js:176-196`), and `validateManualPair`
   never inspects already-reserved ids (`js/concepts.js:210-218`); both lists are
   stored together (`js/admin.js:2448-2478`). Release 2 would then abort
   deterministically — on the one migration that must be all-or-nothing over her
   only copy.
3. **`wordLanguage` coerces any unsupported explicit language to Dutch**
   (`js/concepts.js:27-30`) where this plan requires validation failure. A
   *missing* language may default to Dutch; an explicit invalid one must abort
   and be repaired, or the migration would permanently rewrite it as Dutch.

Also confirmed: the audit signature hashes **only word ids**
(`js/concepts.js:153-165`), so a rename or a content change under a stable id is
invisible to it — and **nothing calls `signaturesMatch`**, while Settings trusts
`audit.ready` directly (`js/admin.js:1493-1519`). The v42 audit screen can
therefore present stale decisions as actionable today.

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
1. Require a **verified** backup — not a fresh-looking one. A timestamp is not
   evidence: `lastBackupAt` is written whenever the share/download path returns
   (`js/admin.js:390`), which proves neither that a file was retained nor that
   nothing changed since. The parent **re-selects the exported file** and the app
   validates it and compares its manifest against a freshly computed digest of
   the current database, storing a non-exportable verification receipt. See
   `VARIETY_AND_INTAKE_PLAN.md` C-P14 — that mechanism is a prerequisite of this
   release, not an optional hardening.
2. Audit: compute the proposed assignments; show the parent (a) the intact-cohort
   seed batch to confirm, and (b) any **ambiguous** photo groups.
3. Let the parent resolve ambiguous groups explicitly — show language, category,
   label and photo; permit only valid one-Dutch/one-Polish selections; **"leave
   separate" is the safe default**.
4. Store decisions **by word id**, with an audit version and a readiness marker
   tied to this dataset. The fingerprint must be **content-sensitive**, not the
   shipped id-only `count/hash` (`js/concepts.js:153-165`) — it must cover at
   least each word's language, text, category and primary photo id, so a rename
   or a re-pointed photo under a stable id invalidates the decisions. Release 2
   must actually *compare* it; nothing calls `signaturesMatch` today.
5. No proposed pair may reserve a word that another proposed pair already
   reserves (live defect 2). Validation runs across the **combined** cohort +
   manual set before anything is stored.

**Release 2 — Migrate and enforce (ONE `versionchange` transaction).**
*(Amended 21 July 2026: this migration takes IndexedDB **`DB_VERSION` 5**, not 4.
`VARIETY_AND_INTAKE_PLAN.md` C-A1 takes v4 for the phrase-variant list — that
version bump is what removes the stale-client concurrent-writer problem five
review rounds failed to solve any other way. Export `formatVersion` is a separate
sequence, unchanged: v4 private backup, v5 concept-aware; see §9.)*
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

**Three distinct failure paths, three distinct screens** (added v3.1 — the
amendment introduced a pre-write restore outcome the original screen did not
cover). They must not be collapsed into one generic error:

| Failure | When | Recovery offered |
|---|---|---|
| **Malformed restore** | Import validation, before any write | Name the bad records; keep the file; no writes happened |
| **Restore concept conflict** | Import derivation, before any write | Parent-facing conflict screen; no writes happened |
| **DB upgrade failure** | `versionchange`, mid-migration | The startup screen above; old DB intact; forward-only recovery shell |

Only the third can leave the app unable to launch, which is why its recovery
shell is built and tested **before** the migration deploys. Rollback to a
pre-bump build is unsupported: v43 code calling `indexedDB.open(name, 3)`
(`js/db.js:17`) fails with `VersionError` once the database is at v4.

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
- **Backup/export compatibility** — concept-aware payloads use **`formatVersion: 5`,
  not 4** (amended 21 July 2026; see `VARIETY_AND_INTAKE_PLAN.md` §1.3). Format v4 is
  reserved for private pre-concept backups carrying allowlisted `meta`; pre-concept
  **share** payloads remain v3. A v5 backup carries the v4 private `meta`; a v5 share
  **never** carries `meta`.

  **Export `formatVersion` and IndexedDB `DB_VERSION` are unrelated and must never be
  read as parallel.** A v4 *backup* is produced by a device still on **DB v3**;
  concept-aware **DB v5** produces export **v5**. (Feature A takes DB v4; see
  `VARIETY_AND_INTAKE_PLAN.md` C-A1. The two sequences are independent — a v4
  *backup* is written by a device on DB v3 or v4.)

  **Accepted `(formatVersion, payloadKind)` combinations — reject anything else:**

  | Version | Kind | Meaning |
  |---|---|---|
  | 1, 2, 3 | *absent* | Legacy export (kind was not yet recorded) |
  | 3 | `share` | Pre-concept share |
  | 4 | `backup` | Private pre-concept backup, carries `meta` |
  | 5 | `backup` | Concept-aware backup, carries `meta` |
  | 5 | `share` | Concept-aware share, **must not** carry `meta` |

  Explicitly rejected: `4 + share`; version 5 with a missing or unknown kind; **any
  share payload containing a `meta` key** (a hard error, not a filter — it means the
  file was built by the wrong path); unknown versions.

  Restore stays **merge-by-ID** (`js/backup.js:154`). For **v1–v4** input, derive and
  validate `conceptId` against the **complete proposed post-merge set**, not just the
  payload; for **v5** input, validate the supplied concepts against that same complete
  set.

  **Old-format derivation rules (v1–v4), stated as an algorithm:**
  1. Overwriting a word by identical id **preserves the existing `conceptId`** — a
     restore of an old file must never strip a concept the device already has. A
     `conceptId` *supplied* on an old-format row is **ignored** (v1–v4 predate the
     field, so its presence means a hand-edited or mislabelled file); a supplied
     `conceptId` on a **new** id is likewise ignored, never trusted.
  2. The **only** evidence that may create a *new* relationship is Rule A applied to
     the complete post-merge set: a `photoId` shared by exactly one Dutch and exactly
     one Polish word. Name matches create nothing (§4). **Decision table for a
     Rule-A candidate pair, by how many of the two words already hold a concept:**

     | Existing concepts | Outcome |
     |---|---|
     | **Zero** | Mint one fresh `conceptId` and assign it to both |
     | **One** | The word without one **joins** the existing concept |
     | **Two, identical** | Already linked — no change |
     | **Two, different** | **Genuine collision → zero writes, report to the parent.** Never merge two established concepts automatically; each may hold a twin the other cannot absorb |

     After the table is applied, **every remaining word without a concept gets a
     fresh single-member one**, and only then is the complete proposed set
     validated against the unique `[conceptId, language]` invariant.
  3. A **restored `twinAudit` may not be used as evidence.** It is stored
     `ready: false`, and "historical" has to mean non-actionable or the flag is
     decorative.
  4. **Seed confirmations do not survive a restore** — seed markers are deliberately
     never exported (`VARIETY_AND_INTAKE_PLAN.md` C-P4), so a restored dataset needs
     the audit re-run before Release 2.
  5. A genuine collision → **zero writes**, and the parent-facing conflict screen
     above; never a silent remap, never a generic error.

  (Superseded note: this section previously said backups do not carry `meta` at all.
  That was true of v3 and is what `VARIETY_AND_INTAKE_PLAN.md` §1 fixes; a restore
  still invalidates the Release-1 audit, which must be re-run.)

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
- Backup: a **v5 backup** round-trip keeps twins *and* private `meta`; a **v5 share**
  contains no `meta`; a **v4 backup** and a **v3 share** derive concepts against the
  complete post-merge set; a genuine concept collision is reported before any write.
- Backup, version/kind matrix — one test per row and per rejected combination:
  v1, v2, legacy kind-less v3, `3+share`, `4+backup`, `5+backup`, `5+share`; and
  refusal of `4+share`, v5 with missing/unknown kind, a share carrying `meta`, and
  an unknown version.
- Backup, restore edge cases: duplicate ids within **each of `categories`, `words`,
  `photos`, `people` and `recordings`**, and duplicate `meta` keys, within
  one payload are rejected; overwriting by identical id **preserves** an existing
  `conceptId`; a restored `twinAudit` is inert as evidence; a genuine collision
  performs **zero** writes and reaches the conflict screen.
- Audit repair (live defects): a cohort pair overlapping an ambiguous group is
  refused before storage; a word cannot be reserved by two proposed pairs; an
  explicit unsupported `language` aborts rather than becoming Dutch; a rename under
  a stable id invalidates the stored decisions.
- Category delete cascade (v41 safety) still fires only on a strong link.
