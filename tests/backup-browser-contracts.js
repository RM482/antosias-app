import {
  ensureSeeded,
  get,
  getAll,
  put,
  putAllTransactional,
  remove,
  savePerson,
  savePhoto,
  saveRecording,
  saveStandardPhrase,
  saveWord,
} from '../js/db.js?v=50';
import {
  analyzeRecordingResponse,
  analyzeImportPayload,
  applyImportPayload,
  buildBackupPayload,
  buildSharePayload,
  getBackupVerificationStatus,
  inspectBackupHealth,
  repairBackupHealth,
  verifyBackupPayload,
} from '../js/backup.js?v=50';
import { recordAudio } from '../js/media.js?v=50';

const result = document.getElementById('result');
const payloadOutput = document.getElementById('backup-payload');
const stores = ['categories', 'words', 'photos', 'people', 'recordings', 'meta'];
let assertions = 0;

function assert(condition, message) {
  assertions += 1;
  if (!condition) throw new Error(message);
}

async function caughtError(action) {
  try {
    await action();
    return null;
  } catch (error) {
    return error;
  }
}

function dataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
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
  const originalMediaRecorder = window.MediaRecorder;
  const originalGetUserMedia = navigator.mediaDevices.getUserMedia;
  class EmptyMediaRecorder {
    static isTypeSupported() {
      return true;
    }

    constructor(_stream, { mimeType = 'audio/mp4' } = {}) {
      this.mimeType = mimeType;
      this.state = 'inactive';
      this.listeners = {};
    }

    addEventListener(type, listener) {
      (this.listeners[type] ||= []).push(listener);
    }

    start() {
      this.state = 'recording';
    }

    stop() {
      this.state = 'inactive';
      for (const listener of this.listeners.stop || []) listener();
    }
  }
  window.MediaRecorder = EmptyMediaRecorder;
  navigator.mediaDevices.getUserMedia = async () => ({
    active: true,
    getAudioTracks: () => [{ readyState: 'live', muted: false }],
    getTracks: () => [{ stop() {} }],
  });
  const emptyController = await recordAudio({ maxMs: 1000 });
  const emptyResult = emptyController.result.then(
    () => null,
    (error) => error
  );
  emptyController.stop();
  const emptyRecordingError = await emptyResult;
  window.MediaRecorder = originalMediaRecorder;
  navigator.mediaDevices.getUserMedia = originalGetUserMedia;
  assert(
    /No audio was captured/.test(emptyRecordingError?.message || ''),
    'zero-byte microphone result is refused before save'
  );

  const futureBadImage = new Blob([9, 8, 7], { type: 'image/jpeg' });
  const futureEmptyAudio = new Blob([], { type: 'audio/mp4' });
  assert(
    /cannot be opened/.test((await caughtError(() => savePhoto(futureBadImage)))?.message || ''),
    'new undecodable photos are refused before entering the database'
  );
  assert(
    /cannot be opened/.test(
      (
        await caughtError(() =>
          savePerson({
            id: 'future-bad-person',
            name: 'Future bad person',
            language: 'nl',
            photo: futureBadImage,
          })
        )
      )?.message || ''
    ),
    'new undecodable profile photos are refused before save'
  );
  assert(
    /is empty/.test(
      (
        await caughtError(() =>
          saveWord({
            id: 'future-bad-word',
            categoryId: 'unused',
            word: 'future bad word',
            audioWord: futureEmptyAudio,
          })
        )
      )?.message || ''
    ),
    'new empty word recordings are refused before save'
  );
  assert(
    /is empty/.test(
      (
        await caughtError(() =>
          saveRecording({
            id: 'future-bad-recording',
            personId: 'unused',
            audioWord: futureEmptyAudio,
          })
        )
      )?.message || ''
    ),
    'new empty family recordings are refused before save'
  );
  assert(
    /is empty/.test(
      (await caughtError(() => saveStandardPhrase('nl', 'goed', futureEmptyAudio)))?.message || ''
    ),
    'new empty game phrases are refused before save'
  );
  const badFamilyResponse = await analyzeRecordingResponse({
    formatVersion: 'recording-response-1',
    personName: 'Future family member',
    language: 'nl',
    personPhoto: await dataUrl(futureBadImage),
    introAudio: await dataUrl(futureEmptyAudio),
    words: [],
    carriers: [],
  });
  assert(
    badFamilyResponse.personPhoto === null &&
      badFamilyResponse.introAudio === null &&
      badFamilyResponse.unplayable.includes('the profile photo') &&
      badFamilyResponse.unplayable.includes('the intro clip'),
    'family recording import reports and excludes every unusable profile-media field'
  );

  // Reproduce several generations of legacy damage at the same time. The
  // health check must report the whole set before changing anything, then one
  // atomic repair must make a strict backup possible without deleting healthy
  // parent records.
  await clearDatabase();
  await put('categories', { id: 'health-cat', name: 'Health test', language: 'nl' });
  await put('photos', {
    id: 'health-bad-photo',
    blob: new Blob([1, 2, 3], { type: 'image/jpeg' }),
  });
  await put('words', {
    id: 'spike-test-word',
    categoryId: null,
    language: 'nl',
    article: '',
    word: 'spike-test',
  });
  await put('words', {
    id: 'health-word',
    categoryId: 'health-cat',
    language: 'nl',
    word: 'kapot',
    photoId: 'health-bad-photo',
    extraPhotoIds: [123],
    audioWord: new Blob([], { type: 'audio/mp4' }),
    audioPhrase: new Blob([], { type: 'audio/mp4' }),
  });
  await put('people', {
    id: 'health-person',
    name: 'Oma Test',
    language: 'nl',
    photo: new Blob([4, 5, 6], { type: 'image/jpeg' }),
    introAudio: new Blob([], { type: 'audio/mp4' }),
  });
  await put('recordings', {
    id: 'health-person:word:health-word',
    personId: 'health-person',
    wordId: 'health-word',
    type: 'word',
    audioWord: new Blob([], { type: 'audio/mp4' }),
  });
  await put('recordings', {
    id: 'health-person:carrier:nl:goed',
    personId: 'health-person',
    type: 'carrier',
    language: 'nl',
    name: 'goed',
    blob: new Blob([], { type: 'audio/mp4' }),
  });
  await put('meta', {
    key: 'phrase-goed-zo',
    value: new Blob([], { type: 'audio/mp4' }),
  });
  await put('meta', {
    key: 'phrase-clickon-de',
    value: [{ id: 'broken-variant', label: 'Broken', blob: new Blob([], { type: 'audio/mp4' }) }],
  });
  await put('meta', { key: 'stickers', value: { damaged: true } });
  await put('meta', { key: 'twinAudit', value: 'damaged' });
  await put('meta', {
    key: 'photoIntake:item:health-item',
    value: {
      id: 'health-item',
      photoId: 'health-bad-photo',
      status: 'deferred',
      draft: { audio: { nl: new Blob([], { type: 'audio/mp4' }) } },
    },
  });
  await put('meta', {
    key: 'photoIntake',
    value: { itemIds: ['health-item', 'missing-item'], language: 'nl' },
  });

  const healthBefore = await inspectBackupHealth();
  const healthIds = new Set(healthBefore.issues.map((issue) => issue.id));
  assert(healthBefore.issues.length >= 11, 'one health scan reports every simultaneous legacy problem');
  assert(healthIds.has('words:spike-test-word:legacy-test'), 'health scan includes the exact old setup test');
  assert(
    [...healthIds].some((id) => id.startsWith('photos:health-bad-photo:blob:')),
    'health scan includes the shared photo record'
  );
  assert(
    [...healthIds].some((id) => id.startsWith('people:health-person:photo:')),
    'health scan includes the profile photo'
  );
  assert(
    [...healthIds].some((id) => id.startsWith('people:health-person:introAudio:')),
    'health scan includes the person intro'
  );
  assert(
    [...healthIds].some((id) => id.startsWith('recordings:health-person:word:health-word:audioWord:')),
    'health scan includes family word audio'
  );
  assert(healthIds.has('meta:stickers:shape'), 'health scan includes damaged private metadata');

  let aggregateRefused = false;
  try {
    await buildBackupPayload();
  } catch (error) {
    aggregateRefused =
      error.name === 'BackupHealthError' &&
      error.issues.length === healthBefore.issues.length;
  }
  assert(aggregateRefused, 'strict export sends the complete issue list to the health screen');

  await put('categories', {
    ...(await get('categories', 'health-cat')),
    name: 'Changed after the report opened',
  });
  const staleReviewError = await caughtError(() =>
    repairBackupHealth(healthBefore.reviewToken)
  );
  assert(
    /Nothing was repaired/.test(staleReviewError?.message || '') &&
      (await get('words', 'spike-test-word')),
    'a stale on-screen health report cannot repair any data'
  );
  const refreshedHealth = await inspectBackupHealth();
  const healthRepair = await repairBackupHealth(refreshedHealth.reviewToken);
  assert(healthRepair.issues.length === 0, 'one repair pass resolves every reported problem');
  assert(!(await get('words', 'spike-test-word')), 'repair removes only the exact setup-test word');
  const repairedWord = await get('words', 'health-word');
  const repairedPerson = await get('people', 'health-person');
  assert(repairedWord.word === 'kapot', 'repair keeps the affected word');
  assert(
    repairedWord.photoId === null &&
      repairedWord.extraPhotoIds.length === 0 &&
      repairedWord.audioWord === null &&
      repairedWord.audioPhrase === null,
    'repair clears only the word’s unusable media'
  );
  assert(repairedPerson.name === 'Oma Test', 'repair keeps the affected person');
  assert(
    repairedPerson.photo === null && repairedPerson.introAudio === null,
    'repair clears only the person’s unusable photo and intro'
  );
  assert(!(await get('photos', 'health-bad-photo')), 'repair removes the unusable shared photo');
  assert(
    !(await get('meta', 'photoIntake:item:health-item')),
    'repair removes an Inbox item whose only photo is unusable'
  );
  assert(
    (await get('meta', 'photoIntake')).value.itemIds.length === 0,
    'repair normalises the Inbox header after removing damaged items'
  );

  const categoryBeforeRace = await get('categories', 'health-cat');
  const wordBeforeRace = await get('words', 'health-word');
  await put('categories', { ...categoryBeforeRace, name: 'Changed while reviewing' });
  let repairRaceRefused = false;
  try {
    await putAllTransactional(
      {
        categories: [{ ...categoryBeforeRace, name: 'Should not win' }],
        words: [{ ...wordBeforeRace, word: 'Should not be written' }],
      },
      'testing repair race',
      {
        expectedRevs: {
          categories: new Map([['health-cat', categoryBeforeRace.rev]]),
          words: new Map([['health-word', wordBeforeRace.rev]]),
        },
        abortOnMismatch: true,
      }
    );
  } catch (error) {
    repairRaceRefused = /Nothing was repaired/.test(error.message);
  }
  assert(repairRaceRefused, 'repair aborts when reviewed data changes before commit');
  assert(
    (await get('words', 'health-word')).word === 'kapot',
    'a repair race rolls back every other queued change'
  );
  await buildBackupPayload();
  assert(true, 'strict backup succeeds immediately after the single repair');

  await clearDatabase();
  const audio = wavBlob();
  const parameterizedAudio = new Blob([await audio.arrayBuffer()], {
    type: 'audio/wav; codecs=pcm',
  });
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
    // Reproduces the leaked display cache found on the real iPhone in v46.
    // The canonical copy is photos/photo-2 and must remain in the backup.
    extraPhotos: [image],
    audioWord: audio,
  });
  await put('people', {
    id: 'person-1',
    name: 'Test person',
    language: 'nl',
    photo: image,
    // Safari can preserve a codec parameter (including this legal space)
    // in FileReader's data-URL prefix. Verification must accept it and restore
    // the manifest-bound Blob.type exactly.
    introAudio: parameterizedAudio,
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
  assert(!Object.hasOwn(backup.words[0], 'extraPhotos'), 'backup removes leaked display-only extraPhotos');
  const backedUpSettings = backup.meta.find((row) => row.key === 'settings').value;
  assert(!Object.hasOwn(backedUpSettings, 'lastBackupAt'), 'private backup excludes lastBackupAt');

  assert(share.formatVersion === 3 && share.payloadKind === 'share', 'share version/kind');
  assert(!Object.hasOwn(share, 'meta'), 'share contains no private meta');
  assert(!Object.hasOwn(share.words[0], 'extraPhotos'), 'share removes leaked display-only extraPhotos');
  assert(share.photos.length === 2, 'share contains only word-referenced photos');
  assert(!share.photos.some((photo) => photo.id === 'photo-private'), 'share excludes intake photo');

  const decoded = await analyzeImportPayload(backup, { existingSnapshot: emptySnapshot() });
  assert(decoded.writes.photos.every((photo) => photo.blob instanceof Blob), 'photos decode to Blobs');
  const phrase = decoded.writes.meta.find((row) => row.key === 'phrase-goed-zo');
  assert(phrase.value instanceof Blob && phrase.value.size > 0, 'phrase media round-trips');
  assert(
    decoded.writes.people[0].introAudio.type === parameterizedAudio.type,
    'parameterized iPhone audio MIME type round-trips exactly'
  );
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
  await saveWord({ ...(await get('words', 'word-1')), extraPhotos: [image] });
  assert(!Object.hasOwn(await get('words', 'word-1'), 'extraPhotos'), 'saveWord never persists display-only extraPhotos');

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
