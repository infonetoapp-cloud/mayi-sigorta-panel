import console from 'node:console';
import { Buffer } from 'node:buffer';
import { URL } from 'node:url';
import { request as httpsRequest } from 'node:https';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
export async function run({ db, accounts, origin }) {
  assert.equal(origin, 'https://localhost:8443');
  const tag = randomUUID().slice(0, 8),
    cases = [],
    state = { tag };
  const path = resolve('audit-evidence/employee-acceptance-2026-11-17.json');
  await mkdir(resolve('audit-evidence'), { recursive: true });
  const report = async () =>
    writeFile(
      path,
      JSON.stringify(
        {
          classification: 'SYNTHETIC/LOCAL',
          transport: 'HTTPS loopback + real Hono/D1/session/CSRF; no browser fetch override',
          date: '2026-11-17',
          run: tag,
          cases,
          state,
        },
        null,
        2,
      ),
    );
  async function step(name, work) {
    try {
      await work();
      cases.push({ name, status: 'PASS' });
      console.info('ACCEPTANCE_PASS ' + name);
    } catch (e) {
      cases.push({ name, status: 'FAIL', message: e.message });
      await report();
      throw Error(name + ': ' + e.message, { cause: e });
    }
    await report();
  }
  async function raw(url, method = 'GET', cookie = '', body, csrf = '', key = '') {
    const u = new URL(url, origin);
    assert.equal(u.origin, origin);
    const response = await new Promise((yes, no) => {
      const req = httpsRequest(
        u,
        {
          method,
          rejectUnauthorized: false,
          headers: {
            ...(cookie ? { cookie } : {}),
            ...(body !== undefined ? { 'content-type': 'application/json', origin } : {}),
            ...(csrf ? { 'X-CSRF-Token': csrf } : {}),
            ...(key ? { 'Idempotency-Key': key } : {}),
          },
        },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8');
            let json;
            try {
              json = JSON.parse(text);
            } catch {
              json = { error: { message: text.slice(0, 160) } };
            }
            yes({ status: res.statusCode, headers: res.headers, json });
          });
        },
      );
      req.on('error', no);
      if (body !== undefined) req.write(JSON.stringify(body));
      req.end();
    });
    return response;
  }
  const expect = (r, status) => {
    assert.ok(
      (Array.isArray(status) ? status : [status]).includes(r.status),
      `HTTP ${r.status}: ${JSON.stringify(r.json.error ?? r.json)}`,
    );
    return r.json.data;
  };
  async function login(account) {
    const r = await raw('/api/auth/login', 'POST', '', {
      email: account.email,
      password: account.password,
    });
    expect(r, 200);
    return { cookie: r.headers['set-cookie'][0].split(';')[0], email: account.email };
  }
  async function read(url, actor = owner) {
    return expect(await raw(url, 'GET', actor.cookie), 200);
  }
  async function write(
    url,
    body,
    { actor = owner, method = 'POST', key = randomUUID(), status = 200, csrf = true } = {},
  ) {
    const token = csrf ? (await read('/api/auth/csrf-token', actor)).token : '';
    return expect(await raw(url, method, actor.cookie, body, token, key), status);
  }
  async function counts() {
    if (db) {
      const out = {};
      for (const t of [
        'customers',
        'policies',
        'tasks',
        'renewal_opportunities',
        'renewal_quote_versions',
        'renewal_policy_links',
        'finance_receivables',
        'finance_entries',
        'claim_files',
        'claim_history',
        'operation_receipts',
        'audit_events',
      ])
        out[t] = (await db.prepare('SELECT count(*) n FROM ' + t).first()).n;
      return out;
    }
    const [customers, policies, tasks, renewals, finance, claims] = await Promise.all([
      read('/api/customers?limit=100'),
      read('/api/policies?pageSize=100'),
      read('/api/tasks/today?limit=50'),
      read('/api/renewals?view=ALL&limit=50'),
      read('/api/finance/receivables?view=ALL&limit=50'),
      read('/api/claims?limit=50'),
    ]);
    let entries = 0,
      histories = 0;
    for (const r of finance.items)
      entries += (await read('/api/finance/receivables/' + r.id)).entries.length;
    for (const r of claims.items) histories += (await read('/api/claims/' + r.id)).history.length;
    return {
      customers: customers.items.length,
      policies: policies.items.length,
      tasks: tasks.items.length,
      renewal_opportunities: renewals.items.length,
      finance_receivables: finance.items.length,
      finance_entries: entries,
      claim_files: claims.items.length,
      claim_history: histories,
    };
  }

  const date = (n) =>
    new Date(
      Date.parse(
        new Intl.DateTimeFormat('en-CA', {
          timeZone: 'Europe/Istanbul',
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(new Date()) + 'T00:00:00Z',
      ) +
        86400000 * n,
    )
      .toISOString()
      .slice(0, 10);
  let owner,
    ahmet,
    ayse,
    customer,
    company,
    oldPolicy,
    newPolicy,
    task,
    quote,
    vehicle,
    insurer,
    product,
    payment,
    claim,
    receivable,
    firstCollection,
    secondCollection;
  await step('real login, unauthenticated rejection, owner/member separation', async () => {
    expect(await raw('/api/me'), 401);
    owner = await login(accounts[0]);
    ahmet = await login(accounts[1]);
    ayse = await login(accounts[2]);
    assert.equal((await read('/api/me')).state ?? 'NORMAL', 'NORMAL');
    expect(await raw('/api/finance/receivables', 'GET', ahmet.cookie), 403);
    expect(await raw('/api/claims', 'GET', ayse.cookie), 403);
  });
  await step('shared customers with private task and renewal-operation boundaries', async () => {
    const a = await read('/api/tasks/today', ahmet),
      b = await read('/api/tasks/today', ayse);
    assert.ok(a.items.length && b.items.length);
    assert.ok(a.items.every((t) => t.assigneeMembershipId === 'demo-member-ahmet'));
    assert.ok(b.items.every((t) => t.assigneeMembershipId === 'demo-member-ayse'));
    expect(
      await raw('/api/renewals/' + a.items[0].renewalId + '/operation-context', 'GET', ayse.cookie),
      404,
    );
    assert.ok((await read('/api/customers', ayse)).items.length > 0);
  });
  await step('catalog creation, duplicate rejection and agency settings read', async () => {
    insurer = await write(
      '/api/catalogs/insurers',
      { code: 'QA_' + tag, name: 'Kabul Sigorta ' + tag },
      { status: 201 },
    );
    product = await write(
      '/api/catalogs/products',
      { code: 'QA_' + tag, name: 'Kabul Kasko', insurerId: insurer.id, branchId: 'demo-branch' },
      { status: 201 },
    );
    payment = await write(
      '/api/catalogs/payment-methods',
      {
        code: 'QA_POS_' + tag,
        name: 'Sanal POS 1–9',
        supportsInstallments: true,
        maxInstallments: 9,
      },
      { status: 201 },
    );
    await write('/api/catalogs/insurers', { code: 'QA_' + tag, name: 'Mükerrer' }, { status: 409 });
    await read('/api/agency/settings');
  });
  await step(
    'individual/company reference and birthday validation with no CSRF side effect',
    async () => {
      const before = await counts();
      await write(
        '/api/customers',
        { type: 'INDIVIDUAL', firstName: 'Hatalı', lastName: 'Tarih', birthDate: date(1) },
        { status: 400 },
      );
      await write(
        '/api/customers',
        { type: 'COMPANY', companyTitle: 'Hatalı Şirket', birthDate: '1990-01-01' },
        { status: 400 },
      );
      await write(
        '/api/customers',
        { type: 'INDIVIDUAL', firstName: 'CSRF', lastName: 'Eksik' },
        { csrf: false, status: 403 },
      );
      assert.deepEqual(await counts(), before);
      customer = await write(
        '/api/customers',
        {
          type: 'INDIVIDUAL',
          firstName: 'Kabul',
          lastName: tag,
          birthDate: '1989-04-23',
          referenceMembershipId: 'demo-member-ahmet',
          email: 'kabul-' + tag + '@example.invalid',
          phone: '+905550000111',
        },
        { status: 201 },
      );
      company = await write(
        '/api/customers',
        {
          type: 'COMPANY',
          companyTitle: 'Kabul Kurumsal ' + tag,
          referenceName: 'Abdurrahman Örnek',
        },
        { status: 201 },
      );
      assert.equal(customer.referenceName, 'Ahmet');
      assert.equal(company.referenceName, 'Abdurrahman Örnek');
      state.customerId = customer.id;
      state.companyId = company.id;
    },
  );
  await step(
    'manual company customer numbers retain leading zeros and stale version is rejected',
    async () => {
      let c = await read('/api/customers/' + customer.id);
      await write(
        '/api/customers/' + c.id + '/insurer-numbers/demo-insurer',
        { expectedVersion: c.version, customerNumber: '000' + tag },
        { method: 'PUT' },
      );
      await write(
        '/api/customers/' + c.id + '/insurer-numbers/' + insurer.id,
        { expectedVersion: c.version, customerNumber: 'BAD' },
        { method: 'PUT', status: 409 },
      );
      c = await read('/api/customers/' + customer.id);
      await write(
        '/api/customers/' + c.id + '/insurer-numbers/' + insurer.id,
        { expectedVersion: c.version, customerNumber: '001' + tag },
        { method: 'PUT' },
      );
      const numbers = await read('/api/customers/' + customer.id + '/insurer-numbers');
      assert.equal(numbers.find((n) => n.insurerId === 'demo-insurer').customerNumber, '000' + tag);
      assert.equal(numbers.find((n) => n.insurerId === insurer.id).customerNumber, '001' + tag);
    },
  );
  await step('optional vehicle fields, duplicate plate and immutable policy snapshot', async () => {
    let c = await read('/api/customers/' + customer.id);
    const empty = await write(
      '/api/customers/' + c.id + '/vehicles',
      { expectedVersion: c.version, details: {}, status: 'ACTIVE' },
      { status: 201 },
    );
    assert.equal(empty.details.plate, null);
    c = await read('/api/customers/' + c.id);
    vehicle = await write(
      '/api/customers/' + c.id + '/vehicles',
      {
        expectedVersion: c.version,
        details: {
          plate: '34 QA ' + tag,
          brand: 'Örnek',
          model: 'İlk model',
          modelYear: 2020,
          engineNumber: '000789',
        },
        status: 'ACTIVE',
      },
      { status: 201 },
    );
    c = await read('/api/customers/' + c.id);
    await write(
      '/api/customers/' + c.id + '/vehicles',
      { expectedVersion: c.version, details: vehicle.details, status: 'ACTIVE' },
      { status: 409 },
    );
    oldPolicy = await write(
      '/api/policies',
      {
        customerId: c.id,
        insurerId: 'demo-insurer',
        productId: 'demo-product',
        branchId: 'demo-branch',
        paymentMethodId: 'demo-payment',
        policyNumber: 'QA-OLD-' + tag,
        startDate: date(-360),
        endDate: date(5),
        grossPremium: '1000.00',
        currency: 'TRY',
        installmentCount: null,
      },
      { status: 201 },
    );
    await write(
      '/api/policies/' + oldPolicy.id + '/vehicle',
      {
        expectedVersion: oldPolicy.version,
        vehicleId: vehicle.id,
        vehicleVersion: vehicle.version,
      },
      { method: 'PUT' },
    );
    c = await read('/api/customers/' + c.id);
    await write(
      '/api/customers/' + c.id + '/vehicles/' + vehicle.id,
      {
        expectedVersion: c.version,
        expectedVehicleVersion: vehicle.version,
        details: { ...vehicle.details, model: 'Güncel model' },
        status: 'ACTIVE',
      },
      { method: 'PUT' },
    );
    oldPolicy = await read('/api/policies/' + oldPolicy.id);
    assert.equal(oldPolicy.vehicle.details.model, 'İlk model');
    state.oldPolicyId = oldPolicy.id;
  });
  await step(
    'independent renewal reads expose only a genuine authorized primary task',
    async () => {
      task = (await read('/api/tasks/today?limit=50')).items.find(
        (t) => t.policyId === oldPolicy.id,
      );
      assert.ok(task);
      const list = await read('/api/renewals?q=' + encodeURIComponent('QA-OLD-' + tag));
      assert.ok(list.items.some((r) => r.id === task.renewalId));
      const detail = await read('/api/renewals/' + task.renewalId);
      assert.equal(detail.policy.id, oldPolicy.id);
      assert.equal(
        (await read('/api/renewals/' + task.renewalId + '/operation-context')).taskId,
        task.taskId,
      );
      state.renewalId = task.renewalId;
    },
  );
  await step(
    'manual nonannual quote version, sending evidence and atomic accepted policy result',
    async () => {
      const root = '/api/renewals/' + task.renewalId + '/quotes',
        defaults = (await read(root)).defaultVersion;
      quote = await write(
        root,
        {
          expectedRenewalVersion: task.renewalVersion,
          version: {
            ...defaults,
            insurerId: insurer.id,
            productId: product.id,
            paymentMethodId: payment.id,
            startDate: date(6),
            endDate: date(95),
            grossPremiumMinor: 125000,
            currency: 'TRY',
            installmentCount: 3,
            validUntil: new Date(Date.now() + 86400000).toISOString(),
          },
        },
        { status: 201 },
      );
      const version = await write(
        root + '/' + quote.quoteId + '/versions',
        {
          expectedQuoteVersion: 1,
          version: {
            ...defaults,
            insurerId: insurer.id,
            productId: product.id,
            paymentMethodId: payment.id,
            startDate: date(6),
            endDate: date(95),
            grossPremiumMinor: 120000,
            currency: 'TRY',
            installmentCount: 3,
            validUntil: new Date(Date.now() + 86400000).toISOString(),
          },
        },
        { status: 201 },
      );
      const quotes = (await read(root)).quotes,
        chosen = quotes.find((q) => q.id === quote.quoteId);
      const currentId = version.quoteVersionId ?? chosen.current_version_id;
      await write(
        root + '/' + quote.quoteId + '/send',
        { expectedQuoteVersion: chosen.version, quoteVersionId: currentId },
        { status: 201 },
      );
      const cmd = {
          expectedPrimaryTaskId: task.taskId,
          expectedRenewalVersion: task.renewalVersion,
          expectedTaskVersion: task.taskVersion,
          acceptedQuoteVersionId: currentId,
          result: {
            kind: 'CREATE_POLICY',
            policy: {
              customerId: customer.id,
              insurerId: insurer.id,
              productId: product.id,
              branchId: 'demo-branch',
              paymentMethodId: payment.id,
              policyNumber: 'QA-NEW-' + tag,
              startDate: date(6),
              endDate: date(95),
              grossPremium: '1200.00',
              currency: 'TRY',
              installmentCount: 3,
            },
          },
        },
        key = randomUUID();
      const out = await write('/api/renewals/' + task.renewalId + '/close-won', cmd, {
        key,
        status: 201,
      });
      const before = await counts();
      assert.deepEqual(
        await write('/api/renewals/' + task.renewalId + '/close-won', cmd, { key }),
        out,
      );
      assert.deepEqual(await counts(), before);
      newPolicy = await read('/api/policies/' + out.createdPolicyId);
      assert.equal(newPolicy.endDate, date(95));
      assert.equal((await read('/api/renewals/' + task.renewalId)).state, 'WON');
      assert.equal(await read('/api/renewals/' + task.renewalId + '/operation-context'), null);
      state.newPolicyId = newPolicy.id;
    },
  );
  await step(
    'policy payment does not create debt or collection; explicit finance ledger is independent',
    async () => {
      const before = (await read('/api/finance/receivables?policyId=' + newPolicy.id)).items;
      assert.equal(before.length, 0);
      receivable = await write('/api/finance/commands', {
        kind: 'CREATE',
        policyId: newPolicy.id,
        expectedPolicyVersion: newPolicy.version,
        amount: '1000.00',
        dueDate: date(7),
        method: 'CASH',
      });
      const d = await read('/api/finance/receivables/' + receivable.receivableId);
      assert.equal(d.receivable.collectedMinor, 0);
      state.receivableId = receivable.receivableId;
      firstCollection = await write('/api/finance/commands', {
        kind: 'COLLECT',
        receivableId: receivable.receivableId,
        expectedVersion: 1,
        amount: '400.00',
        receivedDate: date(0),
        method: 'BANK',
      });
      const body = {
          kind: 'COLLECT',
          receivableId: receivable.receivableId,
          expectedVersion: 2,
          amount: '400.00',
          receivedDate: date(0),
          method: 'BANK',
        },
        token = (await read('/api/auth/csrf-token')).token;
      const rs = await Promise.all([
        raw('/api/finance/commands', 'POST', owner.cookie, body, token, randomUUID()),
        raw('/api/finance/commands', 'POST', owner.cookie, body, token, randomUUID()),
      ]);
      assert.equal(rs.filter((r) => r.status === 200).length, 1);
      assert.ok(rs.some((r) => [400, 409].includes(r.status)));
      secondCollection = rs.find((r) => r.status === 200).json.data;
      const after = await read('/api/finance/receivables/' + receivable.receivableId);
      assert.equal(after.receivable.remainingMinor, 20000);
      await write(
        '/api/finance/commands',
        { ...body, expectedVersion: 3, amount: '200.01' },
        { status: 400 },
      );
      await write(
        '/api/finance/commands',
        {
          kind: 'VOID',
          receivableId: receivable.receivableId,
          expectedVersion: 3,
          reasonCode: 'DATA_ERROR',
        },
        { status: 409 },
      );
    },
  );
  await step(
    'claims use the insured period, preserve note history and never create collection',
    async () => {
      const fields = {
        lossDate: date(0),
        fileNumber: '000/' + tag,
        expertName: 'Kabul Eksper',
        expertContact: null,
        status: 'WAITING',
        note: null,
      };
      await write(
        '/api/claims/commands',
        {
          kind: 'CREATE',
          policyId: newPolicy.id,
          customerId: customer.id,
          expectedPolicyVersion: newPolicy.version,
          fields,
        },
        { status: 400 },
      );
      const before = (await counts()).finance_entries;
      claim = await write('/api/claims/commands', {
        kind: 'CREATE',
        policyId: oldPolicy.id,
        customerId: customer.id,
        expectedPolicyVersion: oldPolicy.version,
        fields,
      });
      await write('/api/claims/commands', {
        kind: 'UPDATE',
        claimId: claim.claimId,
        expectedVersion: 1,
        fields: { ...fields, status: 'COMPLETED', note: 'Dosya sonuçlandı' },
      });
      const d = await read('/api/claims/' + claim.claimId);
      assert.equal(d.history.length, 2);
      assert.equal(d.history[1].fields.status, 'WAITING');
      assert.equal((await counts()).finance_entries, before);
      state.claimId = claim.claimId;
    },
  );
  await step(
    'customer archive blocks new operational records while debt collection and history remain coherent',
    async () => {
      let c = await read('/api/customers/' + customer.id);
      await write(
        '/api/customers/' + customer.id + '/archive',
        { expectedVersion: c.version, reasonCode: 'TEST_COMPLETE' },
        { status: 409 },
      );
      for (const id of [oldPolicy.id, newPolicy.id]) {
        const p = await read('/api/policies/' + id);
        await write('/api/policies/' + id + '/archive', {
          expectedVersion: p.version,
          reasonCode: 'TEST_COMPLETE',
        });
      }
      c = await read('/api/customers/' + customer.id);
      await write('/api/customers/' + customer.id + '/archive', {
        expectedVersion: c.version,
        reasonCode: 'TEST_COMPLETE',
      });
      assert.equal((await read('/api/claims/' + claim.claimId)).canManage, false);
      await write(
        '/api/finance/commands',
        {
          kind: 'CREATE',
          policyId: newPolicy.id,
          expectedPolicyVersion: newPolicy.version,
          amount: '10.00',
          dueDate: date(7),
          method: 'DEFERRED',
        },
        { status: 404 },
      );
      const d = await read('/api/finance/receivables/' + receivable.receivableId);
      await write('/api/finance/commands', {
        kind: 'ADJUST',
        receivableId: receivable.receivableId,
        expectedVersion: d.receivable.version,
        amount: '1100.00',
        dueDate: date(10),
        reasonCode: 'CUSTOMER_AGREED',
      });
    },
  );
  await step(
    'corrections and reversals leave zero collectible balance and an immutable trail',
    async () => {
      let d = await read('/api/finance/receivables/' + receivable.receivableId);
      await write('/api/finance/commands', {
        kind: 'REVERSE',
        receivableId: receivable.receivableId,
        expectedVersion: d.receivable.version,
        entryId: firstCollection.entryId,
        reasonCode: 'DATA_ERROR',
      });
      d = await read('/api/finance/receivables/' + receivable.receivableId);
      await write('/api/finance/commands', {
        kind: 'REVERSE',
        receivableId: receivable.receivableId,
        expectedVersion: d.receivable.version,
        entryId: secondCollection.entryId,
        reasonCode: 'DATA_ERROR',
      });
      d = await read('/api/finance/receivables/' + receivable.receivableId);
      await write('/api/finance/commands', {
        kind: 'VOID',
        receivableId: receivable.receivableId,
        expectedVersion: d.receivable.version,
        reasonCode: 'DUPLICATE',
      });
      d = await read('/api/finance/receivables/' + receivable.receivableId);
      assert.equal(d.receivable.remainingMinor, 0);
      assert.equal(d.entries.length, 4);
      assert.equal(d.receivable.state, 'VOIDED');
    },
  );
  await step(
    'cross-module API references and histories remain coherent after archive and reversal',
    async () => {
      if (db) assert.deepEqual((await db.prepare('PRAGMA foreign_key_check').all()).results, []);
      const c = await read('/api/claims/' + claim.claimId),
        r = await read('/api/renewals/' + task.renewalId),
        f = await read('/api/finance/receivables/' + receivable.receivableId);
      assert.equal(c.claim.policyId, oldPolicy.id);
      assert.equal(r.policy.id, oldPolicy.id);
      assert.equal(f.receivable.policyId, newPolicy.id);
      state.finalCounts = await counts();
      state.databaseInspection = db
        ? 'direct D1 FK check'
        : 'API readback only; no raw DB/audit inspection in this run';
    },
  );
  return { run: tag, passed: cases.length, state };
}
