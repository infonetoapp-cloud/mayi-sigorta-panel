/* global fetch,document,innerWidth */
import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { openOperationalPreview } from '../../scripts/demo/operational-preview.mjs';
let p,
  b,
  stage = 'setup';
const out = 'personnel-evidence/full-staff-browser';
const checks = [];
async function api(page, path) {
  return page.evaluate(async (path) => {
    const r = await fetch(path);
    const j = await r.json();
    return { status: r.status, data: j.data };
  }, path);
}
try {
  await mkdir(out, { recursive: true });
  p = await openOperationalPreview();
  b = await chromium.launch({ headless: true, channel: 'msedge' });
  const pages = [];
  for (let i = 0; i < 3; i++) {
    const c = await b.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: 1440, height: 1000 },
    });
    const page = await c.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(p.origin);
    await page.getByLabel('E-posta', { exact: true }).fill(p.users[i].email);
    await page.getByLabel('Şifre', { exact: true }).fill(p.passwords[i]);
    await page.getByRole('button', { name: 'Giriş Yap', exact: true }).click();
    await page.getByRole('heading', { name: 'Genel Bakış', exact: true }).waitFor();
    pages.push(page);
  }
  const [o, a, ordinary] = pages;
  stage = 'prepare';
  await o.goto(p.origin + '/personnel');
  const data = await api(o, '/api/personnel');
  const target = data.data.personnel.find((x) => x.id === 'demo-member-ahmet');
  await o
    .getByRole('row')
    .filter({ has: o.getByText(target.login_email, { exact: true }) })
    .getByRole('button', { name: 'İzinleri düzenle', exact: true })
    .click();
  await o.getByRole('button', { name: 'Tam Yetki Ver', exact: true }).click();
  assert.equal(await o.getByLabel('Gerekçe', { exact: true }).inputValue(), '');
  assert.equal(
    await o.getByLabel('Görev Görüntüleme kapsamı', { exact: true }).inputValue(),
    'AGENCY',
  );
  assert.ok(await o.getByText('Tam yetki taslağı', { exact: true }).count());
  assert.equal(
    (await api(o, '/api/personnel')).data.personnel
      .find((x) => x.id === target.id)
      .grants.some((x) => x.permission_code === 'task.team'),
    false,
  );
  for (const width of [1440, 1200, 768, 390]) {
    await o.setViewportSize({ width, height: 1000 });
    assert.ok(await o.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
    await o.screenshot({
      path: out + '/full-draft-' + width + '.png',
      fullPage: true,
      mask: [o.locator('[data-sensitive=true]')],
    });
  }
  checks.push('ONE_CLICK_MAXIMUM_SCOPE_OPTIONAL_REASON_NO_PREMATURE_WRITE_FOUR_WIDTHS');
  await o.setViewportSize({ width: 1440, height: 1000 });
  await o.getByRole('button', { name: 'Kaydet', exact: true }).click();
  const reauth = o.getByRole('dialog', {
    name: 'Devam etmek için şifrenizi tekrar girin',
    exact: true,
  });
  await reauth.waitFor();
  await reauth.getByLabel('Şifre', { exact: true }).fill(p.passwords[0]);
  await reauth.getByRole('button', { name: 'Doğrula', exact: true }).click();
  await o
    .getByText('İşlem sunucu tarafından onaylandı. Güncel personel listesi yenilendi.', {
      exact: true,
    })
    .waitFor();
  const persisted = (await api(o, '/api/personnel')).data.personnel.find((x) => x.id === target.id);
  assert.equal(persisted.type, 'MEMBER');
  assert.equal(persisted.grants.length, 40);
  assert.ok(
    persisted.grants.filter((g) => g.scope !== 'UNSCOPED').every((g) => g.scope === 'AGENCY'),
  );
  checks.push('REAL_SECURE_SAVE_EMPTY_REASON_40_PERSISTED_MAXIMUM_MEMBER_GRANTS');
  stage = 'member-access';
  await a.goto(p.origin + '/');
  await a.getByLabel('E-posta', { exact: true }).fill(p.users[1].email);
  await a.getByLabel('Şifre', { exact: true }).fill(p.passwords[1]);
  await a.getByRole('button', { name: 'Giriş Yap', exact: true }).click();
  await a.getByRole('heading', { name: 'Genel Bakış', exact: true }).waitFor();
  const q = await api(a, '/api/tasks/today?limit=50');
  assert.equal(q.status, 200);
  const task = q.data.items.find((t) => t.assigneeMembershipId === 'demo-member-ayse');
  assert.ok(task);
  assert.equal(q.data.canAssign, true);
  assert.equal(
    (
      await api(
        ordinary,
        '/api/tasks/' +
          q.data.items.find((t) => t.assigneeMembershipId === 'demo-member-ahmet').taskId +
          '/context',
      )
    ).status,
    404,
  );
  assert.equal((await api(a, '/api/personnel')).status, 403);
  await a.goto(p.origin + '/today-work?task=' + task.taskId + '&queue=WORK');
  await a.locator('.today-workspace[data-selected=true]').waitFor();
  await a.getByRole('button', { name: 'Görev işlemleri', exact: true }).click();
  await a.getByRole('button', { name: 'Görev atama seçeneklerini aç', exact: true }).click();
  await a.getByLabel('Yeni görev sorumlusu', { exact: true }).waitFor();
  checks.push(
    'FULL_MEMBER_OTHER_EMPLOYEE_TASK_UI_ASSIGNMENT_OPTIONS_ORDINARY_PRIVATE_OWNER_ONLY_DENIED',
  );
  await a.screenshot({ path: out + '/delegated-task.png', fullPage: true });
  stage = 'reload';
  await o.reload();
  await o.getByText('Tam operasyonel yetki · Çalışan', { exact: true }).waitFor();
  checks.push('RELOAD_AUTHORITATIVE_FULL_STATUS');
  console.info(JSON.stringify({ status: 'PASS', groups: checks.length, screens: 5 }));
  await writeFile(
    out + '/results.json',
    JSON.stringify({ status: 'PASS', checks, screens: 5 }, null, 2),
  );
} catch (error) {
  console.error(
    'FULL_STAFF_BROWSER_FAIL',
    stage,
    error?.name,
    String(error?.stack ?? '')
      .split('\n')
      .filter((x) => x.includes('full-staff.smoke.mjs:'))
      .pop(),
  );
  await writeFile(out + '/failure.json', JSON.stringify({ stage, kind: error?.name, checks }));
  process.exitCode = 1;
} finally {
  await b?.close();
  await p?.close();
}
