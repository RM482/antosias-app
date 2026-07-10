import {
  getAll,
  get,
  put,
  isSessionEligible,
  isWordAllowedInSessions,
  isDue,
  wordLabel,
  getStandardPhrases,
  usesEen,
  SRS_INTERVAL_DAYS,
  nextReviewAfterDays,
  attachPhotos,
} from './db.js?v=35';
import { playBlobSequence, stopPlayback, unlockAudio } from './media.js?v=35';
import { el, shuffle, onTap } from './dom.js?v=35';
import { mountParentGate } from './gate.js?v=35';
import { confettiBurst, confettiBurstAt } from './confetti.js?v=35';

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

  // Whose voice carries this session. Default voice (or no person at all) →
  // today's behavior: the words' own inline audio + the meta-store carrier
  // phrases. A non-default person → ONLY words they recorded (plan decision
  // 3: one session, one voice) with their audio overlaid on word copies, and
  // only their carrier clips — a missing carrier degrades to the bare word,
  // never falls back to another person's voice.
  const person = opts.personId ? await get('people', opts.personId) : null;
  let phrases;
  let eligibleInCategory;
  let allEligible;
  if (person && !person.isDefaultVoice) {
    const recs = (await getAll('recordings')).filter((r) => r.personId === person.id);
    const rowByWordId = new Map(
      recs.filter((r) => r.type === 'word' && r.audioWord).map((r) => [r.wordId, r])
    );
    const voiced = allWords
      .filter(
        (w) =>
          (w.language ?? 'nl') === language && isWordAllowedInSessions(w) && rowByWordId.has(w.id)
      )
      .map((w) => ({
        ...w,
        audioWord: rowByWordId.get(w.id).audioWord,
        audioPhrase: rowByWordId.get(w.id).audioPhrase || null,
      }));
    eligibleInCategory = voiced.filter((w) => w.categoryId === categoryId);
    // Distractors: that person's other recorded words (same language).
    allEligible = voiced;
    phrases = {};
    for (const r of recs) {
      if (r.type === 'carrier' && r.language === language && r.blob) phrases[r.name] = r.blob;
    }
  } else {
    phrases = await getStandardPhrases(language);
    eligibleInCategory = allWords.filter((w) => w.categoryId === categoryId && isSessionEligible(w));
    // Distractors stay within the same language so a Polish word can't appear
    // in a Dutch session (and vice versa).
    allEligible = allWords.filter((w) => isSessionEligible(w) && (w.language ?? 'nl') === language);
  }

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
    personId: opts.personId || null, // whose voice this session plays in
    steps,
    phrases, // this voice's carrier clips (meta store for the default voice)
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
  stopPlayback(); // leaving the session silences whatever was still talking
  sessionEl.hidden = true;
  sessionEl.innerHTML = '';
  appEl.hidden = false;
  if (exitCallback) exitCallback();
}

// --- Shared visual helper -----------------------------------------------------

