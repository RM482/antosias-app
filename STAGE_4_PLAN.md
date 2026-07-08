# Stage 4 Plan (v2 — revised after Codex review)

> **Status (2026-07-08): COMPLETE and deployed (app v=16).** All steps shipped:
> hardened all-or-nothing import + same-origin service-worker cache + backup/share
> split (Step 0), in-app Restore-from-backup button, spaced repetition + exclude
> words (Step 1), settings screen with storage status/backup reminder/Guided Access
> card + auto-replay of the word in the find-it game (Steps 2–3), and the invisible
> multi-language seeding groundwork (Step 4). A real-phone backup was verified
> restorable. Follow-up during testing: understood words no longer lead same-day
> repeat sessions. Deferred to a later stage: shipping actual Polish content (with
> its own display rules — Polish has no de/het articles) and any visible language UI.

**Goal:** Harden the prototype for sustained real-world use (safe backups, safe caching, honest storage info), add spaced repetition and word exclusion, and lay minimal groundwork for Polish — without any change that could endanger the existing on-device data.

**Out of scope (explicitly deferred):** multi-child profiles, real-world practice logging, video, community features, the full Polish language mode (now Stage 5), parent-profile audio metadata, themed packs, progression phases, offline badge.

**Prime directive:** the phone holds irreplaceable photos/recordings. Every step below must work when it encounters *old* records that lack new fields, and no step rewrites existing Blob-carrying records except when the user actively saves a word or finishes a session.

---

## Shipping order (each step is independently deployable and testable)

1. **Step 0 — Safety first:** harden export/import + fix service-worker caching. Then take a verified backup of the real phone data before anything else ships.
2. **Step 1 — SRS + exclusion:** session-builder logic + admin toggle. No DB structure change (new fields on words are written lazily; old records read with defaults).
3. **Step 2 — Settings:** stored in the existing `meta` store (no IndexedDB version bump — see below).
4. **Step 3 — Reliability UI:** storage status, backup reminder, Guided Access card.
5. **Step 4 (groundwork only) — Language compatibility defaults + per-language seed markers.** No visible language UI yet.

---

## 1. Spaced repetition (explicit policy)

### Fields (on `word`; written only when a session saves or a word is edited)

- `srsLevel` — integer 0–3. Read as `word.srsLevel ?? 0` everywhere. **Not** the same as `timesPracticed` (total exposures, kept as-is): `srsLevel` only advances on success.
- `nextReviewDate` — epoch **milliseconds** (consistent with `lastPracticed`), or absent/null = never scheduled = due now.

### Selection policy (removes the ambiguity Codex flagged)

The eligible pool for a category = words that have `audioWord`, are not excluded, and match the active language (`word.language ?? 'nl'`).

1. **Due words first:** `nextReviewDate` missing/null or `<= now`. Sort due words by understanding rank ascending (least understood first), then oldest `lastPracticed` first.
2. **Fill remaining slots** (up to 5) with future-dated words, earliest `nextReviewDate` first — so a session is *always* available if the category has ≥2 eligible words. SRS shapes the order; it never blocks a session.

### Scheduling on session "Done"

Intervals by level: `[1, 3, 7, 14]` days.

- If the parent tapped **👂 Understood** for the word: `srsLevel = min(srsLevel + 1, 3)`.
- If not tapped: `srsLevel` **holds** (no advance, no reset — toddler attention varies day to day; an untapped button often means "parent forgot," not "child failed").
- `nextReviewDate = start of the local calendar day + interval days` — calendar-day based, so an evening session makes the word due the next morning, and daylight-saving shifts can't produce off-by-hours surprises.

### Migration of existing words

Old records simply read as `srsLevel 0` / due-now. That means the first sessions after this update treat everything as fresh — an **intentional, documented SRS reset**. No bulk rewrite of Blob-carrying records; fields appear organically as sessions complete.

**Files:** `js/session.js` (selection + scheduling), `js/db.js` (a small `isDue(word, now)` helper).

---

## 2. Exclude familiar words

- `excluded: boolean` on `word` (read as `word.excluded === true`; absent = included).
- Admin word-edit form: "Skip in sessions" toggle. Word list shows a muted style + small badge on excluded words.
- **One shared eligibility helper** (extend `isSessionEligible` or add `isSessionPoolMember(word, language)`) used consistently by: session targets, same-category distractors, cross-category distractors, the "ready words" count, and the Start-session button state. Codex is right that filtering only the target list would leave excluded words appearing as distractors.
- Edge states: if exclusions drop a category below 2 eligible words, Start disables with the existing hint text extended ("…or un-skip some words").

**Files:** `js/admin.js`, `js/session.js`, `js/db.js` (shared helper).

