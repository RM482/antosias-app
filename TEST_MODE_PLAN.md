# Test mode plan (v37)

**Status: SHIPPED as v37 (11 July 2026).
[x] plan agreed  [x] session.js core  [x] admin.js entry UI  [x] CSS  [x] verified
locally (headless Chromium, stubbed mic: 3-option test scored 1/4 exactly matching
the ✓/✗ rows and pre-toggles; practice unchanged; 4-option 2×2 screenshot; zero
console errors)  [x] version bumped + deployed. Remaining: the on-phone checklist
at the bottom of this file (also mirrored in APP_PLAN.md).**

## What the parent asked for (their words, 11 July 2026)

Current sessions are a *practice* mode. Add a **test mode**: no picture-first listen
stage — the session immediately asks "vind de banaan" (audio) and shows the answer
options. Difficulty must be adjustable: **2, 3, or 4 options** per question.

## Decisions (made with/for the parent — don't re-litigate)

1. **Where it lives:** the category (words) screen gets a "🎯 Start a test" button +
   a 2/3/4 difficulty picker, right under the existing "▶ Start a session" button.
   Child mode stays practice-only (tests are parent-led assessment; the ▶ Play
   ritual is untouched).
2. **The chosen difficulty persists** in settings (`testOptionCount`, default 2) so
   it sticks between tests and can be ratcheted up as she grows.
3. **Test flow per word:** prompt audio plays immediately (same carrier + word
   chain as the practice game: "Klik op de / Gdzie jest …" + word — reuses the
   already-recorded carriers, nothing new to record) with N options on screen.
   No listen stage, no real-world-prompt card between words.
4. **Wrong answers stay gentle** (same wiggle + spoken correction + re-ask — no
   toddler failure state), but the app records whether her FIRST tap was correct.
   That first-tap result is the test datum.
5. **End screen shows results**: "7 / 10 right on the first try" + a per-word ✓/✗
   list, and the normal observation toggles are PRE-SET from the results
   (first-try-correct → "👂 Understood" pre-toggled on; parent can override before
   Done). Saving works exactly like practice (same `saveObservations`, so SRS
   advances on understood words as today). Completed test still earns a sticker.
6. **Degrade, never block:** need N-1 distractors per word — drawn from the same
   category first, then same-language pool (like practice). If the pool can't fill
   N options for some word, that word just shows fewer options (minimum 2). A
   category still needs only 2 eligible words to run a test.
7. **One-sound rule** (CLAUDE.md) applies unchanged — all audio through
   `playBlobSequence(blobs, { key })`.

## File-by-file changes

### js/session.js (the core)
- `pickDistractor(...)` → generalize to `pickDistractors(target, sameCategoryPool,
  allEligiblePool, count)` returning up to `count` DISTINCT words (same-category
  first, top up from the language pool, never the target, no duplicates).
- `startSession(categoryId, opts)`: new opts `mode` ('practice' | 'test', default
  'practice') and `optionCount` (2–4, only meaningful in test mode).
  `steps` entries become `{ word, distractors: [...] }` (practice = 1 distractor).
  State gains `mode`, `results: {}` (wordId → firstTapCorrect boolean).
- `renderStep`: test mode never enters 'listen' or 'prompt' stages — every word
  goes straight to 'game'; after a correct tap, `index += 1`, stage stays 'game'.
- `renderGameStage`: options = shuffle([word, ...distractors]); add class
  `count-3` / `count-4` on `.session-options` for layout. First tap on each word
  (and only the first) writes `state.results[word.id]`. Practice behavior is
  byte-for-byte unchanged (its `distractors` array just has one entry).
- `renderEndScreen`: when `state.mode === 'test'`, show the score line + per-word
  ✓/✗ rows above the observation list, and pre-toggle "Understood" for first-try
  correct words (set `state.observations[id].understood = true` AND the button's
  active class). Everything else (Done, saveObservations, sticker) unchanged.

### js/admin.js (entry UI)
- `renderWords` (category screen): under "▶ Start a session", add:
  - a small segmented picker "Test difficulty: 2 / 3 / 4 pictures" bound to
    `settings.testOptionCount` (`saveSettings({ testOptionCount })` on change,
    no re-render needed);
  - "🎯 Start a test" button → `startSession(categoryId, { mode: 'test',
    optionCount: settings.testOptionCount || 2 })`; disabled with the same
    ≥2-ready rule (reuse `canStart`).

### js/db.js
- `DEFAULT_SETTINGS` gains `testOptionCount: 2` (settings merge means old
  installs read the default automatically; no DB version bump).

### css/app.css
- `.session-options.count-3 .session-option-photo` and `.count-4` sizes so 3–4
  tiles fit a phone screen without scrolling (3 → ~30vw each; 4 → 2×2 grid,
  ~38vw each). Test end screen: `.test-score` (big line) and `.test-result-row`
  (word + ✓/✗) styles.

### index.html + all js/*.js
- Cache-bust bump `?v=36` → `?v=37` (one sed pass, per CLAUDE.md).

## Verification (headless, per .claude/skills/verify/SKILL.md)

Stub `getUserMedia` with an oscillator MediaStreamDestination (the fake-device
flag doesn't work on this machine — see the skill's gotchas + scratchpad scripts
from 11 July). Bar: zero console errors.

1. Record 4+ words' audio via the quick-record wizard (any language).
2. Category screen shows the difficulty picker + "🎯 Start a test"; pick 3.
3. Test starts on the game stage directly (no `.listen-stage` ever), 3 options
   visible, prompt audio starts (instrument `AudioBufferSourceNode.start`).
4. Answer word 1 wrong-then-right, word 2+ right first try → end screen says
   "N-1 / N right on the first try", ✓/✗ rows match, "Understood" pre-toggled
   only on first-try-correct words; Done saves and exits.
5. 4-option test renders 2×2 without overflow (screenshot); 2-option matches
   practice layout.
6. Practice session still has listen stage + prompt card + single distractor.
7. `node --check js/*.js`; then bump, commit, push (= deploy).

## On-phone afterwards (add to APP_PLAN.md checklist)

- Category → set difficulty 2 → 🎯 test: audio asks immediately, no big photo
  first; correct tap → confetti → next question.
- Raise to 4: four pictures fit on screen; wrong tap wiggles + corrects gently.
- End screen: score matches what happened; Understood pre-ticked only on
  first-try words; sticker still awarded; Done returns home.
