import { getAll, voicesForCategoryFrom, attachPhotos, LANGUAGES } from './db.js?v=49';
import { unlockAudio, playBlobSequence, stopPlayback } from './media.js?v=49';
import { el, onTap } from './dom.js?v=49';
import { startSession } from './session.js?v=49';
import { mountParentGate } from './gate.js?v=49';

// Child-first flow (reordered 19 July 2026 per parent request):
// Play → flag → language intro with collage of all speakers ("Nederlands!"
// + all Dutch-speaking people) → category tiles → (conditional) face pick
// (only if 2+ people recorded this category) → session.
// Renders into the existing #session overlay so session.js's toddler-proofing
// (touchmove/pinch blockers, no text selection) already covers every screen.
// All buttons use onTap (toddler rule — see CLAUDE.md).

const sessionEl = document.getElementById('session');
const appEl = document.getElementById('app');

export async function startChildMode(onExit) {
  // Inside the Play tap: unlock audio while we're still in a user gesture.
  unlockAudio();

  const [allCategories, allWords, people, recordings] = await Promise.all([
    getAll('categories'),
    getAll('words'),
    getAll('people'),
    getAll('recordings'),
  ]);
  await attachPhotos(allWords);

  const state = { allCategories, allWords, people, recordings, onExit };

  // Playable = the language has at least one category a session can start in.
  const playableLanguages = LANGUAGES.filter((l) => playableCategories(state, l.code).length > 0);
  if (playableLanguages.length === 0) {
    // Parent-facing: the Play button exists before any audio is recorded.
    alert('Nothing is ready to play yet — words need recorded audio first. Check the "Needs audio" words in each category.');
    return;
  }

  appEl.hidden = true;
  sessionEl.hidden = false;
  sessionEl.innerHTML = '';
  mountParentGate(() => exitChildMode(state));
  renderFlagScreen(state, playableLanguages);
}

function exitChildMode(state) {
  stopPlayback(); // e.g. an intro clip still talking when the gate exits
  sessionEl.hidden = true;
  sessionEl.innerHTML = '';
  appEl.hidden = false;
  if (state.onExit) state.onExit();
}

// Swap the visible screen while keeping the parent gate mounted.
function showScreen(screen) {
  sessionEl.querySelectorAll('.session-screen').forEach((n) => n.remove());
  sessionEl.appendChild(screen);
}

// All voices (default and family) that can carry a session for this category.
function voicesFor(state, categoryId, language) {
  return voicesForCategoryFrom(
    { words: state.allWords, people: state.people, recordings: state.recordings },
    categoryId,
    language
  );
}

// Playable = ANY voice can carry it — a category only grandma recorded is a
// real tile even before the parent's own audio exists there.
function playableCategories(state, language) {
  return state.allCategories
    .filter((c) => (c.language ?? 'nl') === language)
    .filter((c) => voicesFor(state, c.id, language).length > 0)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
}

// --- 1. Flag screen -----------------------------------------------------

function renderFlagScreen(state, playableLanguages) {
  const screen = el('div', { class: 'session-screen child-flag-stage' });
  // Even with a single playable language the flag still shows — the tap
  // ritual (she chooses) matters more than saving a screen.
  for (const l of playableLanguages) {
    const btn = el('button', { type: 'button', class: 'child-flag-btn', text: l.flag, 'aria-label': l.label });
    onTap(btn, () => {
      unlockAudio();
      // After flag selection: show all speakers for that language + play the
      // language name ("Nederlands!", "Polski!"), then move to category tiles.
      renderLanguageIntroAndCollage(state, l.code, () =>
        renderTileScreen(state, l.code)
      );
    });
    screen.appendChild(btn);
  }
  showScreen(screen);
}

// --- 1b. Language intro + collage: all speakers for this language ---------

// Shows all people who speak this language + plays the default voice's intro
// ("Nederlands!" or "Polski!" if they have recorded it). Serves as the
// one-time introduction to all speakers before she picks a category. Degrades
// gracefully: no people → skips; default person has no intro → shows collage
// silently; no people with photos → skips to tiles (contract C2).
function renderLanguageIntroAndCollage(state, language, next) {
  const languagePeople = state.people.filter(
    (p) => p.language === language && p.photo
  );
  const defaultPerson = defaultPersonFor(state, language);

  if (languagePeople.length === 0) {
    next();
    return;
  }
  const advance = advanceOnce(next);

  const screen = el('div', { class: 'session-screen child-language-intro-stage' });
  const grid = el('div', { class: `child-collage${languagePeople.length > 4 ? ' cols-3' : ''}` });
  for (const p of languagePeople) {
    const cell = el('div', { class: 'child-collage-cell' });
    const img = el('img', { alt: p.name || '' });
    img.src = URL.createObjectURL(p.photo);
    cell.appendChild(img);
    grid.appendChild(cell);
  }
  screen.appendChild(grid);
  onTap(screen, advance);
  showScreen(screen);

  // Play the default person's intro audio if they have one (this says the
  // language name: "Nederlands!", "Polski!"). Auto-advance after audio ends
  // or after a visual timeout.
  if (defaultPerson && defaultPerson.introAudio) {
    playBlobSequence([defaultPerson.introAudio], { key: 'intro' })
      .catch(() => {})
      .then(() => setTimeout(advance, 600));
  } else {
    setTimeout(advance, 2500);
  }
}

// --- 2. Category tiles -----------------------------------------------------

