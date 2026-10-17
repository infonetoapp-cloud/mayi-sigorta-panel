// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import { createOnboardingTemplateGrants } from '../src/shared/permissions';
import type { TaskStatisticsData } from '../src/shared/task-statistics';

let f: Awaited<ReturnType<typeof localAuthFixture>>;
let employeeCookie: string, ownerCookie: string;
const endpoint = '/api/tasks/statistics';
const now = '2026-10-17T21:30:00.000Z'; // 18 October, 00:30 Istanbul
async function task(
  id: string,
  assignee: string | null,
  due: string,
  completed?: { by: string; at: string },
) {
  await f.db
    .prepare(
      `INSERT INTO tasks(id,agency_id,customer_id,kind,title,due_at,assignee_membership_id,status,completed_at,completed_by_membership_id,actor_kind)
    VALUES(?,'agency-auth-test','stats-customer','GENERAL','Private task',?,?,?,?,?,'SYSTEM')`,
    )
    .bind(
      id,
      due,
      assignee && `membership-${assignee}`,
      completed ? 'COMPLETED' : 'OPEN',
      completed?.at ?? null,
      completed ? `membership-${completed.by}` : null,
    )
    .run();
}
beforeAll(async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date(now));
  f = await localAuthFixture();
  await f.seed('stats-owner', 'OWNER');
  for (const id of ['stats-a', 'stats-b']) {
    const member = await f.seed(id);
    await f.db.batch(
      createOnboardingTemplateGrants('personel').map((grant) =>
        f.db
          .prepare(
            'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
          )
          .bind(crypto.randomUUID(), member.membershipId, grant.permission_code, grant.scope),
      ),
    );
  }
  ownerCookie = (await f.session('stats-owner')).cookie;
  employeeCookie = (await f.session('stats-a')).cookie;
  await f.db
    .prepare(
      "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES('stats-customer','agency-auth-test','INDIVIDUAL','Sensitive customer name','Sensitive','Name','membership-stats-owner')",
    )
    .run();
  await task('stats-overdue', 'stats-a', '2026-10-17T20:59:59.999Z');
  await task('stats-today-past', 'stats-a', '2026-10-17T21:00:00.000Z');
  await task('stats-today-future', 'stats-a', '2026-10-18T20:59:59.999Z');
  await task('stats-upcoming', 'stats-a', '2026-10-18T21:00:00.000Z');
  await task('stats-b-only', 'stats-b', '2026-10-16T10:00:00.000Z');
  await task('stats-unassigned', null, '2026-10-16T10:00:00.000Z');
  await task('stats-completed-by-a-assigned-b', 'stats-b', now, {
    by: 'stats-a',
    at: '2026-09-18T21:00:00.000Z',
  });
  await task('stats-completed-by-b-assigned-a', 'stats-a', now, { by: 'stats-b', at: now });
  await task('stats-old', 'stats-a', now, { by: 'stats-a', at: '2026-09-18T20:59:59.999Z' });
  await task('stats-future-completion', 'stats-a', now, {
    by: 'stats-a',
    at: '2026-10-17T21:30:00.001Z',
  });
}, 60000);
afterAll(async () => {
  await f?.mf.dispose();
  vi.useRealTimers();
});

