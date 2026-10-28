// Real synthetic OWNER onboarding UI -> HTTP -> local D1. Never retain credentials or cookies.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';
import console from 'node:console';
import { chromium } from 'playwright';
import { openOperationalPreview } from '../../scripts/demo/operational-preview.mjs';
let p,
  browser,
  stage = 'setup';
const passed = [];
const evidence = process.env.MAYI_ACCEPTANCE_EVIDENCE_DIR ?? 'personnel-evidence';
async function api(page, path, method = 'GET', body) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const headers = {};
      if (method !== 'GET') {
        const c = await (await globalThis.fetch('/api/auth/csrf-token')).json();
        headers['x-csrf-token'] = c.data?.token;
        headers['content-type'] = 'application/json';
        headers['idempotency-key'] = globalThis.crypto.randomUUID();
      }
      const r = await globalThis.fetch(path, {
        method,
        headers,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const e = await r.json();
      return { status: r.status, data: e.data, code: e.error?.code };
    },
    { path, method, body },
  );
}
function ok(r, status = 200) {
  assert.equal(r.status, status, stage);
  return r.data;
}
async function login(page, email, password, activation = false) {
  await page.goto(p.origin + '/');
  await page.getByLabel('E-posta', { exact: true }).fill(email);
  await page.getByLabel('Şifre', { exact: true }).fill(password);
  const loginResponse = page.waitForResponse(
    (r) => r.url().endsWith('/api/auth/login') && r.request().method() === 'POST',
  );
  await page.getByRole('button', { name: 'Giriş Yap', exact: true }).click();
  const response = await loginResponse;
  if (response.status() === 429) {
    // The native demo now completes this intensive lifecycle inside one real
    // rate-limit window. Honor it in the fixture; never relax the application limiter.
    console.info('PERSONNEL_FIXTURE_RATE_LIMIT_WAIT');
    await page.waitForTimeout(61000);
    // AuthShell deliberately clears credential input on a rejected login.
    await page.getByLabel('E-posta', { exact: true }).fill(email);
    await page.getByLabel('Şifre', { exact: true }).fill(password);
    const retry = page.waitForResponse(
      (r) => r.url().endsWith('/api/auth/login') && r.request().method() === 'POST',
    );
    await page.getByRole('button', { name: 'Giriş Yap', exact: true }).click();
    assert.equal((await retry).status(), 200);
  } else assert.equal(response.status(), 200);
  await page
    .getByRole('heading', {
      name: activation ? 'Yeni şifrenizi belirleyin' : 'Genel Bakış',
      exact: true,
    })
    .waitFor();
}
async function activate(page, temporary, email) {
  await login(page, email, temporary, true);
  assert.equal((await api(page, '/api/customers')).status, 401);
  assert.equal((await api(page, '/api/personnel')).status, 401);
  const password = randomBytes(24).toString('hex');
  await page.getByLabel('Yeni şifre', { exact: true }).fill(password);
  await page.getByLabel('Yeni şifre tekrar', { exact: true }).fill(password);
  await page.getByRole('button', { name: 'Şifreyi kaydet', exact: true }).click();
  await page.getByRole('heading', { name: 'Genel Bakış', exact: true }).waitFor();
  return password;
}
async function temporary(owner) {
  const dialog = owner.getByRole('dialog', { name: 'Geçici şifre — yalnız bir kez', exact: true });
  await dialog.waitFor();
  const value = await dialog.locator('output').textContent();
  assert.equal(typeof value, 'string');
  assert.equal(/^[A-HJ-NP-Z2-9]{5}(?:-[A-HJ-NP-Z2-9]{5}){3}$/.test(value), true);
  await dialog.getByRole('button', { name: 'Güvenli biçimde kapat' }).click();
  assert.equal(await owner.locator('.temporary-secret').count(), 0);
  return value;
}
async function personRow(owner, email) {
  const row = owner.getByRole('row').filter({ has: owner.getByText(email, { exact: true }) });
  await row.waitFor();
  return row;
}
async function command(owner, email, label, edit) {
  const row = await personRow(owner, email);
  if (!(await row.getByRole('button', { name: label, exact: true }).isVisible()))
    await row.locator('summary').click();
  await row.getByRole('button', { name: label, exact: true }).click();
  const critical = owner.getByRole('checkbox', {
    name: 'Kritik işlem etkilerini okudum ve onaylıyorum',
  });
  if (await critical.count()) await critical.check();
  await owner.getByLabel('Gerekçe', { exact: true }).fill('Sentetik personel kabul kontrolü');
  if (edit) await edit();
  const done = owner.waitForResponse(
    (r) => r.url().endsWith('/secure/api/personnel/commands') && r.request().method() === 'POST',
  );
  await owner
    .getByRole('button', {
      name: label === 'İzinleri düzenle' ? 'Kaydet' : 'İşlemi onayla',
      exact: true,
    })
    .click();
  const r = await done;
  return r.status();
}
async function persisted(email) {
  const row = await p.demo.db
    .prepare(
      'SELECT m.id,m.user_id,m.type,m.status,m.version,m.permission_version,c.must_change_password FROM agency_memberships m JOIN local_credentials c ON c.user_id=m.user_id WHERE c.login_email=?',
    )
    .bind(email)
    .first();
  assert(row);
  return row;
}
try {
  await mkdir(evidence, { recursive: true });
  p = await openOperationalPreview();
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === 'win32' ? { channel: 'msedge' } : {}),
  });
  const ownerContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 1440, height: 1000 },
  });
  const employeeContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 768, height: 1000 },
  });
  const otherContext = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width: 360, height: 900 },
  });
  const owner = await ownerContext.newPage(),
    employee = await employeeContext.newPage(),
    other = await otherContext.newPage();
  for (const page of [owner, employee, other]) page.setDefaultTimeout(15000);
  await login(owner, p.users[0].email, p.passwords[0]);
  await owner.goto(p.origin + '/personnel');
  await owner.getByRole('heading', { name: 'Personel ve İzinler', exact: true }).waitFor();
  stage = 'owner-create-reauth';
  await owner.getByRole('button', { name: 'Personel oluştur', exact: true }).click();
  await owner.getByLabel('Başlangıç şablonu').selectOption('yetkili_personel');
  await owner.getByRole('button', { name: 'Vazgeç', exact: true }).click();
  if (await owner.getByRole('button', { name: 'Ayrılmayı onayla', exact: true }).count())
    await owner.getByRole('button', { name: 'Ayrılmayı onayla', exact: true }).click();
  await owner.getByRole('button', { name: 'Personel oluştur', exact: true }).click();
  assert.equal(await owner.getByLabel('Başlangıç şablonu').inputValue(), 'personel');
  await owner.getByLabel('Ad soyad').fill('Sentetik Yeni Çalışan');
  const email = 'onboarding@example.invalid';
  await owner.getByLabel('Giriş e-postası').fill(email);
  assert.equal(await owner.getByLabel('Müşteri Görüntüleme kapsamı').inputValue(), 'AGENCY');
  assert.equal(await owner.getByLabel('Görev Görüntüleme kapsamı').inputValue(), 'ASSIGNED');
  assert.equal(
    await owner.getByRole('checkbox', { name: /^Hassas Kimlik Bilgisi Okuma/ }).isChecked(),
    false,
  );
  await owner.getByRole('button', { name: 'Onayla ve oluştur' }).click();
  const reauth = owner.getByRole('dialog', { name: 'Devam etmek için şifrenizi tekrar girin' });
  await reauth.waitFor();
  assert.equal(
    await p.demo.db
      .prepare('SELECT count(*) n FROM local_credentials WHERE login_email=?')
      .bind(email)
      .first('n'),
    0,
  );
  await reauth.getByLabel('Şifre', { exact: true }).fill(p.passwords[0]);
  await reauth.getByRole('button', { name: 'Doğrula', exact: true }).click();
  let temp = await temporary(owner);
  let person = await persisted(email);
  assert.equal(person.type, 'MEMBER');
  assert.equal(person.must_change_password, 1);
  const initialGrants = (
    await p.demo.db
      .prepare(
        'SELECT permission_code,scope FROM membership_permissions WHERE membership_id=? ORDER BY permission_code',
      )
      .bind(person.id)
      .all()
  ).results;
  assert.equal(initialGrants.find((g) => g.permission_code === 'customer.read').scope, 'AGENCY');
  assert.equal(initialGrants.find((g) => g.permission_code === 'task.read').scope, 'ASSIGNED');
  assert.equal(
    initialGrants.some((g) => g.permission_code.startsWith('sensitive.')),
    false,
  );
  passed.push('OWNER_UI_CREATE_REAUTH_STANDARD_SNAPSHOT_MEMBER_TEMPORARY');
  stage = 'activation-and-private-task';
  let password = await activate(employee, temp, email);
  temp = null;
  assert.equal((await persisted(email)).must_change_password, 0);
  assert.equal((await api(employee, '/api/personnel')).status, 403);
  ok(await api(employee, '/api/auth/reauth', 'POST', { password }));
  assert.equal(
    (
      await api(employee, '/secure/api/personnel/grants', 'POST', {
        kind: 'create',
        name: 'Denied',
        email: 'denied@example.invalid',
        template: 'personel',
        grants: [],
      })
    ).status,
    403,
  );
  await login(other, p.users[2].email, p.passwords[2]);
  assert.equal(
    await employee.getByRole('link', { name: 'Personel ve İzinler', exact: true }).count(),
    0,
  );
  const shared = ok(await api(employee, '/api/customers/demo-customer-0'));
  assert(shared.id);
  assert.equal(ok(await api(employee, '/api/tasks/today?limit=50')).items.length, 0);
  passed.push('FIRST_LOGIN_ACTIVATION_ONLY_PASSWORD_CHANGE_MEMBER_ADMIN_DENIED_SHARED_RECORDS');
  stage = 'owner-assignment';
  const queue = ok(await api(owner, '/api/tasks/today?limit=50'));
  const task = queue.items.find((t) => t.policyId === 'demo-policy-0');
  assert(task);
  const taskPath = `/api/renewals/${task.renewalId}/tasks/${task.taskId}`;
  const directory = ok(await api(owner, `${taskPath}/assignment-options`));
  // Assignment payload follows the existing Task command contract.
  assert(JSON.stringify(directory).includes(person.id));
  ok(
    await api(owner, `${taskPath}/assign`, 'POST', {
      expectedTaskVersion: task.taskVersion,
      expectedRenewalVersion: task.renewalVersion,
      assigneeMembershipId: person.id,
    }),
  );
  assert.equal(
    ok(await api(employee, '/api/tasks/today?limit=50')).items.some(
      (t) => t.taskId === task.taskId,
    ),
    true,
  );
  assert.equal((await api(other, `/api/tasks/${task.taskId}/context`)).status, 404);
  assert.equal((await api(employee, `${taskPath}/assignment-options`)).status, 404);
  passed.push('OWNER_ASSIGN_NEW_EMPLOYEE_SELF_TASK_OTHER_MEMBER_DENIED');
  stage = 'permission-scope-revoke';
  // Keep only customer.read: no hidden dependency repair or automatic expansion.
  const changePermissions = async () => {
    for (const checkbox of await owner.getByRole('checkbox').all())
      if (await checkbox.isChecked()) await checkbox.uncheck();
    await owner.getByRole('checkbox', { name: /^Müşteri Görüntüleme/ }).check();
    await owner.getByLabel('Müşteri Görüntüleme kapsamı').selectOption('ASSIGNED');
  };
  assert.equal(await command(owner, email, 'İzinleri düzenle', changePermissions), 200);
  assert.equal((await api(employee, '/api/customers/demo-customer-0')).status, 401);
  await login(employee, email, password);
  assert.equal((await api(employee, '/api/customers/demo-customer-0')).status, 404);
  assert.equal((await api(employee, '/api/tasks/today?limit=50')).status, 403);
  const narrowed = await persisted(email);
  assert(narrowed.permission_version > person.permission_version);
  assert.equal(
    await command(owner, email, 'İzinleri düzenle', async () => {
      await owner
        .getByRole('button', { name: 'Standart ortak çalışma izinlerini taslağa uygula' })
        .click();
    }),
    200,
  );
  await login(employee, email, password);
  assert.equal((await api(employee, '/api/customers/demo-customer-0')).status, 200);
  assert.equal(
    ok(await api(employee, '/api/tasks/today?limit=50')).items.some(
      (t) => t.taskId === task.taskId,
    ),
    true,
  );
  passed.push('UI_PERMISSION_NARROW_REVOKES_SESSION_SCOPE_DENIAL_EXPLICIT_STANDARD_RESTORE');
  stage = 'suspend-offboarding-retains-work';
  assert.equal(await command(owner, email, 'Askıya al'), 200);
  assert.equal((await persisted(email)).status, 'SUSPENDED');
  assert.equal((await api(employee, '/api/customers/demo-customer-0')).status, 401);
  let work = await p.demo.db
    .prepare('SELECT status,assignee_membership_id FROM tasks WHERE id=?')
    .bind(task.taskId)
    .first();
  assert.equal(work.assignee_membership_id, person.id);
  assert.equal(work.status, 'OPEN');
  const repair = ok(await api(owner, '/api/tasks/today?needsReassignment=true&limit=50'));
  assert(repair.items.some((t) => t.taskId === task.taskId));
  passed.push('SUSPEND_LIVE_SESSION_DENIAL_WORK_PRESERVED_OWNER_REPAIR_QUEUE');
  stage = 'reactivation-forced-change';
  assert.equal(await command(owner, email, 'Yeniden etkinleştir'), 200);
  temp = await temporary(owner);
  password = await activate(employee, temp, email);
  temp = null;
  assert.equal((await persisted(email)).status, 'ACTIVE');
  passed.push('UI_REACTIVATE_NEW_TEMPORARY_FORCED_PASSWORD_CHANGE');
  stage = 'owner-role-promote-demote';
  assert.equal(await command(owner, email, 'Sahip yap'), 200);
  assert.equal((await persisted(email)).type, 'OWNER');
  await login(employee, email, password);
  assert.equal((await api(employee, '/api/personnel')).status, 200);
  assert.equal(await command(owner, email, 'Personel yap'), 200);
  assert.equal((await persisted(email)).type, 'MEMBER');
  assert.equal((await api(employee, '/api/personnel')).status, 401);
  await login(employee, email, password);
  assert.equal((await api(employee, '/api/personnel')).status, 403);
  passed.push('UI_EXPLICIT_OWNER_PROMOTION_DEMOTION_LIVE_AUTHORITY_CHANGE');
  stage = 'offboarding-reset-inactive';
  assert.equal(await command(owner, email, 'Pasifleştir'), 200);
  assert.equal((await persisted(email)).status, 'INACTIVE');
  assert.equal((await api(employee, '/api/tasks/today?limit=50')).status, 401);
  assert.equal(await command(owner, email, 'Şifre sıfırla'), 200);
  temp = await temporary(owner);
  assert.equal((await persisted(email)).status, 'INACTIVE');
  const denied = await employeeContext.request.post(p.origin + '/api/auth/login', {
    headers: { origin: p.origin },
    data: { email, password: temp },
  });
  assert.equal(denied.status(), 401);
  temp = null;
  work = await p.demo.db
    .prepare('SELECT status,assignee_membership_id FROM tasks WHERE id=?')
    .bind(task.taskId)
    .first();
  assert.equal(work.assignee_membership_id, person.id);
  assert.equal(work.status, 'OPEN');
  passed.push('UI_OFFBOARD_REVOKES_SESSION_RESET_DOES_NOT_REACTIVATE_OR_TRANSFER_WORK');
  stage = 'authorized-template-explicit-customization';
  await owner.getByRole('button', { name: 'Personel oluştur', exact: true }).click();
  await owner.getByLabel('Ad soyad').fill('Sentetik Yetkili Personel');
  const authorizedEmail = 'authorized-onboarding@example.invalid';
  await owner.getByLabel('Giriş e-postası').fill(authorizedEmail);
  await owner.getByLabel('Başlangıç şablonu').selectOption('yetkili_personel');
  assert.equal(await owner.getByRole('checkbox', { name: /^Müşteri Arşivleme/ }).isChecked(), true);
  await owner.getByRole('checkbox', { name: /^Müşteri Arşivleme/ }).uncheck();
  await owner.getByRole('button', { name: 'Onayla ve oluştur' }).click();
  temp = await temporary(owner);
  const authorizedPerson = await persisted(authorizedEmail);
  assert.equal(authorizedPerson.type, 'MEMBER');
  const customized = (
    await p.demo.db
      .prepare('SELECT permission_code,scope FROM membership_permissions WHERE membership_id=?')
      .bind(authorizedPerson.id)
      .all()
  ).results;
  assert.equal(
    customized.some((g) => g.permission_code === 'customer.archive'),
    false,
  );
  assert.equal(customized.find((g) => g.permission_code === 'policy.assign').scope, 'AGENCY');
  assert.equal(
    customized.some((g) => g.permission_code.startsWith('sensitive.')),
    false,
  );
  await other.goto(p.origin + '/personnel');
  assert.equal((await api(other, '/api/personnel')).status, 403);
  ok(await api(other, '/api/auth/logout', 'POST', {}));
  await activate(other, temp, authorizedEmail);
  temp = null;
  assert.equal((await api(other, '/api/personnel')).status, 403);
  assert.equal((await api(other, `${taskPath}/assignment-options`)).status, 404);
  passed.push('AUTHORIZED_TEMPLATE_CUSTOMIZED_SNAPSHOT_NOT_OWNER_OR_PRIVATE_TASK_MANAGER');
  stage = 'last-owner-protection';
  assert.equal(await command(owner, p.users[0].email, 'Pasifleştir'), 409);
  const stillOwner = await persisted(p.users[0].email);
  assert.equal(stillOwner.type, 'OWNER');
  assert.equal(stillOwner.status, 'ACTIVE');
  await owner.getByRole('button', { name: 'Vazgeç', exact: true }).click();
  if (await owner.getByRole('button', { name: 'Ayrılmayı onayla', exact: true }).count())
    await owner.getByRole('button', { name: 'Ayrılmayı onayla', exact: true }).click();
  passed.push('LAST_ACTIVE_OWNER_UI_INACTIVATE_DENIED_WITH_STATE_PRESERVED');
  stage = 'explicit-owner-transfer';
  assert.equal(await command(owner, email, 'Yeniden etkinleştir'), 200);
  temp = await temporary(owner);
  password = await activate(employee, temp, email);
  temp = null;
  assert.equal(await command(owner, email, 'Sahipliği devret'), 200);
  assert.equal((await persisted(email)).type, 'OWNER');
  assert.equal((await persisted(p.users[0].email)).type, 'MEMBER');
  assert.equal((await api(owner, '/api/personnel')).status, 401);
  await login(employee, email, password);
  assert.equal((await api(employee, '/api/personnel')).status, 200);
  await login(owner, p.users[0].email, p.passwords[0]);
  assert.equal((await api(owner, '/api/personnel')).status, 403);
  passed.push('UI_EXPLICIT_OWNER_TRANSFER_NEW_OWNER_ACCESS_OLD_OWNER_REVOKED');
  stage = 'integrity-and-secret-custody';
  assert.equal((await p.demo.db.prepare('PRAGMA foreign_key_check').all()).results.length, 0);
  const audits = (
    await p.demo.db
      .prepare(
        "SELECT action FROM audit_events WHERE action LIKE 'personnel.%' AND outcome='SUCCESS'",
      )
      .all()
  ).results;
  for (const kind of [
    'create',
    'permissions',
    'suspend',
    'reactivate',
    'promote',
    'demote',
    'inactivate',
    'reset',
    'transfer',
  ])
    assert(audits.some((a) => a.action === 'personnel.' + kind));
  for (const page of [owner, employee, other])
    assert.equal(
      await page.evaluate(() => globalThis.localStorage.length + globalThis.sessionStorage.length),
      0,
    );
  passed.push('REAL_D1_FK_AUDIT_AND_NO_BROWSER_PERSISTENCE');
  await writeFile(
    evidence + '/browser-results.json',
    JSON.stringify(
      {
        status: 'PASS_LOCAL_ONLY',
        groups: passed,
        groupCount: passed.length,
        productionAccess: false,
        syntheticOnly: true,
      },
      null,
      2,
    ) + '\n',
  );
  console.info('PERSONNEL_BROWSER_PASS ' + JSON.stringify(passed));
} catch (error) {
  // Do not serialize assertion values, response bodies, DOM, screenshots or request headers.
  await mkdir(evidence, { recursive: true });
  const failure = {
    status: 'FAIL',
    stage,
    completed: passed,
    kind: error?.name ?? 'Unknown',
    location:
      String(error?.stack ?? '')
        .split('\n')
        .find((x) => x.includes('personnel-onboarding.smoke.mjs:'))
        ?.trim() ?? null,
  };
  await writeFile(
    evidence + '/failure-' + Date.now() + '.json',
    JSON.stringify(failure, null, 2) + '\n',
  );
  console.error('PERSONNEL_BROWSER_FAIL ' + JSON.stringify(failure));
  process.exitCode = 1;
} finally {
  await browser?.close();
  await p?.close();
}
