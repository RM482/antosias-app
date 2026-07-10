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
  attachPhotos,
} from './db.js?v=28';
import { playBlobSequence, unlockAudio } from './media.js?v=28';
import { el, shuffle, onTap } from './dom.js?v=28';
import { mountParentGate } from './gate.js?v=28';

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

export async function startSession(categoryId, opts = {}) {
  // Runs synchronously within the "Start" tap, so the audio context resumes
  // inside a user gesture (iOS requirement) before the first clip autoplays.
  unlockAudio();
  const [category, allWords] = await Promise.all([get('categories', categoryId), getAll('words')]);

  // Words that keep their photo in the photos store need the blob loaded
  // before session screens can show pictures.
  await attachPhotos(allWords);

  const language = category?.language ?? 'nl';
  const phrases = await getStandardPhrases(language);
  const eligibleInCategory = allWords.filter((w) => w.categoryId === categoryId && isSessionEligible(w));
  // Distractors stay within the same language so a Polish word can't appear in
  // a Dutch session (and vice versa).
  const allEligible = allWords.filter((w) => isSessionEligible(w) && (w.language ?? 'nl') === language);

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
    language,
    // Whose voice this session plays in. Unused until Stage 6 Phase B — today
    // every session uses the words' own inline audio (the default voice).
    personId: opts.personId || null,
    steps,
    phrases, // language-scoped carrier recordings (see getStandardPhrases)
    index: 0,
    stage: 'listen', // 'listen' | 'game' | 'prompt'
    observations: {}, // wordId -> { understood, said }
  };

  appEl.hidden = true;
  sessionEl.hidden = false;
  sessionEl.innerHTML = '';
  mountParentGate(exitSession);
  renderStep(state);
}

function exitSession() {
  sessionEl.hidden = true;
  sessionEl.innerHTML = '';
  appEl.hidden = false;
  if (exitCallback) exitCallback();
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

  let isPlaying = false;
  async function playWord() {
    if (isPlaying) return; // prevent overlapping playback
    isPlaying = true;
    unlockAudio();
    try {
      await playBlobSequence([word.audioWord, word.audioPhrase]);
    } catch {
      // Ignore playback errors from rapid repeated taps.
    } finally {
      isPlaying = false;
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

// Carrier clip played before the target word ("Klik op de …"/"…het …" for
// Dutch by article; a single "prompt" carrier for Polish). Null → the game
// just plays the bare word.
function promptCarrier(word, phrases, language) {
  if (language === 'nl') {
    if (word.article === 'de') return phrases?.clickOnDe || null;
    if (word.article === 'het') return phrases?.clickOnHet || null;
    return null;
  }
  return phrases?.prompt || null; // Polish (and any non-Dutch): one carrier
}

// Carrier for naming a wrongly-tapped word. Dutch picks een/mass by usesEen;
// Polish uses its single correction carrier.
function correctionCarrier(word, phrases, language) {
  if (language === 'nl') return usesEen(word) ? phrases?.correctionEen : phrases?.correction;
  return phrases?.correction || null;
}

function renderGameStage(state) {
  const { word, distractor } = state.steps[state.index];
  const { phrases, language } = state;
  const screen = el('div', { class: 'session-screen game-stage' });
  screen.appendChild(el('div', { class: 'session-hint', text: `Find ${wordLabel(word)}` }));

  const optionsWrap = el('div', { class: 'session-options' });
  const options = shuffle([word, distractor]);

  // "Klik op de" + "banaan" → "Klik op de banaan". Falls back to the bare
  // word when the carrier isn't recorded. playBlobSequence chains the clips
  // through a single audio element, so a tiny seam between them is expected.
  function sayPrompt() {
    unlockAudio();
    playBlobSequence([promptCarrier(word, phrases, language), word.audioWord].filter(Boolean)).catch(() => {});
  }
  // Names the wrong word she tapped ("Nee, dit is een mandarijn" / "…brood" for
  // Dutch; "To jest …" for Polish). Speaks only if the matching clip exists.
  // Returns a promise that resolves when playback completes.
  async function sayCorrection(wrongWord) {
    const carrier = correctionCarrier(wrongWord, phrases, language);
    if (!carrier) return;
    unlockAudio();
    return playBlobSequence([carrier, wrongWord.audioWord].filter(Boolean)).catch(() => {});
  }

  let answered = false;
  function playCorrectFeedback() {
    const goed = phrases?.goed;
    if (!goed) return;
    unlockAudio();
    playBlobSequence([goed]).catch(() => {});
  }
  for (const opt of options) {
    const btn = el('button', { type: 'button', class: 'session-option' });
    btn.appendChild(wordVisual(opt, 'session-option-photo'));
    onTap(btn, () => {
      if (answered) return;
      if (opt.id === word.id) {
        answered = true;
        playCorrectFeedback();
        btn.classList.add('correct');
        setTimeout(() => {
          state.stage = 'prompt';
          renderStep(state);
        }, 700);
      } else {
        btn.classList.add('wiggle');
        setTimeout(() => btn.classList.remove('wiggle'), 500);
        sayCorrection(opt).then(() => {
          // After correction, re-ask the prompt so she gets another chance
          sayPrompt();
        });
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
