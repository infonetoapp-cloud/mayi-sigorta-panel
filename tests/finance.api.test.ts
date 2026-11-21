// @vitest-environment node
import { writeFinance } from '../src/server/finance/service';
import { resolveAuthenticatedUserContext } from '../src/server/auth/identity';
import { verifyFinanceRecovery } from '../scripts/recovery/finance-data-proof';
import { beforeAll, afterAll, it, expect } from 'vitest';
import { customerCoverageFixture } from './support/customer-coverage-fixture';
import type { FinanceResult, FinanceDetail, FinancePage } from '../src/shared/finance';
let f: Awaited<ReturnType<typeof customerCoverageFixture>>,
  serial = 0;
async function data<T>(r: Response, status = 200): Promise<T> {
  expect(r.status, await r.clone().text()).toBe(status);
  return ((await r.json()) as { data: T }).data;
}
async function write(body: unknown, key = crypto.randomUUID(), cookie = f.owner) {
  return f.request('/api/finance/commands', 'POST', cookie, body, await f.csrf(cookie), {
    'Idempotency-Key': key,
  });
}
async function create(displayName?: string) {
  const n = ++serial;
  await f.customer('f-c' + n, undefined, displayName);
  await f.policy('f-p' + n, 'f-c' + n);
  const body = {
    kind: 'CREATE',
    policyId: 'f-p' + n,
    expectedPolicyVersion: 1,
    amount: '100.00',
    dueDate: f.day(-1),
    method: 'DEFERRED',
  };
  return { body, result: await data<FinanceResult>(await write(body)) };
}
async function detail(id: string, cookie = f.owner) {
  return data<FinanceDetail>(await f.request('/api/finance/receivables/' + id, 'GET', cookie));
}
async function state() {
  const r = [];
  for (const table of [
    'finance_receivables',
    'finance_entries',
    'finance_revisions',
    'operation_receipts',
    'audit_events',
  ])
    r.push((await f.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results);
  return JSON.stringify(r);
}
beforeAll(async () => {
  f = await customerCoverageFixture();
}, 180000);
afterAll(async () => {
  await f?.mf.dispose();
});
it('persists a retried adjustment without undoing the newer due date', async () => {
  const { body, result } = await create();
  const member = await f.editingMember('finance-editor-retry', 'finance');
  const edit = {
    kind: 'ADJUST',
    receivableId: result.receivableId,
    expectedVersion: 1,
    amount: body.amount,
    reasonCode: 'DUE_DATE_CHANGED',
  };
  const newDue = f.day(10);
  await data(await write({ ...edit, dueDate: newDue }));
  const stale = { ...edit, reasonCode: 'DATA_ERROR', amount: '1250.50', dueDate: body.dueDate };
  expect((await write(stale, crypto.randomUUID(), member)).status).toBe(409);
  const { receivable } = await detail(result.receivableId, member);
  await data(
    await write(
      { ...stale, expectedVersion: receivable.version, dueDate: receivable.dueDate },
      crypto.randomUUID(),
      member,
    ),
  );
  expect((await detail(result.receivableId)).receivable).toMatchObject({
    version: 3,
    amountMinor: 125050,
    dueDate: newDue,
  });
});
it('explicitly records an agency receivable without treating cash or a policy premium as collected', async () => {
  const c = await create(),
    d = await detail(c.result.receivableId);
  expect(d.receivable).toMatchObject({
    amountMinor: 10000,
    collectedMinor: 0,
    remainingMinor: 10000,
    state: 'OVERDUE',
    version: 1,
    method: 'DEFERRED',
  });
  expect(d.entries).toEqual([]);
  expect(d.revisions).toHaveLength(1);
  const key = crypto.randomUUID(),
    fresh = { ...c.body, method: 'CASH' };
  const first = await data(await write(fresh, key));
  expect(await data(await write(fresh, key))).toEqual(first);
  expect(
    (await f.db.prepare('SELECT count(*) n FROM finance_entries').first<{ n: number }>())!.n,
  ).toBe(0);
  expect((await write({ ...fresh, amount: '101.00' }, key)).status).toBe(409);
});
it('supports partial collection with exact replay and rejects overpayment or a future collection date without effects', async () => {
  const { result } = await create(),
    key = crypto.randomUUID(),
    body = {
      kind: 'COLLECT',
      receivableId: result.receivableId,
      expectedVersion: 1,
      amount: '30.00',
      receivedDate: f.today,
      method: 'BANK',
    };
  const first = await data<FinanceResult>(await write(body, key));
  expect(await data(await write(body, key))).toEqual(first);
  const d = await detail(result.receivableId);
  expect(d.receivable).toMatchObject({ version: 2, collectedMinor: 3000, remainingMinor: 7000 });
  expect(d.entries).toHaveLength(1);
  const before = await state();
  expect((await write({ ...body, expectedVersion: 2, amount: '70.01' })).status).toBe(400);
  expect((await write({ ...body, expectedVersion: 2, receivedDate: f.day(1) })).status).toBe(400);
  expect(await state()).toBe(before);
});
it('keeps corrections and full reversals as immutable history and permits void only after net collections are zero', async () => {
  const { result } = await create(),
    id = result.receivableId;
  const payment = await data<FinanceResult>(
    await write({
      kind: 'COLLECT',
      receivableId: id,
      expectedVersion: 1,
      amount: '30.00',
      receivedDate: f.today,
      method: 'CASH',
    }),
  );
  expect(
    (await write({ kind: 'VOID', receivableId: id, expectedVersion: 2, reasonCode: 'DUPLICATE' }))
      .status,
  ).toBe(409);
  expect(
    (
      await write({
        kind: 'ADJUST',
        receivableId: id,
        expectedVersion: 2,
        amount: '29.99',
        dueDate: f.today,
        reasonCode: 'DATA_ERROR',
      })
    ).status,
  ).toBe(400);
  await data(
    await write({
      kind: 'ADJUST',
      receivableId: id,
      expectedVersion: 2,
      amount: '120.00',
      dueDate: f.day(10),
      reasonCode: 'DUE_DATE_CHANGED',
    }),
  );
  await data(
    await write({
      kind: 'REVERSE',
      receivableId: id,
      expectedVersion: 3,
      entryId: payment.entryId,
      reasonCode: 'DATA_ERROR',
    }),
  );
  let d = await detail(id);
  expect(d.receivable).toMatchObject({
    version: 4,
    collectedMinor: 0,
    remainingMinor: 12000,
    state: 'OPEN',
  });
  expect(d.entries).toHaveLength(2);
  expect(d.revisions.map((r) => r.amountMinor)).toEqual([12000, 10000]);
  expect(
    (
      await write({
        kind: 'REVERSE',
        receivableId: id,
        expectedVersion: 4,
        entryId: payment.entryId,
        reasonCode: 'DATA_ERROR',
      })
    ).status,
  ).toBe(409);
  await expect(
    f.db.prepare('DELETE FROM finance_entries WHERE id=?').bind(payment.entryId).run(),
  ).rejects.toThrow('FINANCE_HISTORY_IMMUTABLE');
  await data(
    await write({ kind: 'VOID', receivableId: id, expectedVersion: 4, reasonCode: 'DUPLICATE' }),
  );
  d = await detail(id);
  expect(d.receivable.state).toBe('VOIDED');
  expect(d.receivable.remainingMinor).toBe(0);
  expect(d.revisions[0]?.reasonCode).toBe('DUPLICATE');
});
it('does not infer finance authority from agency customer/policy access and enforces parent ASSIGNED and HEALTH boundaries', async () => {
  const { result } = await create(),
    url = '/api/finance/receivables/' + result.receivableId;
  expect((await f.request(url, 'GET', f.member)).status).toBe(403);
  await f.db
    .prepare(
      "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES('f-read','membership-coverage-a','finance.read','UNSCOPED')",
    )
    .run();
  expect((await f.request(url, 'GET', f.member)).status).toBe(200);
  expect(
    (
      await write(
        {
          kind: 'COLLECT',
          receivableId: result.receivableId,
          expectedVersion: 1,
          amount: '1.00',
          receivedDate: f.today,
          method: 'CASH',
        },
        crypto.randomUUID(),
        f.member,
      )
    ).status,
  ).toBe(403);
  await f.db
    .prepare(
      "DELETE FROM membership_permissions WHERE membership_id='membership-coverage-a' AND permission_code NOT IN ('finance.read','customer.read','policy.read')",
    )
    .run();
  await f.db
    .prepare(
      "UPDATE membership_permissions SET scope='ASSIGNED' WHERE membership_id='membership-coverage-a' AND permission_code LIKE 'policy.%'",
    )
    .run();
  expect((await f.request(url, 'GET', f.member)).status).toBe(404);
  const parent = await detail(result.receivableId);
  await f.db
    .prepare(
      "UPDATE customers SET assignee_membership_id='membership-coverage-a',version=version+1 WHERE id=?",
    )
    .bind(parent.receivable.customerId)
    .run();
  expect((await f.request(url, 'GET', f.member)).status).toBe(200);
  await f.db
    .prepare(
      "UPDATE customers SET assignee_membership_id='membership-coverage-owner',version=version+1 WHERE id=?",
    )
    .bind(parent.receivable.customerId)
    .run();

  await f.db
    .prepare(
      "UPDATE membership_permissions SET scope='AGENCY' WHERE membership_id='membership-coverage-a' AND permission_code LIKE 'policy.%'",
    )
    .run();
  await f.customer('f-health');
  await f.policy('f-health-p', 'f-health', 'health');
  expect(
    (
      await write({
        kind: 'CREATE',
        policyId: 'f-health-p',
        expectedPolicyVersion: 1,
        amount: '100.00',
        dueDate: f.today,
        method: 'DEFERRED',
      })
    ).status,
  ).toBe(404);
  await f.seed('f-foreign', 'OWNER', false, 'f-other-agency');
  const foreign = (await f.session('f-foreign')).cookie;
  expect((await f.request(url, 'GET', foreign)).status).toBe(404);
});
it('has one winner for concurrent collections and rolls back the balance, receipt and entry if the final audit fails', async () => {
  const { result } = await create(),
    body = {
      kind: 'COLLECT',
      receivableId: result.receivableId,
      expectedVersion: 1,
      amount: '60.00',
      receivedDate: f.today,
      method: 'BANK',
    };
  const rs = await Promise.all([write(body), write(body)]);
  expect(rs.map((r) => r.status).sort()).toEqual([200, 409]);
  expect((await detail(result.receivableId)).receivable.collectedMinor).toBe(6000);
  const before = await state();
  await f.db
    .prepare(
      "CREATE TRIGGER f_audit_fail BEFORE INSERT ON audit_events WHEN NEW.action='finance.collect' BEGIN SELECT RAISE(ABORT,'FINAL_AUDIT_FAILED'); END",
    )
    .run();
  try {
    expect((await write({ ...body, expectedVersion: 2, amount: '10.00' })).status).toBe(500);
    expect(await state()).toBe(before);
  } finally {
    await f.db.prepare('DROP TRIGGER f_audit_fail').run();
  }
});
it('uses bounded filter-bound cursors and currency-separated totals instead of totals from the loaded page', async () => {
  await create();
  await create();
  const page = await data<FinancePage>(
    await f.request('/api/finance/receivables?view=ALL&limit=1', 'GET', f.owner),
  );
  expect(page.items).toHaveLength(1);
  expect(page.nextCursor).toBeTruthy();
  expect(page.totals[0]!.amountMinor).toBeGreaterThan(page.items[0]!.amountMinor);
  const cursor = encodeURIComponent(page.nextCursor!);
  expect(
    (await f.request('/api/finance/receivables?view=OPEN&limit=1&cursor=' + cursor, 'GET', f.owner))
      .status,
  ).toBe(400);
  expect(
    (await f.request('/api/finance/receivables?view=ALL&limit=1&cursor=' + cursor, 'GET', f.owner))
      .status,
  ).toBe(200);
  const q = await data<FinancePage>(
    await f.request('/api/finance/receivables?q=f-p&view=ALL', 'GET', f.owner),
  );
  expect(q.items.length).toBeGreaterThan(0);
  await f.customer('finance-eur-c');
  await f.policy('finance-eur-p', 'finance-eur-c');
  await f.db
    .prepare("UPDATE policies SET currency='EUR',version=version+1 WHERE id='finance-eur-p'")
    .run();
  await data(
    await write({
      kind: 'CREATE',
      policyId: 'finance-eur-p',
      expectedPolicyVersion: 2,
      amount: '12.50',
      dueDate: f.today,
      method: 'DEFERRED',
    }),
  );
  const currencies = await data<FinancePage>(
    await f.request('/api/finance/receivables?view=ALL', 'GET', f.owner),
  );
  expect(currencies.totals.find((t) => t.currency === 'EUR')).toMatchObject({
    amountMinor: 1250,
    collectedMinor: 0,
    remainingMinor: 1250,
  });
  expect(currencies.totals.find((t) => t.currency === 'TRY')?.amountMinor).toBeGreaterThan(1250);
  const before = await state();
  expect(
    (
      await write({
        kind: 'CREATE',
        policyId: 'finance-eur-p',
        expectedPolicyVersion: 2,
        amount: '1.00',
        dueDate: '2026-02-30',
        method: 'CASH',
      })
    ).status,
  ).toBe(400);
  expect(await state()).toBe(before);
  expect(
    (
      await data<FinancePage>(
        await f.request('/api/finance/receivables?q=%25&view=ALL', 'GET', f.owner),
      )
    ).items,
  ).toEqual([]);
});

it('rolls back a live authority change inside the final batch and refuses missing CSRF before writing', async () => {
  const { result } = await create(),
    command = {
      kind: 'COLLECT' as const,
      receivableId: result.receivableId,
      expectedVersion: 1,
      amount: '1.00',
      receivedDate: f.today,
      method: 'BANK' as const,
    };
  const beforeCsrf = await state();
  expect(
    (
      await f.request('/api/finance/commands', 'POST', f.owner, command, undefined, {
        'Idempotency-Key': crypto.randomUUID(),
      })
    ).status,
  ).toBe(403);
  expect(await state()).toBe(beforeCsrf);
  await f.seed('finance-race');
  for (const code of ['finance.read', 'finance.manage', 'customer.read', 'policy.read'])
    await f.db
      .prepare(
        'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
      )
      .bind(
        crypto.randomUUID(),
        'membership-finance-race',
        code,
        code.startsWith('finance.') ? 'UNSCOPED' : 'AGENCY',
      )
      .run();
  const identity = await f.db
    .prepare("SELECT issuer,subject FROM auth_identities WHERE user_id='finance-race'")
    .first<{ issuer: string; subject: string }>();
  const ctx = await resolveAuthenticatedUserContext(f.db, {
    ...identity!,
    assurance: 'NORMAL',
    expiresAt: Date.now() + 60000,
  });
  const before = await state();
  const raced = {
    prepare: f.db.prepare.bind(f.db),
    batch: async (statements: D1PreparedStatement[]) => {
      await f.db
        .prepare(
          "UPDATE agency_memberships SET permission_version=permission_version+1,version=version+1 WHERE id='membership-finance-race'",
        )
        .run();
      return f.db.batch(statements);
    },
  } as D1Database;
  await expect(writeFinance(raced, ctx, command, crypto.randomUUID())).rejects.toMatchObject({
    status: 409,
  });
  expect(await state()).toBe(before);
});
it('retrospectively verifies ledger balances and rejects rehashed historical corruption loaded before triggers', async () => {
  const query = async (sql: string) => (await f.db.prepare(sql).all()).results;
  await expect(verifyFinanceRecovery(query)).resolves.toBeUndefined();
  await f.db.prepare('DROP TRIGGER finance_entry_no_update').run();
  const e = await f.db
    .prepare("SELECT id,amount_minor FROM finance_entries WHERE kind='PAYMENT' LIMIT 1")
    .first<{ id: string; amount_minor: number }>();
  try {
    await f.db
      .prepare('UPDATE finance_entries SET amount_minor=amount_minor+1 WHERE id=?')
      .bind(e!.id)
      .run();
    await expect(verifyFinanceRecovery(query)).rejects.toThrow();
  } finally {
    await f.db
      .prepare('UPDATE finance_entries SET amount_minor=? WHERE id=?')
      .bind(e!.amount_minor, e!.id)
      .run();
  }
});

it('searches the full length on D1 and applies the same literal filter to the finance total', async () => {
  const ascii = 'a'.repeat(80);
  const punctuation = '%_\\';
  const escaped = punctuation.repeat(26) + 'XY';
  const { result } = await create(ascii + ' ' + escaped);
  await create(ascii.slice(0, 79) + 'b ' + escaped.replaceAll('%', '!'));
  for (const q of [ascii.toUpperCase(), escaped, punctuation]) {
    const page = await data<FinancePage>(
      await f.request(
        '/api/finance/receivables?view=ALL&q=' + encodeURIComponent(q),
        'GET',
        f.owner,
      ),
    );
    expect(page.items.map((item) => item.id)).toEqual([result.receivableId]);
    expect(page.totals).toEqual([
      { currency: 'TRY', amountMinor: 10000, collectedMinor: 0, remainingMinor: 10000 },
    ]);
  }
  expect(
    (await f.request('/api/finance/receivables?q=' + ascii + 'a', 'GET', f.owner)).status,
  ).toBe(400);
});
