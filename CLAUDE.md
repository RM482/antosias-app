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

## Deploy & sharing

- Repo: `RM482/antosias-app` (public). GitHub Pages serves `main` at https://rm482.github.io/antosias-app/ — **pushing to main is deploying**; on this project pushes have been routine after each verified change, but confirm with the user when in doubt (and never push when they've asked to hold).
- `gh` CLI is at `~/.local/bin/gh` (not on PATH), authenticated as `RM482`.
- Sharing words with others: user taps "Export for sharing" in the app → gets the JSON to the Mac (AirDrop → `~/Downloads/`) → publish with `~/.local/bin/gh gist create <file>` (secret by default) → share link is `https://rm482.github.io/antosias-app/?shared=<gistId>`. Import only triggers on a device's first-ever open of the app.

## Testing gotchas (learned the hard way)

- The user's real data exists **only inside the iPhone Home Screen app's storage** — Safari tabs, desktop browsers, and private windows are all separate empty worlds. Feature-test locally, but *verify* on the installed iPhone app.
- Never suggest deleting/re-adding the Home Screen icon or clearing Safari data: it destroys all recordings/photos. Export first if ever needed.
- Safari private windows can't store a multi-MB import — don't use them to test sharing.
- After a deploy, the phone needs a full force-quit + reopen to pick up changes (the service worker then fetches fresh).
