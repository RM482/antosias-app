import { getAll, get, put, isSessionEligible, wordLabel } from './db.js?v=4';
import { playBlobSequence, unlockAudio } from './media.js?v=4';
import { el, shuffle } from './dom.js?v=4';

const sessionEl = document.getElementById('session');
const appEl = document.getElementById('app');

let exitCallback = null;
export function initSession(onExit) {
  exitCallback = onExit;
}

const UNDERSTANDING_RANK = { not_introduced: 0, introduced: 1, understands: 2 };

// Least-recently-practised first (never practised sorts first), then
// preferring words with a lower understanding status.
function selectSessionWords(eligibleInCategory) {
  const sorted = [...eligibleInCategory].sort((a, b) => {
    const aTime = a.lastPracticed ?? 0;
    const bTime = b.lastPracticed ?? 0;
    if (aTime !== bTime) return aTime - bTime;
    const aRank = UNDERSTANDING_RANK[a.understandingStatus] ?? 0;
    const bRank = UNDERSTANDING_RANK[b.understandingStatus] ?? 0;
    return aRank - bRank;
  });
  return sorted.slice(0, 5);
}

function pickDistractor(target, sameCategoryPool, allEligiblePool) {
  const sameCat = sameCategoryPool.filter((w) => w.id !== target.id);
  if (sameCat.length > 0) return sameCat[Math.floor(Math.random() * sameCat.length)];
  const anyOther = allEligiblePool.filter((w) => w.id !== target.id);
  if (anyOther.length > 0) return anyOther[Math.floor(Math.random() * anyOther.length)];
  return null;
}

export async function startSession(categoryId) {
  const [category, allWords] = await Promise.all([get('categories', categoryId), getAll('words')]);
  const eligibleInCategory = allWords.filter((w) => w.categoryId === categoryId && isSessionEligible(w));
  const allEligible = allWords.filter(isSessionEligible);

  if (eligibleInCategory.length < 2) {
    alert(
      'This category needs at least 2 words with recorded audio before a session can start. Check the "Needs audio" words in this category first.'
    );
    return;
  }

  const sessionWords = selectSessionWords(eligibleInCategory);
  const steps = sessionWords.map((word) => ({
    word,
    distractor: pickDistractor(word, eligibleInCategory, allEligible),
  }));

  const state = {
    category,
    steps,
    index: 0,
    stage: 'listen', // 'listen' | 'game' | 'prompt'
    observations: {}, // wordId -> { understood, said }
  };

  appEl.hidden = true;
  sessionEl.hidden = false;
  sessionEl.innerHTML = '';
  mountParentGate();
  renderStep(state);
}

function exitSession() {
  sessionEl.hidden = true;
  sessionEl.innerHTML = '';
  appEl.hidden = false;
  if (exitCallback) exitCallback();
}

// --- Hold-to-exit parent gate -----------------------------------------------------

function mountParentGate() {
  const gate = el('button', { type: 'button', class: 'parent-gate', 'aria-label': 'Hold to exit to parent area' });
  const dot = el('div', { class: 'parent-gate-dot' });
  const fill = el('div', { class: 'parent-gate-fill' });
  dot.appendChild(fill);
  gate.appendChild(dot);

  let timer = null;
  const start = (e) => {
    // Pointer capture keeps pointerup routed to this button even if the
    // finger drifts slightly during the hold — small movement shouldn't
    // cancel a 3-second hold on a small touch target.
    if (gate.setPointerCapture) {
      try {
        gate.setPointerCapture(e.pointerId);
      } catch {
        // ignore — capture is a nice-to-have, not required for correctness
      }
    }
    fill.classList.add('filling');
    timer = setTimeout(() => {
      fill.classList.remove('filling');
      exitSession();
    }, 3000);
  };
  const cancel = () => {
    clearTimeout(timer);
    fill.classList.remove('filling');
  };

  gate.addEventListener('pointerdown', start);
  gate.addEventListener('pointerup', cancel);
  gate.addEventListener('pointercancel', cancel);

  sessionEl.appendChild(gate);
}

// --- Shared visual helper -----------------------------------------------------

function wordVisual(word, className) {
  const box = el('div', { class: className });
  if (word.photo) {
    const img = el('img', { alt: '' });
    img.src = URL.createObjectURL(word.photo);
    box.appendChild(img);
  } else {
    box.textContent = word.placeholderEmoji || '🔤';
  }
  return box;
}

// --- Stages -----------------------------------------------------

function renderStep(state) {
  sessionEl.querySelectorAll('.session-screen').forEach((n) => n.remove());
  if (state.index >= state.steps.length) {
    renderEndScreen(state);
    return;
  }
  if (state.stage === 'listen') renderListenStage(state);
  else if (state.stage === 'game') renderGameStage(state);
  else if (state.stage === 'prompt') renderPromptStage(state);
}

