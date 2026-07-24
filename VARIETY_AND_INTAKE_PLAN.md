# Plan v11: phrase variety + photo-first intake

Status: **BUILD-READY for step 1.** Thirteen Codex review rounds; round 13's
verdict on step 1 (backup/restore hardening) was *"safe to start — yes"*, with
C-P10b and the openDB fixes confirmed closed. Steps 2-6 are specified but only
step 1 has been signed off to build.

The features here are not built. The **four live data-safety defects found while
planning them ARE fixed and shipped** (v44, §4.0), along with the openDB
robustness fixes.

### How this converged

Rounds 1-5 found real defects in the plan (a privacy leak, a backup that would
have silently stored empty audio, a restore that already lost data). Rounds 6-10
then circled the same class four times: every design that let a cached old client
keep writing the same keys could lose a recording. Round 10 said so explicitly —
*"still circling the previously identified data-loss classes"* — which was the
signal to change the constraint rather than patch again. Feature A now takes a
database version bump, so an out-of-date client cannot open the database at all
and the concurrent writer simply ceases to exist. Round 11 confirmed the class
was gone and added: *"The version bump is not over-engineering. The shadows, CAS
protocols and tombstones were."* Rounds 11-13 closed the remainder.

**First commit of step 1** (per round 13): §1 in full and nothing else — split
backup/share payloads, the recursive Blob codec with its non-empty assertion,
restore aborting rather than silently skipping, per-key `meta` merge rules,
referential validation, the two-phase cursor export, `rev` stamping with
transactional conflict enforcement, and the verified-backup mechanism. No step-2
audit or photo work in it.

Two parent-requested features, plus the outstanding items inherited from the 14
and 19 July sessions.

- **Feature A — phrase variety.** Record several ways of saying each game phrase
  ("Goed zo!" / "Heel goed!"; "Klik op de …" / "Waar is de …?") so she doesn't
  always hear the same wording.
- **Feature B — photo-first intake.** Import many photos at once, then step
  through them assigning category + word(s) + audio.

---

## What the review rounds changed

**Round 1** caught two defects that would have caused real harm: v1 added `meta`
to the export payload, but "💾 Save backup" and "Share with family" call the
*same* `buildExportPayload()` (`js/admin.js:376`) and the share file is published
to a public-if-you-have-the-link Gist — so v1 would have published her private
recordings and Antosia's stickers. v1 also shipped the backup fix *before*
Feature A, so a restore would have written phrase arrays into code expecting a
single Blob.

**Round 2** caught that v2's headline fix silently did nothing. Verified directly:

```
JSON.stringify({id:'pv_1', blob: <Blob>, label:'Goed zo!'})
  → {"id":"pv_1","blob":{},"label":"Goed zo!"}     // the audio is GONE
```

The backup would have contained a complete-looking list of *empty* phrase
records — the worst class of backup bug, because it looks like it worked.

**Round 3 (full-plan review)** found that the P0 work was still the weakest part
of the plan, and produced a better sequencing option:

1. **Restore already loses data silently, today.** Malformed photos, people and
   recordings are filtered out (`js/backup.js:163-173`) but `skipped` counts only
   categories and words (`js/backup.js:174`). A damaged recording disappears from
   an apparently successful restore **without even being mentioned**. v3's C-P7
   protected only `meta`, which is inconsistent with P0's own safety standard.
2. **Restoring `meta` could destroy newer data.** `putAllTransactional` blindly
   `put`s each key (`js/db.js:103`), so restoring an older phrase record over an
   intact phone would **erase variants recorded since that backup**. v3 introduced
   this path and never defined merge semantics. Now C-P12.
3. **The nested-Blob fix covered only phrase variants**, but v3's own C-P4 added
   ledger records containing draft audio — same `{}` failure. Now one codec for
   all of it (C-P3).
4. **Referential validation cannot stay deferred** if a "verified backup" is
   going to gate a destructive migration.
5. **A third sequencing option** neither earlier round considered — a
   concept-neutral **Photo Inbox** — which gets the parent her bulk photo import
   *without* waiting for the blocked migration. Adopted; see §5.
6. Three latent defects in the **already-shipped v42 code** (§4.1).

It also corrected an overstatement of mine: building full Feature B before the
migration would cost roughly **20–30% rework, not "double the work"**. The honest
number is in §5.

---

## 0. What was verified in the code (21 July 2026, live at `?v=43`)

| Claim | Evidence | Status |
|---|---|---|
| Game phrases are single blobs in `meta` | `js/db.js:432`, `:463`, `:474` | Confirmed |
| Sessions consume a flat `{name: Blob}` map | `js/session.js:140`, `:272`, `:283`, `:324` | Confirmed |
| Family voices have their own carriers in `recordings` | `js/session.js:135`; ids `js/db.js:296` | Confirmed |
| Photos are downscaled on the way in | `js/media.js:6` | Confirmed |
| Photos are shared; words hold `photoId` | `js/db.js:32`, `:227` | Confirmed; legacy records may hold inline `photo`, and words carry `extraPhotoIds` |
| A twin is identified ONLY by shared primary `photoId` | `js/admin.js:351`, `:856`, `:2510`, `:2823` | Confirmed |
| **Backups omit the `meta` store** | `js/backup.js:31`, `:67`, `:204` | Confirmed |
| **Backup and Share are the same payload** | `js/admin.js:376` | Confirmed |
| **Share exports every photo row, referenced or not** | `js/backup.js:32`, `:49` | Confirmed |
| **Restore silently drops malformed photos/people/recordings** | `js/backup.js:163-175` | **Confirmed — pre-existing bug** |
| Any new word invalidates the stored `twinAudit` | `js/concepts.js:153` | Half-true — see below |

**Correction on the audit signature.** `datasetSignature` hashes only *sorted word
ids*, so adding or deleting a word invalidates it but **renaming a word or changing
its language, category or photo does not**. And **nothing in v43 calls
`signaturesMatch`** — the audit screen renders from `audit.ready`
(`js/admin.js:1493`) and never checks staleness. See §4.1.

**Docs are one version stale.** `APP_PLAN.md` says "as of 14 July, live `?v=42`"
and `CLAUDE.md:21` describes the pre-v43 child-mode order; the 19 July reorder
(`c9a787b`) updated neither, and `APP_PLAN.md` has no v43 on-phone section.

---

## 1. P0 — make backup and restore demonstrably lossless

Round 3's summary judgement: *"The immediate blocker is not the concept
migration — it is making v4 backup/restore demonstrably lossless across all
existing media and all allowed `meta`, then verifying the retained file without
mutating the only live database."* This section is now the largest in the plan
for that reason.

### 1.1 The problem

`buildExportPayload()` exports five stores; `meta` is not one of them. `meta` holds:

| Key | What it is | Replaceable? |
|---|---|---|
| `phrase-*` | Her recorded carrier clips | **No — her voice** |
| `stickers` | Antosia's collection | No |
| `settings` | Language + `lastBackupAt` | Partly |
| `twinAudit` | The v42 linking decisions | Re-doable, tediously |
| `seeded`, `migrate:*` | Device schema history | Must **never** be restored |

