# Plan v3 (BUILD-READY): phrase variety + photo-first intake

Status: **build-ready after two Codex review rounds.** Nothing is built yet.
Round 1 rejected v1's approach in two places; round 2 returned "not build-ready"
with ten must-fix items. All are folded in below.

Two parent-requested features, plus the outstanding items inherited from the
14 and 19 July sessions.

- **Feature A — phrase variety.** Record several ways of saying each game
  phrase ("Goed zo!" / "Heel goed!"; "Klik op de …" / "Waar is de …?") so she
  doesn't always hear the same wording.
- **Feature B — photo-first bulk intake.** Import many photos from the library
  at once, then step through assigning category + word(s) + audio, instead of
  starting from a word and hunting for a photo each time.

---

## What the two review rounds changed

**Round 1 caught two defects that would have caused real harm:**

1. **v1 would have leaked her private recordings.** It added the `meta` store to
   the export payload — but "💾 Save backup" and "Share with family" call the
   *same* `buildExportPayload()` (`js/admin.js:376` says so outright), and the
   share file is published to a public-if-you-have-the-link Gist. v1 would have
   published her carrier recordings, Antosia's stickers, and her settings.
2. **v1 shipped the backup fix before Feature A**, so a restore would have
   written phrase *arrays* into code that still expected a single Blob.

**Round 2 caught that v2's headline fix silently did nothing.** Variant records
were to be `{id, blob: Blob, label}`, placed in the JSON payload. Existing export
code explicitly converts *known* Blob fields via `blobToDataUrl`
(`js/backup.js:39`, `:59`); a nested Blob is not one of them. Verified directly:

```
JSON.stringify({id:'pv_1', blob: <Blob>, label:'Goed zo!'})
  → {"id":"pv_1","blob":{},"label":"Goed zo!"}     // the audio is GONE
```

The backup would have contained a complete-looking list of empty phrase records —
the worst class of backup bug, because it looks like it worked. Fixed by C-P3.

Round 2's other nine must-fixes are folded in as the contracts below.

---

## 0. What was verified in the code (21 July 2026, live at `?v=43`)

Both rounds independently checked these against source.

| Claim | Evidence | Status |
|---|---|---|
| Game phrases are single blobs in `meta` | `js/db.js:432`, `:463`, `:474` | Confirmed |
| Sessions consume a flat `{name: Blob}` map | `js/session.js:140`, `:272`, `:283`, `:324` | Confirmed |
| Family voices have their own carriers in `recordings` | `js/session.js:135`; ids `js/db.js:296` | Confirmed |
| Photos are downscaled on the way in | `js/media.js:6` (1024px / q0.85) | Confirmed |
| Photos are shared; words hold `photoId` | `js/db.js:32`, `saveWord` `js/db.js:227` | Confirmed; legacy records may hold inline `photo`, and words carry `extraPhotoIds` |
| A twin is identified ONLY by shared primary `photoId` | `js/admin.js:351`, `:856`, `:2510`, `:2823` | Confirmed |
| **Backups omit the `meta` store** | `js/backup.js:31`, `:67`, `:204` | **Confirmed** |
| **Backup and Share are the same payload** | `js/admin.js:376`; both call `exportAndShare()` | **Confirmed** |
| **Share exports every photo row, referenced or not** | `js/backup.js:32`, `:49` | **Confirmed — drives C-P4** |
| Any new word invalidates the stored `twinAudit` | `js/concepts.js:153` | **Half-true — see below** |

**Correction on the audit signature.** `datasetSignature` hashes only *sorted
word ids*. Adding or deleting a word invalidates it, but **renaming a word or
changing its language, category, or photo does not**. Worse, **nothing in v43
calls `signaturesMatch`**; the audit screen renders from `audit.ready`
(`js/admin.js:1493`) and never checks staleness. So the v42 audit can already
present stale decisions as actionable, and the signature is too weak for what
Release 2 promises. Logged in §4.1.

