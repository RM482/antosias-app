import { ensureSeeded, requestPersistentStorage, getAll, get, put, remove, newId, wordLabel, isSessionEligible } from './db.js?v=7';
import { downscaleImage, recordAudio, unlockAudio, playBlob } from './media.js?v=7';
import { startSession, initSession } from './session.js?v=7';
import { el } from './dom.js?v=7';
import { exportAndShare, importFromGist } from './backup.js?v=7';

const appEl = document.getElementById('app');
const stack = [{ screen: 'categories' }];

function push(view) {
  stack.push(view);
  render();
}
function pop() {
  if (stack.length > 1) stack.pop();
  render();
}
function current() {
  return stack[stack.length - 1];
}

function topbar({ title, onBack, onAdd }) {
  const bar = el('div', { class: 'topbar' });
  if (onBack) bar.appendChild(el('button', { class: 'icon-btn', text: '‹ Back', onclick: onBack }));
  bar.appendChild(el('h1', { text: title }));
  if (onAdd) bar.appendChild(el('button', { class: 'icon-btn', text: '+ Add', onclick: onAdd }));
  return bar;
}

// --- Reusable form controls -----------------------------------------------------

function buildSegmented(container, { label, options, value, onChange }) {
  const wrap = el('div', { class: 'field' });
  wrap.appendChild(el('div', { class: 'field-label', text: label }));
  const seg = el('div', { class: 'segmented' });
  function refresh() {
    seg.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b.dataset.value === value));
  }
  for (const opt of options) {
    const btn = el('button', { type: 'button', text: opt.label });
    btn.dataset.value = opt.value;
    btn.addEventListener('click', () => {
      value = opt.value;
      onChange(opt.value);
      refresh();
    });
    seg.appendChild(btn);
  }
  refresh();
  wrap.appendChild(seg);
  container.appendChild(wrap);
}

function buildPhotoControl(container, draft) {
  const wrap = el('div', { class: 'media-block' });
  wrap.appendChild(el('div', { class: 'field-label', text: 'Photo' }));

  const previewRow = el('div', { style: 'display:flex; align-items:flex-start; gap:14px; margin-bottom:10px;' });
  const thumb = el('div', { class: 'thumb large' });
  function refreshThumb() {
    thumb.innerHTML = '';
    if (draft.photo) {
      const img = el('img', { alt: '' });
      img.src = URL.createObjectURL(draft.photo);
      thumb.appendChild(img);
    } else {
      thumb.textContent = draft.placeholderEmoji || '🔤';
    }
  }
  refreshThumb();
  previewRow.appendChild(thumb);

  const emojiField = el('div', {}, [
    el('div', { class: 'field-label', text: 'Placeholder emoji (used until a real photo is added)' }),
    el('input', {
      type: 'text',
      value: draft.placeholderEmoji || '',
      maxlength: '4',
      placeholder: '🍌',
      oninput: (e) => {
        draft.placeholderEmoji = e.target.value;
        if (!draft.photo) refreshThumb();
      },
    }),
  ]);
  previewRow.appendChild(emojiField);
  wrap.appendChild(previewRow);

  const btnRow = el('div', { class: 'btn-row' });
  const takeInput = el('input', { type: 'file', accept: 'image/*', capture: 'environment', hidden: '' });
  const chooseInput = el('input', { type: 'file', accept: 'image/*', hidden: '' });
  const takeTextSpan = el('span', { text: draft.photo ? 'Retake Photo' : 'Take Photo' });
  const takeLabel = el('label', { class: 'btn' }, [takeTextSpan, takeInput]);
  const chooseLabel = el('label', { class: 'btn' }, [el('span', { text: 'Choose Photo' }), chooseInput]);

  async function handleFile(file) {
    if (!file) return;
    try {
      draft.photo = await downscaleImage(file);
      refreshThumb();
      takeTextSpan.textContent = 'Retake Photo';
    } catch (err) {
      alert(`Could not use that photo: ${err.message}`);
    }
  }
  takeInput.addEventListener('change', (e) => {
    handleFile(e.target.files[0]);
    e.target.value = '';
  });
  chooseInput.addEventListener('change', (e) => {
    handleFile(e.target.files[0]);
    e.target.value = '';
  });

  btnRow.appendChild(takeLabel);
  btnRow.appendChild(chooseLabel);
  wrap.appendChild(btnRow);
  container.appendChild(wrap);
}

