// @vitest-environment node
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { z } from 'zod';
import { createRenewalQuoteVersionSchema } from '../src/server/renewals/validation';
import type { TodayTasksResponseData } from '../src/shared/types';
import { createOnboardingTemplateGrants } from '../src/shared/permissions';
import { localAuthFixture } from './support/local-auth-fixture';

type Version = z.infer<typeof createRenewalQuoteVersionSchema>['version'];
type Result = {
  operationId: string;
  quoteId: string;
  quoteVersionId: string;
  versionNumber: number;
  status: string;
};
type Quote = {
  id: string;
  version: number;
  status: string;
  current_version_id: string;
  versions: Record<string, unknown>[];
  events: { id: string; event: string; quote_version_id: string; operation_receipt_id: string }[];
};
let f: Awaited<ReturnType<typeof localAuthFixture>>,
  customerId = '',
  serial = 0;
const cookies: Record<string, string> = {};
async function data<T>(r: Response, status = 200): Promise<T> {
  expect(r.status).toBe(status);
  return ((await r.json()) as { data: T }).data;
}
async function post(url: string, body: unknown, actor = 'qs-owner', key = crypto.randomUUID()) {
  return f.request(url, 'POST', cookies[actor], body, await f.csrf(cookies[actor]!), {
    'idempotency-key': key,
  });
}
async function history(url: string, actor = 'qs-owner') {
  return data<{ quotes: Quote[]; defaultVersion: Version }>(
    await f.request(url, 'GET', cookies[actor]),
  );
}
async function seed(actor = 'qs-owner', validity?: string) {
  const policy = await data<{ id: string }>(
    await post('/api/policies', {
      customerId,
      insurerId: 'qs-i',
      productId: 'qs-p',
      branchId: 'qs-b',
      paymentMethodId: 'qs-m',
      policyNumber: `QS-${++serial}`,
      startDate: '2026-01-01',
      endDate: new Date(Date.now() + 5 * 86400000).toISOString().slice(0, 10),
      grossPremium: '10.00',
      currency: 'TRY',
      installmentCount: null,
      assigneeMembershipId: 'membership-' + actor,
    }),
    201,
  );
  const task = (
    await data<TodayTasksResponseData>(
      await f.request('/api/tasks/today?limit=50', 'GET', cookies['qs-owner']),
    )
  ).items.find((t) => t.policyId === policy.id)!;
  const url = `/api/renewals/${task.renewalId}/quotes`;
  const defaults = (await history(url)).defaultVersion;
  const version = { ...defaults, ...(validity ? { validUntil: validity } : {}) };
  const created = await data<Result>(
    await post(url, { expectedRenewalVersion: task.renewalVersion, version }, actor),
    201,
  );
  return {
    url,
    task,
    version,
    created,
    sendUrl: `${url}/${created.quoteId}/send`,
    body: { expectedQuoteVersion: 1, quoteVersionId: created.quoteVersionId },
  };
}
async function snapshot() {
  const state: Record<string, unknown> = {};
  for (const table of [
    'renewal_quotes',
    'renewal_quote_versions',
    'renewal_quote_events',
    'operation_receipts',
    'audit_events',
    'renewal_opportunities',
    'tasks',
    'd1_cas_assertions',
  ])
    state[table] = (await f.db.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results;
  return JSON.stringify(state);
}
async function counts() {
  const state: Record<string, number> = {};
  for (const table of ['renewal_quote_events', 'operation_receipts', 'audit_events'])
    state[table] = (await f.db
      .prepare(`SELECT count(*) AS n FROM ${table}`)
      .first<{ n: number }>())!.n;
  return state;
}
beforeAll(async () => {
  f = await localAuthFixture();
  for (const actor of ['qs-owner', 'qs-ahmet', 'qs-ayse', 'qs-foreign']) {
    const member = await f.seed(
      actor,
      actor === 'qs-owner' || actor === 'qs-foreign' ? 'OWNER' : 'MEMBER',
      false,
      actor === 'qs-foreign' ? 'qs-other-agency' : 'agency-auth-test',
    );
    if (actor === 'qs-ahmet' || actor === 'qs-ayse')
      await f.db.batch(
        createOnboardingTemplateGrants('personel').map((g) =>
          f.db
            .prepare(
              'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
            )
            .bind(crypto.randomUUID(), member.membershipId, g.permission_code, g.scope),
        ),
      );
    cookies[actor] = (await f.session(actor)).cookie;
  }
  customerId = (
    await data<{ id: string }>(
      await post('/api/customers', {
        type: 'INDIVIDUAL',
        firstName: 'Sentetik',
        lastName: 'Gönderildi',
      }),
      201,
    )
  ).id;
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('qs-i','agency-auth-test','QS','Sentetik')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('qs-b','agency-auth-test','QS','Sentetik','GENERAL')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('qs-p','agency-auth-test','qs-i','qs-b','QS','Sentetik')",
    ),
    f.db.prepare(
      "INSERT INTO payment_methods(id,agency_id,code,name) VALUES('qs-m','agency-auth-test','QS','Sentetik')",
    ),
  ]);
}, 90000);
afterAll(async () => {
  await f?.mf.dispose();
});

