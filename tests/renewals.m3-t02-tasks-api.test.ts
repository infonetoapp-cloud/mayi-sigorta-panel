// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import miniflare from 'miniflare';
import { createApp, type Env } from '../src/server/index';
import { listRenewalTaskAssignmentOptions, listTodayTasks } from '../src/server/tasks/service';
import { TaskValidationError } from '../src/server/tasks/errors';
import type { AuthenticatedUserContext } from '../src/server/auth/identity';
import type { VerifiedAccessPrincipal } from '../src/server/auth/types';

const { Miniflare, convertV4MiniflareOptions } = miniflare;
const root = resolve(__dirname, '..');
const context: AuthenticatedUserContext = {
  userId: 'task-actor-user',
  identityId: 'task-actor-identity',
  assurance: 'NORMAL',
  memberships: [
    {
      id: 'task-actor-membership',
      agencyId: 'task-agency',
      type: 'OWNER',
      status: 'ACTIVE',
      permissionVersion: 2,
    },
  ],
};
const memberContext: AuthenticatedUserContext = {
  userId: 'task-member-user',
  identityId: 'task-member-identity',
  assurance: 'NORMAL',
  memberships: [
    {
      id: 'task-member-membership',
      agencyId: 'task-agency',
      type: 'MEMBER',
      status: 'ACTIVE',
      permissionVersion: 2,
    },
  ],
};
const principal = { subject: 'task-actor-subject' } as VerifiedAccessPrincipal;

function createTaskApp(authenticatedContext: AuthenticatedUserContext) {
  return createApp({
    createVerifier: (config) => ({ config, verify: async () => principal }),
    createResolver: () => ({ resolve: async () => authenticatedContext }) as never,
  });
}