---

## 3. Settings — in the `meta` store, no DB version bump

Codex correctly noted a new object store requires an IndexedDB version upgrade with `onblocked`/`versionchange` handling — a whole class of risk (a second open Safari tab can block the upgrade indefinitely). **We avoid it entirely:** settings live in the existing `meta` store as `{ key: 'settings', value: { language: 'nl' } }`, which the current `put()` wrapper already supports (`meta` has `keyPath: 'key'`).

- Read via a `getSettings()` helper that **deep-merges stored values over defaults**, so an old `{ language: 'nl' }` record never leaves later-added fields undefined.
- Start minimal: `language` only. `sessionDefaults`, difficulty, themes etc. are **dropped from Stage 4** (JS objects are schemaless; "reserving" fields buys nothing — Codex P2, agreed).

**Files:** `js/db.js` (`getSettings`/`saveSettings`), consumed by `admin.js`/`session.js`.

---

## 4. Backup & restore hardening (Step 0 — ships first)

### Import becomes validate → decode → write, in that order

1. **Validate before touching anything:** `formatVersion` must be a known version (accept 1; reject unknown/newer with a clear message "This backup was made by a newer app version"). Check `categories`/`words` are arrays and required fields exist.
2. **Decode all media data-URLs to Blobs first**, before any database write. (This also matters technically: an IndexedDB transaction auto-commits the moment you `await` a non-IDB async call, so decoding must finish before the transaction opens.)
3. **Write everything in a single `readwrite` transaction** over `categories` + `words` — all-or-nothing; a quota failure mid-restore can no longer leave a half-imported database.
4. Semantics: import **overwrites records with matching ids and leaves everything else** (merge-by-id). Documented in the UI text. Gist-link sharing import stays first-open-only, unchanged.

### Sharing safety

