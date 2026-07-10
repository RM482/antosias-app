import { getAll, isSessionEligible, attachPhotos, LANGUAGES } from './db.js?v=28';
import { unlockAudio } from './media.js?v=28';
import { el, onTap } from './dom.js?v=28';
import { startSession } from './session.js?v=28';
import { mountParentGate } from './gate.js?v=28';

// Child-first flow (Stage 6, canonical order per STAGE_6_PLAN.md contract C1):
// Play → flag → category tiles → (face pick, Phase B) → intro → collage →
// session. Renders into the existing #session overlay so session.js's
// toddler-proofing (touchmove/pinch blockers, no text selection) already
// covers every screen. All buttons use onTap (toddler rule — see CLAUDE.md).

const sessionEl = document.getElementById('session');
const appEl = document.getElementById('app');

export async function startChildMode(onExit) {
  // Inside the Play tap: unlock audio while we're still in a user gesture.
  unlockAudio();

  const [allCategories, allWords, people] = await Promise.all([
    getAll('categories'),
    getAll('words'),
    getAll('people'),
  ]);
  await attachPhotos(allWords);

  const state = { allCategories, allWords, people, onExit };

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

function eligibleWordsIn(state, categoryId) {
  return state.allWords.filter((w) => w.categoryId === categoryId && isSessionEligible(w));
}

function playableCategories(state, language) {
  return state.allCategories
    .filter((c) => (c.language ?? 'nl') === language)
    .filter((c) => eligibleWordsIn(state, c.id).length >= 2)
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
      renderTileScreen(state, l.code);
    });
    screen.appendChild(btn);
  }
  showScreen(screen);
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
    // category by its pictures before she can read.
    const photos = eligibleWordsIn(state, cat.id).filter((w) => w.photo).slice(0, 4);
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

// --- 3–6. Voice → intro → collage → session -----------------------------------------------------

// Phase A: exactly one possible voice per language (the default person, whose
// voice is the words' own inline audio), so the face-pick screen auto-skips
// (contract C1). With no people configured at all this still plays — the
// intro/collage screens simply skip themselves (contract C10).
function beginSession(state, language, category) {
  const person = state.people.find((p) => p.language === language && p.isDefaultVoice) || null;
  startSession(category.id, { personId: person ? person.id : null });
}
