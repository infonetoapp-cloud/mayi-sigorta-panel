// @vitest-environment node
import { beforeAll, afterAll, it, expect, vi } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import { createOnboardingTemplateGrants } from '../src/shared/permissions';
import { ensureRenewalForPolicy } from '../src/server/renewals/generation';
import type { TodayTasksResponseData } from '../src/shared/types';
import type { TaskStatisticsData } from '../src/shared/task-statistics';
let f: Awaited<ReturnType<typeof localAuthFixture>>;
const cookies: Record<string, string> = {};
const root = '/api/tasks/today';
async function list(who: string, query = '') {
  const r = await f.request(root + query, 'GET', cookies[who]);
  expect(r.status).toBe(200);
  return ((await r.json()) as { data: TodayTasksResponseData }).data;
}
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-17T21:30:00Z'));
  f = await localAuthFixture();
  for (const id of ['tw-owner', 'tw-ahmet', 'tw-ayse', 'tw-old', 'tw-foreign']) {
    const member = await f.seed(
      id,
      id === 'tw-owner' || id === 'tw-foreign' ? 'OWNER' : 'MEMBER',
      false,
      id === 'tw-foreign' ? 'tw-foreign-agency' : 'agency-auth-test',
    );
    if (id === 'tw-ahmet' || id === 'tw-ayse')
      await f.db.batch(
        createOnboardingTemplateGrants('personel').map((g) =>
          f.db
            .prepare(
              'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
            )
            .bind(crypto.randomUUID(), member.membershipId, g.permission_code, g.scope),
        ),
      );
    if (id !== 'tw-old') cookies[id] = (await f.session(id)).cookie;
  }
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES('tw-c','agency-auth-test','INDIVIDUAL','Ortak Yetkili Müşteri','Ortak','Müşteri','membership-tw-owner')",
    ),
    f.db.prepare(
      "INSERT INTO insurers(id,agency_id,code,name) VALUES('tw-i','agency-auth-test','TW','TW')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('tw-b','agency-auth-test','TW','TW','GENERAL')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('tw-p','agency-auth-test','tw-i','tw-b','TW','TW')",
    ),
    f.db.prepare(
      "INSERT INTO payment_methods(id,agency_id,code,name) VALUES('tw-m','agency-auth-test','TW','TW')",
    ),
  ]);
  for (const who of ['tw-owner', 'tw-ahmet', 'tw-ayse'])
    for (let n = 0; n < 3; n++) {
      const r = await f.request(
        '/api/policies',
        'POST',
        cookies[who],
        {
          customerId: 'tw-c',
          insurerId: 'tw-i',
          branchId: 'tw-b',
          productId: 'tw-p',
          paymentMethodId: 'tw-m',
          policyNumber: who + '-' + n,
          startDate: '2026-01-01',
          endDate: '2026-10-23',
          grossPremium: '10.00',
          currency: 'TRY',
          installmentCount: null,
        },
        await f.csrf(cookies[who]!),
        { 'idempotency-key': crypto.randomUUID() },
      );
      expect(r.status).toBe(201);
      const id = ((await r.json()) as { data: { id: string } }).data.id;
      await f.db
        .prepare(
          'UPDATE tasks SET due_at=?,version=version+1 WHERE renewal_id IN(SELECT id FROM renewal_opportunities WHERE expiring_policy_id=?)',
        )
        .bind(
          ['2026-10-17T21:10:00.000Z', '2026-10-18T09:00:00.000Z', '2026-10-18T21:00:00.000Z'][n],
          id,
        )
        .run();
    }
  await f.db.batch([
    f.db.prepare(
      "UPDATE tasks SET assignee_membership_id=NULL,version=version+1 WHERE assignee_membership_id='membership-tw-owner'",
    ),
    f.db.prepare(
      "UPDATE renewal_opportunities SET assignee_membership_id=NULL,version=version+1 WHERE assignee_membership_id='membership-tw-owner'",
    ),
  ]);
  await f.db
    .prepare(
      "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency) VALUES('tw-orphan','agency-auth-test','tw-c','tw-i','tw-p','tw-b','tw-m','membership-tw-old','ORPHAN','ORPHAN','2026-01-01','2026-10-23',1000,'TRY')",
    )
    .run();
  await ensureRenewalForPolicy(f.db, 'agency-auth-test', 'tw-orphan');
  await f.db
    .prepare(
      "UPDATE agency_memberships SET status='SUSPENDED',suspended_at='2026-10-17T21:20:00Z',version=version+1,permission_version=permission_version+1 WHERE id='membership-tw-old'",
    )
    .run();
  await f.db.batch([
    f.db.prepare(
      "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('tw-h','agency-auth-test','H','Health','HEALTH')",
    ),
    f.db.prepare(
      "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('tw-hp','agency-auth-test','tw-i','tw-h','H','Health')",
    ),
    f.db.prepare(
      "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency) VALUES('tw-health','agency-auth-test','tw-c','tw-i','tw-hp','tw-h','tw-m','membership-tw-owner','HIDDEN-HEALTH','HIDDEN-HEALTH','2026-01-01','2026-10-23',1000,'TRY')",
    ),
  ]);
  await ensureRenewalForPolicy(f.db, 'agency-auth-test', 'tw-health');
}, 90000);
afterAll(async () => {
  await f?.mf.dispose();
  vi.useRealTimers();
});
it('keeps Ahmet/Ayşe personal task lists private despite shared customer/policy access and broad legacy grants', async () => {
  for (const who of ['tw-ahmet', 'tw-ayse']) {
    const data = await list(who);
    expect(data.items).toHaveLength(3);
    expect(data.items.every((t) => t.assigneeMembershipId === 'membership-' + who)).toBe(true);
    expect(data.unassignedItems).toEqual([]);
    expect(data.canSeeUnassigned).toBe(false);
    expect(data.canSeeReassignment).toBe(false);
    expect((await f.request('/api/customers/tw-c', 'GET', cookies[who])).status).toBe(200);
  }
  await f.db
    .prepare(
      "UPDATE membership_permissions SET scope='AGENCY' WHERE membership_id='membership-tw-ahmet' AND permission_code IN('task.read','renewal.read','customer.read','policy.read')",
    )
    .run();
  expect(
    (await list('tw-ahmet')).items.every((t) => t.assigneeMembershipId === 'membership-tw-ahmet'),
  ).toBe(true);
});
it('preserves instant buckets across the Istanbul midnight statistical boundary', async () => {
  const data = await list('tw-ayse');
  expect(data.timezone).toBe('Europe/Istanbul');
  expect(data.todayLocalDate).toBe('2026-10-18');
  expect(data.items.map((t) => t.bucket)).toEqual(['OVERDUE', 'TODAY', 'UPCOMING']);
  const r = await f.request('/api/tasks/statistics', 'GET', cookies['tw-ayse']);
  expect(r.status).toBe(200);
  const stats = ((await r.json()) as { data: TaskStatisticsData }).data;
  expect(stats.summary.overdue).toBe(0);
  expect(stats.summary.dueToday).toBe(2);
  expect(stats.summary.upcoming).toBe(1);
});
it('uses independently bound work/unassigned cursors and never mixes member/agency cursor authority', async () => {
  const first = await list('tw-owner', '?limit=1');
  expect(first.hasMore).toBe(true);
  expect(first.unassignedHasMore).toBe(true);
  const work = await list('tw-owner', '?limit=1&cursor=' + encodeURIComponent(first.nextCursor!));
  const unassigned = await list(
    'tw-owner',
    '?limit=1&unassignedCursor=' + encodeURIComponent(first.unassignedNextCursor!),
  );
  expect(work.items[0]!.taskId).not.toBe(first.items[0]!.taskId);
  expect(work.unassignedItems).toEqual(first.unassignedItems);
  expect(unassigned.items).toEqual(first.items);
  expect(unassigned.unassignedItems[0]!.taskId).not.toBe(first.unassignedItems[0]!.taskId);
  expect(
    (
      await f.request(
        root + '?cursor=' + encodeURIComponent(first.unassignedNextCursor!),
        'GET',
        cookies['tw-owner'],
      )
    ).ok,
  ).toBe(false);
  expect(
    (
      await f.request(
        root + '?cursor=' + encodeURIComponent(first.nextCursor!),
        'GET',
        cookies['tw-ayse'],
      )
    ).ok,
  ).toBe(false);
});
it('only grants the OWNER reassignment history and leaves suspended assignee associations unchanged', async () => {
  for (const who of ['tw-ahmet', 'tw-ayse'])
    expect((await f.request(root + '?needsReassignment=true', 'GET', cookies[who])).status).toBe(
      403,
    );
  const data = await list('tw-owner', '?needsReassignment=true');
  expect(data.items).toHaveLength(1);
  expect(data.items[0]!.assigneeMembershipId).toBe('membership-tw-old');
  expect(data.items[0]!.needsReassignment).toBe(true);
  expect(data.canSeeReassignment).toBe(true);
  await f.db
    .prepare(
      "UPDATE agency_memberships SET status='INACTIVE',suspended_at=NULL,inactivated_at='2026-10-17T21:25:00.000Z',version=version+1,permission_version=permission_version+1 WHERE id='membership-tw-old'",
    )
    .run();
  const inactive = await list('tw-owner', '?needsReassignment=true');
  expect(
    inactive.items.map((task) => [
      task.taskId,
      task.assigneeMembershipId,
      task.taskVersion,
      task.needsReassignment,
    ]),
  ).toEqual(
    data.items.map((task) => [
      task.taskId,
      task.assigneeMembershipId,
      task.taskVersion,
      task.needsReassignment,
    ]),
  );
});
it('does not disclose foreign/HEALTH details or other employees private task payloads via statistics', async () => {
  for (const who of ['tw-owner', 'tw-ahmet', 'tw-ayse', 'tw-foreign']) {
    const data = await list(who);
    expect([...data.items, ...data.unassignedItems].some((t) => t.policyId === 'tw-health')).toBe(
      false,
    );
    expect(JSON.stringify(data)).not.toContain('HIDDEN-HEALTH');
    if (who === 'tw-foreign') expect(data.items).toEqual([]);
  }
  for (const who of ['tw-ahmet', 'tw-ayse']) {
    expect((await f.request('/api/tasks/statistics?view=team', 'GET', cookies[who])).status).toBe(
      403,
    );
    const r = await f.request('/api/tasks/statistics', 'GET', cookies[who]);
    const body = await r.json();
    expect(JSON.stringify(body)).not.toContain('Ortak Yetkili Müşteri');
    expect(JSON.stringify(body)).not.toContain('policyNumber');
  }
});
it('clears access on session revocation', async () => {
  await f.db
    .prepare("UPDATE local_sessions SET revoked_at=? WHERE user_id='tw-ahmet'")
    .bind(Date.now())
    .run();
  for (const path of [root, '/api/tasks/statistics']) {
    const r = await f.request(path, 'GET', cookies['tw-ahmet']);
    expect(r.status).toBe(401);
    expect(await r.json()).not.toHaveProperty('data');
  }
});
