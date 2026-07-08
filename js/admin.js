import { ensureSeeded, requestPersistentStorage, getStorageStatus, getSettings, saveSettings, getAll, get, put, remove, newId, wordLabel, isSessionEligible } from './db.js?v=15';
import { downscaleImage, recordAudio, unlockAudio, playBlob } from './media.js?v=15';
import { startSession, initSession } from './session.js?v=15';
import { el } from './dom.js?v=15';
import { exportAndShare, importFromGist, importPayload } from './backup.js?v=15';

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

function topbar({ title, onBack, onAdd, onSettings }) {
  const bar = el('div', { class: 'topbar' });
  if (onBack) bar.appendChild(el('button', { class: 'icon-btn', text: '‹ Back', onclick: onBack }));
  bar.appendChild(el('h1', { text: title }));
  const actions = el('div', { class: 'topbar-actions' });
  if (onSettings)
    actions.appendChild(el('button', { class: 'icon-btn', text: '⚙️', 'aria-label': 'Settings', onclick: onSettings }));
  if (onAdd) actions.appendChild(el('button', { class: 'icon-btn', text: '+ Add', onclick: onAdd }));
  bar.appendChild(actions);
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
    topbar({
      title: "Antosia's app",
      onSettings: () => push({ screen: 'settings' }),
      onAdd: () => push({ screen: 'categoryEdit', categoryId: null }),
    })
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

  // Both buttons produce the same export file; they differ in intent and
  // messaging. Backup = safety copy for yourself, never size-gated.
  // Share = destined for a public-if-you-have-the-link Gist, so it gets a
  // privacy warning and a size check first.
  function exportButton({ label, busyLabel, options, beforeExport, doneMessage, onSuccess }) {
    return el('button', {
      class: 'btn-secondary',
      text: label,
      style: 'margin-top:8px;width:100%;',
      onclick: async (e) => {
        if (beforeExport && !beforeExport()) return;
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = busyLabel;
        try {
          const { method, sizeMB } = await exportAndShare(options);
          // 'cancelled' means the user backed out of the share sheet or the
          // size warning — nothing left the phone, so don't record it.
          if (method !== 'cancelled' && onSuccess) await onSuccess();
          if (method === 'download') alert(doneMessage(sizeMB));
        } catch (err) {
          alert(`Export failed: ${err.message}`);
        } finally {
          btn.disabled = false;
          btn.textContent = label;
        }
      },
    });
  }

  screen.appendChild(
    exportButton({
      label: '💾 Save backup',
      busyLabel: 'Preparing backup…',
      options: {},
      onSuccess: () => saveSettings({ lastBackupAt: Date.now() }),
      doneMessage: (sizeMB) =>
        `Backup saved (~${sizeMB} MB) as "antosias-app-export.json". Keep it somewhere safe — Files, iCloud Drive, or AirDrop it to your computer. It contains everything: words, photos, and recordings.`,
    })
  );

  screen.appendChild(
    exportButton({
      label: '📤 Share with family',
      busyLabel: 'Preparing export…',
      options: { warnLargeShare: true },
      beforeExport: () =>
        confirm(
          'Heads up: a shared link is unlisted but not private — anyone who has the link can see the photos and hear the recordings. Share it only with people you trust. Continue?'
        ),
      doneMessage: (sizeMB) =>
        `Exported (~${sizeMB} MB) as "antosias-app-export.json". Check your Downloads or Files app — send that file to whoever is publishing the shared link.`,
    })
  );

  // Restore from a backup file the parent saved earlier. A hidden file input
  // is triggered by the visible button; the picked file is read, parsed, and
  // imported (merge-by-id, all-or-nothing) so a reinstall or accident is
  // recoverable on the phone itself, without needing a computer.
  const restoreInput = el('input', { type: 'file', accept: 'application/json,.json', hidden: '' });
  restoreInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    if (
      !confirm(
        'Restore from this backup? Words in the file will be added, and any word with the same id will be overwritten by the backup version. Your other words are left as they are.'
      )
    )
      return;
    try {
      const text = await file.text();
      let payload;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new Error('That file is not readable — make sure it is an export from this app.');
      }
      const result = await importPayload(payload);
      const skippedNote = result.skipped ? ` (${result.skipped} unusable entr${result.skipped === 1 ? 'y' : 'ies'} skipped)` : '';
      alert(`Restored ${result.words} word${result.words === 1 ? '' : 's'} and ${result.categories} categor${result.categories === 1 ? 'y' : 'ies'}${skippedNote}.`);
      render();
    } catch (err) {
      alert(`Restore failed: ${errText(err)}`);
    }
  });
  screen.appendChild(
    el('button', {
      class: 'btn-secondary',
      text: '♻️ Restore from backup',
      style: 'margin-top:8px;width:100%;',
      onclick: () => restoreInput.click(),
    })
  );
  screen.appendChild(restoreInput);

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
      const excluded = w.excluded === true;
      const ready = isSessionEligible(w); // already false when excluded
      const thumb = el('div', { class: 'thumb' });
      if (w.photo) {
        const img = el('img', { alt: '' });
        img.src = URL.createObjectURL(w.photo);
        thumb.appendChild(img);
      } else {
        thumb.textContent = w.placeholderEmoji || '🔤';
      }
      // Excluded words take priority in the badge — "Skipped" is more useful
      // than "Needs audio" for a word deliberately kept out of sessions.
      let badgeClass = 'badge-warning';
      let badgeText = 'Needs audio';
      if (excluded) {
        badgeClass = 'badge-muted';
        badgeText = 'Skipped';
      } else if (ready) {
        badgeClass = 'badge-ok';
        badgeText = 'Ready';
      }
      list.appendChild(
        el('li', {}, [
          el(
            'button',
            {
              class: `list-item${excluded ? ' list-item-muted' : ''}`,
              onclick: () => push({ screen: 'wordEdit', categoryId, wordId: w.id }),
            },
            [
              thumb,
              el('div', { class: 'list-item-body' }, [
                el('div', { class: 'list-item-title', text: label || '(unnamed word)' }),
                el('div', { class: 'list-item-sub', text: w.phraseText || '' }),
              ]),
              el('span', { class: `badge ${badgeClass}`, text: badgeText }),
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

  // Excluding a word she knows well keeps it out of sessions without deleting
  // it (or its photo/recording). buildSegmented works on strings, so map the
  // boolean to 'in'/'skip'.
  buildSegmented(screen, {
    label: 'In sessions',
    options: [
      { label: 'Include', value: 'in' },
      { label: 'Skip (she knows it)', value: 'skip' },
    ],
    value: draft.excluded ? 'skip' : 'in',
    onChange: (v) => (draft.excluded = v === 'skip'),
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

// --- Settings screen -----------------------------------------------------

function formatBackupDate(ms) {
  if (!ms) return 'never';
  return new Date(ms).toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
}

function card(title, children) {
  return el('div', { class: 'settings-card' }, [el('h2', { class: 'settings-card-title', text: title }), ...children]);
}

async function renderSettings() {
  appEl.appendChild(topbar({ title: 'Settings', onBack: () => pop() }));
  const screen = el('div', { class: 'screen' });

  const [settings, storage] = await Promise.all([getSettings(), getStorageStatus()]);

  // --- Backup reminder ---
  const last = settings.lastBackupAt;
  const daysSince = last ? Math.floor((Date.now() - last) / 86400000) : null;
  const overdue = last == null || daysSince >= 30;
  const backupChildren = [
    el('p', { class: 'settings-line', text: `Last backup: ${formatBackupDate(last)}` }),
  ];
  if (overdue) {
    backupChildren.push(
      el('p', {
        class: 'settings-note settings-note-warn',
        text:
          last == null
            ? "You haven't saved a backup yet. Tap “Save backup” on the home screen to keep a safe copy of your words, photos, and recordings."
            : `It's been about ${daysSince} days since your last backup. A monthly backup is a good habit.`,
      })
    );
  } else {
    backupChildren.push(
      el('p', { class: 'settings-note', text: 'Saving a backup roughly once a month is a good habit.' })
    );
  }
  screen.appendChild(card('Backups', backupChildren));

  // --- Storage status (honest wording: no false guarantees) ---
  const storageChildren = [];
  if (!storage.supported) {
    storageChildren.push(el('p', { class: 'settings-note', text: 'Storage details are not available in this browser.' }));
  } else {
    storageChildren.push(
      el('p', {
        class: 'settings-line',
        text: `Persistent storage: ${storage.persisted ? 'granted' : 'not granted'}`,
      })
    );
    storageChildren.push(
      el('p', {
        class: 'settings-note',
        text: storage.persisted
          ? 'The browser has agreed to keep this app’s data. A backup is still your real safety net.'
          : 'The browser has not guaranteed to keep this app’s data, so keep a recent backup.',
      })
    );
    if (storage.usageBytes != null) {
      storageChildren.push(
        el('p', {
          class: 'settings-line',
          text: `Using about ${(storage.usageBytes / 1024 / 1024).toFixed(1)} MB (approximate).`,
        })
      );
    }
  }
  screen.appendChild(card('Storage', storageChildren));

  // --- Guided Access instructions ---
  const steps = [
    'One-time setup: open the iPhone Settings app → Accessibility → Guided Access. Turn it on and set a passcode.',
    'Open Antosia’s app first, then triple-click the side button (the on/off button). If a menu appears, choose Guided Access.',
    'Tap Start (top right). The phone is now locked to this app.',
    'To finish: triple-click the side button again, enter your passcode, then tap End.',
  ];
  const list = el('ol', { class: 'settings-steps' });
  for (const s of steps) list.appendChild(el('li', { text: s }));
  screen.appendChild(
    card('🔒 Lock the phone to this app (Guided Access)', [
      el('p', {
        class: 'settings-note',
        text: 'Guided Access is Apple’s way to keep a toddler inside one app so taps can’t escape to the rest of the phone.',
      }),
      list,
      el('a', {
        class: 'settings-link',
        text: 'Apple’s official Guided Access guide ↗',
        href: 'https://support.apple.com/en-us/111795',
        target: '_blank',
        rel: 'noopener',
      }),
      el('p', {
        class: 'settings-note',
        text: 'The exact buttons can vary slightly by iPhone model and iOS version — the link above always has the current steps.',
      }),
    ])
  );

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
  if (view.screen === 'settings') return renderSettings();
}

initSession(() => {
  stack.length = 0;
  stack.push({ screen: 'categories' });
  render();
});

function showStartupMessage(text) {
  appEl.innerHTML = '';
  appEl.appendChild(el('p', { class: 'empty-state', text }));
}

function errText(err) {
  return (err && err.message) || String(err);
}

(async () => {
  try {
    const sharedGistId = new URLSearchParams(location.search).get('shared');
    const alreadySeeded = await get('meta', 'seeded');

    if (!alreadySeeded && sharedGistId) {
      showStartupMessage('Loading shared words… this can take a little while on first open.');
      try {
        await importFromGist(sharedGistId);
        await put('meta', { key: 'seeded', value: true });
      } catch (err) {
        alert(`Could not load the shared words (${errText(err)}). Showing the example words instead.`);
        await ensureSeeded();
      }
    } else {
      await ensureSeeded();
    }

    requestPersistentStorage();
    render();
  } catch (err) {
    // Surface startup failures (e.g. storage unavailable in some private
    // browsing modes) as visible text instead of a silent blank page.
    showStartupMessage(`Something went wrong while starting the app: ${errText(err)}`);
  }
})();