A merge-restore into an intact phone doesn't delete these, but a wipe, reinstall
or lost phone loses them permanently — exactly what a backup is for.

### 1.2 Export contracts

**C-P1 — Backup and Share become separate payloads.**

| | `buildBackupPayload()` | `buildSharePayload()` |
|---|---|---|
| categories / words | yes | yes |
| photos | all | **only those referenced by shared words** |
| people / recordings | yes | yes (unchanged) |
| **`meta`** | **yes, by allowlist** | **never** |

**C-P2 — Share exports only word-referenced photos.** Today every photo row is
exported (`js/backup.js:32`, `:49`); once intake exists, unassigned photos live
in that store and an unfiltered share would publish private pictures no word uses.
Filter by the shared words' `photoId` + `extraPhotoIds`.

**C-P3 — ONE tagged recursive Blob codec for every allowlisted `meta` record.**
This is the round-2 bug, widened by round 3: phrase variants *and* intake ledger
items both nest Blobs, and nesting is invisible to the existing field-by-field
conversion (`js/backup.js:39`, `:59`). After encoding, **recursively assert that
no `Blob` remains** and that every tagged value is a local base64 `data:` URL —
never run the current unrestricted `fetch(dataUrl)` (`js/backup.js:26`) on
arbitrary strings.

**C-P4 — `meta` allowlist:** `phrase-*` (both key generations, §2.3), `stickers`,
`settings` (field-filtered), `twinAudit`, intake ledger records (§3.3). **Never
exported, never restored:** `seeded`, `migrate:*` — restoring "this migration
already ran" onto a device where it has not would skip a needed migration forever.

**C-P5 — `settings` is filtered field-by-field.** `lastBackupAt` (`js/db.js:413`)
and any verification receipt must not be restored: a device would otherwise claim
a backup it never made — a lie told by the feature meant to prevent data loss.

**C-P6 — validate every Blob on the way out, not just the new ones.** Existing
word, person and recording audio is currently decoded from a string and written
with no checks (`js/backup.js:177-202`), so zero-byte or unplayable audio restores
"successfully". Assert non-zero size and decodability for every audio field and
that every image decodes. Include a **per-Blob SHA-256 manifest**, which also
catches corruption that still parses as valid JSON.

**C-P7 — export runs in two phases, because hashing cannot happen inside the
transaction.** Round 5 caught that v4's C-P7 and C-P8 were not jointly
implementable: encoding, decoding and SHA-256 are all **async non-IDB work**, and
awaiting any of them inside an IndexedDB transaction auto-commits it — a
restriction this codebase already documents (`js/backup.js:4`). "Cursor through
one transaction, releasing rows promptly, while hashing each row" is therefore
impossible. The workable pipeline:

1. **Phase 1 (inside one readonly transaction spanning every store):** cursor
   through and build a coherent logical snapshot — all scalar fields copied, Blob
   **handles** retained. No non-IDB `await` anywhere inside. IndexedDB guarantees
   a consistent view within a transaction, so this is the snapshot's coherence
   guarantee; without it a save landing mid-export could produce a backup whose
   digest matches nothing that ever existed.
2. **Phase 2 (after the transaction has completed):** validate, hash and encode
   **one Blob at a time**, releasing each raw reference as it is consumed.

**Stated honestly:** raw Blob handles are held for the duration of phase 1. That
is the real memory floor, and C-P9's ceiling must be measured against it — the
claim is *bounded* peak memory, not *low* peak memory.

**C-P8 — the canonical digest, defined exactly.** "Canonical" was hand-waving in
v4. The digest must specify:

- **Ordering, exactly:** stores in this fixed order — `categories`, `words`,
  `photos`, `people`, `recordings`, `meta`. Records sorted by **that store's own
  key path**: `id` for the five content stores, **`key` for `meta`** (round 6:
  "sorted by `id`" was wrong for `meta`, which is keyed on `key`). Object keys
  sorted lexicographically. Array order preserved as-is — it is meaningful for
  `extraPhotoIds`.
- **Coverage:** all non-media scalar data too — a per-Blob manifest alone cannot
  detect a renamed word or a re-pointed category, which is exactly what the
  Release 2 gate must catch.
- **Per Blob:** SHA-256 of the bytes, plus size and MIME type.
- **Absent vs null, decided:** a key whose value is `null` or `undefined` is
  **omitted entirely** before serialising. So "missing" and "null" collapse to
  the same digest, and a field the app stopped writing does not read as a change.
  Empty string, `0` and `false` are values and are kept.
- **Excluded:** `lastBackupAt` and any verification receipt (C-P5) — otherwise
  verifying a backup would immediately invalidate its own digest.
- **Comparison:** an exact canonical tuple comparison, not another 32-bit hash
  like the shipped `datasetSignature` (`js/concepts.js:153`), whose collision
  margin is far too thin to gate a destructive migration.

**C-P9 — single-file export with a measured ceiling; chunking is NOT specified.**
Test at a minimum of twice the expected real library size on the iPhone. If a
single file exceeds the tested safe ceiling, chunked backup **needs its own
specification and review round** — the manifest, re-selection, ordering and atomic
multi-file restore protocol are all undefined today, and shipping a half-designed
multi-file recovery format would be worse than the memory problem it solves.

### 1.3 Export format versions (round 3's wording, adopted)

Export `formatVersion` is independent of IndexedDB `DB_VERSION` — both currently
reach 4, but they describe different things.

- **v4 backup**: `payloadKind: "backup"`; adds allowlisted, explicitly encoded `meta`.
- **Pre-concept share**: stays **v3** — it contains no `meta` and needs no new
  import semantics, so calling it v4 would mean a v4 file lacking v4's defining
  content.
- **v5 backup/share**: the first concept-aware format. A v5 backup has
  `payloadKind: "backup"` and includes the v4 `meta`; a v5 share has
  `payloadKind: "share"` and must not contain `meta`.

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
file was built by the wrong path); unknown versions. "Only exact known versions
and kinds" was too loose to implement; this table is the contract. It is mirrored
verbatim in `TWIN_LINK_PLAN.md` §9 so the two documents cannot drift.

**C-P15 — duplicate ids and duplicate `meta` keys within one payload are
rejected**, before any write. A payload containing the same word id twice has no
defined merge outcome and must not be guessed at.

Importing v1–v4 into a concept-aware database must derive and validate `conceptId`
against the complete proposed post-merge dataset before any write; the derivation
algorithm lives in `TWIN_LINK_PLAN.md` §9 (it is Release 2's work, not v44's).

**C-P10 — `TWIN_LINK_PLAN.md` §9/§10 amended from v4 to v5. DONE (21 July).**
Applied with the wording above. **The amendment itself needs targeted re-vetting**
— it changes the compatibility matrix, old-format import, audit restoration and
share behaviour, so TWIN §§5, 6, 9, 10 must be re-vetted together with this §1 and
the restore tests. The pairing rules do not need a third full review merely because
a version number changed.

