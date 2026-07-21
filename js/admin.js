import { ensureSeeded, migrateDutchCategoryNames, requestPersistentStorage, getStorageStatus, getSettings, saveSettings, getStandardPhrases, saveStandardPhrase, guessUsesEen, usesEen, LANGUAGES, getAll, get, put, remove, newId, wordLabel, isSessionEligible, saveWord, attachPhotos, deleteWordAndCleanup, savePerson, deletePersonAndCleanup, wordRecordingId, carrierRecordingId, savePhoto } from './db.js?v=44';
import { downscaleImage, recordAudio, unlockAudio, playBlob } from './media.js?v=44';
import { startSession, initSession, showStickerBook } from './session.js?v=44';
import { startChildMode } from './child.js?v=44';
import { el } from './dom.js?v=44';
import { buildAuditPlan, validateManualPair } from './concepts.js?v=44';
import { exportAndShare, importFromGist, analyzeImportPayload, applyImportPayload, shareJsonFile, blobToDataUrl, analyzeRecordingResponse, applyRecordingResponse } from './backup.js?v=44';

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
  // setValue updates the highlighted option without firing onChange — used to
  // reflect an auto-computed default (e.g. "een" vs mass noun) as it changes.
  return {
    setValue(v) {
      value = v;
      refresh();
    },
  };
}

// Photo take/choose control writing a downscaled Blob to draft.photo. Words
// also get the placeholder-emoji field; people (showEmoji: false) just show a
// generic face until a photo is added.
function buildPhotoControl(container, draft, { showEmoji = true, emptyIcon = '🔤' } = {}) {
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
      thumb.textContent = (showEmoji && draft.placeholderEmoji) || emptyIcon;
    }
  }
  refreshThumb();
  previewRow.appendChild(thumb);

  if (showEmoji) {
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
  }
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

async function switchLanguage(lang) {
  await saveSettings({ language: lang });
  await ensureSeeded(lang); // seed that language's starter set the first time it's chosen
  render();
}

