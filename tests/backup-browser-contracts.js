import { deleteWordAndCleanup, ensureSeeded, get, getAll, put, remove } from '../js/db.js?v=46';
import {
  analyzeImportPayload,
  applyImportPayload,
  buildBackupPayload,
  buildSharePayload,
  getBackupVerificationStatus,
  verifyBackupPayload,
} from '../js/backup.js?v=46';

const result = document.getElementById('result');
const payloadOutput = document.getElementById('backup-payload');
const stores = ['categories', 'words', 'photos', 'people', 'recordings', 'meta'];
let assertions = 0;

function assert(condition, message) {
  assertions += 1;
  if (!condition) throw new Error(message);
}

function wavBlob() {
  const sampleRate = 8000;
  const samples = 800;
  const bytes = new ArrayBuffer(44 + samples * 2);
  const view = new DataView(bytes);
  const text = (offset, value) => {
    for (let i = 0; i < value.length; i += 1) view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, 'RIFF');
  view.setUint32(4, 36 + samples * 2, true);
  text(8, 'WAVE');
  text(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true);
  view.setUint16(32, 2, true);
  view.setUint16(34, 16, true);
  text(36, 'data');
  view.setUint32(40, samples * 2, true);
  for (let i = 0; i < samples; i += 1) {
    view.setInt16(44 + i * 2, Math.sin((i / sampleRate) * Math.PI * 440 * 2) * 8000, true);
  }
  return new Blob([bytes], { type: 'audio/wav' });
}

function pngBlob() {
  const binary = atob(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII='
  );
  const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0));
  return new Blob([bytes], { type: 'image/png' });
}

async function clearDatabase() {
  for (const store of stores) {
    for (const row of await getAll(store)) await remove(store, store === 'meta' ? row.key : row.id);
  }
}

function emptySnapshot() {
  return Object.fromEntries(stores.map((store) => [store, []]));
}