### 1.4 Restore contracts

**C-P10a — same-id overwrite is a decision, not a default (round 6).** "Merge by
id" currently means *the backup silently wins* — including over a photo or a
recording made since that backup. That is a real destruction path in the recovery
feature itself, and until v44 the confirmation text mentioned only words.

**Decision: the backup still wins — restoring means "put back what that file
says" — but nothing that would replace live media may happen unnamed.** Restore
computes a **conflict report** before writing: records present in both the file
and the database where the live copy holds media the backup's copy lacks or
differs from. The parent sees the count and the affected names, exactly like the
omission report, and confirms. Silence is the thing being removed, not the merge
semantics.

**The conflict check must also be re-applied INSIDE the write transaction**, the
same rule `skipIfPresent` already implements in code (`js/db.js:103`): a record
appearing between the report and the write must not be silently overwritten. A
late conflict is skipped and reported afterwards, never written through.

**C-P10b — and it must detect a CHANGED record, not only a newly-present one.**
`skipIfPresent` compares presence, so a record that already existed at analysis
time and was then *modified* — a re-recorded clip, a replaced photo — is still
overwritten with no report.

Round 12 rejected the first fix for this (compare `updatedAt`, else media byte
sizes): a replacement Blob can be exactly the same size, `updatedAt` is not
mandatory, and photo writes carry no timestamp at all (`js/db.js:263`, `:279`).
A heuristic is not good enough to gate irreplaceable audio.

**Step 1 therefore introduces a real revision token, `rev`.**

- `rev` is a fresh `newId()` value written by **every** path that saves a record
  to a protected store — `saveWord`, `savePhoto`, `savePerson`, the recordings
  writers, and restore itself. Not a counter, not a timestamp: a new opaque
  value on every write, so "changed" is exact rather than inferred.
- Analysis captures the `rev` of every record it intends to overwrite. The write
  transaction re-reads each one and compares. **Any difference — including a
  `rev` that is now absent — means skip and report.** Never write through.
- **Restore discards any `rev` that arrives in a backup file** and stamps every
  record it writes with a fresh one. A token from another device (or another
  time) describes a history this database does not have.
- **Records written before this exists have no `rev`.** Handle those
  conservatively rather than optimistically: if the live record has no `rev` and
  carries any media, it is treated as *possibly changed* and skipped with a
  report. She can then decide per record. Every save after step 1 stamps one, so
  this shrinks to nothing through normal use, and the app is never guessing about
  a recording it cannot verify.

**C-P11 — a malformed blob-bearing record ABORTS the restore.** Any malformed word,
photo, person, recording or allowlisted `meta` record stops the restore before any
write. Today photos, people and recordings are silently filtered and not even
counted (`js/backup.js:163-175`) — the recovery mechanism itself loses data without
saying so. If partial salvage is ever wanted, it becomes a **separately confirmed
recovery mode** that preserves the damaged file and reports every omitted id.

**C-P12 — `meta` merge semantics, defined per key.** `putAllTransactional` blindly
`put`s (`js/db.js:103`), so a naive restore of `meta` would *destroy* newer data.
Required behaviour:

| Key | Merge rule |
|---|---|
| `phrase-<name>` (the variant list) | **Union by variant id; the current value wins on conflicting ids.** |
| `stickers` | Union by identity, never replace. |
| `settings` | Explicit fields only; never `lastBackupAt` or a verification receipt. |
| `twinAudit` | Invalidated by every restore; never replace a current ready audit with an older "ready" one. |
| intake ledger | Current item wins; never resurrect an item whose allocated word ids already exist; recompute the header from surviving items. |

Variants all carry ids after C-A1a, so the union rule is uniform and importing
the same file twice cannot duplicate a clip.

**C-P12b — a backup taken BEFORE Feature A carries a bare Blob, and must merge
onto the same variant rather than beside it.** Step 1 ships before Feature A, so
v4 backups will exist that hold `phrase-<name>` as a plain Blob with no id. The
rule is one deterministic id, used **identically** by the C-A1a upgrade and by
import: **`pv:1:<slot>`** (e.g. `pv:1:clickOnDe`). Only one pre-variant clip can
ever have existed per slot, so the id is unique and stable without hashing.
Therefore:
- C-A1a converts the bare Blob to `{ id: 'pv:1:<slot>', blob, label: '' }`.
- Import converts a bare Blob in a payload to exactly the same id.
- The union rule then does the right thing automatically: same clip → same id →
  the current one wins, no duplicate; a genuinely different later variant has its
  own id and is added.

**C-P12a — restoring an old backup DOES bring back things deleted since it was
made. That is accepted and stated, not engineered away.** Round 10 raised this
for phrase variants, but it is not phrase-specific: merge-by-id restore has
always re-added words, photos and people deleted after the backup was taken, and
that is what "restore" means to the person doing it. The alternative — tombstones
recording every deletion, exported and honoured on import — is a large mechanism
whose only purpose is to make a recovery feature recover *less*.

So: no tombstones. Instead the conflict report (C-P10a) names what the file will
bring back that is not currently here, so she sees "this will also restore 3
things you deleted" **before** confirming, and can decline. The bias stays
"prefer the recording that exists over the one in the file" for conflicts, and
"restore it" for anything absent.

**C-P13 — referential validation of the complete proposed post-merge set.**
Promoted from "deferred" (v3 §4.4) because a *verified* backup is about to gate a
destructive migration. Validate that every word's category exists; every
`photoId`/`extraPhotoIds` target exists; every word recording references an
existing word and person; every ledger item references an existing photo; and,
once on DB v5, that concept constraints hold.

**C-P16 — a fresh-install restore replaces only the provably untouched starter
set.** Browser verification on 24 July found a recovery gap that the review rounds
had missed: the app seeds 13 example words before the Restore button is reachable,
and those words have new random ids on every install. A normal merge would retain
the new examples beside the backed-up copies, so the restored database could not
match its own manifest. Restore may treat the current content as empty only when
it is an exact, complete seed cohort with no photos, recordings, people, progress,
stickers, phrases, audit or intake data, and every seed row has a v45 `rev`.
The review screen names the replacement. Deleting those example rows and writing
the backup happen in the same transaction; every seed `rev` is rechecked inside
that transaction, and any late change aborts the whole restore with zero writes.
All other databases keep the ordinary non-destructive merge behaviour.

### 1.5 The verified-backup mechanism (replaces the timestamp gate)

Today "fresh backup" means `lastBackupAt >= screen-open time`
(`js/admin.js:2269`), and that timestamp is written whenever the share/download
path returns (`js/admin.js:390`) — which proves neither that a file was retained
nor that nothing changed afterwards. Round 3 judged v3's replacement
("validate against the current protected-data fingerprint") correct in principle
but unimplementable as written. Concretely:

