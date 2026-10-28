/* global Event */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';
import console from 'node:console';
import { chromium } from 'playwright';
import { openOperationalPreview } from '../../scripts/demo/operational-preview.mjs';
const out = process.env.MAYI_ACCEPTANCE_EVIDENCE_DIR ?? 'final-evidence/policy-recovery';
const report = { checks: [], screens: [] };
let p,
  b,
  stage = 'setup';
const attempts = [];
const click = (page, name) => page.getByRole('button', { name, exact: true }).click();
try {
  await mkdir(out, { recursive: true });
  p = await openOperationalPreview();
  b = await chromium.launch({ channel: 'msedge', headless: true });
  const page = await (
    await b.newContext({ ignoreHTTPSErrors: true, viewport: { width: 1440, height: 1000 } })
  ).newPage();
  page.setDefaultTimeout(20000);
  await page.goto(p.origin);
  await page.getByLabel('E-posta', { exact: true }).fill(p.users[1].email);
  await page.getByLabel('Şifre', { exact: true }).fill(p.passwords[1]);
  await click(page, 'Giriş Yap');
  await page.getByRole('heading', { name: 'Genel Bakış', exact: true }).waitFor();
  await page.goto(p.origin + '/policies/legacy?policyId=demo-policy-0');
  await click(page, 'Poliçeyi Düzenle');
  await page.getByLabel('Brüt Prim', { exact: true }).fill('12.500,50');
  const grant = await p.demo.db
    .prepare(
      "SELECT id,membership_id,scope FROM membership_permissions WHERE membership_id='demo-member-ahmet' AND permission_code='policy.update'",
    )
    .first();
  assert.ok(grant);
  const before = await p.demo.db
    .prepare("SELECT version FROM policies WHERE id='demo-policy-0'")
    .first('version');
  await page.route('**/api/policies/demo-policy-0', async (route) => {
    if (route.request().method() !== 'PATCH') return route.continue();
    attempts.push({
      body: route.request().postData(),
      key: route.request().headers()['idempotency-key'],
    });
    const response = await route.fetch();
    if (attempts.length === 1) {
      assert.equal(response.status(), 200);
      await p.demo.db.prepare('DELETE FROM membership_permissions WHERE id=?').bind(grant.id).run();
      await route.abort('failed');
    } else await route.fulfill({ response });
  });
  stage = 'commit-drop';
  await click(page, 'Değişiklikleri Kaydet');
  await page.getByRole('button', { name: 'Tekrar Dene', exact: true }).waitFor();
  assert.equal(
    await p.demo.db
      .prepare("SELECT gross_premium_minor FROM policies WHERE id='demo-policy-0'")
      .first('gross_premium_minor'),
    1250050,
  );
  assert.equal(await page.getByLabel('Brüt Prim', { exact: true }).isEnabled(), false);
  assert.equal(await page.getByRole('button', { name: 'Kapat', exact: true }).isEnabled(), false);
  await page
    .getByLabel('Brüt Prim', { exact: true })
    .evaluate((el) =>
      el.closest('form').dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })),
    );
  assert.equal(attempts.length, 1);
  await page
    .getByRole('link', { name: 'Seçili poliçeye dön', exact: true })
    .evaluate((a) => a.click());
  assert.ok(page.url().includes('/policies/legacy?policyId=demo-policy-0'));
  stage = 'real-replay-403';
  const denied = page.waitForResponse(
    (r) => r.request().method() === 'PATCH' && r.url().endsWith('/api/policies/demo-policy-0'),
  );
  await click(page, 'Tekrar Dene');
  assert.equal((await denied).status(), 403);
  await page.getByRole('button', { name: 'Tekrar Dene', exact: true }).waitFor();
  assert.deepEqual(attempts[1], attempts[0]);
  assert.equal(await page.getByLabel('Brüt Prim', { exact: true }).isEnabled(), false);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: out + '/denied-replay-frozen-390.png', fullPage: true });
  report.screens.push('denied-replay-frozen-390.png');
  await p.demo.db
    .prepare(
      "INSERT INTO membership_permissions(id,membership_id,permission_code,scope)VALUES(?,?,'policy.update',?)",
    )
    .bind(grant.id, grant.membership_id, grant.scope)
    .run();
  stage = 'authorized-exact-recovery';
  const recovered = page.waitForResponse(
    (r) => r.request().method() === 'PATCH' && r.url().endsWith('/api/policies/demo-policy-0'),
  );
  await click(page, 'Tekrar Dene');
  assert.equal((await recovered).status(), 200);
  await page.getByRole('button', { name: 'Poliçeyi Düzenle', exact: true }).waitFor();
  assert.equal(attempts.length, 3);
  assert.deepEqual(attempts[2], attempts[0]);
  assert.equal(
    await p.demo.db
      .prepare("SELECT version FROM policies WHERE id='demo-policy-0'")
      .first('version'),
    before + 1,
  );
  assert.equal(
    await p.demo.db
      .prepare(
        "SELECT count(*) n FROM audit_events WHERE action='policy.update' AND idempotency_key=?",
      )
      .bind(attempts[0].key)
      .first('n'),
    1,
  );
  assert.equal(
    await p.demo.db
      .prepare(
        "SELECT count(*) n FROM operation_receipts WHERE action='policy.update' AND idempotency_key=?",
      )
      .bind(attempts[0].key)
      .first('n'),
    1,
  );
  await page.screenshot({ path: out + '/exact-recovery-one-effect-390.png', fullPage: true });
  report.screens.push('exact-recovery-one-effect-390.png');
  report.checks.push(
    'REAL_D1_COMMIT_LOST_RESPONSE_LIVE_GRANT_REVOCATION_403_ORIGINAL_ATTEMPT_RESTORED_PERMISSION_EXACT_REPLAY_SINGLE_VERSION_AUDIT_RECEIPT',
    'FIELDS_TARGET_NEW_SUBMIT_ROUTE_LOCKED_UNTIL_RECOVERY',
  );
  report.status = 'PASS';
  console.info(
    JSON.stringify({
      status: report.status,
      checks: report.checks.length,
      attempts: attempts.length,
    }),
  );
} catch (e) {
  report.status = 'FAIL';
  report.failure = { stage, error: String(e) };
  process.exitCode = 1;
  console.error(JSON.stringify(report.failure));
} finally {
  await writeFile(out + '/results.json', JSON.stringify(report, null, 2));
  await b?.close();
  await p?.close();
}
