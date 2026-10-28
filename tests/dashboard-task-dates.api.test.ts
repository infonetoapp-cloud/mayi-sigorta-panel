// @vitest-environment node
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import { interceptFinalRead } from './support/intercept-final-read';
import { createOnboardingTemplateGrants } from '../src/shared/permissions';
import type { TodayTasksResponseData } from '../src/shared/types';
let f: Awaited<ReturnType<typeof localAuthFixture>>;
let owner: string, member: string, foreign: string;
const clock = '2026-10-22T21:30:00.000Z';
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(clock));
  f = await localAuthFixture();
  await f.seed('dash-owner', 'OWNER');
  for (const id of ['dash-a', 'dash-b']) {
    await f.seed(id);
    await f.db.batch(
      createOnboardingTemplateGrants('personel').map((g) =>
        f.db
          .prepare(
            'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
          )
          .bind(crypto.randomUUID(), 'membership-' + id, g.permission_code, g.scope),
      ),
    );
  }
  owner = (await f.session('dash-owner')).cookie;
  member = (await f.session('dash-a')).cookie;
  await f.seed('dash-foreign', 'OWNER', false, 'dash-other');
  foreign = (await f.session('dash-foreign')).cookie;
  for (const sql of [
    "INSERT INTO insurers(id,agency_id,code,name) VALUES('dash-i','agency-auth-test','DASH','Sigorta')",
    "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('dash-b','agency-auth-test','DASH','Kasko','GENERAL')",
    "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('dash-health','agency-auth-test','DASH_HEALTH','Sağlık','HEALTH')",
    "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('dash-p','agency-auth-test','dash-i','dash-b','DASH','Kasko')",
    "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('dash-hp','agency-auth-test','dash-i','dash-health','DASH_HEALTH','Sağlık')",
    "INSERT INTO payment_methods(id,agency_id,code,name) VALUES('dash-pay','agency-auth-test','CASH','Peşin')",
    "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES('dash-c','agency-auth-test','INDIVIDUAL','Sentetik kişi','Sentetik','Kişi','membership-dash-owner')",
  ])
    await f.db.prepare(sql).run();
  const rows = [
    ['old', 'dash-a', '2026-10-22T20:59:59.999Z'],
    ['early', 'dash-a', '2026-10-22T21:00:00.000Z'],
    ['late', 'dash-a', '2026-10-23T20:59:59.999Z'],
    ['future', 'dash-a', '2026-10-23T21:00:00.000Z'],
    ['other', 'dash-b', '2026-10-22T21:01:00.000Z'],
    ['unassigned', null, '2026-10-22T21:02:00.000Z'],
    ['health', 'dash-a', '2026-10-22T21:03:00.000Z'],
  ] as const;
  for (const [id, assignee, due] of rows) {
    const m = assignee ? 'membership-' + assignee : null;
    const health = id === 'health';
    await f.db
      .prepare(
        "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency) VALUES(?,'agency-auth-test','dash-c','dash-i',?,?,'dash-pay','membership-dash-owner',?,?,'2026-01-01','2026-10-30',10000,'TRY')",
      )
      .bind(
        'dash-policy-' + id,
        health ? 'dash-hp' : 'dash-p',
        health ? 'dash-health' : 'dash-b',
        'DASH-' + id,
        'DASH' + id,
      )
      .run();
    await f.db
      .prepare(
        "INSERT INTO renewal_opportunities(id,agency_id,expiring_policy_id,assignee_membership_id,state) VALUES(?,'agency-auth-test',?,?,'CONTACT_PENDING')",
      )
      .bind('dash-renewal-' + id, 'dash-policy-' + id, m)
      .run();
    await f.db
      .prepare(
        "INSERT INTO tasks(id,agency_id,customer_id,renewal_id,kind,title,due_at,assignee_membership_id,status,actor_kind) VALUES(?,'agency-auth-test','dash-c',?,'RENEWAL_FOLLOWUP','Sentetik takip',?,?,'OPEN','SYSTEM')",
      )
      .bind('dash-task-' + id, 'dash-renewal-' + id, due, m)
      .run();
  }
}, 60000);
afterAll(async () => {
  await f?.mf.dispose();
  vi.useRealTimers();
});
async function read(query: string, cookie = member) {
  const r = await f.request('/api/tasks/today?' + query, 'GET', cookie);
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toContain('no-store');
  return ((await r.json()) as { data: TodayTasksResponseData }).data;
}
it('filters on Istanbul calendar boundaries before LIMIT, including earlier today as TODAY', async () => {
  expect((await read('due=OVERDUE&limit=1')).items.map((x) => x.taskId)).toEqual(['dash-task-old']);
  const today = await read('due=TODAY&limit=1');
  expect(today.items.map((x) => x.taskId)).toEqual(['dash-task-early']);
  expect(today.hasMore).toBe(true);
  expect(
    (await read('due=TODAY&limit=1&cursor=' + encodeURIComponent(today.nextCursor!))).items.map(
      (x) => x.taskId,
    ),
  ).toEqual(['dash-task-late']);
  expect((await read('due=UPCOMING&limit=5')).items.map((x) => x.taskId)).toEqual([
    'dash-task-future',
  ]);
});
it('keeps MEMBER private, OWNER queues explicit, HEALTH excluded, and foreign agency empty', async () => {
  const own = await read('due=TODAY&limit=5');
  expect(own.items.map((x) => x.taskId)).toEqual(['dash-task-early', 'dash-task-late']);
  expect(own.unassignedItems).toEqual([]);
  const team = await read('due=TODAY&limit=5', owner);
  expect(team.items.map((x) => x.taskId)).toEqual([
    'dash-task-early',
    'dash-task-other',
    'dash-task-late',
  ]);
  expect(team.unassignedItems.map((x) => x.taskId)).toEqual(['dash-task-unassigned']);
  expect((await read('due=TODAY&limit=5', foreign)).items).toEqual([]);
});
it('binds filtered cursors to actor, filter and Istanbul date while preserving unfiltered cursor format', async () => {
  const first = await read('due=TODAY&limit=1');
  const cursor = encodeURIComponent(first.nextCursor!);
  for (const [query, cookie] of [
    ['due=OVERDUE&limit=1&cursor=' + cursor, member],
    ['due=TODAY&limit=1&cursor=' + cursor, owner],
    ['limit=1&cursor=' + cursor, member],
  ] as const)
    expect((await f.request('/api/tasks/today?' + query, 'GET', cookie)).status).toBe(400);
  const all = await read('limit=1');
  expect(JSON.parse(atob(all.nextCursor!))).toHaveLength(11);
  vi.setSystemTime(new Date('2026-10-23T21:30:00.000Z'));
  try {
    const fresh = (await f.session('dash-a')).cookie;
    expect(
      (await f.request('/api/tasks/today?due=TODAY&limit=1&cursor=' + cursor, 'GET', fresh)).status,
    ).toBe(400);
  } finally {
    vi.setSystemTime(new Date(clock));
  }
});
it('denies invalid filters and revoked sessions instead of returning cached dashboard rows', async () => {
  expect((await f.request('/api/tasks/today?due=ANY', 'GET', member)).status).toBe(400);
  const s = await f.session('dash-a');
  await f.db
    .prepare('UPDATE local_sessions SET revoked_at=? WHERE token_hash=?')
    .bind(Date.now(), s.hash)
    .run();
  expect((await f.request('/api/tasks/today?due=TODAY', 'GET', s.cookie)).status).toBe(401);
});