function renderListenStage(state) {
  const { word, distractor } = state.steps[state.index];
  const screen = el('div', { class: 'session-screen listen-stage' });

  const photoBtn = el('button', { type: 'button', class: 'session-photo-btn' });
  photoBtn.appendChild(wordVisual(word, 'session-photo'));
  screen.appendChild(photoBtn);

  screen.appendChild(el('div', { class: 'session-label', text: wordLabel(word) }));
  screen.appendChild(el('div', { class: 'session-hint', text: 'Tap the picture to hear it' }));

  async function playWord() {
    unlockAudio();
    try {
      await playBlobSequence([word.audioWord, word.audioPhrase]);
    } catch {
      // Ignore playback errors from rapid repeated taps.
    }
  }
  photoBtn.addEventListener('click', playWord);

  screen.appendChild(
    el('button', {
      class: 'session-continue',
      text: "Let's find it!",
      onclick: () => {
        state.stage = distractor ? 'game' : 'prompt';
        renderStep(state);
      },
    })
  );

  sessionEl.appendChild(screen);
  playWord();
}

function renderGameStage(state) {
  const { word, distractor } = state.steps[state.index];
  const screen = el('div', { class: 'session-screen game-stage' });
  screen.appendChild(el('div', { class: 'session-hint', text: `Find ${wordLabel(word)}` }));

  const optionsWrap = el('div', { class: 'session-options' });
  const options = shuffle([word, distractor]);

  for (const opt of options) {
    const btn = el('button', { type: 'button', class: 'session-option' });
    btn.appendChild(wordVisual(opt, 'session-option-photo'));
    btn.addEventListener('click', () => {
      if (opt.id === word.id) {
        btn.classList.add('correct');
        setTimeout(() => {
          state.stage = 'prompt';
          renderStep(state);
        }, 700);
      } else {
        btn.classList.add('wiggle');
        setTimeout(() => btn.classList.remove('wiggle'), 500);
      }
    });
    optionsWrap.appendChild(btn);
  }
  screen.appendChild(optionsWrap);

  screen.appendChild(
    el('button', {
      class: 'session-continue btn-secondary',
      text: '🔊 Hear it again',
      onclick: () => {
        unlockAudio();
        playBlobSequence([word.audioWord]).catch(() => {});
      },
    })
  );

  sessionEl.appendChild(screen);
}

function renderPromptStage(state) {
  const { word } = state.steps[state.index];
  const screen = el('div', { class: 'session-screen prompt-stage' });
  screen.appendChild(el('div', { class: 'session-prompt-icon', text: '👪' }));
  screen.appendChild(
    el('div', {
      class: 'session-prompt-text',
      text: word.realWorldPrompt || `Try using "${wordLabel(word)}" together right now.`,
    })
  );
  screen.appendChild(
    el('button', {
      class: 'session-continue',
      text: 'Continue when done',
      onclick: () => {
        state.index += 1;
        state.stage = 'listen';
        renderStep(state);
      },
    })
  );
  sessionEl.appendChild(screen);
}

function renderEndScreen(state) {
  const screen = el('div', { class: 'session-screen end-stage' });
  screen.appendChild(el('div', { class: 'session-end-title', text: 'Great session!' }));

  const wordNames = state.steps.map((s) => wordLabel(s.word)).join(', ');
  screen.appendChild(el('div', { class: 'session-end-summary', text: `Today's words: ${wordNames}` }));
  screen.appendChild(
    el('div', {
      class: 'session-end-reminder',
      text: `Try using these words a couple of times during ${
        state.category?.name ? state.category.name.toLowerCase() : 'the day'
      }.`,
    })
  );

  const list = el('div', { class: 'session-obs-list' });
  for (const { word } of state.steps) {
    state.observations[word.id] = state.observations[word.id] || { understood: false, said: false };
    const obs = state.observations[word.id];
    const row = el('div', { class: 'session-obs-row' });
    row.appendChild(el('div', { class: 'session-obs-label', text: wordLabel(word) }));

    const understoodBtn = el('button', { type: 'button', class: 'obs-btn', text: '👂 Understood' });
    understoodBtn.addEventListener('click', () => {
      obs.understood = !obs.understood;
      understoodBtn.classList.toggle('active', obs.understood);
    });

    const saidBtn = el('button', { type: 'button', class: 'obs-btn', text: '🗣️ Said it' });
    saidBtn.addEventListener('click', () => {
      obs.said = !obs.said;
      saidBtn.classList.toggle('active', obs.said);
    });

    row.appendChild(understoodBtn);
    row.appendChild(saidBtn);
    list.appendChild(row);
  }
  screen.appendChild(list);

  screen.appendChild(
    el('button', {
      class: 'session-continue',
      text: 'Done',
      onclick: async () => {
        await saveObservations(state);
        exitSession();
      },
    })
  );

  sessionEl.appendChild(screen);
}

async function saveObservations(state) {
  const now = Date.now();
  for (const { word } of state.steps) {
    const obs = state.observations[word.id] || { understood: false, said: false };
    const fresh = await get('words', word.id);
    if (!fresh) continue; // word was deleted elsewhere mid-session; skip gracefully

    const updated = { ...fresh };
    updated.lastPracticed = now;
    updated.timesPracticed = (fresh.timesPracticed || 0) + 1;
    if (!updated.dateIntroduced) updated.dateIntroduced = now;

    if (obs.understood) {
      updated.understandingStatus = 'understands';
    } else if (updated.understandingStatus === 'not_introduced') {
      updated.understandingStatus = 'introduced';
    }
    if (obs.said) updated.speechStatus = 'says';

    updated.updatedAt = now;
    await put('words', updated);
  }
}
