# Plan: "Antosia's app" — parent-led Dutch word-play prototype

## Status (as of 10 July 2026, end of session) — live app `?v=36`

**Everything is code-complete, deployed, and locally verified. Nothing is
half-built. The whole outstanding list is ON-PHONE TESTING (§ below).**

Four features shipped this session (v33–v36), each verified end-to-end in
headless Chromium (fake mic, real clicks, zero console errors) and pushed to
`main` (= deployed to GitHub Pages):

| v | What |
|---|---|
| v33 | Quick-record wizard + Dutch article/een controls in the Polish editor |
| v34 | Reward system: confetti on correct taps, collectible session stickers |
| v35 | Multiple photos per word, rotated per appearance |
| v36 | Child-mode flow reorder: host intro before the category tiles |

**⏭️ NEXT SESSION — do this first: the on-phone testing checklist below.** After
that, the only queued idea is *reward polish if real use asks for it* (e.g. a
sticker-book screen in child mode). No other work is pending.

**Local verification is now easy:** `.claude/skills/verify/SKILL.md` has the
recipe (static server + headless Chromium with a fake mic, gotchas included).

---

## ON-PHONE TESTING CHECKLIST (nothing here has been tested on the real iPhone)

**Before anything: force-quit the app on the phone and reopen it** — that's how
it picks up v36. (Home Screen icon only; never delete it, never clear Safari
data.) Take a **fresh backup first** (Settings → 💾 Save backup) — it now
includes people and recordings.

### 1. Quick-record wizard (v33) — also the fast path for Polish audio
Home screen → "🎙 Record missing audio (N words)" → step through: photo + word +
Record → Next. Recordings save instantly; Back mid-way loses nothing. The home
count should drop as words get audio. Do this on the 🇵🇱 flag with Mama to fill
in Polish audio (Stage 5's remaining *content* work).

### 2. Dutch article fix from the Polish editor (v33)
🇵🇱 → open a Polish word → "Also in Dutch" section now has the de/het picker,
the "een" toggle, and a live "de banaan" preview. **Note:** Dutch twins created
from the Polish side *before* v33 were saved with no article — open those once
and set de/het.

### 3. Multiple photos per word (v35)
Open a word → "More photos of the same thing (optional)" → ＋ Add photo (2–3
different paintings / cups / balls) → Save → reopen (they persist) → run a
session and confirm the picture changes between appearances. Tap a thumbnail to
remove one.

### 4. Rewards (v34)
Run a full session: confetti on each correct tap; the end screen shows a new
sticker + the growing shelf. A second session gives a different sticker. Exiting
early via the parent gate earns nothing (by design).

### 5. Child-mode flow (v36) — needs a default person first
Settings → 👪 People & voices → add yourself: name, photo, 4s intro clip
("Nederlands!"), **Default voice = Yes**. Then ▶ Play → flag → **your photo +
"Nederlands!" appears BEFORE the category tiles** → tiles → session. The intro
must not repeat after picking a category.

### 6. Family voices — Phase B (never tested on the phone)
Add a non-default person → "🎙 Record words in X's voice" → record 2–3 words
(silly accent is fine) → ▶ Play → face pick appears → session plays in that
voice. Then take a fresh backup (it now carries recordings).

### 7. Remote recording — Phase C (never tested on the phone)
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

### 8. Force-quit + reopen with real data intact
The perennial check: after all of the above, force-quit and reopen — photos,
audio, stickers, people all still there.

✅ Already confirmed on-device: Dutch category names read Ontbijt / Kleren /
Speelgoed.

---

## Shipped this session — details

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