it.each(['qs-owner', 'qs-ahmet', 'qs-ayse'])(
  'records DRAFT to SENT with immutable current-version and exact receipt/event/audit evidence for %s',
  async (actor) => {
    const s = await seed(actor),
      before = (await history(s.url, actor)).quotes[0]!;
    const key = crypto.randomUUID(),
      result = await data<Result>(await post(s.sendUrl, s.body, actor, key), 201);
    expect(result).toMatchObject({
      quoteId: s.created.quoteId,
      quoteVersionId: s.created.quoteVersionId,
      versionNumber: 1,
      status: 'SENT',
    });
    const q = (await history(s.url, actor)).quotes[0]!;
    expect(q.version).toBe(2);
    expect(q.status).toBe('SENT');
    expect(q.current_version_id).toBe(s.created.quoteVersionId);
    expect(q.versions).toEqual(before.versions);
    expect(q.events).toHaveLength(1);
    expect(q.events[0]).toMatchObject({
      event: 'SENT',
      quote_version_id: result.quoteVersionId,
      operation_receipt_id: result.operationId,
    });
    const receipt = await f.db
      .prepare('SELECT id,action,idempotency_key,response_body FROM operation_receipts WHERE id=?')
      .bind(result.operationId)
      .first<{ id: string; action: string; idempotency_key: string; response_body: string }>();
    expect(receipt).toMatchObject({
      id: result.operationId,
      action: 'renewal.quote.send',
      idempotency_key: key,
    });
    expect(JSON.parse(receipt!.response_body)).toEqual(result);
    expect(
      (await f.db
        .prepare(
          "SELECT count(*) AS n FROM audit_events WHERE action='renewal.quote.sent' AND idempotency_key=? AND outcome='SUCCESS'",
        )
        .bind(key)
        .first<{ n: number }>())!.n,
    ).toBe(1);
    const after = await snapshot();
    expect(await data<Result>(await post(s.sendUrl, s.body, actor, key))).toEqual(result);
    expect(await snapshot()).toBe(after);
  },
);
it('records READY to SENT using quote CAS independently from immutable version_number', async () => {
  const s = await seed();
  await f.db
    .prepare("UPDATE renewal_quotes SET status='READY',version=7 WHERE id=?")
    .bind(s.created.quoteId)
    .run();
  const result = await data<Result>(
    await post(s.sendUrl, { ...s.body, expectedQuoteVersion: 7 }),
    201,
  );
  expect(result.versionNumber).toBe(1);
  expect((await history(s.url)).quotes[0]).toMatchObject({
    version: 8,
    status: 'SENT',
    current_version_id: s.created.quoteVersionId,
  });
});
it('rejects an expired immutable version without any receipt, event, pointer or success audit', async () => {
  const until = new Date(Date.now() + 60000).toISOString(),
    s = await seed('qs-owner', until),
    before = await snapshot();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(until) + 1);
  try {
    expect((await post(s.sendUrl, s.body)).status).toBe(409);
  } finally {
    clock.mockRestore();
  }
  expect(await snapshot()).toBe(before);
});
it('rejects expiry after preflight at the atomic send boundary without receipt/event/audit effects', async () => {
  const until = new Date(Date.now() + 60000).toISOString(),
    s = await seed('qs-owner', until),
    db = f.env.DB,
    before = await snapshot();
  let crossed = false;
  f.env.DB = new Proxy(db, {
    get(target, key) {
      if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (statements.length >= 7 && !crossed) {
            crossed = true;
            // Real elapsed time, not mocked D1 SQL or a forged expired immutable row.
            await new Promise((resolve) =>
              setTimeout(resolve, Math.max(0, Date.parse(until) - Date.now() + 100)),
            );
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    const r = await post(s.sendUrl, s.body);
    const q = (await history(s.url)).quotes[0]!;
    expect({
      status: r.status,
      quoteStatus: q.status,
      cas: q.version,
      eventCount: q.events.length,
    }).toEqual({ status: 409, quoteStatus: 'DRAFT', cas: 1, eventCount: 0 });
    expect(crossed).toBe(true);
    expect(await snapshot()).toBe(before);
  } finally {
    f.env.DB = db;
  }
}, 90000);
it.each(['SENT', 'REJECTED', 'EXPIRED'])(
  'rejects a fresh send for %s without persisted effects',
  async (status) => {
    const s = await seed();
    if (status === 'SENT') await data(await post(s.sendUrl, s.body), 201);
    else
      await f.db
        .prepare('UPDATE renewal_quotes SET status=? WHERE id=?')
        .bind(status, s.created.quoteId)
        .run();
    const q = (await history(s.url)).quotes[0]!,
      before = await snapshot();
    expect((await post(s.sendUrl, { ...s.body, expectedQuoteVersion: q.version })).status).toBe(
      409,
    );
    expect(await snapshot()).toBe(before);
  },
);
it('rejects stale CAS, non-current historical version, wrong renewal and extra request fields without writes', async () => {
  const s = await seed(),
    other = await seed();
  const next = await data<Result>(
    await post(`${s.url}/${s.created.quoteId}/versions`, {
      expectedQuoteVersion: 1,
      version: { ...s.version, grossPremiumMinor: 1234 },
    }),
    201,
  );
  for (const [url, body, status] of [
    [s.sendUrl, { expectedQuoteVersion: 1, quoteVersionId: next.quoteVersionId }, 409],
    [s.sendUrl, { expectedQuoteVersion: 2, quoteVersionId: s.created.quoteVersionId }, 409],
    [
      `${other.url}/${s.created.quoteId}/send`,
      { expectedQuoteVersion: 2, quoteVersionId: next.quoteVersionId },
      404,
    ],
    [
      s.sendUrl,
      { expectedQuoteVersion: 2, quoteVersionId: next.quoteVersionId, deliveryChannel: 'EMAIL' },
      400,
    ],
  ] as const) {
    const before = await snapshot();
    expect((await post(url, body)).status).toBe(status);
    expect(await snapshot()).toBe(before);
  }
});
it('preserves exact historical SENT replay after a later immutable revision and rejects changed payload for the same key', async () => {
  const s = await seed(),
    key = crypto.randomUUID(),
    result = await data<Result>(await post(s.sendUrl, s.body, 'qs-owner', key), 201);
  const next = await data<Result>(
    await post(`${s.url}/${s.created.quoteId}/versions`, {
      expectedQuoteVersion: 2,
      version: { ...s.version, termsSummary: 'Sonraki revizyon' },
    }),
    201,
  );
  const before = await snapshot();
  expect(await data<Result>(await post(s.sendUrl, s.body, 'qs-owner', key))).toEqual(result);
  expect(
    (
      await post(
        s.sendUrl,
        { expectedQuoteVersion: 3, quoteVersionId: next.quoteVersionId },
        'qs-owner',
        key,
      )
    ).status,
  ).toBe(409);
  expect(await snapshot()).toBe(before);
  const q = (await history(s.url)).quotes[0]!;
  expect(q).toMatchObject({ status: 'DRAFT', version: 3, current_version_id: next.quoteVersionId });
  expect(q.events).toHaveLength(1);
  expect(q.events[0]).toMatchObject({
    operation_receipt_id: result.operationId,
    quote_version_id: result.quoteVersionId,
    event: 'SENT',
  });
});
it('keeps independent quote.read and quote.manage boundaries with authorized history but denied status recording', async () => {
  const s = await seed('qs-ahmet');
  for (const removeRead of [false, true]) {
    const rows = (
      await f.db
        .prepare(
          "SELECT permission_code,scope FROM membership_permissions WHERE membership_id='membership-qs-ahmet' AND (permission_code='quote.manage' OR (?=1 AND permission_code='quote.read'))",
        )
        .bind(removeRead ? 1 : 0)
        .all<{ permission_code: string; scope: string }>()
    ).results;
    for (const g of rows)
      await f.db
        .prepare(
          "DELETE FROM membership_permissions WHERE membership_id='membership-qs-ahmet' AND permission_code=?",
        )
        .bind(g.permission_code)
        .run();
    try {
      const before = await snapshot();
      const read = await f.request(s.url, 'GET', cookies['qs-ahmet']);
      if (removeRead) expect([403, 404]).toContain(read.status);
      else expect(read.status).toBe(200);
      expect([403, 404]).toContain((await post(s.sendUrl, s.body, 'qs-ahmet')).status);
      expect(await snapshot()).toBe(before);
    } finally {
      for (const g of rows)
        await f.db
          .prepare(
            'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
          )
          .bind(crypto.randomUUID(), 'membership-qs-ahmet', g.permission_code, g.scope)
          .run();
    }
  }
});
it('denies foreign agency, HEALTH without explicit authority and revoked sessions without successful evidence', async () => {
  const s = await seed(),
    before = await snapshot();
  expect([403, 404]).toContain((await f.request(s.url, 'GET', cookies['qs-foreign'])).status);
  expect([403, 404]).toContain((await post(s.sendUrl, s.body, 'qs-foreign')).status);
  expect(await snapshot()).toBe(before);
  await f.db
    .prepare("UPDATE insurance_branches SET data_classification='HEALTH' WHERE id='qs-b'")
    .run();
  try {
    const state = await snapshot();
    expect([403, 404]).toContain((await post(s.sendUrl, s.body)).status);
    expect([403, 404]).toContain((await f.request(s.url, 'GET', cookies['qs-owner'])).status);
    expect(await snapshot()).toBe(state);
  } finally {
    await f.db
      .prepare("UPDATE insurance_branches SET data_classification='GENERAL' WHERE id='qs-b'")
      .run();
  }
  const session = await f.session('qs-ayse'),
    token = await f.csrf(session.cookie);
  await f.db
    .prepare('UPDATE local_sessions SET revoked_at=? WHERE token_hash=?')
    .bind(Date.now(), session.hash)
    .run();
  const state = await snapshot();
  expect(
    (
      await f.request(s.sendUrl, 'POST', session.cookie, s.body, token, {
        'idempotency-key': crypto.randomUUID(),
      })
    ).status,
  ).toBe(401);
  expect(await snapshot()).toBe(state);
});
async function barrier(work: () => Promise<Response[]>) {
  const db = f.env.DB;
  let arrivals = 0,
    release!: () => void;
  const gate = new Promise<void>((r) => {
    release = r;
  });
  f.env.DB = new Proxy(db, {
    get(target, key) {
      if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (statements.length >= 7 && arrivals < 2) {
            if (++arrivals === 2) release();
            await gate;
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    const value = await work();
    expect(arrivals).toBe(2);
    return value;
  } finally {
    f.env.DB = db;
  }
}
it.each([true, false])(
  'serializes concurrent sends with one SENT event and no orphan receipt/audit (same key: %s)',
  async (sameKey) => {
    const s = await seed(),
      key = crypto.randomUUID(),
      before = await counts();
    const responses = await barrier(() =>
      Promise.all([
        post(s.sendUrl, s.body, 'qs-owner', key),
        post(s.sendUrl, s.body, 'qs-owner', sameKey ? key : crypto.randomUUID()),
      ]),
    );
    expect(responses.map((r) => r.status).sort()).toEqual(sameKey ? [200, 201] : [201, 409]);
    if (sameKey) {
      const a = (await responses[0]!.json()) as { data: Result },
        b = (await responses[1]!.json()) as { data: Result };
      expect(a.data).toEqual(b.data);
    }
    const after = await counts();
    for (const t of Object.keys(before)) expect(after[t]).toBe(before[t]! + 1);
    const q = (await history(s.url)).quotes[0]!;
    expect(q.status).toBe('SENT');
    expect(q.version).toBe(2);
    expect(q.events).toHaveLength(1);
    expect(q.versions).toHaveLength(1);
  },
);
it('serializes a send against a competing new version with exactly one committed operation', async () => {
  const s = await seed(),
    before = await counts(),
    original = JSON.stringify((await history(s.url)).quotes[0]!.versions[0]);
  const responses = await barrier(() =>
    Promise.all([
      post(s.sendUrl, s.body),
      post(`${s.url}/${s.created.quoteId}/versions`, {
        expectedQuoteVersion: 1,
        version: { ...s.version, termsSummary: 'Eşzamanlı revizyon' },
      }),
    ]),
  );
  expect(responses.map((r) => r.status).sort()).toEqual([201, 409]);
  const q = (await history(s.url)).quotes[0]!,
    after = await counts();
  expect(after.operation_receipts).toBe(before.operation_receipts! + 1);
  expect(after.audit_events).toBe(before.audit_events! + 1);
  expect(JSON.stringify(q.versions[0])).toBe(original);
  expect(q.version).toBe(2);
  if (q.status === 'SENT') {
    expect(q.events).toHaveLength(1);
    expect(q.versions).toHaveLength(1);
  } else {
    expect(q.status).toBe('DRAFT');
    expect(q.events).toHaveLength(0);
    expect(q.versions).toHaveLength(2);
  }
});
it('rejects ACCEPTED but preserves the original SENT receipt after the existing WON protocol', async () => {
  const s = await seed(),
    key = crypto.randomUUID(),
    result = await data<Result>(await post(s.sendUrl, s.body, 'qs-owner', key), 201);
  await data(
    await post(`/api/renewals/${s.task.renewalId}/close-won`, {
      expectedPrimaryTaskId: s.task.taskId,
      expectedRenewalVersion: s.task.renewalVersion,
      expectedTaskVersion: s.task.taskVersion,
      acceptedQuoteVersionId: s.created.quoteVersionId,
      result: {
        kind: 'CREATE_POLICY',
        policy: {
          customerId,
          insurerId: s.version.insurerId,
          productId: s.version.productId,
          branchId: s.version.branchId,
          paymentMethodId: s.version.paymentMethodId,
          policyNumber: `QS-ACCEPTED-${++serial}`,
          startDate: s.version.startDate,
          endDate: s.version.endDate,
          grossPremium: '10.00',
          currency: s.version.currency,
          installmentCount: null,
        },
      },
    }),
    201,
  );
  const q = (await history(s.url)).quotes[0]!;
  expect(q.status).toBe('ACCEPTED');
  const before = await snapshot();
  expect((await post(s.sendUrl, { ...s.body, expectedQuoteVersion: q.version })).status).toBe(409);
  expect(await data<Result>(await post(s.sendUrl, s.body, 'qs-owner', key))).toEqual(result);
  expect(await snapshot()).toBe(before);
});
it('rolls back a status write when current quote.manage is revoked after preflight but before its real D1 batch', async () => {
  const s = await seed('qs-ahmet'),
    db = f.env.DB,
    before = await snapshot();
  let revoked = false;
  const grant = await f.db
    .prepare(
      "SELECT scope FROM membership_permissions WHERE membership_id='membership-qs-ahmet' AND permission_code='quote.manage'",
    )
    .first<{ scope: string }>();
  f.env.DB = new Proxy(db, {
    get(target, key) {
      if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (statements.length >= 7 && !revoked) {
            revoked = true;
            await f.db
              .prepare(
                "DELETE FROM membership_permissions WHERE membership_id='membership-qs-ahmet' AND permission_code='quote.manage'",
              )
              .run();
          }
          return target.batch(statements);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    expect([403, 409]).toContain((await post(s.sendUrl, s.body, 'qs-ahmet')).status);
    expect(revoked).toBe(true);
    expect(await snapshot()).toBe(before);
  } finally {
    f.env.DB = db;
    if (revoked)
      await f.db
        .prepare(
          'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
        )
        .bind(crypto.randomUUID(), 'membership-qs-ahmet', 'quote.manage', grant!.scope)
        .run();
  }
});
