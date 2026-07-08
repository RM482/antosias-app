import {
  getAll,
  get,
  put,
  isSessionEligible,
  isDue,
  wordLabel,
  getStandardPhrases,
  usesEen,
  SRS_INTERVAL_DAYS,
  nextReviewAfterDays,
} from './db.js?v=21';
import { playBlobSequence, unlockAudio } from './media.js?v=21';
import { el, shuffle, onTap } from './dom.js?v=21';

const sessionEl = document.getElementById('session');
const appEl = document.getElementById('app');

// While a session is on screen, block the touch gestures a toddler triggers
// by accident: finger-drags that scroll/rubber-band the page (except inside
// deliberately scrollable .allow-scroll areas) and iOS pinch-zoom
// (gesturestart/gesturechange are Safari's pinch events).
sessionEl.addEventListener(
  'touchmove',
  (e) => {
    if (!e.target.closest('.allow-scroll')) e.preventDefault();
  },
  { passive: false }
);
for (const type of ['gesturestart', 'gesturechange']) {
  document.addEventListener(type, (e) => {
    if (!sessionEl.hidden) e.preventDefault();
  });
}

let exitCallback = null;
export function initSession(onExit) {
  exitCallback = onExit;
}

const UNDERSTANDING_RANK = { not_introduced: 0, introduced: 1, understands: 2 };
const MAX_SESSION_WORDS = 5;

// Pick up to 5 words for a session. Spaced repetition shapes the order but
// never blocks a session: due words (and never-scheduled words) come first,
// least understood then least-recently-practised; if that leaves empty slots
// we fill them with the words coming due soonest. So a category with 2+
// eligible words always yields a playable session.
function selectSessionWords(eligibleInCategory, now = Date.now()) {
  const byUnderstandingThenRecency = (a, b) => {
    const aRank = UNDERSTANDING_RANK[a.understandingStatus] ?? 0;
    const bRank = UNDERSTANDING_RANK[b.understandingStatus] ?? 0;
    if (aRank !== bRank) return aRank - bRank;
    return (a.lastPracticed ?? 0) - (b.lastPracticed ?? 0);
  };

  const due = eligibleInCategory.filter((w) => isDue(w, now)).sort(byUnderstandingThenRecency);
  if (due.length >= MAX_SESSION_WORDS) return due.slice(0, MAX_SESSION_WORDS);

  // Fill remaining slots with the soonest-upcoming future words. This path
  // also carries same-day repeat sessions (after one round, every word is
  // scheduled for tomorrow, so none are "due"). Order by soonest due, then
  // least-understood/least-recent — so a word just marked "understood"
  // doesn't lead a same-day repeat just because of its position in the list.
  const upcoming = eligibleInCategory
    .filter((w) => !isDue(w, now))
    .sort((a, b) => {
      const byDate = (a.nextReviewDate ?? 0) - (b.nextReviewDate ?? 0);
      return byDate !== 0 ? byDate : byUnderstandingThenRecency(a, b);
    });
  return [...due, ...upcoming].slice(0, MAX_SESSION_WORDS);
}

function pickDistractor(target, sameCategoryPool, allEligiblePool) {
  const sameCat = sameCategoryPool.filter((w) => w.id !== target.id);
  if (sameCat.length > 0) return sameCat[Math.floor(Math.random() * sameCat.length)];
  const anyOther = allEligiblePool.filter((w) => w.id !== target.id);
  if (anyOther.length > 0) return anyOther[Math.floor(Math.random() * anyOther.length)];
  return null;
}

