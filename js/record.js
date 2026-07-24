import { el } from './dom.js?v=46';
import { recordAudio, downscaleImage, playBlob } from './media.js?v=46';
import { fetchGistText, blobToDataUrl, shareJsonFile } from './backup.js?v=46';

// The family member's recording page (Stage 6 Phase C, plan §4.2), reached
// via ?record=<gistId>. Contract C5: this module NEVER touches IndexedDB —
// every clip lives in memory until "send back", and nothing here may leave a
// marker that would confuse a later first-open of the real app.
//
// The audience is a grandparent who may never have recorded anything on a
// phone: one task per screen, ONE big obvious button, everything spelled
// out ("press the big red button", "your phone will ask about the
// microphone — tap Allow"), in Dutch or Polish (the request says which).

const sessionEl = document.getElementById('session');

// --- Localized UI text -----------------------------------------------------

const STRINGS = {
  nl: {
    loading: 'Even geduld…',
    badLink: 'Deze opname-link werkt niet. Vraag om een nieuwe link.',
    greetingTitle: (name) => `Hoi ${name}!`,
    greetingBody: (n, min) =>
      `Antosia leert woordjes — en ze wil ze graag in jouw stem horen! Op deze pagina neem je ${n === 1 ? 'één korte opname' : `${n} korte opnames`} op. Het duurt ongeveer ${min} ${min === 1 ? 'minuut' : 'minuten'}.`,
    greetingOneGo:
      'Belangrijk: maak het in één keer af en sluit of ververs deze pagina niet — anders begin je opnieuw.',
    start: 'Beginnen ▶',
    tipsTitle: 'Zo maak je een goede opname',
    tips: [
      'Druk op de knop en begin méteen te praten — zonder stilte vooraf.',
      'Spreek duidelijk en vrolijk. Antosia hoort jouw stem straks in het spel!',
      'Is het een vraag? Laat het dan echt als een vraag klinken.',
      'Je mag het persoonlijk maken — "Goed zo, Antosia!" is nog leuker dan alleen "Goed zo".',
      'Na elke opname kun je luisteren en het zo vaak overdoen als je wilt.',
    ],
    micHint:
      'Bij de eerste opname vraagt je telefoon of deze pagina de microfoon mag gebruiken. Kies dan "Sta toe" (Allow).',
    tipsGo: 'Ik ben er klaar voor ▶',
    stepOf: (i, n) => `Stap ${i} van ${n}`,
    saySimply: 'Druk op de rode knop en zeg meteen:',
    recording: 'Ik luister — spreek nu!',
    stop: '⏹ Klaar',
    recorded: '✅ Opgenomen!',
    listen: '▶ Luister terug',
    redo: '🔁 Opnieuw proberen',
    next: 'Goed zo — volgende ▶',
    skip: 'Deze overslaan',
    micDenied:
      'De microfoon staat uit voor deze pagina. Ga naar de instellingen van je browser en sta de microfoon toe, of vraag iemand om te helpen.',
    phraseIntro: 'Dit hoort bij hetzelfde woord: het zinnetje. (Overslaan mag ook.)',
    introTask: 'Antosia ziet straks jouw foto terwijl ze dit hoort. Zeg vrolijk:',
    photoTitle: 'Nu een foto van jou',
    photoBody:
      'Antosia ziet jouw foto als het spel begint. Maak een foto van jezelf, of kies een mooie bestaande foto.',
    takePhoto: '📷 Maak een foto',
    choosePhoto: '🖼 Kies een foto',
    photoOk: '✅ Wat een mooie foto!',
    doneTitle: 'Klaar — dankjewel! 🎉',
    doneBody:
      'Nu nog terugsturen. Druk op de grote knop hieronder en kies hoe je het bestand terugstuurt (bijvoorbeeld WhatsApp) — naar degene die jou deze link stuurde.',
    send: '📤 Versturen',
    downloadNote:
      'Het bestand staat nu in je downloads (het heet "antosia-opnames…"). Stuur het als bijlage terug via WhatsApp of e-mail naar degene die jou deze link stuurde.',
    sendAgain: 'Nog een keer versturen',
    hints: {
      prompt: 'Zeg het als een opdrachtje en stop halverwege — het woord komt er in het spel vanzelf achteraan.',
      correction: 'Vriendelijk, niet streng! En maak de zin niet af — het woord komt er vanzelf achteraan.',
      goed: 'Vrolijk en trots — alsof ze net iets heel knaps deed!',
    },
  },
  pl: {
    loading: 'Chwileczkę…',
    badLink: 'Ten link do nagrywania nie działa. Poproś o nowy link.',
    greetingTitle: (name) => `Cześć ${name}!`,
    // Polish numerals: 1 nagranie, 2–4 nagrania, 5+ (and 12–14) nagrań.
    greetingBody: (n, min) => {
      const last = n % 10;
      const teens = n % 100 >= 12 && n % 100 <= 14;
      const nagr =
        n === 1 ? 'jedno krótkie nagranie' : last >= 2 && last <= 4 && !teens ? `${n} krótkie nagrania` : `${n} krótkich nagrań`;
      return `Antosia uczy się słówek — i chce je usłyszeć Twoim głosem! Na tej stronie nagrasz ${nagr}. To zajmie około ${min} min.`;
    },
    greetingOneGo:
      'Ważne: dokończ wszystko za jednym razem i nie zamykaj ani nie odświeżaj tej strony — inaczej zaczniesz od nowa.',
    start: 'Zaczynamy ▶',
    tipsTitle: 'Jak zrobić dobre nagranie',
    tips: [
      'Naciśnij przycisk i od razu zacznij mówić — bez ciszy na początku.',
      'Mów wyraźnie i wesoło. Antosia usłyszy Twój głos w grze!',
      'Jeśli to pytanie — niech naprawdę brzmi jak pytanie.',
      'Możesz dodać coś od siebie — "Brawo, Antosiu!" jest jeszcze milsze niż samo "Brawo".',
      'Po każdym nagraniu możesz odsłuchać i powtórzyć, ile razy chcesz.',
    ],
    micHint:
      'Przy pierwszym nagraniu telefon zapyta, czy ta strona może używać mikrofonu. Wybierz wtedy "Zezwól" (Allow).',
    tipsGo: 'Jestem gotowa/gotowy ▶',
    stepOf: (i, n) => `Krok ${i} z ${n}`,
    saySimply: 'Naciśnij czerwony przycisk i od razu powiedz:',
    recording: 'Słucham — mów teraz!',
    stop: '⏹ Gotowe',
    recorded: '✅ Nagrane!',
    listen: '▶ Odsłuchaj',
    redo: '🔁 Jeszcze raz',
    next: 'Świetnie — dalej ▶',
    skip: 'Pomiń',
    micDenied:
      'Mikrofon jest wyłączony dla tej strony. Włącz go w ustawieniach przeglądarki albo poproś kogoś o pomoc.',
    phraseIntro: 'To należy do tego samego słowa: całe zdanie. (Można też pominąć.)',
    introTask: 'Antosia zobaczy Twoje zdjęcie, słysząc to nagranie. Powiedz wesoło:',
    photoTitle: 'Teraz Twoje zdjęcie',
    photoBody:
      'Antosia zobaczy Twoje zdjęcie na początku gry. Zrób sobie zdjęcie albo wybierz ładne istniejące.',
    takePhoto: '📷 Zrób zdjęcie',
    choosePhoto: '🖼 Wybierz zdjęcie',
    photoOk: '✅ Piękne zdjęcie!',
    doneTitle: 'Gotowe — dziękujemy! 🎉',
    doneBody:
      'Teraz trzeba to odesłać. Naciśnij duży przycisk poniżej i wybierz, jak wysłać plik (np. WhatsApp) — do osoby, od której masz ten link.',
    send: '📤 Wyślij',
    downloadNote:
      'Plik jest teraz w pobranych (nazywa się "antosia-opnames…"). Wyślij go jako załącznik przez WhatsApp albo e-mail do osoby, od której masz ten link.',
    sendAgain: 'Wyślij jeszcze raz',
    hints: {
      prompt: 'Powiedz to jak małe zadanie i urwij w połowie — słowo doklei się w grze samo.',
      correction: 'Łagodnie, nie surowo! I nie kończ zdania — słowo doklei się samo.',
      goed: 'Wesoło i z dumą — jakby właśnie zrobiła coś wspaniałego!',
    },
  },
};

