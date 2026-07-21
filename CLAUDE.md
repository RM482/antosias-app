# Antosia's app — project notes for Claude

Parent-led Dutch word-learning prototype for a ~2-year-old. Full plan, current status, and iOS lessons learned live in `APP_PLAN.md` — read its Status section first.

## Working with this user

The user is a complete beginner (first git/terminal/GitHub experience). **Always explain in plain language what a command or step does before running it** — especially git, deploys, and anything touching their phone. Walk through on-phone steps click by click and confirm what they saw.

## Stack & conventions

- Vanilla HTML/CSS/JS, no build step, no backend. ES modules under `js/`, styles in `css/app.css`.
- Data lives in IndexedDB on-device only (photos/audio as Blobs); never uploaded anywhere by the app itself.
- **Cache-busting:** all internal imports/links carry `?v=N`. Bump N in *every* file that references it (`index.html` + `js/*.js`, one `sed` pass) whenever shipping a change. The service worker (`sw.js`, network-first) handles freshness for installed apps, but keep bumping `?v=N` anyway.
- `spike.html` is a kept-on-purpose iOS test harness — don't delete.
- Syntax-check with `node --check js/*.js` before committing.
- **`js/concepts.js` must stay PURE and SYNCHRONOUS** — no IndexedDB, no `await`. The migration runs it inside a `versionchange` transaction, where awaiting a non-IDB promise auto-commits half a migration. Callers read what it needs (seed markers, categories) and pass it in.
- **`wordLanguage()` returns `null`** for an explicitly unsupported language (v44) — only a *missing* one defaults to `'nl'`. Null must stay un-pairable everywhere: check for it rather than comparing with `!==`, which silently treats null as "the other language".
- **Verify changes by actually running the app**, not just syntax-checking: `.claude/skills/verify/SKILL.md` has the recipe (static server on :8321 + headless Chromium with a fake mic, plus the locator/dialog gotchas). Every feature v33–v44 was driven end-to-end this way before shipping. Two gotchas: **Settings is the `⚙️` button**, not text; and you can test modules directly without any UI by loading a page on the served origin and calling `page.evaluate(() => import('/js/concepts.js?v=44'))` — that is how v44's 70 assertions run.
- **Photos:** a word has one primary `photoId` (this is what links language twins — don't break that) plus optional `extraPhotoIds: []`, several pictures of the same concept. `attachPhotos` loads them onto `word.photo` / `word.extraPhotos`; sessions pick randomly from the pool on each appearance. Any code that deletes a photo must check no other word references it (`photoId` *or* `extraPhotoIds`).
- **Rewards:** confetti (`js/confetti.js`) is visual-only — never add audio to it (the one-sound rule below). Stickers live in the `meta` store under `stickers`; only a *completed* session awards one.
- **Toddler touch handling:** in child session mode (`session.js`), always wire buttons with `onTap()` from `dom.js`, not raw `click` listeners — real toddler-hands testing showed plain `click` misses holds/drags/wobbly presses. `onTap` fires on `touchend` (any hold length) with `click` as a desktop fallback. Session mode also blocks pinch-zoom and page-drag by default (`touchmove` is prevented unless the element is inside `.allow-scroll`) — add that class to any session content that must scroll.
- **Backup vs restore (v44):** `importPayload` is split — `analyzeImportPayload(payload, { existingIds })` is **pure and write-free** and returns `{ usable, omitted, guardedIds }`; `applyImportPayload(analysis)` does the writing. Anything unusable is itemised (`{store, index, id, field?, kind, identity, reason}`) and shown to the parent *before* any write; `kind` distinguishes a genuine loss from a `repaired` row (restored minus a damaged clip) or a superseded `duplicate`. **`importPayload` refuses by default when anything would be dropped** — a caller that cannot show the parent what it is discarding must not discard it. `putAllTransactional(writes, ctx, { skipIfPresent })` re-checks guarded ids *inside* the write transaction and returns what it skipped. **Never reintroduce a silent filter here**: that was the bug.
- **Backup and Share are still the SAME payload** (`js/admin.js:376`) and the share file goes to a public-if-you-have-the-link Gist. **Do not add anything to the export until step 1 splits them** — `meta` (her recorded phrases, stickers, settings) must never reach the share path.
- **Photos live in the `photos` store (IndexedDB v3), shared across language twins.** Words carry `photoId`, not a photo Blob (legacy inline `word.photo` still supported, migrates on save). Before displaying words anywhere, call `attachPhotos(words)` from `db.js`; save words with `saveWord()` (it writes the new `photoId` back onto your draft — pairing logic depends on that). Backups are formatVersion 3 (photos + people + recordings; older files still import). **Never delete words with raw `remove()`** — use `deleteWordAndCleanup()` (cleans up the shared photo and recordings atomically); same for people, `deletePersonAndCleanup()`. Save people with `savePerson()` (enforces one default voice per language).
- **Child mode (`js/child.js`, Stage 6; reordered v43):** the home-screen ▶ Play button runs flag → **collage of every speaker of that language + the language intro** ("Nederlands!") → category tiles → (face pick, shown only when 2+ people recorded *that category*) → family-voice intro (non-default voices only) → session. The collage moved to the front in v43, and the tiles now precede the voice pick so voices can be filtered per category. It renders into `#session` (so session.js's toddler touch blockers apply) and uses the shared parent gate from `js/gate.js` — mount gates only via `mountParentGate(onExit)`. Pre-session screens must never block: missing people/photos/audio always degrade to skipping that screen (STAGE_6_PLAN.md contracts C2/C10).
- **Audio playback:** only one sound may ever play at a time (stacked audio genuinely confused the toddler). `playBlobSequence(blobs, { key })` in `media.js` enforces it centrally: pass a `key` naming the sound (e.g. `` `prompt:${word.id}` ``) — a different key cuts off the current sound, the same key while playing is ignored (clip finishes; resolves `{ duplicate: true }`). It resolves `{ completed | cancelled | duplicate }`; only chain follow-up audio on `completed`. Call `stopPlayback()` on any exit path (gates, session end). Never play audio outside this mechanism.

## Reviewing with Codex

Codex CLI runs locally: `/Applications/ChatGPT.app/Contents/Resources/codex` (authenticated, `gpt-5.6-sol`). Run it read-only against the real source:

```
codex exec --skip-git-repo-check --model gpt-5.6-sol -c model_reasoning_effort=high < promptfile
```

It has repeatedly caught things reading alone missed on this project — a privacy leak, a backup that would have stored empty audio, a regression inside one of its own suggested fixes. Two things that make it much more useful: ask it to **verify claims against the source itself** rather than trusting the prompt, and when rounds start repeating, ask **"is this converging or circling?"** — that question ended a five-round loop by revealing the constraint was wrong rather than the patch.

## Deploy & sharing

- Repo: `RM482/antosias-app` (public). GitHub Pages serves `main` at https://rm482.github.io/antosias-app/ — **pushing to main is deploying**; on this project pushes have been routine after each verified change, but confirm with the user when in doubt (and never push when they've asked to hold).
- `gh` CLI is at `~/.local/bin/gh` (not on PATH), authenticated as `RM482`.
- Sharing words with others: user taps "Export for sharing" in the app → gets the JSON to the Mac (AirDrop → `~/Downloads/`) → publish with `~/.local/bin/gh gist create <file>` (secret by default) → share link is `https://rm482.github.io/antosias-app/?shared=<gistId>`. Import only triggers on a device's first-ever open of the app.

## Testing gotchas (learned the hard way)

- The user's real data exists **only inside the iPhone Home Screen app's storage** — Safari tabs, desktop browsers, and private windows are all separate empty worlds. Feature-test locally, but *verify* on the installed iPhone app.
- Never suggest deleting/re-adding the Home Screen icon or clearing Safari data: it destroys all recordings/photos. Export first if ever needed.
- Safari private windows can't store a multi-MB import — don't use them to test sharing.
- After a deploy, the phone needs a full force-quit + reopen to pick up changes (the service worker then fetches fresh).
