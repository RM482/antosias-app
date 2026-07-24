# Plan: "Antosia's app" — parent-led Dutch word-play prototype

## Status (as of 24 July 2026) — live app `?v=47`

**Everything shipped is code-complete, deployed, and locally verified (headless
Chromium, zero console errors). Nothing is half-built.**

**v45 DEPLOYED (24 July):** backup/restore hardening is live. Node contract
coverage plus the real browser suite pass; the latter runs 32 assertions over
image/audio round-trips, private/share separation, retained-file verification,
healthy restore, tamper refusal, reference refusal, revision races and atomic
fresh-install recovery, with zero console errors.

Browser testing found and fixed one gap missed by the plan reviews: a fresh
install seeds 13 random-id example words before Restore is reachable, so a merge
would have duplicated those examples and could never match the backup manifest.
Restore now replaces them only when they are the exact untouched starter set,
names that action in the review, and rechecks every seed revision inside the
same write transaction (C-P16 in `VARIETY_AND_INTAKE_PLAN.md`).

**v46 DEPLOYED (24 July):** the first real-iPhone backup attempt found one old
Stage 1 harness record (`spike-test-word`) with no category. v45 correctly
refused to omit it. v46 shows a narrowly matched, parent-confirmed “Remove old
setup test” repair and moves all future spike persistence data out of the
`words` store. No real word is inferred or touched. The full browser suite
passes 34 assertions with zero console errors; the exact cleanup UI and a
successful post-cleanup backup build were also driven end to end.

**v47 DEPLOYED (24 July):** after the old setup test was removed, the
real-iPhone backup exposed a display-only `extraPhotos` Blob accidentally saved
inside one word by an older edit flow. Its canonical picture remains safely in
the `photos` store and is referenced by `extraPhotoIds`. v47 strips that derived
cache from all future `saveWord` writes and normalises it out of private backup,
family share and verification digests. The real photo-store record remains in
the payload. The full browser suite passes 37 assertions with zero warnings or
errors, including the exact leaked-cache shape, restore and retained-file
verification.

**⏭️ NEXT:** force-quit and reopen the phone app, then repeat Save backup → Save
to Files → Verify backup. Everything else in the plan is specified but NOT
signed off.

**⏸️ STILL PAUSED — `TWIN_LINK_PLAN.md` (now v3.1, and NO LONGER build-ready).**
Three defects in its already-shipped v42 code were found and fixed in v44, which
means the plan itself needs re-vetting before Release 2 is built. It also now
takes DB **v5** (Feature A took v4). Do not build it next.

Shipped newest first:

| v | What |
|---|---|
| v47 | **Leaked extra-photo cache repair.** Prevents `attachPhotos()`'s display-only `extraPhotos` Blob copies from being persisted by `saveWord`, and excludes already-leaked copies from backup/share/digests while retaining the canonical `photos` records referenced by `extraPhotoIds`. |
| v46 | **Legacy spike-test repair.** Detects only the exact invalid `spike-test-word` left by the Stage 1 iPhone harness and offers a parent-confirmed removal so backup validation can pass. Future spike persistence uses non-exported test metadata rather than an invalid word row. |
| v45 | **Verifiable, lossless private backups.** Backup and family share are separate; private backups include allowlisted metadata and an integrity manifest, while shares exclude it. Restore validates every row/reference/media item before one atomic write, protects concurrent changes with revision tokens, and a retained file can be re-selected to prove it matches the phone. Fresh-install restore safely replaces only the exact untouched starter set. |
| v44 | **Four live data-safety fixes**, found by Codex while planning other work. (1) **Restore lost data silently** — malformed photos/people/recordings were dropped and only categories+words were even counted, so a damaged recording vanished from an apparently successful restore. `importPayload` is split into `analyzeImportPayload` (pure, write-free) + `applyImportPayload`; the restore screen itemises every problem by name and asks first; declining writes nothing; `importPayload` refuses by default, covering the Gist path. Also: duplicate ids in a file no longer silently overwrite each other, damaged media inside a valid row is reported rather than blanked away, and a repaired row never overwrites a record that appeared since (re-checked *inside* the write transaction). (2) The **twin audit could put one word in two pairs** (would have made the migration abort). (3) **Unrecognised languages were silently read as Dutch** — now reported, and saving is blocked. (4) The **seed cohort never checked its seed marker**. Saved audits are `auditVersion: 2`; v1 records are set aside. Plus `openDB` gained `onblocked`/`onversionchange` handling and stopped caching a failed open forever. |
| v43 | **Child-mode flow reorder** (19 July, parent request): flag → collage of ALL that language's speakers + language intro → category tiles → (conditional) face pick → session. The collage moved from the end to the beginning; tiles now come before the voice pick, so voices are filtered to people who recorded *that category*. Default voice goes straight to the session; a family voice still gets its own intro. |
| v42 | **Translation linking, Release 1 (non-destructive).** New `js/concepts.js`: the twin-pairing rules, deliberately PURE + SYNCHRONOUS so Release 2 can run them inside a `versionchange` transaction. `SEED_DATA` gains a shared `key` per concept (banaan/banan = 'banana'). New Settings → "🔗 Translation linking". Decisions stored under `meta` key `twinAudit`. Writes NO word records. |
| v41 | Four fixes from a code review, 3 of them v40 regressions: category delete could destroy an **unrelated** same-named category and all its words; the translation wizard could silently fail to link a twin (now a "same thing?" conflict screen); the parent gate only half-filled; the end-screen Done button trapped the parent on a save failure. |
| v40 | Six real-use fixes: session word order shuffled; choice photos show whole; parent hold-to-exit 3s→1.5s; ⭐ Stickers manager in Settings; Dutch↔Polish category pairs mirror; "➕ Add missing translations" wizard on the flag. |
| v39 | iOS mic fix: a muted/interrupted capture stream is dropped and re-acquired instead of reused. |
| v38 | Pictures ~50% bigger, interim real-world-prompt screen REMOVED, ⭐ Sticker book screen, end-screen overlap fixed. |
| v37 | TEST MODE (`TEST_MODE_PLAN.md`): "🎯 Start a test" per category, 2/3/4 difficulty, first tap scored. |
| v36 | Child-mode flow reorder: host intro before the category tiles (superseded by v43). |
| v35 | Multiple photos per word, rotated per appearance. |
| v34 | Rewards: confetti on correct taps, collectible session stickers. |
| v33 | Quick-record wizard + Dutch article/een controls in the Polish editor. |