describe('Private operational statistics on local D1/API', () => {
  async function data(cookie = ownerCookie, query = '?view=team'): Promise<TaskStatisticsData> {
    const response = await f.request(endpoint + query, 'GET', cookie);
    expect(response.status, await response.clone().text()).toBe(200);
    return ((await response.json()) as { data: TaskStatisticsData }).data;
  }
  it('does not widen employee counts or filters with legacy AGENCY task/report and management grants', async () => {
    await f.db
      .prepare(
        "UPDATE membership_permissions SET scope='AGENCY' WHERE membership_id='membership-stats-a' AND permission_code IN ('task.read','report.operations')",
      )
      .run();
    await f.db
      .prepare(
        "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES('stats-legacy-management','membership-stats-a','report.management','AGENCY')",
      )
      .run();
    try {
      expect((await data(employeeCookie, '')).summary).toEqual({
        overdue: 1,
        dueToday: 2,
        upcoming: 1,
        completedLast30Days: 1,
      });
      expect((await f.request(endpoint + '?view=team', 'GET', employeeCookie)).status).toBe(403);
      expect(
        (await f.request(endpoint + '?membershipId=membership-stats-b', 'GET', employeeCookie))
          .status,
      ).toBe(403);
    } finally {
      await f.db
        .prepare("DELETE FROM membership_permissions WHERE id='stats-legacy-management'")
        .run();
      await f.db
        .prepare(
          "UPDATE membership_permissions SET scope='ASSIGNED' WHERE membership_id='membership-stats-a' AND permission_code IN ('task.read','report.operations')",
        )
        .run();
    }
  });
  it('moves current workload on reassignment without moving completed-by activity', async () => {
    await f.db
      .prepare(
        "UPDATE tasks SET assignee_membership_id='membership-stats-b',version=version+1 WHERE id='stats-upcoming'",
      )
      .run();
    try {
      expect((await data(employeeCookie, '')).summary.upcoming).toBe(0);
      const team = await data();
      expect(team.employees.find((row) => row.membershipId === 'membership-stats-b')).toMatchObject(
        { upcoming: 1, completedLast30Days: 1 },
      );
      expect(
        team.employees.find((row) => row.membershipId === 'membership-stats-a')
          ?.completedLast30Days,
      ).toBe(1);
    } finally {
      await f.db
        .prepare(
          "UPDATE tasks SET assignee_membership_id='membership-stats-a',version=version+1 WHERE id='stats-upcoming'",
        )
        .run();
    }
  });
  it.each(['SUSPENDED', 'INACTIVE'] as const)(
    'keeps %s employee workload and past completions separate from unassigned',
    async (status) => {
      const column = status === 'SUSPENDED' ? 'suspended_at' : 'inactivated_at';
      await f.db
        .prepare(
          `UPDATE agency_memberships SET status=?,${column}=?,version=version+1,permission_version=permission_version+1 WHERE id='membership-stats-b'`,
        )
        .bind(status, now)
        .run();
      try {
        const team = await data();
        expect(
          team.employees.find((row) => row.membershipId === 'membership-stats-b'),
        ).toMatchObject({ status, overdue: 1, completedLast30Days: 1 });
        expect(team.unassigned?.overdue).toBe(1);
      } finally {
        await f.db
          .prepare(
            "UPDATE agency_memberships SET status='ACTIVE',suspended_at=NULL,inactivated_at=NULL,version=version+1,permission_version=permission_version+1 WHERE id='membership-stats-b'",
          )
          .run();
      }
    },
  );
  it('keeps inactive-user workload and historical attribution in owner rows', async () => {
    await f.db
      .prepare("UPDATE users SET status='INACTIVE',version=version+1 WHERE id='stats-b'")
      .run();
    try {
      expect(
        (await data()).employees.find((row) => row.membershipId === 'membership-stats-b'),
      ).toMatchObject({ userActive: false, overdue: 1, completedLast30Days: 1 });
    } finally {
      await f.db
        .prepare("UPDATE users SET status='ACTIVE',version=version+1 WHERE id='stats-b'")
        .run();
    }
  });
  it('honors custom parent scopes and missing report/task permissions', async () => {
    await f.db
      .prepare(
        "UPDATE membership_permissions SET scope='ASSIGNED' WHERE membership_id='membership-stats-a' AND scope='AGENCY'",
      )
      .run();
    try {
      expect((await data(employeeCookie, '')).summary).toEqual({
        overdue: 0,
        dueToday: 0,
        upcoming: 0,
        completedLast30Days: 0,
      });
    } finally {
      for (const grant of createOnboardingTemplateGrants('personel'))
        await f.db
          .prepare(
            'UPDATE membership_permissions SET scope=? WHERE membership_id=? AND permission_code=?',
          )
          .bind(grant.scope, 'membership-stats-a', grant.permission_code)
          .run();
    }
    for (const code of ['report.operations', 'task.read']) {
      await f.db
        .prepare('DELETE FROM membership_permissions WHERE membership_id=? AND permission_code=?')
        .bind('membership-stats-a', code)
        .run();
      try {
        expect((await f.request(endpoint, 'GET', employeeCookie)).status).toBe(403);
      } finally {
        await f.db
          .prepare(
            'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
          )
          .bind(crypto.randomUUID(), 'membership-stats-a', code, 'ASSIGNED')
          .run();
      }
    }
  });
  it('isolates actual foreign-agency data and employee names', async () => {
    await f.seed('stats-foreign-owner', 'OWNER', false, 'stats-foreign');
    const cookie = (await f.session('stats-foreign-owner')).cookie;
    const foreign = await data(cookie);
    expect(foreign.summary).toEqual({
      overdue: 0,
      dueToday: 0,
      upcoming: 0,
      completedLast30Days: 0,
    });
    expect(foreign.employees.map((row) => row.membershipId)).toEqual([
      'membership-stats-foreign-owner',
    ]);
    expect(
      (await data(ownerCookie, '?membershipId=membership-stats-foreign-owner')).summary.overdue,
    ).toBe(0);
  });
  it.each(['self', 'team'])(
    'denies %s disclosure when the current session is revoked immediately before the final aggregate batch',
    async (view) => {
      const session = await f.session(view === 'team' ? 'stats-owner' : 'stats-a');
      let intercepted = false;
      f.env.DB = new Proxy(f.db, {
        get(target, key) {
          if (key === 'batch')
            return async (statements: D1PreparedStatement[]) => {
              intercepted = true;
              await target
                .prepare('UPDATE local_sessions SET revoked_at=? WHERE token_hash=?')
                .bind(Date.now(), session.hash)
                .run();
              return target.batch(statements);
            };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      try {
        const response = await f.request(endpoint + '?view=' + view, 'GET', session.cookie);
        expect(intercepted).toBe(true);
        expect(response.status).toBe(403);
        expect(await response.json()).not.toHaveProperty('data');
      } finally {
        f.env.DB = f.db;
      }
    },
  );
  it('verifies current owner authority rather than an earlier owner context', async () => {
    await f.seed('stats-demoted-owner', 'OWNER');
    const session = await f.session('stats-demoted-owner');
    let intercepted = false;
    f.env.DB = new Proxy(f.db, {
      get(target, key) {
        if (key === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            intercepted = true;
            await target
              .prepare(
                "UPDATE agency_memberships SET type='MEMBER',version=version+1,permission_version=permission_version+1 WHERE id='membership-stats-demoted-owner'",
              )
              .run();
            return target.batch(statements);
          };
        const value = Reflect.get(target, key, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    try {
      expect((await f.request(endpoint + '?view=team', 'GET', session.cookie)).status).toBe(403);
      expect(intercepted).toBe(true);
    } finally {
      f.env.DB = f.db;
    }
  });
  it('shows owner team totals, all employees and a separate unassigned workload', async () => {
    const response = await f.request(endpoint + '?view=team', 'GET', ownerCookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      data: {
        view: 'team',
        summary: { overdue: 3, dueToday: 2, upcoming: 1, completedLast30Days: 2 },
        unassigned: { overdue: 1, dueToday: 0, upcoming: 0 },
        employees: expect.arrayContaining([
          expect.objectContaining({
            membershipId: 'membership-stats-a',
            overdue: 1,
            completedLast30Days: 1,
          }),
          expect.objectContaining({
            membershipId: 'membership-stats-b',
            overdue: 1,
            completedLast30Days: 1,
          }),
          expect.objectContaining({
            membershipId: 'membership-stats-owner',
            overdue: 0,
            completedLast30Days: 0,
          }),
        ]),
      },
    });
  });
  it('rejects cross-employee selectors, team requests and unknown or duplicate filters', async () => {
    for (const query of [
      '?membershipId=membership-stats-b',
      '?view=team',
      '?view=team&cursor=membership-stats-b',
    ]) {
      const response = await f.request(endpoint + query, 'GET', employeeCookie);
      expect(response.status).toBe(403);
      expect(await response.json()).not.toHaveProperty('data');
    }
    for (const query of [
      '?agencyId=other',
      '?assigneeMembershipId=membership-stats-b',
      '?view=self&view=team',
      '?from=2020-01-01',
    ])
      expect((await f.request(endpoint + query, 'GET', employeeCookie)).status).toBe(400);
  });
  it('counts the entire own workload by Istanbul calendar day and actual completing employee', async () => {
    const response = await f.request(endpoint, 'GET', employeeCookie);
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toContain('no-store');
    const body = await response.json();
    expect(body).toMatchObject({
      data: {
        view: 'self',
        timezone: 'Europe/Istanbul',
        todayLocalDate: '2026-10-18',
        completionStart: '2026-09-18T21:00:00.000Z',
        summary: { overdue: 1, dueToday: 2, upcoming: 1, completedLast30Days: 1 },
        employees: [],
      },
    });
    expect(JSON.stringify(body)).not.toMatch(
      /Sensitive customer name|Private task|stats-b|stats-customer/,
    );
  });
  it('switches buckets and the 30-calendar-day start exactly at Istanbul midnight', async () => {
    try {
      vi.setSystemTime(new Date('2026-10-17T20:59:59.999Z'));
      const before = (await f.session('stats-a')).cookie;
      expect((await data(before, '')).summary).toEqual({
        overdue: 0,
        dueToday: 1,
        upcoming: 3,
        completedLast30Days: 2,
      });
      vi.setSystemTime(new Date('2026-10-17T21:00:00.000Z'));
      const midnight = (await f.session('stats-a')).cookie;
      expect((await data(midnight, '')).summary).toEqual({
        overdue: 1,
        dueToday: 2,
        upcoming: 1,
        completedLast30Days: 1,
      });
    } finally {
      vi.setSystemTime(new Date(now));
    }
  });
  it('rejects expired and already revoked sessions before returning even zero counts', async () => {
    const expired = await f.session('stats-a');
    try {
      vi.setSystemTime(new Date(Date.now() + 12 * 60 * 60 * 1000));
      expect((await f.request(endpoint, 'GET', expired.cookie)).status).toBe(401);
    } finally {
      vi.setSystemTime(new Date(now));
    }
    const revoked = await f.session('stats-a');
    await f.db
      .prepare('UPDATE local_sessions SET revoked_at=? WHERE token_hash=?')
      .bind(Date.now(), revoked.hash)
      .run();
    expect((await f.request(endpoint, 'GET', revoked.cookie)).status).toBe(401);
  });
  it.each(['permission', 'identity', 'credential'] as const)(
    'denies a live %s revocation at the final aggregate boundary',
    async (mode) => {
      const session = await f.session('stats-a');
      let intercepted = false;
      f.env.DB = new Proxy(f.db, {
        get(target, key) {
          if (key === 'batch')
            return async (statements: D1PreparedStatement[]) => {
              intercepted = true;
              if (mode === 'permission')
                await target
                  .prepare(
                    "DELETE FROM membership_permissions WHERE membership_id='membership-stats-a' AND permission_code='report.operations'",
                  )
                  .run();
              if (mode === 'identity')
                await target
                  .prepare(
                    "UPDATE auth_identities SET status='REVOKED',revoked_at='2026-10-17T21:30:00.000Z',version=version+1 WHERE id='identity-stats-a'",
                  )
                  .run();
              if (mode === 'credential')
                await target
                  .prepare(
                    "UPDATE local_credentials SET credential_version=credential_version+1 WHERE user_id='stats-a'",
                  )
                  .run();
              return target.batch(statements);
            };
          const value = Reflect.get(target, key, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      try {
        const response = await f.request(endpoint, 'GET', session.cookie);
        expect(intercepted).toBe(true);
        expect(response.status).toBe(403);
        expect(await response.json()).not.toHaveProperty('data');
      } finally {
        f.env.DB = f.db;
        if (mode === 'permission')
          await f.db
            .prepare(
              "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES('stats-restored-report','membership-stats-a','report.operations','ASSIGNED')",
            )
            .run();
        if (mode === 'identity') {
          await f.db
            .prepare(
              "UPDATE auth_identities SET status='ACTIVE',revoked_at=NULL,version=version+1 WHERE id='identity-stats-a'",
            )
            .run();
          await f.db
            .prepare("UPDATE local_credentials SET login_enabled=1 WHERE user_id='stats-a'")
            .run();
        }
        // A new session is required after the credential epoch changes; never undo epochs.
        if (mode === 'credential' || mode === 'identity')
          employeeCookie = (await f.session('stats-a')).cookie;
      }
    },
  );
  it('excludes HEALTH aggregates without explicit health grants, including for OWNER', async () => {
    await f.db.batch([
      f.db.prepare(
        "INSERT INTO insurers(id,agency_id,code,name) VALUES('stats-insurer','agency-auth-test','STATS','Synthetic')",
      ),
      f.db.prepare(
        "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('stats-health','agency-auth-test','HEALTH','Synthetic','HEALTH')",
      ),
      f.db.prepare(
        "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('stats-product','agency-auth-test','stats-insurer','stats-health','STATS','Synthetic')",
      ),
      f.db.prepare(
        "INSERT INTO payment_methods(id,agency_id,code,name,supports_installments,max_installments) VALUES('stats-payment','agency-auth-test','STATS','Synthetic',0,12)",
      ),
      f.db
        .prepare(`INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency)
        VALUES('stats-health-policy','agency-auth-test','stats-customer','stats-insurer','stats-product','stats-health','stats-payment','membership-stats-a','STATS-H','STATSH','2026-01-01','2026-11-01',10000,'TRY')`),
    ]);
    await task('stats-health-open', 'stats-a', now);
    await task('stats-health-completed', 'stats-b', now, { by: 'stats-a', at: now });
    await f.db
      .prepare(
        "UPDATE tasks SET policy_id='stats-health-policy',version=version+1 WHERE id IN ('stats-health-open','stats-health-completed')",
      )
      .run();
    expect((await data(employeeCookie, '')).summary).toMatchObject({
      dueToday: 2,
      completedLast30Days: 1,
    });
    expect((await data()).summary).toMatchObject({ dueToday: 2, completedLast30Days: 2 });
    for (const id of ['stats-a', 'stats-owner'])
      await f.db
        .prepare(
          "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,'sensitive.health.read','UNSCOPED')",
        )
        .bind('stats-health-' + id, 'membership-' + id)
        .run();
    try {
      expect((await data(employeeCookie, '')).summary).toMatchObject({
        dueToday: 3,
        completedLast30Days: 2,
      });
      expect((await data()).summary).toMatchObject({ dueToday: 3, completedLast30Days: 3 });
    } finally {
      await f.db
        .prepare(
          "DELETE FROM membership_permissions WHERE id IN ('stats-health-stats-a','stats-health-stats-owner')",
        )
        .run();
    }
  });
  it('counts a real renewal completion by its recorded OWNER actor and transfers only replacement workload', async () => {
    await f.db.batch([
      f.db.prepare(
        "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('stats-general','agency-auth-test','GENERAL','Synthetic','GENERAL')",
      ),
      f.db.prepare(
        "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('stats-general-product','agency-auth-test','stats-insurer','stats-general','GENERAL','Synthetic')",
      ),
      f.db
        .prepare(`INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency)
        VALUES('stats-flow-policy','agency-auth-test','stats-customer','stats-insurer','stats-general-product','stats-general','stats-payment','membership-stats-a','STATS-F','STATSF','2026-01-01','2026-11-01',10000,'TRY')`),
      f.db.prepare(
        "INSERT INTO renewal_opportunities(id,agency_id,expiring_policy_id,assignee_membership_id,state) VALUES('stats-flow-renewal','agency-auth-test','stats-flow-policy','membership-stats-a','CONTACT_PENDING')",
      ),
      f.db
        .prepare(
          "INSERT INTO tasks(id,agency_id,customer_id,renewal_id,kind,title,due_at,assignee_membership_id,actor_kind) VALUES('stats-flow-task','agency-auth-test','stats-customer','stats-flow-renewal','RENEWAL_FOLLOWUP','Synthetic',?,'membership-stats-a','SYSTEM')",
        )
        .bind(now),
    ]);
    const completedBefore = (await data(employeeCookie, '')).summary.completedLast30Days;
    const response = await f.request(
      '/api/renewals/stats-flow-renewal/tasks/stats-flow-task/complete',
      'POST',
      ownerCookie,
      {
        expectedRenewalVersion: 1,
        expectedTaskVersion: 1,
        replacementDueAt: '2026-10-19T06:00:00.000Z',
      },
      await f.csrf(ownerCookie),
      { 'idempotency-key': 'stats-flow-complete' },
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const completion = (
      (await response.json()) as {
        data: { replacementTaskId: string; replacementTaskVersion: number; renewalVersion: number };
      }
    ).data;
    expect(
      await f.db
        .prepare(
          "SELECT assignee_membership_id,completed_by_membership_id FROM tasks WHERE id='stats-flow-task'",
        )
        .first(),
    ).toEqual({
      assignee_membership_id: 'membership-stats-a',
      completed_by_membership_id: 'membership-stats-owner',
    });
    expect((await data(employeeCookie, '')).summary.completedLast30Days).toBe(completedBefore);
    expect(
      (await data()).employees.find((row) => row.membershipId === 'membership-stats-owner')
        ?.completedLast30Days,
    ).toBe(1);
    const upcomingBefore = (await data(employeeCookie, '')).summary.upcoming;
    const assigned = await f.request(
      `/api/renewals/stats-flow-renewal/tasks/${completion.replacementTaskId}/assign`,
      'POST',
      ownerCookie,
      {
        expectedRenewalVersion: completion.renewalVersion,
        expectedTaskVersion: completion.replacementTaskVersion,
        assigneeMembershipId: 'membership-stats-b',
      },
      await f.csrf(ownerCookie),
      { 'idempotency-key': 'stats-flow-assign' },
    );
    expect(assigned.status, await assigned.clone().text()).toBe(200);
    expect((await data(employeeCookie, '')).summary.upcoming).toBe(upcomingBefore - 1);
    expect(
      (await data()).employees.find((row) => row.membershipId === 'membership-stats-owner')
        ?.completedLast30Days,
    ).toBe(1);
  });
  it('paginates employee rows without truncating team totals or disclosing other agencies', async () => {
    const before = await data();
    const ids = Array.from(
      { length: 52 },
      (_, index) => `stats-page-${String(index).padStart(2, '0')}`,
    );
    await f.db.batch(
      ids.flatMap((id) => [
        f.db
          .prepare("INSERT INTO users(id,status,display_name) VALUES(?,'INACTIVE',?)")
          .bind(id, id),
        f.db
          .prepare(
            "INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at) VALUES(?,'agency-auth-test',?,'MEMBER','INVITED',?,'2099-01-01T00:00:00.000Z')",
          )
          .bind('membership-' + id, id, id + '@example.invalid'),
      ]),
    );
    await task('stats-page-work', ids[51]!, '2026-10-19T06:00:00.000Z');
    const first = await data();
    expect(first.employees).toHaveLength(50);
    expect(first.summary).toEqual({ ...before.summary, upcoming: before.summary.upcoming + 1 });
    expect(first.nextCursor).not.toBeNull();
    const second = await data(
      ownerCookie,
      '?view=team&cursor=' + encodeURIComponent(first.nextCursor!),
    );
    expect(second.summary).toEqual(first.summary);
    expect(second.nextCursor).toBeNull();
    const collected = [...first.employees, ...second.employees].map((row) => row.membershipId);
    const expected = await f.db
      .prepare("SELECT id FROM agency_memberships WHERE agency_id='agency-auth-test' ORDER BY id")
      .all<{ id: string }>();
    expect(collected).toEqual(expected.results.map((row) => row.id));
    expect(new Set(collected).size).toBe(collected.length);
    expect(collected).not.toContain('membership-stats-foreign-owner');
  });
});