**Docs are one version stale.** `APP_PLAN.md` says "as of 14 July, live `?v=42`"
and `CLAUDE.md:21` describes the pre-v43 child-mode order; the 19 July reorder
(commit `c9a787b`) updated neither, and `APP_PLAN.md` has no v43 on-phone
section. Fixed as part of the first shipped change.

---

## 1. P0 — backups do not protect the parent's recorded phrases

### 1.1 The problem

`buildExportPayload()` exports five stores. `meta` is not one of them. `meta` holds:

| Key | What it is | Replaceable? |
|---|---|---|
| `phrase-*` | Her own recorded carrier clips | **No — her voice** |
| `stickers` | Antosia's earned collection | No |
| `settings` | Language + `lastBackupAt` | Partly |
| `twinAudit` | The v42 linking decisions | Re-doable, tediously |
| `seeded`, `migrate:*` | Device schema history | Must **never** be restored |

A merge-restore into an intact database doesn't delete these, but a wipe,
reinstall, or lost phone loses them permanently — exactly what a backup is for.
`TWIN_LINK_PLAN.md:233` noted the omission only as it affects the audit; the
irreplaceable-recordings consequence was never drawn.

### 1.2 Contracts

**C-P1 — Backup and Share become separate payloads.**

| | `buildBackupPayload()` | `buildSharePayload()` |
|---|---|---|
| categories / words | yes | yes |
| photos | all | **only those referenced by shared words** |
| people / recordings | yes | yes (unchanged) |
| **`meta`** | **yes, by allowlist** | **never** |

No `meta` key may ever enter the share payload. Her carrier recordings,
Antosia's stickers and her settings are device-private.

**C-P2 — Share exports only word-referenced photos.** Today every photo row is
exported (`js/backup.js:32`, `:49`). Once Feature B exists, unassigned and
deferred photos live in the `photos` store, so an unfiltered share would publish
private pictures that no word even uses. Filter by `photoId` + `extraPhotoIds`
of the shared words.

**C-P3 — Blob-bearing `meta` values get explicit recursive encode/decode, with
validation.** This is the fix for the round-2 finding above. Every variant's
`blob` is converted with `blobToDataUrl` on export and back on import, exactly
as the five known stores already do. **Export verifies that every variant
decoded to a non-empty blob and aborts with a readable error if not** — a backup
that silently contains `{}` where her voice should be is worse than no backup.

**C-P4 — `meta` allowlist:** `phrase-*` (both key generations, §2.4),
`stickers`, `settings` (field-filtered), `twinAudit`, and the intake ledger
records (§3.3). **Never exported, never restored:** `seeded`, `migrate:*` —
restoring "this migration already ran" onto a device where it has not would skip
a needed migration forever.

**C-P5 — `settings` is filtered field-by-field.** `lastBackupAt` (`js/db.js:413`)
must not be restored: a device would otherwise claim a backup it never made,
a lie told by the very feature meant to prevent data loss.

**C-P6 — `twinAudit` restores as historical, forced non-ready.**
`TWIN_LINK_PLAN.md:233` requires a restore to invalidate the audit; since restore
is merge-by-ID and the signature ignores content changes, a restored audit could
authorise pairings for words whose content has since changed.

**C-P7 — malformed `meta` aborts the restore**, rather than being skipped like a
malformed word (`js/backup.js:161`). A silently dropped irreplaceable recording
is the worst outcome; she must be told. `meta` is written inside the same
`putAllTransactional` call as the other stores (`js/db.js:99` already accepts
arbitrary store names).

### 1.3 Format versions: v4 and v5, not one v4 with flags

`TWIN_LINK_PLAN.md:228` already assigned `formatVersion: 4` to "carries
`conceptId`". v2 proposed one v4 plus a `contents[]` capability array; round 2
argued for two exact versions instead, and that is simpler to audit:

- **v4** = adds backup-only `meta` (phrase variants, stickers, settings, audit,
  intake). This plan.
- **v5** = v4 plus concept-aware words and import semantics. `TWIN_LINK_PLAN.md`.