### The one thing to understand before touching backups

Before v45, the `meta` store was not backed up and Backup/Share used the same
payload. v45 fixed both problems: a **private backup** carries only the allowlisted
phrases, stickers, settings, audit and intake state, while a **family share**
contains no `meta` at all. Never recombine those paths—the share file can be
published to a public-if-you-have-the-link Gist.

Notes for the next session:
- ✅ Confirmed on the phone previously: **Polish audio works** (record + play) and
  the Dutch category names. Everything from v37 onward is still untested on the
  real iPhone (§ checklist below).
- `word.realWorldPrompt` still exists on records and in the editor but no longer
  appears mid-session (v38 cut that screen).
- **Codex CLI runs locally** — `/Applications/ChatGPT.app/Contents/Resources/codex`,
  authenticated, `gpt-5.6-sol`. Use
  `codex exec --skip-git-repo-check --model gpt-5.6-sol -c model_reasoning_effort=high < promptfile`.
  It is read-only in the working directory, so it reads the real source — the old
  "copy the project into Codex's workspace first" blocker no longer applies.
- **Local verification recipe:** `.claude/skills/verify/SKILL.md`. Two gotchas
  learned this session: Settings is the `⚙️` button (not text), and you can drive
  the real modules from a page on the served origin with
  `page.evaluate(() => import('/js/concepts.js?v=44'))` — that is how the 70
  assertions behind v44 run without any UI at all.
- **A lesson worth keeping.** Review rounds 6–10 kept finding the same class of
  problem because a constraint I had invented (no database version bump for the
  phrase feature) forced old and new code to share storage keys. Five designs to
  make that safe all failed. Asking the reviewer *"is this converging or
  circling?"* got the answer "circling", and changing the constraint dissolved the
  class in one move. When the same shape of bug keeps coming back, suspect the
  constraint, not the patch.

---

## ⏸️ PAUSED: translation linking (resume here)

**Paused 14 July 2026 at the parent's request. Spec: `TWIN_LINK_PLAN.md` — now
v3.1 and explicitly NOT build-ready:** three defects in its shipped v42 code were
found and fixed in v44 (see above), so the plan needs re-vetting, and it now takes
IndexedDB **v5** because Feature A claimed v4. Read
`VARIETY_AND_INTAKE_PLAN.md` §5 for where it sits in the queue — it is step 5 of
6, not the next thing to build.

### The problem being fixed

A word's language twin is identified **only** by a shared `photoId`
(`js/admin.js:355`, `:860`, `:2518`, `:2825`). So **a word with no picture can
never have a twin** — the parent cannot quickly add the Polish for a Dutch word
she has recorded but never photographed. This is her actual, still-unfixed
complaint. (A photo-less word IS playable — `isSessionEligible` needs only audio,
`js/db.js:293`, and `wordVisual` falls back to the emoji, `js/session.js:210` — so
"just require a photo" was considered and **rejected**.)

### The fix

Add `conceptId` to words. Twins = same `conceptId`, different language; at most
one word per language per concept. `photoId` stays a picture, not identity.

### Where we got to

- **Release 1 — DONE and shipped (v42).** Non-destructive: the audit screen,
  `js/concepts.js` (pure planner), seed keys, parent decisions stored under the
  `meta` key `twinAudit`. Verified: renamed/duplicated seed words → cohort
  refused; a family photo across 3 words → flagged, never auto-paired; no word
  record touched.
- **Release 2 — DESIGNED, NOT BUILT.** One atomic `versionchange` transaction:
  read all words → run the `js/concepts.js` planner → assign every `conceptId`
  → **normalise every `language`** → create a unique `[conceptId, language]`
  index → verify → commit or abort. Then switch the four twin lookups to
  `findTwin()` and **drop the `w.photoId &&` clause** from the translations
  filter (`js/admin.js:355`) — that is the line that actually fixes her problem.

### Next action when resuming

1. **Get the final Codex vet of Release 2** (the destructive half). It was blocked
   only because the files weren't in Codex's workspace — the parent must copy the
   project there first (Claude cannot: macOS blocks `~/Documents`).
2. Do **not** build Release 2 until that vet says go, and not before confirming the
   parent has a fresh backup. It rewrites the only copy of her recordings.

### Non-negotiables already established (do not re-litigate)

- **Never pair on inference.** Only a photo shared by exactly one Dutch + one
  Polish word, or an intact seed cohort the parent confirms as a batch. A
  same-name or same-text match is **not** evidence.
- **`js/concepts.js` must stay pure and synchronous** — Release 2 runs it inside a
  `versionchange` transaction, where awaiting a non-IDB promise auto-commits half
  a migration.
- **Legacy words can have NO `language` field** (the code has always read
  `language ?? 'nl'`). IndexedDB skips records whose compound key path has a
  missing component, so the unique index would silently NOT enforce the invariant
  on exactly those legacy Dutch words. The migration MUST persist a normalised
  `language`.
- **A migration failure screen is required.** The new JS installs even when the
  upgrade aborts, so a deterministic failure would otherwise brick the app on
  every launch.
- Also still owed by the plan: photo forking (`saveWord` overwrites a shared photo
  blob in place, so editing one twin's picture changes both), and routing the word
  editor's silent same-name adoption through the conflict screen.

### Known follow-ups, deliberately deferred

- Backup restore's **referential validation** (it is already atomic via
  `putAllTransactional`; the gap is that it accepts a word whose category doesn't
  exist, leaving an invisible record).
- Broader write atomicity for category and word+photo saves.
- The on-phone **mic-interruption-during-an-active-take** test (v39 repairs the
  *next* take; a take interrupted mid-recording is not detected).

