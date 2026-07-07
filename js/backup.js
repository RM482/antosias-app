import { getAll, put } from './db.js?v=8';

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

async function dataUrlToBlob(dataUrl) {
  const res = await fetch(dataUrl);
  return res.blob();
}

export async function buildExportPayload() {
  const [categories, words] = await Promise.all([getAll('categories'), getAll('words')]);
  const exportedWords = await Promise.all(
    words.map(async (w) => ({
      ...w,
      photo: w.photo ? await blobToDataUrl(w.photo) : null,
      audioWord: w.audioWord ? await blobToDataUrl(w.audioWord) : null,
      audioPhrase: w.audioPhrase ? await blobToDataUrl(w.audioPhrase) : null,
    }))
  );
  return {
    formatVersion: 1,
    exportedAt: Date.now(),
    categories,
    words: exportedWords,
  };
}

// Tries the native share sheet first (lets you AirDrop/Message/email the
// file directly on iOS); falls back to a plain download if unsupported.
export async function exportAndShare() {
  const payload = await buildExportPayload();
  const json = JSON.stringify(payload);
  const sizeMB = (json.length / 1024 / 1024).toFixed(1);
  const blob = new Blob([json], { type: 'application/json' });
  const file = new File([blob], 'antosias-app-export.json', { type: 'application/json' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: "Antosia's app export" });
      return { method: 'share', sizeMB };
    } catch (err) {
      if (err.name === 'AbortError') return { method: 'cancelled', sizeMB };
      // fall through to the download fallback below
    }
  }

  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'antosias-app-export.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
  return { method: 'download', sizeMB };
}

export async function importPayload(payload) {
  for (const cat of payload.categories || []) {
    await put('categories', cat);
  }
  for (const w of payload.words || []) {
    await put('words', {
      ...w,
      photo: w.photo ? await dataUrlToBlob(w.photo) : null,
      audioWord: w.audioWord ? await dataUrlToBlob(w.audioWord) : null,
      audioPhrase: w.audioPhrase ? await dataUrlToBlob(w.audioPhrase) : null,
    });
  }
}

// Secret Gists are readable by anyone with the exact ID via GitHub's public
// API, with no auth needed — that's what makes an unlisted link work.
export async function importFromGist(gistId) {
  const res = await fetch(`https://api.github.com/gists/${gistId}`);
  if (!res.ok) throw new Error(`Could not load shared data (status ${res.status})`);
  const gist = await res.json();
  const file = Object.values(gist.files || {})[0];
  if (!file) throw new Error('Shared data file not found in that link');

  // The gists API truncates file content over ~1MB; real exports (with
  // photos/audio inlined) easily exceed that, so fetch the raw file instead.
  let text = file.content;
  if (file.truncated || !text) {
    const rawRes = await fetch(file.raw_url);
    if (!rawRes.ok) throw new Error(`Could not load shared data file (status ${rawRes.status})`);
    text = await rawRes.text();
  }

  const payload = JSON.parse(text);
  await importPayload(payload);
}