**C-P14:** the export embeds a canonical manifest/digest (C-P6). To verify, the
parent **re-selects the exported file**; the app validates all records and media,
then compares that manifest against a **freshly computed digest of the current
database**. Success stores a **non-exportable verification receipt**. Release 2
runs this as an **asynchronous preflight before calling `indexedDB.open(…, 5)`**;
if the digests differ, it shows the backup screen and never starts the upgrade.

This also makes Release 2's required migration-failure screen feasible: the
database currently opens immediately at a fixed version (`js/db.js:14-18`), so
repeatedly attempting a known-bad upgrade *before* any UI renders could not
reliably offer "return to the audit".

---

## 2. Feature A — multiple phrase variants

### 2.1 What was asked for

> "Multiple phrases for when she gets an answer right or wrong, and the searching
> questions… E.g. multiple ways of saying 'goed zo', or 'waar is de…?' instead of
> 'klik op de'."

The second example is a **different wording for an existing slot**, not a new
slot: "Waar is de …?" and "Klik op de …" are interchangeable before the same Dutch
`de` word. So variants live *inside* the existing slots and grammatical agreement
is preserved for free.

### 2.2 Variant records

```js
{ id: 'pv_ab12…', blob: Blob, label: 'Waar is de…?', createdAt: 1690000000 }
```

Round 1 rejected a bare `Blob[]`: deletion by array index means a stale render or
double tap can delete the *wrong* irreplaceable clip. Ids make deletion
unambiguous; `label` lets the UI show the wording.

**Why `meta` and not a new object store:** `TWIN_LINK_PLAN.md` Release 2 owns the
next `versionchange`, and its migration is designed and twice-vetted against DB v3.
A competing upgrade would invalidate that review. `meta` values are
structured-cloneable, so no schema change is needed.

### 2.3 Dual-key backward compatibility

The service worker is network-first, which means it falls back to *cache* when the
network is unavailable (`sw.js:19`, `:28`), so a v43 client can return at any time
— and once an array is written to the old key, that client returns the array and
`decodeBlob` calls `.arrayBuffer()` on it (`js/media.js:221`) and throws.

**C-A1 — Feature A takes a database version bump, which removes the concurrent
writer entirely.**

Rounds 4 through 10 all failed on the same thing, and round 10 said so plainly:
*"still circling the previously identified data-loss classes."* Five designs were
tried — a digest, a CAS check, an optimistic retry, additive normalisation, and
finally making the legacy key BE variant one — and every one of them loses a
write, because all of them accept the same premise: **that a cached v43 client
may keep writing while v44+ writes too.** Round 10's trace is decisive: a stale
Settings screen holds a snapshot and its "Save phrases" rewrites *every* slot it
snapshotted (`js/admin.js:1648`), so it can resurrect a deleted clip and destroy
a newer one no matter how the data is shaped. No storage layout fixes stale
intent.

The premise was self-imposed. v3 of this plan forbade a `versionchange` for
Feature A so DB v4 stayed reserved for `TWIN_LINK_PLAN.md` Release 2 — and that
single constraint is what forced five rounds of increasingly elaborate
workarounds.

**Decision: Feature A opens the database at v4. Release 2 becomes v5.** Version
numbers are free; there is no reason the migration needs *that* integer. The
consequences are all good:

- **A cached v43 client cannot open a v4 database at all** — `indexedDB.open`
  fails with `VersionError` (`js/db.js:17`). It fails loudly and immediately
  instead of silently overwriting her recordings. There is no concurrent writer,
  so there is nothing to detect, reconcile or race.
- **No shadow, no copy, no digest, no CAS, no normalisation, no per-variant
  `sha256`.** All of it existed only to survive a writer that can no longer
  exist. Variants become a plain list under one key, migrated once in the
  upgrade transaction — pure, synchronous, all-or-nothing, exactly the kind of
  migration IndexedDB's version mechanism is for.
- The app **already** requires a force-quit and reopen after every deploy, and
  the project has **already** accepted forward-only recovery for a version bump
  (C-S2). This applies that same accepted rule one release earlier.

Cost: the upgrade is irreversible, so a rolled-back build cannot open her
database. That is exactly the risk Release 2 already carries, and it gets the
same treatment — **the forward-recovery shell (C-S2) is built and tested before
this ships, not before Release 2.** It simply moves earlier in the queue.

**C-A1a — the migration itself.** Inside the v3→v4 `versionchange`: for each
phrase slot holding a bare Blob, write `[{ id: 'pv:1:<slot>', blob, label: '' }]`
in its place (id per C-P12b). Pure and synchronous (no hashing, no `await`), one
transaction, and it either completes or the database stays at v3 with nothing
changed.

**C-A1b — upgrades compose by `oldVersion`, because a phone can jump straight
from v3 to v5.** If she skips the Feature A release, the Release 2 upgrade opens
a v3 database at version 5 and must run **both** steps, in order, in that single
`versionchange`: the phrase conversion first, then the concept migration. Every
`onupgradeneeded` branches on `event.oldVersion` and applies each step it has not
yet had — never assume the previous release ran.

### 2.4 API (`js/db.js`)

```
getStandardPhrases(language)                   → { name: Variant[] }   // shape CHANGES
addPhraseVariant(language, name, blob, label)  → appends, returns id
removePhraseVariant(language, name, variantId) → removes by id
renamePhraseVariant(language, name, variantId, label)
```

`saveStandardPhrase()` is replaced; its only caller is `js/admin.js:1601`.

After the C-A1a upgrade every slot holds a variant list, so reads need no
per-shape branching at all — the defensive "a bare Blob becomes one variant"
fallback stays only as a belt-and-braces guard for a database that somehow
skipped the migration.

**C-A2 — add, remove AND rename each run as ONE readwrite transaction** over the
slot's variant list. A `get` → mutate → `put` across two transactions can
silently drop a just-recorded clip. No non-IDB `await` inside — trivially
satisfiable now that there is nothing to hash there.

**C-A2a — deleted after this version bump, along with the problem it addressed.**
There is no normalisation step at read time and no legacy key to reconcile: the
one-off conversion happens in the C-A1a upgrade transaction.

**C-A3 — every call site of the old flat shape is updated in the same change** —
`js/session.js:140`, `js/admin.js:1371`.

**C-A4 — removing a variant asks for confirmation naming that exact variant.**

### 2.5 Selection

| Phrase | Chosen | Why |
|---|---|---|
| Prompt | **Once per question**, stored on the step | If she taps wrong and it re-asks (`js/session.js:363`), it must re-ask *in the same words*. Rewording mid-question turns a retry into a new puzzle. |
| Correction | Once per (question, wrong word) | Tapping the same wrong picture twice should say the same thing. |
| Praise | Once per answered question | `answered` (`js/session.js:341`) already permits one accepted correct tap per question. |

**C-A5 — never repeat the immediately-previous variant of a slot** when 2+ exist.
The last-used map lives at **module scope** — not on session state, which is
constructed fresh in every `startSession()` (`js/session.js:169`).