---

## ON-PHONE TESTING CHECKLIST for next time

**Before anything: force-quit the app on the phone and reopen it** — that's how
it picks up v42. (Home Screen icon only; never delete it, never clear Safari
data.) Take a **fresh backup first** (Settings → 💾 Save backup) — it includes
people and recordings now.

### 0e. v44 — the restore safety fixes (untested on phone)
You cannot easily *cause* a damaged backup by hand, so the useful phone checks are
that the ordinary paths still behave:
- **Settings → ♻️ Restore from backup** with a good file: the confirmation now
  spells out that photos, recordings and people are replaced too, not just words.
  Restoring a healthy backup should report no problems and change nothing
  unexpected. ⚠️ Only restore a backup you are willing to have applied — restoring
  brings back things you deleted after that backup was made. That is intended.
- **Settings → 🔗 Translation linking**: if you saved answers there before today,
  the app now says they have been **set aside** and asks you to go through it
  once more. That is expected — the version that produced them could get pairs
  wrong. Nothing was changed to your words.
- While you are in there, check whether it reports **"words with a language this
  app doesn't recognise"**. On a healthy database it should say nothing. If it
  DOES appear, don't try to fix it in the editor — report it, because the words
  it names need a repair control that does not exist yet.

### 0d. v43 — the new child-mode order (untested on phone)
Tap ▶ Play and check the new sequence:
flag → **a collage of everyone who speaks that language** (with the language name
playing: "Nederlands!") → **category tiles** → *then* the face pick, and only if
more than one person recorded **that particular category** → session.
The collage moved from the end to the beginning, so she meets the speakers first
and picks what to learn second. If only your own voice exists for a category, it
should go straight from the tile into the session with no face pick at all.

### 0c. v42 — translation linking, Release 1 (untested on phone)
Settings → **🔗 Translation linking**. It changes nothing; it only asks. Expect:
a backup gate (Save is disabled until you back up *in that flow*), then the
starter-set batch (`de banaan ↔ banan`, …) to confirm, then any ambiguous groups.
**If any proposed starter pair looks wrong, do NOT tick it — report it instead.**
That list is derived, and the parent's eyes are the check on it.

### 0b. v41 — review fixes (untested on phone)
- **Category delete is now safe:** deleting a category only removes the
  other-language one when they are genuinely linked. If an unlinked same-named
  category exists, the confirm box says it is being left alone.
- **Translations wizard asks:** typing a translation that matches an existing word
  now shows a "Same thing?" screen with both words side by side.
- **Parent gate:** the dot now fills fully in ~1.5s (it used to stop halfway).
- **End-of-session Done:** if saving fails it now says so and offers Retry.

### 0a. v40 fixes — quickest tour
- **Add translations:** on the 🇳🇱 flag, look under "Record missing audio" for
  **"➕ Add missing Polish translations (N)"** (only appears for words that have
  a picture but no twin yet). Add a couple (type the word; de/het picker shows
  when the target is Dutch), then switch to 🇵🇱 — those words now exist and show
  up in **"Record missing audio"** for Polish.
- **Category mirroring:** add a category on 🇳🇱 → switch to 🇵🇱 → it's there with
  the same emoji. Change a Dutch emoji → the Polish twin follows. ⚠️ Deleting a
  category now also deletes its paired other-language category **and its words**
  — the confirm dialog spells that out.
- **Stickers manager:** Settings → **⭐ Stickers** → tap one to remove it, or
  "Reset all". (It's in Settings so Antosia can't wipe her own collection.)
- **Session feel:** run a session — the word order varies (no longer always the
  same first word), the pictures show whole/uncropped, and the hold-to-exit dot
  is quicker (~1.5s).
- **Mic (v39):** during a recording, trigger a notification/Siri, then finish —
  the take should still have sound, not silence.

### 0. v38 look & flow
Run one practice session: the two choices are BIG and stacked vertically; a
correct tap goes **straight to the next word** (no "give Papa the banana"
screen anymore); the end screen's sticker no longer overlaps "Today's words".
Then tap **⭐ Sticker book** on the home screen: her collection shows as a big
grid, and the only way out is the hold-the-dot parent gate.

### 1. Test mode (v37)
Open a category → "🎯 Start a test" with difficulty 2: audio asks immediately
(no big photo first), correct tap → confetti → next question. Raise difficulty
to 4: four pictures in a 2×2 grid; a wrong tap wiggles + corrects gently and
re-asks. End screen: score matches what actually happened, "Understood"
pre-ticked only on first-try-correct words, sticker still awarded, Done saves
and returns home.

### 2. Quick-record wizard (v33) — finish the Polish content
Confirmed working this session. Remaining: step through the rest of the 🇵🇱
words with Mama ("🎙 Record missing audio (N words)" on the Polish flag) until
the count reaches zero — that completes Stage 5's outstanding content work.

### 3. Dutch article fix from the Polish editor (v33)
🇵🇱 → open a Polish word → "Also in Dutch" section now has the de/het picker,
the "een" toggle, and a live "de banaan" preview. **Note:** Dutch twins created
from the Polish side *before* v33 were saved with no article — open those once
and set de/het.

### 4. Multiple photos per word (v35)
Open a word → "More photos of the same thing (optional)" → ＋ Add photo (2–3
different paintings / cups / balls) → Save → reopen (they persist) → run a
session and confirm the picture changes between appearances. Tap a thumbnail to
remove one.

### 5. Rewards (v34)
Run a full session: confetti on each correct tap; the end screen shows a new
sticker + the growing shelf. A second session gives a different sticker. Exiting
early via the parent gate earns nothing (by design).

### 6. Child-mode flow (v36) — needs a default person first
Settings → 👪 People & voices → add yourself: name, photo, 4s intro clip
("Nederlands!"), **Default voice = Yes**. Then ▶ Play → flag → **your photo +
"Nederlands!" appears BEFORE the category tiles** → tiles → session. The intro
must not repeat after picking a category.