`SUPPORTED_FORMAT_VERSIONS` (`js/backup.js:15`) becomes `[1,2,3,4]` now, `[…,5]`
at Release 2.

**C-P8: `TWIN_LINK_PLAN.md` must be amended to say v5 before either ships.** Two
documents each defining "v4" differently is how you get an unreadable backup.
This is a doc edit, and it is a blocker, not a nicety.

### 1.4 The backup process itself is an iPhone failure risk — in scope

`buildExportPayload` base64-encodes every Blob **concurrently** via `Promise.all`
(`js/backup.js:31`), then materialises the whole payload as a JSON string and
again as a Blob (`js/backup.js:88`). Peak memory is several times the data size,
and Feature B will grow the photo set substantially.

**C-P9: encode sequentially.** Backup is the foundation everything else rests on;
a backup that gets killed by Safari on a large library is not a backup.

---

## 2. Feature A — multiple phrase variants

### 2.1 What was asked for

> "Multiple phrases for when she gets an answer right or wrong, and the
> searching questions… E.g. multiple ways of saying 'goed zo', or 'waar is
> de…?' instead of 'klik op de'."

The second example is **a different wording for an existing slot**, not a new
slot: "Waar is de …?" and "Klik op de …" are interchangeable before the same
Dutch `de` word. So variants live *inside* the existing slots, and grammatical
agreement is preserved for free.

### 2.2 Variant records

```js
{ id: 'pv_ab12…', blob: Blob, label: 'Waar is de…?', createdAt: 1690000000 }
```

Round 1 rejected a bare `Blob[]`: deletion would be by array index, so a stale
render or double tap could delete the *wrong* irreplaceable clip after indices
shift. Ids make deletion unambiguous; `label` lets the UI show the wording.

**Why `meta` and not a new object store:** `TWIN_LINK_PLAN.md` Release 2 owns the
next `versionchange` (the unique `[conceptId, language]` index), and its
migration is designed and twice-vetted against DB v3. A competing upgrade would
invalidate that review and force two destructive upgrades to be reasoned about
together. `meta` values are structured-cloneable, so no schema change is needed.

### 2.3 Dual-key backward compatibility (replaces v2's lazy-write idea)

v2 proposed migrating lazily on first write so stale clients kept reading a Blob.
Round 2 showed this fails: the service worker is network-first, which means it
falls back to *cache* when the network is unavailable (`sw.js:19`, `:28`), so a
v43 client can come back at any time — and once an array is written to the old
key, that client returns the array and `decodeBlob` calls `.arrayBuffer()` on it
(`js/media.js:221`) and throws.

**C-A1 — variants live under NEW keys; the legacy keys stay as a playable
shadow.** New code reads `phrase-v2-<name>` and prefers it. The legacy key
(`phrase-clickon-de`, …) keeps holding **one plain Blob** — the first variant —
so any cached or rolled-back v43 client still plays a valid clip instead of
crashing. Both keys are written in the same transaction as C-A2.

### 2.4 API (`js/db.js`)

```
getStandardPhrases(language)                   → { name: Variant[] }   // shape CHANGES
addPhraseVariant(language, name, blob, label)  → appends, returns id
removePhraseVariant(language, name, variantId) → removes by id
renamePhraseVariant(language, name, variantId, label)
```

`saveStandardPhrase()` is replaced; its only caller is `js/admin.js:1601`.
Legacy normalisation on read: a bare Blob becomes
`[{ id: 'legacy', blob, label: '' }]`, so her existing clips keep playing.