- **Privacy warning before sharing:** "Anyone with this link can see the photos and hear the recordings." Secret Gists are unlisted, not private.
- **Preflight size check:** warn above ~8 MB (Gist raw fetch is only dependable well below GitHub's 10 MB threshold; base64 inflates media ~33%).
- Note in code: exporter holds encoded media + JSON string + Blob in memory simultaneously — acceptable at current sizes, revisit if exports grow past ~20 MB.

### Backup vs sharing in the UI

- Rename/split: "**Save backup**" (same file, framed as safety copy — AirDrop/Files/iCloud) and "**Share with family**" (Gist flow, with the privacy warning).
- Record `lastBackupAt` in settings; settings panel shows "Last backup: …" with a gentle monthly nudge.

**Files:** `js/backup.js`, `js/admin.js`.

---

## 5. Service worker fix (Step 0 — ships first)

Current SW caches **every** GET, including `api.github.com` and raw Gist responses — duplicating multi-MB shared exports into cache storage and serving stale shared data offline.

- Cache **same-origin requests only**; pass cross-origin requests straight through.
- Bump `CACHE_NAME` (e.g. `antosias-app-v2`) and **delete old-named caches on `activate`** — also clears out stale `?v=N` asset copies accumulated since launch.

**Files:** `sw.js`.

---

## 6. Storage status UI (honest wording)

- Settings panel shows: **"Persistent storage: granted / not granted"** (from `navigator.storage.persisted()`) — not "Protected", not "cleared after 30 days" (neither is a documented guarantee).
- Approximate usage line: "Using about X MB" from `estimate()`, clearly labelled approximate. **No percentage bar and no 80% threshold** — Safari quotas are large and the estimate is fuzzy; a threshold either never fires or misleads.
- All three calls (`persist`, `persisted`, `estimate`) wrapped to tolerate rejection/absence (partially done in `requestPersistentStorage()` already).
- Real protection remains **write-failure handling** (existing `QuotaExceededError` messaging in `db.js`) plus the backup reminder.
- Offline badge: **dropped** (`navigator.onLine` is only a hint; the app already works offline silently).

**Files:** `js/admin.js`, `js/db.js`.

---

## 7. Guided Access card (corrected steps)

Minimal embedded steps, matching Apple's actual flow:

1. One-time setup: Settings → Accessibility → Guided Access → on, set a passcode.
2. **Open Antosia's app first**, then triple-click the side button (if a menu appears, choose Guided Access), tap **Start**.
3. To exit: triple-click again, enter the passcode, tap **End**.

Plus a link to Apple's official Guided Access page (flow varies slightly by iOS version).

**Files:** `js/admin.js` (settings panel card).

---

## 8. Language groundwork (compatibility only — no visible UI)

Stage 4 does **only** what makes a future Polish stage safe:

- All read paths use defaults: `category.language ?? 'nl'`, `word.language ?? 'nl'` — existing categories (which have no language field) can never disappear behind a filter.
- Seeding switches from the single global `seeded` flag to **per-language versioned markers** (`meta` keys like `seed:nl:v1`); existing installs get `seed:nl:v1` backfilled from the legacy flag. An empty seed is **never** marked complete, so Polish content added later will seed on existing installs.
- Seed word/category ids get language-prefixed going forward to prevent collisions.
- **No language picker, no "coming soon" flag, no Polish placeholder UI** — dropped per review. When Polish actually happens (Stage 5), it also needs per-language form config (Polish has no de/het article system — the admin form's article picker and "Dutch word" label are Dutch-specific), and a properly equivalent word list. That design lands in Stage 5, not now.

**Files:** `js/db.js` (seed markers, defaults), light touches in `admin.js`/`session.js` where language is read.

---

## 9. Export format versioning

- Export stays `formatVersion: 1` until the payload's shape actually changes (new fields like `srsLevel`/`excluded` ride along fine in v1 — import just passes them through).
- Import: accept `formatVersion === 1`; reject anything else with a plain-language error. When v2 eventually exists, v1 imports backfill defaults on read (same `??` helpers as live data — no separate migration code path).

**Files:** `js/backup.js`.

---

## Dropped from the original plan (per review, agreed)

- `recordedBy` audio metadata (can't hang metadata on a raw Blob without changing the media representation — design it when multi-parent recording is real).
- `themeId`/`themeLabel` (likely a many-to-many model later; premature).
- `phase` progression field (child-specific, not word-intrinsic).
- `sessionDefaults` (maxWords/difficulty) placeholders.
- Inactive Polish language picker.
- "Backup file in launch context" auto-restore idea (explicit file import is sufficient and dependable on iPhone).
- Offline badge.
- Storage percentage bar / 80% warning.

---

## Verification

**Upgrade-path test (most important):** load a populated pre-Stage-4 database (real Blobs, no new fields) against the new code — every screen renders, sessions run, nothing is hidden or rewritten unexpectedly. Test on desktop with a copied dataset first, then on the real phone **after Step 0's verified backup exists**.

**Logic tests (desktop):**
- SRS: run sessions across simulated days; levels advance only on "Understood"; due-first-then-fill ordering; session always available with ≥2 eligible words even when none are due.
- Exclusion: excluded word never appears as target **or distractor**; all-excluded category disables Start with the right message; ready-counts match.
- Import: old-format file imports; unknown-version file rejects cleanly; simulated quota failure mid-restore leaves the DB untouched (transaction rollback); >1 MB Gist path still works; oversized export triggers the preflight warning.
- Settings: partial stored settings deep-merge correctly.
- SW: cross-origin requests not cached; old cache names deleted on activate; offline launch after a deploy still opens the app.

**iPhone (real use, ~2 weeks):**
- Step 0 first: export a backup, verify it re-imports on desktop, keep the file safe.
- Words resurface on schedule; exclude one well-known word and confirm it stays gone across ≥5 sessions.
- Settings persist across force-quit; storage status line reads sensibly; Guided Access card steps work as written on the actual device.

---

## Known risks & mitigations

| Risk | Mitigation |
|------|-----------|
| Any bug during rollout endangers real data | Step 0 ships and is verified (backup taken + re-import tested) before any logic change |
| Old records missing new fields | All reads go through `??`-defaults; no field is assumed to exist; no bulk rewrites |
| Half-imported restore | Validate + decode fully before a single all-or-nothing transaction |
| Stale/oversized SW cache | Same-origin-only caching, versioned cache name, old-cache cleanup |
| SRS feels like a reset after update | It is one, intentionally — documented; history (`timesPracticed`, statuses) is untouched |

---

## Timeline estimate (revised)

- Step 0 (import hardening + SW fix + verified backup): 3–4 h
- Step 1 (SRS + exclusion): 3–4 h
- Step 2 (settings) + Step 3 (reliability UI + Guided Access): 2–3 h
- Step 4 (language groundwork): 1–2 h
- Testing (desktop + 2-week iPhone soak): 3–4 h

**Total: ~12–17 hours**, each step shippable on its own.

---

## Success criteria

- A verified backup of the real phone data exists before any behavior change ships.
- Excluded words never appear in sessions — as targets or distractors.
- Words resurface on the 1/3/7/14-day schedule, advancing only on positive observations; sessions are never blocked by scheduling.
- Import is all-or-nothing and rejects unknown formats politely.
- The service worker caches only the app's own files and cleans up after itself.
- Storage UI makes honest, plain-language claims the platform actually backs.
- Old on-device data is untouched and fully visible after every step.