### 7. Family voices — Phase B (never tested on the phone)
Add a non-default person → "🎙 Record words in X's voice" → record 2–3 words
(silly accent is fine) → ▶ Play → face pick appears → session plays in that
voice. Then take a fresh backup (it now carries recordings).

### 8. Remote recording — Phase C (never tested on the phone)
Build a request on the phone → AirDrop the file to the Mac →
`~/.local/bin/gh gist create <file>` → open
`https://rm482.github.io/antosias-app/?record=<gistId>` in a FRESH browser
profile (a private window is fine — the page uses no storage; confirm no
`antosia-app` database is created, and that opening the plain app URL afterwards
still seeds as a first-open) → record → "📤 Versturen" → import the file via
Settings → "📥 Import family recordings" → face pick offers them → **import the
same file again → no duplicates**. **Test once from an Android device BEFORE
asking the whole family** (codec risk — the import's decode-check reports
unplayable clips by name).

### 9. Force-quit + reopen with real data intact
The perennial check: after all of the above, force-quit and reopen — photos,
audio, stickers, people all still there.

✅ Already confirmed on-device: Dutch category names read Ontbijt / Kleren /
Speelgoed.

---

## Shipped earlier (v33–v36) — details — v37 spec: TEST_MODE_PLAN.md; v38: commit 1b4fba6; v39: commit 2a247f4; v40: commit 97cb5f9