async function renderCategories() {
  const [allCategories, allWords, settings, stickersRec] = await Promise.all([
    getAll('categories'),
    getAll('words'),
    getSettings(),
    get('meta', 'stickers').catch(() => null),
  ]);
  const lang = settings.language || 'nl';
  const stickerCount = (stickersRec && Array.isArray(stickersRec.value) && stickersRec.value.length) || 0;
  // Only show the active language's content (old records without a language
  // field read as Dutch, so nothing pre-existing disappears).
  const categories = allCategories
    .filter((c) => (c.language ?? 'nl') === lang)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const words = allWords.filter((w) => (w.language ?? 'nl') === lang);

  appEl.appendChild(
    topbar({
      title: "Antosia's app",
      onSettings: () => push({ screen: 'settings' }),
      onAdd: () => push({ screen: 'categoryEdit', categoryId: null }),
    })
  );

  const screen = el('div', { class: 'screen' });

  // Child-first entry (Stage 6): Antosia's own button. It opens the flag →
  // category-tiles flow; the per-category "▶ Start" buttons below stay as the
  // parent's instant path with no intro screens.
  screen.appendChild(
    el('button', {
      class: 'play-btn',
      text: '▶ Play',
      onclick: () => startChildMode(returnHome),
    })
  );

  // Her collection, one tap away (parent taps it and hands the phone over —
  // it opens full-screen with the hold-to-exit gate, like a session).
  screen.appendChild(
    el('button', {
      class: 'btn-secondary',
      text: `⭐ Sticker book${stickerCount ? ` (${stickerCount})` : ''}`,
      style: 'width:100%;margin-bottom:16px;',
      onclick: () => showStickerBook(),
    })
  );

  // Language switcher (flags). Tapping a flag stores the choice, seeds that
  // language's starter words the first time, and re-renders everything for it.
  const langSwitch = el('div', { class: 'lang-switch' });
  for (const l of LANGUAGES) {
    const btn = el('button', {
      type: 'button',
      class: `lang-btn${l.code === lang ? ' active' : ''}`,
      text: l.flag,
      'aria-label': l.label,
      title: l.label,
      onclick: () => {
        if (l.code !== lang) switchLanguage(l.code);
      },
    });
    langSwitch.appendChild(btn);
  }
  screen.appendChild(langSwitch);

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

  // Quick-record wizard entry: one button that walks through every word (in
  // the active language) still missing its word audio — the fastest way to
  // make a whole language playable, e.g. recording all the Polish seeds.
  const missingAudio = words.filter((w) => w.excluded !== true && !w.audioWord);
  if (missingAudio.length > 0) {
    const catOrder = new Map(categories.map((c, i) => [c.id, i]));
    missingAudio.sort(
      (a, b) =>
        (catOrder.get(a.categoryId) ?? 999) - (catOrder.get(b.categoryId) ?? 999) ||
        (a.createdAt ?? 0) - (b.createdAt ?? 0)
    );
    screen.appendChild(
      el('button', {
        class: 'btn-secondary',
        text: `🎙 Record missing audio (${missingAudio.length} word${missingAudio.length === 1 ? '' : 's'})`,
        style: 'margin-top:8px;width:100%;',
        onclick: () =>
          push({ screen: 'quickRecord', wordIds: missingAudio.map((w) => w.id), index: 0 }),
      })
    );
  }

  // Quick-translate entry: active-language words that have a picture but no
  // twin in the other language yet. Sharing the photo is how twins link, so we
  // only flag words that HAVE a photo (a photo-less word has nothing to link a
  // translation to, and isn't session-ready anyway).
  const otherLang = lang === 'nl' ? 'pl' : 'nl';
  const otherLabel = (LANGUAGES.find((l) => l.code === otherLang) || {}).label || 'other language';
  const untranslated = words.filter(
    (w) =>
      w.excluded !== true &&
      w.photoId &&
      !allWords.some((o) => (o.language ?? 'nl') === otherLang && o.photoId === w.photoId)
  );
  if (untranslated.length > 0) {
    const catOrder = new Map(categories.map((c, i) => [c.id, i]));
    untranslated.sort(
      (a, b) =>
        (catOrder.get(a.categoryId) ?? 999) - (catOrder.get(b.categoryId) ?? 999) ||
        (a.createdAt ?? 0) - (b.createdAt ?? 0)
    );
    screen.appendChild(
      el('button', {
        class: 'btn-secondary',
        text: `➕ Add missing ${otherLabel} translations (${untranslated.length})`,
        style: 'margin-top:8px;width:100%;',
        onclick: () =>
          push({ screen: 'addTranslations', wordIds: untranslated.map((w) => w.id), index: 0 }),
      })
    );
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
      // Analyse before writing: if anything in the file is unusable the parent
      // is told exactly what, by name, and decides. Declining writes nothing.
      // (Damaged photos, people and recordings used to be dropped silently —
      // they were not even counted.)
      const analysis = analyzeImportPayload(payload);
      if (analysis.omitted.length > 0) {
        const lines = analysis.omitted
          .slice(0, 12)
          .map((o) => `• ${o.store}: ${o.identity} — ${o.reason}`)
          .join('\n');
        const more =
          analysis.omitted.length > 12 ? `\n…and ${analysis.omitted.length - 12} more.` : '';
        const proceed = confirm(
          `${analysis.omitted.length} entr${analysis.omitted.length === 1 ? 'y is' : 'ies are'} damaged and cannot be restored:\n\n${lines}${more}\n\nRestore everything else? (Nothing has been changed yet. Keep this backup file either way — a newer version of the app may be able to read more of it.)`
        );
        if (!proceed) return;
      }
      const result = await applyImportPayload(analysis);
      const skippedNote = result.skipped ? ` (${result.skipped} damaged entr${result.skipped === 1 ? 'y' : 'ies'} could not be restored)` : '';
      const peopleNote = result.people || result.recordings
        ? `, ${result.people} ${result.people === 1 ? 'person' : 'people'} and ${result.recordings} voice recording${result.recordings === 1 ? '' : 's'}`
        : '';
      alert(`Restored ${result.words} word${result.words === 1 ? '' : 's'} and ${result.categories} categor${result.categories === 1 ? 'y' : 'ies'}${peopleNote}${skippedNote}.`);
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
          const [allCats, settings] = await Promise.all([getAll('categories'), getSettings()]);
          const maxOrder = allCats.reduce((m, c) => Math.max(m, c.order ?? 0), -1);
          const lang = settings.language || 'nl'; // new category belongs to the active language
          const created = {
            id: newId(),
            name: draft.name.trim(),
            emoji: draft.emoji.trim() || '🙂',
            language: lang,
            order: maxOrder + 1,
            createdAt: Date.now(),
          };
          await put('categories', created);
          // Mirror: create the matching category in the other language so both
          // flags stay in step. The twin starts with the same name (we can't
          // translate) and emoji — rename it on the other flag when convenient.
          await findOrCreatePairedCategory(created, lang === 'nl' ? 'pl' : 'nl');
        } else {
          const updated = { ...existing, name: draft.name.trim(), emoji: draft.emoji.trim() || '🙂' };
          await put('categories', updated);
          // Mirror the emoji (the picture of the concept) to the paired
          // category; names stay language-specific, so we don't touch those.
          const twin = await findOrCreatePairedCategory(updated, (updated.language ?? 'nl') === 'nl' ? 'pl' : 'nl');
          if (twin && twin.emoji !== updated.emoji) {
            await put('categories', { ...twin, emoji: updated.emoji });
          }
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
          const [words, allCats] = await Promise.all([getAll('words'), getAll('categories')]);
          const otherLang = (existing.language ?? 'nl') === 'nl' ? 'pl' : 'nl';
          const otherLabel = otherLang === 'nl' ? 'Dutch' : 'Polish';
          // Cascade ONLY on a strong link. A same-name category is not proof of
          // a twin, and this path deletes words — so an unverified match is left
          // alone and the parent is told, rather than guessed at.
          const twin = findLinkedTwinCategory(existing, allCats, otherLang);
          const here = words.filter((w) => w.categoryId === categoryId);
          const there = twin ? words.filter((w) => w.categoryId === twin.id) : [];

          let twinNote = '';
          if (twin) {
            twinNote = ` Its linked ${otherLabel} category “${twin.name}” and its ${there.length} word(s) go too.`;
          } else {
            const maybe = findPairingCandidate(existing, allCats, otherLang);
            if (maybe) {
              twinNote =
                ` There is also a ${otherLabel} category called “${maybe.name}”, but it is NOT linked to this one, so it will be left alone` +
                ` — delete it separately if you want it gone.`;
            }
          }
          if (!confirm(`Delete “${existing.name}” and its ${here.length} word(s)?${twinNote} This can't be undone.`)) {
            return;
          }
          for (const w of here) await deleteWordAndCleanup(w.id);
          await remove('categories', categoryId);
          if (twin) {
            for (const w of there) await deleteWordAndCleanup(w.id);
            await remove('categories', twin.id);
          }
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
  // Words that keep their photo in the photos store need the blob loaded
  // before the list can show thumbnails.
  await attachPhotos(words);

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

  // Test mode (TEST_MODE_PLAN.md): no listen stage, straight to "vind de …"
  // with 2–4 pictures. The difficulty choice persists in settings so it can
  // be ratcheted up as she grows.
  const settings = await getSettings();
  let testOptionCount = Math.min(4, Math.max(2, settings.testOptionCount || 2));
  const testBtn = el('button', {
    class: 'btn-secondary',
    text: '🎯 Start a test',
    style: 'margin-bottom:10px;width:100%;',
    onclick: () => startSession(categoryId, { mode: 'test', optionCount: testOptionCount }),
  });
  testBtn.disabled = !canStart;
  buildSegmented(screen, {
    label: 'Test difficulty (pictures to choose from)',
    options: [
      { label: '2', value: '2' },
      { label: '3', value: '3' },
      { label: '4', value: '4' },
    ],
    value: String(testOptionCount),
    onChange: (v) => {
      testOptionCount = Number(v);
      saveSettings({ testOptionCount });
    },
  });
  screen.appendChild(testBtn);

  if (!canStart) {
    screen.appendChild(
      el('p', {
        class: 'hint',
        text: 'Needs at least 2 words with recorded audio before a session or test can start.',
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

// Find the other-language category that mirrors this one, creating it if
// needed. Matching by name alone fails for the seeded pairs ("Breakfast" vs
// "Śniadanie"), so: (1) follow a previously stored pairedCategoryId link,
// (2) match seeded ids by their shared suffix (…cat-breakfast ↔
// pl-cat-breakfast), (3) match by identical name, (4) create a counterpart
// with the same name/emoji. The resolved pair is linked both ways so later
// renames can't break it.
// STRONG identity — the only lookup allowed to authorize something destructive
// (a cascading delete). A twin is certain in exactly two cases:
//   1. a RECIPROCAL pairedCategoryId link (both records point at each other), or
//   2. a deterministic seed pair (nl-cat-toys ↔ pl-cat-toys).
// A same-name match is deliberately NOT identity here: a freshly mirrored
// category starts out carrying the other language's name, and legacy/restored
// data can collide by accident — deleting on a name guess would take an
// unrelated category AND every word inside it, with no undo.
function findLinkedTwinCategory(category, cats, otherLang) {
  const inOtherLang = (c) => c && (c.language ?? 'nl') === otherLang;

  if (category.pairedCategoryId) {
    const linked = cats.find((c) => c.id === category.pairedCategoryId);
    if (inOtherLang(linked) && linked.pairedCategoryId === category.id) return linked;
  }
  const seedSuffix = /(?:^|-)cat-(.+)$/.exec(category.id || '');
  if (seedSuffix) {
    const seedTwin = cats.find((c) => c.id === `${otherLang}-cat-${seedSuffix[1]}` && inOtherLang(c));
    if (seedTwin) return seedTwin;
  }
  return null;
}

// WEAK, non-destructive guess at an existing counterpart when no strong link
// exists yet: a one-way link, or an identical name. Used ONLY to adopt a
// category and then link it properly (findOrCreatePairedCategory) — never to
// authorize a delete.
function findPairingCandidate(category, cats, otherLang) {
  const inOtherLang = (c) => c && (c.language ?? 'nl') === otherLang;
  if (category.pairedCategoryId) {
    const linked = cats.find((c) => c.id === category.pairedCategoryId);
    if (inOtherLang(linked)) return linked;
  }
  const name = (category.name || '').trim().toLowerCase();
  if (!name) return null;
  return cats.find((c) => inOtherLang(c) && (c.name || '').trim().toLowerCase() === name) || null;
}

async function findOrCreatePairedCategory(category, otherLang) {
  const cats = await getAll('categories');
  // Adopting on a weak match is fine here — the pair gets linked both ways
  // below, which upgrades it to a strong (reciprocal) link for next time.
  let match =
    findLinkedTwinCategory(category, cats, otherLang) || findPairingCandidate(category, cats, otherLang);
  if (!match) {
    match = {
      id: newId(),
      name: category.name,
      emoji: category.emoji,
      order: category.order ?? 0,
      language: otherLang,
    };
    await put('categories', match);
  }
  if (category.pairedCategoryId !== match.id) {
    category.pairedCategoryId = match.id;
    await put('categories', category);
  }
  if (match.pairedCategoryId !== category.id) {
    match.pairedCategoryId = category.id;
    await put('categories', match);
  }
  return match;
}

async function renderWordEdit({ categoryId, wordId }) {
  const isNew = !wordId;
  const [existing, category, allWords] = await Promise.all([
    isNew ? null : get('words', wordId),
    get('categories', categoryId),
    getAll('words'),
  ]);
  if (!isNew && !existing) {
    pop();
    return;
  }

  // A word belongs to its category's language. Dutch shows the de/het article
  // picker and the "een" toggle; Polish (no articles) hides both.
  const wordLang = existing ? existing.language ?? 'nl' : category?.language ?? 'nl';
  const isDutch = wordLang === 'nl';
  const otherLang = isDutch ? 'pl' : 'nl';
  const langLabel = (LANGUAGES.find((l) => l.code === wordLang) || {}).label || 'Word';
  const otherLangLabel = (LANGUAGES.find((l) => l.code === otherLang) || {}).label || 'Word';

  const now = Date.now();
  const draft = existing
    ? { ...existing }
    : {
        id: newId(),
        categoryId,
        language: wordLang,
        article: isDutch ? 'de' : '',
        word: '',
        photo: null,
        placeholderEmoji: '🔤',
        audioWord: null,
        audioPhrase: null,
        phraseText: '',
        realWorldPrompt: '',
        understandingStatus: 'not_introduced',
        speechStatus: 'none',
        useEen: true, // Dutch only; countable by default (turn off for mass nouns)
        excluded: false,
        srsLevel: 0,
        nextReviewDate: null,
        dateIntroduced: null,
        lastPracticed: null,
        timesPracticed: 0,
        createdAt: now,
        updatedAt: now,
      };

  // Load the photo blob for display if this word keeps its photo in the
  // photos store (new format).
  await attachPhotos([draft]);

  // The paired word is the other-language word sharing this word's photo.
  // Only a real photoId links words — matching on a missing id would pair
  // this word with any other-language word that also has no photo.
  const pairedWord = draft.photoId
    ? allWords.find((w) => (w.language ?? 'nl') === otherLang && w.photoId === draft.photoId) || null
    : null;

  // Draft for the other-language version, edited in the section below the
  // main word's fields. Category is resolved at save time (see the Save
  // handler) so a new paired word always lands on its own language's side.
  let pairedDraft = pairedWord
    ? { ...pairedWord }
    : {
        id: newId(),
        categoryId: null,
        language: otherLang,
        article: otherLang === 'nl' ? 'de' : '',
        word: '',
        photo: null,
        photoId: null,
        placeholderEmoji: draft.placeholderEmoji || '🔤',
        audioWord: null,
        audioPhrase: null,
        phraseText: '',
        realWorldPrompt: '',
        understandingStatus: 'not_introduced',
        speechStatus: 'none',
        useEen: otherLang === 'nl', // same countable-by-default as the main draft
        excluded: false,
        srsLevel: 0,
        nextReviewDate: null,
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

  // Dutch-only grammar controls: the de/het article picker and the "een"
  // correction toggle. Polish has neither, so they're omitted for Polish words.
  let eenSeg = null;
  let eenTouched = false;
  if (isDutch) {
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

    // Correction phrasing in the game: “een” → "Nee, dit is een mandarijn"
    // (countable); “no een” → "Nee, dit is brood" (mass nouns). Auto-guessed
    // from the word until the parent sets it by hand; an explicit saved choice
    // is kept.
    const eenExplicit = existing && typeof existing.useEen === 'boolean';
    eenTouched = !!eenExplicit;
    draft.useEen = usesEen(draft); // explicit saved value, else the guess (same as the game)
    eenSeg = buildSegmented(screen, {
      label: 'Naming it (“dit is …”)',
      options: [
        { label: 'een …', value: 'een' },
        { label: 'no “een”', value: 'none' },
      ],
      value: draft.useEen ? 'een' : 'none',
      onChange: (v) => {
        draft.useEen = v === 'een';
        eenTouched = true; // stop auto-guessing once the parent decides
      },
    });
  }

  screen.appendChild(
    el('div', { class: 'field' }, [
      el('label', { text: `${langLabel} word` }),
      el('input', {
        type: 'text',
        value: draft.word,
        placeholder: isDutch ? 'e.g. banaan' : 'e.g. banan',
        oninput: (e) => {
          draft.word = e.target.value;
          labelPreview.textContent = wordLabel(draft) || ' ';
          if (isDutch && eenSeg && !eenTouched) {
            draft.useEen = guessUsesEen(draft.word);
            eenSeg.setValue(draft.useEen ? 'een' : 'none');
          }
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
        placeholder: isDutch ? 'e.g. Dit is een banaan' : 'e.g. To jest banan',
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
        placeholder: isDutch ? 'e.g. Give Papa de banaan' : 'e.g. Daj Papie bananę',
        oninput: (e) => (draft.realWorldPrompt = e.target.value),
      }),
    ])
  );

  buildPhotoControl(screen, draft);

  // --- Extra photos (optional) ---
  // Several pictures of the same concept (e.g. three different paintings for
  // "schilderij") so sessions rotate between them and she learns the concept,
  // not one specific object. The photo above stays the word's primary — it
  // links language twins and is used for list/request thumbnails. Entries
  // hold either a saved id or a not-yet-saved blob; everything persists on
  // Save (never on tap), same as the rest of this form.
  const extraEntries = [];
  for (const pid of draft.extraPhotoIds || []) {
    let blob = null;
    try {
      blob = (await get('photos', pid))?.blob || null;
    } catch {
      /* undisplayable, still kept */
    }
    extraEntries.push({ id: pid, blob });
  }
  const originalExtraIds = extraEntries.map((e) => e.id);
  {
    const wrap = el('div', { class: 'media-block' });
    wrap.appendChild(
      el('div', { class: 'field-label', text: 'More photos of the same thing (optional)' })
    );
    wrap.appendChild(
      el('p', {
        class: 'settings-note',
        text: 'Sessions switch between all the photos, so she learns the word — not one specific object. Tap a photo to remove it.',
      })
    );
    const thumbRow = el('div', { style: 'display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px;' });
    function refreshThumbs() {
      thumbRow.innerHTML = '';
      extraEntries.forEach((entry, i) => {
        const thumb = el('button', {
          type: 'button',
          class: 'thumb large',
          'aria-label': 'Remove this photo',
        });
        if (entry.blob) {
          const img = el('img', { alt: '' });
          img.src = URL.createObjectURL(entry.blob);
          thumb.appendChild(img);
        } else {
          thumb.textContent = '🖼️';
        }
        thumb.onclick = () => {
          if (confirm('Remove this extra photo?')) {
            extraEntries.splice(i, 1);
            refreshThumbs();
          }
        };
        thumbRow.appendChild(thumb);
      });
    }
    refreshThumbs();
    wrap.appendChild(thumbRow);

    const addInput = el('input', { type: 'file', accept: 'image/*', hidden: '' });
    addInput.addEventListener('change', async (e) => {
      const file = e.target.files[0];
      e.target.value = '';
      if (!file) return;
      try {
        extraEntries.push({ id: null, blob: await downscaleImage(file) });
        refreshThumbs();
      } catch (err) {
        alert(`Could not use that photo: ${err.message}`);
      }
    });
    const btnRow = el('div', { class: 'btn-row' });
    btnRow.appendChild(el('label', { class: 'btn' }, [el('span', { text: '＋ Add photo' }), addInput]));
    wrap.appendChild(btnRow);
    screen.appendChild(wrap);
  }

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

  // --- Paired language section ---
  screen.appendChild(
    el('div', { style: 'margin: 20px 0; padding-top: 20px; border-top: 1px solid #ddd;' }, [
      el('h2', { style: 'font-size: 16px; margin: 0 0 12px 0;', text: `Also in ${otherLangLabel}` }),
    ])
  );

  // When the *paired* word is the Dutch one (i.e. this is a Polish word),
  // it needs the same grammar controls as a Dutch main word: the de/het
  // article picker and the "een" correction toggle. Without them the twin
  // used to be saved articleless with an explicit useEen=false.
  let pairedEenSeg = null;
  let pairedEenTouched = false;
  let pairedLabelPreview = null;

  screen.appendChild(
    el('div', { class: 'field' }, [
      el('label', { text: `${otherLangLabel} word` }),
      el('input', {
        type: 'text',
        value: pairedDraft.word,
        placeholder: otherLang === 'pl' ? 'e.g. banan' : 'e.g. banaan',
        oninput: (e) => {
          pairedDraft.word = e.target.value;
          if (pairedEenSeg && !pairedEenTouched) {
            pairedDraft.useEen = guessUsesEen(pairedDraft.word);
            pairedEenSeg.setValue(pairedDraft.useEen ? 'een' : 'none');
          }
          if (pairedLabelPreview) pairedLabelPreview.textContent = wordLabel(pairedDraft) || ' ';
        },
      }),
    ])
  );

  if (otherLang === 'nl') {
    buildSegmented(screen, {
      label: 'Article',
      options: [
        { label: 'de', value: 'de' },
        { label: 'het', value: 'het' },
        { label: '(none)', value: '' },
      ],
      value: pairedDraft.article,
      onChange: (v) => {
        pairedDraft.article = v;
        if (pairedLabelPreview) pairedLabelPreview.textContent = wordLabel(pairedDraft) || ' ';
      },
    });

    // Same auto-guess-until-touched behavior as the main Dutch draft. An
    // existing twin's saved boolean counts as an explicit choice.
    pairedEenTouched = !!(pairedWord && typeof pairedWord.useEen === 'boolean');
    pairedDraft.useEen = usesEen(pairedDraft);
    pairedEenSeg = buildSegmented(screen, {
      label: 'Naming it (“dit is …”)',
      options: [
        { label: 'een …', value: 'een' },
        { label: 'no “een”', value: 'none' },
      ],
      value: pairedDraft.useEen ? 'een' : 'none',
      onChange: (v) => {
        pairedDraft.useEen = v === 'een';
        pairedEenTouched = true;
      },
    });

    pairedLabelPreview = el('div', { class: 'label-preview', text: wordLabel(pairedDraft) || ' ' });
    screen.appendChild(pairedLabelPreview);
  }

  screen.appendChild(
    el('div', { class: 'field' }, [
      el('label', { text: 'Optional short phrase (text)' }),
      el('input', {
        type: 'text',
        value: pairedDraft.phraseText,
        placeholder: otherLang === 'pl' ? 'e.g. To jest banan' : 'e.g. Dit is een banaan',
        oninput: (e) => (pairedDraft.phraseText = e.target.value),
      }),
    ])
  );

  screen.appendChild(
    el('div', { class: 'field' }, [
      el('label', { text: 'Real-world prompt for the parent' }),
      el('input', {
        type: 'text',
        value: pairedDraft.realWorldPrompt,
        placeholder: otherLang === 'pl' ? 'e.g. Daj Papie bananę' : 'e.g. Give Papa de banaan',
        oninput: (e) => (pairedDraft.realWorldPrompt = e.target.value),
      }),
    ])
  );

  buildAudioControl(screen, {
    title: `${otherLangLabel} word audio (say just the word)`,
    maxMs: 6000,
    getBlob: () => pairedDraft.audioWord,
    setBlob: (b) => (pairedDraft.audioWord = b),
    required: false, // Optional initially, can record later
  });

  buildAudioControl(screen, {
    title: `${otherLangLabel} phrase audio (optional)`,
    maxMs: 15000,
    getBlob: () => pairedDraft.audioPhrase,
    setBlob: (b) => (pairedDraft.audioPhrase = b),
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
          alert(`Please enter the ${langLabel} word.`);
          return;
        }
        draft.word = draft.word.trim();
        draft.updatedAt = Date.now();

        // Persist extra photos: new blobs get ids in the photos store; the
        // word carries only the id list.
        for (const entry of extraEntries) {
          if (!entry.id && entry.blob) entry.id = await savePhoto(entry.blob);
        }
        draft.extraPhotoIds = extraEntries.map((e) => e.id).filter(Boolean);

        // Save the main word first — saveWord writes the (possibly new)
        // photoId back onto the draft, so the paired word can share it.
        await saveWord(draft);

        // Extra photos removed in this edit: delete their blobs unless some
        // other word still references them (photoId or extras).
        for (const removedId of originalExtraIds.filter((id) => !draft.extraPhotoIds.includes(id))) {
          const referenced = allWords.some(
            (w) =>
              w.id !== draft.id &&
              (w.photoId === removedId || (w.extraPhotoIds || []).includes(removedId))
          );
          if (!referenced) await remove('photos', removedId).catch(() => {});
        }

        const pairedText = pairedDraft.word.trim();
        if (pairedText) {
          if (!pairedWord) {
            // No photo-linked pair yet. If the other language already has a
            // word with this exact name (e.g. the seeded Polish "chleb"),
            // update that record instead of creating a duplicate.
            const existingByName = allWords.find(
              (w) =>
                (w.language ?? 'nl') === otherLang &&
                (w.word || '').trim().toLowerCase() === pairedText.toLowerCase()
            );
            if (existingByName) {
              pairedDraft = {
                ...existingByName,
                // Blank form fields keep the existing word's values — saving a
                // Polish word with an untouched Dutch section must not wipe
                // the Dutch twin's phrase/prompt.
                phraseText: pairedDraft.phraseText || existingByName.phraseText,
                realWorldPrompt: pairedDraft.realWorldPrompt || existingByName.realWorldPrompt,
                audioWord: pairedDraft.audioWord || existingByName.audioWord,
                audioPhrase: pairedDraft.audioPhrase || existingByName.audioPhrase,
                // Dutch grammar set in this form wins over the old record's
                ...(otherLang === 'nl' ? { article: pairedDraft.article, useEen: pairedDraft.useEen } : {}),
              };
            } else if (category) {
              // Brand-new paired word: put it in the other language's
              // matching category (never this language's).
              const pairedCat = await findOrCreatePairedCategory(category, otherLang);
              pairedDraft.categoryId = pairedCat.id;
            }
          }
          pairedDraft.word = pairedText;
          pairedDraft.language = otherLang;
          // Share the photo — unless the other-language word already has its
          // own photo, which we then leave alone.
          if (!pairedDraft.photoId && !pairedDraft.photo) {
            pairedDraft.photoId = draft.photoId || null;
          }
          pairedDraft.updatedAt = Date.now();
          await saveWord(pairedDraft);
        }
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
          await deleteWordAndCleanup(draft.id);
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

// The carrier clips each language needs (recorded once, stitched before each
// word in the find-it game). Dutch has article-aware prompts and an een/mass
// correction split; Polish uses whole-phrase carriers whose wording works
// with the bare (nominative) word. Shared by the Settings screen (parent's
// own clips, meta store) and the per-person voice recorder (recordings store).
const PHRASE_SPECS = {
  nl: {
    intro:
      'Record these short clips in your own voice. During the find-it game the app plays the matching clip before the word — e.g. “Klik op de” + “banaan”. Trail off naturally, as if the word comes next. Leave them blank to just hear the word on its own.',
    specs: [
      { name: 'clickOnDe', title: 'Prompt for “de” words — say: “Klik op de …”' },
      { name: 'clickOnHet', title: 'Prompt for “het” words — say: “Klik op het …”' },
      { name: 'correctionEen', title: 'Correction for countable words — say: “Nee, dit is een …” (een mandarijn)' },
      { name: 'correction', title: 'Correction for mass words — say: “Nee, dit is …” (brood, melk)' },
      { name: 'goed', title: 'Feedback when she gets it right — say: “Goed zo!” (well done!)' },
    ],
  },
  pl: {
    intro:
      'Record these short clips in your own voice. The app plays them before the word during the find-it game. Choose wording that fits the plain (nominative) word — e.g. “Gdzie jest …?” and “To jest …” — and trail off naturally. Leave them blank to just hear the word on its own.',
    specs: [
      { name: 'prompt', title: 'Prompt — say something like: “Gdzie jest …?” (where is …?)' },
      { name: 'correction', title: 'Correction on a wrong tap — say: “To jest …” (this is …)' },
      { name: 'goed', title: 'Feedback when she gets it right — say: “Świetnie!” (well done!)' },
    ],
  },
};

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
  const lang = settings.language || 'nl';
  const langLabel = (LANGUAGES.find((l) => l.code === lang) || {}).label || '';
  const phrases = await getStandardPhrases(lang);

  // --- People & voices (Stage 6) ---
  // Import of a family member's recording response (the file they send back
  // after recording at home via a ?record= link). Analysis (validate, decode,
  // per-clip playability check) happens before any confirm; nothing is
  // written until the parent approves.
  const importRecordingsInput = el('input', { type: 'file', accept: 'application/json,.json', hidden: '' });
  importRecordingsInput.addEventListener('change', async (e) => {
    const file = e.target.files[0];
    e.target.value = '';
    if (!file) return;
    try {
      let payload;
      try {
        payload = JSON.parse(await file.text());
      } catch {
        throw new Error('That file is not readable — make sure it is the file they sent back.');
      }
      const analysis = await analyzeRecordingResponse(payload);
      if (analysis.unplayable.length > 0) {
        const proceed = confirm(
          `${analysis.unplayable.length} clip${analysis.unplayable.length === 1 ? '' : 's'} can't play on this phone (${analysis.unplayable.join(', ')}) — probably recorded on an Android device in a format iPhones can't play. Import the rest?`
        );
        if (!proceed) return;
      }
      const usable = analysis.wordRows.length + analysis.carrierRows.length;
      if (usable === 0 && !analysis.introAudio && !analysis.personPhoto) {
        alert('Nothing usable in this file — no playable recordings found.');
        return;
      }
      const summaryBits = `${analysis.wordRows.length} word recording${analysis.wordRows.length === 1 ? '' : 's'} and ${analysis.carrierRows.length} game phrase${analysis.carrierRows.length === 1 ? '' : 's'}`;
      const question = analysis.existingPerson
        ? `Add ${summaryBits} to "${analysis.existingPerson.name}"? Existing recordings of the same words are replaced by these.`
        : `Add new person "${analysis.personName}" with ${summaryBits}?`;
      if (!confirm(question)) return;
      const result = await applyRecordingResponse(analysis);
      const skippedNote = analysis.skippedCount
        ? ` ${analysis.skippedCount} recording${analysis.skippedCount === 1 ? ' was' : 's were'} for words you've deleted — skipped.`
        : '';
      alert(`Imported ${result.words} word recordings and ${result.carriers} game phrases for ${result.person.name}.${skippedNote}`);
      render();
    } catch (err) {
      alert(`Import failed: ${errText(err)}`);
    }
  });

  screen.appendChild(
    card('👪 People & voices', [
      el('p', {
        class: 'settings-note',
        text: 'Family members and friends: their photos and voices for child mode — the session intro and the family collage.',
      }),
      el('button', {
        class: 'btn-secondary',
        text: 'Manage people',
        style: 'width:100%;margin-bottom:8px;',
        onclick: () => push({ screen: 'people' }),
      }),
      el('button', {
        class: 'btn-secondary',
        text: '📥 Import family recordings',
        style: 'width:100%;',
        onclick: () => importRecordingsInput.click(),
      }),
      importRecordingsInput,
    ])
  );

  // --- Manage stickers ---
  // Settings is the parent area (reached from the home screen, not child
  // mode), so resetting or pruning here can't be done by Antosia herself.
  const stickersRec = await get('meta', 'stickers').catch(() => null);
  const stickerList = (stickersRec && Array.isArray(stickersRec.value) && stickersRec.value) || [];
  const stickerChildren = [];
  if (stickerList.length === 0) {
    stickerChildren.push(
      el('p', {
        class: 'settings-note',
        text: 'No stickers yet. Antosia earns one each time she finishes a session.',
      })
    );
  } else {
    stickerChildren.push(
      el('p', {
        class: 'settings-note',
        text: `${stickerList.length} sticker${stickerList.length === 1 ? '' : 's'} collected. Tap one to remove it.`,
      })
    );
    const grid = el('div', { class: 'sticker-manage-grid' });
    stickerList.forEach((s, i) => {
      grid.appendChild(
        el('button', {
          type: 'button',
          class: 'sticker-manage-cell',
          text: s.emoji,
          'aria-label': `Remove sticker ${s.emoji}`,
          onclick: async () => {
            if (!confirm(`Remove this ${s.emoji} sticker from Antosia’s book?`)) return;
            const next = stickerList.filter((_, j) => j !== i);
            await put('meta', { key: 'stickers', value: next });
            render();
          },
        })
      );
    });
    stickerChildren.push(grid);
    stickerChildren.push(
      el('button', {
        class: 'btn-danger',
        text: 'Reset all stickers',
        style: 'width:100%;margin-top:12px;',
        onclick: async () => {
          if (!confirm(`Remove all ${stickerList.length} stickers? This can’t be undone.`)) return;
          await put('meta', { key: 'stickers', value: [] });
          render();
        },
      })
    );
  }
  screen.appendChild(card('⭐ Stickers', stickerChildren));

  // --- Translation linking: Release 1 preparation (TWIN_LINK_PLAN.md §6) ---
  // Read-only audit + parent decisions. Writes NO word records and changes no
  // schema — it only records what the later migration should do.
  const auditRec = await get('meta', 'twinAudit').catch(() => null);
  const audit = auditRec && auditRec.value;
  const linkChildren = [
    el('p', {
      class: 'settings-note',
      text: 'Right now a Dutch word and its Polish word are only linked if they share the same picture — so a word without a photo can’t be translated at all. This prepares the fix: it works out which words belong together, and asks you about anything it can’t be sure of.',
    }),
  ];
  // Decisions made by the OLD planner can't be trusted: it didn't check the
  // seed marker, could put one word in two pairs, and silently read an
  // unrecognised language as Dutch. They have to be made again.
  const auditStale = !!(audit && audit.ready && (audit.auditVersion ?? 1) < 2);
  const auditUsable = !!(audit && audit.ready && !auditStale);
  if (auditUsable) {
    linkChildren.push(
      el('p', {
        class: 'settings-line',
        text: `Prepared on ${formatBackupDate(audit.createdAt)} — ${
          (audit.cohortPairs || []).length + (audit.manualPairs || []).length
        } pair(s) confirmed.`,
      })
    );
  } else if (auditStale) {
    linkChildren.push(
      el('p', {
        class: 'settings-note settings-note-warn',
        text: `Your earlier answers (from ${formatBackupDate(
          audit.createdAt
        )}) were worked out by a version that could get some pairs wrong, so they’ve been set aside. Nothing was changed to your words — please go through this once more.`,
      })
    );
  }
  linkChildren.push(
    el('button', {
      class: 'btn-secondary',
      text: auditUsable ? '🔗 Review translation linking' : '🔗 Prepare translation linking',
      style: 'width:100%;',
      onclick: () => push({ screen: 'twinAudit', openedAt: Date.now() }),
    })
  );
  screen.appendChild(card('🔗 Translation linking', linkChildren));

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

  // --- Standard game phrases (recorded once, reused for every word) ---
  const phraseConfig = PHRASE_SPECS[lang] || PHRASE_SPECS.nl;
  const phraseDraft = { ...phrases };
  const phraseBox = el('div', {});
  phraseBox.appendChild(el('p', { class: 'settings-note', text: phraseConfig.intro }));
  for (const spec of phraseConfig.specs) {
    buildAudioControl(phraseBox, {
      title: spec.title,
      maxMs: 5000,
      getBlob: () => phraseDraft[spec.name],
      setBlob: (b) => (phraseDraft[spec.name] = b),
      required: false,
    });
  }
  const savePhrasesBtn = el('button', {
    text: 'Save phrases',
    style: 'margin-top:6px;width:100%;',
    onclick: async (e) => {
      const btn = e.currentTarget;
      btn.disabled = true;
      btn.textContent = 'Saving…';
      try {
        for (const spec of phraseConfig.specs) {
          if (phraseDraft[spec.name]) await saveStandardPhrase(lang, spec.name, phraseDraft[spec.name]);
        }
        alert('Saved. These phrases will play during the find-it game.');
      } catch (err) {
        alert(`Could not save: ${errText(err)}`);
      } finally {
        btn.disabled = false;
        btn.textContent = 'Save phrases';
      }
    },
  });
  phraseBox.appendChild(savePhrasesBtn);
  screen.appendChild(card(`🔊 Standard game phrases${langLabel ? ` — ${langLabel}` : ''}`, [phraseBox]));

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

// --- People & voices (Stage 6) -----------------------------------------------------

async function renderPeople() {
  appEl.appendChild(
    topbar({
      title: 'People & voices',
      onBack: () => pop(),
      onAdd: () => push({ screen: 'personEdit', personId: null }),
    })
  );
  const screen = el('div', { class: 'screen' });
  const [people, allWords, allCategories, allRecordings] = await Promise.all([
    getAll('people'),
    getAll('words'),
    getAll('categories'),
    getAll('recordings'),
  ]);
  const catById = new Map(allCategories.map((c) => [c.id, c]));

  // "Ontbijt 6/10 · Speelgoed 4/4" — how much of each category this person
  // has voiced (counting only words the parent hasn't excluded).
  function coverageLine(p) {
    const recorded = new Set(
      allRecordings
        .filter((r) => r.personId === p.id && r.type === 'word' && r.audioWord)
        .map((r) => r.wordId)
    );
    const perCat = new Map();
    for (const w of allWords) {
      if ((w.language ?? 'nl') !== p.language || w.excluded === true) continue;
      const entry = perCat.get(w.categoryId) || { total: 0, done: 0 };
      entry.total += 1;
      if (recorded.has(w.id)) entry.done += 1;
      perCat.set(w.categoryId, entry);
    }
    return [...perCat]
      .filter(([, e]) => e.done > 0)
      .map(([cid, e]) => `${(catById.get(cid) || {}).name || '?'} ${e.done}/${e.total}`)
      .join(' · ');
  }

  screen.appendChild(
    el('p', {
      class: 'settings-note',
      text:
        'The people Antosia sees and hears in child mode: whose photo opens a session, who appears in each language’s family collage, and whose voice she can pick by tapping a face.',
    })
  );

  for (const l of LANGUAGES) {
    const group = people
      .filter((p) => p.language === l.code)
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    const children = [];

    if (!group.some((p) => p.isDefaultVoice)) {
      children.push(
        el('p', {
          class: 'settings-note settings-note-warn',
          text:
            l.code === 'nl'
              ? 'Add yourself first — your photo and you saying “Nederlands” — and mark yourself as the default voice.'
              : 'Add yourself first — your photo and you saying “Polski” — and mark yourself as the default voice.',
        })
      );
    }

    if (group.length === 0) {
      children.push(el('p', { class: 'settings-note', text: 'No people yet. Tap "+ Add" above.' }));
    } else {
      const list = el('ul', { class: 'list' });
      for (const p of group) {
        const thumb = el('div', { class: 'thumb' });
        if (p.photo) {
          const img = el('img', { alt: '' });
          img.src = URL.createObjectURL(p.photo);
          thumb.appendChild(img);
        } else {
          thumb.textContent = '👤';
        }
        const badges = [];
        if (p.isDefaultVoice) badges.push(el('span', { class: 'badge badge-ok', text: 'Default voice' }));
        if (p.inCollage) badges.push(el('span', { class: 'badge badge-muted', text: 'In collage' }));
        const body = [
          el('div', { class: 'list-item-title', text: p.name || '(unnamed)' }),
          el('div', { class: 'badge-row' }, badges),
        ];
        if (!p.isDefaultVoice) {
          const coverage = coverageLine(p);
          if (coverage) body.push(el('div', { class: 'list-item-sub', text: coverage }));
        }
        list.appendChild(
          el('li', {}, [
            el(
              'button',
              { class: 'list-item', onclick: () => push({ screen: 'personEdit', personId: p.id }) },
              [thumb, el('div', { class: 'list-item-body' }, body)]
            ),
          ])
        );
      }
      children.push(list);
    }
    screen.appendChild(card(`${l.flag} ${l.label}`, children));
  }

  appEl.appendChild(screen);
}

async function renderPersonEdit({ personId }) {
  const isNew = !personId;
  const [existing, settings] = await Promise.all([
    isNew ? null : get('people', personId),
    getSettings(),
  ]);
  if (!isNew && !existing) {
    pop();
    return;
  }

  const now = Date.now();
  const draft = existing
    ? { ...existing }
    : {
        id: newId(),
        name: '',
        language: settings.language || 'nl',
        photo: null,
        introAudio: null,
        inCollage: true,
        isDefaultVoice: false,
        createdAt: now,
        updatedAt: now,
      };

  appEl.appendChild(topbar({ title: isNew ? 'New person' : draft.name || 'Edit person', onBack: () => pop() }));
  const screen = el('div', { class: 'screen' });

  screen.appendChild(
    el('div', { class: 'field' }, [
      el('label', { text: 'Name (what Antosia calls them)' }),
      el('input', {
        type: 'text',
        value: draft.name,
        placeholder: 'e.g. Papa, Oma Els, Ciocia Kasia',
        oninput: (e) => (draft.name = e.target.value),
      }),
    ])
  );

  buildSegmented(screen, {
    label: 'Language they represent',
    options: LANGUAGES.map((l) => ({ label: `${l.flag} ${l.label}`, value: l.code })),
    value: draft.language,
    onChange: (v) => (draft.language = v),
  });

  buildPhotoControl(screen, draft, { showEmoji: false, emptyIcon: '👤' });

  buildAudioControl(screen, {
    title: 'Them saying the language name — “Nederlands” / “Polski” (plays when a session opens)',
    maxMs: 4000,
    getBlob: () => draft.introAudio,
    setBlob: (b) => (draft.introAudio = b),
    required: false,
  });

  buildSegmented(screen, {
    label: 'Show in the family collage',
    options: [
      { label: 'Yes', value: 'yes' },
      { label: 'No', value: 'no' },
    ],
    value: draft.inCollage ? 'yes' : 'no',
    onChange: (v) => (draft.inCollage = v === 'yes'),
  });

  buildSegmented(screen, {
    label: 'Default voice for this language (usually you — the voice on the words themselves)',
    options: [
      { label: 'Yes', value: 'yes' },
      { label: 'No', value: 'no' },
    ],
    value: draft.isDefaultVoice ? 'yes' : 'no',
    onChange: (v) => (draft.isDefaultVoice = v === 'yes'),
  });

  // Voice recorder entry — for saved non-default people (the default voice
  // already speaks through the words' own recordings). E.g. grandma visits
  // and hands you her voice directly, no remote flow needed.
  if (!isNew && !existing.isDefaultVoice) {
    screen.appendChild(
      el('button', {
        class: 'btn-secondary',
        text: `🎙 Record words in ${existing.name}'s voice`,
        style: 'width:100%;margin-bottom:6px;',
        onclick: () => push({ screen: 'personRecord', personId }),
      })
    );
    screen.appendChild(
      el('button', {
        class: 'btn-secondary',
        text: '📋 Create recording request (they record at home)',
        style: 'width:100%;margin-bottom:6px;',
        onclick: () => push({ screen: 'personRequest', personId }),
      })
    );
    screen.appendChild(
      el('p', {
        class: 'hint',
        style: 'margin:0 0 14px;',
        text: 'Words they record become a voice Antosia can choose by tapping their face when a session starts.',
      })
    );
  }

  const actions = el('div', { class: 'form-actions' });
  actions.appendChild(
    el('button', {
      text: 'Save',
      onclick: async () => {
        if (!draft.name.trim()) {
          alert('Please enter a name.');
          return;
        }
        draft.name = draft.name.trim();
        draft.updatedAt = Date.now();
        // savePerson clears the default-voice flag on whoever held it before.
        await savePerson(draft);
        pop();
      },
    })
  );

  if (!isNew) {
    actions.appendChild(
      el('button', {
        class: 'btn-danger',
        text: 'Delete person',
        onclick: async () => {
          if (
            !confirm(
              `Delete "${draft.name}"? Any words and phrases recorded in their voice are deleted too. This can't be undone.`
            )
          )
            return;
          await deletePersonAndCleanup(draft.id);
          pop();
        },
      })
    );
  }

  actions.appendChild(el('button', { class: 'btn-secondary', text: 'Cancel', onclick: () => pop() }));
  screen.appendChild(actions);
  appEl.appendChild(screen);
}

// --- Per-person voice recorder (Stage 6 Phase B §3.4) ---------------------------
// Every completed recording is written to the recordings store immediately
// (crash-safe, no giant in-memory draft); deterministic ids make re-records
// pure overwrites. Excluded ("Skip") words are left out — recording a word
// the parent keeps out of sessions would be wasted breath.

async function renderPersonRecord({ personId }) {
  const person = await get('people', personId);
  if (!person) {
    pop();
    return;
  }
  const lang = person.language;
  const [allCategories, allWords, allRecordings] = await Promise.all([
    getAll('categories'),
    getAll('words'),
    getAll('recordings'),
  ]);
  const recs = allRecordings.filter((r) => r.personId === personId);
  const recordedWordIds = new Set(
    recs.filter((r) => r.type === 'word' && r.audioWord).map((r) => r.wordId)
  );
  const specs = (PHRASE_SPECS[lang] || PHRASE_SPECS.nl).specs;
  const carrierDone = specs.filter((s) =>
    recs.some((r) => r.type === 'carrier' && r.language === lang && r.name === s.name && r.blob)
  ).length;

  appEl.appendChild(topbar({ title: `🎙 ${person.name}`, onBack: () => pop() }));
  const screen = el('div', { class: 'screen' });
  screen.appendChild(
    el('p', {
      class: 'settings-note',
      text: `Pick a category and step through its words — ${person.name} says each one, you record. Every recording saves the moment it's made, so you can stop anytime and continue later.`,
    })
  );

  const list = el('ul', { class: 'list' });
  const categories = allCategories
    .filter((c) => (c.language ?? 'nl') === lang)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  for (const cat of categories) {
    const catWords = allWords.filter((w) => w.categoryId === cat.id && w.excluded !== true);
    if (catWords.length === 0) continue;
    const done = catWords.filter((w) => recordedWordIds.has(w.id)).length;
    list.appendChild(
      el('li', {}, [
        el(
          'button',
          {
            class: 'list-item',
            onclick: () => push({ screen: 'personRecordWords', personId, categoryId: cat.id, index: 0 }),
          },
          [
            el('div', { class: 'thumb', text: cat.emoji || '📁' }),
            el('div', { class: 'list-item-body' }, [
              el('div', { class: 'list-item-title', text: cat.name }),
              el('div', { class: 'list-item-sub', text: `${done} of ${catWords.length} words recorded` }),
            ]),
            el('span', {
              class: `badge ${done === catWords.length ? 'badge-ok' : 'badge-warning'}`,
              text: done === catWords.length ? 'Done' : `${catWords.length - done} to go`,
            }),
          ]
        ),
      ])
    );
  }
  list.appendChild(
    el('li', {}, [
      el(
        'button',
        { class: 'list-item', onclick: () => push({ screen: 'personRecordPhrases', personId }) },
        [
          el('div', { class: 'thumb', text: '🔊' }),
          el('div', { class: 'list-item-body' }, [
            el('div', { class: 'list-item-title', text: 'Game phrases' }),
            el('div', {
              class: 'list-item-sub',
              text: `${carrierDone} of ${specs.length} recorded — "click on…", "well done!" etc.`,
            }),
          ]),
          el('span', {
            class: `badge ${carrierDone === specs.length ? 'badge-ok' : 'badge-warning'}`,
            text: carrierDone === specs.length ? 'Done' : `${specs.length - carrierDone} to go`,
          }),
        ]
      ),
    ])
  );
  screen.appendChild(list);
  appEl.appendChild(screen);
}

async function renderPersonRecordWords(view) {
  const { personId, categoryId } = view;
  const index = view.index ?? 0;
  const [person, category, allWords] = await Promise.all([
    get('people', personId),
    get('categories', categoryId),
    getAll('words'),
  ]);
  const words = allWords.filter((w) => w.categoryId === categoryId && w.excluded !== true);
  if (!person || !category || words.length === 0 || index >= words.length) {
    pop(); // finished the last word (or something was deleted meanwhile)
    return;
  }
  const word = words[index];
  await attachPhotos([word]);
  const label = wordLabel(word);

  const rowId = wordRecordingId(personId, word.id);
  const existing = await get('recordings', rowId);
  const draft = {
    audioWord: existing?.audioWord || null,
    audioPhrase: existing?.audioPhrase || null,
  };
  async function saveRow() {
    try {
      await put('recordings', {
        id: rowId,
        personId,
        type: 'word',
        wordId: word.id,
        audioWord: draft.audioWord,
        audioPhrase: draft.audioPhrase || null,
        updatedAt: Date.now(),
      });
    } catch (err) {
      alert(`Could not save the recording: ${errText(err)}`);
    }
  }

  appEl.appendChild(
    topbar({ title: `${category.emoji} ${index + 1} / ${words.length}`, onBack: () => pop() })
  );
  const screen = el('div', { class: 'screen' });

  const thumb = el('div', { class: 'thumb large', style: 'margin:0 auto 10px;' });
  if (word.photo) {
    const img = el('img', { alt: '' });
    img.src = URL.createObjectURL(word.photo);
    thumb.appendChild(img);
  } else {
    thumb.textContent = word.placeholderEmoji || '🔤';
  }
  screen.appendChild(thumb);
  screen.appendChild(
    el('div', { class: 'label-preview', style: 'text-align:center;margin-bottom:14px;', text: label })
  );

  buildAudioControl(screen, {
    title: `${person.name} says: “${label}”`,
    maxMs: 6000,
    getBlob: () => draft.audioWord,
    setBlob: (b) => {
      draft.audioWord = b;
      saveRow();
    },
    required: false,
  });

  if (word.phraseText) {
    buildAudioControl(screen, {
      title: `Optional phrase — “${word.phraseText}”`,
      maxMs: 15000,
      getBlob: () => draft.audioPhrase,
      setBlob: (b) => {
        draft.audioPhrase = b;
        saveRow();
      },
      required: false,
    });
  }

  // Stepper: mutate this view's index in place and re-render, so Back still
  // pops to the category list in one step no matter how far she got.
  const nav = el('div', { class: 'form-actions' });
  const isLast = index === words.length - 1;
  nav.appendChild(
    el('button', {
      text: isLast ? 'Done' : 'Next word ›',
      onclick: () => {
        if (isLast) {
          pop();
        } else {
          view.index = index + 1;
          render();
        }
      },
    })
  );
  if (index > 0) {
    nav.appendChild(
      el('button', {
        class: 'btn-secondary',
        text: '‹ Previous word',
        onclick: () => {
          view.index = index - 1;
          render();
        },
      })
    );
  }
  screen.appendChild(nav);
  appEl.appendChild(screen);
}

// --- Quick-record wizard ---------------------------------------------------
// Steps through every word still missing its word audio (snapshotted when the
// wizard opened, so recording one doesn't renumber the rest — you can still go
// back and re-listen/re-record). One screen per word: photo, label, record.
// Every recording saves onto the word the moment it's made; stopping halfway
// loses nothing.
async function renderQuickRecord(view) {
  const wordIds = view.wordIds || [];
  const index = view.index ?? 0;
  if (wordIds.length === 0 || index >= wordIds.length) {
    pop(); // finished the last word (or nothing left to record)
    return;
  }
  const word = await get('words', wordIds[index]);
  if (!word) {
    // Deleted since the wizard opened — drop it from the run and re-render
    // at the same index (which is now the next word).
    view.wordIds = wordIds.filter((id) => id !== wordIds[index]);
    if (view.index >= view.wordIds.length) view.index = Math.max(0, view.wordIds.length - 1);
    render();
    return;
  }
  const category = await getCategoryOrNull(word.categoryId);
  await attachPhotos([word]);
  const label = wordLabel(word);

  const draft = {
    audioWord: word.audioWord || null,
    audioPhrase: word.audioPhrase || null,
  };
  async function save() {
    try {
      // Re-fetch so we never overwrite fields changed elsewhere since this
      // screen rendered; only the audio (and updatedAt) comes from the draft.
      const fresh = await get('words', word.id);
      if (!fresh) return;
      await saveWord({
        ...fresh,
        audioWord: draft.audioWord,
        audioPhrase: draft.audioPhrase || null,
        updatedAt: Date.now(),
      });
    } catch (err) {
      alert(`Could not save the recording: ${errText(err)}`);
    }
  }

  appEl.appendChild(
    topbar({ title: `🎙 ${index + 1} / ${wordIds.length}`, onBack: () => pop() })
  );
  const screen = el('div', { class: 'screen' });

  if (category) {
    screen.appendChild(
      el('p', {
        class: 'settings-note',
        style: 'text-align:center;',
        text: `${category.emoji || '📁'} ${category.name}`,
      })
    );
  }

  const thumb = el('div', { class: 'thumb large', style: 'margin:0 auto 10px;' });
  if (word.photo) {
    const img = el('img', { alt: '' });
    img.src = URL.createObjectURL(word.photo);
    thumb.appendChild(img);
  } else {
    thumb.textContent = word.placeholderEmoji || '🔤';
  }
  screen.appendChild(thumb);
  screen.appendChild(
    el('div', { class: 'label-preview', style: 'text-align:center;margin-bottom:14px;', text: label })
  );

  buildAudioControl(screen, {
    title: `Say the word: “${label}”`,
    maxMs: 6000,
    getBlob: () => draft.audioWord,
    setBlob: (b) => {
      draft.audioWord = b;
      save();
    },
    required: true,
  });

  if (word.phraseText) {
    buildAudioControl(screen, {
      title: `Optional phrase — “${word.phraseText}”`,
      maxMs: 15000,
      getBlob: () => draft.audioPhrase,
      setBlob: (b) => {
        draft.audioPhrase = b;
        save();
      },
      required: false,
    });
  }

  // Same stepper pattern as the person recorder: mutate this view's index in
  // place and re-render, so Back pops to the home screen in one step.
  const nav = el('div', { class: 'form-actions' });
  const isLast = index === wordIds.length - 1;
  nav.appendChild(
    el('button', {
      text: isLast ? 'Done' : 'Next word ›',
      onclick: () => {
        if (isLast) {
          pop();
        } else {
          view.index = index + 1;
          render();
        }
      },
    })
  );
  if (index > 0) {
    nav.appendChild(
      el('button', {
        class: 'btn-secondary',
        text: '‹ Previous word',
        onclick: () => {
          view.index = index - 1;
          render();
        },
      })
    );
  }
  screen.appendChild(nav);
  appEl.appendChild(screen);
}

// Create/link the other-language twin for `sourceWord` from a typed
// translation. Mirrors the word editor's paired-word save (admin.js Save
// handler): reuse a same-name word if one exists, else create a new word in
// the paired category, and share the source word's photo so the twins link.
// Audio is intentionally left empty — it then shows up in "Record missing
// audio" for that language, exactly the follow-up the parent wanted.
// --- Translation linking, Release 1: the audit (TWIN_LINK_PLAN.md §6) --------
//
// Non-destructive by design: this screen writes NO word records and does not
// touch the schema. It computes what the migration WOULD do, gets the parent's
// decision on anything that isn't backed by evidence, and stores those decisions
// (by word id, with a dataset signature) for the migration to revalidate later.
async function renderTwinAudit(view) {
  const [allWords, settings, allCategories, seedNl, seedPl] = await Promise.all([
    getAll('words'),
    getSettings(),
    getAll('categories'),
    get('meta', 'seed:nl:v1').catch(() => null),
    get('meta', 'seed:pl:v1').catch(() => null),
  ]);
  await attachPhotos(allWords);
  // The seed markers and categories are read HERE and passed in, so the planner
  // stays pure and synchronous (it has to run inside a versionchange later).
  const plan = buildAuditPlan(allWords, {
    markers: { 'seed:nl:v1': !!seedNl, 'seed:pl:v1': !!seedPl },
    categories: allCategories,
  });
  const byId = new Map(allWords.map((w) => [w.id, w]));

  // Decisions live on the view so a re-render doesn't lose them.
  if (!view.decisions) {
    view.decisions = { cohortConfirmed: false, manualPairs: {} }; // photoId -> {nlId, plId}
  }
  const decisions = view.decisions;

  // The backup must be taken FROM THIS FLOW: a backup from last week doesn't
  // protect the data as it stands right now.
  const backupFresh = (settings.lastBackupAt ?? 0) >= view.openedAt;

  appEl.appendChild(topbar({ title: '🔗 Translation linking', onBack: () => pop() }));
  const screen = el('div', { class: 'screen' });

  screen.appendChild(
    el('p', {
      class: 'settings-note',
      text: 'Nothing is changed on this screen. It only works out which Dutch and Polish words belong together, and saves your answers. The actual change comes in a later update.',
    })
  );

  // --- Step 1: fresh backup -------------------------------------------------
  const backupChildren = [];
  if (backupFresh) {
    backupChildren.push(el('p', { class: 'settings-line', text: '✅ Fresh backup saved.' }));
  } else {
    backupChildren.push(
      el('p', {
        class: 'settings-note',
        text: 'Save a backup now, before anything else. Your recordings and photos exist only on this phone.',
      })
    );
    backupChildren.push(
      el('button', {
        class: 'btn-secondary',
        text: '💾 Save backup',
        style: 'width:100%;',
        onclick: async (e) => {
          const btn = e.currentTarget;
          btn.disabled = true;
          btn.textContent = 'Preparing backup…';
          try {
            const { method, sizeMB } = await exportAndShare({});
            if (method === 'cancelled') return; // nothing left the phone
            await saveSettings({ lastBackupAt: Date.now() });
            if (method === 'download') {
              alert(
                `Backup saved (~${sizeMB} MB). Keep it somewhere safe — Files, iCloud Drive, or AirDrop it to your computer.`
              );
            }
            render();
          } catch (err) {
            alert(`Backup failed: ${errText(err)}`);
          } finally {
            btn.disabled = false;
            btn.textContent = '💾 Save backup';
          }
        },
      })
    );
  }
  screen.appendChild(card('1. Backup first', backupChildren));

  // --- Step 2: what we can work out on our own ------------------------------
  const autoChildren = [
    el('p', {
      class: 'settings-line',
      text: `${plan.photoPairs.length} pair(s) already share a picture — these link automatically.`,
    }),
    el('p', {
      class: 'settings-line',
      text: `${plan.untranslated.length} word(s) have no partner yet — they stay as they are, ready to be translated.`,
    }),
  ];
  if (plan.missingLanguage > 0) {
    autoChildren.push(
      el('p', {
        class: 'settings-note',
        text: `${plan.missingLanguage} older word(s) don’t record which language they are. The update will mark them as Dutch.`,
      })
    );
  }
  // An explicit but unrecognised language is a different thing entirely from a
  // missing one: it can't be guessed, so it's reported and it blocks saving.
  // Silently treating it as Dutch would have let the migration relabel it
  // permanently.
  if (plan.languageIssues.length > 0) {
    autoChildren.push(
      el('p', {
        class: 'settings-note settings-note-warn',
        text: `${plan.languageIssues.length} word(s) have a language this app doesn’t recognise (${plan.languageIssues
          .slice(0, 3)
          .map((i) => `“${i.word || i.id}” = ${JSON.stringify(i.language)}`)
          .join(', ')}${plan.languageIssues.length > 3 ? ', …' : ''}). These need fixing before linking can be saved — nothing here will guess for them.`,
      })
    );
  }
  screen.appendChild(card('2. Worked out automatically', autoChildren));

  // --- Step 3: the starter set (one batch confirmation, never silent) --------
  const cohortChildren = [];
  if (plan.cohort.intact && plan.cohort.pairs.length > 0) {
    cohortChildren.push(
      el('p', {
        class: 'settings-note',
        text: 'Your starter words look untouched, so we can match them up from the original list. Check they look right, then tick the box.',
      })
    );
    const list = el('div', { class: 'twin-pair-list' });
    for (const p of plan.cohort.pairs) {
      list.appendChild(
        el('div', { class: 'twin-pair-row' }, [
          el('span', { text: wordLabel(p.nl) }),
          el('span', { class: 'twin-pair-link', text: '↔' }),
          el('span', { text: wordLabel(p.pl) }),
        ])
      );
    }
    cohortChildren.push(list);
    const checkbox = el('input', { type: 'checkbox' });
    checkbox.checked = decisions.cohortConfirmed;
    checkbox.addEventListener('change', (e) => {
      decisions.cohortConfirmed = e.target.checked;
    });
    const label = el('label', { class: 'twin-confirm' }, [
      checkbox,
      el('span', { text: `Yes — link these ${plan.cohort.pairs.length} starter pairs` }),
    ]);
    cohortChildren.push(label);
  } else {
    cohortChildren.push(
      el('p', {
        class: 'settings-note',
        text: 'Your starter words have been edited since they were added, so we won’t guess at them. You can link any of them yourself later, one at a time.',
      })
    );
  }
  screen.appendChild(card('3. The starter words', cohortChildren));

  // --- Step 4: ambiguous groups (parent decides; leave-separate is default) --
  if (plan.ambiguous.length > 0) {
    const ambChildren = [
      el('p', {
        class: 'settings-note',
        text: 'These words share one picture, so we can’t tell which belongs with which. Pick a pair only if you’re sure — otherwise leave them separate.',
      }),
    ];
    for (const group of plan.ambiguous) {
      const box = el('div', { class: 'twin-ambiguous' });
      const thumb = el('div', { class: 'thumb' });
      const withPhoto = group.words.find((w) => w.photo);
      if (withPhoto) {
        const img = el('img', { alt: '' });
        img.src = URL.createObjectURL(withPhoto.photo);
        thumb.appendChild(img);
      } else {
        thumb.textContent = '🖼';
      }
      box.appendChild(thumb);
      box.appendChild(
        el('div', {
          class: 'settings-note',
          text: `Shared by: ${group.words.map((w) => wordLabel(w)).join(', ')}`,
        })
      );

      const chosen = decisions.manualPairs[group.photoId] || {};
      const makeSelect = (candidates, side, placeholder) => {
        const sel = el('select', { class: 'twin-select' });
        sel.appendChild(el('option', { value: '', text: placeholder }));
        for (const w of candidates) {
          const opt = el('option', { value: w.id, text: wordLabel(w) });
          if (chosen[side] === w.id) opt.selected = true;
          sel.appendChild(opt);
        }
        sel.addEventListener('change', (e) => {
          const current = decisions.manualPairs[group.photoId] || {};
          const next = { ...current, [side]: e.target.value || undefined };
          if (!next.nlId && !next.plId) delete decisions.manualPairs[group.photoId];
          else decisions.manualPairs[group.photoId] = next;
        });
        return sel;
      };
      box.appendChild(makeSelect(group.nl, 'nlId', '(leave separate)'));
      box.appendChild(makeSelect(group.pl, 'plId', '(leave separate)'));
      ambChildren.push(box);
    }
    screen.appendChild(card(`4. Needs your decision (${plan.ambiguous.length})`, ambChildren));
  }

  // --- Step 5: save the decisions -------------------------------------------
  const saveChildren = [];
  if (!backupFresh) {
    saveChildren.push(
      el('p', { class: 'settings-note settings-note-warn', text: 'Save a backup above first.' })
    );
  }
  if (plan.languageIssues.length > 0) {
    saveChildren.push(
      el('p', {
        class: 'settings-note settings-note-warn',
        text: 'Some words have an unrecognised language (see above). Fix those first — saving is blocked until then.',
      })
    );
  }
  const saveBtn = el('button', {
    text: 'Save my answers',
    style: 'width:100%;',
    onclick: async () => {
      // Only keep a manual pair when BOTH sides were picked and it is legal.
      // Validation runs against the COMBINED set: ids already claimed by an
      // automatic or cohort pair, plus every manual pair accepted so far in
      // this loop. Without that, two proposals could share a word and the
      // migration would abort on the unique index.
      const reserved = new Set(plan.reservedIds);
      const manualPairs = [];
      for (const [photoId, choice] of Object.entries(decisions.manualPairs)) {
        if (!choice.nlId || !choice.plId) continue; // half-picked = leave separate
        const nlWord = byId.get(choice.nlId);
        const plWord = byId.get(choice.plId);
        const problem = validateManualPair(nlWord, plWord, reserved);
        if (problem) {
          alert(`That pairing isn’t valid: ${problem}`);
          return;
        }
        reserved.add(nlWord.id);
        reserved.add(plWord.id);
        manualPairs.push([nlWord.id, plWord.id]);
      }
      const cohortPairs =
        decisions.cohortConfirmed && plan.cohort.intact
          ? plan.cohort.pairs.map((p) => [p.nl.id, p.pl.id])
          : [];
      try {
        await put('meta', {
          key: 'twinAudit',
          value: {
            // v2: the planner was repaired (seed-marker evidence, no word in
            // two pairs, no silent language coercion). Decisions saved by the
            // older planner are not trustworthy and must be re-made.
            auditVersion: 2,
            createdAt: Date.now(),
            backupAt: (await getSettings()).lastBackupAt ?? null,
            // The migration must refuse to act on these decisions if the data
            // changed after they were made.
            signature: plan.signature,
            cohortConfirmed: decisions.cohortConfirmed && plan.cohort.intact,
            cohortPairs,
            manualPairs,
            ready: true,
          },
        });
      } catch (err) {
        alert(`Could not save your answers: ${errText(err)}`);
        return;
      }
      alert(
        `Saved. ${cohortPairs.length + manualPairs.length} pair(s) confirmed. The update that actually links them will come next — your words are unchanged for now.`
      );
      pop();
    },
  });
  saveBtn.disabled = !backupFresh || plan.languageIssues.length > 0;
  saveChildren.push(saveBtn);
  screen.appendChild(card('5. Save', saveChildren));

  appEl.appendChild(screen);
}

// A word can legitimately carry no categoryId (damaged or leftover records —
// see backup.js's isUsableWord), and IndexedDB throws DataError on a null key.
// Never hand `get` an empty id.
async function getCategoryOrNull(categoryId) {
  if (!categoryId) return null;
  return (await get('categories', categoryId)) || null;
}

// An other-language word that already carries this exact name, and is NOT
// already this word's photo-linked twin. Two words can share a spelling and
// mean different things, so this is a question for the parent — never a
// silent merge. Returns null when there's nothing to ask about.
function findTranslationConflict(sourceWord, otherLang, text, allWords) {
  const name = (text || '').trim().toLowerCase();
  if (!name) return null;
  return (
    allWords.find(
      (w) =>
        (w.language ?? 'nl') === otherLang &&
        (w.word || '').trim().toLowerCase() === name &&
        !(sourceWord.photoId && w.photoId === sourceWord.photoId)
    ) || null
  );
}

function applyTwinGrammar(twin, otherLang, fields) {
  if (otherLang !== 'nl') return;
  twin.article = fields.article || twin.article || 'de';
  if (fields.useEen != null) twin.useEen = fields.useEen;
}

// A brand-new word for this concept in the other language, sharing the source's
// photo (that shared photoId is the ONLY thing that links twins). Audio is left
// empty on purpose: the word then shows up in that language's "Record missing
// audio" list, which is the parent's next step anyway.
async function createNewTwin(sourceWord, otherLang, fields) {
  const category = await getCategoryOrNull(sourceWord.categoryId);
  const pairedCat = category ? await findOrCreatePairedCategory(category, otherLang) : null;
  const now = Date.now();
  const twin = {
    id: newId(),
    categoryId: pairedCat ? pairedCat.id : sourceWord.categoryId,
    language: otherLang,
    article: otherLang === 'nl' ? fields.article || 'de' : '',
    word: (fields.text || '').trim(),
    photoId: sourceWord.photoId || null,
    placeholderEmoji: sourceWord.placeholderEmoji || '🔤',
    audioWord: null,
    audioPhrase: null,
    phraseText: '',
    realWorldPrompt: '',
    understandingStatus: 'not_introduced',
    speechStatus: 'none',
    useEen: otherLang === 'nl' ? fields.useEen !== false : false,
    excluded: false,
    srsLevel: 0,
    nextReviewDate: null,
    dateIntroduced: null,
    lastPracticed: null,
    timesPracticed: 0,
    createdAt: now,
    updatedAt: now,
  };
  applyTwinGrammar(twin, otherLang, fields);
  await saveWord(twin);
}

// The parent confirmed the existing same-name word is the SAME concept. Adopt
// it as the twin: move it into the paired category and give it the source's
// photo as its primary, which is what actually links the pair. Its own former
// picture is kept as an extra rather than thrown away, and its audio, progress
// and grammar survive untouched.
async function linkExistingAsTwin(sourceWord, otherLang, existingWord, fields) {
  const twin = { ...existingWord };

  // `photo` here can mean two different things:
  //   - a TRUE legacy inline blob (photo, but no photoId) → migrate it to the
  //     photos store and keep it as an extra, so the picture isn't lost;
  //   - just the display blob attachPhotos() loaded from photoId → not legacy,
  //     and re-saving it would duplicate the same image.
  // Either way the blob must be OFF the record before we assign the source's
  // photoId: saveWord() writes an inline `photo` into whatever photoId the
  // record carries, which would overwrite the SOURCE's photo blob.
  if (twin.photo && !twin.photoId) {
    const legacyId = await savePhoto(twin.photo);
    twin.extraPhotoIds = [...new Set([...(twin.extraPhotoIds || []), legacyId])];
  }
  delete twin.photo;

  // Demote its old primary photo to an extra so the picture isn't lost.
  if (sourceWord.photoId && twin.photoId && twin.photoId !== sourceWord.photoId) {
    const extras = new Set(twin.extraPhotoIds || []);
    extras.add(twin.photoId);
    extras.delete(sourceWord.photoId);
    twin.extraPhotoIds = [...extras];
  }
  twin.photoId = sourceWord.photoId || twin.photoId || null;

  const category = await getCategoryOrNull(sourceWord.categoryId);
  const pairedCat = category ? await findOrCreatePairedCategory(category, otherLang) : null;
  if (pairedCat) twin.categoryId = pairedCat.id;

  twin.word = (fields.text || '').trim();
  twin.language = otherLang;
  applyTwinGrammar(twin, otherLang, fields);
  twin.updatedAt = Date.now();
  await saveWord(twin);
}

// Defensive: a photo-linked twin already exists (it shouldn't — that's why the
// word was flagged — but it may have appeared since). Just refresh its text and
// grammar instead of creating a duplicate.
async function updateLinkedTwin(twin, otherLang, fields) {
  const updated = { ...twin, word: (fields.text || '').trim(), language: otherLang, updatedAt: Date.now() };
  applyTwinGrammar(updated, otherLang, fields);
  await saveWord(updated);
}

// "You already have a word called that" — the one question the wizard must ask.
// Shows both records side by side (picture, name, category) and lets the parent
// decide. Nothing is written until they choose.
async function renderTranslationConflict(view, sourceWord, otherLang, advance) {
  const { existingId, fields } = view.conflict;
  const existing = await get('words', existingId);
  if (!existing) {
    // Vanished since we asked — no conflict left; fall back to a plain create.
    view.conflict = null;
    await createNewTwin(sourceWord, otherLang, fields);
    advance();
    return;
  }
  await attachPhotos([existing]);
  const existingCat = await getCategoryOrNull(existing.categoryId);
  const sourceCat = await getCategoryOrNull(sourceWord.categoryId);

  appEl.appendChild(
    topbar({ title: 'Same thing?', onBack: () => { view.conflict = null; render(); } })
  );
  const screen = el('div', { class: 'screen' });

  screen.appendChild(
    el('p', {
      class: 'settings-note',
      text: `You already have a ${(LANGUAGES.find((l) => l.code === otherLang) || {}).label || ''} word called “${(
        fields.text || ''
      ).trim()}”. Is it the same thing as this one, or a different word that just happens to share the name?`,
    })
  );

  const pairRow = el('div', { class: 'conflict-pair' });
  const sideOf = (w, cat, caption) => {
    const box = el('div', { class: 'conflict-side' });
    const thumb = el('div', { class: 'thumb large' });
    if (w.photo) {
      const img = el('img', { alt: '' });
      img.src = URL.createObjectURL(w.photo);
      thumb.appendChild(img);
    } else {
      thumb.textContent = w.placeholderEmoji || '🔤';
    }
    box.appendChild(thumb);
    box.appendChild(el('div', { class: 'label-preview', text: wordLabel(w) }));
    box.appendChild(
      el('div', { class: 'settings-note', text: cat ? `${cat.emoji || '📁'} ${cat.name}` : 'No category' })
    );
    box.appendChild(el('div', { class: 'settings-note', text: caption }));
    return box;
  };
  pairRow.appendChild(sideOf(sourceWord, sourceCat, 'the word you are translating'));
  pairRow.appendChild(sideOf(existing, existingCat, 'the word you already have'));
  screen.appendChild(pairRow);

  const actions = el('div', { class: 'form-actions' });
  actions.appendChild(
    el('button', {
      text: '✅ Same thing — link them',
      onclick: async () => {
        try {
          await linkExistingAsTwin(sourceWord, otherLang, existing, fields);
        } catch (err) {
          alert(`Could not link the words: ${errText(err)}`);
          return;
        }
        advance();
      },
    })
  );
  actions.appendChild(
    el('button', {
      class: 'btn-secondary',
      text: '➕ Different word — keep both',
      onclick: async () => {
        try {
          await createNewTwin(sourceWord, otherLang, fields);
        } catch (err) {
          alert(`Could not save the translation: ${errText(err)}`);
          return;
        }
        advance();
      },
    })
  );
  actions.appendChild(
    el('button', {
      class: 'btn-secondary',
      text: '‹ Change what I typed',
      onclick: () => {
        view.conflict = null;
        render();
      },
    })
  );
  screen.appendChild(actions);

  screen.appendChild(
    el('p', {
      class: 'settings-note',
      text: '“Same thing” moves it into the matching category and gives it this picture (its old picture is kept as an extra). Its recordings and progress stay. “Different word” leaves it completely untouched.',
    })
  );

  appEl.appendChild(screen);
}

// Quick "add missing translations" wizard: one untranslated word per screen,
// type the other-language word (+ de/het for Dutch), reuse the same photo.
async function renderAddTranslations(view) {
  const wordIds = view.wordIds || [];
  const index = view.index ?? 0;
  if (wordIds.length === 0 || index >= wordIds.length) {
    pop();
    return;
  }
  const word = await get('words', wordIds[index]);
  if (!word) {
    // Deleted since the wizard opened — drop it and re-render at this index.
    view.wordIds = wordIds.filter((id) => id !== wordIds[index]);
    if (view.index >= view.wordIds.length) view.index = Math.max(0, view.wordIds.length - 1);
    render();
    return;
  }
  await attachPhotos([word]);
  const category = await getCategoryOrNull(word.categoryId);
  const otherLang = (word.language ?? 'nl') === 'nl' ? 'pl' : 'nl';
  const otherIsDutch = otherLang === 'nl';
  const otherLabel = (LANGUAGES.find((l) => l.code === otherLang) || {}).label || 'Word';

  const isLast = index === wordIds.length - 1;
  const advance = () => {
    view.conflict = null;
    if (isLast) {
      pop();
    } else {
      view.index = index + 1;
      render();
    }
  };

  // The typed translation collided with an existing word — ask the parent
  // rather than guessing (a wrong guess silently merges two concepts, or
  // leaves the pair unlinked forever).
  if (view.conflict && view.conflict.forWordId === word.id) {
    await renderTranslationConflict(view, word, otherLang, advance);
    return;
  }

  const draft = { text: '', article: otherIsDutch ? 'de' : '', useEen: true };

  appEl.appendChild(topbar({ title: `➕ ${index + 1} / ${wordIds.length}`, onBack: () => pop() }));
  const screen = el('div', { class: 'screen' });

  if (category) {
    screen.appendChild(
      el('p', { class: 'settings-note', style: 'text-align:center;', text: `${category.emoji || '📁'} ${category.name}` })
    );
  }

  const thumb = el('div', { class: 'thumb large', style: 'margin:0 auto 10px;' });
  if (word.photo) {
    const img = el('img', { alt: '' });
    img.src = URL.createObjectURL(word.photo);
    thumb.appendChild(img);
  } else {
    thumb.textContent = word.placeholderEmoji || '🔤';
  }
  screen.appendChild(thumb);
  screen.appendChild(
    el('div', { class: 'label-preview', style: 'text-align:center;margin-bottom:14px;', text: wordLabel(word) })
  );

  screen.appendChild(
    el('div', { class: 'field' }, [
      el('label', { text: `${otherLabel} word` }),
      el('input', {
        type: 'text',
        value: '',
        placeholder: otherIsDutch ? 'e.g. banaan' : 'e.g. banan',
        oninput: (e) => (draft.text = e.target.value),
      }),
    ])
  );

  if (otherIsDutch) {
    buildSegmented(screen, {
      label: 'Article',
      options: [
        { label: 'de', value: 'de' },
        { label: 'het', value: 'het' },
        { label: '(none)', value: '' },
      ],
      value: draft.article,
      onChange: (v) => (draft.article = v),
    });
  }

  const nav = el('div', { class: 'form-actions' });
  nav.appendChild(
    el('button', {
      text: isLast ? 'Save & finish' : 'Save & next ›',
      onclick: async () => {
        if (!draft.text.trim()) {
          alert(`Type the ${otherLabel} word, or tap Skip.`);
          return;
        }
        try {
          const allWords = await getAll('words');
          const linked = word.photoId
            ? allWords.find((w) => (w.language ?? 'nl') === otherLang && w.photoId === word.photoId)
            : null;
          if (linked) {
            await updateLinkedTwin(linked, otherLang, draft);
            advance();
            return;
          }
          const clash = findTranslationConflict(word, otherLang, draft.text, allWords);
          if (clash) {
            // Don't guess whether these are the same concept — ask (below).
            view.conflict = { forWordId: word.id, existingId: clash.id, fields: { ...draft } };
            render();
            return;
          }
          await createNewTwin(word, otherLang, draft);
        } catch (err) {
          alert(`Could not save the translation: ${errText(err)}`);
          return;
        }
        advance();
      },
    })
  );
  nav.appendChild(el('button', { class: 'btn-secondary', text: isLast ? 'Skip & finish' : 'Skip ›', onclick: advance }));
  if (index > 0) {
    nav.appendChild(
      el('button', {
        class: 'btn-secondary',
        text: '‹ Previous',
        onclick: () => {
          view.index = index - 1;
          render();
        },
      })
    );
  }
  screen.appendChild(nav);
  appEl.appendChild(screen);
}

async function renderPersonRecordPhrases({ personId }) {
  const person = await get('people', personId);
  if (!person) {
    pop();
    return;
  }
  const lang = person.language;
  const config = PHRASE_SPECS[lang] || PHRASE_SPECS.nl;
  const allRecordings = await getAll('recordings');
  const draft = {};
  for (const spec of config.specs) {
    const row = allRecordings.find(
      (r) => r.id === carrierRecordingId(personId, lang, spec.name)
    );
    draft[spec.name] = (row && row.blob) || null;
  }

  appEl.appendChild(topbar({ title: `🔊 ${person.name}'s game phrases`, onBack: () => pop() }));
  const screen = el('div', { class: 'screen' });
  screen.appendChild(
    el('p', {
      class: 'settings-note',
      text: `${config.intro} These are in ${person.name}'s voice — a phrase they skip just plays the bare word in their sessions.`,
    })
  );
  for (const spec of config.specs) {
    buildAudioControl(screen, {
      title: spec.title,
      maxMs: 5000,
      getBlob: () => draft[spec.name],
      setBlob: async (b) => {
        draft[spec.name] = b;
        try {
          await put('recordings', {
            id: carrierRecordingId(personId, lang, spec.name),
            personId,
            type: 'carrier',
            language: lang,
            name: spec.name,
            blob: b,
            updatedAt: Date.now(),
          });
        } catch (err) {
          alert(`Could not save the recording: ${errText(err)}`);
        }
      },
      required: false,
    });
  }
  appEl.appendChild(screen);
}

// --- Recording requests (Stage 6 Phase C §4.1) -----------------------------------
// What each carrier asks the family member to SAY (in the request's language).
// The `type` picks the localized intonation hint on the recording page
// (prompt = trail off like a little task; correction = kind, unfinished;
// goed = happy and proud).

const REQUEST_CARRIERS = {
  nl: [
    { name: 'clickOnDe', say: 'Klik op de …', type: 'prompt' },
    { name: 'clickOnHet', say: 'Klik op het …', type: 'prompt' },
    { name: 'correctionEen', say: 'Nee, dit is een …', type: 'correction' },
    { name: 'correction', say: 'Nee, dit is …', type: 'correction' },
    { name: 'goed', say: 'Goed zo!', type: 'goed' },
  ],
  pl: [
    { name: 'prompt', say: 'Gdzie jest …?', type: 'prompt' },
    { name: 'correction', say: 'To jest …', type: 'correction' },
    { name: 'goed', say: 'Świetnie!', type: 'goed' },
  ],
};

async function renderPersonRequest({ personId }) {
  const person = await get('people', personId);
  if (!person) {
    pop();
    return;
  }
  const lang = person.language;
  const [allCategories, allWords] = await Promise.all([getAll('categories'), getAll('words')]);
  const categories = allCategories
    .filter((c) => (c.language ?? 'nl') === lang)
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const wordsFor = (catId) => allWords.filter((w) => w.categoryId === catId && w.excluded !== true);

  const state = {
    checked: new Set(categories.filter((c) => wordsFor(c.id).length > 0).map((c) => c.id)),
    includePhrases: true,
    includeIntro: true,
    uiLanguage: lang, // language of the instructions the family member reads
  };

  appEl.appendChild(topbar({ title: `📋 Request for ${person.name}`, onBack: () => pop() }));
  const screen = el('div', { class: 'screen' });
  screen.appendChild(
    el('p', {
      class: 'settings-note',
      text: `Builds a file you publish as a link. ${person.name} opens the link on their own phone, records everything right in the browser (no app install), and sends you back a file to import here.`,
    })
  );

  screen.appendChild(el('div', { class: 'field-label', text: 'Words to ask for' }));
  const catList = el('div', { style: 'margin-bottom:16px;' });
  for (const cat of categories) {
    const count = wordsFor(cat.id).length;
    if (count === 0) continue;
    const btn = el('button', {
      type: 'button',
      class: 'btn-secondary',
      style: 'width:100%;margin-bottom:8px;text-align:left;justify-content:flex-start;',
    });
    const refresh = () => {
      btn.textContent = `${state.checked.has(cat.id) ? '☑' : '☐'} ${cat.emoji} ${cat.name} (${count} word${count === 1 ? '' : 's'})`;
    };
    btn.addEventListener('click', () => {
      if (state.checked.has(cat.id)) state.checked.delete(cat.id);
      else state.checked.add(cat.id);
      refresh();
    });
    refresh();
    catList.appendChild(btn);
  }
  screen.appendChild(catList);

  buildSegmented(screen, {
    label: 'Language of the instructions they read',
    options: LANGUAGES.map((l) => ({ label: `${l.flag} ${l.label}`, value: l.code })),
    value: state.uiLanguage,
    onChange: (v) => (state.uiLanguage = v),
  });

  buildSegmented(screen, {
    label: 'Also ask for the game phrases ("click on…", "well done!")',
    options: [
      { label: 'Yes', value: 'yes' },
      { label: 'No', value: 'no' },
    ],
    value: 'yes',
    onChange: (v) => (state.includePhrases = v === 'yes'),
  });

  buildSegmented(screen, {
    label: `Also ask for the intro ("${lang === 'nl' ? 'Nederlands!' : 'Polski!'}") and a photo`,
    options: [
      { label: 'Yes', value: 'yes' },
      { label: 'No', value: 'no' },
    ],
    value: 'yes',
    onChange: (v) => (state.includeIntro = v === 'yes'),
  });

  screen.appendChild(
    el('button', {
      text: '📤 Create request file',
      style: 'width:100%;margin-top:8px;',
      onclick: async (e) => {
        const words = [...state.checked].flatMap((catId) => wordsFor(catId));
        if (words.length === 0) {
          alert('Pick at least one category with words.');
          return;
        }
        if (
          !confirm(
            'Heads up: the request link is unlisted but not private — anyone who has the exact link can see the word photos in it. Share it only with the person recording. Continue?'
          )
        )
          return;
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.textContent = 'Preparing…';
        try {
          await attachPhotos(words);
          const items = [];
          for (const w of words) {
            let thumb = null;
            if (w.photo) {
              // Small context picture for the reader; keeps a 30-word request
              // comfortably inside the Gist limits.
              thumb = await blobToDataUrl(await downscaleImage(w.photo, 200, 0.6));
            }
            items.push({
              wordId: w.id,
              label: wordLabel(w),
              word: w.word,
              phraseText: w.phraseText || '',
              thumb,
            });
          }
          const payload = {
            formatVersion: 'recording-request-1',
            language: lang,
            uiLanguage: state.uiLanguage,
            appName: "Antosia's app",
            personName: person.name,
            words: items,
            carriers: state.includePhrases ? REQUEST_CARRIERS[lang] || [] : [],
            includeIntro: state.includeIntro,
          };
          const safeName = person.name.replace(/[^\p{L}\p{N}]+/gu, '-').toLowerCase();
          const { method } = await shareJsonFile({
            json: JSON.stringify(payload),
            filename: `antosia-verzoek-${safeName}.json`,
            title: "Antosia's app recording request",
          });
          if (method !== 'cancelled') {
            alert(
              `Request file created. Now:\n\n1. Get the file to your Mac (AirDrop is easiest).\n2. In Terminal: ~/.local/bin/gh gist create <the file>\n3. Send ${person.name} this link on WhatsApp:\nhttps://rm482.github.io/antosias-app/?record=<the gist id from step 2>\n\nWhen the recordings come back as a file, use "Import family recordings" in Settings.`
            );
          }
        } catch (err) {
          alert(`Could not create the request: ${errText(err)}`);
        } finally {
          btn.disabled = false;
          btn.textContent = '📤 Create request file';
        }
      },
    })
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
  if (view.screen === 'people') return renderPeople();
  if (view.screen === 'personEdit') return renderPersonEdit(view);
  if (view.screen === 'quickRecord') return renderQuickRecord(view);
  if (view.screen === 'addTranslations') return renderAddTranslations(view);
  if (view.screen === 'twinAudit') return renderTwinAudit(view);
  if (view.screen === 'personRecord') return renderPersonRecord(view);
  if (view.screen === 'personRecordWords') return renderPersonRecordWords(view);
  if (view.screen === 'personRecordPhrases') return renderPersonRecordPhrases(view);
  if (view.screen === 'personRequest') return renderPersonRequest(view);
}

// Shared "back to the admin home screen" used by both exits from the #session
// overlay: the end of a session (initSession) and the child-mode parent gate.
function returnHome() {
  stack.length = 0;
  stack.push({ screen: 'categories' });
  render();
}

initSession(returnHome);

function showStartupMessage(text) {
  appEl.innerHTML = '';
  appEl.appendChild(el('p', { class: 'empty-state', text }));
}

function errText(err) {
  return (err && err.message) || String(err);
}

(async () => {
  // Contract C5: a family member opening a ?record= link gets the recording
  // page BEFORE any database access — record.js never opens IndexedDB, and
  // no seed/settings/migration code may run first (their browser must stay a
  // blank slate for a possible later first-open of the real app).
  const recordGistId = new URLSearchParams(location.search).get('record');
  if (recordGistId) {
    const { startRecordingPage } = await import('./record.js?v=44');
    startRecordingPage(recordGistId);
    return;
  }
  try {
    const sharedGistId = new URLSearchParams(location.search).get('shared');
    const alreadySeeded = await get('meta', 'seeded');
    const { language } = await getSettings();

    if (!alreadySeeded && sharedGistId) {
      showStartupMessage('Loading shared words… this can take a little while on first open.');
      try {
        await importFromGist(sharedGistId);
        // Mark initialized so we never dump seed words on top of imported data
        // (ensureSeeded's legacy backfill also relies on this flag).
        await put('meta', { key: 'seeded', value: true });
      } catch (err) {
        alert(`Could not load the shared words (${errText(err)}). Showing the example words instead.`);
        await ensureSeeded(language);
      }
    } else {
      await ensureSeeded(language);
    }

    // One-time rename of the seeded Dutch categories to Dutch names (skips any
    // the parent has already renamed themselves).
    await migrateDutchCategoryNames();

    requestPersistentStorage();
    render();
  } catch (err) {
    // Surface startup failures (e.g. storage unavailable in some private
    // browsing modes) as visible text instead of a silent blank page.
    showStartupMessage(`Something went wrong while starting the app: ${errText(err)}`);
  }
})();