export async function startSession(categoryId) {
  // Runs synchronously within the "Start" tap, so the audio context resumes
  // inside a user gesture (iOS requirement) before the first clip autoplays.
  unlockAudio();
  const [category, allWords, phrases] = await Promise.all([
    get('categories', categoryId),
    getAll('words'),
    getStandardPhrases(),
  ]);
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
    phrases, // reusable carrier recordings: { clickOnDe, clickOnHet, correction }
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

  // Plain touch events (not Pointer Events, which have had capture/leave
  // quirks on iOS Safari). We deliberately don't listen for touchmove, so
  // finger drift during the hold has no effect — only an actual lift
  // (touchend) or an OS-level gesture takeover (touchcancel) cancels it.
  let timer = null;
  const start = (e) => {
    if (e.cancelable) e.preventDefault();
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

  gate.addEventListener('touchstart', start, { passive: false });
  gate.addEventListener('touchend', cancel);
  gate.addEventListener('touchcancel', cancel);
  // Mouse fallback so this is still testable in a desktop browser.
  gate.addEventListener('mousedown', start);
  gate.addEventListener('mouseup', cancel);
  gate.addEventListener('mouseleave', cancel);

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
  onTap(photoBtn, playWord);

  const findBtn = el('button', {
    type: 'button',
    class: 'find-btn',
    text: '🔍',
    'aria-label': "Let's find it!",
  });
  onTap(findBtn, () => {
    state.stage = distractor ? 'game' : 'prompt';
    renderStep(state);
  });
  screen.appendChild(findBtn);

  sessionEl.appendChild(screen);
  playWord();
}

// Carrier clip that matches a word's article, or null (no article / not
// recorded → the game just plays the bare word, as before).
function promptCarrier(word, phrases) {
  if (word.article === 'de') return phrases?.clickOnDe || null;
  if (word.article === 'het') return phrases?.clickOnHet || null;
  return null;
}

function renderGameStage(state) {
  const { word, distractor } = state.steps[state.index];
  const { phrases } = state;
  const screen = el('div', { class: 'session-screen game-stage' });
  screen.appendChild(el('div', { class: 'session-hint', text: `Find ${wordLabel(word)}` }));

  const optionsWrap = el('div', { class: 'session-options' });
  const options = shuffle([word, distractor]);

  // "Klik op de" + "banaan" → "Klik op de banaan". Falls back to the bare
  // word when the carrier isn't recorded. playBlobSequence chains the clips
  // through a single audio element, so a tiny seam between them is expected.
  function sayPrompt() {
    unlockAudio();
    playBlobSequence([promptCarrier(word, phrases), word.audioWord].filter(Boolean)).catch(() => {});
  }
  // Names the wrong word she tapped, with Dutch-correct phrasing: countable
  // words use the "een" carrier ("Nee, dit is een mandarijn"), mass nouns use
  // the plain one ("Nee, dit is brood"). useEen defaults on, so only mass
  // nouns need turning off. Speaks only if the matching clip was recorded.
  function sayCorrection(wrongWord) {
    const carrier = usesEen(wrongWord) ? phrases?.correctionEen : phrases?.correction;
    if (!carrier) return;
    unlockAudio();
    playBlobSequence([carrier, wrongWord.audioWord].filter(Boolean)).catch(() => {});
  }

  let answered = false;
  for (const opt of options) {
    const btn = el('button', { type: 'button', class: 'session-option' });
    btn.appendChild(wordVisual(opt, 'session-option-photo'));
    onTap(btn, () => {
      if (answered) return;
      if (opt.id === word.id) {
        answered = true;
        btn.classList.add('correct');
        setTimeout(() => {
          state.stage = 'prompt';
          renderStep(state);
        }, 700);
      } else {
        btn.classList.add('wiggle');
        setTimeout(() => btn.classList.remove('wiggle'), 500);
        sayCorrection(opt);
      }
    });
    optionsWrap.appendChild(btn);
  }
  screen.appendChild(optionsWrap);

  const hearAgainBtn = el('button', {
    type: 'button',
    class: 'session-continue btn-secondary',
    text: '🔊 Hear it again',
  });
  onTap(hearAgainBtn, sayPrompt);
  screen.appendChild(hearAgainBtn);

  sessionEl.appendChild(screen);

  // Speak the prompt as the two choices appear ("Klik op de banaan"), so she
  // hears what to look for and then finds it. Same audio the button replays.
  sayPrompt();
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
  const continueBtn = el('button', { type: 'button', class: 'session-continue', text: 'Continue when done' });
  onTap(continueBtn, () => {
    state.index += 1;
    state.stage = 'listen';
    renderStep(state);
  });
  screen.appendChild(continueBtn);
  sessionEl.appendChild(screen);
}

function renderEndScreen(state) {
  // allow-scroll: the observation list can outgrow small screens, and the
  // session-wide touchmove blocker exempts this class.
  const screen = el('div', { class: 'session-screen end-stage allow-scroll' });
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
    onTap(understoodBtn, () => {
      obs.understood = !obs.understood;
      understoodBtn.classList.toggle('active', obs.understood);
    });

    const saidBtn = el('button', { type: 'button', class: 'obs-btn', text: '🗣️ Said it' });
    onTap(saidBtn, () => {
      obs.said = !obs.said;
      saidBtn.classList.toggle('active', obs.said);
    });

    row.appendChild(understoodBtn);
    row.appendChild(saidBtn);
    list.appendChild(row);
  }
  screen.appendChild(list);

  const doneBtn = el('button', { type: 'button', class: 'session-continue', text: 'Done' });
  onTap(doneBtn, async () => {
    await saveObservations(state);
    exitSession();
  });
  screen.appendChild(doneBtn);

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

    // Spaced-repetition schedule. Interval is based on the level the word is
    // AT now (so a first success reinforces the next day: level 0 → 1 day),
    // and only a positive observation advances the level afterwards. A
    // toddler's attention wanders, and an untapped button usually means "we
    // didn't get to it," not "she failed" — so a no-observation session holds
    // the level (word simply comes due again on the same interval) rather than
    // resetting or advancing it.
    const level = Math.min(updated.srsLevel ?? 0, SRS_INTERVAL_DAYS.length - 1);
    updated.nextReviewDate = nextReviewAfterDays(SRS_INTERVAL_DAYS[level], now);
    updated.srsLevel = obs.understood ? Math.min(level + 1, SRS_INTERVAL_DAYS.length - 1) : level;

    updated.updatedAt = now;
    await put('words', updated);
  }
}