**Honest scope correction (round 3):** module scope does **not** survive an iPhone
force-quit, so this promises no-repeat *within the current app lifetime only*. v3's
"yesterday's last isn't today's first" was wrong. Persisting last-used ids to `meta`
would deliver that, and is deliberately **not** worth a write per question.

### 2.6 The praise-cutoff bug — Feature A does not ship without this

Verified at `js/session.js:343-355`: a correct tap calls `playCorrectFeedback()`,
then **700 ms later** `renderStep()` advances to the next word, whose audio uses a
different playback key — which by the one-sound rule cuts the praise off. "Goed
zo!" mostly survives; **"Heel goed gedaan!" would be chopped mid-word**, so the
feature sounds broken the moment she records longer praise.

**C-A6 — the advance waits for praise, with an exact lifecycle:**

- `playCorrectFeedback()` returns its promise and the advance awaits it
  (`playBlobSequence` already resolves `completed | cancelled | duplicate`,
  `js/media.js:276`); today the promise is discarded and a fixed timer races it.
- **After the correct tap all question audio controls are inert** — including
  "🔊 Hear it again", which today has no `answered` guard (`js/session.js:372`)
  and would cancel the praise with a different key.
- Advance only if the same session and step are still mounted.
- **External cancellation never advances** (the parent gate must win); an
  **internal cap timeout does** advance, after stopping playback. v3 conflated
  these two and contradicted itself.
- Keep a short minimum visual pause when there is no praise clip, so confetti reads.

### 2.7 Recording durability and validation

**C-A7 — each completed take saves immediately, and the control stays busy until
it lands.** Today Settings holds takes in `phraseDraft` until "Save phrases"
(`js/admin.js:1578`), so a force-quit loses the visit's work. Note
`buildAudioControl` currently calls `setBlob(blob)` **without awaiting it**
(`js/admin.js:164-180`) — the contract requires an awaitable setter, with the
control disabled until validation and the IDB transaction complete.

**C-A8 — reject empty or unplayable takes at record time.** `recordAudio` resolves
a Blob even when an interruption produced no usable chunks (`js/media.js:110`).
Check size and decodability (`canDecodeAudio`, `js/backup.js`) before storing.

**C-A9 — detect interruption *during* a take, in code.** Round 3 showed §4.6 cannot
stay an on-phone test item: current logic only rejects an already-muted cached
stream *before* the next recording (`js/media.js:55-74`), and **decodable silence
passes C-A8**. Listen for track `mute`/`ended` during the take and reject that take.

### 2.8 UI

```
Prompt for "de" words
  ▶ 1  "Klik op de…"        ✎  🗑
  ▶ 2  "Waar is de…?"       ✎  🗑
  ＋ Add another way of saying this
```

Relabel `PHRASE_SPECS` (`js/admin.js:1332`) to "e.g. 'Klik op de…', 'Waar is de…?',
'Zoek de…'". **Two interchangeability warnings must appear**, because a wrong
variant produces confidently wrong grammar rather than an error:

- **Dutch:** every variant in the `de` slot must end so a `de` word follows.
  "Waar is het…?" in the `de` slot yields *"waar is het banaan"*.
- **Polish:** `js/db.js:437` is explicit that carriers must fit the **bare
  nominative**. "Gdzie jest …?" works; "Pokaż …" demands the accusative and yields
  *"Pokaż banan"* where "Pokaż banana" is correct.

Removing the last variant is allowed and means "play the bare word".

### 2.9 Family voices — deferred

Sessions build a family voice's `phrases` from `recordings` (`js/session.js:135`);
both branches unify to `{name: Variant[]}`, the family branch wrapping its single
blob. Variants are for the parent's own voice only. Carrier ids are deterministic
so re-import overwrites rather than duplicates (`js/db.js:304`), so variants would
need an index in that id *plus* changes to remote request generation, the family
recording page, response validation, import and management UI. Deferred on scope,
not because it is free.

---

## 3. Feature B — photo-first intake

### 3.1 What was asked for

> "I end up taking a lot of photos and then it takes time to add it for each word.
> Can we build an alternative option to do it the other way around? Eg that I can
> mass import photos from my photo library, and then click through a process where
> I assign each photo a category, list the Dutch / Polish word and record the
> audio."

**Alternative, not replacement.** Delivered in two stages (§5): a concept-neutral
**Photo Inbox** first, then bilingual completion after the migration.

### 3.2 State machine

| State | Meaning | Who owns the photo |
|---|---|---|
| `pending` | Ingested, not yet decided | The ledger item |
| `committed` | Word(s) created | The word |
| `deferred` | "Skip, decide later" | The ledger item, surfaced in the tray |
| *(discarded)* | Rejected | Nobody — photo and item deleted together |

**An intake is finishable only when no item is `pending`.** Round 3 simplified
this: a successful discard deletes photo *and* ledger item in one transaction, so
a durable `discarded` row is unnecessary — it is in-progress UI history at most.
The tray record **is** the deferred ledger item; deferred data is never copied
into a second model.

### 3.3 Ledger schema (explicit — C-B1)

Round 3 found C-B3/B4/B9 unimplementable without this.

```
meta['photoIntake']            → { openedAt, language, itemIds: [...], revision }
meta['photoIntake:item:<id>']  → { id, photoId, status, revision,
                                   wordIds: { nl?, pl? },   // preallocated
                                   conceptId?,              // post-migration only
                                   draft: { categoryId,
                                            text:  { nl?, pl? },
                                            audio: { nl?, pl? },   // Blobs
                                            article, useEen } }
```

**`language` and per-language audio are persisted (round 4).** The intake runs in
a language, and the Inbox stage writes one language while the later bilingual
stage writes two — a single ambiguous `audio` field could not survive that
transition, and a resumed intake would not know which language its draft belonged
to. `text` and `audio` are keyed by language from the start, so the bilingual
stage adds a key rather than reinterpreting an existing one.

**Only one intake may be open at a time.** When the last non-deferred item is
resolved, the header is deleted and deferred items remain as standalone tray
records. One record per item, not one giant record: v2 rewrote everything on each
keystroke, structured-cloning every draft Blob in the intake — a real iPhone
memory and I/O problem.

**C-B2 — drafts persist at the right granularity:** a recorded take is written
**immediately**; text is debounced briefly and flushed on blur, navigation and
`visibilitychange`.

**C-B3 — ledger records are in the backup allowlist** (C-P4) and go through the
C-P3 codec, since `draft.audio` is a nested Blob.

**C-B4 — committed items' records are deleted when the intake finishes**, along
with their draft blobs; deferred records persist as tray items.

### 3.4 Ingest

`<input type="file" accept="image/*" multiple>` → for each file, **sequentially**:
decode + downscale → **write the photo row and its ledger item in ONE transaction**
→ progress "Preparing 7 / 24".