**v36 — child-mode flow reorder (parent request):**
New order: flag → **host intro** (default person's photo + "Nederlands!"/
"Polski!") → category tiles → face pick (>1 voice) → **family-voice intro only
when a non-default voice was picked** (the host's own intro never repeats) →
collage → session. Supersedes STAGE_6_PLAN contract C1's original order;
CLAUDE.md updated. C2/C10 degradation kept: no default person (or no
photo/intro) → the flag goes straight to tiles, verified.

**v35 — multiple photos per word (parent request):**

- Word editor gains "More photos of the same thing (optional)": ＋ Add photo
  (iOS picker offers camera/library), thumbnails shown, tap a thumbnail
  (+ confirm) to remove. Persisted on Save only, like the whole form.
- `word.photoId` stays the single primary (twin pairing, list/request thumbnails
  untouched); `word.extraPhotoIds: []` rides on the word record, blobs in the
  existing `photos` store. No DB version bump.
- `attachPhotos` loads extras onto `word.extraPhotos`; sessions' `wordVisual`
  picks randomly from primary+extras on every appearance (listen stage, game
  tiles, distractors) — so she learns the concept, not one object.
- Cleanup is leak-free both ways: removing an extra in the editor deletes its
  blob unless another word references it; `deleteWordAndCleanup` cascades all of
  a word's photo ids with the same shared-reference check.
- Backups already export/import the whole photos store → extras included, no
  format change.

**v34 — the reward system:**

- **Confetti** (`js/confetti.js`, new): pure-visual burst, `pointer-events:none`,
  attached to `#session` itself so it survives the stage re-render at 700ms after
  a correct tap; self-removes; honors `prefers-reduced-motion`. No audio — the
  one-sound-at-a-time rule is untouched.
- **Correct tap in the find-it game** → confetti burst from the tapped photo
  (plus the existing "Goed zo!" clip).
- **Session stickers:** every *completed* session (end screen reached; a
  parent-gate exit mid-session earns nothing) awards one emoji sticker —
  unearned ones first from a set of 20, repeats once she has them all. Stored in
  the `meta` store under key `stickers` (no DB version bump). End screen shows a
  pop-in sticker reveal + a shelf of the last 8 (+N counter) + a big confetti
  burst. Award/render degrades silently on any storage failure (spirit of C2);
  the parent observation list never waits on it.

**v33 — quick-record wizard + Polish-editor grammar fix:**

- **Quick-record wizard:** home screen gains "🎙 Record missing audio (N words)"
  (only when N > 0, active language only). Steps through every word missing its
  word audio — photo + label + record, optional phrase step when phraseText
  exists — saving onto the word instantly (re-fetches the record before saving so
  it never clobbers concurrent edits). Word list is snapshotted at wizard start
  so recording doesn't renumber the run; deleted words are skipped. This is the
  fast path for recording all the Polish seed audio (Stage 5's remaining content
  work).
- **Bug fix — Dutch grammar from the Polish editor:** the "Also in Dutch" section
  of a Polish word now has the de/het article picker, the een/no-een toggle
  (auto-guessed until touched, same as the main Dutch form), and a live
  "het banaan" preview. Previously a Dutch twin created from the Polish side was
  saved articleless with an explicit `useEen: false`. The merge-into-existing-name
  path now carries article/useEen from the form, and blank phrase/prompt fields no
  longer wipe the existing twin's values (pre-existing bug). Polish words also get
  Polish placeholder examples instead of Dutch ones.
- **Verified end-to-end in headless Chromium** (fake mic; full record→save→count
  paths, both features, zero console errors). Recipe persisted in
  `.claude/skills/verify/SKILL.md`. Twins created from the Polish side *before*
  v33 still have no article — re-open them from either side and set it.

---

## Previous status (10 July 2026, night) — `?v=32`; ALL of Stage 6 deployed

**Stage 6 is code-complete: Phases A, B, and C are all deployed.** Phase C finished
its local verification and shipped as v32. Desktop-verified: normal startup unaffected
by the `?record=` route; the import pipeline (unplayable clip flagged and kept out,
deleted-word recording skipped+counted, re-import fully idempotent, C6 null-photo
protection); the request builder end-to-end (category toggles → 5KB request file with
thumbnails + publish-instructions alert); and the builder's own output running the
recording wizard through every screen in both Dutch and Polish.

*(Its on-phone verification list has moved into the checklist at the top of this
file — items 6 and 7.)*

**What Phase C contains (shipped v32):**

- **`js/record.js` (new):** the family member's recording page (`?record=<gistId>`),
  built for technically-inept elderly relatives — one task per screen, one giant
  button, everything spelled out. Fully localized nl + pl (parent picks the
  instructions language per request, independent of the word language). Includes the
  parent-requested recording tips: start speaking immediately (no pause), happy /
  question intonation hints per phrase type, and "personalizing is welcome —
   'Goed zo, Antosia!'". Never touches IndexedDB (contract C5). Wizard: greeting →
  tips → intro clip → selfie → words (word + optional phrase steps) → game phrases →
  send-back (share sheet, download fallback with instructions). Polish plural grammar
  handled (1 nagranie / 2–4 nagrania / 5+ nagrań).
- **admin.js:** `?record=` routes as the FIRST statement of the startup IIFE (C5);
  person editor gains "📋 Create recording request" (category checkboxes, instructions
  language, phrases/intro toggles, ≤200px thumbs, privacy warning, share + publish
  instructions alert); Settings → People card gains "📥 Import family recordings".
- **backup.js:** `fetchGistText`/`blobToDataUrl`/`shareJsonFile` extracted;
  `analyzeRecordingResponse` (validate → decode → per-clip `canDecodeAudio` playability
  check → match person by name+language, nothing written) +
  `applyRecordingResponse` (one transaction; C6 null-protection; deterministic ids →
  re-import idempotent). **media.js:** `canDecodeAudio`.
- Recorder bugs already found & fixed via browser testing: Stop tapped before the mic
  was ready did nothing; UI said "speak now!" while the permission prompt was still
  up (now a calm "one moment…" until capture truly starts); mic-denied message was
  being overwritten.

**Phase C flow reminder (for the parent):** build request in app → AirDrop file to
Mac → `~/.local/bin/gh gist create <file>` → send
`https://rm482.github.io/antosias-app/?record=<gistId>` via WhatsApp → they record →
they send a file back → Settings → "📥 Import family recordings".

---

## Previous status (10 July 2026, midday) — shipped as v31

**Stage 6 Phases A AND B are implemented and deployed.** Phase A shipped as v29 and is
in real use. v30 fixed two real-use reports: (1) the category rename finally works on
the phone — the v28 migration matched the newer `nl-cat-*` ids but her install (seeded
pre-Stage-5) has the original `cat-*` ids; pass v2 matches by exact English NAME under a
fresh marker; (2) audio can no longer overlap — `playBlobSequence(blobs, { key })`
enforces one-sound-at-a-time centrally (different key cuts the current sound off, same
key while playing is ignored so the clip finishes; resolves
completed/cancelled/duplicate, and the wrong-answer re-ask chains only on `completed`).

**Phase B shipped as v31 (verified locally, needs the §3.5 on-phone pass):**
- **Contract C9 layering:** `isWordAllowedInSessions` (parent intent) split from audio
  availability; `isSessionEligible` stays as the default-voice composition.
- **`voicesForCategory`** — every voice that can carry a category (default = inline
  audio; others = their `recordings` rows; ≥2 words each).
- **Voice-scoped sessions:** `startSession` with a non-default personId uses ONLY that
  person's recorded words (their audio overlaid on word copies) and ONLY their carrier
  clips; missing carriers degrade to the bare word. SRS stays per-word.
- **Face pick** in child mode when a category has >1 voice: round photo buttons, silent
  selection, then the chosen person's intro. Default voice with no person record shows
  a flag tile (C10).
- **In-app voice recorder** (person edit → "🎙 Record words in X's voice"): category
  list with progress, word-by-word stepper (photo + "Oma says: 'de lepel'", word 6s +
  optional phrase 15s), and the game-phrase set — every recording saves immediately
  with deterministic ids (re-record = overwrite). People list shows coverage
  ("Ontbijt 2/5").
- Verified locally: voice discovery, face pick UI, Oma-only session pool, recorder
  screens, coverage display, and word-delete cascading her recording + collapsing the
  face pick. Zero console errors.

**Next:** on-phone verification of Phase B (§3.5 — record a second voice for 2–3 words
with a silly accent and play it), then Phase C (remote recording requests via the Gist
relay + `?record=` page + response import; read §4 and contracts C5/C6 first).

**Phase A recap (v29):**

- **Step ⓪ — orphaned-photo bug fixed:** `deleteWordAndCleanup(wordId)` in db.js
  deletes a word, its recordings, and its photos-store blob (only when no other word —
  e.g. the paired-language twin — still references the same photoId) in ONE IndexedDB
  transaction. Both admin deletion paths use it.
- **DB v3:** new `people` and `recordings` stores (recordings created now, used from
  Phase B; deterministic ids, personId + wordId indexes). `savePerson` enforces one
  default voice per language; `deletePersonAndCleanup` cascades recordings.
- **Backups are formatVersion 3** (people + recordings included; v1/v2 files still
  import; restore summary reports people/recordings counts).
- **People & voices screens** (Settings → 👪): per-language people list with
  default-voice/in-collage badges and an "add yourself first" hint; person editor with
  name, language, photo, 4s intro clip, collage + default-voice toggles.
- **Child mode (js/child.js):** big ▶ Play button on the home screen → flag screen
  (only playable languages) → photo category tiles → default-voice person's full-screen
  intro ("Nederlands!"/"Polski!") → family collage (5s, tap-skips) → normal session.
  Degrades per contracts C2/C10: with no people configured everything still plays,
  intro/collage just skip. Parent gate extracted to shared js/gate.js (contract C8);
  the per-category ▶ Start buttons are untouched (decision 5).

**Verified locally (desktop browser, fresh profile):** silent v3 upgrade, whole child
flow end-to-end, shared-photo deletion semantics, default-voice exclusivity, person
delete cascade, backup v3 round-trip. **Still to verify on the real iPhone:** the §2.5
checklist — especially force-quit + reopen with real data intact, then a real Papa
person + collage people, and a fresh backup.

**Also still unconfirmed on-device from v28:** (1) Dutch categories read Ontbijt /
Kleren / Speelgoed; (2) the stray "Chleb" entry on the Dutch Ontbijt list is gone.

**Next after phone verification:** Stage 6 Phase B (multi-voice playback + face pick +
in-app recording for another person), then Phase C (remote recording requests).

**Shipped and verified on the real iPhone, 9 July (v23–v28):**
- **Game-loop polish from real use:** photo taps can't stack/loop audio anymore (one
  clip must finish first); a correct tap plays the parent-recorded "Goed zo!"; a wrong
  tap says the correction ("Nee, dit is …") and then automatically re-asks the prompt.
  New `goed` phrase slots in Settings for both languages (Dutch one recorded).
