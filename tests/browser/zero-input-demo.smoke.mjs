// Real Edge, synthetic D1, real login and reauth; no credential-bearing artifacts.
import assert from 'node:assert/strict';
import { writeFile, mkdir } from 'node:fs/promises';
import process from 'node:process';
import console from 'node:console';
const { setTimeout, fetch } = globalThis;
let demo,
  stage = 'module';
try {
  const { openAutomaticDemo } = await import('../../scripts/demo/automatic.mjs');
  stage = 'startup';
  demo = await openAutomaticDemo();
  const [owner, a, b] = demo.pages;
  for (const page of demo.pages) {
    await page.getByRole('heading', { name: 'Genel Bakış', exact: true }).waitFor();
    assert.equal(
      await page.evaluate(() => globalThis.localStorage.length + globalThis.sessionStorage.length),
      0,
    );
  }
  assert.equal(new Set(demo.pages.map((p) => p.context())).size, 3);
  stage = 'authority';
  const status = (page, path) =>
    page.evaluate(async (path) => (await globalThis.fetch(path)).status, path);
  assert.equal(await status(owner, '/api/personnel'), 200);
  assert.equal(await status(a, '/api/personnel'), 403);
  assert.equal(await status(b, '/api/personnel'), 403);
  stage = 'personnel-reauth';
  await owner.goto(demo.origin + '/personnel');
  await owner.getByRole('button', { name: 'Personel oluştur', exact: true }).click();
  await owner.getByLabel('Ad soyad').fill('Sentetik Otomatik Demo');
  await owner.getByLabel('Giriş e-postası').fill('automatic-demo@example.invalid');
  await owner.getByRole('button', { name: 'Onayla ve oluştur' }).click();
  const dialog = owner.getByRole('dialog', { name: 'Devam etmek için şifrenizi tekrar girin' });
  await dialog.waitFor();
  await owner.waitForFunction(() => {
    const p = globalThis.document.querySelector('[role="dialog"] input[type="password"]');
    return p && p.value.length >= 32;
  });
  // Autofill must not submit or consume the real server reauth/command.
  await new Promise((resolve) => setTimeout(resolve, 700));
  assert.equal(await dialog.count(), 1);
  assert.equal(
    await demo.db
      .prepare(
        "SELECT count(*) n FROM local_credentials WHERE login_email='automatic-demo@example.invalid'",
      )
      .first('n'),
    0,
  );
  await dialog.getByRole('button', { name: 'Doğrula', exact: true }).click();
  await owner.getByRole('dialog', { name: 'Geçici şifre — yalnız bir kez' }).waitFor();
  assert.equal(
    await demo.db
      .prepare(
        "SELECT count(*) n FROM local_credentials WHERE login_email='automatic-demo@example.invalid'",
      )
      .first('n'),
    1,
  );
  await owner.getByRole('button', { name: 'Güvenli biçimde kapat' }).click();
  stage = 'cleanup';
  const origin = demo.origin;
  for (const page of demo.pages) await page.close();
  await demo.closed;
  let refused = false;
  try {
    await fetch(origin + '/api/health');
  } catch {
    refused = true;
  }
  assert.equal(refused, true);
  await mkdir('node_modules/.cache', { recursive: true });
  await writeFile(
    'node_modules/.cache/zero-input-demo-result.json',
    JSON.stringify({
      status: 'PASS',
      realEdge: true,
      accounts: 3,
      isolatedContexts: 3,
      realFormLogin: true,
      reauthFilledNotSubmitted: true,
      realPersonnelCreate: true,
      closeCleanup: true,
    }),
  );
  console.info(
    'ZERO_INPUT_DEMO_PASS: 3 isolated real Edge logins; reauth autofill without submit; real personnel create; close cleanup.',
  );
} catch (error) {
  console.error('ZERO_INPUT_DEMO_FAIL', stage, error?.name ?? 'Unknown');
  process.exitCode = 1;
} finally {
  await demo?.close();
}
