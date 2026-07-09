# Stage 6 Plan — People, voices & the child-first flow

**Status: DRAFT for review (Codex). Not yet implemented.**

**Goal:** Antosia starts sessions herself: she picks a flag (🇳🇱/🇵🇱), sees and hears the
person behind that language ("Nederlands!" / "Polski!"), sees a photo collage of the
family/friends who speak it, picks a category from big photo tiles, and — once family
voice packs exist — picks *whose voice* she wants. Family members record word packs
remotely on their own phones and send them back as files; the parent imports them and
controls exactly which words each person is asked to record.

**Decisions already made by the parent (do not re-litigate):**

1. **Child-first flow** — a full child mode: flag → category tiles → (face pick) → intro →
   collage → session. Not just an intro bolted onto the existing parent-started session.
2. **Antosia picks the voice** — when a category has recordings from more than one person,
   she chooses by tapping a face.
3. **One session = one voice** — a session in grandma's voice uses *only* words grandma
   recorded (needs ≥ 2). No mid-session voice mixing. Admin shows per-person coverage.

**Prime directive (unchanged):** the phone holds irreplaceable photos/recordings. Every
step must tolerate old records lacking new fields, and nothing may rewrite existing
Blob-carrying records except when the parent actively saves something.

**Out of scope:** any backend/server, automatic audio transcoding, video, multi-child
profiles, notifications to family members, editing requests after they're sent.

---

## Big picture: three phases, each independently shippable

| Phase | What ships | Child sees |
|---|---|---|
| **A** | People registry + child mode (flag, tiles, intro, collage) | Flag → papa's photo + "Nederlands" → collage → category tiles → today's session |
| **B** | Multi-voice playback + face pick + in-app "record as person X" | Same, plus a face-pick screen when a category has >1 voice |
| **C** | Remote recording requests + response import + coverage view | Nothing new — this is parent-side plumbing that feeds Phase B |

The **database version bump (v2 → v3) happens once, at the start of Phase A**, and creates
*both* new stores (`people` and `recordings`), even though `recordings` is only used from
Phase B. One upgrade event instead of two.

---

## 1. Data model

### 1.1 New store: `people` (keyPath `id`)

```js
{
  id,                  // newId()
  name,                // 'Papa', 'Oma Els', 'Ciocia Kasia'
  language,            // 'nl' | 'pl' — the language this person represents
  photo,               // Blob | null — one photo, downscaled (reuse downscaleImage, max 1024)
  introAudio,          // Blob | null — them saying 'Nederlands' / 'Polski' (max 4s)
  inCollage,           // boolean — appears in the language collage
  isDefaultVoice,      // boolean — exactly one per language (papa for nl, mama for pl)
  createdAt, updatedAt,
}
```

Notes:
- Photo is stored **inline on the person** (one small blob), NOT in the `photos` store —
  people photos are never shared between records, so the indirection buys nothing.
- A person can be collage-only (`inCollage: true`, no recordings ever) — e.g. Dutch friends.
- **The default-voice person plays the words' existing inline audio** (`word.audioWord`).
  This is the no-migration trick: today's recordings simply *are* papa's/mama's voice.
  Nothing is copied or rewritten.

### 1.2 New store: `recordings` (keyPath `id`, index on `personId`)

One record per (person, word) and per (person, carrier):

```js
// word recording
{ id, personId, type: 'word', wordId, audioWord /* Blob */, audioPhrase /* Blob|null */, updatedAt }

// carrier recording (game phrases in this person's voice)
{ id, personId, type: 'carrier', language, name /* e.g. 'clickOnDe', 'goed' */, blob, updatedAt }
```

- Carrier `name` values reuse the existing `PHRASE_SCHEMA` names for that language.
- The default-voice person does NOT get `recordings` rows — their words come from the word
  records and their carriers from the existing `meta` phrase keys, exactly as today.

### 1.3 openDB upgrade (db.js)