- **Shared photos store (IndexedDB v2):** photos moved out of word records into a
  `photos` store; words carry `photoId`. One photo is shared between a Dutch word and
  its Polish twin.
- **Bilingual word editor:** editing any word shows an "Also in {other language}"
  section (word, phrase, prompt, audio — no articles for Polish). Saving creates/updates
  the twin with the same photo, in the right paired category (Ontbijt↔Śniadanie matched
  by seed-id; custom categories get a linked counterpart created). Typing a name that
  already exists in the other language updates that word instead of duplicating.
  Verified with brood↔chleb.
- **Backups carry photos (formatVersion 2; still imports v1 files).** A real backup was
  taken and saved on 9 July after these changes.
- **Dutch category names:** seed + one-time migration renames Breakfast/Clothes/Toys →
  Ontbijt/Kleren/Speelgoed (skips any category the parent renamed themselves).

**Stage 5 (Polish + language switching) is functionally done and in real use** — flag
switcher, Polish seeds, language-scoped editor/phrases/sessions verified on-device.
What remains is content, not code: real Polish audio + the two Polish carriers recorded
by the mother (STAGE_5_PLAN.md step 4), now easier via the bilingual editor.

---

## Previous status (8 July 2026)

**Stages 1–3 are built, deployed, and verified working on the real iPhone — including first real use with Antosia, who loved it.** Her real-toddler-hands feedback drove a round of touch-interaction fixes (below). Stage 4 (polish) is up next.

**Toddler-hands fixes from real use (8 July 2026):**
- She often held/dragged rather than cleanly tapping, so browser `click` events frequently never fired. All session-mode buttons now respond on `touchend` (finger lift) via a shared `onTap` helper in `dom.js`, regardless of hold duration or wobble; `click` stays as the desktop fallback. The mini-game also now guards against double-advancing on rapid repeat taps.
- Pinching/dragging was zooming the page and breaking touch. Fixed with `user-scalable=no` on the viewport, a `touchmove` blocker in session mode (except inside `.allow-scroll` areas — the now-scrollable end screen), suppressing Safari's `gesturestart`/`gesturechange` pinch events while a session is open, and disabling long-press callouts/text-selection inside sessions.
- Replaced the text-only "Let's find it!" button with a big round pulsing 🔍 magnifying-glass button — no reading required.

**Confirmed with the user: code updates never touch on-device data.** Photos/audio/categories live in IndexedDB, entirely separate from the deployed code; `ensureSeeded()` only ever seeds once. Safe to invest real time building out content. The real risks are deleting the Home Screen icon (never do this) or very-long-inactivity storage eviction — mitigate with periodic "Export for sharing" as a personal backup too.

- **Live app:** https://rm482.github.io/antosias-app/ — dedicated public repo `RM482/antosias-app`, deployed via GitHub Pages (push to `main` = deploy). Installed on the parent's iPhone via Add to Home Screen.
- **Stage 1 (spike):** camera capture, mic recording, IndexedDB Blob persistence, and standalone install all confirmed on-device. Harness kept at `spike.html` for future iOS debugging.
- **Stage 2 (parent admin):** category/word CRUD, photo take/choose, word + phrase audio recording with playback, separate understanding/speech status pickers, "Needs audio" flags — verified end-to-end on iPhone; in real use (user has recorded 6 words with photos/audio, renamed banaan → mandarijn).
- **Stage 3 (child session mode):** listen stage → 2-choice tap-the-picture game → real-world prompt card → end screen with per-word Understood/Said-it observations, press-and-hold parent exit gate — verified end-to-end on iPhone.
- **Sharing (added beyond the original plan):** "Export for sharing" button packages everything (photos/audio inlined) to a JSON file via the iOS share sheet. That file gets published as a *secret GitHub Gist*, and `?shared=<gistId>` on the app URL auto-imports it on a device's first open — no import step for recipients. Confirmed working on a second iPhone. It's a snapshot, not live sync; unlisted, not private (anyone with the exact link can view). First published share: gist `f5e49af98a0ac660274b9f9c97111364`.

**Hard-won iOS lessons now baked into the code:**
- iOS Home Screen web apps have storage *separate from Safari's* (and from any desktop browser) — all real testing must happen in the installed app itself.
- GitHub Pages' 10-minute HTTP cache made deployed updates invisible on the phone; fixed permanently with a network-first service worker (`sw.js`) plus `?v=N` cache-busting on internal imports (bump N on each change).
- The parent gate needed plain touch events + a 72px target + safe-area clearance; Pointer Events and edge-hugging placement both failed on iOS.
- The Gists API truncates files >1MB — shared imports must fetch `raw_url` when `truncated` is set.
- IndexedDB can reject with `null` errors (notably under private-browsing storage caps) — DB layer substitutes descriptive Errors; Safari private windows can't hold a ~2MB import, so they're a bad test vehicle for sharing.

**Not yet done (Stage 4, parked):** spaced-repetition resurfacing, offline cache polish, Guided Access instructions card, routine backup workflow, storage persistence/quota surfacing in the UI.

## Context

Build the first testable prototype of an iPhone-friendly app that helps a ~2-year-old learn Dutch words through short (3–5 min) parent-led sessions: real family photos, parent-recorded audio, a tiny tap interaction, and a real-world prompt that pushes the practice off-screen. The goal is to prove the loop *parent adds photo/audio → child sees photo → hears Dutch word → taps correct item → real-world prompt → parent tracks understanding/speech* — not to build a platform. Dutch only; Polish, profiles, cloud sync etc. are explicitly deferred.

The app lives in the `Antosia's app/` folder, currently inside the monorepo at `/Users/mr/Desktop/AI/Test projects` (which also contains an unrelated Quote generator project).