**C-B5 — photo row and ledger entry commit atomically.** `savePhoto()` is its own
transaction (`js/db.js:217`); a force-quit between it and a separate ledger write
leaves an invisible unowned photo.

**Honest correction:** a force-quit during ingest **does** lose the not-yet-processed
selections — those `File` handles live only in page memory. v1's "loses nothing"
was false. Everything already ingested survives.

**C-B6 — release memory explicitly, not just "process sequentially":** copy the
`File`s and clear the input immediately, null each processed slot, close bitmaps
and reset canvases. Otherwise the input's `FileList` retains every original for the
whole run.

**C-B7 — `createImageBitmap` needs a fallback.** It is the only decode path
(`js/media.js:6`). iOS normally transcodes HEIC for `accept="image/*"`, but that
must not be assumed: add an `<img>` + canvas fallback and, if both fail, skip that
photo by name without aborting the batch.

**C-B8 — revoke object URLs between wizard steps.** Existing controls create them
without revoking (`js/admin.js:79`).

### 3.5 The per-photo wizard

Counter "7 / 24". Per photo: the photo large; **a category picker defaulting to the
previous photo's category** (the biggest time-saver, since she photographs by
theme) plus "＋ New category"; the word + de/het + "een" toggle (`guessUsesEen`,
`js/db.js:498`); **inline audio recording**, skippable; **Skip** / **Discard**;
‹ Prev / Next ›.

**C-B9 — ids are allocated into the draft before any write**, so resume is
idempotent.

**C-B10 — a commit is ONE transaction, via a dedicated `commitIntakeItem()` that
does NOT call `saveWord()`.** `saveWord` performs photo and word writes in separate
awaited transactions (`js/db.js:233`), so reusing it cannot give atomicity.
`commitIntakeItem()` prebuilds photo-free word records and writes the word(s) and
the stripped ledger item together, translating a unique-index abort into the C-B16
conflict screen. To avoid logic drift, extract the shared pure
normalisation/defaults/validation helpers and have **both** write paths use them.

**C-B11 — the transaction includes `categories` when the item creates one.**
`findOrCreatePairedCategory` performs up to three separate writes
(`js/admin.js:777-800`), so an inline new category could otherwise survive a failed
word commit. Preallocate category ids and include the store in the same transaction.

**C-B12 — discard is atomic:** delete the photo and the ledger item together.

**C-B13 — committed steps are read-only in the wizard**, with an explicit "Edit
saved word(s)" action routing to the normal editor. "Prev edits by stable id"
invited half-written twins through a second, non-atomic path.

**C-B14 — Next / Discard / Finish are re-entrancy guarded**, and new words get the
**full default field set** from the existing creation path (`js/admin.js:824`),
scheduling and status fields included.

### 3.6 The Unassigned photos tray

Deferred photos appear in a permanent **Unassigned photos** view: grid, "use this
photo" (opens the wizard), "delete". The ledger item is the record — no second model.

**C-B15 — no photo is ever unreferenced and invisible.** It is owned by a word, an
open intake, or the tray. There is deliberately **no automatic sweeper** — it would
race the wizard and could delete the photo she is looking at. **Pre-existing orphans
must be adopted:** `saveWord` can already create a photo and then fail before the
word write (`js/db.js:233-244`), so on first launch the tray scans for unreferenced
photos and offers to adopt or delete them. Without that scan, C-B15 is simply false
on her current database.

Placement: an **"Unassigned photos (N)" badge beside the intake entry**, with
Settings as a secondary route. This is ownership state, not optional housekeeping.

### 3.6a Same-language collisions in the Photo Inbox — blocked, not adopted

Round 4 caught a hole in the split: the Inbox has "no same-name adoption", which
without a further rule means it would **silently create a duplicate word**. That
is worse than adoption, and it would also manufacture exactly the ambiguous photo
groups the migration cannot resolve alone.

**C-B20 — the Inbox refuses a same-language name match.** It shows "You already
have *banaan* in Ontbijt", with the existing word's photo, and offers only:
**open that word** (to add this picture there via the normal editor), or **change
the name**. It does not adopt, and it does not create a second word. Adoption
arrives with the bilingual stage (C-B16), where the concept model can express the
result.

### 3.7 Collisions (bilingual stage — see §5)

| Case | Behaviour |
|---|---|
| New word's name matches an existing word **in the same language** | Ask: add this photo to the existing word, or create a separate word? Never silently adopt. |
| Cross-language name match | The v41 "Same thing?" conflict screen. |
| Both twins named, one collides | Resolve before either is written; the commit stays atomic (C-B10). |
| Inline category name matches an other-language category | Confirm — C-B17. |

**C-B16 — adoption resolves the concept; the draft's preallocated ids do not win.**
The rule is **one resolved concept per committed semantic pair**, not "one
conceptId per photo-draft". Adopt the existing concept and join the other entered
language to it. Round 3 corrected v3 here: if that concept **already has a twin in
the entered language**, do not categorically reject — **reuse that existing twin
when the entered text agrees**, and show an edit/conflict choice when it differs.

**C-B17 — category pairing is a collision path too.** `findOrCreatePairedCategory`
(`js/admin.js:762`) adopts an other-language category on a one-way link *or an
identical name*, then treats that link as authoritative. Same-name adoption must be
confirmed, consistent with the v41 principle that a name match authorises nothing
destructive.

### 3.8 Storage and follow-up

**C-B18 — `getStorageStatus()` cannot answer "is space tight"**: it returns
`{supported, persisted, usageBytes}` (`js/db.js:390`) with no quota. Extend it to
return the quota it already fetches from `navigator.storage.estimate()`. The
"warn above ~30 photos" threshold is a usability guard, not a storage calculation.

**C-B19 — a completed intake offers a backup.**

---

## 4. Outstanding items

### 4.0 SHIPPED in v44 — four live data-safety defects

Found by review rounds 3–6 while planning the above, cleared by round 5 to ship
ahead of the full programme, and verified in headless Chromium (54 assertions,
zero console errors):

1. **Restore lost data silently.** Malformed photos, people and recordings were
   filtered out while `skipped` counted only categories and words. Now
   `analyzeImportPayload` (pure, write-free) itemises every omission —
   `{store, index, field?, identity, reason}` — the restore screen lists them and
   asks before writing, and `importPayload` **refuses by default**, which covers
   `importFromGist`. Round 6 extended this to **duplicate ids within a payload**
   (the second copy used to silently replace the first) and to **damaged media
   inside an otherwise-valid row** (an empty or non-`data:` audio field used to
   vanish, and non-`data:` strings were being handed to `fetch()`).
2. **The audit could put one word in two pairs** — `ambiguousIds` was computed
   after the cohort filter, and `validateManualPair` never enforced its own
   "already spoken for" rule. Release 2 would have aborted deterministically.
3. **Unrecognised languages were silently read as Dutch.** `wordLanguage` now
   returns `null` for an explicit unsupported value; the audit names those words
   and blocks saving. Round 6 caught that `null` was *not* automatically safe:
   `findTwin` matched on `!== lang`, so a `de` word became an `nl` word's twin,
   and `classifyPhotoGroups` called `{nl, pl, de}` a clean pair. Both fixed.