async function run() {
  await clearDatabase();
  await put('words', {
    id: 'spike-test-word',
    categoryId: null,
    language: 'nl',
    article: '',
    word: 'spike-test',
  });
  let spikeRefused = false;
  try {
    await buildBackupPayload();
  } catch (error) {
    spikeRefused = /missing an id, text, or category/.test(error.message);
  }
  assert(spikeRefused, 'legacy spike test blocks an incomplete backup');
  await deleteWordAndCleanup('spike-test-word');
  assert(!(await get('words', 'spike-test-word')), 'legacy spike test cleanup is exact');

  const audio = wavBlob();
  const image = pngBlob();

  await put('categories', { id: 'cat-1', name: 'Food', language: 'nl' });
  await put('photos', { id: 'photo-1', blob: image });
  await put('photos', { id: 'photo-2', blob: image });
  await put('photos', { id: 'photo-private', blob: image });
  await put('words', {
    id: 'word-1',
    categoryId: 'cat-1',
    word: 'banana',
    language: 'nl',
    photoId: 'photo-1',
    extraPhotoIds: ['photo-2'],
    audioWord: audio,
  });
  await put('people', {
    id: 'person-1',
    name: 'Test person',
    language: 'nl',
    photo: image,
    introAudio: audio,
  });
  await put('recordings', {
    id: 'person-1:word:word-1',
    personId: 'person-1',
    wordId: 'word-1',
    audioWord: audio,
  });
  await put('meta', { key: 'phrase-goed-zo', value: audio });
  await put('meta', {
    key: 'photoIntake:item:item-1',
    value: {
      id: 'item-1',
      photoId: 'photo-private',
      status: 'deferred',
      wordIds: {},
      draft: { audio: { nl: audio } },
    },
  });
  await put('meta', { key: 'photoIntake', value: { itemIds: ['item-1'], language: 'nl' } });
  await put('meta', { key: 'stickers', value: [{ emoji: '⭐', earnedAt: 1 }] });
  await put('meta', {
    key: 'settings',
    value: { language: 'nl', testOptionCount: 3, lastBackupAt: 123 },
  });
  await put('meta', { key: 'seeded', value: true });
  await put('meta', { key: 'migrate:test', value: true });

  const backup = await buildBackupPayload();
  const share = await buildSharePayload();

  assert(backup.formatVersion === 4 && backup.payloadKind === 'backup', 'private backup version/kind');
  assert(backup.manifest.digest.length === 64, 'private backup has a SHA-256 digest');
  assert(backup.manifest.blobs.length >= 8, 'all nested and top-level media is manifested');
  assert(backup.meta.some((row) => row.key === 'phrase-goed-zo'), 'private backup includes phrases');
  assert(backup.meta.some((row) => row.key === 'photoIntake:item:item-1'), 'private backup includes intake');
  assert(!backup.meta.some((row) => row.key === 'seeded'), 'private backup excludes seed markers');
  assert(!backup.meta.some((row) => row.key === 'migrate:test'), 'private backup excludes migrations');
  const backedUpSettings = backup.meta.find((row) => row.key === 'settings').value;
  assert(!Object.hasOwn(backedUpSettings, 'lastBackupAt'), 'private backup excludes lastBackupAt');

  assert(share.formatVersion === 3 && share.payloadKind === 'share', 'share version/kind');
  assert(!Object.hasOwn(share, 'meta'), 'share contains no private meta');
  assert(share.photos.length === 2, 'share contains only word-referenced photos');
  assert(!share.photos.some((photo) => photo.id === 'photo-private'), 'share excludes intake photo');

  const decoded = await analyzeImportPayload(backup, { existingSnapshot: emptySnapshot() });
  assert(decoded.writes.photos.every((photo) => photo.blob instanceof Blob), 'photos decode to Blobs');
  const phrase = decoded.writes.meta.find((row) => row.key === 'phrase-goed-zo');
  assert(phrase.value instanceof Blob && phrase.value.size > 0, 'phrase media round-trips');
  const intake = decoded.writes.meta.find((row) => row.key === 'photoIntake:item:item-1');
  assert(intake.value.draft.audio.nl instanceof Blob, 'nested intake media round-trips');

  const tampered = structuredClone(backup);
  tampered.words[0].word = 'tampered';
  let tamperRefused = false;
  try {
    await analyzeImportPayload(tampered, { existingSnapshot: emptySnapshot() });
  } catch (error) {
    tamperRefused = /integrity manifest/.test(error.message);
  }
  assert(tamperRefused, 'tampered backup is refused');

  await clearDatabase();
  const restored = await applyImportPayload(decoded);
  assert(restored.words === 1 && restored.photos === 3, 'healthy restore writes the complete set');
  assert((await get('words', 'word-1')).word === 'banana', 'restored word is readable');
  assert((await get('meta', 'phrase-goed-zo')).value instanceof Blob, 'restored phrase is readable');

  await verifyBackupPayload(backup);
  assert((await getBackupVerificationStatus()).verified, 'retained backup verifies against current data');
  await put('words', { ...(await get('words', 'word-1')), word: 'changed after verification' });
  assert(!(await getBackupVerificationStatus()).verified, 'later data change invalidates verification');

  const raceAnalysis = await analyzeImportPayload(backup);
  await put('words', { ...(await get('words', 'word-1')), word: 'late write' });
  const raced = await applyImportPayload(raceAnalysis);
  assert(raced.lateSkipped.some((item) => item.store === 'words' && item.id === 'word-1'), 'late write is skipped');
  assert((await get('words', 'word-1')).word === 'late write', 'late write is not overwritten');

  const finalAnalysis = await analyzeImportPayload(backup);
  await applyImportPayload(finalAnalysis);
  await verifyBackupPayload(backup);
  assert((await getBackupVerificationStatus()).verified, 'final retained fixture matches the database');

  await clearDatabase();
  await ensureSeeded('nl');
  assert((await getAll('words')).length === 13, 'fresh install has the untouched starter set');
  await put('meta', { key: 'future-user-data', value: { keep: true } });
  const unknownMetaRecovery = await analyzeImportPayload(backup, { replacePristineStarter: true });
  assert(!unknownMetaRecovery.replacedStarter, 'unknown meta prevents starter replacement');
  await remove('meta', 'future-user-data');
  const editedStarter = (await getAll('words'))[0];
  await put('words', { ...editedStarter, useEen: false });
  const editedStarterRecovery = await analyzeImportPayload(backup, { replacePristineStarter: true });
  assert(!editedStarterRecovery.replacedStarter, 'an extra seed-word field prevents starter replacement');

  await clearDatabase();
  await ensureSeeded('nl');
  const racedFreshRecovery = await analyzeImportPayload(backup, { replacePristineStarter: true });
  const changedStarter = (await getAll('words'))[0];
  await put('words', { ...changedStarter, word: `${changedStarter.word}-changed` });
  let starterRaceRefused = false;
  try {
    await applyImportPayload(racedFreshRecovery);
  } catch (error) {
    starterRaceRefused = /starter data changed/.test(error.message);
  }
  assert(starterRaceRefused, 'starter replacement aborts if a seed row changes');
  assert(!(await get('words', 'word-1')), 'aborted starter replacement writes nothing');

  await clearDatabase();
  await ensureSeeded('nl');
  const freshRecovery = await analyzeImportPayload(backup, { replacePristineStarter: true });
  assert(freshRecovery.replacedStarter.words === 13, 'restore recognises untouched starter words');
  await applyImportPayload(freshRecovery);
  assert((await getAll('words')).length === 1, 'fresh-install restore removes only the starter words');
  await verifyBackupPayload(backup);
  assert((await getBackupVerificationStatus()).verified, 'fresh-install recovery matches the retained backup');

  payloadOutput.textContent = JSON.stringify(backup);

  result.textContent = `PASS — ${assertions} browser assertions`;
  document.documentElement.dataset.status = 'pass';
}

run().catch((error) => {
  console.error(error);
  result.textContent = `FAIL — ${error.stack || error.message}`;
  document.documentElement.dataset.status = 'fail';
});