function renderTileScreen(state, language) {
  const screen = el('div', { class: 'session-screen child-tile-stage' });
  const grid = el('div', { class: 'child-tiles' });

  for (const cat of playableCategories(state, language)) {
    const tile = el('button', { type: 'button', class: 'child-tile' });
    tile.appendChild(el('div', { class: 'child-tile-emoji', text: cat.emoji || '📁' }));
    tile.appendChild(el('div', { class: 'child-tile-name', text: cat.name }));

    // Up to 4 real word photos inside the tile, so she recognizes the
    // category by its pictures before she can read. Any non-skipped word's
    // photo will do — pictures don't need audio (a grandma-only category
    // still gets a photo tile).
    const photos = state.allWords
      .filter((w) => w.categoryId === cat.id && w.excluded !== true && w.photo)
      .slice(0, 4);
    if (photos.length > 0) {
      const strip = el('div', { class: 'child-tile-photos' });
      for (const w of photos) {
        const img = el('img', { alt: '' });
        img.src = URL.createObjectURL(w.photo);
        strip.appendChild(img);
      }
      tile.appendChild(strip);
    }

    onTap(tile, () => beginSession(state, language, cat));
    grid.appendChild(tile);
  }

  screen.appendChild(grid);
  showScreen(screen);
}

// --- 3–5. Voice pick → (conditional) voice intro → session ------------------

// One voice → skip the face pick; more than one → she picks by
// tapping a face. Voices are filtered to only those with recordings in this
// specific category, making it category-aware (parent request, 19 July 2026).
function beginSession(state, language, category) {
  const voices = voicesFor(state, category.id, language);
  if (voices.length === 0) return; // tile shouldn't exist, but never error
  if (voices.length === 1) {
    proceedWithVoice(state, language, category, voices[0]);
  } else {
    renderFacePick(state, language, category, voices);
  }
}

// The language's default-voice person — plays their intro audio when the
// language collage shows, establishing the language name ("Nederlands!", etc).
function defaultPersonFor(state, language) {
  return state.people.find((p) => p.language === language && p.isDefaultVoice) || null;
}

function proceedWithVoice(state, language, category, voice) {
  const person = voice.person; // null for a default voice with no person record
  // The collage already played after the flag, so skip it here.
  // A non-default voice (family member) still gets their own intro before
  // their session; the default voice goes straight to the session.
  if (voice.isDefault) {
    startSession(category.id, { personId: null });
  } else {
    renderIntro(state, language, person, () =>
      startSession(category.id, { personId: person.id })
    );
  }
}

// --- 3. Face pick: whose voice does she want? -----------------------------------

// Tapping a face is a SILENT selection (plan decision 2) — the chosen
// person's full-screen intro always follows as its own screen. The default
// voice's tile shows the default person's photo when one exists, else the
// language flag (contract C10); a person without a photo shows their name in
// a colored circle — never blocks.
function renderFacePick(state, language, category, voices) {
  const screen = el('div', { class: 'session-screen child-face-stage' });
  const row = el('div', { class: 'child-faces' });

  for (const voice of voices) {
    const btn = el('button', { type: 'button', class: 'child-face-btn' });
    const photo = el('div', { class: 'child-face-photo' });
    if (voice.person && voice.person.photo) {
      const img = el('img', { alt: voice.person.name || '' });
      img.src = URL.createObjectURL(voice.person.photo);
      photo.appendChild(img);
    } else if (voice.isDefault) {
      photo.textContent = (LANGUAGES.find((l) => l.code === language) || {}).flag || '👤';
    } else {
      photo.textContent = (voice.person.name || '?').slice(0, 2);
      photo.classList.add('child-face-initials');
    }
    btn.appendChild(photo);
    if (voice.person && voice.person.name) {
      btn.appendChild(el('div', { class: 'child-face-name', text: voice.person.name }));
    }
    onTap(btn, () => proceedWithVoice(state, language, category, voice));
    row.appendChild(btn);
  }

  screen.appendChild(row);
  showScreen(screen);
}

// Wraps a screen-advance callback so it fires at most once, and never after
// the parent gate has already exited child mode — otherwise a still-pending
// auto-advance timer could relaunch the session overlay over the admin screen.
function advanceOnce(fn) {
  let done = false;
  return () => {
    if (done || sessionEl.hidden) return;
    done = true;
    fn();
  };
}

// --- 4. Voice intro: full-screen photo of a non-default voice -----------------

// Shows a family member's (non-default voice's) photo + plays their intro.
// Used when a non-default voice is picked for a category session.
// Degrades per contract C2: photo-only and audio-only both still show the
// moment; a person with neither skips the screen entirely. Never blocks the child.
function renderIntro(state, language, person, next) {
  if (!person || (!person.photo && !person.introAudio)) {
    next();
    return;
  }
  const advance = advanceOnce(next);

  const screen = el('div', { class: 'session-screen child-intro-stage' });
  if (person.photo) {
    const photo = el('div', { class: 'child-intro-photo' });
    const img = el('img', { alt: person.name || '' });
    img.src = URL.createObjectURL(person.photo);
    photo.appendChild(img);
    screen.appendChild(photo);
  }
  onTap(screen, advance);
  showScreen(screen);

  if (person.introAudio) {
    // Advance shortly after the clip ends; a tap can always skip ahead.
    playBlobSequence([person.introAudio], { key: 'intro' })
      .catch(() => {})
      .then(() => setTimeout(advance, 600));
  } else {
    setTimeout(advance, 2500);
  }
}

