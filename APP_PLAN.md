# Plan: "Antosia's app" — parent-led Dutch word-play prototype

## Status (as of 9 July 2026) — live app `?v=28`

**⏭️ NEXT SESSION: implement STAGE_6_PLAN.md (v3, twice Codex-reviewed — read its
"Implementation contracts" section first).** Phase A starts with step ⓪, the
orphaned-photo cleanup fix (a live bug: deleting a word leaves its photos-store blob
behind). Before coding, two 1-minute phone checks from yesterday's deploys:
(1) Dutch categories should now read Ontbijt / Kleren / Speelgoed (the v28 rename
shipped but was not confirmed on-device); (2) confirm the stray "Chleb" entry on the
Dutch Breakfast list was deleted (leftover from a fixed pairing bug).

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