function databaseWithFailedAllResult(db: D1Database, queryFragment: string): D1Database {
  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(statementTarget, operation) {
        if (operation === 'all') return async () => ({ success: false, results: [] });
        const value = Reflect.get(statementTarget, operation, statementTarget);
        if (operation === 'bind' && typeof value === 'function') {
          return (...bindings: unknown[]) =>
            wrap(Reflect.apply(value, statementTarget, bindings) as D1PreparedStatement);
        }
        return typeof value === 'function' ? value.bind(statementTarget) : value;
      },
    });

  return new Proxy(db, {
    get(target, property) {
      if (property === 'prepare') {
        return (query: string) => {
          const statement = target.prepare(query);
          return query.includes(queryFragment) ? wrap(statement) : statement;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as D1Database;
}

async function seedRenewalTask(db: D1Database, suffix: string) {
  const policyId = `task-policy-${suffix}`;
  const renewalId = `task-renewal-${suffix}`;
  const taskId = `task-primary-${suffix}`;
  const policyNumber = `TASK-${suffix.toUpperCase()}`;
  const now = '2026-09-24T06:00:00.000Z';
  await db.batch([
    db
      .prepare(
        `INSERT INTO policies
           (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
            assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
            gross_premium_minor,currency)
         VALUES(?,?,?,?,?,?,?,?,?,?,'2026-01-01','2026-11-01',10000,'TRY')`,
      )
      .bind(
        policyId,
        'task-agency',
        'task-customer',
        'task-insurer',
        'task-product',
        'task-branch',
        'task-payment',
        'task-actor-membership',
        policyNumber,
        policyNumber,
      ),
    db
      .prepare(
        `INSERT INTO renewal_opportunities
           (id,agency_id,expiring_policy_id,assignee_membership_id,state,version,created_at,updated_at)
         VALUES(?,?,?,NULL,'CONTACT_PENDING',1,?,?)`,
      )
      .bind(renewalId, 'task-agency', policyId, now, now),
    db
      .prepare(
        `INSERT INTO tasks
           (id,agency_id,customer_id,renewal_id,kind,title,due_at,assignee_membership_id,status,
            actor_kind,version,created_at,updated_at)
         VALUES(?,?,?,?,'RENEWAL_FOLLOWUP','Yenileme takibi',?,NULL,'OPEN','SYSTEM',1,?,?)`,
      )
      .bind(taskId, 'task-agency', 'task-customer', renewalId, now, now, now),
  ]);
  return { policyId, renewalId, taskId };
}

describe('M3-T02 scoped Today’s Work API', () => {
  let mf: miniflare.Miniflare;
  let db: D1Database;

  beforeAll(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T06:00:00.000Z'));
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: 'export default { fetch() { return new Response(null); } }',
        d1Databases: { DB: '00000000-0000-0000-0000-000000000032' },
      }),
    );
    db = await mf.getD1Database('DB');
    for (const file of readdirSync(resolve(root, 'db/migrations'))
      .filter((name) => /^\d{4}_.*\.sql$/.test(name))
      .sort()) {
      for (const statement of readFileSync(resolve(root, 'db/migrations', file), 'utf8')
        .split('--> statement-breakpoint')
        .map((part) => part.trim())
        .filter(Boolean)) {
        await db.prepare(statement).run();
      }
    }

    await db.batch([
      db.prepare("INSERT INTO agencies(id,status) VALUES('task-agency','PROVISIONING')"),
      db.prepare("INSERT INTO users(id,status,version) VALUES('task-actor-user','INACTIVE',1)"),
      db.prepare(
        `INSERT INTO agency_memberships
           (id,agency_id,user_id,type,status,permission_version,version,invitation_email,
            invitation_expires_at,activated_at)
         VALUES('task-actor-membership','task-agency','task-actor-user','OWNER','INVITED',1,1,
           'task-actor@test.test','2099-01-01T00:00:00.000Z',NULL)`,
      ),
      db.prepare(
        `INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email,status)
         VALUES('task-actor-identity','task-actor-user','https://team.cloudflareaccess.com',
           'task-actor-subject','task-actor@test.test','ACTIVE')`,
      ),
    ]);
    await db.prepare("UPDATE users SET status='ACTIVE',version=2 WHERE id='task-actor-user'").run();
    await db
      .prepare(
        `UPDATE agency_memberships SET status='ACTIVE',activated_at='2026-01-01T00:00:00.000Z',
           permission_version=2,version=2 WHERE id='task-actor-membership'`,
      )
      .run();
    await db
      .prepare(
        `UPDATE agencies SET status='ACTIVE',bootstrap_completed_at='2026-01-01T00:00:00.000Z',
           activated_at='2026-01-01T00:00:00.000Z',version=2 WHERE id='task-agency'`,
      )
      .run();

    await db.batch([
      db.prepare("INSERT INTO users(id,status,version) VALUES('task-member-user','INACTIVE',1)"),
      db.prepare(
        `INSERT INTO agency_memberships
           (id,agency_id,user_id,type,status,permission_version,version,invitation_email,
            invitation_expires_at)
         VALUES('task-member-membership','task-agency','task-member-user','MEMBER','INVITED',1,1,
           'task-member@test.test','2099-01-01T00:00:00.000Z')`,
      ),
      db.prepare(
        `INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email,status)
         VALUES('task-member-identity','task-member-user','https://team.cloudflareaccess.com',
           'task-member-subject','task-member@test.test','ACTIVE')`,
      ),
      db.prepare("INSERT INTO users(id,status,version) VALUES('inactive-task-user','INACTIVE',1)"),
      db.prepare(
        `INSERT INTO agency_memberships
           (id,agency_id,user_id,type,status,permission_version,version,invitation_email,
            invitation_expires_at)
         VALUES('inactive-task-membership','task-agency','inactive-task-user','MEMBER','INVITED',1,1,
           'inactive-task@test.test','2099-01-01T00:00:00.000Z')`,
      ),
    ]);
    await db
      .prepare("UPDATE users SET status='ACTIVE',version=2 WHERE id='task-member-user'")
      .run();
    await db
      .prepare(
        `UPDATE agency_memberships SET status='ACTIVE',activated_at='2026-01-01T00:00:00.000Z',
           permission_version=2,version=2 WHERE id='task-member-membership'`,
      )
      .run();
    await db.batch([
      db.prepare(
        `INSERT INTO membership_permissions(id,membership_id,permission_code,scope)
         VALUES('task-member-task-read','task-member-membership','task.read','ASSIGNED'),
               ('task-member-renewal-read','task-member-membership','renewal.read','ASSIGNED'),
               ('task-member-customer-read','task-member-membership','customer.read','AGENCY'),
               ('task-member-policy-read','task-member-membership','policy.read','AGENCY'),
               ('task-member-task-update','task-member-membership','task.update','ASSIGNED'),
               ('task-member-task-create','task-member-membership','task.create','UNSCOPED')`,
      ),
    ]);

    await db.batch([
      db.prepare(
        `INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,phone,assignee_membership_id)
         VALUES('task-customer','task-agency','INDIVIDUAL','Ada Yılmaz','Ada','Yılmaz','+905551112233',
           'task-actor-membership'),
               ('task-customer-member','task-agency','INDIVIDUAL','Member Customer','Member','Customer',
           '+905551234567','task-member-membership'),
               ('task-customer-unassigned','task-agency','INDIVIDUAL','Unassigned Customer','Unassigned','Customer',
           '+905551234568','inactive-task-membership')`,
      ),
      db.prepare(
        "INSERT INTO insurers(id,agency_id,code,name) VALUES('task-insurer','task-agency','INS','Insurer')",
      ),
      db.prepare(
        `INSERT INTO insurance_branches(id,agency_id,code,name,data_classification)
         VALUES('task-branch','task-agency','AUTO','Auto','GENERAL')`,
      ),
      db.prepare(
        `INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name)
         VALUES('task-product','task-agency','task-insurer','task-branch','AUTO','Auto')`,
      ),
      db.prepare(
        `INSERT INTO payment_methods(id,agency_id,code,name,supports_installments,max_installments)
         VALUES('task-payment','task-agency','CASH','Cash',0,12)`,
      ),
      db.prepare(
        `INSERT INTO policies
           (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
            assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
            gross_premium_minor,currency)
         VALUES('task-policy','task-agency','task-customer','task-insurer','task-product','task-branch',
           'task-payment','task-actor-membership','POL-001','POL001','2026-01-01','2026-10-24',10000,'TRY'),
               ('task-policy-member','task-agency','task-customer-member','task-insurer','task-product','task-branch',
           'task-payment','task-member-membership','POL-002','POL002','2026-01-01','2026-10-25',20000,'TRY'),
               ('task-policy-unassigned','task-agency','task-customer-unassigned','task-insurer','task-product','task-branch',
           'task-payment','inactive-task-membership','POL-003','POL003','2026-01-01','2026-10-26',30000,'TRY')`,
      ),
      db.prepare(
        `INSERT INTO renewal_opportunities
           (id,agency_id,expiring_policy_id,assignee_membership_id,state,version,created_at,updated_at)
         VALUES('task-renewal','task-agency','task-policy','task-actor-membership','CONTACT_PENDING',1,
           '2026-09-24T06:00:00.000Z','2026-09-24T06:00:00.000Z'),
               ('task-renewal-member','task-agency','task-policy-member','task-member-membership','CONTACT_PENDING',1,
           '2026-09-24T06:00:00.000Z','2026-09-24T06:00:00.000Z'),
               ('task-renewal-unassigned','task-agency','task-policy-unassigned',NULL,'CONTACT_PENDING',1,
           '2026-09-24T06:00:00.000Z','2026-09-24T06:00:00.000Z')`,
      ),
      db.prepare(
        `INSERT INTO tasks
           (id,agency_id,customer_id,renewal_id,kind,title,due_at,assignee_membership_id,status,
            actor_kind,version,created_at,updated_at)
         VALUES('task-primary','task-agency','task-customer','task-renewal','RENEWAL_FOLLOWUP',
           'Yenileme takibi','2026-09-24T06:00:00.000Z','task-actor-membership','OPEN','SYSTEM',1,
           '2026-09-24T06:00:00.000Z','2026-09-24T06:00:00.000Z'),
               ('task-primary-member','task-agency','task-customer-member','task-renewal-member','RENEWAL_FOLLOWUP',
           'Member follow-up','2026-09-24T06:00:00.000Z','task-member-membership','OPEN','SYSTEM',1,
           '2026-09-24T06:00:00.000Z','2026-09-24T06:00:00.000Z'),
               ('task-primary-unassigned','task-agency','task-customer-unassigned','task-renewal-unassigned','RENEWAL_FOLLOWUP',
           'Unassigned follow-up','2026-09-24T06:00:00.000Z',NULL,'OPEN','SYSTEM',1,
           '2026-09-24T06:00:00.000Z','2026-09-24T06:00:00.000Z')`,
      ),
    ]);
  });

  afterAll(async () => {
    vi.useRealTimers();
    await mf.dispose();
  });

  it('returns only authorized open renewal tasks with minimal customer and policy context', async () => {
    const direct = await listTodayTasks(context, db, { limit: 25, cursor: undefined });
    expect(direct.items).toHaveLength(2);
    expect(
      (direct as unknown as { unassignedItems: Array<{ taskId: string }> }).unassignedItems.map(
        (item) => item.taskId,
      ),
    ).toEqual(['task-primary-unassigned']);
    const response = await createTaskApp(context).request(
      'https://panel.mayisigorta.test/api/tasks/today',
      { method: 'GET' },
      {
        DB: db,
        CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
        CF_ACCESS_AUDIENCE: 'normal-audience',
        CF_ACCESS_SECURE_AUDIENCE: 'secure-audience',
        CSRF_SECRET: 'test-csrf-secret-that-is-long-enough',
      } satisfies Env,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const envelope = (await response.json()) as {
      success: boolean;
      data: {
        items: Array<Record<string, unknown>>;
        unassignedItems: Array<Record<string, unknown>>;
        todayLocalDate: string;
        timezone: string;
        canSeeUnassigned: boolean;
      };
    };
    expect(envelope.success).toBe(true);
    expect(envelope.data.todayLocalDate).toBe('2026-09-24');
    expect(envelope.data.timezone).toBe('Europe/Istanbul');
    expect(envelope.data.items).toHaveLength(2);
    expect(envelope.data.canSeeUnassigned).toBe(true);
    const actorTask = envelope.data.items.find((task) => task.taskId === 'task-primary');
    expect(actorTask?.taskId).toBe('task-primary');
    expect(actorTask?.renewalId).toBe('task-renewal');
    expect(actorTask?.customerDisplayName).toBe('Ada Yılmaz');
    expect(actorTask?.customerPhone).toBe('+905551112233');
    expect(actorTask?.policyNumber).toBe('POL-001');
    expect(actorTask?.dueAt).toBe('2026-09-24T06:00:00.000Z');
    expect(actorTask?.bucket).toBe('TODAY');
    expect(actorTask).not.toHaveProperty('address');
    expect(actorTask).not.toHaveProperty('identity');
    expect(envelope.data.unassignedItems).toHaveLength(1);
    expect(envelope.data.unassignedItems[0]).toMatchObject({
      isUnassigned: true,
      assigneeMembershipId: null,
    });
  });

  it('does not report an empty Today’s Work page when the database query fails', async () => {
    const failingDb = databaseWithFailedAllResult(db, 'SELECT t.id AS task_id');

    await expect(
      listTodayTasks(context, failingDb, { limit: 25, cursor: undefined }),
    ).rejects.toMatchObject({
      code: 'TASK_QUERY_FAILED',
    } satisfies Partial<TaskValidationError>);

    const response = await createTaskApp(context).request(
      'https://panel.mayisigorta.test/api/tasks/today',
      { method: 'GET' },
      {
        DB: failingDb,
        CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
        CF_ACCESS_AUDIENCE: 'normal-audience',
        CF_ACCESS_SECURE_AUDIENCE: 'secure-audience',
        CSRF_SECRET: 'test-csrf-secret-that-is-long-enough',
      } satisfies Env,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: 'SERVICE_UNAVAILABLE' },
    });
  });

  it('filters ASSIGNED collections by persisted Renewal/Customer ownership and hides the unassigned queue', async () => {
    const response = await createTaskApp(memberContext).request(
      'https://panel.mayisigorta.test/api/tasks/today',
      { method: 'GET' },
      {
        DB: db,
        CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
        CF_ACCESS_AUDIENCE: 'normal-audience',
        CF_ACCESS_SECURE_AUDIENCE: 'secure-audience',
        CSRF_SECRET: 'test-csrf-secret-that-is-long-enough',
      } satisfies Env,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const envelope = (await response.json()) as {
      success: boolean;
      data: {
        items: Array<Record<string, unknown>>;
        unassignedItems: Array<Record<string, unknown>>;
        canSeeUnassigned: boolean;
      };
    };
    expect(envelope.data.canSeeUnassigned).toBe(false);
    expect(envelope.data.items).toHaveLength(1);
    expect(envelope.data.unassignedItems).toHaveLength(0);
    expect(envelope.data.items[0]).toMatchObject({
      taskId: 'task-primary-member',
      renewalId: 'task-renewal-member',
      customerDisplayName: 'Member Customer',
      isUnassigned: false,
    });
    expect(envelope.data.items.map((task) => task.taskId)).not.toContain('task-primary-unassigned');
    expect(envelope.data.items.map((task) => task.taskId)).not.toContain('task-primary');
  });

  it('does not let Customer assignment expose an unassigned Task to an ASSIGNED member', async () => {
    await db
      .prepare(
        `UPDATE customers SET assignee_membership_id='task-member-membership',version=version+1,
         updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='task-customer-unassigned'`,
      )
      .run();
    try {
      const response = await createTaskApp(memberContext).request(
        'https://panel.mayisigorta.test/api/tasks/today',
        { method: 'GET' },
        {
          DB: db,
          CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
          CF_ACCESS_AUDIENCE: 'normal-audience',
          CF_ACCESS_SECURE_AUDIENCE: 'secure-audience',
          CSRF_SECRET: 'test-csrf-secret-that-is-long-enough',
        } satisfies Env,
      );
      expect(response.status).toBe(200);
      const envelope = (await response.json()) as {
        data: {
          items: Array<{ taskId: string; isUnassigned: boolean }>;
          unassignedItems: Array<{ taskId: string }>;
          canSeeUnassigned: boolean;
        };
      };
      expect(envelope.data.canSeeUnassigned).toBe(false);
      expect(envelope.data.items.map((task) => task.taskId)).not.toContain(
        'task-primary-unassigned',
      );
      expect(envelope.data.unassignedItems).toEqual([]);
    } finally {
      await db
        .prepare(
          `UPDATE customers SET assignee_membership_id='inactive-task-membership',version=version+1,
           updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='task-customer-unassigned'`,
        )
        .run();
    }
  });

  it('limits assignment options to active members with linked Renewal and Task read access', async () => {
    const response = await createTaskApp(context).request(
      'https://panel.mayisigorta.test/api/renewals/task-renewal/tasks/task-primary/assignment-options',
      { method: 'GET' },
      {
        DB: db,
        CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
        CF_ACCESS_AUDIENCE: 'normal-audience',
        CF_ACCESS_SECURE_AUDIENCE: 'secure-audience',
        CSRF_SECRET: 'test-csrf-secret-that-is-long-enough',
      } satisfies Env,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const envelope = (await response.json()) as {
      success: boolean;
      data: Array<{ membershipId: string; label: string; membershipType: string }>;
    };
    expect(envelope.success).toBe(true);
    expect(envelope.data).toContainEqual({
      membershipId: 'task-member-membership',
      label: 'task-member@test.test',
      membershipType: 'MEMBER',
    });
    expect(envelope.data.map((item) => item.membershipId)).not.toContain(
      'inactive-task-membership',
    );
  });

  it('does not present an empty assignee list when the assignment query fails', async () => {
    const failingDb = databaseWithFailedAllResult(db, 'SELECT m.id,m.invitation_email,m.type');

    await expect(
      listRenewalTaskAssignmentOptions(context, failingDb, 'task-renewal', 'task-primary'),
    ).rejects.toMatchObject({ code: 'ASSIGNMENT_OPTIONS_QUERY_FAILED' });

    const response = await createTaskApp(context).request(
      'https://panel.mayisigorta.test/api/renewals/task-renewal/tasks/task-primary/assignment-options',
      { method: 'GET' },
      {
        DB: failingDb,
        CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
        CF_ACCESS_AUDIENCE: 'normal-audience',
        CF_ACCESS_SECURE_AUDIENCE: 'secure-audience',
        CSRF_SECRET: 'test-csrf-secret-that-is-long-enough',
      } satisfies Env,
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: 'SERVICE_UNAVAILABLE' },
    });
  });

  it('does not disclose assignment options outside the current Renewal scope', async () => {
    const response = await createTaskApp(memberContext).request(
      'https://panel.mayisigorta.test/api/renewals/task-renewal/tasks/task-primary/assignment-options',
      { method: 'GET' },
      {
        DB: db,
        CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
        CF_ACCESS_AUDIENCE: 'normal-audience',
        CF_ACCESS_SECURE_AUDIENCE: 'secure-audience',
        CSRF_SECRET: 'test-csrf-secret-that-is-long-enough',
      } satisfies Env,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
  });

  it('paginates deterministically within the authorized task collection', async () => {
    const secondUnassignedTask = await seedRenewalTask(db, 'unassigned-queue-page');
    const first = await createTaskApp(context).request(
      'https://panel.mayisigorta.test/api/tasks/today?limit=1',
      { method: 'GET' },
      {
        DB: db,
        CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
        CF_ACCESS_AUDIENCE: 'normal-audience',
        CF_ACCESS_SECURE_AUDIENCE: 'secure-audience',
        CSRF_SECRET: 'test-csrf-secret-that-is-long-enough',
      } satisfies Env,
    );
    const firstEnvelope = (await first.json()) as {
      data: {
        items: Array<{ taskId: string }>;
        unassignedItems: Array<{ taskId: string }>;
        hasMore: boolean;
        nextCursor: string | null;
        unassignedHasMore: boolean;
        unassignedNextCursor: string | null;
      };
    };
    expect(firstEnvelope.data.items.map((item) => item.taskId)).toEqual(['task-primary']);
    expect(firstEnvelope.data.hasMore).toBe(true);
    expect(firstEnvelope.data.nextCursor).not.toBeNull();
    expect(firstEnvelope.data.unassignedItems.map((item) => item.taskId)).toEqual([
      'task-primary-unassigned',
    ]);
    expect(firstEnvelope.data.unassignedHasMore).toBe(true);
    expect(firstEnvelope.data.unassignedNextCursor).not.toBeNull();

    const second = await createTaskApp(context).request(
      `https://panel.mayisigorta.test/api/tasks/today?limit=1&cursor=${encodeURIComponent(firstEnvelope.data.nextCursor!)}`,
      { method: 'GET' },
      {
        DB: db,
        CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
        CF_ACCESS_AUDIENCE: 'normal-audience',
        CF_ACCESS_SECURE_AUDIENCE: 'secure-audience',
        CSRF_SECRET: 'test-csrf-secret-that-is-long-enough',
      } satisfies Env,
    );
    const secondEnvelope = (await second.json()) as {
      data: { items: Array<{ taskId: string }>; hasMore: boolean };
    };
    expect(secondEnvelope.data.items.map((item) => item.taskId)).toEqual(['task-primary-member']);
    expect(secondEnvelope.data.hasMore).toBe(false);

    const secondUnassignedPage = await createTaskApp(context).request(
      `https://panel.mayisigorta.test/api/tasks/today?limit=1&unassignedCursor=${encodeURIComponent(firstEnvelope.data.unassignedNextCursor!)}`,
      { method: 'GET' },
      {
        DB: db,
        CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
        CF_ACCESS_AUDIENCE: 'normal-audience',
        CF_ACCESS_SECURE_AUDIENCE: 'secure-audience',
        CSRF_SECRET: 'test-csrf-secret-that-is-long-enough',
      } satisfies Env,
    );
    expect(secondUnassignedPage.status).toBe(200);
    const secondUnassignedEnvelope = (await secondUnassignedPage.json()) as {
      data: { unassignedItems: Array<{ taskId: string }>; unassignedHasMore: boolean };
    };
    expect(secondUnassignedEnvelope.data.unassignedItems.map((item) => item.taskId)).toEqual([
      secondUnassignedTask.taskId,
    ]);
    expect(secondUnassignedEnvelope.data.unassignedHasMore).toBe(false);

    const assignedCursorUsedForQueue = await createTaskApp(context).request(
      `https://panel.mayisigorta.test/api/tasks/today?unassignedCursor=${encodeURIComponent(firstEnvelope.data.nextCursor!)}`,
      { method: 'GET' },
      {
        DB: db,
        CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
        CF_ACCESS_AUDIENCE: 'normal-audience',
        CF_ACCESS_SECURE_AUDIENCE: 'secure-audience',
        CSRF_SECRET: 'test-csrf-secret-that-is-long-enough',
      } satisfies Env,
    );
    expect(assignedCursorUsedForQueue.status).toBe(400);
    expect(await assignedCursorUsedForQueue.json()).toMatchObject({
      success: false,
      error: { code: 'INVALID_CURSOR' },
    });

    const ownerCursorUsedByMember = await createTaskApp(memberContext).request(
      `https://panel.mayisigorta.test/api/tasks/today?cursor=${encodeURIComponent(firstEnvelope.data.nextCursor!)}`,
      { method: 'GET' },
      {
        DB: db,
        CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
        CF_ACCESS_AUDIENCE: 'normal-audience',
        CF_ACCESS_SECURE_AUDIENCE: 'secure-audience',
        CSRF_SECRET: 'test-csrf-secret-that-is-long-enough',
      } satisfies Env,
    );
    expect(ownerCursorUsedByMember.status).toBe(400);
    expect(await ownerCursorUsedByMember.json()).toMatchObject({
      success: false,
      error: { code: 'INVALID_CURSOR' },
    });
  });

  it('rejects malformed task pagination cursors', async () => {
    const response = await createTaskApp(context).request(
      'https://panel.mayisigorta.test/api/tasks/today?cursor=not-base64',
      { method: 'GET' },
      {
        DB: db,
        CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
        CF_ACCESS_AUDIENCE: 'normal-audience',
        CF_ACCESS_SECURE_AUDIENCE: 'secure-audience',
        CSRF_SECRET: 'test-csrf-secret-that-is-long-enough',
      } satisfies Env,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: 'INVALID_CURSOR' },
    });
  });

  it('accepts a bound-shape cursor longer than 256 characters for normal UUID identifiers', async () => {
    const cursor = btoa(
      JSON.stringify([
        'UNASSIGNED',
        'a'.repeat(36),
        'b'.repeat(36),
        1,
        'AGENCY',
        'AGENCY',
        'AGENCY',
        'AGENCY',
        null,
        '2026-09-24T06:00:00.000Z',
        'c'.repeat(36),
      ]),
    );
    expect(cursor.length).toBe(268);
    const response = await createTaskApp(context).request(
      `https://panel.mayisigorta.test/api/tasks/today?unassignedCursor=${encodeURIComponent(cursor)}`,
      { method: 'GET' },
      {
        DB: db,
        CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
        CF_ACCESS_AUDIENCE: 'normal-audience',
        CF_ACCESS_SECURE_AUDIENCE: 'secure-audience',
        CSRF_SECRET: 'test-csrf-secret-that-is-long-enough',
      } satisfies Env,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      success: false,
      error: { code: 'INVALID_CURSOR' },
    });
  });

  it('atomically assigns both Renewal and primary Task; exact retry creates one audit and changed input conflicts', async () => {
    const app = createTaskApp(context);
    const env = {
      DB: db,
      CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
      CF_ACCESS_AUDIENCE: 'normal-audience',
      CF_ACCESS_SECURE_AUDIENCE: 'secure-audience',
      CSRF_SECRET: 'test-csrf-secret-that-is-long-enough',
    } satisfies Env;
    const csrfResponse = await app.request(
      'https://panel.mayisigorta.test/api/csrf-token',
      { method: 'GET' },
      env,
    );
    expect(csrfResponse.status).toBe(200);
    const csrf = ((await csrfResponse.json()) as { data: { token: string } }).data.token;
    const body = {
      expectedRenewalVersion: 1,
      expectedTaskVersion: 1,
      assigneeMembershipId: 'task-member-membership',
    };
    const request = () =>
      app.request(
        'https://panel.mayisigorta.test/api/renewals/task-renewal/tasks/task-primary/assign',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://panel.mayisigorta.com',
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'task-assignment-key-1',
          },
          body: JSON.stringify(body),
        },
        env,
      );

    const first = await request();
    expect(first.status, await first.clone().text()).toBe(200);
    const firstEnvelope = (await first.json()) as {
      success: boolean;
      data: { assigneeMembershipId: string; renewalVersion: number; taskVersion: number };
    };
    expect(firstEnvelope.data).toMatchObject({
      assigneeMembershipId: 'task-member-membership',
      renewalVersion: 2,
      taskVersion: 2,
    });
    expect(
      await db
        .prepare("SELECT assignee_membership_id FROM renewal_opportunities WHERE id='task-renewal'")
        .first<{ assignee_membership_id: string }>(),
    ).toEqual({ assignee_membership_id: 'task-member-membership' });
    expect(
      await db
        .prepare("SELECT assignee_membership_id FROM tasks WHERE id='task-primary'")
        .first<{ assignee_membership_id: string }>(),
    ).toEqual({ assignee_membership_id: 'task-member-membership' });

    const persistedReceipt = await db
      .prepare(
        "SELECT response_body FROM operation_receipts WHERE idempotency_key='task-assignment-key-1'",
      )
      .first<{ response_body: string }>();
    const tamperedReceipt = JSON.parse(persistedReceipt?.response_body ?? '{}') as Record<
      string,
      unknown
    >;
    tamperedReceipt.updatedAt = '2026-09-24T06:00:01.000Z';
    await db
      .prepare(
        "UPDATE operation_receipts SET response_body=? WHERE idempotency_key='task-assignment-key-1'",
      )
      .bind(JSON.stringify(tamperedReceipt))
      .run();
    try {
      const tamperedReplay = await request();
      expect(tamperedReplay.status, await tamperedReplay.clone().text()).toBe(404);
    } finally {
      await db
        .prepare(
          "UPDATE operation_receipts SET response_body=? WHERE idempotency_key='task-assignment-key-1'",
        )
        .bind(persistedReceipt?.response_body ?? '')
        .run();
    }

    const replay = await request();
    expect(replay.status).toBe(200);
    const replayEnvelope = (await replay.json()) as { data: unknown };
    expect(replayEnvelope.data).toEqual(firstEnvelope.data);
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS count FROM audit_events WHERE action='renewal.task.assigned'",
          )
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);

    const otherTargetConflict = await app.request(
      'https://panel.mayisigorta.test/api/renewals/task-renewal-unassigned/tasks/task-primary-unassigned/assign',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'task-assignment-key-1',
        },
        body: JSON.stringify(body),
      },
      env,
    );
    expect(otherTargetConflict.status).toBe(409);

    const changedPayload = { ...body, assigneeMembershipId: null };
    const conflict = await app.request(
      'https://panel.mayisigorta.test/api/renewals/task-renewal/tasks/task-primary/assign',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'task-assignment-key-1',
        },
        body: JSON.stringify(changedPayload),
      },
      env,
    );
    expect(conflict.status).toBe(409);

    const staleVersion = await app.request(
      'https://panel.mayisigorta.test/api/renewals/task-renewal/tasks/task-primary/assign',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'task-assignment-stale-version-key',
        },
        body: JSON.stringify(body),
      },
      env,
    );
    expect(staleVersion.status).toBe(409);
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS count FROM operation_receipts WHERE idempotency_key='task-assignment-stale-version-key'",
          )
          .first<{ count: number }>()
      )?.count,
    ).toBe(0);
  });

  it('rolls back Renewal assignment, Task assignment, receipt, and audit if the Task write fails', async () => {
    await db
      .prepare(
        `CREATE TRIGGER fail_task_assignment_update BEFORE UPDATE ON tasks
         WHEN NEW.id='task-primary-unassigned'
         BEGIN SELECT RAISE(ABORT,'TEST_TASK_ASSIGNMENT_FAILURE'); END`,
      )
      .run();
    try {
      const app = createTaskApp(context);
      const env = {
        DB: db,
        CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
        CF_ACCESS_AUDIENCE: 'normal-audience',
        CF_ACCESS_SECURE_AUDIENCE: 'secure-audience',
        CSRF_SECRET: 'test-csrf-secret-that-is-long-enough',
      } satisfies Env;
      const csrfResponse = await app.request(
        'https://panel.mayisigorta.test/api/csrf-token',
        { method: 'GET' },
        env,
      );
      const csrf = ((await csrfResponse.json()) as { data: { token: string } }).data.token;
      const response = await app.request(
        'https://panel.mayisigorta.test/api/renewals/task-renewal-unassigned/tasks/task-primary-unassigned/assign',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://panel.mayisigorta.com',
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'assignment-rollback-key',
          },
          body: JSON.stringify({
            expectedRenewalVersion: 1,
            expectedTaskVersion: 1,
            assigneeMembershipId: 'task-member-membership',
          }),
        },
        env,
      );
      expect(response.status).toBe(500);
      expect(
        await db
          .prepare(
            "SELECT assignee_membership_id,version FROM renewal_opportunities WHERE id='task-renewal-unassigned'",
          )
          .first(),
      ).toEqual({ assignee_membership_id: null, version: 1 });
      expect(
        await db
          .prepare(
            "SELECT assignee_membership_id,version FROM tasks WHERE id='task-primary-unassigned'",
          )
          .first(),
      ).toEqual({ assignee_membership_id: null, version: 1 });
      expect(
        (
          await db
            .prepare(
              "SELECT count(*) AS count FROM operation_receipts WHERE idempotency_key='assignment-rollback-key'",
            )
            .first<{ count: number }>()
        )?.count,
      ).toBe(0);
      expect(
        (
          await db
            .prepare(
              "SELECT count(*) AS count FROM audit_events WHERE idempotency_key='assignment-rollback-key'",
            )
            .first<{ count: number }>()
        )?.count,
      ).toBe(0);
    } finally {
      await db.prepare('DROP TRIGGER fail_task_assignment_update').run();
    }
  });

  it('denies unknown, inactive, and cross-agency assignees without changing either record', async () => {
    const fixture = await seedRenewalTask(db, 'invalid-assignee');
    await db.batch([
      db.prepare(
        "INSERT INTO agencies(id,status,version) VALUES('task-foreign-agency','PROVISIONING',1)",
      ),
      db.prepare("INSERT INTO users(id,status,version) VALUES('task-foreign-user','INACTIVE',1)"),
      db.prepare(
        "INSERT INTO users(id,status,version) VALUES('task-parent-readless-user','INACTIVE',1)",
      ),
      db.prepare(
        `INSERT INTO agency_memberships
           (id,agency_id,user_id,type,status,permission_version,version,invitation_email,invitation_expires_at)
         VALUES('foreign-task-membership','task-foreign-agency','task-foreign-user','OWNER','INVITED',1,1,
           'foreign-task@test.test','2099-01-01T00:00:00.000Z')`,
      ),
      db.prepare(
        `INSERT INTO agency_memberships
           (id,agency_id,user_id,type,status,permission_version,version,invitation_email,invitation_expires_at)
         VALUES('parent-readless-task-membership','task-agency','task-parent-readless-user','MEMBER','INVITED',1,1,
           'parent-readless-task@test.test','2099-01-01T00:00:00.000Z')`,
      ),
      db.prepare(
        `INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email,status)
         VALUES('foreign-task-identity','task-foreign-user','https://team.cloudflareaccess.com',
           'foreign-task-subject','foreign-task@test.test','ACTIVE')`,
      ),
      db.prepare(
        `INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email,status)
         VALUES('parent-readless-task-identity','task-parent-readless-user','https://team.cloudflareaccess.com',
           'parent-readless-task-subject','parent-readless-task@test.test','ACTIVE')`,
      ),
      db.prepare("UPDATE users SET status='ACTIVE',version=version+1 WHERE id='task-foreign-user'"),
      db.prepare(
        "UPDATE users SET status='ACTIVE',version=version+1 WHERE id='task-parent-readless-user'",
      ),
      db.prepare(
        `UPDATE agency_memberships SET status='ACTIVE',activated_at='2026-01-01T00:00:00.000Z',
           permission_version=permission_version+1,version=version+1 WHERE id='foreign-task-membership'`,
      ),
      db.prepare(
        `UPDATE agency_memberships SET status='ACTIVE',activated_at='2026-01-01T00:00:00.000Z',
           permission_version=permission_version+1,version=version+1
         WHERE id='parent-readless-task-membership'`,
      ),
      db.prepare(
        `INSERT INTO membership_permissions(id,membership_id,permission_code,scope)
         VALUES('parent-readless-task-read','parent-readless-task-membership','task.read','AGENCY'),
               ('parent-readless-renewal-read','parent-readless-task-membership','renewal.read','AGENCY')`,
      ),
      db.prepare(
        `UPDATE agencies SET status='ACTIVE',bootstrap_completed_at='2026-01-01T00:00:00.000Z',
           activated_at='2026-01-01T00:00:00.000Z',version=version+1 WHERE id='task-foreign-agency'`,
      ),
    ]);

    const app = createTaskApp(context);
    const env = {
      DB: db,
      CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
      CF_ACCESS_AUDIENCE: 'normal-audience',
      CF_ACCESS_SECURE_AUDIENCE: 'secure-audience',
      CSRF_SECRET: 'test-csrf-secret-that-is-long-enough',
    } satisfies Env;
    const csrfResponse = await app.request(
      'https://panel.mayisigorta.test/api/csrf-token',
      { method: 'GET' },
      env,
    );
    const csrf = ((await csrfResponse.json()) as { data: { token: string } }).data.token;
    const attempts = [
      { membershipId: 'missing-task-membership', key: 'invalid-task-assignee-missing' },
      { membershipId: 'inactive-task-membership', key: 'invalid-task-assignee-inactive' },
      { membershipId: 'foreign-task-membership', key: 'invalid-task-assignee-cross-agency' },
      {
        membershipId: 'parent-readless-task-membership',
        key: 'invalid-task-assignee-parent-readless',
      },
    ];
    for (const attempt of attempts) {
      const response = await app.request(
        `https://panel.mayisigorta.test/api/renewals/${fixture.renewalId}/tasks/${fixture.taskId}/assign`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://panel.mayisigorta.com',
            'X-CSRF-Token': csrf,
            'Idempotency-Key': attempt.key,
          },
          body: JSON.stringify({
            expectedRenewalVersion: 1,
            expectedTaskVersion: 1,
            assigneeMembershipId: attempt.membershipId,
          }),
        },
        env,
      );
      expect(response.status, await response.clone().text()).toBe(409);
      expect(await response.json()).toMatchObject({
        success: false,
        error: { code: 'ASSIGNEE_NOT_ASSIGNABLE' },
      });
    }

    expect(
      await db
        .prepare('SELECT assignee_membership_id,version FROM renewal_opportunities WHERE id=?')
        .bind(fixture.renewalId)
        .first(),
    ).toEqual({ assignee_membership_id: null, version: 1 });
    expect(
      await db
        .prepare('SELECT assignee_membership_id,version FROM tasks WHERE id=?')
        .bind(fixture.taskId)
        .first(),
    ).toEqual({ assignee_membership_id: null, version: 1 });
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS count FROM operation_receipts WHERE idempotency_key LIKE 'invalid-task-assignee-%'",
          )
          .first<{ count: number }>()
      )?.count,
    ).toBe(0);
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS count FROM audit_events WHERE idempotency_key LIKE 'invalid-task-assignee-%'",
          )
          .first<{ count: number }>()
      )?.count,
    ).toBe(0);
  });

  it('completes the primary Task only with an atomic replacement follow-up and exact replay', async () => {
    const app = createTaskApp(context);
    const env = {
      DB: db,
      CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
      CF_ACCESS_AUDIENCE: 'normal-audience',
      CF_ACCESS_SECURE_AUDIENCE: 'secure-audience',
      CSRF_SECRET: 'test-csrf-secret-that-is-long-enough',
    } satisfies Env;
    const csrfResponse = await app.request(
      'https://panel.mayisigorta.test/api/csrf-token',
      { method: 'GET' },
      env,
    );
    const csrf = ((await csrfResponse.json()) as { data: { token: string } }).data.token;
    const body = {
      expectedRenewalVersion: 1,
      expectedTaskVersion: 1,
      replacementDueAt: '2026-09-25T06:00:00.000Z',
    };
    const request = () =>
      app.request(
        'https://panel.mayisigorta.test/api/renewals/task-renewal-unassigned/tasks/task-primary-unassigned/complete',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://panel.mayisigorta.com',
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'task-complete-key-1',
          },
          body: JSON.stringify(body),
        },
        env,
      );

    const first = await request();
    expect(first.status, await first.clone().text()).toBe(200);
    const firstEnvelope = (await first.json()) as {
      success: boolean;
      data: {
        renewalId: string;
        completedTaskId: string;
        replacementTaskId: string;
        replacementDueAt: string;
        completedTaskVersion: number;
        replacementTaskVersion: number;
        renewalVersion: number;
        completedAt: string;
      };
    };
    expect(firstEnvelope.data).toMatchObject({
      renewalId: 'task-renewal-unassigned',
      completedTaskId: 'task-primary-unassigned',
      replacementDueAt: body.replacementDueAt,
      completedTaskVersion: 2,
      replacementTaskVersion: 1,
      renewalVersion: 1,
      completedAt: '2026-09-24T06:00:00.000Z',
    });
    expect(firstEnvelope.data.replacementTaskId).not.toBe('task-primary-unassigned');
    expect(
      await db
        .prepare("SELECT status,version FROM tasks WHERE id='task-primary-unassigned'")
        .first<{ status: string; version: number }>(),
    ).toEqual({ status: 'COMPLETED', version: 2 });
    expect(
      await db
        .prepare(
          `SELECT id,due_at,assignee_membership_id,actor_kind,created_by_user_id,created_by_membership_id
           FROM tasks WHERE agency_id='task-agency' AND renewal_id='task-renewal-unassigned'
             AND kind='RENEWAL_FOLLOWUP' AND status='OPEN'`,
        )
        .first<{
          id: string;
          due_at: string;
          assignee_membership_id: string | null;
          actor_kind: string;
          created_by_user_id: string | null;
          created_by_membership_id: string | null;
        }>(),
    ).toEqual({
      id: firstEnvelope.data.replacementTaskId,
      due_at: body.replacementDueAt,
      assignee_membership_id: null,
      actor_kind: 'USER',
      created_by_user_id: 'task-actor-user',
      created_by_membership_id: 'task-actor-membership',
    });

    const persistedReceipt = await db
      .prepare(
        "SELECT response_body FROM operation_receipts WHERE idempotency_key='task-complete-key-1'",
      )
      .first<{ response_body: string }>();
    expect(persistedReceipt?.response_body).toBeTruthy();
    const tamperedReceipt = JSON.parse(persistedReceipt?.response_body ?? '{}') as Record<
      string,
      unknown
    >;
    tamperedReceipt.replacementTaskId = '00000000-0000-4000-8000-000000000001';
    await db
      .prepare(
        "UPDATE operation_receipts SET response_body=? WHERE idempotency_key='task-complete-key-1'",
      )
      .bind(JSON.stringify(tamperedReceipt))
      .run();
    try {
      const tamperedReplay = await request();
      expect(tamperedReplay.status, await tamperedReplay.clone().text()).toBe(404);
      expect(await tamperedReplay.json()).toMatchObject({
        success: false,
        error: { code: 'NOT_FOUND' },
      });
    } finally {
      await db
        .prepare(
          "UPDATE operation_receipts SET response_body=? WHERE idempotency_key='task-complete-key-1'",
        )
        .bind(persistedReceipt?.response_body ?? '')
        .run();
    }

    const tamperedTimestampReceipt = JSON.parse(persistedReceipt?.response_body ?? '{}') as Record<
      string,
      unknown
    >;
    tamperedTimestampReceipt.completedAt = '2026-09-24T06:00:01.000Z';
    await db
      .prepare(
        "UPDATE operation_receipts SET response_body=? WHERE idempotency_key='task-complete-key-1'",
      )
      .bind(JSON.stringify(tamperedTimestampReceipt))
      .run();
    try {
      const tamperedTimestampReplay = await request();
      expect(tamperedTimestampReplay.status, await tamperedTimestampReplay.clone().text()).toBe(
        404,
      );
      expect(await tamperedTimestampReplay.json()).toMatchObject({
        success: false,
        error: { code: 'NOT_FOUND' },
      });
    } finally {
      await db
        .prepare(
          "UPDATE operation_receipts SET response_body=? WHERE idempotency_key='task-complete-key-1'",
        )
        .bind(persistedReceipt?.response_body ?? '')
        .run();
    }

    const replay = await request();
    expect(replay.status).toBe(200);
    const replayEnvelope = (await replay.json()) as { data: unknown };
    expect(replayEnvelope.data).toEqual(firstEnvelope.data);
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS count FROM audit_events WHERE action='renewal.task.completed_with_replacement'",
          )
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
    expect(
      await db
        .prepare(
          `SELECT count(*) AS count FROM audit_events
           WHERE action='renewal.task.replacement_created' AND target_type='tasks' AND target_id=?
             AND idempotency_key='task-complete-key-1' AND outcome='SUCCESS'`,
        )
        .bind(firstEnvelope.data.replacementTaskId)
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });

    const conflict = await app.request(
      'https://panel.mayisigorta.test/api/renewals/task-renewal-unassigned/tasks/task-primary-unassigned/complete',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'task-complete-key-1',
        },
        body: JSON.stringify({ ...body, replacementDueAt: '2026-09-26T06:00:00.000Z' }),
      },
      env,
    );
    expect(conflict.status).toBe(409);

    const otherTargetConflict = await app.request(
      'https://panel.mayisigorta.test/api/renewals/task-renewal-member/tasks/task-primary-member/complete',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'task-complete-key-1',
        },
        body: JSON.stringify(body),
      },
      env,
    );
    expect(otherTargetConflict.status).toBe(409);
  });

  it('rolls back primary Task completion when replacement Task insertion fails', async () => {
    await db
      .prepare(
        `CREATE TRIGGER fail_task_replacement_insert BEFORE INSERT ON tasks
         WHEN NEW.renewal_id='task-renewal-member' AND NEW.actor_kind='USER'
         BEGIN SELECT RAISE(ABORT,'TEST_TASK_REPLACEMENT_FAILURE'); END`,
      )
      .run();
    const app = createTaskApp(context);
    const env = {
      DB: db,
      CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
      CF_ACCESS_AUDIENCE: 'normal-audience',
      CF_ACCESS_SECURE_AUDIENCE: 'secure-audience',
      CSRF_SECRET: 'test-csrf-secret-that-is-long-enough',
    } satisfies Env;
    const csrfResponse = await app.request(
      'https://panel.mayisigorta.test/api/csrf-token',
      { method: 'GET' },
      env,
    );
    const csrf = ((await csrfResponse.json()) as { data: { token: string } }).data.token;
    const response = await app.request(
      'https://panel.mayisigorta.test/api/renewals/task-renewal-member/tasks/task-primary-member/complete',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'task-complete-rollback-key',
        },
        body: JSON.stringify({
          expectedRenewalVersion: 1,
          expectedTaskVersion: 1,
          replacementDueAt: '2026-09-25T06:00:00.000Z',
        }),
      },
      env,
    );
    expect(response.status).toBe(500);
    expect(
      await db
        .prepare("SELECT status,version FROM tasks WHERE id='task-primary-member'")
        .first<{ status: string; version: number }>(),
    ).toEqual({ status: 'OPEN', version: 1 });
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS count FROM tasks WHERE renewal_id='task-renewal-member' AND status='OPEN'",
          )
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS count FROM operation_receipts WHERE idempotency_key='task-complete-rollback-key'",
          )
          .first<{ count: number }>()
      )?.count,
    ).toBe(0);
    await db.prepare('DROP TRIGGER fail_task_replacement_insert').run();
  });

  it('rolls back completion, replacement, receipt, and both audit events when audit insertion fails', async () => {
    const fixture = await seedRenewalTask(db, 'audit-failure');
    await db
      .prepare(
        `CREATE TRIGGER fail_task_completion_audit BEFORE INSERT ON audit_events
         WHEN NEW.idempotency_key='task-completion-audit-failure-key'
           AND NEW.action='renewal.task.replacement_created'
         BEGIN SELECT RAISE(ABORT,'TEST_TASK_COMPLETION_AUDIT_FAILURE'); END`,
      )
      .run();
    try {
      const app = createTaskApp(context);
      const env = {
        DB: db,
        CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
        CF_ACCESS_AUDIENCE: 'normal-audience',
        CF_ACCESS_SECURE_AUDIENCE: 'secure-audience',
        CSRF_SECRET: 'test-csrf-secret-that-is-long-enough',
      } satisfies Env;
      const csrfResponse = await app.request(
        'https://panel.mayisigorta.test/api/csrf-token',
        { method: 'GET' },
        env,
      );
      const csrf = ((await csrfResponse.json()) as { data: { token: string } }).data.token;
      const response = await app.request(
        `https://panel.mayisigorta.test/api/renewals/${fixture.renewalId}/tasks/${fixture.taskId}/complete`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://panel.mayisigorta.com',
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'task-completion-audit-failure-key',
          },
          body: JSON.stringify({
            expectedRenewalVersion: 1,
            expectedTaskVersion: 1,
            replacementDueAt: '2026-09-25T06:00:00.000Z',
          }),
        },
        env,
      );
      expect(response.status).toBe(500);
      expect(
        await db
          .prepare('SELECT status,version FROM tasks WHERE id=?')
          .bind(fixture.taskId)
          .first(),
      ).toEqual({ status: 'OPEN', version: 1 });
      expect(
        (
          await db
            .prepare(
              "SELECT count(*) AS count FROM tasks WHERE renewal_id=? AND kind='RENEWAL_FOLLOWUP' AND status='OPEN'",
            )
            .bind(fixture.renewalId)
            .first<{ count: number }>()
        )?.count,
      ).toBe(1);
      expect(
        (
          await db
            .prepare('SELECT count(*) AS count FROM operation_receipts WHERE idempotency_key=?')
            .bind('task-completion-audit-failure-key')
            .first<{ count: number }>()
        )?.count,
      ).toBe(0);
      expect(
        (
          await db
            .prepare('SELECT count(*) AS count FROM audit_events WHERE idempotency_key=?')
            .bind('task-completion-audit-failure-key')
            .first<{ count: number }>()
        )?.count,
      ).toBe(0);
    } finally {
      await db.prepare('DROP TRIGGER fail_task_completion_audit').run();
    }
  });

  it('rolls back zero-row Task and Renewal completion comparisons without an orphan replacement', async () => {
    const fixture = await seedRenewalTask(db, 'stale-completion');
    const app = createTaskApp(context);
    const env = {
      DB: db,
      CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
      CF_ACCESS_AUDIENCE: 'normal-audience',
      CF_ACCESS_SECURE_AUDIENCE: 'secure-audience',
      CSRF_SECRET: 'test-csrf-secret-that-is-long-enough',
    } satisfies Env;
    const csrfResponse = await app.request(
      'https://panel.mayisigorta.test/api/csrf-token',
      { method: 'GET' },
      env,
    );
    const csrf = ((await csrfResponse.json()) as { data: { token: string } }).data.token;
    const attempts = [
      { key: 'task-completion-stale-task-key', renewalVersion: 1, taskVersion: 2 },
      { key: 'task-completion-stale-renewal-key', renewalVersion: 2, taskVersion: 1 },
    ];
    for (const attempt of attempts) {
      const response = await app.request(
        `https://panel.mayisigorta.test/api/renewals/${fixture.renewalId}/tasks/${fixture.taskId}/complete`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://panel.mayisigorta.com',
            'X-CSRF-Token': csrf,
            'Idempotency-Key': attempt.key,
          },
          body: JSON.stringify({
            expectedRenewalVersion: attempt.renewalVersion,
            expectedTaskVersion: attempt.taskVersion,
            replacementDueAt: '2026-09-25T06:00:00.000Z',
          }),
        },
        env,
      );
      expect(response.status).toBe(409);
    }

    expect(
      await db.prepare('SELECT status,version FROM tasks WHERE id=?').bind(fixture.taskId).first(),
    ).toEqual({ status: 'OPEN', version: 1 });
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS count FROM tasks WHERE renewal_id=? AND kind='RENEWAL_FOLLOWUP' AND status='OPEN'",
          )
          .bind(fixture.renewalId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS count FROM operation_receipts WHERE idempotency_key LIKE 'task-completion-stale-%'",
          )
          .first<{ count: number }>()
      )?.count,
    ).toBe(0);
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS count FROM audit_events WHERE idempotency_key LIKE 'task-completion-stale-%'",
          )
          .first<{ count: number }>()
      )?.count,
    ).toBe(0);
  });

  it('concurrent exact completion retries converge on one replacement Task and one receipt', async () => {
    const fixture = await seedRenewalTask(db, 'concurrent-completion');
    const app = createTaskApp(context);
    const env = {
      DB: db,
      CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
      CF_ACCESS_AUDIENCE: 'normal-audience',
      CF_ACCESS_SECURE_AUDIENCE: 'secure-audience',
      CSRF_SECRET: 'test-csrf-secret-that-is-long-enough',
    } satisfies Env;
    const csrfResponse = await app.request(
      'https://panel.mayisigorta.test/api/csrf-token',
      { method: 'GET' },
      env,
    );
    const csrf = ((await csrfResponse.json()) as { data: { token: string } }).data.token;
    const request = () =>
      app.request(
        `https://panel.mayisigorta.test/api/renewals/${fixture.renewalId}/tasks/${fixture.taskId}/complete`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://panel.mayisigorta.com',
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'task-completion-concurrent-key',
          },
          body: JSON.stringify({
            expectedRenewalVersion: 1,
            expectedTaskVersion: 1,
            replacementDueAt: '2026-09-25T06:00:00.000Z',
          }),
        },
        env,
      );

    const responses = await Promise.all([request(), request()]);
    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    const envelopes = await Promise.all(
      responses.map(
        (response) =>
          response.json() as Promise<{
            data: { replacementTaskId: string };
            replayed: boolean;
          }>,
      ),
    );
    expect(envelopes[0]?.data).toEqual(envelopes[1]?.data);
    expect(envelopes.filter((envelope) => envelope.replayed)).toHaveLength(1);
    expect(
      await db.prepare('SELECT status,version FROM tasks WHERE id=?').bind(fixture.taskId).first(),
    ).toEqual({ status: 'COMPLETED', version: 2 });
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS count FROM tasks WHERE renewal_id=? AND kind='RENEWAL_FOLLOWUP' AND status='OPEN'",
          )
          .bind(fixture.renewalId)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS count FROM operation_receipts WHERE idempotency_key='task-completion-concurrent-key'",
          )
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS count FROM audit_events WHERE idempotency_key='task-completion-concurrent-key' AND outcome='SUCCESS'",
          )
          .first<{ count: number }>()
      )?.count,
    ).toBe(2);
  });

  it('lets an ASSIGNED member replace only their linked follow-up', async () => {
    const app = createTaskApp(memberContext);
    const env = {
      DB: db,
      CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
      CF_ACCESS_AUDIENCE: 'normal-audience',
      CF_ACCESS_SECURE_AUDIENCE: 'secure-audience',
      CSRF_SECRET: 'test-csrf-secret-that-is-long-enough',
    } satisfies Env;
    const csrfResponse = await app.request(
      'https://panel.mayisigorta.test/api/csrf-token',
      { method: 'GET' },
      env,
    );
    const csrf = ((await csrfResponse.json()) as { data: { token: string } }).data.token;
    const response = await app.request(
      'https://panel.mayisigorta.test/api/renewals/task-renewal-member/tasks/task-primary-member/complete',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'member-task-complete-key',
        },
        body: JSON.stringify({
          expectedRenewalVersion: 1,
          expectedTaskVersion: 1,
          replacementDueAt: '2026-09-26T06:00:00.000Z',
        }),
      },
      env,
    );
    expect(response.status).toBe(200);
    const envelope = (await response.json()) as {
      data: { replacementTaskId: string; completedTaskId: string };
    };
    expect(envelope.data.completedTaskId).toBe('task-primary-member');
    expect(
      await db
        .prepare(
          'SELECT assignee_membership_id,actor_kind,created_by_membership_id FROM tasks WHERE id=?',
        )
        .bind(envelope.data.replacementTaskId)
        .first(),
    ).toEqual({
      assignee_membership_id: 'task-member-membership',
      actor_kind: 'USER',
      created_by_membership_id: 'task-member-membership',
    });

    const replay = await app.request(
      'https://panel.mayisigorta.test/api/renewals/task-renewal-member/tasks/task-primary-member/complete',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'member-task-complete-key',
        },
        body: JSON.stringify({
          expectedRenewalVersion: 1,
          expectedTaskVersion: 1,
          replacementDueAt: '2026-09-26T06:00:00.000Z',
        }),
      },
      env,
    );
    expect(replay.status).toBe(200);
    const replayEnvelope = (await replay.json()) as { data: unknown; replayed: boolean };
    expect(replayEnvelope.data).toEqual(envelope.data);
    expect(replayEnvelope.replayed).toBe(true);

    await db
      .prepare(
        `DELETE FROM membership_permissions
         WHERE membership_id='task-member-membership' AND permission_code='task.update'`,
      )
      .run();
    await db
      .prepare(
        `UPDATE agency_memberships SET permission_version=3,version=3
         WHERE id='task-member-membership'`,
      )
      .run();
    const revokedReplay = await app.request(
      'https://panel.mayisigorta.test/api/renewals/task-renewal-member/tasks/task-primary-member/complete',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'member-task-complete-key',
        },
        body: JSON.stringify({
          expectedRenewalVersion: 1,
          expectedTaskVersion: 1,
          replacementDueAt: '2026-09-26T06:00:00.000Z',
        }),
      },
      env,
    );
    expect(revokedReplay.status).toBe(404);
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS count FROM operation_receipts WHERE idempotency_key='member-task-complete-key'",
          )
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
  });

  it('does not disclose an unassigned Renewal task to an ASSIGNED member', async () => {
    const app = createTaskApp(memberContext);
    const env = {
      DB: db,
      CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
      CF_ACCESS_AUDIENCE: 'normal-audience',
      CF_ACCESS_SECURE_AUDIENCE: 'secure-audience',
      CSRF_SECRET: 'test-csrf-secret-that-is-long-enough',
    } satisfies Env;
    const csrfResponse = await app.request(
      'https://panel.mayisigorta.test/api/csrf-token',
      { method: 'GET' },
      env,
    );
    const csrf = ((await csrfResponse.json()) as { data: { token: string } }).data.token;
    const response = await app.request(
      'https://panel.mayisigorta.test/api/renewals/task-renewal-unassigned/tasks/task-primary-unassigned/complete',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'member-cross-scope-task-key',
        },
        body: JSON.stringify({
          expectedRenewalVersion: 1,
          expectedTaskVersion: 1,
          replacementDueAt: '2026-09-26T06:00:00.000Z',
        }),
      },
      env,
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ success: false, error: { code: 'NOT_FOUND' } });
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS count FROM operation_receipts WHERE idempotency_key='member-cross-scope-task-key'",
          )
          .first<{ count: number }>()
      )?.count,
    ).toBe(0);
  });

  it('does not let a customer assignment grant access to another member’s assigned Task', async () => {
    const fixture = await seedRenewalTask(db, 'customer-assignment-other-task');
    await db.batch([
      db.prepare(
        `UPDATE customers SET assignee_membership_id='task-member-membership',version=version+1
           WHERE id='task-customer'`,
      ),
      db
        .prepare(
          `UPDATE renewal_opportunities SET assignee_membership_id='task-actor-membership',version=2
           WHERE id=?`,
        )
        .bind(fixture.renewalId),
      db
        .prepare(
          `UPDATE tasks SET assignee_membership_id='task-actor-membership',version=2 WHERE id=?`,
        )
        .bind(fixture.taskId),
    ]);
    const memberMembership = await db
      .prepare('SELECT permission_version FROM agency_memberships WHERE id=?')
      .bind('task-member-membership')
      .first<{ permission_version: number }>();
    expect(memberMembership).not.toBeNull();
    const memberWithCurrentPermissionVersion: AuthenticatedUserContext = {
      ...memberContext,
      memberships: [
        {
          ...memberContext.memberships[0]!,
          permissionVersion: memberMembership!.permission_version,
        },
      ],
    };
    const memberTasks = await listTodayTasks(memberWithCurrentPermissionVersion, db, {
      limit: 25,
      cursor: undefined,
    });
    expect(memberTasks.items.map((task) => task.taskId)).not.toContain(fixture.taskId);

    const app = createTaskApp(memberWithCurrentPermissionVersion);
    const env = {
      DB: db,
      CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
      CF_ACCESS_AUDIENCE: 'normal-audience',
      CF_ACCESS_SECURE_AUDIENCE: 'secure-audience',
      CSRF_SECRET: 'test-csrf-secret-that-is-long-enough',
    } satisfies Env;
    const csrfResponse = await app.request(
      'https://panel.mayisigorta.test/api/csrf-token',
      { method: 'GET' },
      env,
    );
    const csrf = ((await csrfResponse.json()) as { data: { token: string } }).data.token;
    const response = await app.request(
      `https://panel.mayisigorta.test/api/renewals/${fixture.renewalId}/tasks/${fixture.taskId}/complete`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'member-customer-assignment-not-task-key',
        },
        body: JSON.stringify({
          expectedRenewalVersion: 2,
          expectedTaskVersion: 2,
          replacementDueAt: '2026-09-26T06:00:00.000Z',
        }),
      },
      env,
    );
    const unchangedTask = await db
      .prepare('SELECT status,version FROM tasks WHERE id=?')
      .bind(fixture.taskId)
      .first();
    const receiptCount = (
      await db
        .prepare(
          "SELECT count(*) AS count FROM operation_receipts WHERE idempotency_key='member-customer-assignment-not-task-key'",
        )
        .first<{ count: number }>()
    )?.count;
    await db
      .prepare(
        `UPDATE customers SET assignee_membership_id='task-actor-membership',version=version+1
         WHERE id='task-customer'`,
      )
      .run();
    expect(response.status).toBe(404);
    expect(unchangedTask).toEqual({ status: 'OPEN', version: 2 });
    expect(receiptCount).toBe(0);
  });

  it('assigns an unassigned queue follow-up and its Renewal together to an active member', async () => {
    const receipt = await db
      .prepare(
        "SELECT response_body FROM operation_receipts WHERE idempotency_key='task-complete-key-1'",
      )
      .first<{ response_body: string }>();
    const completion = JSON.parse(receipt?.response_body ?? '{}') as {
      renewalId: string;
      completedTaskId: string;
      replacementTaskId: string;
      replacementDueAt: string;
      completedTaskVersion: number;
      replacementTaskVersion: number;
      renewalVersion: number;
      completedAt: string;
    };
    const app = createTaskApp(context);
    const env = {
      DB: db,
      CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
      CF_ACCESS_AUDIENCE: 'normal-audience',
      CF_ACCESS_SECURE_AUDIENCE: 'secure-audience',
      CSRF_SECRET: 'test-csrf-secret-that-is-long-enough',
    } satisfies Env;
    const csrfResponse = await app.request(
      'https://panel.mayisigorta.test/api/csrf-token',
      { method: 'GET' },
      env,
    );
    const csrf = ((await csrfResponse.json()) as { data: { token: string } }).data.token;
    const response = await app.request(
      `https://panel.mayisigorta.test/api/renewals/task-renewal-unassigned/tasks/${completion.replacementTaskId}/assign`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'assign-unassigned-queue-key',
        },
        body: JSON.stringify({
          expectedRenewalVersion: 1,
          expectedTaskVersion: 1,
          assigneeMembershipId: 'task-member-membership',
        }),
      },
      env,
    );
    expect(response.status).toBe(200);
    expect(
      await db
        .prepare(
          "SELECT assignee_membership_id,version FROM renewal_opportunities WHERE id='task-renewal-unassigned'",
        )
        .first(),
    ).toEqual({ assignee_membership_id: 'task-member-membership', version: 2 });
    expect(
      await db
        .prepare('SELECT assignee_membership_id,version FROM tasks WHERE id=?')
        .bind(completion.replacementTaskId)
        .first(),
    ).toEqual({ assignee_membership_id: 'task-member-membership', version: 2 });

    const replay = await app.request(
      'https://panel.mayisigorta.test/api/renewals/task-renewal-unassigned/tasks/task-primary-unassigned/complete',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'task-complete-key-1',
        },
        body: JSON.stringify({
          expectedRenewalVersion: 1,
          expectedTaskVersion: 1,
          replacementDueAt: completion.replacementDueAt,
        }),
      },
      env,
    );
    expect(replay.status).toBe(200);
    const replayEnvelope = (await replay.json()) as { data: unknown; replayed: boolean };
    expect(replayEnvelope.data).toEqual(completion);
    expect(replayEnvelope.replayed).toBe(true);
  });

  it('rechecks current assignment authority before returning a completed replay', async () => {
    const fixture = await seedRenewalTask(db, 'assignment-replay-authority');
    await db.batch([
      db.prepare(
        `UPDATE membership_permissions SET scope='AGENCY'
         WHERE membership_id='task-member-membership'
           AND permission_code IN ('task.read','renewal.read')`,
      ),
      db.prepare(
        `INSERT INTO membership_permissions(id,membership_id,permission_code,scope)
         VALUES('task-member-task-assign','task-member-membership','task.assign','AGENCY'),
               ('task-member-renewal-assign','task-member-membership','renewal.assign','AGENCY')`,
      ),
      db.prepare(
        `UPDATE agency_memberships SET permission_version=3,version=version+1
         WHERE id='task-member-membership'`,
      ),
    ]);
    const managerContext: AuthenticatedUserContext = {
      userId: 'task-member-user',
      identityId: 'task-member-identity',
      assurance: 'NORMAL',
      memberships: [
        {
          id: 'task-member-membership',
          agencyId: 'task-agency',
          type: 'MEMBER',
          status: 'ACTIVE',
          permissionVersion: 3,
        },
      ],
    };
    const app = createTaskApp(managerContext);
    const env = {
      DB: db,
      CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
      CF_ACCESS_AUDIENCE: 'normal-audience',
      CF_ACCESS_SECURE_AUDIENCE: 'secure-audience',
      CSRF_SECRET: 'test-csrf-secret-that-is-long-enough',
    } satisfies Env;
    const csrfResponse = await app.request(
      'https://panel.mayisigorta.test/api/csrf-token',
      { method: 'GET' },
      env,
    );
    const csrf = ((await csrfResponse.json()) as { data: { token: string } }).data.token;
    const request = () =>
      app.request(
        `https://panel.mayisigorta.test/api/renewals/${fixture.renewalId}/tasks/${fixture.taskId}/assign`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://panel.mayisigorta.com',
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'task-assignment-replay-authority-key',
          },
          body: JSON.stringify({
            expectedRenewalVersion: 1,
            expectedTaskVersion: 1,
            assigneeMembershipId: 'task-actor-membership',
          }),
        },
        env,
      );

    const first = await request();
    expect(first.status).toBe(200);
    const exactReplay = await request();
    expect(exactReplay.status).toBe(200);
    expect(await exactReplay.json()).toMatchObject({ replayed: true });

    await db.batch([
      db.prepare(
        `DELETE FROM membership_permissions
           WHERE membership_id='task-member-membership'
             AND permission_code IN ('task.assign','renewal.assign')`,
      ),
      db.prepare(
        `UPDATE agency_memberships SET permission_version=4,version=version+1
         WHERE id='task-member-membership'`,
      ),
    ]);
    const deniedReplay = await request();
    expect(deniedReplay.status).toBe(404);
    expect(await deniedReplay.json()).toMatchObject({
      success: false,
      error: { code: 'NOT_FOUND' },
    });
    expect(
      await db
        .prepare('SELECT assignee_membership_id,version FROM renewal_opportunities WHERE id=?')
        .bind(fixture.renewalId)
        .first(),
    ).toEqual({ assignee_membership_id: 'task-actor-membership', version: 2 });
    expect(
      await db
        .prepare('SELECT assignee_membership_id,version FROM tasks WHERE id=?')
        .bind(fixture.taskId)
        .first(),
    ).toEqual({ assignee_membership_id: 'task-actor-membership', version: 2 });
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS count FROM audit_events WHERE idempotency_key='task-assignment-replay-authority-key'",
          )
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
  });

  it('omits HEALTH follow-up work unless policy.health.read is allowed', async () => {
    const now = '2026-09-24T06:00:00.000Z';
    await db.batch([
      db.prepare(
        `INSERT INTO insurance_branches(id,agency_id,code,name,data_classification)
         VALUES('task-health-branch','task-agency','TASK-HEALTH','Health','HEALTH')`,
      ),
      db.prepare(
        `INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name)
         VALUES('task-health-product','task-agency','task-insurer','task-health-branch','TASK-HEALTH','Health')`,
      ),
      db.prepare(
        `INSERT INTO policies
           (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
            assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
            gross_premium_minor,currency)
         VALUES('task-health-policy','task-agency','task-customer','task-insurer','task-health-product',
           'task-health-branch','task-payment','task-actor-membership','HEALTH-TASK-1','HEALTHTASK1',
           '2026-01-01','2026-11-01',10000,'TRY')`,
      ),
      db
        .prepare(
          `INSERT INTO renewal_opportunities
           (id,agency_id,expiring_policy_id,assignee_membership_id,state,version,created_at,updated_at)
         VALUES('task-health-renewal','task-agency','task-health-policy','task-actor-membership',
           'CONTACT_PENDING',1,?,?)`,
        )
        .bind(now, now),
      db
        .prepare(
          `INSERT INTO tasks
           (id,agency_id,customer_id,renewal_id,kind,title,due_at,assignee_membership_id,status,
            actor_kind,version,created_at,updated_at)
         VALUES('task-health-primary','task-agency','task-customer','task-health-renewal',
           'RENEWAL_FOLLOWUP','Yenileme takibi',?,'task-actor-membership','OPEN','SYSTEM',1,?,?)`,
        )
        .bind(now, now, now),
      db.prepare(
        "INSERT INTO users(id,status,version) VALUES('health-task-reader-user','INACTIVE',1)",
      ),
      db.prepare(
        `INSERT INTO agency_memberships
           (id,agency_id,user_id,type,status,permission_version,version,invitation_email,invitation_expires_at)
         VALUES('health-task-reader-membership','task-agency','health-task-reader-user','MEMBER','INVITED',1,1,
           'health-task-reader@test.test','2099-01-01T00:00:00.000Z')`,
      ),
      db.prepare(
        `INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email,status)
         VALUES('health-task-reader-identity','health-task-reader-user','https://team.cloudflareaccess.com',
           'health-task-reader-subject','health-task-reader@test.test','ACTIVE')`,
      ),
      db.prepare("UPDATE users SET status='ACTIVE',version=2 WHERE id='health-task-reader-user'"),
      db
        .prepare(
          `UPDATE agency_memberships SET status='ACTIVE',activated_at=?,version=2,permission_version=2
         WHERE id='health-task-reader-membership'`,
        )
        .bind(now),
      db.prepare(
        `INSERT INTO membership_permissions(id,membership_id,permission_code,scope)
         VALUES('health-task-policy-read','health-task-reader-membership','policy.read','AGENCY'),
               ('health-task-customer-read','health-task-reader-membership','customer.read','AGENCY'),
               ('health-task-health-read','health-task-reader-membership','sensitive.health.read','UNSCOPED'),
               ('health-task-task-read','health-task-reader-membership','task.read','AGENCY'),
               ('health-task-renewal-read','health-task-reader-membership','renewal.read','AGENCY')`,
      ),
    ]);

    const ownerTasks = await listTodayTasks(context, db, { limit: 50, cursor: undefined });
    expect(ownerTasks.items.map((task) => task.taskId)).not.toContain('task-health-primary');

    const healthReaderContext: AuthenticatedUserContext = {
      userId: 'health-task-reader-user',
      identityId: 'health-task-reader-identity',
      assurance: 'NORMAL',
      memberships: [
        {
          id: 'health-task-reader-membership',
          agencyId: 'task-agency',
          type: 'MEMBER',
          status: 'ACTIVE',
          permissionVersion: 2,
        },
      ],
    };
    const permittedTasks = await listTodayTasks(healthReaderContext, db, {
      limit: 50,
      cursor: undefined,
    });
    expect(
      permittedTasks.items.find((task) => task.taskId === 'task-health-primary'),
    ).toMatchObject({
      policyNumber: 'HEALTH-TASK-1',
      policyEndDate: '2026-11-01',
    });
  });
});
