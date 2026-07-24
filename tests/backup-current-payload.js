import { buildBackupPayload } from '../js/backup.js?v=45';

const result = document.getElementById('result');
const payloadOutput = document.getElementById('backup-payload');

try {
  const payload = await buildBackupPayload();
  payloadOutput.textContent = JSON.stringify(payload);
  result.textContent = 'PASS — current backup payload built';
  document.documentElement.dataset.status = 'pass';
} catch (error) {
  console.error(error);
  result.textContent = `FAIL — ${error.stack || error.message}`;
  document.documentElement.dataset.status = 'fail';
}