it.each(['limit=5', 'due=TODAY&limit=5'])(
  'denies session revocation after authorization immediately before final queue disclosure: %s',
  async (query) => {
    const session = await f.session('dash-a');
    const original = f.env.DB;
    const barrier = interceptFinalRead(
      f.db,
      (sql) => sql.includes('SELECT t.id AS task_id') && sql.includes('ORDER BY t.due_at'),
      async () => {
        await f.db
          .prepare('UPDATE local_sessions SET revoked_at=? WHERE token_hash=?')
          .bind(Date.now(), session.hash)
          .run();
      },
    );
    f.env.DB = barrier.db;
    try {
      const response = await f.request('/api/tasks/today?' + query, 'GET', session.cookie);
      expect(barrier.wasTriggered()).toBe(true);
      expect(response.status).toBe(403);
      expect(await response.json()).not.toHaveProperty('data');
    } finally {
      f.env.DB = original;
    }
  },
);

it.each(['customer.read', 'policy.read', 'sensitive.health.read'])(
  'denies a persisted read grant loss at the final queue boundary: %s',
  async (code) => {
    await f.db
      .prepare(
        "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES('queue-race-health-grant','membership-dash-a','sensitive.health.read','UNSCOPED')",
      )
      .run();
    const grant = await f.db
      .prepare(
        'SELECT id,scope FROM membership_permissions WHERE membership_id=? AND permission_code=?',
      )
      .bind('membership-dash-a', code)
      .first<{ id: string; scope: string }>();
    expect(grant).not.toBeNull();
    const session = await f.session('dash-a');
    const baseline = await read('due=TODAY&limit=5', session.cookie);
    expect(baseline.items.some((item) => item.taskId === 'dash-task-health')).toBe(true);
    const original = f.env.DB;
    const barrier = interceptFinalRead(
      f.db,
      (sql) => sql.includes('SELECT t.id AS task_id') && sql.includes('ORDER BY t.due_at'),
      async () => {
        await f.db.prepare('DELETE FROM membership_permissions WHERE id=?').bind(grant!.id).run();
      },
    );
    f.env.DB = barrier.db;
    try {
      const response = await f.request('/api/tasks/today?due=TODAY&limit=5', 'GET', session.cookie);
      expect(barrier.wasTriggered()).toBe(true);
      expect(response.status).toBe(403);
      expect(await response.json()).not.toHaveProperty('data');
    } finally {
      f.env.DB = original;
      await f.db
        .prepare(
          'INSERT OR IGNORE INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
        )
        .bind(grant!.id, 'membership-dash-a', code, grant!.scope)
        .run();
      await f.db
        .prepare("DELETE FROM membership_permissions WHERE id='queue-race-health-grant'")
        .run();
    }
  },
);
