// Combined three-slice acceptance: genuine isolated logins, HTTP APIs and disposable synthetic D1.
/* global document, fetch, crypto, history */
import assert from 'node:assert/strict';
import console from 'node:console';
import process from 'node:process';
import { URL } from 'node:url';
import { mkdir, writeFile } from 'node:fs/promises';
import { openAutomaticDemo } from '../../scripts/demo/automatic.mjs';
const out = 'v4-checkpoint-evidence';
let demo,
  stage = 'setup';
const report = { mode: 'REAL_EDGE_AUTHENTICATED_LOCAL_D1', checks: [], errors: [], external: [] };
async function api(page, path, method = 'GET', body) {
  return page.evaluate(
    async ({ path, method, body }) => {
      const headers = {};
      if (method !== 'GET') {
        const csrf = await (await fetch('/api/csrf-token')).json();
        headers['content-type'] = 'application/json';
        headers['x-csrf-token'] = csrf.data.token;
        headers['idempotency-key'] = crypto.randomUUID();
      }
      const r = await fetch(path, {
        method,
        headers,
        cache: 'no-store',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const e = await r.json();
      return { status: r.status, data: e.data };
    },
    { path, method, body },
  );
}
function ok(r, status = 200) {
  assert.equal(r.status, status, stage);
  return r.data;
}
async function button(p, name) {
  await p.getByRole('button', { name, exact: true }).click();
}
async function openSection(p, name) {
  const b = p.getByRole('button', { name, exact: true });
  if ((await b.getAttribute('aria-expanded')) === 'false') await b.click();
}
async function selectTask(p, t) {
  await p.goto(demo.origin + `/today-work?task=${encodeURIComponent(t.taskId)}&queue=WORK`);
  await p.locator('.today-workspace[data-selected=true]').waitFor();
  assert.ok(
    (await p.getByRole('region', { name: 'Seçili görev özeti', exact: true }).innerText()).includes(
      t.policyNumber,
    ),
  );
}
async function checkpoint(name) {
  report.checks.push(name);
  await writeFile(out + '/combined-browser.json', JSON.stringify(report, null, 2));
}
try {
  await mkdir(out, { recursive: true });
  demo = await openAutomaticDemo();
  const [owner, a, b] = demo.pages;
  for (const [i, p] of demo.pages.entries()) {
    p.setDefaultTimeout(20000);
    await p.setViewportSize({ width: [1440, 768, 390][i], height: i === 2 ? 844 : 1000 });
    p.on('pageerror', () => report.errors.push('runtime'));
    p.on('console', (m) => {
      if (m.type() === 'error' && /Content Security Policy|Refused to/.test(m.text()))
        report.errors.push('csp');
    });
    p.on('request', (r) => {
      if (new URL(r.url()).origin !== demo.origin) report.external.push(new URL(r.url()).origin);
    });
  }
  const tasks = [];
  stage = 'three-actor-linked-navigation';
  for (const [i, p] of demo.pages.entries()) {
    const queue = ok(await api(p, '/api/tasks/today?limit=50'));
    assert.ok(queue.items.length);
    if (i)
      assert.ok(
        queue.items.every(
          (t) => t.assigneeMembershipId === 'demo-member-' + (i === 1 ? 'ahmet' : 'ayse'),
        ),
      );
    const t = queue.items.find((t) => (i === 1 ? t.policyId === 'demo-policy-0' : true));
    assert.ok(t);
    tasks.push(t);
    await selectTask(p, t);
    await p.getByRole('link', { name: 'Müşteri profilini aç', exact: true }).click();
    await p.getByRole('heading', { name: t.customerDisplayName, exact: true }).waitFor();
    await p
      .getByRole('navigation', { name: 'Müşteri bölümleri' })
      .getByRole('link', { name: 'Poliçeler ve yenilemeler', exact: true })
      .click();
    await p.getByRole('link', { name: t.policyNumber, exact: true }).click();
    await p.getByRole('heading', { name: t.policyNumber, exact: true }).waitFor();
    assert.equal(new URL(p.url()).pathname, '/policies/' + t.policyId);
    await p.getByRole('link', { name: 'Seçili takibe dön', exact: true }).click();
    await p.locator('.today-workspace[data-selected=true]').waitFor();
    assert.equal(new URL(p.url()).searchParams.get('task'), t.taskId);
  }
  await checkpoint('THREE_ACTOR_DAILY_CUSTOMER_POLICY_DAILY_EXACT_IDENTITIES');
  const t = tasks[1];
  stage = 'daily-discard-context';
  await selectTask(a, t);
  await openSection(a, 'İletişim');
  await button(a, 'İletişim kaydı ekle');
  await a.getByLabel('Görüşme sonucu', { exact: true }).selectOption('NOTE');
  await a.getByLabel('İç not', { exact: true }).fill('Bırakılan sentetik checkpoint taslağı');
  await a.getByRole('link', { name: 'Müşteri profilini aç', exact: true }).click();
  await a.getByRole('dialog').waitFor();
  await button(a, 'Ayrılmayı onayla');
  await a.getByRole('heading', { name: t.customerDisplayName, exact: true }).waitFor();
  assert.equal(await a.evaluate(() => typeof history.state?.usr?.workReturn), 'string');
  await a.getByRole('link', { name: 'Seçili takibe dön', exact: true }).click();
  await a.locator('.today-workspace[data-selected=true]').waitFor();
  assert.equal(new URL(a.url()).searchParams.get('task'), t.taskId);
  await checkpoint('DAILY_DISCARD_PRESERVES_LINK_ONCLICK_AND_RETURN_CONTEXT');
  stage = 'daily-uncertain-logout-replay';
  await openSection(a, 'İletişim');
  await button(a, 'İletişim kaydı ekle');
  await a.getByLabel('Görüşme sonucu', { exact: true }).selectOption('NOTE');
  const note = 'Birleşik V4 belirsiz yazım kabulü';
  await a.getByLabel('İç not', { exact: true }).fill(note);
  const path = `/api/renewals/${t.renewalId}/interactions`;
  const attempts = [];
  let drop = true,
    logoutPosts = 0;
  const listen = (r) => {
    if (new URL(r.url()).pathname === '/api/auth/logout') logoutPosts++;
  };
  a.on('request', listen);
  await a.route('**' + path, async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    attempts.push({
      body: route.request().postData(),
      key: route.request().headers()['idempotency-key'],
    });
    const response = await route.fetch();
    if (drop) {
      drop = false;
      await route.abort('failed');
    } else await route.fulfill({ response });
  });
  await button(a, 'İletişim kaydını kaydet');
  await a
    .getByRole('button', { name: 'Aynı iletişim isteğini yeniden dene', exact: true })
    .waitFor();
  await button(a, 'Çıkış Yap');
  await a.getByText(/belirsiz sonucu çözülmeden çıkış/).waitFor();
  assert.equal(logoutPosts, 0);
  assert.equal(await a.getByRole('dialog').count(), 0);
  assert.equal(new URL(a.url()).pathname, '/today-work');
  await button(a, 'Aynı iletişim isteğini yeniden dene');
  await a.getByText('İletişim kaydı kaydedildi ve geçmiş güncellendi.', { exact: true }).waitFor();
  assert.equal(attempts.length, 2);
  assert.ok(attempts[0].body === attempts[1].body && attempts[0].key === attempts[1].key);
  assert.equal(
    await demo.db
      .prepare('SELECT count(*) n FROM renewal_interactions WHERE renewal_id=? AND note=?')
      .bind(t.renewalId, note)
      .first('n'),
    1,
  );
  assert.equal(await a.getByText(/belirsiz sonucu çözülmeden çıkış/).count(), 0);
  await a.unroute('**' + path);
  a.off('request', listen);
  await checkpoint('DAILY_COMMITTED_RESPONSE_LOSS_SINGLE_EFFECT_EXACT_RETRY_LOGOUT_HOLD_RECOVERY');
  stage = 'shared-customer-note-private-tasks';
  await a.getByRole('link', { name: 'Müşteri profilini aç', exact: true }).click();
  await a
    .getByRole('navigation', { name: 'Müşteri bölümleri' })
    .getByRole('link', { name: 'Müşteri notları', exact: true })
    .click();
  const shared = 'Birleşik V4 ortak müşteri notu';
  await a.getByLabel('Yeni müşteri notu', { exact: true }).fill(shared);
  await button(a, 'Notu kaydet');
  await a.getByText('Not kaydedildi.', { exact: true }).waitFor();
  await b.goto(demo.origin + `/customers/${t.customerId}?section=notes`);
  await b.getByText(shared, { exact: true }).waitFor();
  assert.equal((await api(b, `/api/tasks/${t.taskId}/context`)).status, 404);
  await checkpoint('SHARED_NOTE_VISIBLE_OTHER_MEMBER_PRIVATE_TASK_404');
  stage = 'policy-renewal-quote-followup';
  await a
    .getByRole('navigation', { name: 'Müşteri bölümleri' })
    .getByRole('link', { name: 'Poliçeler ve yenilemeler', exact: true })
    .click();
  await a.getByRole('link', { name: t.policyNumber, exact: true }).click();
  await a.getByRole('link', { name: 'Yenileme ve teklifler', exact: true }).click();
  await a.getByRole('button', { name: t.policyNumber + ' yenilemesini aç', exact: true }).click();
  assert.equal(new URL(a.url()).searchParams.get('renewal'), t.renewalId);
  await button(a, 'Teklif geçmişini aç');
  await a.locator('.quote-history').waitFor();
  const historyRead = ok(await api(a, `/api/renewals/${t.renewalId}/quotes`));
  assert.ok(historyRead.quotes.length);
  await button(a, 'Takip ve sonuç');
  await button(a, 'Yetkili takipleri yükle');
  await a.getByRole('link', { name: 'Takip ve sonuç işlemlerini aç', exact: true }).click();
  await a.locator('.today-workspace[data-selected=true]').waitFor();
  assert.equal(new URL(a.url()).searchParams.get('task'), t.taskId);
  await a.goBack();
  await a.getByRole('button', { name: 'Yenileme seçimini değiştir', exact: true }).waitFor();
  assert.equal(new URL(a.url()).searchParams.get('renewal'), t.renewalId);
  await checkpoint('POLICY_EXACT_RENEWAL_IMMUTABLE_QUOTE_HISTORY_FOLLOWUP_BACK_RESTORE');
  stage = 'personnel-real-reauth';
  assert.equal((await api(owner, '/api/personnel')).status, 200);
  for (const p of [a, b]) assert.equal((await api(p, '/api/personnel')).status, 403);
  await owner.goto(demo.origin + '/personnel');
  await button(owner, 'Personel oluştur');
  await owner.getByLabel('Ad soyad', { exact: true }).fill('Sentetik V4 Checkpoint');
  await owner.getByLabel('Giriş e-postası', { exact: true }).fill('checkpoint@example.invalid');
  await button(owner, 'Onayla ve oluştur');
  const reauth = owner.getByRole('dialog', {
    name: 'Devam etmek için şifrenizi tekrar girin',
    exact: true,
  });
  await reauth.waitFor();
  await owner.waitForFunction(() => {
    const e = document.querySelector('[role="dialog"] input[type=password]');
    return e && e.value.length >= 32;
  });
  assert.equal(
    await demo.db
      .prepare(
        "SELECT count(*) n FROM local_credentials WHERE login_email='checkpoint@example.invalid'",
      )
      .first('n'),
    0,
  );
  await reauth.getByRole('button', { name: 'Doğrula', exact: true }).click();
  await owner.getByRole('dialog', { name: 'Geçici şifre — yalnız bir kez', exact: true }).waitFor();
  assert.equal(
    await demo.db
      .prepare(
        "SELECT count(*) n FROM local_credentials WHERE login_email='checkpoint@example.invalid'",
      )
      .first('n'),
    1,
  );
  await button(owner, 'Güvenli biçimde kapat');
  await checkpoint('PERSONNEL_OWNER_REAL_CREATE_REAUTH_MEMBER_DENIAL_NO_SECRET_CAPTURE');
  stage = 'catalog-real-create-edit';
  await owner.goto(demo.origin + '/catalogs');
  await owner.getByRole('button', { name: '+ Yeni Ekle', exact: true }).click();
  await owner
    .getByLabel('Kod (Semantik Değer - Değiştirilemez)', { exact: true })
    .fill('V4CHECKPOINT');
  await owner.getByLabel('İsim / Tanım', { exact: true }).fill('Sentetik Checkpoint Sigortacı');
  await button(owner, 'Kaydet');
  const catalogRow = owner
    .getByRole('row')
    .filter({ has: owner.getByText('V4CHECKPOINT', { exact: true }) });
  await catalogRow.waitFor();
  let insurer = ok(await api(owner, '/api/catalogs/insurers')).find(
    (i) => i.code === 'V4CHECKPOINT',
  );
  assert.ok(insurer);
  assert.equal(insurer.name, 'Sentetik Checkpoint Sigortacı');
  await catalogRow.getByRole('button', { name: 'Düzenle', exact: true }).click();
  await owner.getByLabel('İsim / Tanım', { exact: true }).fill('Sentetik Checkpoint Güncel');
  await button(owner, 'Güncelle');
  await owner.getByText('Sentetik Checkpoint Güncel', { exact: true }).waitFor();
  insurer = ok(await api(owner, '/api/catalogs/insurers')).find((i) => i.id === insurer.id);
  assert.equal(insurer.name, 'Sentetik Checkpoint Güncel');
  assert.equal(insurer.version, 2);
  assert.equal(
    (
      await api(b, '/api/catalogs/insurers', 'POST', {
        code: 'V4MEMBERDENY',
        name: 'Sentetik yetkisiz deneme',
      })
    ).status,
    403,
  );
  assert.equal(
    await demo.db.prepare("SELECT count(*) n FROM insurers WHERE code='V4MEMBERDENY'").first('n'),
    0,
  );
  await b.goto(demo.origin + '/catalogs');
  await b.getByText('Sentetik Checkpoint Güncel', { exact: true }).waitFor();
  await checkpoint('CATALOG_OWNER_CREATE_CAS_EDIT_MEMBER_READ_MUTATION_DENY');
  stage = 'legacy-customer-live-edit-return';
  await selectTask(a, t);
  await a.getByRole('link', { name: 'Müşteri profilini aç', exact: true }).click();
  await a.getByRole('link', { name: 'İleri müşteri işlemleri', exact: true }).click();
  await button(a, 'İletişim bilgilerini düzenle');
  await a.getByLabel('Telefon', { exact: true }).fill('+90 555 000 0490');
  await button(a, 'İletişim bilgilerini kaydet');
  await a.getByText('İletişim bilgileri kaydedildi.', { exact: true }).waitFor();
  assert.equal(ok(await api(a, `/api/customers/${t.customerId}`)).phone, '+90 555 000 0490');
  await button(a, '✕');
  await a.getByRole('link', { name: 'Modern müşteri profiline dön', exact: true }).click();
  await a.getByRole('heading', { name: t.customerDisplayName, exact: true }).waitFor();
  assert.equal(await a.evaluate(() => typeof history.state?.usr?.workReturn), 'string');
  await a.getByRole('link', { name: 'Seçili takibe dön', exact: true }).click();
  await a.locator('.today-workspace[data-selected=true]').waitFor();
  assert.equal(new URL(a.url()).searchParams.get('task'), t.taskId);
  await checkpoint('LEGACY_CUSTOMER_REAL_CONTACT_PATCH_MODERN_RETURN_WORK_CONTEXT');
  stage = 'legacy-policy-live-amendment-return';
  const portfolio = '/policies?search=DEMO&searchMode=prefix&sort=end_date_desc';
  await owner.goto(demo.origin + portfolio);
  await owner.getByRole('link', { name: t.policyNumber, exact: true }).waitFor();
  await button(owner, 'Gelişmiş filtreler');
  await owner
    .getByRole('option', { name: 'Sentetik Checkpoint Güncel', exact: true })
    .waitFor({ state: 'attached' });
  await owner.getByRole('link', { name: 'Klasik işlemler', exact: true }).click();
  const row = owner
    .getByRole('row')
    .filter({ has: owner.getByText(t.policyNumber, { exact: true }) });
  await row.getByRole('button', { name: 'Detayı Aç', exact: true }).click();
  await owner.getByRole('heading', { name: 'Poliçe Detayı', exact: true }).waitFor();
  await button(owner, 'Zeyil Ekle');
  await owner.getByLabel('Zeyil Referansı', { exact: true }).fill('V4-CHECKPOINT-ENDORSEMENT');
  await owner
    .getByLabel('Yürürlük Tarihi', { exact: true })
    .fill(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Istanbul' }).format(new Date()));
  await owner.getByLabel('Prim Farkı', { exact: true }).fill('100,50');
  await owner.getByLabel('Zeyil Para Birimi', { exact: true }).fill('TRY');
  await owner.getByLabel('Zeyil Açıklaması', { exact: true }).fill('Sentetik birleşik kabul zeyli');
  const saved = owner.waitForResponse(
    (r) =>
      r.request().method() === 'POST' &&
      new URL(r.url()).pathname === `/api/policies/${t.policyId}/amendments`,
  );
  await button(owner, 'Zeyli Kaydet');
  assert.ok((await saved).ok());
  const amendments = ok(await api(owner, `/api/policies/${t.policyId}/amendments`));
  const entries = Array.isArray(amendments) ? amendments : amendments.items;
  const amendment = entries.find((x) => x.externalReference === 'V4-CHECKPOINT-ENDORSEMENT');
  assert.ok(amendment);
  assert.equal(amendment.premiumDifferenceMinor, 10050);
  await owner.getByRole('link', { name: 'Modern poliçe listesine dön', exact: true }).click();
  await owner.locator('.pv4-table').waitFor();
  assert.equal(new URL(owner.url()).pathname + new URL(owner.url()).search, portfolio);
  await checkpoint('LEGACY_POLICY_REAL_ENDORSEMENT_EXACT_MONEY_FILTERED_PORTFOLIO_RETURN');
  stage = 'forced-session-end';
  await b.goto(demo.origin + `/customers/${t.customerId}?section=notes`);
  await b
    .getByLabel('Yeni müşteri notu', { exact: true })
    .fill('Oturum sonunda terk edilen sentetik taslak');
  const ended = await b.evaluate(async () => {
    const c = await (await fetch('/api/auth/csrf-token')).json();
    return (
      await fetch('/api/auth/logout', {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-csrf-token': c.data.token },
        body: '{}',
      })
    ).status;
  });
  assert.equal(ended, 200);
  await button(b, 'Notları yenile');
  await b.getByRole('heading', { name: 'Giriş Yap', exact: true }).waitFor();
  assert.equal(await b.getByRole('dialog').count(), 0);
  await checkpoint('SERVER_SESSION_END_REMAINS_AUTHORITATIVE_OVER_DIRTY_WORKSPACE');
  stage = 'voluntary-daily-logout';
  await selectTask(owner, t);
  await openSection(owner, 'İletişim');
  await button(owner, 'İletişim kaydı ekle');
  await owner.getByLabel('Görüşme sonucu', { exact: true }).selectOption('NOTE');
  await owner
    .getByLabel('İç not', { exact: true })
    .fill('Gönüllü çıkış onayı için sentetik taslak');
  let requests = 0;
  owner.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/auth/logout') requests++;
  });
  await button(owner, 'Çıkış Yap');
  await owner.getByRole('dialog').waitFor();
  assert.equal(requests, 0);
  await button(owner, 'Bu ekranda kal');
  assert.equal(ok(await api(owner, '/api/auth/session')).state, 'NORMAL');
  await button(owner, 'Çıkış Yap');
  await button(owner, 'Ayrılmayı onayla');
  await owner.getByRole('heading', { name: 'Giriş Yap', exact: true }).waitFor();
  assert.equal(requests, 1);
  assert.equal((await api(owner, '/api/auth/session')).status, 401);
  await checkpoint('VOLUNTARY_DAILY_LOGOUT_EXPLICIT_DISCARD_SINGLE_LOGOUT_REQUEST');
  assert.deepEqual((await demo.db.prepare('PRAGMA foreign_key_check').all()).results, []);
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.external, []);
  report.status = 'PASS';
  await checkpoint('FINAL_FK_RUNTIME_CSP_AND_LOCAL_ORIGIN_INTEGRITY');
  console.info(
    JSON.stringify({
      status: 'PASS',
      scenarioGroups: report.checks.length,
      actors: 3,
      errors: report.errors.length,
      external: report.external.length,
    }),
  );
} catch (error) {
  report.status = 'FAIL';
  report.stage = stage;
  report.kind = error?.name ?? 'unknown';
  report.failure = stage === 'setup' ? 'SYNTHETIC_SETUP_FAILED' : String(error);
  await writeFile(out + '/combined-browser-failure.json', JSON.stringify(report, null, 2));
  console.error('V4_CHECKPOINT_FAIL', stage, report.kind);
  process.exitCode = 1;
} finally {
  await demo?.close();
}
