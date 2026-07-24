import assert from 'node:assert/strict';

// The contract tests exercise the write-free restore analyser in Node. Media
// decoding itself is covered by the browser recipe; an empty window object
// makes the analyser take media.js's documented no-AudioContext fallback.
globalThis.window = {};

const { analyzeImportPayload } = await import('../js/backup.js?v=48');

const emptySnapshot = () => ({
  categories: [],
  words: [],
  photos: [],
  people: [],
  recordings: [],
  meta: [],
});

const validLegacy = () => ({
  formatVersion: 3,
  exportedAt: 1,
  categories: [{ id: 'cat-1', name: 'Food' }],
  words: [{ id: 'word-1', categoryId: 'cat-1', word: 'banana' }],
  photos: [],
  people: [],
  recordings: [],
});

async function textSha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

function canonicalForTest(value) {
  if (Array.isArray(value)) return value.map(canonicalForTest);
  if (value && typeof value === 'object') {
    if (value.__antosiaBlobV1 === true) {
      return {
        __antosiaBlobV1: true,
        sha256: value.sha256,
        size: value.size,
        type: value.type,
      };
    }
    return Object.fromEntries(
      Object.keys(value)
        .filter((key) => key !== 'rev' && value[key] != null)
        .sort()
        .map((key) => [key, canonicalForTest(value[key])])
    );
  }
  return value;
}

async function signV4(payload, blobs = []) {
  const canonicalDataset = [
    ['categories', payload.categories],
    ['words', payload.words],
    ['photos', payload.photos],
    ['people', payload.people],
    ['recordings', payload.recordings],
    ['meta', payload.meta],
  ];
  payload.manifest = {
    algorithm: 'SHA-256',
    digest: await textSha256(JSON.stringify(canonicalForTest(canonicalDataset))),
    blobs,
  };
  return payload;
}

async function validV4() {
  const payload = {
    formatVersion: 4,
    payloadKind: 'backup',
    exportedAt: 1,
    categories: [{ id: 'cat-1', name: 'Food' }],
    words: [{ categoryId: 'cat-1', id: 'word-1', word: 'banana' }],
    photos: [],
    people: [],
    recordings: [],
    meta: [
      { key: 'settings', value: { language: 'nl', testOptionCount: 3 } },
      { key: 'stickers', value: [] },
    ],
  };
  return signV4(payload);
}

async function validV4WithPhrase() {
  const payload = await validV4();
  const bytes = new Uint8Array([0]);
  const mediaSha = await textSha256(String.fromCharCode(...bytes));
  const tag = {
    __antosiaBlobV1: true,
    data: 'data:audio/webm;base64,AA==',
    sha256: mediaSha,
    size: 1,
    type: 'audio/webm',
  };
  payload.meta = [{ key: 'phrase-goed-zo', value: tag }];
  payload.manifest = undefined;
  await signV4(payload, [
      {
        path: 'meta[0].value',
        sha256: mediaSha,
        size: 1,
        type: 'audio/webm',
      },
    ]);
  return payload;
}

{
  const analysis = await analyzeImportPayload(validLegacy(), { existingSnapshot: emptySnapshot() });
  assert.equal(analysis.writes.categories.length, 1);
  assert.equal(analysis.writes.words.length, 1);
  assert.equal(analysis.restored.length, 2);
}

{
  const duplicate = validLegacy();
  duplicate.words.push({ ...duplicate.words[0] });
  await assert.rejects(
    analyzeImportPayload(duplicate, { existingSnapshot: emptySnapshot() }),
    /same id\/key twice/
  );
}

for (const formatVersion of [1, 2, 3]) {
  const payload = validLegacy();
  payload.formatVersion = formatVersion;
  const analysis = await analyzeImportPayload(payload, { existingSnapshot: emptySnapshot() });
  assert.equal(analysis.writes.words.length, 1);
}

{
  const share = validLegacy();
  share.payloadKind = 'share';
  const analysis = await analyzeImportPayload(share, { existingSnapshot: emptySnapshot() });
  assert.equal(analysis.writes.words.length, 1);
}

for (const [formatVersion, payloadKind] of [
  [4, 'share'],
  [4, undefined],
  [5, 'backup'],
  [5, 'share'],
  [5, undefined],
  [99, undefined],
]) {
  const payload = validLegacy();
  payload.formatVersion = formatVersion;
  if (payloadKind) payload.payloadKind = payloadKind;
  await assert.rejects(
    analyzeImportPayload(payload, { existingSnapshot: emptySnapshot() }),
    /newer version/
  );
}

for (const store of ['categories', 'words', 'photos', 'people', 'recordings']) {
  const payload = validLegacy();
  const row =
    store === 'categories'
      ? { id: 'duplicate', name: 'Duplicate' }
      : store === 'words'
        ? { id: 'duplicate', categoryId: 'cat-1', word: 'duplicate' }
        : store === 'photos'
          ? { id: 'duplicate', blob: 'not reached' }
          : store === 'people'
            ? { id: 'duplicate', name: 'Duplicate' }
            : { id: 'duplicate', personId: 'person-1' };
  payload[store] = [{ ...row }, { ...row }];
  await assert.rejects(
    analyzeImportPayload(payload, { existingSnapshot: emptySnapshot() }),
    new RegExp(`${store} contains the same id/key twice`)
  );
}

