import { ensureSeeded, getAll, remove } from '../js/db.js?v=45';

const result = document.getElementById('result');
const stores = ['categories', 'words', 'photos', 'people', 'recordings', 'meta'];

try {
  for (const store of stores) {
    for (const row of await getAll(store)) await remove(store, store === 'meta' ? row.key : row.id);
  }
  await ensureSeeded('nl');
  const words = await getAll('words');
  if (words.length !== 13) throw new Error(`Expected 13 starter words, found ${words.length}`);
  result.textContent = 'PASS — untouched starter data prepared';
  document.documentElement.dataset.status = 'pass';
} catch (error) {
  console.error(error);
  result.textContent = `FAIL — ${error.stack || error.message}`;
  document.documentElement.dataset.status = 'fail';
}