function buildAudioControl(container, { title, maxMs, getBlob, setBlob, required }) {
  const wrap = el('div', { class: 'media-block' });
  wrap.appendChild(el('div', { class: 'field-label', text: title }));

  const statusLine = el('div', { class: 'status-line' });
  function refreshStatus() {
    if (getBlob()) {
      statusLine.textContent = '✅ Recorded';
      statusLine.className = 'status-line status-ok';
    } else {
      statusLine.textContent = required
        ? '⚠️ Needed for this word to be usable in a session'
        : 'Not recorded (optional)';
      statusLine.className = `status-line ${required ? 'status-missing' : ''}`;
    }
  }
  refreshStatus();
  wrap.appendChild(statusLine);

  const btnRow = el('div', { class: 'btn-row' });
  const recordBtn = el('button', { type: 'button', text: 'Record' });
  const playBtn = el('button', { type: 'button', class: 'btn-secondary', text: 'Play' });
  playBtn.disabled = !getBlob();

  let activeController = null;
  recordBtn.addEventListener('click', async () => {
    unlockAudio();
    if (activeController) {
      activeController.stop();
      return;
    }
    try {
      recordBtn.textContent = 'Stop';
      const controller = await recordAudio({ maxMs });
      activeController = controller;
      const { blob } = await controller.result;
      activeController = null;
      recordBtn.textContent = 'Record';
      setBlob(blob);
      playBtn.disabled = false;
      refreshStatus();
    } catch (err) {
      activeController = null;
      recordBtn.textContent = 'Record';
      alert(err.message);
    }
  });

  playBtn.addEventListener('click', () => {
    const blob = getBlob();
    if (blob) playBlob(blob).catch((err) => alert(err.message));
  });

  btnRow.appendChild(recordBtn);
  btnRow.appendChild(playBtn);
  wrap.appendChild(btnRow);
  container.appendChild(wrap);
}

// --- Screens -----------------------------------------------------

async function renderCategories() {
  const [categories, words] = await Promise.all([getAll('categories'), getAll('words')]);
  categories.sort((a, b) => (a.order ?? 0) - (b.order ?? 0));

  appEl.appendChild(
    topbar({ title: "Antosia's app", onAdd: () => push({ screen: 'categoryEdit', categoryId: null }) })
  );

  const screen = el('div', { class: 'screen' });

  if (categories.length === 0) {
    screen.appendChild(
      el('p', {
        class: 'empty-state',
        text: 'No categories yet. Tap "+ Add" to create one, like "Breakfast" or "Bath time".',
      })
    );
  } else {
    const list = el('ul', { class: 'list' });
    for (const cat of categories) {
      const catWords = words.filter((w) => w.categoryId === cat.id);
      const readyCount = catWords.filter(isSessionEligible).length;
      const canStart = readyCount >= 2;

      const startBtn = el('button', {
        type: 'button',
        class: 'icon-btn session-start-btn',
        text: '▶ Start',
        onclick: () => startSession(cat.id),
      });
      startBtn.disabled = !canStart;
      startBtn.title = canStart
        ? `Start a session for ${cat.name}`
        : 'Needs at least 2 words with recorded audio';

      list.appendChild(
        el('li', {}, [
          el('div', { class: 'list-item-row' }, [
            el(
              'button',
              { class: 'list-item', onclick: () => push({ screen: 'words', categoryId: cat.id }) },
              [
                el('div', { class: 'thumb', text: cat.emoji || '📁' }),
                el('div', { class: 'list-item-body' }, [
                  el('div', { class: 'list-item-title', text: cat.name }),
                  el('div', {
                    class: 'list-item-sub',
                    text: `${catWords.length} word${catWords.length === 1 ? '' : 's'} · ${readyCount} ready for sessions`,
                  }),
                ]),
              ]
            ),
            startBtn,
          ]),
        ])
      );
    }
    screen.appendChild(list);
  }

  screen.appendChild(
    el('button', {
      class: 'btn-secondary',
      text: '📤 Export for sharing',
      style: 'margin-top:8px;width:100%;',
      onclick: async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Preparing export…';
        try {
          const { method, sizeMB } = await exportAndShare();
          if (method === 'download') {
            alert(
              `Exported (~${sizeMB} MB) as "antosias-app-export.json". Check your Downloads or Files app — send that file to whoever is publishing the shared link.`
            );
          }
        } catch (err) {
          alert(`Export failed: ${err.message}`);
        } finally {
          btn.disabled = false;
          btn.textContent = '📤 Export for sharing';
        }
      },
    })
  );

  appEl.appendChild(screen);
}

