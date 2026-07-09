# Stage 6 Plan — People, voices & the child-first flow (v3, after two Codex review rounds)

**Status: DRAFT v3 — Codex round-1 and round-2 findings incorporated. Not yet implemented.**

**Goal:** Antosia starts sessions herself: she picks a flag (🇳🇱/🇵🇱), picks a category
from big photo tiles, (later) picks *whose voice* she wants by tapping a face, then sees
and hears the "host" of that session — a full-screen photo of the person whose voice it
is, saying "Nederlands!" / "Polski!" — followed **always** by a photo collage of the
family and friends she should associate with that language. Then the session plays.
Family members record word packs remotely on their own phones and send them back as
files; the parent imports them and controls exactly which words each person is asked
to record.

**Decisions made by the parent (do not re-litigate):**

1. **Child-first flow** with the canonical screen order in the contracts below.
2. **Antosia picks the voice** when a category has more than one — by tapping a face.
   The face tap is a **silent selection**; the chosen person's full-screen intro always
   follows as its own screen (the parent explicitly wants the full-screen photo moment).
3. **One session = one voice** — a session in grandma's voice uses *only* words grandma
   recorded (needs ≥ 2). No mid-session voice mixing.
4. **The collage always follows the intro.** Whoever the host is, the next thing she sees
   is the collage of that language's people. Non-negotiable part of the ritual.
5. **The parent's per-category "Start a session" button stays exactly as it is today** —
   no intro, no collage. It is the deliberate escape hatch / quick path. The ritual lives
   only in child mode. (Supersedes the v1 idea of adding the ritual there too.)

**Prime directive (unchanged):** the phone holds irreplaceable photos/recordings. Every
step must tolerate old records lacking new fields, and nothing may rewrite existing
Blob-carrying records except when the parent actively saves something.

**Out of scope:** any backend/server, automatic audio transcoding, video, multi-child
profiles, notifications to family members, editing requests after they're sent.

---

## Implementation contracts (canonical answers — implementer must not deviate)

These resolve every ambiguity found in review. If plan prose elsewhere seems to
conflict with this section, **this section wins**.

**C1 — Canonical child flow order:**

```
Play → 1 Flag → 2 Category tiles → 3 Face pick (auto-skip if one voice)
     → 4 Intro (full-screen photo + "Nederlands"/"Polski" of the chosen voice person)
     → 5 Collage (always follows the intro)
     → 6 Session
```

Category comes before intro because the host is the *voice person*, and the voice can't
be known until the category (and face, when applicable) is chosen. In Phase A there is
only ever one voice per language (the default parent), so the child experiences:
flag → tiles → papa/mama intro → collage → session.

**C2 — Default-person fallback:** every read is `?? default`. Missing intro photo or
audio → skip that part of the intro (photo-only, audio-only, or skip screen entirely);
never block the child. No collage people → skip the collage screen. No playable
language → alert (parent-facing) and return to admin.

**C3 — Deterministic recording IDs (no duplicates by construction):**

- word recording id: `` `${personId}:word:${wordId}` ``
- carrier recording id: `` `${personId}:carrier:${language}:${name}` ``

`put()` on the same identity is an overwrite, so local re-records and repeated imports
are idempotent with no lookup logic. The `recordings` store gets **two indexes**:
`personId` and `wordId`.

**C4 — Deletion cleanup (atomic, via one named helper):**

`deleteWordAndCleanup(wordId)` in db.js owns a **single `readwrite` transaction over
`words` + `photos` + `recordings`** and does everything inside it with raw IDB requests
— the reference check included. (IndexedDB auto-commits the moment you `await` anything
non-IDB, so the helper must not be written as several awaited `remove()` calls; that's
exactly the non-atomic shape this contract forbids.)

- Delete word → also delete all `recordings` with that `wordId` (via the `wordId`
  index), and delete its photo from the `photos` store **iff no other word references
  that photoId** (check across ALL words, both languages — photos are shared with the
  paired-language word).
- Delete category → the existing loop already deletes each word; each word delete runs
  the word cleanup above.
- Delete person → confirm dialog warns recordings go too; delete all `recordings` with
  that `personId`.
- **Note:** the photo-orphan part fixes a bug that exists in the shipped app *today*
  (deleting a word already leaves its photos-store blob behind). Ship it as Phase A
  step ⓪ independent of everything else.

**C5 — `?record=` routes before ANY database access.** In the startup IIFE, parsing
`location.search` and branching to the recording page happens as the very first
statement — before `get('meta', …)`, `getSettings()`, `ensureSeeded()`,
`migrateDutchCategoryNames()`, `requestPersistentStorage()`, or `render()`. The
recording page never opens IndexedDB at all (clips live in memory).

