// @vitest-environment node
import { beforeAll, afterAll, it, expect } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import { verifyPolicyLifecycleRecovery } from '../scripts/recovery/policy-lifecycle-proof';
import { ensureRenewalForPolicy } from '../src/server/renewals/generation';
let f: Awaited<ReturnType<typeof localAuthFixture>>,
  owner: string,
  other: string,
  member: string,
  customerId: string;
let serial = 0;
const agencyToday = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Istanbul',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
}).format(new Date());
function agencyDateAfter(days: number) {
  const date = new Date(`${agencyToday}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}
const cancellationDate = agencyDateAfter(-7);
const expiringPolicyDays = 7;
beforeAll(async () => {
  f = await localAuthFixture();
  await f.seed('cancel-owner', 'OWNER');
  await f.seed('cancel-other', 'OWNER', false, 'cancel-foreign');
  await f.seed('cancel-member');
  owner = (await f.session('cancel-owner')).cookie;
  other = (await f.session('cancel-other')).cookie;
  member = (await f.session('cancel-member')).cookie;
  for (const [code, scope] of [
    ['customer.read', 'AGENCY'],
    ['policy.read', 'AGENCY'],
    ['policy.update', 'AGENCY'],
    ['renewal.read', 'AGENCY'],
    ['renewal.close_lost', 'AGENCY'],
    ['renewal.void', 'AGENCY'],
    ['task.read', 'ASSIGNED'],
    ['task.update', 'ASSIGNED'],
  ])
    await f.db
      .prepare(
        'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
      )
      .bind(crypto.randomUUID(), 'membership-cancel-member', code, scope)
      .run();
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('cancel-i','agency-auth-test','CAN','Sentetik Şirket')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name) VALUES('cancel-b','agency-auth-test','CAN','Kasko')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('cancel-pr','agency-auth-test','cancel-i','cancel-b','CAN','Ürün')",
    ),
    f.db.prepare(
      "INSERT INTO payment_methods(id,agency_id,code,name) VALUES('cancel-pay','agency-auth-test','CAN','Nakit')",
    ),
    f.db.prepare(
      "INSERT INTO loss_reasons(id,agency_id,code,name) VALUES('cancel-sale','agency-auth-test','VEHICLE_SOLD','Araç satıldı')",
    ),
    f.db.prepare(
      "INSERT INTO loss_reasons(id,agency_id,code,name) VALUES('cancel-other-reason','agency-auth-test','OTHER','Diğer')",
    ),
  ]);
  const c = await write('/api/customers', {
    type: 'INDIVIDUAL',
    firstName: 'İptal',
    lastName: 'Sentetik',
    insurerNumber: { insurerId: 'cancel-i', customerNumber: '000-CANCEL' },
  });
  expect(c.status).toBe(201);
  customerId = ((await c.json()) as { data: { id: string } }).data.id;
}, 180000);
afterAll(async () => {
  await f?.mf.dispose();
});
async function write(
  path: string,
  body: unknown,
  key = crypto.randomUUID(),
  cookie = owner,
  method = 'POST',
) {
  return f.request(path, method, cookie, body, await f.csrf(cookie), { 'idempotency-key': key });
}
async function make(open = false) {
  const response = await write('/api/policies', {
    customerId,
    insurerId: 'cancel-i',
    productId: 'cancel-pr',
    branchId: 'cancel-b',
    paymentMethodId: 'cancel-pay',
    policyNumber: 'CANCEL-' + ++serial,
    startDate: agencyDateAfter(-180),
    endDate: agencyDateAfter(open ? expiringPolicyDays : 365),
    grossPremium: '1234.56',
    currency: 'TRY',
    installmentCount: null,
  });
  expect(response.status, await response.clone().text()).toBe(201);
  return ((await response.json()) as { data: { id: string; version: number } }).data;
}
async function context(id: string, kind = 'cancel', cookie = owner) {
  const r = await f.request(
    `/api/policies/${id}/${kind === 'cancel' ? 'cancellation-context' : 'void-context'}`,
    'GET',
    cookie,
  );
  expect(r.status, await r.clone().text()).toBe(200);
  return ((await r.json()) as { data: Record<string, unknown> }).data;
}
function input(c: Record<string, unknown>, kind = 'cancel') {
  return {
    expectedPolicyVersion: c.policyVersion,
    cancellationDate,
    reasonCode: kind === 'cancel' ? 'VEHICLE_SOLD' : 'DUPLICATE',
    reasonNotes: null,
    targetSetFingerprint: c.targetSetFingerprint,
    ...(c.expectedRenewal
      ? {
          expectedRenewal: c.expectedRenewal,
          ...(kind === 'cancel' ? { lossReasonId: 'cancel-sale' } : {}),
        }
      : {}),
  };
}
it('cancels with evidence, preserves unrelated work and exactly replays without duplicate history', async () => {
  const p = await make(),
    c = await context(p.id),
    body = input(c),
    key = crypto.randomUUID();
  const r = await write(`/api/policies/${p.id}/cancel`, body, key);
  expect(r.status, await r.clone().text()).toBe(200);
  const result = ((await r.json()) as { data: Record<string, unknown> }).data;
  expect(result).toMatchObject({
    policyId: p.id,
    status: 'CANCELLED',
    policyVersion: 2,
    closedRenewalId: null,
    completedTaskId: null,
  });
  expect(await (await write(`/api/policies/${p.id}/cancel`, body, key)).json()).toMatchObject({
    data: result,
    replayed: true,
  });
  expect(
    (await write(`/api/policies/${p.id}/cancel`, { ...body, reasonNotes: 'changed' }, key)).status,
  ).toBe(409);
  expect((await write(`/api/policies/${p.id}/cancel`, body)).status).toBe(409);
  const h = await f.request(`/api/policies/${p.id}/cancellations`, 'GET', owner);
  expect(await h.json()).toMatchObject({
    data: [{ reasonCode: 'VEHICLE_SOLD', eventDate: cancellationDate, status: 'CANCELLED' }],
  });
  expect(
    (await f.db
      .prepare('SELECT count(*) n FROM policy_cancellations WHERE policy_id=?')
      .bind(p.id)
      .first<{ n: number }>())!.n,
  ).toBe(1);
  await expect(
    f.db
      .prepare("UPDATE policies SET status='ACTIVE',version=version+1 WHERE id=?")
      .bind(p.id)
      .run(),
  ).rejects.toThrow('POLICY_LIFECYCLE_COMMAND_REQUIRED');
  expect(
    (
      await write(
        `/api/policies/${p.id}`,
        { expectedVersion: 2, endDate: agencyDateAfter(364) },
        crypto.randomUUID(),
        owner,
        'PATCH',
      )
    ).status,
  ).toBe(409);
  await expect(
    f.db.prepare('DELETE FROM policy_cancellations WHERE policy_id=?').bind(p.id).run(),
  ).rejects.toThrow('IMMUTABLE_HISTORY');
});
it('closes its real renewal and primary Task atomically, leaving another policy and GENERAL Task intact', async () => {
  const p = await make(true),
    unrelated = await make(true);
  await f.db
    .prepare(
      "INSERT INTO tasks(id,agency_id,customer_id,kind,title,due_at,assignee_membership_id,actor_kind,created_by_user_id,created_by_membership_id) VALUES('cancel-general','agency-auth-test',?,'GENERAL','Bağımsız müşteri takibi','2027-01-01T09:00:00.000Z','membership-cancel-owner','USER','cancel-owner','membership-cancel-owner')",
    )
    .bind(customerId)
    .run();
  const c = await context(p.id);
  expect(c.expectedRenewal).toBeTruthy();
  expect(
    (await f.request(`/api/policies/${p.id}/cancellation-context`, 'GET', member)).status,
  ).toBe(403);
  const r = await write(`/api/policies/${p.id}/cancel`, input(c));
  expect(r.status, await r.clone().text()).toBe(200);
  const result = (
    (await r.json()) as { data: { closedRenewalId: string; completedTaskId: string } }
  ).data;
  expect(
    await f.db
      .prepare('SELECT state FROM renewal_opportunities WHERE id=?')
      .bind(result.closedRenewalId)
      .first(),
  ).toMatchObject({ state: 'LOST' });
  expect(
    await f.db.prepare('SELECT status FROM tasks WHERE id=?').bind(result.completedTaskId).first(),
  ).toMatchObject({ status: 'COMPLETED' });
  expect(
    await f.db.prepare('SELECT status FROM tasks WHERE id=?').bind('cancel-general').first(),
  ).toMatchObject({ status: 'OPEN' });
  expect(
    await f.db.prepare('SELECT status FROM policies WHERE id=?').bind(unrelated.id).first(),
  ).toMatchObject({ status: 'ACTIVE' });
  expect(
    (await f.db
      .prepare(
        'SELECT count(*) n FROM policy_lifecycle_targets WHERE cancellation_id=(SELECT id FROM policy_cancellations WHERE policy_id=?)',
      )
      .bind(p.id)
      .first<{ n: number }>())!.n,
  ).toBe(2);
});
it('rejects stale context, invalid dates/reasons, missing CSRF, oversized JSON and cross agency', async () => {
  const p = await make(),
    c = await context(p.id),
    body = input(c);
  expect(
    (
      await write(`/api/policies/${p.id}/cancel`, {
        ...body,
        cancellationDate: agencyDateAfter(400),
      })
    ).status,
  ).toBe(400);
  expect(
    (await write(`/api/policies/${p.id}/cancel`, { ...body, reasonCode: 'OTHER' })).status,
  ).toBe(400);
  expect(
    (
      await f.request(`/api/policies/${p.id}/cancel`, 'POST', owner, body, undefined, {
        'idempotency-key': crypto.randomUUID(),
      })
    ).status,
  ).toBe(403);
  expect((await f.request(`/api/policies/${p.id}/cancellation-context`, 'GET', other)).status).toBe(
    404,
  );
  expect(
    (await write(`/api/policies/${p.id}/cancel`, { ...body, reasonNotes: 'x'.repeat(17000) }))
      .status,
  ).toBe(413);
  await f.db.prepare('UPDATE policies SET version=version+1 WHERE id=?').bind(p.id).run();
  expect((await write(`/api/policies/${p.id}/cancel`, body)).status).toBe(409);
  expect(
    await f.db.prepare('SELECT status FROM policies WHERE id=?').bind(p.id).first(),
  ).toMatchObject({ status: 'ACTIVE' });
});
it('rolls back policy, renewal, Task, history and receipt on final audit failure', async () => {
  const p = await make(true),
    c = await context(p.id),
    body = input(c),
    key = crypto.randomUUID();
  await f.db.exec(
    "CREATE TRIGGER cancel_fail_audit BEFORE INSERT ON audit_events WHEN NEW.action='policy.cancel' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_FINAL_AUDIT_FAIL'); END;",
  );
  try {
    expect((await write(`/api/policies/${p.id}/cancel`, body, key)).status).toBe(500);
  } finally {
    await f.db.exec('DROP TRIGGER cancel_fail_audit;');
  }
  expect(
    await f.db.prepare('SELECT status,version FROM policies WHERE id=?').bind(p.id).first(),
  ).toMatchObject({ status: 'ACTIVE', version: 1 });
  expect(
    await f.db
      .prepare('SELECT id FROM operation_receipts WHERE idempotency_key=?')
      .bind(key)
      .first(),
  ).toBeNull();
  expect(
    await f.db.prepare('SELECT id FROM policy_cancellations WHERE policy_id=?').bind(p.id).first(),
  ).toBeNull();
  const after = await context(p.id);
  expect(after.expectedRenewal).toEqual(c.expectedRenewal);
});
it('voids a technical duplicate through its own evidence and blocks generic lifecycle writes', async () => {
  const p = await make(true),
    c = await context(p.id, 'void');
  expect(
    (
      await write(
        `/api/policies/${p.id}`,
        { expectedVersion: 1, status: 'CANCELLED' },
        crypto.randomUUID(),
        owner,
        'PATCH',
      )
    ).status,
  ).toBe(409);
  const r = await write(`/api/policies/${p.id}/void`, input(c, 'void'));
  expect(r.status, await r.clone().text()).toBe(200);
  expect(
    await f.db.prepare('SELECT status FROM policies WHERE id=?').bind(p.id).first(),
  ).toMatchObject({ status: 'VOIDED' });
  await expect(
    f.db
      .prepare("UPDATE policies SET status='CANCELLED',version=version+1 WHERE id=?")
      .bind((await make()).id)
      .run(),
  ).rejects.toThrow('POLICY_LIFECYCLE_COMMAND_REQUIRED');
});
it('handles concurrent retries and prevents cancelled policies from being generated again', async () => {
  const p = await make(true),
    c = await context(p.id),
    body = input(c),
    key = crypto.randomUUID();
  const results = await Promise.all([
    write(`/api/policies/${p.id}/cancel`, body, key),
    write(`/api/policies/${p.id}/cancel`, body, key),
  ]);
  expect(results.map((r) => r.status)).toEqual([200, 200]);
  const saved = await results[0]!.json();
  expect(await (await write(`/api/policies/${p.id}/cancel`, body, key)).json()).toMatchObject({
    data: (saved as { data: unknown }).data,
    replayed: true,
  });
  expect(await ensureRenewalForPolicy(f.db, 'agency-auth-test', p.id)).toBe('NOT_ELIGIBLE');
  const second = await make(),
    ctx = await context(second.id),
    payload = input(ctx);
  const race = await Promise.all([
    write(`/api/policies/${second.id}/cancel`, payload),
    write(`/api/policies/${second.id}/cancel`, payload),
  ]);
  expect(race.map((r) => r.status).sort()).toEqual([200, 409]);
});
it('rejects a new cron-created target after context, and blocks HEALTH even for an ungranted owner', async () => {
  await f.db
    .prepare(
      "INSERT INTO agency_settings(id,agency_id,renewal_window_days) VALUES('cancel-settings','agency-auth-test',1) ON CONFLICT(agency_id) DO UPDATE SET renewal_window_days=1",
    )
    .run();
  const p = await make(true),
    c = await context(p.id);
  expect(c.expectedRenewal).toBeUndefined();
  await f.db
    .prepare("UPDATE agency_settings SET renewal_window_days=30 WHERE agency_id='agency-auth-test'")
    .run();
  expect(await ensureRenewalForPolicy(f.db, 'agency-auth-test', p.id)).toBe('CREATED');
  expect((await write(`/api/policies/${p.id}/cancel`, input(c))).status).toBe(409);
  const h = await make();
  // Test-only classification fixture. The production catalog doesn't expose a reclassification action.
  await f.db
    .prepare("UPDATE insurance_branches SET data_classification='HEALTH' WHERE id='cancel-b'")
    .run();
  try {
    expect(
      (await f.request(`/api/policies/${h.id}/cancellation-context`, 'GET', owner)).status,
    ).toBe(403);
  } finally {
    await f.db
      .prepare("UPDATE insurance_branches SET data_classification='GENERAL' WHERE id='cancel-b'")
      .run();
  }
});
it('preserves a real WON renewal and its issued policy when cancelling the expiring source', async () => {
  const old = await make(true),
    ctx = await context(old.id),
    t = ctx.expectedRenewal as {
      id: string;
      version: number;
      primaryTaskId: string;
      taskVersion: number;
    };
  const won = await write(`/api/renewals/${t.id}/close-won`, {
    expectedPrimaryTaskId: t.primaryTaskId,
    expectedRenewalVersion: t.version,
    expectedTaskVersion: t.taskVersion,
    result: {
      kind: 'CREATE_POLICY',
      policy: {
        customerId,
        insurerId: 'cancel-i',
        productId: 'cancel-pr',
        branchId: 'cancel-b',
        paymentMethodId: 'cancel-pay',
        policyNumber: 'CANCEL-WON-' + ++serial,
        startDate: agencyDateAfter(expiringPolicyDays + 1),
        endDate: agencyDateAfter(expiringPolicyDays + 365),
        grossPremium: '1234.56',
        currency: 'TRY',
        installmentCount: null,
        status: 'ACTIVE',
      },
    },
  });
  expect(won.status, await won.clone().text()).toBe(201);
  const issued = ((await won.json()) as { data: { createdPolicyId: string } }).data.createdPolicyId;
  const before = await f.db
    .prepare('SELECT * FROM renewal_opportunities WHERE id=?')
    .bind(t.id)
    .first();
  const closed = await context(old.id);
  expect(closed.expectedRenewal).toBeUndefined();
  const r = await write(`/api/policies/${old.id}/cancel`, input(closed));
  expect(r.status, await r.clone().text()).toBe(200);
  expect(
    await f.db.prepare('SELECT * FROM renewal_opportunities WHERE id=?').bind(t.id).first(),
  ).toEqual(before);
  expect(
    await f.db.prepare('SELECT status FROM policies WHERE id=?').bind(issued).first(),
  ).toMatchObject({ status: 'ACTIVE' });
});
it('validates imported evidence and rejects forged or missing targets despite a recomputed export checksum', async () => {
  const query = async (sql: string) =>
    (await f.db.prepare(sql).all<Record<string, unknown>>()).results;
  await expect(verifyPolicyLifecycleRecovery(query)).resolves.toBeUndefined();
  await expect(
    verifyPolicyLifecycleRecovery(async (sql) =>
      sql === 'SELECT * FROM policy_lifecycle_targets' ? [] : query(sql),
    ),
  ).rejects.toThrow('OPERATIONAL_RECOVERY_INVALID');
  await expect(
    verifyPolicyLifecycleRecovery(async (sql) => {
      const rows = await query(sql);
      return sql.includes("SELECT *,'CANCELLED'")
        ? rows.map((r, i) => (i ? r : { ...r, event_date: agencyDateAfter(-8) }))
        : rows;
    }),
  ).rejects.toThrow('OPERATIONAL_RECOVERY_INVALID');
});
it('rechecks a permission/session revocation in the final batch and writes no partial cancellation', async () => {
  const p = await make(),
    ctx = await context(p.id, 'cancel', member),
    csrf = await f.csrf(member),
    key = crypto.randomUUID(),
    original = f.env.DB;
  let intercepted = false;
  f.env.DB = {
    prepare: original.prepare.bind(original),
    batch: async (statements: D1PreparedStatement[]) => {
      if (!intercepted) {
        intercepted = true;
        await original
          .prepare(
            "DELETE FROM membership_permissions WHERE membership_id='membership-cancel-member' AND permission_code='policy.update'",
          )
          .run();
        await original
          .prepare(
            "UPDATE agency_memberships SET permission_version=permission_version+1,version=version+1 WHERE id='membership-cancel-member'",
          )
          .run();
      }
      return original.batch(statements);
    },
  } as D1Database;
  try {
    const r = await f.request(`/api/policies/${p.id}/cancel`, 'POST', member, input(ctx), csrf, {
      'idempotency-key': key,
    });
    expect(intercepted).toBe(true);
    expect(r.status, await r.clone().text()).toBe(403);
  } finally {
    f.env.DB = original;
  }
  expect(
    await f.db.prepare('SELECT status,version FROM policies WHERE id=?').bind(p.id).first(),
  ).toMatchObject({ status: 'ACTIVE', version: 1 });
  expect(
    await f.db
      .prepare('SELECT id FROM operation_receipts WHERE idempotency_key=?')
      .bind(key)
      .first(),
  ).toBeNull();
  expect(
    await f.db.prepare('SELECT id FROM policy_cancellations WHERE policy_id=?').bind(p.id).first(),
  ).toBeNull();
});