async function renderCategoryEdit({ categoryId }) {
  const isNew = !categoryId;
  const existing = isNew ? null : await get('categories', categoryId);
  const draft = {
    name: existing?.name || '',
    emoji: existing?.emoji || '🙂',
  };

  appEl.appendChild(topbar({ title: isNew ? 'New category' : 'Edit category', onBack: () => pop() }));
  const screen = el('div', { class: 'screen' });

  screen.appendChild(
    el('div', { class: 'field' }, [
      el('label', { text: 'Category name' }),
      el('input', {
        type: 'text',
        value: draft.name,
        placeholder: 'e.g. Breakfast',
        oninput: (e) => (draft.name = e.target.value),
      }),
    ])
  );

  screen.appendChild(
    el('div', { class: 'field' }, [
      el('label', { text: 'Emoji (shown in the list)' }),
      el('input', {
        type: 'text',
        value: draft.emoji,
        maxlength: '4',
        oninput: (e) => (draft.emoji = e.target.value),
      }),
    ])
  );

  const actions = el('div', { class: 'form-actions' });
  actions.appendChild(
    el('button', {
      text: 'Save',
      onclick: async () => {
        if (!draft.name.trim()) {
          alert('Please enter a category name.');
          return;
        }
        if (isNew) {
          const allCats = await getAll('categories');
          const maxOrder = allCats.reduce((m, c) => Math.max(m, c.order ?? 0), -1);
          await put('categories', {
            id: newId(),
            name: draft.name.trim(),
            emoji: draft.emoji.trim() || '🙂',
            order: maxOrder + 1,
            createdAt: Date.now(),
          });
        } else {
          await put('categories', { ...existing, name: draft.name.trim(), emoji: draft.emoji.trim() || '🙂' });
        }
        pop();
      },
    })
  );

  if (!isNew) {
    actions.appendChild(
      el('button', {
        class: 'btn-danger',
        text: 'Delete category (and its words)',
        onclick: async () => {
          const words = await getAll('words');
          const toDelete = words.filter((w) => w.categoryId === categoryId);
          if (!confirm(`Delete "${existing.name}" and its ${toDelete.length} word(s)? This can't be undone.`)) {
            return;
          }
          for (const w of toDelete) await remove('words', w.id);
          await remove('categories', categoryId);
          pop();
        },
      })
    );
  }

  actions.appendChild(el('button', { class: 'btn-secondary', text: 'Cancel', onclick: () => pop() }));
  screen.appendChild(actions);
  appEl.appendChild(screen);
}