{
  const payload = await validV4();
  payload.meta.push({ ...payload.meta[0] });
  await assert.rejects(
    analyzeImportPayload(payload, { existingSnapshot: emptySnapshot() }),
    /meta contains the same id\/key twice/
  );
}

{
  const brokenReference = validLegacy();
  brokenReference.words[0].categoryId = 'missing';
  await assert.rejects(
    analyzeImportPayload(brokenReference, { existingSnapshot: emptySnapshot() }),
    /category that is not present/
  );
}

{
  const partial = validLegacy();
  partial.categories = [];
  const current = emptySnapshot();
  current.categories.push({ id: 'cat-1', name: 'Food', rev: 'cat-rev' });
  const analysis = await analyzeImportPayload(partial, { existingSnapshot: current });
  assert.equal(analysis.writes.words.length, 1);
}

{
  const damagedMedia = validLegacy();
  damagedMedia.words[0].audioWord = 'https://example.com/not-local.mp3';
  await assert.rejects(
    analyzeImportPayload(damagedMedia, { existingSnapshot: emptySnapshot() }),
    /not a local image\/audio data URL/
  );
}

{
  const wrongMediaKind = validLegacy();
  wrongMediaKind.words[0].audioWord =
    'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB';
  await assert.rejects(
    analyzeImportPayload(wrongMediaKind, { existingSnapshot: emptySnapshot() }),
    /not stored as audio/
  );
}

{
  const current = emptySnapshot();
  current.categories.push({ id: 'cat-1', name: 'Food', rev: 'cat-rev' });
  current.words.push({
    id: 'word-1',
    categoryId: 'cat-1',
    word: 'banana',
    audioWord: new Blob([new Uint8Array([0])], { type: 'audio/webm' }),
  });
  const analysis = await analyzeImportPayload(validLegacy(), { existingSnapshot: current });
  assert.equal(analysis.protectedLegacy.length, 1);
  assert.equal(analysis.writes.words.length, 0);
}

{
  const payload = await validV4();
  const analysis = await analyzeImportPayload(payload, { existingSnapshot: emptySnapshot() });
  assert.equal(analysis.writes.meta.length, 2);
  assert.equal(analysis.writes.meta.find((row) => row.key === 'settings').value.lastBackupAt, undefined);
}

{
  const tampered = await validV4();
  tampered.words[0].word = 'changed after export';
  await assert.rejects(
    analyzeImportPayload(tampered, { existingSnapshot: emptySnapshot() }),
    /does not match its integrity manifest/
  );
}

{
  const privateShare = validLegacy();
  privateShare.payloadKind = 'share';
  privateShare.meta = [{ key: 'settings', value: {} }];
  await assert.rejects(
    analyzeImportPayload(privateShare, { existingSnapshot: emptySnapshot() }),
    /contains private backup data/
  );
}

{
  const nestedMedia = await validV4WithPhrase();
  const analysis = await analyzeImportPayload(nestedMedia, { existingSnapshot: emptySnapshot() });
  const phrase = analysis.writes.meta.find((row) => row.key === 'phrase-goed-zo');
  assert.ok(phrase.value instanceof Blob);
  assert.equal(phrase.value.size, 1);
}

{
  const payload = validLegacy();
  payload.words[0].audioWord = 'data:audio/webm;base64,AA==';
  const current = emptySnapshot();
  current.categories.push({ id: 'cat-1', name: 'Food', rev: 'cat-rev' });
  current.words.push({
    id: 'word-1',
    categoryId: 'cat-1',
    word: 'banana',
    audioWord: new Blob([new Uint8Array([1])], { type: 'audio/webm' }),
    rev: 'word-rev',
  });
  const analysis = await analyzeImportPayload(payload, { existingSnapshot: current });
  assert.equal(analysis.conflicts.length, 1);
  assert.equal(analysis.expectedRevs.words.get('word-1'), 'word-rev');
}

{
  const payload = await validV4();
  const current = emptySnapshot();
  current.meta.push(
    {
      key: 'settings',
      value: { language: 'pl', testOptionCount: 2, lastBackupAt: 99 },
      rev: 'settings-rev',
    },
    {
      key: 'stickers',
      value: [{ emoji: '⭐', earnedAt: 1 }],
      rev: 'stickers-rev',
    }
  );
  const analysis = await analyzeImportPayload(payload, { existingSnapshot: current });
  const settings = analysis.writes.meta.find((row) => row.key === 'settings').value;
  const stickers = analysis.writes.meta.find((row) => row.key === 'stickers').value;
  assert.deepEqual(settings, { language: 'nl', testOptionCount: 3, lastBackupAt: 99 });
  assert.deepEqual(stickers, [{ emoji: '⭐', earnedAt: 1 }]);
}

console.log('backup contract tests passed');
