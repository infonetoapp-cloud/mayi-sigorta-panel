// @vitest-environment node
import { beforeAll, afterAll, it, expect } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import { createOnboardingTemplateGrants } from '../src/shared/permissions';
import { ensureRenewalForPolicy } from '../src/server/renewals/generation';
let f: Awaited<ReturnType<typeof localAuthFixture>>;
const cookies: Record<string, string> = {},
  renewals: Record<string, string> = {};
let company = '',
  contact: { id: string; version: number },
  foreignContact: string;
async function data<T>(r: Response, status = 200): Promise<T> {
  expect(r.status).toBe(status);
  return ((await r.json()) as { data: T }).data;
}
async function post(path: string, body: unknown, actor = 'ix-owner', key = crypto.randomUUID()) {
  return f.request(path, 'POST', cookies[actor], body, await f.csrf(cookies[actor]!), {
    'idempotency-key': key,
  });
}
const body = (
  outcome = 'CONTACT_CONFIRMED',
  channel = 'PHONE',
  occurredAt = '2026-10-14T10:00:00.000Z',
) => ({
  outcome,
  channel,
  occurredAt,
  companyContactId: null as string | null,
  note: outcome === 'NOTE' ? 'Sentetik iç not' : null,
});
const path = (id: string) => '/api/renewals/' + id + '/interactions';
async function history(id = renewals['ix-owner']!, actor = 'ix-owner') {
  return data<{
    interactions: {
      id: string;
      outcome: string;
      channel: string;
      occurred_at: string;
      note: string | null;
      author_name: string | null;
    }[];
    lastContactAt: string | null;
    lastAttemptAt: string | null;
    customerType: string;
    companyContacts: { id: string; displayName: string }[];
  }>(await f.request(path(id), 'GET', cookies[actor]));
}
async function snapshot() {
  const result: Record<string, unknown> = {};
  for (const table of [
    'renewal_interactions',
    'renewal_opportunities',
    'tasks',
    'operation_receipts',
  ])
    result[table] = (await f.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results;
  result.audit = (
    await f.db.prepare("SELECT * FROM audit_events WHERE outcome='SUCCESS' ORDER BY id").all()
  ).results;
  return JSON.stringify(result);
}
beforeAll(async () => {
  f = await localAuthFixture();
  for (const who of ['ix-owner', 'ix-ahmet', 'ix-ayse', 'ix-foreign']) {
    const member = await f.seed(
      who,
      who === 'ix-owner' || who === 'ix-foreign' ? 'OWNER' : 'MEMBER',
      false,
      who === 'ix-foreign' ? 'ix-foreign-agency' : 'agency-auth-test',
    );
    if (who === 'ix-ahmet' || who === 'ix-ayse')
      await f.db.batch(
        createOnboardingTemplateGrants('personel').map((g) =>
          f.db
            .prepare(
              'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
            )
            .bind(crypto.randomUUID(), member.membershipId, g.permission_code, g.scope),
        ),
      );
    cookies[who] = (await f.session(who)).cookie;
  }
  const individual = (
    await data<{ id: string }>(
      await post('/api/customers', {
        type: 'INDIVIDUAL',
        firstName: 'Sentetik',
        lastName: 'Görüşme',
      }),
      201,
    )
  ).id;
  company = (
    await data<{ id: string }>(
      await post('/api/customers', { type: 'COMPANY', companyTitle: 'Sentetik Görüşme Şirketi' }),
      201,
    )
  ).id;
  contact = await data(
    await post('/api/customers/' + company + '/contacts', {
      firstName: 'Açık',
      lastName: 'Seçim',
      role: 'Finans',
    }),
    201,
  );
  const other = (
    await data<{ id: string }>(
      await post('/api/customers', { type: 'COMPANY', companyTitle: 'Diğer Sentetik Şirket' }),
      201,
    )
  ).id;
  foreignContact = (
    await data<{ id: string }>(
      await post('/api/customers/' + other + '/contacts', {
        firstName: 'Diğer',
        lastName: 'Yetkili',
      }),
      201,
    )
  ).id;
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('ix-i','agency-auth-test','IX','IX')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('ix-b','agency-auth-test','IX','IX','GENERAL')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('ix-p','agency-auth-test','ix-i','ix-b','IX','IX')",
    ),
    f.db.prepare(
      "INSERT INTO payment_methods(id,agency_id,code,name) VALUES('ix-m','agency-auth-test','IX','IX')",
    ),
  ]);
  for (const who of ['ix-owner', 'ix-ahmet', 'ix-ayse', 'company']) {
    const p = await data<{ id: string }>(
      await post(
        '/api/policies',
        {
          customerId: who === 'company' ? company : individual,
          insurerId: 'ix-i',
          branchId: 'ix-b',
          productId: 'ix-p',
          paymentMethodId: 'ix-m',
          policyNumber: 'IX-' + who,
          startDate: '2026-01-01',
          endDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
          grossPremium: '10.00',
          currency: 'TRY',
          installmentCount: null,
        },
        who === 'company' ? 'ix-owner' : who,
      ),
      201,
    );
    renewals[who] = (await f.db
      .prepare('SELECT id FROM renewal_opportunities WHERE expiring_policy_id=?')
      .bind(p.id)
      .first<{ id: string }>())!.id;
  }
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('ix-h','agency-auth-test','H','Health','HEALTH')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('ix-hp','agency-auth-test','ix-i','ix-h','H','Health')",
    ),
    f.db.prepare(
      "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency) SELECT 'ix-health',agency_id,customer_id,insurer_id,'ix-hp','ix-h',payment_method_id,assignee_membership_id,'HIDDEN-HEALTH','HIDDENHEALTH',start_date,end_date,gross_premium_minor,currency FROM policies WHERE policy_number='IX-ix-owner'",
    ),
  ]);
  await ensureRenewalForPolicy(f.db, 'agency-auth-test', 'ix-health');
  renewals.health = (await f.db
    .prepare("SELECT id FROM renewal_opportunities WHERE expiring_policy_id='ix-health'")
    .first<{ id: string }>())!.id;
}, 90000);
afterAll(async () => {
  await f?.mf.dispose();
});
it('authorizes OWNER/Ahmet/Ayşe interactions on their real authorized queue tasks independently of quote reads', async () => {
  for (const who of ['ix-owner', 'ix-ahmet', 'ix-ayse']) {
    const queue = await data<{ items: { renewalId: string }[] }>(
      await f.request('/api/tasks/today', 'GET', cookies[who]),
    );
    expect(queue.items.some((t) => t.renewalId === renewals[who])).toBe(true);
    expect((await history(renewals[who], who)).customerType).toBe('INDIVIDUAL');
  }
  const grants = await f.db
    .prepare(
      "SELECT id,permission_code,scope FROM membership_permissions WHERE membership_id='membership-ix-ahmet' AND permission_code LIKE 'quote.%'",
    )
    .all<{ id: string; permission_code: string; scope: string }>();
  expect(grants.results.length).toBeGreaterThan(0);
  await f.db
    .prepare(
      "DELETE FROM membership_permissions WHERE membership_id='membership-ix-ahmet' AND permission_code LIKE 'quote.%'",
    )
    .run();
  try {
    expect(
      (
        await f.request(
          '/api/renewals/' + renewals['ix-ahmet'] + '/quotes',
          'GET',
          cookies['ix-ahmet'],
        )
      ).status,
    ).toBe(403);
    expect((await history(renewals['ix-ahmet'], 'ix-ahmet')).interactions).toEqual([]);
    expect(
      (await post(path(renewals['ix-ahmet']!), body('ATTEMPT_NO_RESPONSE', 'EMAIL'), 'ix-ahmet'))
        .status,
    ).toBe(201);
  } finally {
    await f.db.batch(
      grants.results.map((grant) =>
        f.db
          .prepare(
            "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,'membership-ix-ahmet',?,?)",
          )
          .bind(grant.id, grant.permission_code, grant.scope),
      ),
    );
  }
});
it('does not derive interaction authority from task visibility or quote authority', async () => {
  const grants = await f.db
    .prepare(
      "SELECT id,permission_code,scope FROM membership_permissions WHERE membership_id='membership-ix-ayse' AND permission_code LIKE 'interaction.%'",
    )
    .all<{ id: string; permission_code: string; scope: string }>();
  expect(grants.results.length).toBeGreaterThan(0);
  await f.db
    .prepare(
      "DELETE FROM membership_permissions WHERE membership_id='membership-ix-ayse' AND permission_code LIKE 'interaction.%'",
    )
    .run();
  try {
    const before = await snapshot();
    expect((await f.request('/api/tasks/today', 'GET', cookies['ix-ayse'])).status).toBe(200);
    expect(
      (
        await f.request(
          '/api/renewals/' + renewals['ix-ayse'] + '/quotes',
          'GET',
          cookies['ix-ayse'],
        )
      ).status,
    ).toBe(200);
    for (const r of [
      await f.request(path(renewals['ix-ayse']!), 'GET', cookies['ix-ayse']),
      await post(path(renewals['ix-ayse']!), body(), 'ix-ayse'),
    ]) {
      expect(r.status).toBe(403);
      expect(await r.json()).not.toHaveProperty('data');
    }
    expect(await snapshot()).toBe(before);
  } finally {
    await f.db.batch(
      grants.results.map((grant) =>
        f.db
          .prepare(
            "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,'membership-ix-ayse',?,?)",
          )
          .bind(grant.id, grant.permission_code, grant.scope),
      ),
    );
  }
});
it('keeps confirmed contact separate from unanswered WhatsApp attempts and internal notes with recorded author', async () => {
  await data(await post(path(renewals['ix-owner']!), body()), 201);
  await data(
    await post(
      path(renewals['ix-owner']!),
      body('ATTEMPT_NO_RESPONSE', 'WHATSAPP', '2026-10-15T10:00:00.000Z'),
    ),
    201,
  );
  await data(
    await post(path(renewals['ix-owner']!), body('NOTE', 'OTHER', '2026-10-16T10:00:00.000Z')),
    201,
  );
  const h = await history();
  expect(h.lastContactAt).toBe('2026-10-14T10:00:00.000Z');
  expect(h.lastAttemptAt).toBe('2026-10-15T10:00:00.000Z');
  expect(h.interactions).toHaveLength(3);
  expect(h.interactions.every((i) => i.author_name !== null)).toBe(true);
  expect(h.interactions[2]!.note).toBe('Sentetik iç not');
});
it('rejects generic WhatsApp-open, invalid note/channel/timestamp and invented CAS fields without evidence', async () => {
  const before = await snapshot();
  for (const b of [
    { ...body(), outcome: 'WHATSAPP_OPENED', channel: 'WHATSAPP' },
    { ...body('NOTE'), channel: 'PHONE' },
    { ...body('NOTE', 'OTHER'), note: ' ' },
    { ...body(), note: 'not allowed' },
    { ...body(), occurredAt: '2026-10-14T13:00:00+03:00' },
    { ...body(), expectedVersion: 1 },
  ])
    expect((await post(path(renewals['ix-owner']!), b)).status).toBe(400);
  expect(await snapshot()).toBe(before);
});
it('replays the exact original occurrence/key without another interaction, receipt or successful audit', async () => {
  const key = crypto.randomUUID(),
    b = body('NOTE', 'OTHER', '2026-10-16T11:00:00.000Z');
  const first = await data(await post(path(renewals['ix-owner']!), b, 'ix-owner', key), 201),
    before = await snapshot();
  expect(await data(await post(path(renewals['ix-owner']!), b, 'ix-owner', key))).toEqual(first);
  expect(
    (await post(path(renewals['ix-owner']!), { ...b, note: 'changed' }, 'ix-owner', key)).status,
  ).toBe(409);
  expect(await snapshot()).toBe(before);
});
it('requires an explicit owned active company contact and preserves historical replay after contact deactivation', async () => {
  const id = renewals.company!,
    before = await snapshot();
  expect((await history(id)).companyContacts.map((c) => c.id)).toContain(contact.id);
  for (const companyContactId of [null, foreignContact])
    expect((await post(path(id), { ...body(), companyContactId })).status).toBe(409);
  expect(await snapshot()).toBe(before);
  const key = crypto.randomUUID(),
    b = { ...body(), companyContactId: contact.id };
  const saved = await data(await post(path(id), b, 'ix-owner', key), 201);
  await data(
    await post('/api/customers/' + company + '/contacts/' + contact.id + '/deactivate', {
      expectedVersion: contact.version,
    }),
  );
  expect((await history(id)).companyContacts).toEqual([]);
  const after = await snapshot();
  expect((await post(path(id), { ...b, occurredAt: '2026-10-14T11:00:00.000Z' })).status).toBe(409);
  expect(await data(await post(path(id), b, 'ix-owner', key))).toEqual(saved);
  expect(await snapshot()).toBe(after);
});
it('does not accept a company contact on an individual renewal', async () => {
  const before = await snapshot();
  expect(
    (await post(path(renewals['ix-owner']!), { ...body(), companyContactId: foreignContact }))
      .status,
  ).toBe(409);
  expect(await snapshot()).toBe(before);
});
it('denies cross-agency and HEALTH reads/writes without disclosing history', async () => {
  const before = await snapshot();
  for (const [id, actor, status] of [
    [renewals['ix-owner']!, 'ix-foreign', 404],
    [renewals.health!, 'ix-owner', 403],
  ] as const) {
    for (const r of [
      await f.request(path(id), 'GET', cookies[actor]),
      await post(path(id), body(), actor),
    ]) {
      expect(r.status).toBe(status);
      expect(await r.json()).not.toHaveProperty('data');
    }
  }
  expect(await snapshot()).toBe(before);
});
it('rejects revoked write permission and revoked sessions under current authority', async () => {
  await f.db
    .prepare(
      "DELETE FROM membership_permissions WHERE membership_id='membership-ix-ahmet' AND permission_code='interaction.create'",
    )
    .run();
  const before = await snapshot();
  expect((await history(renewals['ix-ahmet'], 'ix-ahmet')).interactions).toHaveLength(1);
  expect((await post(path(renewals['ix-ahmet']!), body(), 'ix-ahmet')).status).toBe(403);
  expect(await snapshot()).toBe(before);
  const csrf = await f.csrf(cookies['ix-ayse']!);
  await f.db
    .prepare("UPDATE local_sessions SET revoked_at=? WHERE user_id='ix-ayse'")
    .bind(Date.now())
    .run();
  expect((await f.request(path(renewals['ix-ayse']!), 'GET', cookies['ix-ayse'])).status).toBe(401);
  expect(
    (
      await f.request(path(renewals['ix-ayse']!), 'POST', cookies['ix-ayse'], body(), csrf, {
        'idempotency-key': crypto.randomUUID(),
      })
    ).status,
  ).toBe(401);
  expect(await snapshot()).toBe(before);
});