async function renderWords({ categoryId }) {
  const [category, allWords] = await Promise.all([get('categories', categoryId), getAll('words')]);
  if (!category) {
    pop();
    return;
  }
  const words = allWords.filter((w) => w.categoryId === categoryId);

  appEl.appendChild(
    topbar({
      title: `${category.emoji} ${category.name}`,
      onBack: () => pop(),
      onAdd: () => push({ screen: 'wordEdit', categoryId, wordId: null }),
    })
  );

  const screen = el('div', { class: 'screen' });

  const readyCount = words.filter(isSessionEligible).length;
  const canStart = readyCount >= 2;
  const startBtn = el('button', {
    text: '▶ Start a session',
    style: 'margin-bottom:10px;width:100%;',
    onclick: () => startSession(categoryId),
  });
  startBtn.disabled = !canStart;
  screen.appendChild(startBtn);
  if (!canStart) {
    screen.appendChild(
      el('p', {
        class: 'hint',
        text: 'Needs at least 2 words with recorded audio before a session can start.',
        style: 'margin:-4px 0 14px;',
      })
    );
  }

  screen.appendChild(
    el('button', {
      class: 'btn-secondary',
      text: 'Edit category name / emoji',
      style: 'margin-bottom:16px;width:100%;',
      onclick: () => push({ screen: 'categoryEdit', categoryId }),
    })
  );

  if (words.length === 0) {
    screen.appendChild(
      el('p', { class: 'empty-state', text: 'No words in this category yet. Tap "+ Add" to create one.' })
    );
  } else {
    const list = el('ul', { class: 'list' });
    for (const w of words) {
      const label = wordLabel(w);
      const ready = isSessionEligible(w);
      const thumb = el('div', { class: 'thumb' });
      if (w.photo) {
        const img = el('img', { alt: '' });
        img.src = URL.createObjectURL(w.photo);
        thumb.appendChild(img);
      } else {
        thumb.textContent = w.placeholderEmoji || '🔤';
      }
      list.appendChild(
        el('li', {}, [
          el(
            'button',
            { class: 'list-item', onclick: () => push({ screen: 'wordEdit', categoryId, wordId: w.id }) },
            [
              thumb,
              el('div', { class: 'list-item-body' }, [
                el('div', { class: 'list-item-title', text: label || '(unnamed word)' }),
                el('div', { class: 'list-item-sub', text: w.phraseText || '' }),
              ]),
              el('span', {
                class: `badge ${ready ? 'badge-ok' : 'badge-warning'}`,
                text: ready ? 'Ready' : 'Needs audio',
              }),
            ]
          ),
        ])
      );
    }
    screen.appendChild(list);
  }

  appEl.appendChild(screen);
}