4. **The seed cohort never checked its seed marker.** It now requires both
   markers plus a complete category set, matches word text exactly, and accepts
   legacy Dutch category ids only via one explicit alias that must actually exist.

Saved audits are `auditVersion: 2`; anything else is shown as set aside and must
be re-made. The check fails **closed** (`!== 2`, not `< 2`).

**Still owed on this thread:** a v2 audit is not yet re-validated against the
dataset signature, so it can still be *displayed* as current after words change
(§4.1). That is Release 2's gate, not v44's.

### 4.1 Translation linking, Release 2 — plus three defects in shipped v42 code

The migration is designed, twice-vetted, **not built**. It assigns `conceptId`,
normalises `language`, creates the unique index, then drops the `w.photoId &&`
clause at `js/admin.js:355` — the line that actually fixes "I can't add a Polish
word for a photo-less Dutch word".

**Round 3 found three defects in code that is already live**, all of which would
make the migration abort or misbehave. These are now migration blockers:

1. **The seed cohort ignores its own evidence requirement.**
   `TWIN_LINK_PLAN.md:94-98` requires a seed marker as cohort evidence, but
   `detectSeedCohort` receives only words and never checks `meta`
   (`js/concepts.js:95-145`).
2. **A cohort pair can overlap an ambiguous photo group,** so the audit can save
   one word in two proposed pairs. `cohortPairs` excludes automatic photo pairs but
   **not ambiguous ids** (`js/concepts.js:176-196`), and `validateManualPair` does
   not enforce its own comment's "neither already spoken for" claim
   (`js/concepts.js:210-218`); the save path is `js/admin.js:2461-2478`. Release 2
   would then abort deterministically — on a migration that is meant to be
   all-or-nothing over her only copy.
3. **`wordLanguage` silently converts any unsupported explicit language to Dutch**
   (`js/concepts.js:27-30`), while `TWIN_LINK_PLAN.md` requires unsupported values
   to fail validation. Missing language may default to Dutch; an explicit invalid
   language must abort and be repaired.

Also still owed: the audit signature is **id-only** and cannot detect that a word
id now holds different content, so Release 2 needs a **content-sensitive
fingerprint**; and since **nothing calls `signaturesMatch`**, the v42 audit screen
can already present stale decisions as actionable — it needs a visible
"out of date, re-run" state regardless of when Release 2 lands.

### 4.2 Photo forking — promoted to its own early release
`saveWord` overwrites a shared photo blob in place, in a *different* transaction
from the word write (`js/db.js:233-244`), so editing one twin's picture changes
both. `TWIN_LINK_PLAN.md:181` already specifies the reference-aware transactional
helper; this plan adopts those contracts and tests. Round 3 moved it earlier
(§5 step 2) because the bug is live in the editor **today**, not only under intake.

### 4.3 Silent same-name adoption — superseded by §3.7.

### 4.4 Backup restore referential validation — **promoted to P0** (C-P13).

### 4.5 Broader write atomicity — partly absorbed by C-B10/C-B11 and §4.2.

### 4.6 Mic interruption during a take — **promoted to code** (C-A9).

### 4.7 Docs stale at v43 — folded into the first shipped change.

### 4.8 On-phone testing backlog — v37 through v43, largely unconfirmed.

---

## 5. Sequencing — revised around the Photo Inbox

### The change

v3 put Feature B **last**, behind a migration that is itself blocked on an
external review. Round 3 proposed a third option neither earlier round considered,
and it is adopted: **split Feature B**. Almost all of it is identity-neutral —
roughly 15 of its 19 contracts (ingest, per-item persistence, tray ownership,
image handling, recording durability, discard, storage reporting) don't care how
twins are identified. Only the bilingual commit, adoption and their collision tests
do.

So the **Photo Inbox** ships early: bulk ingest, durable ledger, the tray,
category + **one language's word** + that word's audio. No bilingual commit, no
adoption, no concept merging, no paired-category creation — and a same-language
name match is **refused** rather than duplicated (C-B20). Each committed item
creates a single-member word/photo group, which the migration safely gives its own
concept, so the Inbox is concept-*neutral* rather than concept-*hostile*.

**Two honest corrections about rework.** v3 said building Feature B before the
migration would "double the work"; round 3 put full-B rework at **20–30%**, so
v3's figure was wrong and overstated the case for waiting. Round 3 then estimated
the reduced Inbox at "under 10%", and round 4 rejected **that** as undefensible
until the post-migration extension points are pinned down. So: **no percentage is
claimed.** What is claimed structurally is that the Inbox's identity-dependent
surface is confined to `commitIntakeItem()` (C-B10), the collision screens
(§3.6a/§3.7) and the ledger's `conceptId` field — everything else is untouched by
the migration.

### The order

Steps are numbered by dependency, **not** by version label. Feature A floats, so
fixed `v44…v48` numbering would go stale the moment it lands between two others;
the `?v=N` number gets assigned when each release actually ships.

1. **Backup/restore hardening, alone.** §1 in full: split payloads, the Blob codec,
   restore-aborts-on-malformed, `meta` merge rules, referential validation,
   single-transaction cursor export, the verified-backup mechanism, the
   version/kind matrix. Includes the docs refresh (§4.7) and the completed
   `TWIN_LINK_PLAN.md` amendment (C-P10).
2. **Audit defect repairs (§4.1) + the reference-aware photo-replacement helper
   (§4.2).** Both are live bugs. **Two separate commits**, because they protect
   different things: photo forking stops irreversible picture replacement *today*
   (`js/db.js:227-244`), while the audit repairs protect the later migration.
3. **Photo Inbox** (concept-neutral, with C-B20).
4. **Feature A** — after step 1 (whose codec and merge tests must already cover
   the variant list), and it now carries the **DB v4 bump plus the
   forward-recovery shell** (C-A1/C-S2). That shell is a prerequisite for
   Release 2 anyway, so building it here means the riskiest release later inherits
   an already-tested recovery path rather than a freshly written one.
5. **Release 2, alone.** Re-run the audit over the new words, verify a current
   backup (C-P14), then migrate. **C-S1: nothing else ships in that release** —
   its own plan requires a migration-failure screen because a deterministic
   upgrade failure would otherwise brick every launch (`TWIN_LINK_PLAN.md`).
6. **Bilingual/adoption completion of Feature B** (§3.7, C-B16/C-B17).

**C-S2 — rollback past a version bump is unsupported, and this now applies from
Feature A onward, not just at Release 2.** Once the database is at v4, v43 code
calling `indexedDB.open(name, 3)` (`js/db.js:17`) fails with `VersionError`.
Recovery is **forward-only**: a fixed shell, built and tested *before* the first
version bump ships. Feature A takes v4 (C-A1), Release 2 takes v5.

