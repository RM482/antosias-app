import { ensureSeeded, getAll, put, remove } from '../js/db.js?v=48';

const result = document.getElementById('result');
const stores = ['categories', 'words', 'photos', 'people', 'recordings', 'meta'];

try {
  for (const store of stores) {
    for (const row of await getAll(store)) await remove(store, store === 'meta' ? row.key : row.id);
  }
  await ensureSeeded('nl');
  const withSpike = new URLSearchParams(location.search).has('spike');
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
  const withEmptyIntro = new URLSearchParams(location.search).has('emptyIntro');
  if (withEmptyIntro) {
    await put('people', {
      id: 'person-empty-intro',
      name: 'Oma Test',
      language: 'nl',
      introAudio: new Blob([], { type: 'audio/mp4' }),
      inCollage: true,
      isDefaultVoice: false,
    });
  }
  const words = await getAll('words');
  const expected = withSpike ? 14 : 13;
  if (words.length !== expected) throw new Error(`Expected ${expected} words, found ${words.length}`);
  result.textContent = withSpike
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