**C6 — Import never null-overwrites.** When importing a recording response into an
existing person: `personPhoto`/`introAudio` are only written when the response value is
non-null; a null leaves the existing blob untouched. Recordings rows are whole-row
overwrites by their deterministic id (each row carries real audio by construction).

**C7 — Release checklist applies to every Stage-6 deploy** (this is the existing
project rule, restated so it lands in every phase): new modules `child.js`/`record.js`
are imported with `?v=N`; bump N in `index.html` **and every `js/*.js`** on each deploy
(one `sed` pass); `sw.js` needs no cache-name change (network-first serves new files),
but verify each phase on the installed phone app after a force-quit.

**C8 — Parent gate is shared.** Extract `mountParentGate(onExit)` out of `session.js`
into a small shared module (`js/gate.js`) exporting exactly that function; both
`session.js` and `child.js` import it. Child-mode exit behaves like `exitSession()`
today: hide+clear `#session`, unhide `#app`, invoke the exit callback so the admin
home screen re-renders.

**C9 — Session eligibility is layered; "Skip" always wins.** Today's
`isSessionEligible(word)` couples two checks: inline audio exists AND not excluded.
Non-default voices break that coupling (grandma's words may have no inline audio), so
split it:

```js
// Layer 1 — parent intent, voice-independent:
isWordAllowedInSessions(word)   // word.excluded !== true (callers filter language/category)
// Layer 2 — audio availability for the chosen voice:
//   default voice   → !!word.audioWord            (today's inline audio)
//   non-default     → a recordings row `${personId}:word:${word.id}` with audioWord
```

Every pool — session targets, distractors, ready-counts, Start/flag/tile/face
playability — is Layer 1 AND Layer 2. A word the parent marked "Skip" can never
re-enter a session through ANY voice. Keep `isSessionEligible` as the default-voice
composition of the two layers so existing call sites stay correct.

**C10 — Bootstrap: Play never waits for People setup.** Playability derives from audio
(Layer 2), not from `people` records. With zero people configured, child mode works
end-to-end: flag → tiles → (face pick auto-skips) → intro **skipped** (no person) →
collage **skipped** (no people) → session on today's inline audio. The default-voice
person, once created, only *adds* the intro photo/audio, the collage membership, and
the face-pick label. In face pick, the default voice's tile uses the default person's
photo when one exists, else a flag-emoji tile — never blocks. The People screen's hint
card (§2.1) is the nudge to set this up; the child is never gated on it.

---

## Big picture: three phases, each independently shippable

| Phase | What ships | Child sees |
|---|---|---|
| **A** | People registry + child mode | Flag → tiles → papa's photo + "Nederlands" → collage → today's session |
| **B** | Multi-voice playback + face pick + in-app "record as person X" + per-person coverage display (§3.4) | Same, plus a silent face-pick screen when a category has >1 voice; the intro then shows the chosen person |
| **C** | Remote recording requests + recording page + response import | Nothing new — parent-side plumbing that feeds Phase B |

The **database version bump (v2 → v3) happens once, at the start of Phase A**, creating
*both* new stores (`people` and `recordings`) even though `recordings` is only used from
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

### 1.2 New store: `recordings` (keyPath `id`, indexes `personId` AND `wordId`)

Ids are deterministic per contract C3. One record per (person, word) and per
(person, carrier):

```js
// id = `${personId}:word:${wordId}`
{ id, personId, type: 'word', wordId, audioWord /* Blob */, audioPhrase /* Blob|null */, updatedAt }

// id = `${personId}:carrier:${language}:${name}`
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
  store.createIndex('wordId', 'wordId');
}
```

Same pattern as the v2 bump (which shipped without incident). Keep the existing
error-substitution behaviour (`storageError`).

### 1.4 Backups (backup.js) — ships WITH Phase A

`formatVersion: 3`. Payload adds:

```js
people:     [{ ...person, photo: dataUrl|null, introAudio: dataUrl|null }],
recordings: [{ ...rec, audioWord: dataUrl|null, audioPhrase: dataUrl|null, blob: dataUrl|null }],
```

- `SUPPORTED_FORMAT_VERSIONS = [1, 2, 3]`; v1/v2 files simply have no `people`/`recordings`
  (default to `[]` on import, like `photos` today).
- `putAllTransactional({ categories, words, photos, people, recordings })` — still
  all-or-nothing.
- The import summary alert must report people + recordings counts (verification relies
  on this).
- **This must land in the same deploy as the DB bump** — otherwise a backup taken after
  people are added would silently miss them (exact bug class we just fixed for photos).

---

## 2. Phase A — People registry + child mode

### 2.0 Step ⓪ — orphan cleanup fix (pre-existing bug, ship first)

Per contract C4: deleting a word must delete its photos-store blob when no other word
references the same `photoId`. Implement as a `deleteWordAndCleanup(wordId)` helper in
db.js used by both deletion paths in admin.js (single word delete; category delete
loop). In Phase A it also deletes `recordings` by `wordId` (the store exists once the
v3 bump lands; guard with `objectStoreNames.contains` if shipped before it).

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
  - Deleting a person: confirm dialog that names the consequence ("...their recordings
    are deleted too"); cascade per contract C4.
- **First-run seeding of people: none.** When the parent opens "People & voices" and no
  person has `isDefaultVoice` for a language, show a hint card: "Add yourself first —
  your photo and you saying 'Nederlands'. Mark yourself as the default voice." Enforce
  max one `isDefaultVoice` per language on save (saving a new default clears the flag
  on the old one).

### 2.2 Child mode entry (admin.js home screen)

- Big friendly **"▶ Play"** button at the top of the categories (home) screen, above the
  language switcher. Tapping it calls `startChildMode()` (new module `js/child.js`).
- The existing per-category "Start a session" button **is not touched** (contract
  decision 5).

### 2.3 New module: `js/child.js`

Owns the pre-session screens, in the canonical order C1. Renders into the existing
`#session` element (so the touchmove/pinch blockers already cover it), mounts the
shared parent gate (contract C8) immediately, and finally hands off to
`startSession(categoryId, { personId })`.

Screen details:

1. **Flag screen.** One big flag button per *playable* language. Playable = that language
   has ≥ 1 category with ≥ 2 session-eligible words for at least one voice (Phase A:
   the default voice / inline audio). If only one language is playable, still show its
   flag alone — the tap ritual matters. If none, exit to admin with an alert
   (parent-facing). The flag tap calls `unlockAudio()` (iOS: first gesture unlocks
   later autoplay).
2. **Category tiles.** Big tap tiles for that language's playable categories: category
   emoji + name + up to 4 word-photo thumbnails inside the tile (use `attachPhotos`).
   All buttons wired with `onTap` (toddler rule — see CLAUDE.md).
3. **Face pick** *(Phase B; Phase A auto-skips — exactly one voice exists)*: see §3.3.
   Selection is silent (no audio on tap).
4. **Intro.** Full-screen photo of the session's voice person + their `introAudio`
   autoplaying once. Advance on audio end + 600ms, or on tap. Missing photo/audio →
   degrade per contract C2.
5. **Collage.** Grid (CSS grid, 2–3 columns depending on count) of photos of every person
   with that `language` and `inCollage: true`. Shows for 5 seconds, any tap skips.
   Skip the screen only if no collage people exist. **Always follows the intro**
   (decision 4).
6. `startSession(categoryId, { personId })`.

### 2.4 session.js changes in Phase A

- `startSession(categoryId, opts = {})` — accept and thread through `opts.personId`
  (unused until Phase B).
- `mountParentGate` moves to `js/gate.js` per contract C8 (mechanical extraction).
- Nothing else.

### 2.5 Phase A verification (on the real iPhone unless stated)

0. `node --check js/*.js` before every commit (existing rule).
1. Force-quit + reopen; confirm the DB upgrade was silent and all existing data intact
   (categories, words, photos, a full session).
2. Delete a test word that has a photo shared with its Polish twin → twin keeps its
   photo. Delete the twin too → photo record actually gone (check storage estimate or
   a debug count).
3. Settings → People: add Papa (photo + "Nederlands" + default voice + in collage) and
   2–3 collage-only people. Add Mama on the Polish side.
4. Tap Play: flag screen shows both flags only if Polish actually has ≥2 ready words.
5. Dutch flag → tiles → papa photo + audio → collage (5s, tap-skips) → normal session.
6. Confirm the per-category Start button still starts instantly with no intro.
7. Take a NEW backup; restore it in the Mac browser profile; the import summary must
   report the people count and restored people must show photos + intro audio.

---

## 3. Phase B — Multi-voice playback + face pick + local recording

### 3.1 Voice resolution helpers (db.js)

```js
// All voices that can carry a session for this category+language. Words are
// counted only if they pass BOTH layers of contract C9 (allowed-in-sessions
// AND audio available for that voice) — an excluded word counts for no voice:
// - the default voice, if ≥2 such words have inline audioWord
// - every other person with ≥2 'word' recordings pointing at such words
async function voicesForCategory(categoryId, language) → [{ person, eligibleWordIds }]

// Per-word audio for a chosen voice:
// default voice → { audioWord: word.audioWord, audioPhrase: word.audioPhrase }
// other person  → their recordings row for that wordId (or null if none)
function audioForWord(word, personId, recordingsByWordId)
```

### 3.2 Session changes (session.js)

- `startSession(categoryId, { personId })`:
  - If `personId` is a non-default person: the eligible pool = words in the category
    that pass C9 for that voice — i.e. not excluded AND that person recorded them
    (decision 3 — only her words). The ≥2-words check applies to *that pool*.
    Distractors also come only from that pool (plus, if needed, other same-language
    C9-passing words that person recorded in other categories).
  - Carriers: use that person's `carrier` recordings. **A missing carrier degrades exactly
    like today** — the game plays the bare word (prompt) or stays silent (goed zo). No
    fallback to another person's voice (decision 3: one consistent voice).
  - SRS bookkeeping stays **per word**, voice-agnostic (one schedule per word regardless
    of who voiced the session). See the SRS-skew risk in §6.

### 3.3 Face pick screen (child.js, between tiles and intro)

- After she picks a category: `voicesForCategory(...)`. If exactly one voice → skip.
- Otherwise: big round photo buttons (person photo, name underneath). **Tapping a face
  silently selects it** and advances to the intro screen, which then shows that person
  full-screen with their intro audio — the full-screen moment always happens (decision 2).
- Persons with no photo show their name in a colored circle (still tappable).

### 3.4 Local (in-app) recording for another person (admin.js)

The cheapest way to test the whole voice pipeline before building the remote flow —
grandma visits, hands you her voice directly:

- On the person edit screen: **"🎙 Record words in {name}'s voice"** → a recording
  walkthrough screen: pick a category, then step through its words one at a time —
  word photo + label, Record (maxMs 6000) / Play / Redo / Skip, progress "3 / 10".
  When a word has a `phraseText`, the same step also offers the optional phrase
  recording (15s cap, skippable) — parity with the remote flow, stored as
  `audioPhrase` on the same row. Then the carriers for that language — exactly the
  `PHRASE_SCHEMA` list the Settings screen shows ('goed' is already part of it; do
  not add it twice). Each completed item writes/overwrites that person's `recordings`
  row immediately (crash-safe; no giant in-memory draft; deterministic ids make
  re-records overwrites).
- Person rows on the People screen show coverage: "Ontbijt 6/10 · Speelgoed 4/4".

### 3.5 Phase B verification

0. `node --check js/*.js`.
1. Record a second Dutch voice (your own voice, silly accent is fine) for 2–3 words of
   one category via §3.4. Re-record one word — confirm no duplicate row (coverage count
   unchanged).
2. Play: Dutch → that category → face screen with 2 faces → tap the test person
   (silent) → their full-screen intro → collage → session uses only their words and
   their carriers.
3. Pick papa instead → full word list, existing audio — unchanged behaviour.
4. Delete one of the recorded words → the test person's coverage drops accordingly;
   their session pool shrinks (below 2 words → their face disappears from face pick).
5. Backup + restore round-trip; import summary reports the recordings count.

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
- **Before export, show the same unlisted-not-private warning used by "Share with
  family"** (the request contains word thumbnails and will sit in a secret Gist):
  reuse the existing confirm text pattern in admin.js.
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

### 4.2 Recording page (new module `js/record.js`, routed per contract C5)

- Startup routing: `?record=<gistId>` branches to this page **before any IndexedDB
  access** (contract C5). Fetch the gist with the truncation-aware helper
  (`fetchGistJson(gistId)`, extracted from backup.js).
- **Validate before rendering anything.** The link is an arbitrary Gist; a bad or
  malicious payload must fail fast with "This recording link is invalid" rather than
  build a giant in-memory page. Reject unless: `formatVersion === 'recording-request-1'`;
  `language` is a known code; `words` is an array of ≤ 60 items each with a string
  `wordId` and `word`; `carriers` ≤ 10 items; every `thumb` data-URL ≤ 120 KB; total
  fetched JSON ≤ 8 MB (checked on the raw text before `JSON.parse`).
- Plain mobile-browser page (Safari AND Android Chrome), no install:
  1. Greeting: "Hoi Oma Els! Antosia's app needs your voice — {n} words, ~{n} minutes."
     Big "Start" (this tap unlocks the mic prompt context).
  2. Their intro: "Say: **Nederlands**" — Record/Play/Redo.
  3. Their photo: file input (`capture="user"` for a selfie), downscaled to 512px.
  4. Each word: thumbnail + label, "Say: **het brood**", Record (6s cap) / Play / Redo,
     optional phrase if `phraseText` exists (15s cap). Progress "4 / 12". A "Skip" button
     per item — partial responses are fine (decision 3 handles partial coverage).
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
- **Null-protection per contract C6**: photo/intro only overwrite when non-null.
- Recording rows get their deterministic ids (contract C3) — re-importing the same file
  is a pure overwrite, importable twice with identical results.
- `wordId`s that no longer exist on the phone (word deleted since the request): skipped,
  counted, reported ("2 recordings were for words you've deleted — skipped").

### 4.4 Phase C verification

0. `node --check js/*.js`.
1. Open a `?record=` link in a **fresh browser profile** (private window is fine here —
   the page must not use IndexedDB at all): confirm it renders the recording flow and
   that no `antosia-app` database is created (check devtools → Storage), and no seed
   words appear if the same profile later opens the app normally... (open the plain app
   URL after: it should seed fresh as first-ever open, proving `?record=` left no marker).
2. Build a request for 3 words on the phone, publish via the Mac, open the link on a
   second device, record, send the file back.
3. Import on the phone: person appears, coverage shows, face pick offers them, session
   plays in their voice. **Import the same file again**: no duplicates, counts unchanged.
4. Import a response for a person that already has a photo, where the response photo is
   null → photo survives.
5. Deliberately test the codec path once from an Android device if any family member has
   one — BEFORE asking the whole family to record.

---

## 5. File-by-file summary

| File | Phase | Change |
|---|---|---|
| `js/db.js` | A | DB_VERSION 3, `people` + `recordings` stores (+`wordId` index), people CRUD, `deleteWordAndCleanup`; B: `voicesForCategory`, `audioForWord` |
| `js/backup.js` | A | formatVersion 3 (people + recordings in export/import, counts in summary); C: `fetchGistJson` extracted |
| `js/gate.js` | A (new) | `mountParentGate(onExit)` extracted from session.js (contract C8) |
| `js/admin.js` | A | People screens, Play button, deletion paths use `deleteWordAndCleanup`; B: local voice recorder; C: `?record=` route (first statement of startup), import-recordings button, request builder + privacy warning |
| `js/child.js` | A (new) | Flag → tiles → face pick (B) → intro → collage → handoff (order per C1) |
| `js/session.js` | A/B | `startSession(categoryId, { personId })`, gate import; B: voice-scoped pools + carriers |
| `js/record.js` | C (new) | Family-member recording page (no IndexedDB) |
| `js/media.js` | C | decode-check helper for import validation |
| `css/app.css` | A/B | flag screen, tiles, collage grid, face buttons, recorder walkthrough |
| `index.html` + all `js/*.js` | every deploy | `?v=N` bump (contract C7) |
| `APP_PLAN.md` / `CLAUDE.md` | each | status + lessons learned as we go |

**Ordering within Phase A** (each its own commit, testable): ⓪ orphan-photo cleanup fix,
① DB v3 + backup v3, ② gate extraction + People screens, ③ child.js flag/tiles wired to
existing sessions, ④ intro + collage.

## 6. Risks

- **DB version bump**: a second open tab can block the upgrade. Same (accepted) risk as
  the v2 bump, which shipped fine; the phone app is single-instance in practice.
- **Codec mismatch (Android → iPhone)**: the one genuinely new technical risk; §4.2's
  decode-check keeps bad clips out of the database, worst case grandma re-records on an
  iPhone at the next visit.
- **SRS × voice choice**: the review schedule is per-word and voice-blind. If a partial
  voice (grandma: 3 of 10 words) becomes Antosia's favourite, those 3 words get
  over-practised while the other 7 stagnate. Accepted for now; the coverage display
  (§3.4) gives the parent visibility, and encouraging fuller packs is the real fix.
  Revisit only if it shows up in practice.
- **Toddler patience**: flag → tiles → face → intro → collage is 4–5 taps/waits before
  the first word. Mitigation: every screen tap-skippable, collage capped at 5s, and the
  untouched parent Start button remains the fast path.
- **Storage growth**: each voice pack ≈ words × ~60KB. Three relatives × 30 words ≈ 5–6MB.
  Fine vs. Safari quotas; backup files grow accordingly (the 8MB share warning already
  exists; plain backups are never blocked).
- **Gist size**: requests carry thumbnails (~15KB × words) — a 40-word request ≈ <1MB. OK.

## 7. Open questions for the parent (answer before Phase C)

1. Should the family member's recording page speak Dutch, Polish, or English? (It can
   localise per request language.)
2. Do collage photos need per-person *multiple* photos eventually? (Plan assumes one.)