Decisions confirmed with the user:
- **Seed words ship with emoji-style placeholder images** (clearly marked, replaced the moment a real photo is added) so the admin flow is testable on day one.
- **Host on GitHub Pages** for real-iPhone testing — mic recording in the browser requires HTTPS. Only the app code is public; all photos/audio stay in on-device storage and are never uploaded.
- **Dedicated Git repository.** `Antosia's app/` gets its own repo (separate from the monorepo containing Quote generator), pushed to its own GitHub remote. This keeps the two unrelated projects cleanly separated and lets GitHub Pages serve straight from the repo root — no subpath complications, no Pages Actions workflow needed.
- **Real-iPhone testing starts in Stage 1**, not at the end. Desktop testing can't validate iOS camera capture, mic permissions, standalone-PWA behavior, or IndexedDB persistence — those are exactly the things most likely to force an architecture change, so they need to be proven early, not discovered late.

## Success criteria for the prototype

Before calling this prototype "working," it should demonstrate:
- A parent can prepare a 3-word session (photo + word audio for each word) in under 5 minutes.
- A child can complete a 3–5 word session without leaving the flow or reaching the parent/admin area by accident.
- A parent can log an "understands" / "says it" observation without interrupting or restarting the session.
- Photos, audio, and progress survive at least a week of normal on-device use (no silent data loss, no eviction).
- The activity is compelling enough that the parent chooses to repeat it on at least 3 separate days.

## Architecture (simplest thing that works)

**Mobile-first static web app — vanilla HTML/CSS/JS, no build step, no backend, no accounts.**

- Runs as a plain website and as an installable home-screen web app (PWA manifest → full-screen standalone mode on iPhone, which also removes Safari chrome — the biggest single win for toddler-safety).
- Migration paths stay open: the same code can later be wrapped with Capacitor into a native iOS app, or rebuilt in SwiftUI; the JSON-exportable data model keeps content portable either way.

**Storage: IndexedDB** (photos and audio stored as Blobs — far too big for localStorage), via a small hand-rolled promise wrapper (~60 lines, no library). `navigator.storage.persist()` only *requests* persistent storage — it's a heuristic, not a guarantee. Check `navigator.storage.persisted()` and show the parent whether it was granted; surface `navigator.storage.estimate()` in the admin area so the parent can see usage; handle `QuotaExceededError` on writes with a clear "storage full, delete something or export a backup" message rather than failing silently. "Add to Home Screen" still meaningfully reduces eviction risk on top of this.

**Photo capture:** two explicit buttons — "Take Photo" (`<input type="file" accept="image/*" capture="environment">`) and "Choose Photo" (`<input type="file" accept="image/*">`, no `capture`). `capture` is a hint iOS mostly honors but isn't contractually guaranteed, so offering both paths explicitly avoids relying on that hint alone. Downscale to ≤1024px JPEG via canvas before storing so the DB stays small.

**Audio recording:** `getUserMedia` + `MediaRecorder`. Feature-detect the mime type with `MediaRecorder.isTypeSupported()` (try `audio/mp4`, fall back through alternatives) rather than assuming `audio/mp4` — store whatever `Blob.type` actually comes back and read it back from that on playback. Auto-stop recording at a sensible cap (~6s for a word, ~15s for a phrase) so a parent can't accidentally record a huge file. Always stop all `MediaStreamTrack`s when recording ends (success, cap reached, or cancelled) so the mic indicator doesn't stay on. If `getUserMedia` throws (permission denied / no mic), show a clear inline message instead of a dead button. Playback through a single `<audio>` element unlocked by the first user tap (iOS autoplay rule).

