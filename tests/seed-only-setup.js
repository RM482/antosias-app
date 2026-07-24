import { ensureSeeded, getAll, put, remove } from '../js/db.js?v=50';

const result = document.getElementById('result');
const stores = ['categories', 'words', 'photos', 'people', 'recordings', 'meta'];

try {
  for (const store of stores) {
    for (const row of await getAll(store)) await remove(store, store === 'meta' ? row.key : row.id);
  }
  await ensureSeeded('nl');
  const params = new URLSearchParams(location.search);
  const withHealth = params.has('health');
  const withSpike = params.has('spike') || withHealth;
  if (withSpike) {
    await put('words', {
      id: 'spike-test-word',
      categoryId: null,
      language: 'nl',
      article: '',
      word: 'spike-test',
      photo: null,
      audioWord: null,
    });
  }
  const withEmptyIntro = params.has('emptyIntro') || withHealth;
  if (withEmptyIntro) {
    await put('people', {
      id: 'person-empty-intro',
      name: 'Oma Test',
      language: 'nl',
      photo: withHealth ? new Blob([1, 2, 3], { type: 'image/jpeg' }) : null,
      introAudio: new Blob([], { type: 'audio/mp4' }),
      inCollage: true,
      isDefaultVoice: false,
    });
  }
  if (withHealth) {
    const words = await getAll('words');
    const affectedWord = words.find((word) => word.id !== 'spike-test-word');
    await put('photos', {
      id: 'health-bad-photo',
      blob: new Blob([4, 5, 6], { type: 'image/jpeg' }),
    });
    await put('words', {
      ...affectedWord,
      photoId: 'health-bad-photo',
      audioWord: new Blob([], { type: 'audio/mp4' }),
    });
    await put('meta', {
      key: 'phrase-goed-zo',
      value: new Blob([], { type: 'audio/mp4' }),
    });
  }
  const words = await getAll('words');
  const expected = withSpike ? 14 : 13;
  if (words.length !== expected) throw new Error(`Expected ${expected} words, found ${words.length}`);
  result.textContent = withHealth
    ? 'PASS — multiple simultaneous backup problems prepared'
    : withSpike
    ? 'PASS — untouched starter data plus legacy spike prepared'
    : withEmptyIntro
      ? 'PASS — untouched starter data plus empty intro prepared'
      : 'PASS — untouched starter data prepared';
  document.documentElement.dataset.status = 'pass';
} catch (error) {
  console.error(error);
  result.textContent = `FAIL — ${error.stack || error.message}`;
  document.documentElement.dataset.status = 'fail';
}