**C-S3 — ordering does not keep the audit valid by itself.** She can add or delete
a word between any two deployments, so Release 2 must recompute and compare the
fingerprint at upgrade time regardless of what shipped when.

---

## 6. Verification plan

Per `.claude/skills/verify/SKILL.md`: static server on :8321 + headless Chromium,
`getUserMedia` stubbed with an oscillator `MediaStreamDestination`.

**C-V1 — never wipe or trial-restore on the real iPhone.** The Home Screen app's
storage is the only copy of her real data (`CLAUDE.md:30-34`). On-phone backup
verification **re-selects and analyses without writing**; every wipe/restore test
runs in disposable browser storage.

**C-V2 — test atomicity by fault injection, not by hand.** "Force-quit while a
transaction is pending" is not reliably hand-timable. Use automated page
termination in the harness; reserve the phone for memory pressure, share-sheet
retention, HEIC fallback, mic interruption and resume UX.

**C-V3 — deterministic selection tests.** Inject the RNG and test the selection
function directly rather than sampling "~20 questions", which makes results flaky.

- **Restore conflict detection (C-P10b):** a record modified between analysis and
  the write is **skipped and reported**, not overwritten — asserted by mutating
  the record inside the harness after analysis returns; a record with no `rev`
  and media attached is treated as possibly-changed and skipped; a genuinely
  untouched record is written normally.
- **Backup (the largest suite):** every Blob location round-trips to a non-empty
  playable blob, **including nested ledger audio**; corruption in each Blob location
  aborts with **zero writes**; the share payload contains no `meta` (C-P1) and no
  unreferenced photos (C-P2); merge into a **non-empty** database preserves newer
  phrase variants and ledger state (C-P12); `seeded`/`migrate:*` never return;
  `lastBackupAt` is not restored; `twinAudit` returns non-ready; referential
  validation catches a word with a missing category (C-P13).
- **Backup, version/kind matrix (round 4)** — one test per accepted row **and per
  rejected combination**: v1, v2, legacy kind-less v3, `3+share`, `4+backup`,
  `5+backup`, `5+share`; refusal of `4+share`, of v5 with a missing or unknown
  kind, of a share payload carrying `meta`, and of an unknown version.
- **Backup, duplicate handling (C-P15)** — parameterised over **every id-bearing
  section**, not just words: duplicate ids within `categories`, `words`, `photos`,
  `people` and `recordings` are each rejected, as are duplicate `meta` keys. Round
  5 caught that all five stores use overwrite-by-key `put()` (`js/db.js:103`), so
  testing words alone would leave four silent-overwrite paths unproven.
- **Backup, phrase merge:** variants union by id, so importing the same file
  twice yields no duplicates; a conflicting id keeps the CURRENT recording; a
  clip deleted since the backup IS restored and is **named in the conflict report
  first** (C-P12/C-P12a); a v3-era database upgraded by C-A1a yields exactly one
  variant per previously-recorded slot, with the audio intact.
- **Feature A:** a legacy bare Blob still plays; a stale v43 reader still finds a
  playable clip after the upgrade (C-A1a); an out-of-date client cannot open the
  v4 database at all and fails with VersionError rather than writing; deleting
  the last variant leaves the slot empty (the app's "nothing recorded" state);
  long praise is **not truncated** and
  "Hear it again" cannot cancel it (C-A6); an empty take and an interrupted take are
  both rejected (C-A8/C-A9).
- **Photo Inbox:** atomic photo+ledger enqueue; killed mid-transaction leaves
  all-or-nothing; resume is idempotent with no duplicate words **and knows its
  language** (C-B1); discard removes photo and item together; deferred photos appear
  in the tray; the pre-existing orphan scan finds a planted orphan (C-B15); a
  same-language name match is **refused**, creating no second word (C-B20).
- **Before Release 2:** cohort/ambiguous overlap and explicit-invalid-language
  cases (§4.1) — these must fail *loudly* in tests before they can fail during a
  migration.

## 7. On-phone testing

`APP_PLAN.md`'s checklist has **no v43 section at all** (the flow reorder: speaker
collage first, then tiles, then category-aware voice pick) — add it alongside
sections for whatever ships here. Real-iPhone work is scoped by C-V1/C-V2: memory
pressure on a large export, share-sheet retention, HEIC fallback, mic interruption
during a take, and resume UX after a force-quit.

---

## 8. Review status

- **Round 1** — rejected the export approach (privacy leak), the release order
  (shape mismatch), the bare-`Blob[]` model, three false atomicity claims, and the
  pre-migration fallback.
- **Round 2** — *not build-ready*; ten must-fixes, headlined by the nested-Blob
  serialisation bug that would have produced empty phrase backups.
- **Round 3 (full plan)** — *not build-ready*; P0 was still the weakest section.
  Folded in: C-P3 (one codec covering ledger audio), C-P6 (validate all media +
  digest manifest), C-P7/C-P8/C-P9 (cursor export, single-transaction snapshot, measured ceiling), C-P11 (restore aborts
  rather than silently skipping), C-P12 (`meta` merge rules), C-P13 (referential
  validation promoted to P0), C-P14 (a real verified-backup mechanism), §1.3
  (`payloadKind`, share stays v3), C-A1 completions, C-A6 cancel-vs-cap, C-A5
  scope correction, C-A7 awaitable setter, C-A9 (mic interruption becomes code),
  C-B1 (ledger schema), C-B6 (explicit memory release), C-B11 (categories in the
  transaction), C-B12 (atomic discard), C-B15 (pre-existing orphan scan), C-B16
  (twin reuse on adoption), §4.1 (three live v42 defects), §5 (Photo Inbox split),
  C-V1/C-V2/C-V3 (test-method corrections).

- **Round 4 (final; full plan + the TWIN amendment)** — *not build-ready*; seven
  must-fixes, all specification gaps rather than new flaws, plus an independent
  confirmation of the three live v42 defects. Folded in: the `(formatVersion,
  payloadKind)` matrix and old-format derivation algorithm (§1.3 and
  `TWIN_LINK_PLAN.md` §9), C-P8 (single-transaction snapshot), C-P9 (measured
  ceiling; chunking explicitly unspecified), C-P12 (phrase merge rules), C-P15 (duplicate id/key rejection), C-A1 (playback-only, with
  stale takes surfaced), C-B1 (ledger carries language and per-language audio),
  C-B20 (Inbox refuses same-language matches), §5 (no rework percentage;
  dependency-ordered steps instead of fixed version labels; step 2 split into two
  commits), and the TWIN corrections — stale build-ready status, verified-backup
  gate, content-sensitive fingerprint, three distinct failure screens, and the
  DB-version/export-version confusion.

Deliberately left to implementation: the praise cap and minimum pause, the text
debounce interval, the photo-count warning threshold, the tray's layout, whether
step 2 ships as one deployment or two, and single-file versus chunked backup —
that last one only after real-iPhone memory measurement, and only if the chunked
protocol is fully specified first (C-P9).