**Toddler safety (what's realistically possible on iOS):**
- Child session mode: full-screen layout, zero visible navigation, big targets, `touch-action`/`user-select`/`overscroll-behavior` locked down, no links out.
- Exit from child mode only via a **press-and-hold (3 s) parent gate** in a screen corner.
- True app-locking is impossible from web code — the parent area includes a short illustrated **Guided Access instructions card** (Settings → Accessibility → Guided Access, triple-click side button), which is Apple's supported way to lock a toddler into one app.

## Files

```
Antosia's app/
  index.html            app shell: parent area + child session views
  css/app.css            calm, minimal, iPhone-first styles (large touch targets, safe-area insets) — relative path
  js/db.js               IndexedDB wrapper, schema v1, seed data
  js/media.js            photo capture/downscale + audio record/playback helpers
  js/admin.js            parent area: categories & words CRUD, tracking, settings, export/import
  js/session.js          child session: eligibility, builder, per-word flow, mini-game, end screen
  manifest.webmanifest   name, icons, standalone display — relative start_url
  sw.js                  minimal offline cache with versioned cache name (stage 4)
  icons/                 app icon (simple generated PNG)
```

All asset references use relative paths (`./css/app.css`, relative `start_url` in the manifest, service worker registered with a scope relative to `sw.js`'s own location) so the app works regardless of exactly where in a GitHub Pages URL it ends up served from.

## Data model (designed for later growth, minimal now)

```js
// meta store: { schemaVersion: 1 }
category: { id, name, emoji, order, createdAt }
word: {
  id, categoryId, language: 'nl',          // language + reserved profileId → Polish/profiles later
  article,               // 'de' | 'het' | ''
  word,                  // 'banaan' → display label derived: 'de banaan'
  photo,                 // Blob | null (null ⇒ emoji placeholder shown)
  placeholderEmoji,      // '🍌' — used until photo exists
  audioWord,             // Blob | null — a word needs this to be session-eligible
  audioPhrase,           // Blob | null, e.g. 'Dit is een banaan'
  phraseText,            // optional display text of the phrase
  realWorldPrompt,       // e.g. 'Give Papa de banaan'
  understandingStatus,   // 'not_introduced' | 'introduced' | 'understands'
  speechStatus,          // 'none' | 'attempts' | 'says'
  dateIntroduced, lastPracticed, timesPracticed,
  createdAt, updatedAt
}
```

`understandingStatus` and `speechStatus` are tracked independently (a child can understand a word long before attempting to say it) — the end-of-session screen updates them separately rather than overwriting one shared field. This stays at the word level rather than a full session/observation event log: a per-word "last observation wins" model is enough evidence to test the learning loop, and a full event history is more bookkeeping than this prototype needs (worth revisiting only if the prototype validates and richer analytics become useful).

**Session eligibility:** a word is usable in a child session only once it has `audioWord` set — a photo-only word (even the seed placeholder) can be *browsed* in admin but won't appear in a session, because hearing the parent's actual voice is the point of the loop, not a nice-to-have. The admin word list flags "needs audio" on any word missing it, so the parent has a clear checklist before their first session.

**Export format:** `{ formatVersion: 1, exportedAt, categories: [...], words: [...] }` with photo/audio blobs base64-encoded inline. Import validates `formatVersion` and required fields before touching the database, shows a warning that import **replaces** all current data (simplest, least error-prone behavior for a single-user prototype — no merge logic), and only writes after explicit confirmation. Because base64 inflates size ~33% and inline export can spike memory with many photos/recordings, the export button shows the current `storage.estimate()` size first so the parent isn't surprised.

Seed data: 3 categories — Breakfast (banaan, melk, brood, lepel, beker), Clothes (sok, schoen, jas, broek), Toys (bal, beer, boek, auto) — each with article, placeholder emoji, and a default real-world prompt; **no seed audio**, since audio must be the parent's real voice. Seed content exists to make the *admin* area (and the "needs audio" checklist) testable immediately, not to make a session runnable out of the box.

## Staged build

### Stage 1 — Repo, iPhone spike, and foundations
- Create the dedicated repo for `Antosia's app/`, push, enable GitHub Pages immediately — before building most features.
- Build a minimal HTTPS spike page (not the full app) that exercises exactly the risky iOS primitives: take/choose a photo, record+play back audio via `MediaRecorder` with `isTypeSupported` feature detection, write a Blob to IndexedDB and read it back, register the manifest and confirm "Add to Home Screen" launches full-screen standalone, force-quit and relaunch to confirm the Blob is still there.
- Test that spike on the actual iPhone first. If anything doesn't behave as expected (a capture path, a recording format, standalone-mode quirks), resolve it here — before the admin/session UI is built on top of assumptions that might not hold.
- Once the spike is proven, build out `db.js` (schema + seed) and `media.js` (the hardened capture/record helpers described above) as the real, reusable modules.

### Stage 2 — Parent admin area
- App shell and styles.
- Parent area: list categories → words; create/edit/delete both; per word: article picker (de/het), word text, phrase text, real-world prompt, take/choose photo (with retake), record/re-record word audio and optional phrase audio (with playback preview), separate understanding/speech status pickers.
- "Needs audio" indicator per word so the parent can see at a glance which words aren't session-ready yet.
- Verify full photo + audio CRUD end-to-end, both on desktop and on the iPhone.

### Stage 3 — Child session mode (the core loop)
- Session builder: pick a category → select 3–5 session-eligible words (has `audioWord`), least-recently-practised first, preferring lower understanding status.
  - **Edge cases the builder must handle explicitly:** fewer than 3 eligible words in a category → run with whatever's eligible (minimum 2) rather than blocking; only 0–1 eligible words → session start is disabled with a message pointing back to the "needs audio" checklist; not enough distractor photos for the mini-game → fall back to 2-choice instead of 3; all words in a category were practiced very recently → ignore the recency preference rather than refusing to start a session.
- Per-word flow: full-screen photo + label ("de banaan") → tap photo to hear word (auto-plays phrase audio if present) → **tap-the-correct-photo mini-game**, defaulting to **2 choices** (a third only if testing with a 2-year-old shows 2 is too easy) drawn from other session-eligible words with photos, falling back to placeholder emoji if a distractor has no real photo yet; gentle confirmation on correct tap, wrong tap just wiggles — no failure state → **real-world prompt card** for the parent ("Give Papa de banaan" + "Continue when done").
- End screen: "Today's words: banaan, melk, lepel" + parent reminder ("Use these words twice during breakfast") + one-tap per-word observation update (separate understanding / speech taps), stamping `lastPracticed`/`timesPracticed`.
- Press-and-hold parent gate; child mode has no other exits. If a word or category referenced by an in-progress session is deleted mid-session (parent editing on another path, or data cleared), the session ends gracefully back to the child-mode home rather than erroring.

### Stage 4 — iPhone polish + repetition
- PWA manifest, icon, minimal service worker with a versioned cache name (bump per release, clean up old caches on `activate` so a new deploy can't leave stale HTML/JS mixed with fresh assets) → installable, offline, full-screen on the home screen.
- Simple spaced repetition in the session builder: words resurface ~next day, ~3 days, ~1 week based on `lastPracticed` + understanding status (a weighting function, not a full SRS).
- Guided Access instructions card in the parent area.
- JSON export/import backup as specified above.
- Final full-loop smoke test on the actual iPhone.

## Verification

- **Desktop (during each stage):** `python3 -m http.server` in `Antosia's app/` → Chrome/Safari responsive mode at iPhone dimensions; mic and camera-roll upload both work on localhost. Exercise: seed loads → add a word with photo+audio → run a session end-to-end → statuses and lastPracticed update → data survives reload.
- **iPhone (starting Stage 1 spike, repeated through Stage 4):** open the GitHub Pages URL in Safari → grant mic, record audio, take a photo with the camera → Add to Home Screen → run a full child session in standalone mode → verify parent gate + Guided Access flow → force-quit and reopen to confirm IndexedDB persistence.
- **Edge cases to explicitly test:** microphone permission denied, offline cold launch (airplane mode + relaunch from home screen), simulated storage-full (`QuotaExceededError` path), recording cancelled mid-capture, category with 0–2 words, mini-game with insufficient distractors, malformed/foreign-version import file, photo taken in an unusual orientation, rapid repeated taps on the mini-game, long-press-then-release-early on the parent gate, and reopening after a service-worker update (Stage 4+).
- Commit at the end of each stage in the new dedicated repo.
