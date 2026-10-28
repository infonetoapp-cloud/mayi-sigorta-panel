import { mkdir, writeFile } from 'node:fs/promises';
import { openAutomaticDemo } from '../../scripts/demo/automatic.mjs';
import assert from 'node:assert/strict';
import console from 'node:console';
const out = 'catalog-evidence/states';
await mkdir(out, { recursive: true });
const d = await openAutomaticDemo();
try {
  const [o, , member] = d.pages;
  await o.setViewportSize({ width: 1440, height: 1000 });
  await o.goto(d.origin + '/catalogs');
  await o.getByRole('button', { name: 'Yeni kayıt', exact: true }).waitFor();
  await o.getByRole('button', { name: 'Yeni kayıt', exact: true }).click();
  await o.getByLabel('Kod', { exact: true }).fill('V4PREVIEW');
  await o.getByLabel('Ad', { exact: true }).fill('Sentetik Yeni Sigortacı');
  await o.screenshot({ path: out + '/create-1440.png', fullPage: true });
  await o.getByRole('button', { name: 'Vazgeç', exact: true }).click();
  await o.getByRole('button', { name: 'Ayrılmayı onayla', exact: true }).click();
  let release;
  const held = new Promise((r) => (release = r));
  await o.route('**/api/catalogs/insurers', async (route) => {
    await held;
    await route.continue();
  });
  await o.getByRole('button', { name: 'Listeyi yenile', exact: true }).click();
  await o.getByText('Katalog yükleniyor…', { exact: true }).waitFor();
  await o.screenshot({ path: out + '/loading-1440.png', fullPage: true });
  release();
  await o.getByText('Katalog yükleniyor…', { exact: true }).waitFor({ state: 'hidden' });
  await o.unroute('**/api/catalogs/insurers');
  await o.route('**/api/catalogs/insurers', (route) =>
    route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({ success: false, error: { code: 'SERVICE_UNAVAILABLE' } }),
    }),
  );
  await o.getByRole('button', { name: 'Listeyi yenile', exact: true }).click();
  await o.getByRole('alert').waitFor();
  await o.screenshot({ path: out + '/read-error-1440.png', fullPage: true });
  await o.unroute('**/api/catalogs/insurers');
  await o.getByRole('button', { name: 'Yeniden dene', exact: true }).click();
  await o.locator('.catalog-table[aria-busy=false]').waitFor();
  await member.setViewportSize({ width: 390, height: 1000 });
  await member.goto(d.origin + '/catalogs');
  await member.getByText(/Salt okunur/).waitFor();
  assert.equal(await member.getByRole('button', { name: 'Yeni kayıt', exact: true }).count(), 0);
  await member.screenshot({ path: out + '/member-readonly-390.png', fullPage: true });
  await writeFile(
    out + '/results.json',
    JSON.stringify({
      status: 'PASS',
      checks: [
        'CREATE_DRAFT_AND_EXPLICIT_DISCARD',
        'ACTUAL_DELAYED_LOADING',
        'ERROR_EXPLICIT_RETRY',
        'MEMBER_READONLY',
      ],
      screens: 4,
    }),
  );
  console.info('CATALOG_STATES_PASS 4');
} finally {
  await d.close();
}