async function renderWordEdit({ categoryId, wordId }) {
  const isNew = !wordId;
  const existing = isNew ? null : await get('words', wordId);
  if (!isNew && !existing) {
    pop();
    return;
  }

  const now = Date.now();
  const draft = existing
    ? { ...existing }
    : {
        id: newId(),
        categoryId,
        language: 'nl',
        article: 'de',
        word: '',
        photo: null,
        placeholderEmoji: '🔤',
        audioWord: null,
        audioPhrase: null,
        phraseText: '',
        realWorldPrompt: '',
        understandingStatus: 'not_introduced',
        speechStatus: 'none',
        dateIntroduced: null,
        lastPracticed: null,
        timesPracticed: 0,
        createdAt: now,
        updatedAt: now,
      };

  appEl.appendChild(
    topbar({ title: isNew ? 'New word' : wordLabel(draft) || 'Edit word', onBack: () => pop() })
  );
  const screen = el('div', { class: 'screen' });

  buildSegmented(screen, {
    label: 'Article',
    options: [
      { label: 'de', value: 'de' },
      { label: 'het', value: 'het' },
      { label: '(none)', value: '' },
    ],
    value: draft.article,
    onChange: (v) => {
      draft.article = v;
      labelPreview.textContent = wordLabel(draft) || ' ';
    },
  });

  screen.appendChild(
    el('div', { class: 'field' }, [
      el('label', { text: 'Dutch word' }),
      el('input', {
        type: 'text',
        value: draft.word,
        placeholder: 'e.g. banaan',
        oninput: (e) => {
          draft.word = e.target.value;
          labelPreview.textContent = wordLabel(draft) || ' ';
        },
      }),
    ])
  );

  const labelPreview = el('div', { class: 'label-preview', text: wordLabel(draft) || ' ' });
  screen.appendChild(labelPreview);

  screen.appendChild(
    el('div', { class: 'field' }, [
      el('label', { text: 'Optional short phrase (text)' }),
      el('input', {
        type: 'text',
        value: draft.phraseText,
        placeholder: 'e.g. Dit is een banaan',
        oninput: (e) => (draft.phraseText = e.target.value),
      }),
    ])
  );

  screen.appendChild(
    el('div', { class: 'field' }, [
      el('label', { text: 'Real-world prompt for the parent' }),
      el('input', {
        type: 'text',
        value: draft.realWorldPrompt,
        placeholder: 'e.g. Give Papa de banaan',
        oninput: (e) => (draft.realWorldPrompt = e.target.value),
      }),
    ])
  );

  buildPhotoControl(screen, draft);

  buildAudioControl(screen, {
    title: 'Word audio (say just the word)',
    maxMs: 6000,
    getBlob: () => draft.audioWord,
    setBlob: (b) => (draft.audioWord = b),
    required: true,
  });

  buildAudioControl(screen, {
    title: 'Phrase audio (optional)',
    maxMs: 15000,
    getBlob: () => draft.audioPhrase,
    setBlob: (b) => (draft.audioPhrase = b),
    required: false,
  });

  buildSegmented(screen, {
    label: 'Understanding',
    options: [
      { label: 'Not introduced', value: 'not_introduced' },
      { label: 'Introduced', value: 'introduced' },
      { label: 'Understands', value: 'understands' },
    ],
    value: draft.understandingStatus,
    onChange: (v) => {
      draft.understandingStatus = v;
      if (v !== 'not_introduced' && !draft.dateIntroduced) draft.dateIntroduced = Date.now();
    },
  });

  buildSegmented(screen, {
    label: 'Speech',
    options: [
      { label: 'None', value: 'none' },
      { label: 'Attempts', value: 'attempts' },
      { label: 'Says it', value: 'says' },
    ],
    value: draft.speechStatus,
    onChange: (v) => (draft.speechStatus = v),
  });

  const actions = el('div', { class: 'form-actions' });
  actions.appendChild(
    el('button', {
      text: 'Save',
      onclick: async () => {
        if (!draft.word.trim()) {
          alert('Please enter the Dutch word.');
          return;
        }
        draft.word = draft.word.trim();
        draft.updatedAt = Date.now();
        await put('words', draft);
        pop();
      },
    })
  );

  if (!isNew) {
    actions.appendChild(
      el('button', {
        class: 'btn-danger',
        text: 'Delete word',
        onclick: async () => {
          if (!confirm(`Delete "${wordLabel(draft)}"? This can't be undone.`)) return;
          await remove('words', draft.id);
          pop();
        },
      })
    );
  }

  actions.appendChild(el('button', { class: 'btn-secondary', text: 'Cancel', onclick: () => pop() }));
  screen.appendChild(actions);
  appEl.appendChild(screen);
}

// --- Render dispatch + init -----------------------------------------------------

async function render() {
  appEl.innerHTML = '';
  const view = current();
  if (view.screen === 'categories') return renderCategories();
  if (view.screen === 'categoryEdit') return renderCategoryEdit(view);
  if (view.screen === 'words') return renderWords(view);
  if (view.screen === 'wordEdit') return renderWordEdit(view);
}

initSession(() => {
  stack.length = 0;
  stack.push({ screen: 'categories' });
  render();
});

(async () => {
  const sharedGistId = new URLSearchParams(location.search).get('shared');
  const alreadySeeded = await get('meta', 'seeded');

  if (!alreadySeeded && sharedGistId) {
    try {
      await importFromGist(sharedGistId);
      await put('meta', { key: 'seeded', value: true });
    } catch (err) {
      alert(`Could not load the shared words (${err.message}). Showing the example words instead.`);
      await ensureSeeded();
    }
  } else {
    await ensureSeeded();
  }

  requestPersistentStorage();
  render();
})();