**C-A2 — add, remove AND rename each run as ONE readwrite transaction**
containing the read, the mutation, the new-key write and the legacy-shadow
write. A `get` → mutate → `put` across two transactions can silently drop a
just-recorded clip when two UI actions overlap. No non-IDB `await` inside.
(v2's version of this contract omitted rename, which is the same read-modify-write.)

**C-A3 — every call site of the old flat shape is updated in the same change** —
`js/session.js:140` and `js/admin.js:1371`. A missed one hands an array to
`decodeBlob` and throws.

**C-A4 — removing a variant asks for confirmation naming that exact variant.**
It deletes irreplaceable audio.

### 2.5 Selection: when is a variant chosen?

Not "randomly on every playback".

| Phrase | Chosen | Why |
|---|---|---|
| Prompt (`clickOnDe` / `clickOnHet` / `prompt`) | **Once per question**, stored on the step | If she taps wrong and the app re-asks (`js/session.js:363`), it must re-ask *in the same words*. Rewording mid-question turns a retry into a new puzzle. |
| Correction | Once per (question, wrong word) | Tapping the same wrong picture twice should say the same thing. |
| Praise (`goed`) | Once per answered question | `answered` (`js/session.js:341`) already permits one accepted correct tap per question, so "per correct tap" and "per question" coincide. |

**C-A5 — never repeat the immediately-previous variant of a slot** when 2+ exist;
uniform random repeats more often than listeners expect. **The last-used map
lives at module scope, not on session state** — v2 said "on the session state and
persists across sessions", which is self-contradictory: `state` is constructed
fresh inside every `startSession()` call (`js/session.js:169`). Module scope
gives the intended behaviour (yesterday's last "Goed zo!" isn't today's first)
for the lifetime of the loaded app.

### 2.6 The praise-cutoff bug — Feature A does not ship without this

Verified at `js/session.js:343-355`: a correct tap calls `playCorrectFeedback()`,
then **700 ms later** `renderStep()` advances to the next word, whose audio uses
a *different* playback key — which by the one-sound rule cuts the praise off.

"Goed zo!" mostly survives. **"Heel goed gedaan!" would be chopped mid-word** —
so the moment she records longer praise variants, the feature sounds broken.

**C-A6 — the advance waits for praise, with an exact lifecycle:**

- `playCorrectFeedback()` returns its promise and the advance awaits it
  (`playBlobSequence` already resolves `completed | cancelled | duplicate`,
  `js/media.js:276`); today the promise is discarded and a fixed timer races it.
- **After the correct tap, all question audio controls are inert** — including
  "🔊 Hear it again", which today is still live (`js/session.js:372`, no
  `answered` guard) and would cancel the praise with a different key.
- Advance only if the same session and the same step are still mounted.
- A cancelled or exited playback **never** advances (the parent gate must win).
- A time cap stops playback before advancing, so a corrupt long clip can't hang
  the session.
- Keep a short minimum visual pause when there is no praise clip at all, so the
  confetti still reads.

### 2.7 Recording durability and validation

**C-A7 — each completed take saves immediately.** Today Settings holds new takes
in `phraseDraft` until "Save phrases" (`js/admin.js:1578`), so a force-quit loses
every take from that visit — unacceptable once she is recording several per slot.

**C-A8 — reject empty or unplayable takes at record time.** `recordAudio`
resolves a Blob even when an interruption produced no usable chunks
(`js/media.js:110`). Check size and decodability (`canDecodeAudio` already exists
in `js/backup.js`) before storing, and tell her a take failed. This interacts
with the known mic-interruption gap (§4.6).

### 2.8 UI — Settings → game phrases

```
Prompt for "de" words
  ▶ 1  "Klik op de…"        ✎  🗑
  ▶ 2  "Waar is de…?"       ✎  🗑
  ＋ Add another way of saying this
```

Relabel `PHRASE_SPECS` (`js/admin.js:1332`) from single imperative examples to
"e.g. 'Klik op de…', 'Waar is de…?', 'Zoek de…'".

**Two interchangeability warnings must appear**, because a wrong variant produces
confidently wrong grammar rather than an error:

- **Dutch:** every variant in the `de` slot must end so a `de` word follows.
  "Waar is het…?" in the `de` slot yields *"waar is het banaan"*.
- **Polish:** `js/db.js:437` is explicit that Polish carriers must fit the **bare
  nominative** word. "Gdzie jest …?" works; "Pokaż …" demands the accusative and
  yields *"Pokaż banan"* where "Pokaż banana" is correct.

Removing the last variant is allowed and means "play the bare word" — today's
behaviour for an unrecorded phrase. No slot is ever mandatory.

### 2.9 Family voices — deferred, and honestly so

Sessions build a family voice's `phrases` from `recordings` rows
(`js/session.js:135`). Both branches are unified to produce `{name: Variant[]}`;
the family branch wraps its single blob.

**Variants are for the parent's own voice only in this release.** v1 claimed
later support would be "a pure data change"; round 1 rejected that and was right.
Carrier ids are deterministic so re-import overwrites rather than duplicates
(`js/db.js:304`, contract C3), so variants would need an index in that id *plus*
changes to remote request generation, the family recording page, response
validation, import, and management UI. Deferred on scope, not because it is free.

---

## 3. Feature B — photo-first bulk intake

### 3.1 What was asked for

> "I end up taking a lot of photos and then it takes time to add it for each
> word. Can we build an alternative option to do it the other way around? Eg
> that I can mass import photos from my photo library, and then click through a
> process where I assign each photo a category, list the Dutch / Polish word and
> record the audio."

**Alternative, not replacement.** The word-first flow is unchanged.

### 3.2 State machine

| State | Meaning | Who owns the photo |
|---|---|---|
| `pending` | Ingested, not yet decided | The ledger |
| `committed` | Word(s) created | The word |
| `deferred` | "Skip, decide later" | The Unassigned tray (§3.6) |
| `discarded` | Rejected | Nobody — photo deleted |

**An intake is finishable only when no item is `pending`.** This is what makes
"Skip" coherent; v1's skip had no lifecycle, so items could be neither resumable
nor discarded — i.e. invisible orphans.

### 3.3 Ledger storage: one record per item

**C-B1 — the ledger is a header record plus one record per item**
(`photoIntake:item:<id>`), not a single `photoIntake` blob. v2 stored everything
in one record rewritten on every field change, which structured-clones every
draft Blob in the whole intake on each keystroke — an iPhone memory and I/O
problem, and it leaves duplicate draft audio behind after commit.

**C-B2 — drafts persist at the right granularity:** a recorded take is written
**immediately**; text fields are debounced briefly and flushed on blur,
navigation, and `visibilitychange`. Otherwise a force-quit mid-photo loses the
typed words and a fresh recording — precisely the work this feature exists to save.

**C-B3 — the ledger is in the backup allowlist** (C-P4). Restoring a backup that
contains deferred photos but not their ledger would recreate invisible orphans
and lose the typed text and audio attached to them.

**C-B4 — completed and discarded item records are deleted when the intake
finishes**; deferred records persist as tray items. Otherwise ledgers and draft
blobs accumulate forever.

### 3.4 Ingest — and what a force-quit actually costs

`<input type="file" accept="image/*" multiple>` → for each file, **sequentially**:
decode + downscale → **write the photo row and its ledger item in ONE
transaction** → progress "Preparing 7 / 24".

**C-B5 — photo row and ledger entry commit atomically.** v1 had `savePhoto()`
(its own transaction, `js/db.js:217`) followed by a separate ledger write; a
force-quit between them leaves an invisible unowned photo.

**Honest correction to v1:** a force-quit during ingest **does** lose the
not-yet-processed selections — the unprocessed `File` handles live only in page
memory, so killed at "7 / 24" the remaining 17 must be re-picked. v1's "loses
nothing" was false. What is guaranteed is that everything already ingested
survives.

**C-B6 — sequential ingest is necessary but not sufficient.** A single
high-resolution photo can need hundreds of MB to decode and the `FileList`
retains all originals throughout. Process one at a time, release promptly, and
treat a failure as *skip this photo by name*, never abort the batch.

**C-B7 — `createImageBitmap` needs a fallback.** It is the only decode path
(`js/media.js:6`). iOS normally transcodes HEIC for `accept="image/*"` inputs,
but that must not be assumed — add an `<img>` + canvas fallback; if both fail,
skip that photo with a named warning.

**C-B8 — revoke object URLs between wizard steps.** The existing controls create
them without revoking (`js/admin.js:79`); across dozens of screens that retains
decoded images until Safari kills the tab.

### 3.5 The per-photo wizard

Counter "7 / 24". Per photo: the photo large; **a category picker defaulting to
the previous photo's category** (the biggest time-saver, since she photographs by
theme) plus "＋ New category"; Dutch word + de/het + "een" toggle (default from
`guessUsesEen`, `js/db.js:498`); optional Polish word; **inline audio recording**
via `buildAudioControl`, skippable; **Skip** (→ `deferred`) / **Discard**
(→ `discarded`); ‹ Prev / Next ›.

**C-B9 — ids are allocated into the draft before any write**, so resume is
idempotent: re-running a commit writes the same ids rather than duplicating.

**C-B10 — a commit is ONE transaction over `words` + `meta`, via a dedicated
`commitIntakeItem()` that does NOT call `saveWord()`.** `saveWord` performs photo
and word writes in separate awaited transactions (`js/db.js:233`), and the editor
today saves twins separately (`js/admin.js:1245`, `:1299`) — so reusing it cannot
give atomicity. `commitIntakeItem()` prebuilds photo-free word records and puts
the Dutch word, the optional Polish twin, and the stripped ledger item in one
transaction, translating a unique-index abort into the C-B14 conflict screen.

**C-B11 — discard is atomic too:** delete the photo and transition the ledger
item in one transaction.

**C-B12 — committed steps are read-only in the wizard.** Prev shows what was
saved with an explicit "Edit saved word(s)" action that routes to the normal
editor. v2's "Prev edits by stable id" invited half-written twins through a
second, non-atomic path.

**C-B13 — Next / Discard / Finish are re-entrancy guarded**, and new words get
the **full default field set** used by the existing creation path
(`js/admin.js:824`) — scheduling and status fields included.

### 3.6 The Unassigned photos tray

`deferred` photos go to a permanent **Unassigned photos** view: grid, "use this
photo" (opens the wizard) and "delete".

**C-B14 — no photo is ever unreferenced and invisible**: it is owned by a word,
an open intake, or the tray. There is deliberately **no automatic sweeper**
deleting unreferenced photos — it would race the wizard and could eat the photo
she is looking at.

Round 2's placement point is adopted: this is ownership state, not optional
housekeeping, so it gets an **"Unassigned photos (N)" badge next to the bulk-intake
entry**, with Settings as a secondary route.

### 3.7 Collisions — enumerated, because "same as the editor" is not a contract

The editor's own adoption behaviour is silent and destructive
(`js/admin.js:1260`) and is itself being changed by Release 2
(`TWIN_LINK_PLAN.md` §8), so "same validation as the editor" was never a stable
contract.

| Case | Behaviour |
|---|---|
| New Dutch word, name matches an existing **Dutch** word | Ask: add this photo to the existing word, or create a separate word? Never silently adopt. |
| Polish twin name matches an existing **Polish** word | Same question, same screen. |
| Cross-language name match | The v41 "Same thing?" conflict screen — its existing purpose. |
| Both twins named, one collides | Resolve before either is written; the commit stays atomic (C-B10). |
| Inline "＋ New category" name matches an other-language category | Confirm — see C-B16. |

**C-B15 — adoption resolves the concept; the draft's preallocated ids do not
win.** If she chooses "add this photo to the existing word", that word already
has an id and (post-migration) a `conceptId`. The rule is **one resolved concept
per committed semantic pair**, not "one conceptId per photo-draft": adopt the
existing concept, join the other entered language to it, and **reject the
operation if that concept already contains that language** (the unique index
would abort anyway — better to say so in words she can act on).

**C-B16 — category pairing is a collision path too.**
`findOrCreatePairedCategory` (`js/admin.js:762`) adopts an other-language
category on a one-way link *or an identical name*, then treats that link as
authoritative. Bulk intake with inline category creation exercises this
repeatedly. Same-name adoption must be confirmed, consistent with the v41
principle that a name match authorises nothing destructive.

### 3.8 Storage headroom

**C-B17 — `getStorageStatus()` cannot answer "is space tight"**: it returns
`{supported, persisted, usageBytes}` (`js/db.js:390`) with no quota, so v1's
"warn if space is tight" was unimplementable as written. Extend it to return the
quota it already fetches from `navigator.storage.estimate()`. The "warn above
~30 photos" threshold is a usability guard, not a storage calculation, and is
described as such.

**C-B18 — a completed intake offers a backup.** Newly imported photos and
recordings are phone-only until a backup is actually retained, and this feature
creates many at once.

---

## 4. Outstanding items inherited from previous sessions

### 4.1 Translation linking, Release 2 — the destructive migration
Designed, twice-vetted, **not built**. Assigns `conceptId`, normalises
`language`, creates the unique index, then drops the `w.photoId &&` clause at
`js/admin.js:355` — the line that actually fixes "I can't add a Polish word for a
photo-less Dutch word". Blocked on a final Codex vet of the destructive half and
on a backup that genuinely protects her data (§1).

**Two additions from review:** the audit signature is **id-only** and cannot
detect that a word id now holds different content, so Release 2's promise to
refuse stale decisions needs a **content-sensitive fingerprint**; and since
**nothing calls `signaturesMatch` today**, a visible "these decisions are out of
date, re-run the audit" state is needed regardless of when Release 2 lands.

### 4.2 Photo forking — ships with Feature B
`saveWord` overwrites a shared photo blob in place and in a *different*
transaction from the word write (`js/db.js:233`), so editing one twin's picture
changes both. `TWIN_LINK_PLAN.md:181` already specifies the reference-aware
transactional helper; **this plan adopts those contracts and tests rather than
re-deriving them.** Feature B mass-produces shared-photo twins, so it cannot ship
without this.

### 4.3 Silent same-name adoption — superseded by §3.7.

### 4.4 Backup restore referential validation — deferred, unchanged.
Restore accepts a word whose category doesn't exist, leaving an invisible record.

### 4.5 Broader write atomicity — partly absorbed by C-B10 and §4.2.
Category saves remain outstanding.

### 4.6 Mic interruption *during* an active take — on-phone test, not code.
v39 repairs the *next* take; a take interrupted mid-recording is not detected.
Now interacts with C-A8.

### 4.7 Docs stale at v43 — folded into the first shipped change.

### 4.8 On-phone testing backlog — v37 through v43, largely unconfirmed.

---

## 5. Sequencing

**Release v44 — backup fix + Feature A, together.** They ship as one release
because the backup must know the phrase data shape; restoring variant arrays into
a reader expecting a Blob was the bug round 1 caught. Includes the docs refresh
(§4.7) and the `TWIN_LINK_PLAN.md` v5 amendment (C-P8).

**Then: she records her variants, then makes a verified backup.**

**C-S1 — the Release 2 gate is a *verified* backup, not a timestamp.** Today
"fresh" means `lastBackupAt >= screen-open time` (`js/admin.js:2269`), and that
timestamp is written whenever the share/download path returns
(`js/admin.js:390`) — which proves neither that a file was retained nor that
nothing changed afterwards. Before the destructive migration she must
**re-select the exported file** and have the app validate it against the current
protected-data fingerprint. This replaces v2's C-S1, which round 2 showed was
unprovable.

**Release v45 — Release 2, the translation-linking migration.** Needs its final
Codex vet.

**C-S2 — it ships alone**, with nothing else in the release: its own plan
requires a migration-failure screen because a deterministic upgrade failure would
otherwise brick every launch (`TWIN_LINK_PLAN.md:165`).

**C-S3 — rollback past DB v4 is unsupported, and must be stated before deploying.**
Once the database is at v4, v43 code calling `indexedDB.open(name, 3)`
(`js/db.js:17`) fails with `VersionError`. The recovery path is **forward-only**:
a fixed v45+ shell. That shell is built and tested *before* the migration
deploys, not improvised on the phone afterwards.

**Release v46 — Feature B**, with photo forking (§4.2) and the collision table
(§3.7), built on `conceptId`.

**The v1 fallback stays withdrawn.** Both rounds judged building Feature B before
the migration unsafe: it is tightly coupled to concept identity, unique-index
error handling and the collision screens, so building against two identity models
doubles the work in the most stateful feature in the app. v1 also understated the
audit cost — name collisions and word adoption can produce photo groups that are
*not* clean 1:1, so they would not all land in Release 2's automatic bucket.

**C-S4 — ordering does not keep the audit valid by itself.** This is a daily-use
app; she can add or delete a word between any two deployments. Release 2 must
recompute and compare the fingerprint at upgrade time regardless of what shipped
when (§4.1).

---

## 6. Verification plan

Per `.claude/skills/verify/SKILL.md`: static server on :8321 + headless Chromium,
`getUserMedia` stubbed with an oscillator `MediaStreamDestination` (the
fake-device flag does not work on this Mac). DB-shaped assertions by driving
IndexedDB directly.

- **Feature A:** seed 3 variants; over ~20 questions assert more than one is
  heard, none repeats back-to-back, a re-ask after a wrong tap replays the *same*
  prompt, a legacy bare Blob still plays, a long praise clip is **not truncated**
  (C-A6), "Hear it again" cannot cancel praise, and an empty take is rejected
  (C-A8). Assert a simulated v43 reader still finds a playable Blob on the legacy
  key after variants are written (C-A1).
- **Backup:** **assert every exported phrase variant round-trips to a non-empty
  playable blob** (C-P3 — the round-2 bug, tested explicitly); assert the share
  payload contains no `meta` (C-P1) and no unreferenced photos (C-P2); wipe →
  restore → phrases and stickers return, `seeded`/`migrate:*` do not,
  `lastBackupAt` is not restored, `twinAudit` returns non-ready.
- **Feature B:** synthetic image files through the input; assert atomic
  photo+ledger enqueue. **Test kills while a transaction is pending and assert
  all-or-nothing** — v2 listed boundaries ("after commit before ledger", "after
  the first word before the twin") that cannot exist if C-B10 holds, so testing
  for them would have tested the wrong thing. Also: resume is idempotent with no
  duplicate words; discard removes photo and item together; deferred photos
  appear in the tray; each collision row in §3.7 reaches its screen.

## 7. On-phone testing additions

`APP_PLAN.md`'s checklist has **no v43 section at all** (the flow reorder:
speaker collage first, then tiles, then category-aware voice pick) — add it
alongside sections for whatever ships here.

Real-iPhone **force-quit tests at each boundary**, not just a desktop reload:
during ingest, mid-draft while recording, during a pending commit, during
discard, during backup generation, and during the DB upgrade itself.

---

## 8. Review status

- **Round 1** — rejected the export approach (privacy leak), the release order
  (shape mismatch), the bare-`Blob[]` model, three false atomicity claims in
  Feature B, and the pre-migration fallback.
- **Round 2** — verdict *not build-ready*; ten must-fix items, headlined by the
  nested-Blob serialisation bug that would have produced empty phrase backups.
  All ten are folded in: C-P3 (serialisation), C-A1 (dual-key), C-S1 (verified
  backup), §1.3 (v4/v5 split), C-B1–B4 (per-item ledger, in backup), C-B10/B11
  (`commitIntakeItem`, atomic discard), C-B15 (adoption semantics), C-B12
  (committed-item lifecycle), C-A6 (praise lifecycle), C-P2 (share photo
  filter), §6 (corrected atomicity tests), C-S3 (forward-only recovery).

Deliberately left to implementation: the exact praise cap and minimum pause, the
text debounce interval, the photo-count warning threshold, and the tray's layout.