// What the intro clip should say — the language's own name.
const NATIVE_LANGUAGE_NAMES = { nl: 'Nederlands!', pl: 'Polski!' };

// --- Request validation (plan §4.2: fail fast on anything malformed) ------------

function validateRequest(req) {
  const fail = () => {
    throw new Error('invalid recording request');
  };
  if (!req || typeof req !== 'object' || req.formatVersion !== 'recording-request-1') fail();
  if (req.language !== 'nl' && req.language !== 'pl') fail();
  if (!Array.isArray(req.words) || req.words.length > 60) fail();
  for (const w of req.words) {
    if (!w || typeof w.wordId !== 'string' || typeof w.word !== 'string') fail();
    if (w.thumb != null && (typeof w.thumb !== 'string' || w.thumb.length > 120 * 1024)) fail();
  }
  if (req.carriers != null && (!Array.isArray(req.carriers) || req.carriers.length > 10)) fail();
  for (const c of req.carriers || []) {
    if (!c || typeof c.name !== 'string' || typeof c.say !== 'string') fail();
  }
}

// --- Entry point (routed from admin.js before any DB access) --------------------

export async function startRecordingPage(gistId) {
  const root = document.getElementById('app');
  if (sessionEl) sessionEl.hidden = true;
  root.innerHTML = '';
  root.appendChild(el('p', { class: 'empty-state', text: 'Even geduld… / Chwileczkę…' }));
  try {
    const text = await fetchGistText(gistId);
    if (text.length > 8 * 1024 * 1024) throw new Error('request too large');
    const req = JSON.parse(text);
    validateRequest(req);
    runRecordingWizard(req);
  } catch {
    root.innerHTML = '';
    root.appendChild(
      el('p', {
        class: 'empty-state',
        text: `${STRINGS.nl.badLink} / ${STRINGS.pl.badLink}`,
      })
    );
  }
}

