// Integrated functional acceptance: real loopback HTTPS, browser authentication, CRM API and local D1.
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import process from 'node:process';
import console from 'node:console';
import { chromium } from 'playwright';
import { openOperationalPreview } from '../../scripts/demo/operational-preview.mjs';
let p,
  browser,
  stage = 'setup';
const passed = [];
const evidence = process.env.MAYI_ACCEPTANCE_EVIDENCE_DIR ?? 'functional-evidence';
async function api(page, path, method = 'GET', body, key) {
  const r = await page.evaluate(
    async ({ path, method, body, key }) => {
      const headers = {};
      if (method !== 'GET') {
        const c = await (await globalThis.fetch('/api/csrf-token')).json();
        headers['x-csrf-token'] = c.data.token;
        headers['content-type'] = 'application/json';
        headers['idempotency-key'] = key ?? globalThis.crypto.randomUUID();
      }
      const r = await globalThis.fetch(path, {
        method,
        headers,
        cache: 'no-store',
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const e = await r.json();
      return { status: r.status, data: e.data, code: e.error?.code };
    },
    { path, method, body, key },
  );
  return r;
}
function ok(r, status = 200) {
  assert.equal(r.status, status, stage);
  return r.data;
}
const snapshot = (t) => ({
  expectedPrimaryTaskId: t.taskId,
  expectedRenewalVersion: t.renewalVersion,
  expectedTaskVersion: t.taskVersion,
});
try {
  await mkdir(evidence, { recursive: true });
  p = await openOperationalPreview();
  browser = await chromium.launch({
    headless: true,
    ...(process.platform === 'win32' ? { channel: 'msedge' } : {}),
  });
  const contexts = [];
  const pages = [];
  for (const [i, u] of p.users.entries()) {
    const context = await browser.newContext({
      ignoreHTTPSErrors: true,
      viewport: { width: [1440, 768, 360][i], height: 1000 },
    });
    const page = await context.newPage();
    page.setDefaultTimeout(15000);
    await page.goto(p.origin + '/');
    await page.getByLabel('E-posta', { exact: true }).fill(u.email);
    await page.getByLabel('Şifre', { exact: true }).fill(p.passwords[i]);
    await page.getByRole('button', { name: 'Giriş Yap', exact: true }).click();
    await page.getByRole('heading', { name: 'Genel Bakış', exact: true }).waitFor();
    contexts.push(context);
    pages.push(page);
  }
  const [owner, a, b] = pages;
  stage = 'customer-cross-record';
  const customer = ok(
    await api(owner, '/api/customers', 'POST', {
      type: 'INDIVIDUAL',
      firstName: 'Bütünleşik',
      lastName: 'Kabul',
      email: 'functional@example.invalid',
    }),
    201,
  );
  const company = ok(
    await api(owner, '/api/customers', 'POST', {
      type: 'COMPANY',
      companyTitle: 'Sentetik Kabul Şirketi',
    }),
    201,
  );
  const contact = ok(
    await api(owner, `/api/customers/${company.id}/contacts`, 'POST', {
      firstName: 'Yetkili',
      lastName: 'Kabul',
      role: 'İrtibat',
      email: 'representative@example.invalid',
      phone: null,
      isPrimary: true,
    }),
    201,
  );
  assert.equal(ok(await api(owner, `/api/customers/${company.id}`)).contacts[0].id, contact.id);
  const noteKey = globalThis.crypto.randomUUID();
  const noteBody = { content: 'Sentetik modüller arası kabul notu' };
  const note = ok(
    await api(a, `/api/customers/${customer.id}/notes`, 'POST', noteBody, noteKey),
    201,
  );
  const replay = ok(
    await api(a, `/api/customers/${customer.id}/notes`, 'POST', noteBody, noteKey),
    200,
  );
  assert.equal(replay.id, note.id);
  await b.goto(p.origin + `/customers/${customer.id}?section=notes`);
  await b.getByText(noteBody.content, { exact: true }).waitFor();
  await b.reload();
  await b.getByText(noteBody.content, { exact: true }).waitFor();
  passed.push('INDIVIDUAL_COMPANY_CONTACT_SHARED_NOTE_EXACT_REPLAY_REFRESH');
  stage = 'policy-renewal-generation';
  const end = new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10);
  const common = {
    customerId: customer.id,
    insurerId: 'demo-insurer',
    productId: 'demo-product',
    branchId: 'demo-branch',
    paymentMethodId: 'demo-payment',
    assigneeMembershipId: 'demo-member-ahmet',
    grossPremium: '12500.50',
    currency: 'TRY',
    installmentCount: null,
    status: 'ACTIVE',
  };
  const create = async (number) =>
    ok(
      await api(owner, '/api/policies', 'POST', {
        ...common,
        policyNumber: number,
        startDate: '2026-01-01',
        endDate: end,
      }),
      201,
    );
  const policies = [];
  for (const id of ['LINK', 'CREATE', 'LOST']) policies.push(await create('FUNCTIONAL-' + id));
  assert(policies.every((x) => x.grossPremiumMinor === 1250050));
  let queue = ok(await api(a, '/api/tasks/today?limit=50'));
  const taskFor = (policy) => {
    const t = queue.items.find((t) => t.policyId === policy.id);
    assert(t);
    return t;
  };
  let t = taskFor(policies[0]);
  assert.equal((await api(b, `/api/tasks/${t.taskId}/context`)).status, 404);
  passed.push('POLICY_CREATION_MONEY_RENEWAL_TASK_GENERATION_MEMBER_PRIVACY');
  stage = 'interaction-quote-revision-sent';
  ok(
    await api(a, `/api/renewals/${t.renewalId}/interactions`, 'POST', {
      outcome: 'CONTACT_CONFIRMED',
      channel: 'PHONE',
      occurredAt: new Date().toISOString(),
      companyContactId: null,
      note: null,
    }),
    201,
  );
  queue = ok(await api(a, '/api/tasks/today?limit=50'));
  t = taskFor(policies[0]);
  const root = `/api/renewals/${t.renewalId}/quotes`;
  const history = ok(await api(a, root));
  const version = {
    ...history.defaultVersion,
    grossPremiumMinor: 1250050,
    validUntil: new Date(Date.now() + 86400000).toISOString(),
  };
  const q = ok(
    await api(a, root, 'POST', { expectedRenewalVersion: t.renewalVersion, version }),
    201,
  );
  const rev = ok(
    await api(a, `${root}/${q.quoteId}/versions`, 'POST', { expectedQuoteVersion: 1, version }),
    201,
  );
  ok(
    await api(a, `${root}/${q.quoteId}/send`, 'POST', {
      expectedQuoteVersion: 2,
      quoteVersionId: rev.quoteVersionId,
    }),
    201,
  );
  const sent = ok(await api(a, root));
  assert.equal(sent.quotes.find((x) => x.id === q.quoteId).versions.length, 2);
  passed.push('CONTACT_QUOTE_CREATE_IMMUTABLE_REVISION_SENT');
  stage = 'won-existing-policy-link';
  const newPolicy = ok(
    await api(owner, '/api/policies', 'POST', {
      ...common,
      policyNumber: 'FUNCTIONAL-LINK-RESULT',
      startDate: version.startDate,
      endDate: version.endDate,
    }),
    201,
  );
  queue = ok(await api(a, '/api/tasks/today?limit=50'));
  t = taskFor(policies[0]);
  const winBody = {
    ...snapshot(t),
    acceptedQuoteVersionId: rev.quoteVersionId,
    result: {
      kind: 'LINK_POLICY',
      newPolicyId: newPolicy.id,
      expectedPolicyVersion: newPolicy.version,
      allocatedNewPremiumMinor: 1250050,
      currency: 'TRY',
    },
  };
  const winKey = globalThis.crypto.randomUUID();
  ok(await api(a, `/api/renewals/${t.renewalId}/close-won`, 'POST', winBody, winKey));
  ok(await api(a, `/api/renewals/${t.renewalId}/close-won`, 'POST', winBody, winKey));
  assert.equal(
    (
      await p.demo.db
        .prepare('SELECT state FROM renewal_opportunities WHERE id=?')
        .bind(t.renewalId)
        .first()
    ).state,
    'WON',
  );
  assert.equal(
    (
      await p.demo.db
        .prepare('SELECT count(*) n FROM renewal_policy_links WHERE renewal_id=?')
        .bind(t.renewalId)
        .first()
    ).n,
    1,
  );
  passed.push('WON_LINK_SINGLE_ALLOCATION_EXACT_REPLAY_DB');
  stage = 'won-new-policy';
  queue = ok(await api(a, '/api/tasks/today?limit=50'));
  t = taskFor(policies[1]);
  const defaults = ok(await api(a, `/api/renewals/${t.renewalId}/quotes`)).defaultVersion;
  ok(
    await api(a, `/api/renewals/${t.renewalId}/close-won`, 'POST', {
      ...snapshot(t),
      result: {
        kind: 'CREATE_POLICY',
        policy: {
          ...common,
          policyNumber: 'FUNCTIONAL-CREATED-RESULT',
          startDate: defaults.startDate,
          endDate: defaults.endDate,
        },
      },
    }),
    201,
  );
  assert.equal(
    (
      await p.demo.db
        .prepare("SELECT count(*) n FROM policies WHERE policy_number='FUNCTIONAL-CREATED-RESULT'")
        .first()
    ).n,
    1,
  );
  passed.push('WON_CREATE_POLICY_ATOMIC_LINK_DB');
  stage = 'task-replacement-lost-dashboard';
  queue = ok(await api(a, '/api/tasks/today?limit=50'));
  t = taskFor(policies[2]);
  const replaced = ok(
    await api(a, `/api/renewals/${t.renewalId}/tasks/${t.taskId}/complete`, 'POST', {
      expectedRenewalVersion: t.renewalVersion,
      expectedTaskVersion: t.taskVersion,
      replacementDueAt: new Date(Date.now() + 86400000).toISOString(),
    }),
  );
  assert.notEqual(replaced.replacementTaskId, t.taskId);
  const stale = await api(a, `/api/renewals/${t.renewalId}/close-lost`, 'POST', {
    ...snapshot(t),
    lossReasonId: 'demo-loss-price',
    lossReasonNotes: null,
  });
  assert.equal(stale.status, 409);
  queue = ok(await api(a, '/api/tasks/today?limit=50'));
  t = taskFor(policies[2]);
  ok(
    await api(a, `/api/renewals/${t.renewalId}/close-lost`, 'POST', {
      ...snapshot(t),
      lossReasonId: 'demo-loss-price',
      lossReasonNotes: null,
    }),
  );
  assert.equal(
    (
      await p.demo.db
        .prepare("SELECT count(*) n FROM tasks WHERE renewal_id=? AND status='OPEN'")
        .bind(t.renewalId)
        .first()
    ).n,
    0,
  );
  for (const page of [owner, a, b]) {
    await page.goto(p.origin + '/');
    await page.getByRole('link', { name: /Geciken görevler: / }).waitFor();
    const summary = ok(
      await api(page, '/api/tasks/statistics?view=' + (page === owner ? 'team' : 'self')),
    );
    const values = await page
      .getByRole('link', { name: /Bugünkü görevler: / })
      .getAttribute('aria-label');
    assert.equal(values, `Bugünkü görevler: ${summary.summary.dueToday}`);
  }
  passed.push('REPLACEMENT_NEW_PRIMARY_STALE409_LOST_CLOSE_DASHBOARD_SYNC');
  stage = 'policy-search-refresh';
  await owner.goto(p.origin + '/policies?search=FUNCTIONAL&searchMode=prefix');
  await owner.getByRole('link', { name: 'FUNCTIONAL-LINK-RESULT', exact: true }).waitFor();
  await owner.reload();
  await owner.getByRole('link', { name: 'FUNCTIONAL-LINK-RESULT', exact: true }).waitFor();
  await owner.getByRole('link', { name: 'FUNCTIONAL-LINK-RESULT', exact: true }).click();
  await owner.getByRole('heading', { name: 'FUNCTIONAL-LINK-RESULT', exact: true }).waitFor();
  passed.push('POLICY_SEARCH_REFRESH_DETAIL_CROSS_MODULE');
  assert.deepEqual((await p.demo.db.prepare('PRAGMA foreign_key_check').all()).results, []);
  passed.push('FINAL_FK_INTEGRITY');
  for (const [i, page] of pages.entries())
    await page.screenshot({ path: `${evidence}/integrated-${i}.png`, fullPage: true });
  await writeFile(
    `${evidence}/integrated-business-results.json`,
    JSON.stringify({ status: 'PASS', mode: 'REAL_LOCAL_BROWSER_AUTH_API_D1', passed }, null, 2),
  );
  console.info(JSON.stringify({ status: 'PASS', scenarioGroups: passed.length }));
} catch (error) {
  await writeFile(
    `${evidence}/integrated-business-failure.json`,
    JSON.stringify(
      {
        status: 'FAIL',
        stage,
        completed: passed,
        kind: error instanceof Error ? error.name : 'unknown',
        actual:
          typeof error?.actual === 'number' || typeof error?.actual === 'boolean'
            ? error.actual
            : undefined,
        expected:
          typeof error?.expected === 'number' || typeof error?.expected === 'boolean'
            ? error.expected
            : undefined,
        location:
          error instanceof Error
            ? error.stack?.match(/functional-business\.smoke\.mjs:\d+:\d+/)?.[0]
            : undefined,
      },
      null,
      2,
    ),
  );
  console.error('INTEGRATED_BUSINESS_FAIL', stage, error instanceof Error ? error.name : 'unknown');
  process.exitCode = 1;
} finally {
  await browser?.close();
  await p?.close();
}