```js
const DB_VERSION = 3;
// in onupgradeneeded, after the existing v2 blocks:
if (!db.objectStoreNames.contains('people')) db.createObjectStore('people', { keyPath: 'id' });
if (!db.objectStoreNames.contains('recordings')) {
  const store = db.createObjectStore('recordings', { keyPath: 'id' });
  store.createIndex('personId', 'personId');
}
```

Same pattern as the v2 bump (which shipped without incident). Keep the existing
error-substitution behaviour (`storageError`).

### 1.4 Settings

Add `childMode: true` implicit — no setting needed. Add nothing to settings in Phase A.

### 1.5 Backups (backup.js) — ships WITH Phase A

`formatVersion: 3`. Payload adds:

```js
people:     [{ ...person, photo: dataUrl|null, introAudio: dataUrl|null }],
recordings: [{ ...rec, audioWord: dataUrl|null, audioPhrase: dataUrl|null, blob: dataUrl|null }],
```

- `SUPPORTED_FORMAT_VERSIONS = [1, 2, 3]`; v1/v2 files simply have no `people`/`recordings`
  (default to `[]` on import, like `photos` today).
- `putAllTransactional({ categories, words, photos, people, recordings })` — still
  all-or-nothing.
- **This must land in the same deploy as the DB bump** — otherwise a backup taken after
  people are added would silently miss them (exact bug class we just fixed for photos).

---

## 2. Phase A — People registry + child mode

### 2.1 Admin: "People" screen (admin.js)

- New card/button on the Settings screen: **"👪 People & voices"** → new screen
  (`{ screen: 'people' }` on the nav stack).
- List of people grouped by language flag, each row: photo thumb, name, badges
  ("Default voice", "In collage", later "6 words recorded").
- "+ Add person" → person edit screen:
  - Name (text), Language (segmented 🇳🇱/🇵🇱), Photo (reuse `buildPhotoControl` pattern but
    writing to `person.photo` inline), Intro audio (reuse `buildAudioControl`, maxMs 4000,
    title: 'Them saying the language name — "Nederlands" / "Polski"'),
    "Show in collage" toggle, Save / Delete / Cancel.
  - Deleting a person: confirm dialog; also delete their `recordings` rows (Phase B+).
- **First-run seeding of people: none.** Instead, when the parent opens "People & voices"
  for the first time and no person has `isDefaultVoice` for a language, show a hint card:
  "Add yourself first — your photo and you saying 'Nederlands'. Mark yourself as the
  default voice." Enforce max one `isDefaultVoice` per language on save (saving a new
  default clears the flag on the old one).

### 2.2 Child mode entry (admin.js home screen)

- Big friendly **"▶ Play"** button at the top of the categories (home) screen, above the
  language switcher. Tapping it calls `startChildMode()` (new module `js/child.js`).
- The existing per-category "Start a session" button **stays** as the parent shortcut. It
  now ALSO plays the intro + collage for that category's language (steps 4–5 below) before
  the first word, so the ritual is consistent — but skips flag/tiles/face screens.

### 2.3 New module: `js/child.js`

Owns the pre-session screens. Renders into the existing `#session` element (so the
touchmove/pinch blockers and the parent gate already cover it), mounts the parent gate
immediately, and finally hands off to `startSession(categoryId, { personId })`.

Screen order:

1. **Flag screen.** One big flag button per *playable* language. Playable = that language
   has ≥ 1 category with ≥ 2 session-eligible words (for any voice; in Phase A that means
   the default voice / inline audio). If only one language is playable, still show its flag
   alone — the tap ritual matters. If none, exit to admin with an alert (parent-facing).
2. **Category tiles.** Big tap tiles for that language's playable categories: category
   emoji + name + up to 4 word-photo thumbnails inside the tile (use `attachPhotos`).
   All buttons wired with `onTap` (toddler rule — see CLAUDE.md).
3. **Face pick** *(Phase B; in Phase A auto-skip)* — see §3.3.
4. **Intro.** Full-screen photo of the chosen voice person (Phase A: the language's
   default-voice person) + their `introAudio` autoplaying once. Advance on audio end +
   600ms, or on tap. **If the person/photo/audio is missing, skip silently** — never block
   the child on missing parent setup.