// Exported separately so the wizard can be exercised without a real Gist.
export function runRecordingWizard(req) {
  const root = document.getElementById('app');
  const t = STRINGS[req.uiLanguage] || STRINGS[req.language] || STRINGS.nl;

  // Everything stays in memory until "send back" (contract C5).
  const answers = {
    photo: null, // Blob
    intro: null, // { blob, mimeType }
    words: new Map(), // wordId -> { audioWord, audioPhrase, mimeType }
    carriers: new Map(), // name -> { blob, mimeType }
  };

  // Linear wizard: one task per screen, one primary button.
  const steps = [{ type: 'greeting' }, { type: 'tips' }];
  if (req.includeIntro) steps.push({ type: 'intro' });
  steps.push({ type: 'photo' });
  for (const w of req.words) {
    steps.push({ type: 'word', item: w });
    if (w.phraseText) steps.push({ type: 'phrase', item: w });
  }
  for (const c of req.carriers || []) steps.push({ type: 'carrier', item: c });
  steps.push({ type: 'send' });

  let index = 0;
  const next = () => {
    index = Math.min(index + 1, steps.length - 1);
    renderStep();
  };

  function screen(children) {
    root.innerHTML = '';
    const wrap = el('div', { class: 'record-page' }, children);
    root.appendChild(wrap);
    window.scrollTo(0, 0);
  }

  function progressLine() {
    // Count only real recording tasks (not greeting/tips/send) so the number
    // matches what the person feels they are doing.
    const tasks = steps.filter((s) => !['greeting', 'tips', 'send'].includes(s.type));
    const doneBefore = steps.slice(0, index).filter((s) => !['greeting', 'tips', 'send'].includes(s.type)).length;
    return el('div', { class: 'record-progress', text: t.stepOf(doneBefore + 1, tasks.length) });
  }

  // One recording block: red button → recording → recorded (listen/redo/next).
  // getExisting/setResult read/write the in-memory answer for this item.
  function recorderBlock({ sayText, hint, maxMs, getExisting, setResult, skippable = true, thumbUrl = null }) {
    const box = el('div', {});
    if (thumbUrl) {
      const img = el('img', { class: 'record-thumb', alt: '' });
      img.src = thumbUrl;
      box.appendChild(img);
    }
    box.appendChild(el('p', { class: 'record-instruction', text: t.saySimply }));
    box.appendChild(el('div', { class: 'record-say', text: sayText }));
    if (hint) box.appendChild(el('p', { class: 'record-hint', text: hint }));

    const statusEl = el('p', { class: 'record-status', text: '' });
    const buttons = el('div', { class: 'record-actions' });
    box.appendChild(statusEl);
    box.appendChild(buttons);

    let controller = null;

    function showIdle() {
      statusEl.textContent = getExisting() ? t.recorded : '';
      buttons.innerHTML = '';
      const recBtn = el('button', { type: 'button', class: 'record-btn', text: '🎤' });
      recBtn.addEventListener('click', startRecording);
      buttons.appendChild(recBtn);
      if (getExisting()) {
        appendRecordedActions();
      } else if (skippable) {
        appendSkip();
      }
    }

    async function startRecording() {
      // The mic can take a moment (first time: the permission prompt). Show
      // a calm "one moment" state until recording has ACTUALLY started —
      // never "speak now!" while nothing is being captured — and honor a
      // stop tap that lands during that wait.
      let stopRequested = false;
      try {
        statusEl.textContent = t.loading;
        buttons.innerHTML = '';
        const stopBtn = el('button', { type: 'button', class: 'record-btn recording', text: t.stop });
        stopBtn.addEventListener('click', () => {
          stopRequested = true;
          if (controller) controller.stop();
        });
        buttons.appendChild(stopBtn);
        controller = await recordAudio({ maxMs });
        statusEl.textContent = t.recording;
        if (stopRequested) controller.stop();
        const { blob, mimeType } = await controller.result;
        controller = null;
        setResult({ blob, mimeType });
        showRecorded();
      } catch {
        controller = null;
        showIdle();
        statusEl.textContent = t.micDenied; // after showIdle, which resets the status line
      }
    }

    function appendRecordedActions() {
      const listenBtn = el('button', { type: 'button', class: 'record-secondary', text: t.listen });
      listenBtn.addEventListener('click', () => {
        const existing = getExisting();
        if (existing) playBlob(existing.blob).catch(() => {});
      });
      const redoBtn = el('button', { type: 'button', class: 'record-secondary', text: t.redo });
      redoBtn.addEventListener('click', startRecording);
      const nextBtn = el('button', { type: 'button', class: 'record-primary', text: t.next });
      nextBtn.addEventListener('click', next);
      buttons.appendChild(listenBtn);
      buttons.appendChild(redoBtn);
      buttons.appendChild(nextBtn);
    }

    function appendSkip() {
      const skipBtn = el('button', { type: 'button', class: 'record-skip', text: t.skip });
      skipBtn.addEventListener('click', next);
      buttons.appendChild(skipBtn);
    }

    function showRecorded() {
      statusEl.textContent = t.recorded;
      buttons.innerHTML = '';
      appendRecordedActions();
    }

    showIdle();
    return box;
  }

  function renderStep() {
    const step = steps[index];

    if (step.type === 'greeting') {
      const taskCount = steps.filter((s) => ['intro', 'word', 'phrase', 'carrier'].includes(s.type)).length;
      const minutes = Math.max(2, Math.ceil(taskCount / 3));
      const startBtn = el('button', { type: 'button', class: 'record-primary record-start', text: t.start });
      startBtn.addEventListener('click', next);
      screen([
        el('h1', { class: 'record-title', text: t.greetingTitle(req.personName || '') }),
        el('p', { class: 'record-body', text: t.greetingBody(taskCount, minutes) }),
        el('p', { class: 'record-warn', text: t.greetingOneGo }),
        startBtn,
      ]);
      return;
    }

    if (step.type === 'tips') {
      const list = el('ul', { class: 'record-tips' });
      for (const tip of t.tips) list.appendChild(el('li', { text: tip }));
      const goBtn = el('button', { type: 'button', class: 'record-primary record-start', text: t.tipsGo });
      goBtn.addEventListener('click', next);
      screen([
        el('h1', { class: 'record-title', text: t.tipsTitle }),
        list,
        el('p', { class: 'record-warn', text: t.micHint }),
        goBtn,
      ]);
      return;
    }

    if (step.type === 'intro') {
      screen([
        progressLine(),
        el('p', { class: 'record-body', text: t.introTask }),
        recorderBlock({
          sayText: NATIVE_LANGUAGE_NAMES[req.language] || '',
          hint: t.hints.goed,
          maxMs: 4000,
          getExisting: () => answers.intro,
          setResult: (r) => (answers.intro = r),
        }),
      ]);
      return;
    }

    if (step.type === 'photo') {
      const takeInput = el('input', { type: 'file', accept: 'image/*', capture: 'user', hidden: '' });
      const chooseInput = el('input', { type: 'file', accept: 'image/*', hidden: '' });
      const preview = el('div', { class: 'record-photo-preview' });
      const buttons = el('div', { class: 'record-actions' });

      function refresh() {
        preview.innerHTML = '';
        buttons.innerHTML = '';
        if (answers.photo) {
          const img = el('img', { alt: '' });
          img.src = URL.createObjectURL(answers.photo);
          preview.appendChild(img);
          preview.appendChild(el('p', { class: 'record-status', text: t.photoOk }));
          const nextBtn = el('button', { type: 'button', class: 'record-primary', text: t.next });
          nextBtn.addEventListener('click', next);
          buttons.appendChild(nextBtn);
        }
        const takeBtn = el('button', { type: 'button', class: 'record-secondary', text: t.takePhoto });
        takeBtn.addEventListener('click', () => takeInput.click());
        const chooseBtn = el('button', { type: 'button', class: 'record-secondary', text: t.choosePhoto });
        chooseBtn.addEventListener('click', () => chooseInput.click());
        buttons.appendChild(takeBtn);
        buttons.appendChild(chooseBtn);
        if (!answers.photo) {
          const skipBtn = el('button', { type: 'button', class: 'record-skip', text: t.skip });
          skipBtn.addEventListener('click', next);
          buttons.appendChild(skipBtn);
        }
      }
      async function onFile(e) {
        const file = e.target.files[0];
        e.target.value = '';
        if (!file) return;
        try {
          answers.photo = await downscaleImage(file, 512, 0.8);
          refresh();
        } catch {
          /* leave the photo unset; they can try again or skip */
        }
      }
      takeInput.addEventListener('change', onFile);
      chooseInput.addEventListener('change', onFile);
      refresh();
      screen([
        progressLine(),
        el('h1', { class: 'record-title', text: t.photoTitle }),
        el('p', { class: 'record-body', text: t.photoBody }),
        preview,
        buttons,
        takeInput,
        chooseInput,
      ]);
      return;
    }

    if (step.type === 'word') {
      const w = step.item;
      screen([
        progressLine(),
        recorderBlock({
          sayText: w.label || w.word,
          hint: null,
          maxMs: 6000,
          thumbUrl: w.thumb || null,
          getExisting: () => answers.words.get(w.wordId) || null,
          setResult: (r) => {
            const existing = answers.words.get(w.wordId) || {};
            answers.words.set(w.wordId, { ...existing, audioWord: r.blob, mimeType: r.mimeType });
          },
        }),
      ]);
      return;
    }

    if (step.type === 'phrase') {
      const w = step.item;
      screen([
        progressLine(),
        el('p', { class: 'record-body', text: t.phraseIntro }),
        recorderBlock({
          sayText: w.phraseText,
          hint: null,
          maxMs: 15000,
          thumbUrl: w.thumb || null,
          getExisting: () => {
            const entry = answers.words.get(w.wordId);
            return entry && entry.audioPhrase ? { blob: entry.audioPhrase } : null;
          },
          setResult: (r) => {
            const existing = answers.words.get(w.wordId) || {};
            answers.words.set(w.wordId, { ...existing, audioPhrase: r.blob, mimeType: existing.mimeType || r.mimeType });
          },
        }),
      ]);
      return;
    }

    if (step.type === 'carrier') {
      const c = step.item;
      screen([
        progressLine(),
        recorderBlock({
          sayText: c.say,
          hint: t.hints[c.type] || null,
          maxMs: 5000,
          getExisting: () => answers.carriers.get(c.name) || null,
          setResult: (r) => answers.carriers.set(c.name, { blob: r.blob, mimeType: r.mimeType }),
        }),
      ]);
      return;
    }

    if (step.type === 'send') {
      const note = el('p', { class: 'record-body', text: '' });
      const sendBtn = el('button', { type: 'button', class: 'record-primary record-start', text: t.send });
      sendBtn.addEventListener('click', async () => {
        sendBtn.disabled = true;
        try {
          const json = JSON.stringify(await buildResponse());
          const safeName = (req.personName || 'familie').replace(/[^\p{L}\p{N}]+/gu, '-').toLowerCase();
          const { method } = await shareJsonFile({
            json,
            filename: `antosia-opnames-${safeName}.json`,
            title: "Antosia's app",
          });
          if (method === 'download') note.textContent = t.downloadNote;
          if (method === 'share') sendBtn.textContent = t.sendAgain;
        } finally {
          sendBtn.disabled = false;
        }
      });
      screen([
        el('h1', { class: 'record-title', text: t.doneTitle }),
        el('p', { class: 'record-body', text: t.doneBody }),
        sendBtn,
        note,
      ]);
      return;
    }
  }

  async function buildResponse() {
    const words = [];
    for (const [wordId, entry] of answers.words) {
      if (!entry.audioWord) continue; // a phrase without its word is unusable
      words.push({
        wordId,
        mimeType: entry.mimeType || entry.audioWord.type || '',
        audioWord: await blobToDataUrl(entry.audioWord),
        audioPhrase: entry.audioPhrase ? await blobToDataUrl(entry.audioPhrase) : null,
      });
    }
    const carriers = [];
    for (const [name, entry] of answers.carriers) {
      carriers.push({
        name,
        mimeType: entry.mimeType || entry.blob.type || '',
        blob: await blobToDataUrl(entry.blob),
      });
    }
    return {
      formatVersion: 'recording-response-1',
      language: req.language,
      personName: req.personName || '',
      personPhoto: answers.photo ? await blobToDataUrl(answers.photo) : null,
      introAudio: answers.intro ? await blobToDataUrl(answers.intro.blob) : null,
      words,
      carriers,
    };
  }

  renderStep();
}
