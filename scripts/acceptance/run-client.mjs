import console from 'node:console';
import process from 'node:process';
import { readFile } from 'node:fs/promises';
import { run } from './journey.mjs';
const accounts = JSON.parse(await readFile('node_modules/.cache/acceptance/accounts.json', 'utf8'));
try {
  const result = await run({ accounts, origin: 'https://localhost:8443' });
  console.info('ACCEPTANCE_COMPLETE ' + JSON.stringify(result));
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