function wordVisual(word, className) {
  const box = el('div', { class: className });
  // A word can have several photos of the same concept (three different
  // paintings for "schilderij"); each appearance picks one at random so she
  // learns the concept rather than one specific object.
  const pool = [word.photo, ...(word.extraPhotos || [])].filter(Boolean);
  if (pool.length) {
    const img = el('img', { alt: '' });
    img.src = URL.createObjectURL(pool[Math.floor(Math.random() * pool.length)]);
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

  // The shared `key` enforces one-sound-at-a-time: a repeat tap while this
  // word is still playing is ignored (the clip finishes), and any different
  // sound started elsewhere cuts it off (see media.js stopPlayback).
  function playWord() {
    unlockAudio();
    playBlobSequence([word.audioWord, word.audioPhrase], { key: `listen:${word.id}` }).catch(() => {});
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

  // All game audio is keyed (one-sound rule, media.js): tapping something
  // that plays a DIFFERENT sound cuts the current one off mid-word; tapping
  // something that would REPEAT the sound already playing is ignored so the
  // clip finishes cleanly — never stacked, never restarted.

  // "Klik op de" + "banaan" → "Klik op de banaan". Falls back to the bare
  // word when the carrier isn't recorded.
  function sayPrompt() {
    unlockAudio();
    playBlobSequence([promptCarrier(word, phrases, language), word.audioWord].filter(Boolean), {
      key: `prompt:${word.id}`,
    }).catch(() => {});
  }
  // Names the wrong word she tapped ("Nee, dit is een mandarijn" / "…brood" for
  // Dutch; "To jest …" for Polish). Speaks only if the matching clip exists.
  // Resolves with the playback result (see playBlobSequence).
  async function sayCorrection(wrongWord) {
    const carrier = correctionCarrier(wrongWord, phrases, language);
    if (!carrier) return { completed: true }; // nothing to say — re-ask right away
    unlockAudio();
    return playBlobSequence([carrier, wrongWord.audioWord].filter(Boolean), {
      key: `correction:${wrongWord.id}`,
    }).catch(() => ({ cancelled: true }));
  }

  let answered = false;
  function playCorrectFeedback() {
    const goed = phrases?.goed;
    if (!goed) return;
    unlockAudio();
    playBlobSequence([goed], { key: 'goed' }).catch(() => {});
  }
  for (const opt of options) {
    const btn = el('button', { type: 'button', class: 'session-option' });
    btn.appendChild(wordVisual(opt, 'session-option-photo'));
    onTap(btn, () => {
      if (answered) return;
      if (opt.id === word.id) {
        answered = true;
        playCorrectFeedback(); // cuts off a still-playing correction/prompt
        btn.classList.add('correct');
        // Confetti lives on #session (not the stage screen), so it keeps
        // falling through the stage change below instead of vanishing at 700ms.
        confettiBurstAt(sessionEl, btn);
        setTimeout(() => {
          state.stage = 'prompt';
          renderStep(state);
        }, 700);
      } else {
        btn.classList.add('wiggle');
        setTimeout(() => btn.classList.remove('wiggle'), 500);
        sayCorrection(opt).then((res) => {
          // Re-ask the prompt so she gets another chance — but only if the
          // correction actually played to the end. If she tapped on (the
          // correction got cut off or was already playing) or answered
          // correctly meanwhile, a re-ask now would talk over that audio.
          if (res && res.completed && !answered) sayPrompt();
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

// Sticker set Antosia collects, one per completed session. Unearned stickers
// are picked first so the shelf keeps growing; once she has them all, any of
// them can appear again. Stored in the meta store (no DB version bump), and
// everything degrades silently: a storage hiccup must never break the end
// screen (same spirit as contract C2).
const STICKERS = ['🦄', '🌈', '⭐', '🐣', '🦋', '🐞', '🌻', '🐥', '🎈', '🚗', '🐟', '🍓', '🧸', '🎀', '🐰', '🐸', '🦆', '🍦', '☀️', '🐱'];

async function awardSticker() {
  let stickers = [];
  try {
    const rec = await get('meta', 'stickers');
    stickers = (rec && Array.isArray(rec.value) && rec.value) || [];
  } catch {
    /* unreadable → treat as empty shelf */
  }
  const earned = new Set(stickers.map((s) => s.emoji));
  const pool = STICKERS.filter((e) => !earned.has(e));
  const emoji = (pool.length ? pool : STICKERS)[Math.floor(Math.random() * (pool.length ? pool.length : STICKERS.length))];
  stickers = [...stickers, { emoji, earnedAt: Date.now() }];
  try {
    await put('meta', { key: 'stickers', value: stickers });
  } catch {
    /* not persisted, but still celebrated */
  }
  return { emoji, stickers };
}

function renderEndScreen(state) {
  // allow-scroll: the observation list can outgrow small screens, and the
  // session-wide touchmove blocker exempts this class.
  const screen = el('div', { class: 'session-screen end-stage allow-scroll' });
  screen.appendChild(el('div', { class: 'session-end-title', text: 'Great session!' }));

  // Sticker reveal fills in asynchronously; the rest of the end screen never
  // waits on it (and renders fine if awarding fails for any reason).
  const stickerBox = el('div', { class: 'sticker-reveal' });
  screen.appendChild(stickerBox);
  if (!state.stickerAwarded) {
    state.stickerAwarded = true;
    awardSticker()
      .then(({ emoji, stickers }) => {
        stickerBox.appendChild(el('div', { class: 'sticker-big', text: emoji }));
        stickerBox.appendChild(el('div', { class: 'sticker-caption', text: 'A new sticker!' }));
        // Shelf: the most recent stickers, newest last, plus a count once it
        // no longer fits — so she can point at what she's collected.
        const recent = stickers.slice(-8).map((s) => s.emoji).join(' ');
        const extra = stickers.length > 8 ? ` +${stickers.length - 8}` : '';
        stickerBox.appendChild(
          el('div', { class: 'sticker-shelf', text: `${recent}${extra}` })
        );
        confettiBurst(sessionEl, { count: 34 });
      })
      .catch(() => {});
  }

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
