# Stage 5 — Polish + language switching (in progress)

**Live app version:** cache-bust `?v=22` (bump on every deploy; see CLAUDE.md).

## Where things stand (all deployed on `main`)

Stage 4 is complete (see STAGE_4_PLAN.md). On top of it, these were built and shipped:

- **Backups:** all-or-nothing import; in-app "💾 Save backup" / "📤 Share with family"
  (privacy + size warnings) / "♻️ Restore from backup". A real-phone backup was verified restorable.
- **Sessions:** spaced repetition (srsLevel 0–3, nextReviewDate, intervals 1/3/7/14 days;
  advance only on "Understood"; understood words don't lead same-day repeats). Exclude/"Skip"
  words. Auto-play of the prompt when the choices appear.
- **Spoken game phrases (Dutch):** parent records reusable carrier clips in Settings; the game
  stitches carrier + word via gapless Web Audio playback (decoded/cached, silence-trimmed):
  - Prompt: "Klik op de …" / "Klik op het …" (by article) + word
  - Correction on a wrong tap: "Nee, dit is een …" (countable) / "Nee, dit is …" (mass) + tapped word
  - `useEen` per word, auto-guessed from a built-in Dutch mass-noun list; `usesEen(word)` is the
    single source of truth shared by editor + game.
- **Settings screen:** storage status, backup reminder, Guided Access card, standard-phrase recording.
- **Audio/mic:** gapless Web Audio sequence player with element fallback; mic stream reused across
  recordings (one iOS permission prompt per launch), released on background.
- **Language groundwork:** data model carries `language` on categories + words; `settings.language`
  (default `'nl'`); per-language seed markers (`seed:<lang>:v1`) with legacy backfill so existing
  installs never get re-seeded. `SEED_DATA.nl` populated, `SEED_DATA.pl` empty.

## Stage 5 goal

Let the parent switch between 🇳🇱 Dutch and 🇵🇱 Polish from the home screen, with the whole app
(categories, words, sessions, phrases) scoped to the chosen language.

### Key design decisions

- **Language chooser:** flag toggle (🇳🇱 / 🇵🇱) at the top of the home screen; writes
  `settings.language`; everything re-renders for that language.
- **Polish has no de/het articles and no "een".** So per language the word model + UI differ:
  - Dutch word label = `article + word`; Polish label = just the word.
  - The Article picker and the "Naming it (dit is …)" toggle are **Dutch-only** (hidden for Polish).
- **Polish is case-inflected**, which breaks naive carrier+word stitching for some verbs
  (e.g. "Kliknij na …" needs accusative, but word audio is nominative). To avoid encoding Polish
  grammar in code, **the parent records the Polish carriers themselves** and picks phrasing that
  works with the bare (nominative) recorded word — e.g. prompt "Gdzie jest …?" ("where is…"),
  correction "To jest …" ("this is…"). So Polish needs only **two** carriers (prompt, correction),
  with no article/een variants.
- **Standard phrases are language-scoped** (keys prefixed by language) so Dutch and Polish carriers
  don't collide.
- **Polish starter content:** seed a small set of categories/words (emoji placeholders, no audio)
  when Polish is first activated, so the screen isn't empty. Audio is recorded by the parent later.

### Build order (each step independently committable)

1. [DONE, code] Home-screen language chooser (🇳🇱/🇵🇱) + `settings.language` + filter
   categories/words by active language + seed Polish starter content on first switch
   (`switchLanguage` in admin.js; `LANGUAGES` + `SEED_DATA.pl` in db.js). New categories/words are
   stamped with the active language.
2. [DONE, code] Language-aware word editor: de/het picker and the "een" toggle are hidden for
   Polish; the word-field label reads "{Language} word"; new Polish words default to no article.
3. [DONE, code] Language-scoped standard phrases (`PHRASE_SCHEMA`; Dutch keeps its original
   unprefixed keys so existing recordings survive; Polish uses `prompt` + `correction`). Session
   phrasing branches by language (`promptCarrier`/`correctionCarrier` in session.js); distractors
   stay within the session's language. Settings phrase recorders show the right clips per language.
4. [TODO] Polish seed word list reviewed by a native speaker + real Polish audio recorded in-app.

### ⏭️ RESUME HERE (next session)

**Live app: `?v=22` (pushed, NOT yet tested on the iPhone).** Steps 1–3 above are written and
syntax-checked but have only been reasoned through, not run on-device. First thing next session:

1. Force-quit + reopen the installed app; confirm the **Dutch** side is unchanged (categories,
   sessions, phrases all still work) — this is the safety check, since Stage-5 code touched the home
   screen, word editor, and session/phrase code paths.
2. Tap the **🇵🇱** flag on the home screen. Expect: Polish starter categories (Śniadanie/Ubrania/
   Zabawki) appear, seeded once. Open a Polish word — the de/het picker and "een" toggle should be
   gone, label reads "Polish word".
3. In Settings (while 🇵🇱 active) record the two Polish carriers ("Gdzie jest …?", "To jest …"),
   add a photo + audio to ≥2 Polish words, run a session, check the spoken prompt/correction.
4. If all good, move to step 4 (real Polish content/audio). If anything's off, fix before continuing.

Known nit deferred: a couple of word-editor strings are still Dutch-centric (Save validation says
"Please enter the Dutch word"; the optional-phrase placeholder is Dutch) — harmless, tidy later.

### Safety notes

- No schema version bump needed (settings live in `meta`; language fields default via `?? 'nl'`).
- Existing Dutch data is untouched; language filtering uses `word.language ?? 'nl'` so old records
  stay visible under Dutch.