5. **Collage.** Grid (CSS grid, 2–3 columns depending on count) of photos of every person
   with that `language` and `inCollage: true`. Shows for 5 seconds (progress unnecessary),
   any tap skips. Skip the screen entirely if no collage people exist.
6. Call `startSession(categoryId, { personId })`.

Audio-unlock note: the very first tap (the flag) must call `unlockAudio()` so the intro
clip can autoplay (same iOS rule as today's Start button).

### 2.4 session.js changes in Phase A

- `startSession(categoryId, opts = {})` — accept and thread through `opts.personId`
  (unused until Phase B) and an `opts.skipIntro` flag is NOT needed (intro lives in
  child.js / the Start-button path, not in session.js).
- No other Phase A changes.

### 2.5 Phase A verification (on the real iPhone)

1. Force-quit + reopen; confirm the DB upgrade was silent and all existing data intact
   (categories, words, photos, a full session).
2. Settings → People: add Papa (photo + "Nederlands" + default voice + in collage) and
   2–3 collage-only people. Add Mama on the Polish side.
3. Tap Play: flag screen shows both flags only if Polish actually has ≥2 ready words.
4. Dutch flag → papa photo + audio → collage (5s, tap-skips) → tiles → normal session.
5. Take a NEW backup and confirm it restores (people included) — use the existing
   restore flow on the Mac's browser profile, not the phone.

---

## 3. Phase B — Multi-voice playback + face pick + local recording

### 3.1 Voice resolution helpers (db.js)

```js
// All voices that can carry a session for this category+language:
// - the default-voice person, if ≥2 words in the category have inline audioWord
// - every other person with ≥2 'word' recordings pointing at words in this category
async function voicesForCategory(categoryId, language) → [{ person, eligibleWordIds }]

// Per-word audio for a chosen voice:
// default voice → { audioWord: word.audioWord, audioPhrase: word.audioPhrase }
// other person  → their recordings row for that wordId (or null if none)
function audioForWord(word, personId, recordingsByWordId)
```

### 3.2 Session changes (session.js)

- `startSession(categoryId, { personId })`:
  - If `personId` is a non-default person: the eligible pool = words in the category that
    person has recorded (decision #3 — only her words). The ≥2-words check applies to
    *that pool*. Distractors also come only from that pool (plus, if needed, other
    same-language words that person recorded in other categories).
  - Carriers: use that person's `carrier` recordings. **A missing carrier degrades exactly
    like today** — the game plays the bare word (prompt) or stays silent (goed zo). No
    fallback to another person's voice (decision #3: one consistent voice).
  - SRS bookkeeping stays **per word**, voice-agnostic (one schedule per word regardless
    of who voiced the session).
- `wordVisual`, photos etc. — untouched (photos are voice-independent).

### 3.3 Face pick screen (child.js, between tiles and intro)

- After she picks a category: `voicesForCategory(...)`. If exactly one voice → skip.
- Otherwise: big round photo buttons (person photo, name underneath). Tapping a face
  plays that person's `introAudio` immediately as confirmation **and** that person becomes
  the session voice → continue to intro screen (which then shows the SAME person — don't
  play the intro twice; the face-tap sound WAS the intro, so skip screen 4 in this path
  and go straight to the collage).
- Persons with no photo show their name in a colored circle (still tappable).

### 3.4 Local (in-app) recording for another person (admin.js)

The cheapest way to test the whole voice pipeline before building the remote flow —
grandma visits, hands you her voice directly:

- On the person edit screen: **"🎙 Record words in {name}'s voice"** → a recording
  walkthrough screen: pick a category, then step through its words one at a time —
  word photo + label, Record (maxMs 6000) / Play / Redo / Skip, progress "3 / 10".
  Then the carriers for that language (same list as Settings phrases, plus 'goed').
  Each completed item writes/overwrites that person's `recordings` row immediately
  (crash-safe; no giant in-memory draft).
- Person rows on the People screen show coverage: "Ontbijt 6/10 · Speelgoed 4/4".

### 3.5 Phase B verification

1. Record a second Dutch voice (your own voice, silly accent is fine) for 2–3 words of
   one category via §3.4.
2. Play: pick Dutch → that category → face screen appears with 2 faces → pick the test
   person → session uses only their words and their carriers.
3. Pick papa instead → full word list, existing audio — unchanged behaviour.
4. Backup + restore round-trip includes the recordings.

---

## 4. Phase C — Remote recording requests

No backend, so it's a file/link relay, reusing the proven Gist pipeline:

```
parent phone                    parent Mac                     family member's phone
------------                    ----------                     ---------------------
build request in app  ──share──▶ gh gist create req.json ──link──▶ opens app URL ?record=<gistId>
                                                                    records everything in browser
import response file ◀──WhatsApp/AirDrop/email── share sheet ◀──── taps "Send back" (a .json file)
```

### 4.1 Request builder (admin.js, on the person edit screen)

- **"📋 Create recording request"** → screen: pick language (prefilled from person),
  tick categories (or individual words) to include, toggle "include game phrases",
  toggle "include intro ('Nederlands')".
- Export = JSON file via the existing `exportAndShare` share-sheet code path:

```js
{
  formatVersion: 'recording-request-1',
  language: 'nl',
  appName: "Antosia's app",
  personName: 'Oma Els',            // so the page can greet them
  words: [{ wordId, label /* 'het brood' */, word, phraseText,
            thumb /* dataUrl ≤200px JPEG, from the shared photo — context for the reader */ }],
  carriers: [{ name: 'clickOnDe', instruction: 'Say: "Klik op de …" — trail off naturally' }, …],
  includeIntro: true,
}
```

- Thumbnails: downscale to ≤200px, quality 0.6 — keeps a 30-word request well under the
  Gist comfort zone. Reuse `downscaleImage(blob, 200, 0.6)`.
- The parent publishes it exactly like sharing today (AirDrop to Mac →
  `~/.local/bin/gh gist create` → send `https://rm482.github.io/antosias-app/?record=<gistId>`
  to the family member over WhatsApp). Document this in the request-created screen text.

### 4.2 Recording page (new module `js/record.js`, routed from admin.js startup)

- Startup: if `location.search` has `record=<gistId>` → do NOT touch the local database
  at all (this runs in a relative's browser). Fetch the gist (reuse the truncation-aware
  fetch from backup.js — extract it into a shared helper `fetchGistJson(gistId)`).
- Plain mobile-browser page (Safari AND Android Chrome), no install:
  1. Greeting: "Hoi Oma Els! Antosia's app needs your voice — {n} words, ~{n} minutes."
     Big "Start" (this tap unlocks the mic prompt context).
  2. Their intro: "Say: **Nederlands**" — Record/Play/Redo.
  3. Their photo: file input (`capture="user"` for a selfie), downscaled to 512px.
  4. Each word: thumbnail + label, "Say: **het brood**", Record (6s cap) / Play / Redo,
     optional phrase if `phraseText` exists (15s cap). Progress "4 / 12". A "Skip" button
     per item — partial responses are fine (decision #3 handles partial coverage).
  5. Carriers, one by one, with the instruction text.
  6. **"Send back"**: builds the response JSON, offers `navigator.share` with the file
     (falls back to download). Message shown: "Send this file back to {parent} on WhatsApp."
- Keep all clips in memory (a page reload loses progress — say so on screen: "Please
  finish in one go; about {n} minutes"). Typical 30-word pack ≈ 30 × ~60KB ≈ 2MB in
  memory: fine.
- **Codec risk (the one real unknown):** Android Chrome records `audio/webm;codecs=opus`;
  older iOS Safari can't play it. Mitigations, in order:
  1. The recording page prefers `audio/mp4` when `MediaRecorder.isTypeSupported` allows
     (recent Android Chrome does).
  2. The response file records each clip's mimeType.
  3. **Import on the parent's iPhone runs a decode check per clip** (`decodeAudioData` on
     a copy) and reports "3 clips can't play on this phone" with the word names, before
     anything is written. Partial import allowed (playable clips only) after a confirm.

### 4.3 Response format + import

```js
{
  formatVersion: 'recording-response-1',
  language: 'nl',
  personName: 'Oma Els',
  personPhoto: dataUrl|null,
  introAudio: dataUrl|null,
  words: [{ wordId, mimeType, audioWord: dataUrl, audioPhrase: dataUrl|null }],
  carriers: [{ name, mimeType, blob: dataUrl }],
}
```

- Import lives in Settings: **"📥 Import family recordings"** → file picker (same
  `<input type="file">` approach as Restore-from-backup).
- Flow: parse → validate formatVersion → decode all media → **decode-check each clip**
  (§4.2.3) → match/confirm person ("Add new person 'Oma Els'?" or pick an existing one)
  → write person + recordings in ONE transaction (`putAllTransactional`).
- `wordId`s that no longer exist on the phone (word deleted since the request): skipped,
  counted, reported ("2 recordings were for words you've deleted — skipped").
- Re-importing the same response overwrites that person's matching rows (merge-by
  person+wordId / person+carrier-name) — safe to import twice.

### 4.4 Phase C verification

1. Build a request for 3 words on the phone, publish via the Mac, open the link on a
   second device (the Mac's browser or your wife's phone), record, send the file back.
2. Import on the phone: person appears, coverage shows, face pick offers them, session
   plays in their voice.
3. Deliberately test the codec path once from an Android device if any family member has
   one — BEFORE asking the whole family to record.

---

## 5. File-by-file summary

| File | Phase | Change |
|---|---|---|
| `js/db.js` | A | DB_VERSION 3, `people` + `recordings` stores, people CRUD helpers; B: `voicesForCategory`, `audioForWord` |
| `js/backup.js` | A | formatVersion 3 (people + recordings in export/import); C: `fetchGistJson` extracted |
| `js/admin.js` | A | People screens, Play button, route `?record=` (C), import-recordings button (C), request builder (C), local voice recorder (B) |
| `js/child.js` | A (new) | Flag → tiles → face pick (B) → intro → collage → handoff |
| `js/session.js` | A/B | `startSession(categoryId, { personId })`; B: voice-scoped pools + carriers |
| `js/record.js` | C (new) | Family-member recording page |
| `js/media.js` | C | decode-check helper for import validation |
| `css/app.css` | A/B | flag screen, tiles, collage grid, face buttons, recorder walkthrough |
| `APP_PLAN.md` / `CLAUDE.md` | each | status + lessons learned as we go |

**Ordering within Phase A** (each its own commit, testable): ① DB v3 + backup v3,
② People screens, ③ child.js flag/tiles wired to existing sessions, ④ intro + collage.

## 6. Risks

- **DB version bump**: a second open tab can block the upgrade. Same (accepted) risk as
  the v2 bump, which shipped fine; the phone app is single-instance in practice.
- **Codec mismatch (Android → iPhone)**: the one genuinely new technical risk; §4.2's
  decode-check keeps bad clips out of the database, worst case grandma re-records on an
  iPhone at the next visit.
- **Toddler patience**: flag → tiles → face → intro → collage is 4–5 taps/waits before
  the first word. Mitigation: every screen tap-skippable, collage capped at 5s, and the
  parent shortcut (category Start button) stays.
- **Storage growth**: each voice pack ≈ words × ~60KB. Three relatives × 30 words ≈ 5–6MB.
  Fine vs. Safari quotas; backup files grow accordingly (the 8MB share warning already
  exists; plain backups are never blocked).
- **Gist size**: requests carry thumbnails (~15KB × words) — a 40-word request ≈ <1MB. OK.

## 7. Open questions for the parent (answer before Phase C)

1. Should the family member's "Send back" default message/instructions be in Dutch,
   Polish, or English? (The page can localise per request language.)
2. Do collage photos need per-person *multiple* photos eventually? (Plan assumes one.)
