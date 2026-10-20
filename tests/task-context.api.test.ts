// @vitest-environment node
import { beforeAll, afterAll, expect, it } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import { createOnboardingTemplateGrants } from '../src/shared/permissions';
let f: Awaited<ReturnType<typeof localAuthFixture>>;
let owner: string, member: string;
beforeAll(async () => {
  f = await localAuthFixture();
  await f.seed('nav-owner', 'OWNER');
  for (const id of ['nav-a', 'nav-b']) {
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
  owner = (await f.session('nav-owner')).cookie;
  member = (await f.session('nav-a')).cookie;
  for (const sql of [
    "INSERT INTO insurers(id,agency_id,code,name) VALUES('nav-i','agency-auth-test','NAV','Sentetik şirket')",
    "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('nav-b','agency-auth-test','NAV','Kasko','GENERAL')",
    "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('nav-p','agency-auth-test','nav-i','nav-b','NAV','Kasko')",
    "INSERT INTO payment_methods(id,agency_id,code,name,supports_installments,max_installments) VALUES('nav-pay','agency-auth-test','CASH','Peşin',0,12)",
    "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES('nav-c','agency-auth-test','INDIVIDUAL','Sentetik kişi','Sentetik','Kişi','membership-nav-owner')",
  ])
    await f.db.prepare(sql).run();
  for (const id of ['a', 'b']) {
    await f.db
      .prepare(
        "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency) VALUES(?,'agency-auth-test','nav-c','nav-i','nav-p','nav-b','nav-pay',?, ?,?,'2026-01-01','2099-01-01',10000,'TRY')",
      )
      .bind('nav-policy-' + id, 'membership-nav-' + id, 'NAV-' + id, 'NAV' + id)
      .run();
    await f.db
      .prepare(
        "INSERT INTO renewal_opportunities(id,agency_id,expiring_policy_id,assignee_membership_id,state) VALUES(?,'agency-auth-test',?,?,'CONTACT_PENDING')",
      )
      .bind('nav-renewal-' + id, 'nav-policy-' + id, 'membership-nav-' + id)
      .run();
    await f.db
      .prepare(
        "INSERT INTO tasks(id,agency_id,customer_id,renewal_id,kind,title,due_at,assignee_membership_id,status,actor_kind) VALUES(?,'agency-auth-test','nav-c',?,'RENEWAL_FOLLOWUP','Sentetik takip','2026-10-20T09:00:00.000Z',?,'OPEN','SYSTEM')",
      )
      .bind('nav-task-' + id, 'nav-renewal-' + id, 'membership-nav-' + id)
      .run();
  }
}, 60000);
afterAll(async () => {
  await f?.mf.dispose();
});
it('returns exact authorized Task A and no unrelated Task B with private no-store', async () => {
  const r = await f.request('/api/tasks/nav-task-a/context', 'GET', member);
  expect(r.status).toBe(200);
  expect(r.headers.get('cache-control')).toContain('no-store');
  const body = (await r.json()) as {
    data: { items: Array<{ taskId: string }>; unassignedItems: unknown[] };
  };
  expect(body.data.items.map((x) => x.taskId)).toEqual(['nav-task-a']);
  expect(body.data.unassignedItems).toEqual([]);
});
it('allows OWNER to read exact A or B but does not expose B to another MEMBER', async () => {
  expect((await f.request('/api/tasks/nav-task-b/context', 'GET', owner)).status).toBe(200);
  expect((await f.request('/api/tasks/nav-task-b/context', 'GET', member)).status).toBe(404);
  expect((await f.request('/api/tasks/missing/context', 'GET', member)).status).toBe(404);
});
it('rejects unauthorized queues, duplicate filters, unknown filters and malformed identifiers', async () => {
  expect(
    (await f.request('/api/tasks/nav-task-a/context?queue=REASSIGNMENT', 'GET', member)).status,
  ).toBe(403);
  for (const suffix of ['?queue=WORK&queue=WORK', '?assignee=other', '?queue=other'])
    expect((await f.request('/api/tasks/nav-task-a/context' + suffix, 'GET', member)).status).toBe(
      400,
    );
  expect((await f.request('/api/tasks/a%20b/context', 'GET', member)).status).toBe(400);
});
it('does not replace completed A with another primary Task or return a closed record', async () => {
  await f.db
    .prepare(
      "UPDATE tasks SET status='COMPLETED',completed_at='2026-10-20T09:00:00.000Z',completed_by_membership_id='membership-nav-a',version=version+1 WHERE id='nav-task-a'",
    )
    .run();
  try {
    expect((await f.request('/api/tasks/nav-task-a/context', 'GET', owner)).status).toBe(404);
  } finally {
    await f.db
      .prepare(
        "UPDATE tasks SET status='OPEN',completed_at=NULL,completed_by_membership_id=NULL,version=version+1 WHERE id='nav-task-a'",
      )
      .run();
  }
});
it('revalidates reassignment instead of restoring the previous employee authority', async () => {
  await f.db.batch([
    f.db.prepare(
      "UPDATE tasks SET assignee_membership_id='membership-nav-b',version=version+1 WHERE id='nav-task-a'",
    ),
    f.db.prepare(
      "UPDATE renewal_opportunities SET assignee_membership_id='membership-nav-b',version=version+1 WHERE id='nav-renewal-a'",
    ),
  ]);
  try {
    expect((await f.request('/api/tasks/nav-task-a/context', 'GET', member)).status).toBe(404);
  } finally {
    await f.db.batch([
      f.db.prepare(
        "UPDATE tasks SET assignee_membership_id='membership-nav-a',version=version+1 WHERE id='nav-task-a'",
      ),
      f.db.prepare(
        "UPDATE renewal_opportunities SET assignee_membership_id='membership-nav-a',version=version+1 WHERE id='nav-renewal-a'",
      ),
    ]);
  }
});
it('does not disclose cross-agency or HEALTH context through a known exact ID', async () => {
  await f.seed('nav-foreign', 'OWNER', false, 'nav-other');
  const foreign = (await f.session('nav-foreign')).cookie;
  expect((await f.request('/api/tasks/nav-task-a/context', 'GET', foreign)).status).toBe(404);
  await f.db
    .prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('nav-health','agency-auth-test','HEALTH','Sağlık','HEALTH')",
    )
    .run();
  await f.db
    .prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('nav-health-p','agency-auth-test','nav-i','nav-health','HEALTH','Sağlık')",
    )
    .run();
  await f.db
    .prepare(
      "UPDATE policies SET branch_id='nav-health',product_id='nav-health-p',version=version+1 WHERE id='nav-policy-a'",
    )
    .run();
  try {
    expect((await f.request('/api/tasks/nav-task-a/context', 'GET', member)).status).toBe(404);
  } finally {
    await f.db
      .prepare(
        "UPDATE policies SET branch_id='nav-b',product_id='nav-p',version=version+1 WHERE id='nav-policy-a'",
      )
      .run();
  }
});
it('fails closed when the session is revoked at the final exact-context batch', async () => {
  const session = await f.session('nav-a');
  const db = f.db;
  let ready = false,
    fired = false;
  f.env.DB = new Proxy(db, {
    get(target, key) {
      if (key === 'prepare')
        return (sql: string) => {
          if (sql.includes('t.id=?') && sql.includes('task_title')) ready = true;
          return db.prepare(sql);
        };
      if (key === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          if (ready && !fired) {
            fired = true;
            await db
              .prepare('UPDATE local_sessions SET revoked_at=? WHERE token_hash=?')
              .bind(Date.now(), session.hash)
              .run();
          }
          return db.batch(statements);
        };
      const value = Reflect.get(target, key, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  try {
    const r = await f.request('/api/tasks/nav-task-a/context', 'GET', session.cookie);
    expect(fired).toBe(true);
    expect([401, 403, 503]).toContain(r.status);
    expect(await r.text()).not.toContain('Sentetik kişi');
  } finally {
    f.env.DB = db;
  }
});
it('denies a revoked permission/session without returning cached context', async () => {
  await f.db
    .prepare(
      "DELETE FROM membership_permissions WHERE membership_id='membership-nav-a' AND permission_code='task.read'",
    )
    .run();
  const r = await f.request('/api/tasks/nav-task-a/context', 'GET', member);
  expect([401, 403]).toContain(r.status);
  expect(await r.text()).not.toContain('Sentetik kişi');
});
