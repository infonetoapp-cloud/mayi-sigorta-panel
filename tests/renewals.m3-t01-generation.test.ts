// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import miniflare from 'miniflare';
import {
  ensureRenewalForPolicy,
  runRenewalGenerationForAgency,
} from '../src/server/renewals/generation';
import {
  archivePolicy,
  createPolicy,
  getPolicy,
  PolicyAuthorizationRaceError,
  updatePolicy,
} from '../src/server/policies/service';
import { createWorker, type Env } from '../src/server/index';
import { registerPolicyRoutes } from '../src/server/policies/routes';
import { computePayloadHash } from '../src/server/mutations/canonical';
import { generateIdentityBoundCsrfToken } from '../src/server/security/csrf';
import type { AuthenticatedUserContext } from '../src/server/auth/identity';
import type { AuthenticatedPrincipal } from '../src/server/auth/types';

const { Miniflare, convertV4MiniflareOptions } = miniflare;
const root = resolve(__dirname, '..');
const ownerContext = {
  userId: 'user-a',
  identityId: 'identity-a',
  assurance: 'NORMAL' as const,
  memberships: [
    {
      id: 'member-a',
      agencyId: 'agency-a',
      type: 'OWNER' as const,
      status: 'ACTIVE' as const,
      permissionVersion: 2,
    },
  ],
};

function policyInput(policyNumber: string, endDate: string) {
  return {
    customerId: 'customer-a',
    productId: 'product-a',
    branchId: 'branch-a',
    paymentMethodId: 'cash-a',
    policyNumber,
    startDate: '2026-01-01',
    endDate,
    grossPremium: '100.25',
    currency: 'TRY',
    installmentCount: null,
    status: 'ACTIVE',
  };
}

function memberPolicyContext(permissionVersion: number): AuthenticatedUserContext {
  return {
    userId: 'policy-member-user',
    identityId: 'policy-member-identity',
    assurance: 'NORMAL',
    memberships: [
      {
        id: 'policy-member-membership',
        agencyId: 'agency-a',
        type: 'MEMBER',
        status: 'ACTIVE',
        permissionVersion,
      },
    ],
  };
}

async function seedMemberPolicyContext(db: D1Database): Promise<void> {
  await db
    .prepare("INSERT INTO users(id,status,version) VALUES('policy-member-user','INACTIVE',1)")
    .run();
  await db
    .prepare(
      `INSERT INTO agency_memberships
         (id,agency_id,user_id,type,status,permission_version,invitation_email,invitation_expires_at,version)
       VALUES ('policy-member-membership','agency-a','policy-member-user','MEMBER','INVITED',1,
         'policy-member@test.test','2099-01-01T00:00:00.000Z',1)`,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email,status)
       VALUES ('policy-member-identity','policy-member-user','https://mayi-test.cloudflareaccess.com',
         'policy-member-subject','policy-member@test.test','ACTIVE')`,
    )
    .run();
  await db
    .prepare("UPDATE users SET status='ACTIVE',version=2 WHERE id='policy-member-user'")
    .run();
  await db
    .prepare(
      `UPDATE agency_memberships SET status='ACTIVE',activated_at='2026-09-24T00:00:00.000Z',
         permission_version=2,version=2 WHERE id='policy-member-membership'`,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES
        ('policy-member-customer-read','policy-member-membership','customer.read','ASSIGNED'),
        ('policy-member-policy-read','policy-member-membership','policy.read','ASSIGNED'),
        ('policy-member-policy-create','policy-member-membership','policy.create','UNSCOPED')`,
    )
    .run();
  await db
    .prepare(
      `INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id)
       VALUES ('policy-member-customer','agency-a','INDIVIDUAL','Member Policy Customer','Member','Policy',
         'policy-member-membership')`,
    )
    .run();
}

describe('M3-T01 idempotent renewal generation on local D1', () => {
  let mf: miniflare.Miniflare;
  let db: D1Database;

  beforeAll(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T00:00:00.000Z'));
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: 'export default {fetch(){return new Response()}}',
        d1Databases: { DB: '00000000-0000-0000-0000-000000000031' },
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
    await db
      .prepare(
        `INSERT INTO agencies (id,status,bootstrap_completed_at,activated_at)
         VALUES ('agency-a','PROVISIONING',NULL,NULL)`,
      )
      .run();
    await db.prepare("INSERT INTO users (id,status) VALUES ('user-a','INACTIVE')").run();
    await db
      .prepare(
        `INSERT INTO agency_memberships
           (id,agency_id,user_id,type,status,permission_version,invitation_email,invitation_expires_at)
         VALUES ('member-a','agency-a','user-a','OWNER','INVITED',1,'owner@example.test','2099-01-01T00:00:00.000Z')`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO auth_identities (id,user_id,issuer,subject,verified_email,status)
         VALUES ('identity-a','user-a','https://access.test','subject-a','owner@example.test','ACTIVE')`,
      )
      .run();
    await db.prepare("UPDATE users SET status='ACTIVE',version=2 WHERE id='user-a'").run();
    await db
      .prepare(
        `UPDATE agency_memberships SET status='ACTIVE',activated_at='2026-01-01T00:00:00.000Z',version=2,permission_version=2 WHERE id='member-a'`,
      )
      .run();
    await db
      .prepare(
        `UPDATE agencies SET status='ACTIVE',bootstrap_completed_at='2026-01-01T00:00:00.000Z',activated_at='2026-01-01T00:00:00.000Z',version=2 WHERE id='agency-a'`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO customers
           (id,agency_id,type,display_name,first_name,last_name,assignee_membership_id)
         VALUES ('customer-a','agency-a','INDIVIDUAL','Renewal Customer','Ada','Yilmaz','member-a')`,
      )
      .run();
    await db
      .prepare(
        "INSERT INTO insurers (id,agency_id,code,name) VALUES ('insurer-a','agency-a','INS-A','Insurer')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO insurance_branches (id,agency_id,code,name,data_classification) VALUES ('branch-a','agency-a','AUTO','Auto','GENERAL')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO insurance_products (id,agency_id,insurer_id,branch_id,code,name) VALUES ('product-a','agency-a','insurer-a','branch-a','AUTO-A','Auto')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO payment_methods (id,agency_id,code,name,supports_installments,max_installments) VALUES ('cash-a','agency-a','CASH','Cash',0,12)",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO agency_settings (id,agency_id,default_insurer_id) VALUES ('settings-a','agency-a','insurer-a')",
      )
      .run();
    await db
      .prepare(
        `INSERT INTO policies
           (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,
            policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency)
         VALUES ('policy-future','agency-a','customer-a','insurer-a','product-a','branch-a','cash-a','member-a',
                 'AUTO-001','AUTO001','2026-01-01','2026-10-24',10000,'TRY'),
                ('policy-missed','agency-a','customer-a','insurer-a','product-a','branch-a','cash-a','member-a',
                 'AUTO-002','AUTO002','2025-01-01','2026-09-22',20000,'TRY')`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO renewal_generation_cursors (agency_id,last_successful_local_date,version)
         VALUES ('agency-a','2026-09-20',1)`,
      )
      .run();
    await seedMemberPolicyContext(db);
  });

  afterAll(async () => {
    vi.useRealTimers();
    await mf.dispose();
  });

  async function insertPolicy(id: string, number: string, normalized: string, endDate: string) {
    await db
      .prepare(
        `INSERT INTO policies
           (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,
            policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency)
         VALUES (?, 'agency-a','customer-a','insurer-a','product-a','branch-a','cash-a','member-a',
                 ?, ?,'2026-01-01',?,10000,'TRY')`,
      )
      .bind(id, number, normalized, endDate)
      .run();
  }

  it('reconciles a missed cron without duplicate effects or automatic LOST', async () => {
    const first = await runRenewalGenerationForAgency(db, 'agency-a');
    expect(first.createdCount).toBe(2);

    const renewals = await db
      .prepare(
        'SELECT id,expiring_policy_id,state,assignee_membership_id FROM renewal_opportunities ORDER BY expiring_policy_id',
      )
      .all<{
        id: string;
        expiring_policy_id: string;
        state: string;
        assignee_membership_id: string | null;
      }>();
    expect(renewals.results).toHaveLength(2);
    expect(renewals.results.map((row) => row.state)).toEqual([
      'CONTACT_PENDING',
      'CONTACT_PENDING',
    ]);
    expect(renewals.results.every((row) => row.assignee_membership_id === 'member-a')).toBe(true);
    const renewalIds = renewals.results.map((row) => row.id);

    const initialHistory = await db
      .prepare(
        'SELECT count(*) AS count FROM renewal_state_history WHERE renewal_id IN (?,?) AND to_state="CONTACT_PENDING"',
      )
      .bind(...renewalIds)
      .first<{ count: number }>();
    const primaryTasks = await db
      .prepare(
        "SELECT count(*) AS count FROM tasks WHERE renewal_id IN (?,?) AND kind='RENEWAL_FOLLOWUP' AND status='OPEN'",
      )
      .bind(...renewalIds)
      .first<{ count: number }>();
    const systemAudits = await db
      .prepare(
        "SELECT count(*) AS count FROM system_audit_events WHERE action='renewal.generate' AND target_id IN (?,?) AND outcome='SUCCESS'",
      )
      .bind(...renewalIds)
      .first<{ count: number }>();
    expect(initialHistory?.count).toBe(2);
    expect(primaryTasks?.count).toBe(2);
    expect(systemAudits?.count).toBe(2);

    const taskRows = await db
      .prepare(
        "SELECT due_at,assignee_membership_id FROM tasks WHERE renewal_id IN (?,?) AND kind='RENEWAL_FOLLOWUP' ORDER BY due_at",
      )
      .bind(...renewalIds)
      .all<{ due_at: string; assignee_membership_id: string | null }>();
    expect(taskRows.results.every((task) => task.assignee_membership_id === 'member-a')).toBe(true);
    expect(taskRows.results.every((task) => task.due_at === '2026-09-24T06:00:00.000Z')).toBe(true);

    const retry = await runRenewalGenerationForAgency(db, 'agency-a');
    expect(retry.createdCount).toBe(0);
    expect(
      (
        await db
          .prepare('SELECT count(*) AS count FROM renewal_opportunities')
          .first<{ count: number }>()
      )?.count,
    ).toBe(2);
    expect(
      (
        await db
          .prepare("SELECT count(*) AS count FROM tasks WHERE kind='RENEWAL_FOLLOWUP'")
          .first<{ count: number }>()
      )?.count,
    ).toBe(2);
  });

  it('persists Policy-first, Customer-fallback and unassigned Renewal/Task responsibility', async () => {
    await db.batch([
      db.prepare("INSERT INTO users(id,status,version) VALUES('inactive-m3-user','INACTIVE',1)"),
      db.prepare(
        `INSERT INTO agency_memberships
             (id,agency_id,user_id,type,status,permission_version,version,invitation_email,
              invitation_expires_at,inactivated_at)
           VALUES ('inactive-m3-member','agency-a','inactive-m3-user','MEMBER','INACTIVE',1,1,
             'inactive-m3@test.test','2099-01-01T00:00:00.000Z','2026-09-24T00:00:00.000Z')`,
      ),
      db.prepare(
        `INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id)
           VALUES
             ('customer-m3-priority','agency-a','INDIVIDUAL','Priority','P','R','member-a'),
             ('customer-m3-fallback','agency-a','INDIVIDUAL','Fallback','F','B','member-a'),
             ('customer-m3-unassigned','agency-a','INDIVIDUAL','Unassigned','U','A','inactive-m3-member')`,
      ),
      db.prepare(
        `INSERT INTO policies
             (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
              assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
              gross_premium_minor,currency)
           VALUES
             ('policy-m3-priority','agency-a','customer-m3-priority','insurer-a','product-a','branch-a','cash-a',
              'policy-member-membership','PRIORITY-001','PRIORITY001','2026-01-01','2026-09-29',10000,'TRY'),
             ('policy-m3-fallback','agency-a','customer-m3-fallback','insurer-a','product-a','branch-a','cash-a',
              'inactive-m3-member','FALLBACK-001','FALLBACK001','2026-01-01','2026-09-30',10000,'TRY'),
             ('policy-m3-unassigned','agency-a','customer-m3-unassigned','insurer-a','product-a','branch-a','cash-a',
              'inactive-m3-member','UNASSIGNED-001','UNASSIGNED001','2026-01-01','2026-10-01',10000,'TRY')`,
      ),
    ]);
    const result = await runRenewalGenerationForAgency(db, 'agency-a');
    expect(result.createdCount).toBeGreaterThanOrEqual(3);
    const assignments = await db
      .prepare(
        `SELECT p.id AS policy_id,r.assignee_membership_id AS renewal_assignee,
           t.assignee_membership_id AS task_assignee
         FROM renewal_opportunities r
         JOIN policies p ON p.agency_id=r.agency_id AND p.id=r.expiring_policy_id
         JOIN tasks t ON t.agency_id=r.agency_id AND t.renewal_id=r.id
           AND t.kind='RENEWAL_FOLLOWUP'
         WHERE p.id LIKE 'policy-m3-%' ORDER BY p.id`,
      )
      .all<{ policy_id: string; renewal_assignee: string | null; task_assignee: string | null }>();
    expect(assignments.results).toEqual([
      {
        policy_id: 'policy-m3-fallback',
        renewal_assignee: 'member-a',
        task_assignee: 'member-a',
      },
      {
        policy_id: 'policy-m3-priority',
        renewal_assignee: 'policy-member-membership',
        task_assignee: 'policy-member-membership',
      },
      {
        policy_id: 'policy-m3-unassigned',
        renewal_assignee: null,
        task_assignee: null,
      },
    ]);
  });

  it('converges concurrent scheduled generation into one renewal, history, task and audit', async () => {
    await insertPolicy('policy-race', 'AUTO-003', 'AUTO003', '2026-09-28');
    const [left, right] = await Promise.all([
      runRenewalGenerationForAgency(db, 'agency-a'),
      runRenewalGenerationForAgency(db, 'agency-a'),
    ]);
    expect(left.createdCount + right.createdCount).toBe(1);
    expect(
      (
        await db
          .prepare('SELECT count(*) AS count FROM renewal_opportunities WHERE expiring_policy_id=?')
          .bind('policy-race')
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS count FROM tasks WHERE renewal_id IN (SELECT id FROM renewal_opportunities WHERE expiring_policy_id=?) AND kind='RENEWAL_FOLLOWUP' AND status='OPEN'",
          )
          .bind('policy-race')
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
  });

  it('uses the same generator for manual Policy create/update and a concurrent cron run', async () => {
    const policyInput = (policyNumber: string, endDate: string) => ({
      customerId: 'customer-a',
      productId: 'product-a',
      branchId: 'branch-a',
      paymentMethodId: 'cash-a',
      policyNumber,
      startDate: '2026-01-01',
      endDate,
      grossPremium: '100.00',
      currency: 'TRY',
      installmentCount: null,
      status: 'ACTIVE',
    });
    const manual = await createPolicy(
      ownerContext,
      db,
      policyInput('MANUAL-001', '2026-10-20'),
      'manual-renewal-policy-create',
    );
    expect(await ensureRenewalForPolicy(db, 'agency-a', manual.data.id)).toBe('CREATED');
    expect(
      (
        await db
          .prepare('SELECT count(*) AS count FROM renewal_opportunities WHERE expiring_policy_id=?')
          .bind(manual.data.id)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
    expect((await runRenewalGenerationForAgency(db, 'agency-a')).createdCount).toBe(0);

    const outsideWindow = await createPolicy(
      ownerContext,
      db,
      policyInput('MANUAL-002', '2026-12-31'),
      'manual-renewal-policy-before-window',
    );
    expect(
      (
        await db
          .prepare('SELECT count(*) AS count FROM renewal_opportunities WHERE expiring_policy_id=?')
          .bind(outsideWindow.data.id)
          .first<{ count: number }>()
      )?.count,
    ).toBe(0);
    const [updated, cron] = await Promise.all([
      (async () => {
        const result = await updatePolicy(
          ownerContext,
          db,
          outsideWindow.data.id,
          { expectedVersion: 1, endDate: '2026-10-21' },
          'manual-renewal-policy-enter-window',
        );
        await ensureRenewalForPolicy(db, 'agency-a', outsideWindow.data.id);
        return result;
      })(),
      runRenewalGenerationForAgency(db, 'agency-a'),
    ]);
    expect(updated.data.version).toBe(2);
    expect(cron.createdCount).toBeLessThanOrEqual(1);
    expect(
      (
        await db
          .prepare('SELECT count(*) AS count FROM renewal_opportunities WHERE expiring_policy_id=?')
          .bind(outsideWindow.data.id)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS count FROM tasks WHERE renewal_id IN (SELECT id FROM renewal_opportunities WHERE expiring_policy_id=?) AND kind='RENEWAL_FOLLOWUP' AND status='OPEN'",
          )
          .bind(outsideWindow.data.id)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
  });

  it.each(['renewal_opportunities', 'renewal_state_history', 'tasks', 'system_audit_events'])(
    'rolls back a candidate completely when the %s insert fails',
    async (table) => {
      const suffix = table.replaceAll('_', '-');
      const policyId = `policy-fail-${suffix}`;
      await insertPolicy(
        policyId,
        `FAIL-${suffix}`,
        `FAIL${suffix.replaceAll('-', '')}`,
        '2026-09-29',
      );
      const cursorBefore = await db
        .prepare(
          'SELECT last_successful_local_date,version FROM renewal_generation_cursors WHERE agency_id=?',
        )
        .bind('agency-a')
        .first<{ last_successful_local_date: string | null; version: number }>();
      const taskCountBefore = await db
        .prepare("SELECT count(*) AS count FROM tasks WHERE kind='RENEWAL_FOLLOWUP'")
        .first<{ count: number }>();
      await db
        .prepare(
          `CREATE TRIGGER fail_m3_${table} BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT, 'INJECTED_M3_FAILURE'); END`,
        )
        .run();

      try {
        await expect(runRenewalGenerationForAgency(db, 'agency-a')).rejects.toThrow(
          /INJECTED_M3_FAILURE/,
        );
      } finally {
        await db.prepare(`DROP TRIGGER fail_m3_${table}`).run();
      }
      expect(
        (
          await db
            .prepare(
              'SELECT count(*) AS count FROM renewal_opportunities WHERE expiring_policy_id=?',
            )
            .bind(policyId)
            .first<{ count: number }>()
        )?.count,
      ).toBe(0);
      expect(
        (
          await db
            .prepare("SELECT count(*) AS count FROM tasks WHERE kind='RENEWAL_FOLLOWUP'")
            .first<{ count: number }>()
        )?.count,
      ).toBe(taskCountBefore?.count);
      expect(
        (
          await db
            .prepare('SELECT count(*) AS count FROM system_audit_events WHERE idempotency_key=?')
            .bind(`renewal-policy:${policyId}`)
            .first<{ count: number }>()
        )?.count,
      ).toBe(0);
      expect(
        await db
          .prepare(
            'SELECT last_successful_local_date,version FROM renewal_generation_cursors WHERE agency_id=?',
          )
          .bind('agency-a')
          .first<{ last_successful_local_date: string | null; version: number }>(),
      ).toMatchObject({ last_successful_local_date: cursorBefore!.last_successful_local_date });
      const retry = await runRenewalGenerationForAgency(db, 'agency-a');
      expect(retry.createdCount).toBe(1);
    },
  );

  it('runs the same idempotent generation service from the Worker scheduled entry point', async () => {
    await runRenewalGenerationForAgency(db, 'agency-a');
    await insertPolicy('policy-worker-scheduled', 'WORKER-001', 'WORKER1', '2026-10-05');
    const worker = createWorker();
    const scheduled = (
      worker as unknown as {
        scheduled: (
          controller: unknown,
          env: unknown,
          ctx: { waitUntil(promise: Promise<unknown>): void },
        ) => void;
      }
    ).scheduled;
    let scheduledWork: Promise<unknown> | undefined;
    scheduled({}, { DB: db }, { waitUntil: (promise) => (scheduledWork = promise) });
    if (!scheduledWork) throw new Error('Worker did not register its scheduled promise.');
    await expect(scheduledWork).resolves.toMatchObject({ agenciesProcessed: 1, createdCount: 1 });
    expect(
      (
        await db
          .prepare('SELECT count(*) AS count FROM renewal_opportunities WHERE expiring_policy_id=?')
          .bind('policy-worker-scheduled')
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
  });

  it('generates renewal work through the guarded manual Policy create route and exact replay', async () => {
    const app = new Hono<{ Bindings: Env }>();
    const principal = { subject: 'identity-a' } as unknown as AuthenticatedPrincipal;
    registerPolicyRoutes(app, {
      createSessionVerifier: (config) => ({ config, verify: async () => principal }),
      createResolver: () => ({ resolve: async () => ownerContext as AuthenticatedUserContext }),
    });
    const token = await generateIdentityBoundCsrfToken(
      { subject: 'identity-a' },
      'm3-manual-policy-route-csrf-secret-2026',
    );
    const body = policyInput('ROUTE-MANUAL-001', '2026-10-10');
    const request = () =>
      app.request(
        'https://panel.mayisigorta.com/api/policies',
        {
          method: 'POST',
          headers: {
            Origin: 'https://panel.mayisigorta.com',
            'Content-Type': 'application/json',
            'X-CSRF-Token': token,
            'Idempotency-Key': 'manual-policy-renewal-route-key',
          },
          body: JSON.stringify(body),
        },
        {
          DB: db,

          CSRF_SECRET: 'm3-manual-policy-route-csrf-secret-2026',
        },
      );
    const first = await request();
    expect(first.status).toBe(201);
    const firstBody = (await first.json()) as { data: { id: string }; replayed: boolean };
    const second = await request();
    expect(second.status).toBe(201);
    const secondBody = (await second.json()) as { data: { id: string }; replayed: boolean };
    expect(secondBody.data.id).toBe(firstBody.data.id);
    expect(secondBody.replayed).toBe(true);
    expect(
      (
        await db
          .prepare('SELECT count(*) AS count FROM renewal_opportunities WHERE expiring_policy_id=?')
          .bind(firstBody.data.id)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);

    const outsideWindow = await createPolicy(
      ownerContext,
      db,
      policyInput('ROUTE-MANUAL-UPDATE-001', '2026-12-31'),
      'manual-policy-update-before-window',
    );
    const updateRequest = () =>
      app.request(
        `https://panel.mayisigorta.com/api/policies/${outsideWindow.data.id}`,
        {
          method: 'PATCH',
          headers: {
            Origin: 'https://panel.mayisigorta.com',
            'Content-Type': 'application/json',
            'X-CSRF-Token': token,
            'Idempotency-Key': 'manual-policy-renewal-update-route-key',
          },
          body: JSON.stringify({ expectedVersion: 1, endDate: '2026-10-12' }),
        },
        {
          DB: db,

          CSRF_SECRET: 'm3-manual-policy-route-csrf-secret-2026',
        },
      );
    const updated = await updateRequest();
    expect(updated.status).toBe(200);
    const updatedBody = (await updated.json()) as { data: { id: string }; replayed: boolean };
    const updateReplay = await updateRequest();
    expect(updateReplay.status).toBe(200);
    expect(((await updateReplay.json()) as { replayed: boolean }).replayed).toBe(true);
    expect(
      (
        await db
          .prepare('SELECT count(*) AS count FROM renewal_opportunities WHERE expiring_policy_id=?')
          .bind(updatedBody.data.id)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
  });

  it('rejects archiving a Policy with an open Renewal without hiding its work', async () => {
    const created = await createPolicy(
      ownerContext,
      db,
      policyInput('OPEN-ARCHIVE-001', '2026-10-12'),
      'owner-open-renewal-archive-create',
    );
    await ensureRenewalForPolicy(db, 'agency-a', created.data.id);

    await expect(
      archivePolicy(
        ownerContext,
        db,
        created.data.id,
        { expectedVersion: 1, reasonCode: 'USER_REQUESTED' },
        'owner-open-renewal-archive',
      ),
    ).rejects.toMatchObject({ code: 'OPEN_DEPENDENCIES' });
    const policy = await db
      .prepare('SELECT archived_at,version FROM policies WHERE agency_id=? AND id=?')
      .bind('agency-a', created.data.id)
      .first<{ archived_at: string | null; version: number }>();
    expect(policy).toEqual({ archived_at: null, version: 1 });
    const task = await db
      .prepare(
        `SELECT t.status FROM tasks t JOIN renewal_opportunities r
           ON r.agency_id=t.agency_id AND r.id=t.renewal_id
         WHERE r.expiring_policy_id=?`,
      )
      .bind(created.data.id)
      .first<{ status: string }>();
    expect(task?.status).toBe('OPEN');
  });

  it('rejects silently cancelling a Policy with an open Renewal until an explicit outcome command exists', async () => {
    const created = await createPolicy(
      ownerContext,
      db,
      policyInput('OPEN-CANCEL-001', '2026-10-13'),
      'owner-open-renewal-cancel-create',
    );
    await ensureRenewalForPolicy(db, 'agency-a', created.data.id);

    await expect(
      updatePolicy(
        ownerContext,
        db,
        created.data.id,
        { expectedVersion: 1, status: 'CANCELLED' },
        'owner-open-renewal-cancel',
      ),
    ).rejects.toMatchObject({ code: 'OPEN_DEPENDENCIES' });
    const row = await db
      .prepare('SELECT status,version FROM policies WHERE agency_id=? AND id=?')
      .bind('agency-a', created.data.id)
      .first<{ status: string; version: number }>();
    expect(row).toEqual({ status: 'ACTIVE', version: 1 });
  });

  it('denies a HEALTH Policy create replay after sensitive.health.write is revoked while read remains', async () => {
    await db
      .prepare(
        `INSERT INTO insurance_branches(id,agency_id,code,name,data_classification)
         VALUES ('policy-member-health-branch','agency-a','M3-HEALTH','Health','HEALTH')`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name)
         VALUES ('policy-member-health-product','agency-a','insurer-a','policy-member-health-branch',
           'M3-HEALTH-PRODUCT','Health Product')`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES
          ('policy-member-health-read','policy-member-membership','sensitive.health.read','UNSCOPED'),
          ('policy-member-health-write','policy-member-membership','sensitive.health.write','UNSCOPED')`,
      )
      .run();
    const firstContext = memberPolicyContext(2);
    const healthInput = {
      ...policyInput('HEALTH-REPLAY-001', '2026-12-31'),
      customerId: 'policy-member-customer',
      productId: 'policy-member-health-product',
      branchId: 'policy-member-health-branch',
    };
    const created = await createPolicy(
      firstContext,
      db,
      healthInput,
      'member-health-policy-create-replay',
    );
    const exactReplay = await createPolicy(
      firstContext,
      db,
      healthInput,
      'member-health-policy-create-replay',
    );
    expect(exactReplay.replayed).toBe(true);
    expect(exactReplay.data).toEqual(created.data);
    expect((await getPolicy(firstContext, db, created.data.id)).id).toBe(created.data.id);
    await db
      .prepare(
        `DELETE FROM membership_permissions
         WHERE membership_id='policy-member-membership' AND permission_code='sensitive.health.write'`,
      )
      .run();
    await db
      .prepare(
        `UPDATE agency_memberships SET permission_version=3,version=version+1
         WHERE id='policy-member-membership'`,
      )
      .run();
    const readOnlyHealthContext = memberPolicyContext(3);
    expect((await getPolicy(readOnlyHealthContext, db, created.data.id)).id).toBe(created.data.id);
    await expect(
      createPolicy(readOnlyHealthContext, db, healthInput, 'member-health-policy-create-replay'),
    ).rejects.toBeInstanceOf(PolicyAuthorizationRaceError);
  });

  it('denies a completed Policy create replay after policy.create is revoked while policy.read remains', async () => {
    const firstContext = memberPolicyContext(3);
    const input = {
      ...policyInput('REPLAY-AUTH-001', '2026-12-31'),
      customerId: 'policy-member-customer',
    };
    const created = await createPolicy(
      firstContext,
      db,
      input,
      'member-policy-create-replay-denied',
    );
    expect((await getPolicy(firstContext, db, created.data.id)).id).toBe(created.data.id);
    await db
      .prepare(
        `DELETE FROM membership_permissions
         WHERE membership_id='policy-member-membership' AND permission_code='policy.create'`,
      )
      .run();
    await db
      .prepare(
        `UPDATE agency_memberships SET permission_version=4,version=version+1
         WHERE id='policy-member-membership'`,
      )
      .run();
    const readOnlyContext = memberPolicyContext(4);
    expect((await getPolicy(readOnlyContext, db, created.data.id)).id).toBe(created.data.id);
    await expect(
      createPolicy(readOnlyContext, db, input, 'member-policy-create-replay-denied'),
    ).rejects.toBeInstanceOf(PolicyAuthorizationRaceError);
  });

  it('fails closed when a completed Policy create receipt DTO disagrees with its immutable audit target', async () => {
    const originalInput = policyInput('REPLAY-TARGET-001', '2026-12-31');
    const original = await createPolicy(
      ownerContext,
      db,
      originalInput,
      'owner-policy-create-replay-target-original',
    );
    const other = await createPolicy(
      ownerContext,
      db,
      policyInput('REPLAY-TARGET-002', '2026-12-30'),
      'owner-policy-create-replay-target-other',
    );
    const receipt = await db
      .prepare(
        `SELECT response_body FROM operation_receipts
         WHERE agency_id='agency-a' AND actor_user_id='user-a' AND actor_membership_id='member-a'
           AND action='policy.create' AND idempotency_key=?`,
      )
      .bind('owner-policy-create-replay-target-original')
      .first<{ response_body: string }>();
    if (!receipt) throw new Error('Policy create receipt missing in test fixture.');
    const altered = JSON.parse(receipt.response_body) as Record<string, unknown>;
    altered.id = other.data.id;
    await db
      .prepare(
        `UPDATE operation_receipts SET response_body=?
         WHERE agency_id='agency-a' AND actor_user_id='user-a' AND actor_membership_id='member-a'
           AND action='policy.create' AND idempotency_key=?`,
      )
      .bind(JSON.stringify(altered), 'owner-policy-create-replay-target-original')
      .run();
    const immutableAudit = await db
      .prepare(
        `SELECT count(*) AS count,min(target_id) AS target_id FROM audit_events
         WHERE agency_id='agency-a' AND actor_user_id='user-a' AND actor_membership_id='member-a'
           AND action='policy.create' AND outcome='SUCCESS' AND idempotency_key=?`,
      )
      .bind('owner-policy-create-replay-target-original')
      .first<{ count: number; target_id: string | null }>();
    expect(immutableAudit).toEqual({ count: 1, target_id: original.data.id });
    await expect(
      createPolicy(ownerContext, db, originalInput, 'owner-policy-create-replay-target-original'),
    ).rejects.toBeInstanceOf(PolicyAuthorizationRaceError);
  });

  it('fails closed on a malformed completed Policy create DTO even when its audit target still matches', async () => {
    const input = policyInput('REPLAY-MALFORMED-001', '2026-12-31');
    const created = await createPolicy(
      ownerContext,
      db,
      input,
      'owner-policy-create-replay-malformed',
    );
    const receipt = await db
      .prepare(
        `SELECT response_body FROM operation_receipts
         WHERE agency_id='agency-a' AND actor_user_id='user-a' AND actor_membership_id='member-a'
           AND action='policy.create' AND idempotency_key=?`,
      )
      .bind('owner-policy-create-replay-malformed')
      .first<{ response_body: string }>();
    if (!receipt) throw new Error('Policy create receipt missing in malformed DTO test.');
    const malformed = JSON.parse(receipt.response_body) as Record<string, unknown>;
    malformed.grossPremiumMinor = '10025';
    await db
      .prepare(
        `UPDATE operation_receipts SET response_body=?
         WHERE agency_id='agency-a' AND actor_user_id='user-a' AND actor_membership_id='member-a'
           AND action='policy.create' AND idempotency_key=?`,
      )
      .bind(JSON.stringify(malformed), 'owner-policy-create-replay-malformed')
      .run();
    const auditTarget = await db
      .prepare(
        `SELECT count(*) AS count,min(target_id) AS target_id FROM audit_events
         WHERE agency_id='agency-a' AND actor_user_id='user-a' AND actor_membership_id='member-a'
           AND action='policy.create' AND outcome='SUCCESS' AND idempotency_key=?`,
      )
      .bind('owner-policy-create-replay-malformed')
      .first<{ count: number; target_id: string | null }>();
    expect(auditTarget).toEqual({ count: 1, target_id: created.data.id });
    await expect(
      createPolicy(ownerContext, db, input, 'owner-policy-create-replay-malformed'),
    ).rejects.toBeInstanceOf(PolicyAuthorizationRaceError);
  });

  it('fails closed when a default-derived Policy insurer differs from the persisted create result', async () => {
    const input = policyInput('REPLAY-DEFAULT-INSURER-001', '2026-12-31');
    const created = await createPolicy(
      ownerContext,
      db,
      input,
      'owner-policy-create-replay-default-insurer',
    );
    const createAudit = await db
      .prepare(
        `SELECT metadata_json FROM audit_events
         WHERE agency_id='agency-a' AND actor_user_id='user-a' AND actor_membership_id='member-a'
           AND action='policy.create' AND idempotency_key=?`,
      )
      .bind('owner-policy-create-replay-default-insurer')
      .first<{ metadata_json: string }>();
    if (!createAudit) throw new Error('Policy create audit missing in default insurer test.');
    const createMetadata = JSON.parse(createAudit.metadata_json) as Record<string, unknown>;
    expect(createMetadata.responseHash).toBe(
      await computePayloadHash({
        action: 'policy.create',
        target: created.data.id,
        result: created.data,
      }),
    );
    const updated = await updatePolicy(
      ownerContext,
      db,
      created.data.id,
      { expectedVersion: 1, endDate: '2027-12-31' },
      'owner-policy-create-replay-update',
    );
    expect(updated.data.version).toBe(2);
    const exactOriginal = await createPolicy(
      ownerContext,
      db,
      input,
      'owner-policy-create-replay-default-insurer',
    );
    expect(exactOriginal.replayed).toBe(true);
    expect(exactOriginal.data).toEqual(created.data);
    await db
      .prepare(
        "INSERT INTO insurers(id,agency_id,code,name) VALUES('insurer-b','agency-a','INS-B','Other')",
      )
      .run();
    const actual = await db
      .prepare('SELECT insurer_id FROM policies WHERE agency_id=? AND id=?')
      .bind('agency-a', created.data.id)
      .first<{ insurer_id: string }>();
    expect(actual?.insurer_id).toBe('insurer-a');
    const receipt = await db
      .prepare(
        `SELECT response_body FROM operation_receipts
         WHERE agency_id='agency-a' AND actor_user_id='user-a' AND actor_membership_id='member-a'
           AND action='policy.create' AND idempotency_key=?`,
      )
      .bind('owner-policy-create-replay-default-insurer')
      .first<{ response_body: string }>();
    if (!receipt) throw new Error('Policy create receipt missing in default insurer test.');
    const altered = JSON.parse(receipt.response_body) as Record<string, unknown>;
    altered.insurerId = 'insurer-b';
    await db
      .prepare(
        `UPDATE operation_receipts SET response_body=?
         WHERE agency_id='agency-a' AND actor_user_id='user-a' AND actor_membership_id='member-a'
           AND action='policy.create' AND idempotency_key=?`,
      )
      .bind(JSON.stringify(altered), 'owner-policy-create-replay-default-insurer')
      .run();
    await expect(
      createPolicy(ownerContext, db, input, 'owner-policy-create-replay-default-insurer'),
    ).rejects.toBeInstanceOf(PolicyAuthorizationRaceError);
  });

  it('rejects a unique existing Renewal whose initial history or system audit proof is malformed', async () => {
    const cases = [
      {
        policyId: 'policy-corrupt-history-proof',
        renewalId: 'renewal-corrupt-history-proof',
        endDate: '2026-10-15',
        initialState: 'AWAITING_RESPONSE',
        auditOutcome: 'SUCCESS',
        auditKey: 'renewal-policy:policy-corrupt-history-proof',
      },
      {
        policyId: 'policy-corrupt-audit-proof',
        renewalId: 'renewal-corrupt-audit-proof',
        endDate: '2026-10-16',
        initialState: 'CONTACT_PENDING',
        auditOutcome: 'FAILURE',
        auditKey: 'wrong-system-audit-key',
      },
    ] as const;

    for (const [index, proof] of cases.entries()) {
      await insertPolicy(
        proof.policyId,
        `CORRUPT-PROOF-${index}`,
        `CORRUPTPROOF${index}`,
        proof.endDate,
      );
      await db.batch([
        db
          .prepare(
            `INSERT INTO renewal_opportunities(id,agency_id,expiring_policy_id,state,version)
             VALUES (?, 'agency-a', ?, 'CONTACT_PENDING', 1)`,
          )
          .bind(proof.renewalId, proof.policyId),
        db
          .prepare(
            `INSERT INTO renewal_state_history
               (id,agency_id,renewal_id,from_state,to_state,actor_kind,reason_code)
             VALUES (?, 'agency-a', ?, NULL, ?, 'SYSTEM', 'POLICY_EXPIRING')`,
          )
          .bind(`history-${index}`, proof.renewalId, proof.initialState),
        db
          .prepare(
            `INSERT INTO tasks
               (id,agency_id,customer_id,renewal_id,kind,title,due_at,status,actor_kind)
             VALUES (?, 'agency-a', 'customer-a', ?, 'RENEWAL_FOLLOWUP','Yenileme takibi',
               '2026-09-24T06:00:00.000Z','OPEN','SYSTEM')`,
          )
          .bind(`task-${index}`, proof.renewalId),
        db
          .prepare(
            `INSERT INTO system_audit_events
               (id,agency_id,system_actor_code,action,target_type,target_id,correlation_id,
                idempotency_key,outcome,reason_code,metadata_json)
             VALUES (?, 'agency-a','renewal-generation','renewal.generate',
               'renewal_opportunities',?,'correlation',?,?,'POLICY_EXPIRING','{}')`,
          )
          .bind(`system-audit-${index}`, proof.renewalId, proof.auditKey, proof.auditOutcome),
      ]);
      await expect(ensureRenewalForPolicy(db, 'agency-a', proof.policyId)).rejects.toMatchObject({
        code: 'RENEWAL_GENERATION_EXISTING_EFFECT_INCOMPLETE',
      });
    }
    // D1 defaults use its real clock, independently of Vitest's frozen JavaScript clock.
    const cleanupClock = await db
      .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now")
      .first<{ now: string }>();
    if (!cleanupClock) throw new Error('D1 cleanup clock unavailable');
    const cleanupAt = cleanupClock.now;
    await db.batch(
      cases.flatMap((proof) => [
        db
          .prepare(
            `UPDATE tasks SET status='COMPLETED',completed_at=?,completed_by_membership_id=?,
               version=version+1,updated_at=?
             WHERE agency_id='agency-a' AND renewal_id=? AND status='OPEN'`,
          )
          .bind(cleanupAt, 'member-a', cleanupAt, proof.renewalId),
        db
          .prepare(
            `INSERT INTO renewal_state_history
               (id,agency_id,renewal_id,from_state,to_state,actor_kind,actor_user_id,
                actor_membership_id,reason_code,created_at,void_reason_code)
             VALUES (?,?,?,?,'VOIDED','USER','user-a','member-a','TECHNICAL_ERROR',?,
               'TECHNICAL_ERROR')`,
          )
          .bind(
            `cleanup-history-${proof.policyId}`,
            'agency-a',
            proof.renewalId,
            proof.initialState,
            cleanupAt,
          ),
        db
          .prepare(
            `UPDATE renewal_opportunities SET state='VOIDED',void_reason_code='TECHNICAL_ERROR',
               closed_at=?,closed_by_membership_id=?,
               version=version+1,updated_at=?
             WHERE agency_id='agency-a' AND id=?`,
          )
          .bind(cleanupAt, 'member-a', cleanupAt, proof.renewalId),
        db
          .prepare(
            `UPDATE policies SET status='CANCELLED',version=version+1,updated_at=?
             WHERE agency_id='agency-a' AND id=?`,
          )
          .bind(cleanupAt, proof.policyId),
      ]),
    );
  });

  it('retains the first scan baseline across a failed initial generation and catches expiry next day', async () => {
    await insertPolicy('policy-first-scan-catchup', 'FIRST-SCAN-001', 'FIRSTSCAN001', '2026-09-24');
    await db.prepare("DELETE FROM renewal_generation_cursors WHERE agency_id='agency-a'").run();
    await db
      .prepare(
        `CREATE TRIGGER fail_initial_generation_audit BEFORE INSERT ON system_audit_events
         BEGIN SELECT RAISE(ABORT,'INITIAL_GENERATION_FAILURE'); END`,
      )
      .run();

    await expect(runRenewalGenerationForAgency(db, 'agency-a')).rejects.toThrow(
      'INITIAL_GENERATION_FAILURE',
    );
    const baseline = await db
      .prepare(
        'SELECT last_successful_local_date,updated_at FROM renewal_generation_cursors WHERE agency_id=?',
      )
      .bind('agency-a')
      .first<{ last_successful_local_date: string | null; updated_at: string }>();
    expect(baseline?.last_successful_local_date).toBeNull();
    expect(baseline?.updated_at).toBe('2026-09-24T00:00:00.000Z');

    await db.prepare('DROP TRIGGER fail_initial_generation_audit').run();
    vi.setSystemTime(new Date('2026-09-25T00:00:00.000Z'));
    await runRenewalGenerationForAgency(db, 'agency-a');
    const generated = await db
      .prepare(
        `SELECT r.state FROM renewal_opportunities r
         WHERE r.agency_id='agency-a' AND r.expiring_policy_id='policy-first-scan-catchup'`,
      )
      .first<{ state: string }>();
    expect(generated?.state).toBe('CONTACT_PENDING');
  });

  it('schedules initial follow-up on a business day when generation runs on a weekend', async () => {
    const cases = [
      {
        now: '2026-09-26T00:00:00.000Z',
        policyId: 'policy-weekend-saturday',
        policyNumber: 'WEEKEND-SAT-001',
        normalizedNumber: 'WEEKENDSAT001',
        endDate: '2026-10-26',
        expectedDueAt: '2026-09-28T06:00:00.000Z',
      },
      {
        now: '2026-09-27T00:00:00.000Z',
        policyId: 'policy-weekend-sunday-morning',
        policyNumber: 'WEEKEND-SUN-001',
        normalizedNumber: 'WEEKENDSUN001',
        endDate: '2026-10-27',
        expectedDueAt: '2026-09-28T06:00:00.000Z',
      },
      {
        now: '2026-09-27T09:00:00.000Z',
        policyId: 'policy-weekend-sunday-afternoon',
        policyNumber: 'WEEKEND-SUN-002',
        normalizedNumber: 'WEEKENDSUN002',
        endDate: '2026-10-27',
        expectedDueAt: '2026-09-28T06:00:00.000Z',
      },
      {
        now: '2026-09-28T09:00:00.000Z',
        policyId: 'policy-weekday-after-nine',
        policyNumber: 'WEEKDAY-AFTER-001',
        normalizedNumber: 'WEEKDAYAFTER001',
        endDate: '2026-10-28',
        expectedDueAt: '2026-09-28T09:00:00.000Z',
      },
    ];

    try {
      for (const scenario of cases) {
        vi.setSystemTime(new Date(scenario.now));
        await insertPolicy(
          scenario.policyId,
          scenario.policyNumber,
          scenario.normalizedNumber,
          scenario.endDate,
        );
        await runRenewalGenerationForAgency(db, 'agency-a');

        const task = await db
          .prepare(
            `SELECT t.due_at FROM renewal_opportunities r
             JOIN tasks t ON t.agency_id=r.agency_id AND t.renewal_id=r.id
               AND t.kind='RENEWAL_FOLLOWUP'
             WHERE r.agency_id='agency-a' AND r.expiring_policy_id=?`,
          )
          .bind(scenario.policyId)
          .first<{ due_at: string }>();
        expect(task?.due_at).toBe(scenario.expectedDueAt);
      }
    } finally {
      vi.setSystemTime(new Date('2026-09-25T00:00:00.000Z'));
    }
  });

  it('daily Cron discovers a policy entering the window without editing it and ignores document ticks', async () => {
    vi.setSystemTime(new Date('2035-01-01T00:00:00.000Z'));
    await insertPolicy('daily-window-policy', 'DAILY-WINDOW', 'DAILYWINDOW', '2035-02-01');
    const worker = createWorker();
    async function tick(cron: string) {
      const work: Promise<unknown>[] = [];
      worker.scheduled({ cron } as ScheduledController, { DB: db }, {
        waitUntil: (promise: Promise<unknown>) => work.push(promise),
      } as unknown as ExecutionContext);
      await Promise.all(work);
      return work.length;
    }
    expect(await tick('*/5 * * * *')).toBe(0);
    expect(await tick('0 0 * * *')).toBe(1);
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM renewal_opportunities WHERE expiring_policy_id='daily-window-policy'",
        )
        .first(),
    ).toEqual({ count: 0 });
    vi.setSystemTime(new Date('2035-01-02T00:00:00.000Z'));
    await tick('0 0 * * *');
    await tick('0 0 * * *');
    const batchSizes: number[] = [];
    const observed = new Proxy(db, {
      get(target, property) {
        if (property === 'batch')
          return (statements: D1PreparedStatement[]) => {
            batchSizes.push(statements.length);
            return target.batch(statements);
          };
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const replayWork: Promise<unknown>[] = [];
    worker.scheduled({ cron: '0 0 * * *' } as ScheduledController, { DB: observed }, {
      waitUntil: (promise: Promise<unknown>) => replayWork.push(promise),
    } as unknown as ExecutionContext);
    await Promise.all(replayWork);
    expect(batchSizes).toEqual([2, 2]); // Start + atomic completion CAS; no business inserts for existing policies.
    expect(
      await db
        .prepare("SELECT version,end_date FROM policies WHERE id='daily-window-policy'")
        .first(),
    ).toEqual({ version: 1, end_date: '2035-02-01' });
    expect(
      await db
        .prepare(
          `SELECT
      (SELECT count(*) FROM renewal_opportunities WHERE expiring_policy_id='daily-window-policy') AS renewals,
      (SELECT count(*) FROM tasks WHERE renewal_id IN (SELECT id FROM renewal_opportunities WHERE expiring_policy_id='daily-window-policy')) AS tasks,
      (SELECT count(*) FROM renewal_state_history WHERE renewal_id IN (SELECT id FROM renewal_opportunities WHERE expiring_policy_id='daily-window-policy')) AS history,
      (SELECT count(*) FROM system_audit_events WHERE idempotency_key='renewal-policy:daily-window-policy') AS audits`,
        )
        .first(),
    ).toEqual({ renewals: 1, tasks: 1, history: 1, audits: 1 });
  });

  it('recovers a missed daily run after partial failure without advancing the cursor early or duplicating evidence', async () => {
    vi.setSystemTime(new Date('2036-09-24T00:00:00.000Z'));
    await db
      .prepare(
        "UPDATE renewal_generation_cursors SET last_successful_local_date='2036-09-20',continuation_json=NULL,updated_at='2036-09-20T00:00:00.000Z',version=version+1 WHERE agency_id='agency-a'",
      )
      .run();
    await insertPolicy('daily-recovery-a', 'DAILY-RECOVERY-A', 'DAILYRECOVERYA', '2036-09-25');
    await insertPolicy('daily-recovery-b', 'DAILY-RECOVERY-B', 'DAILYRECOVERYB', '2036-09-26');
    await db
      .prepare(
        "CREATE TRIGGER daily_recovery_failure BEFORE INSERT ON renewal_opportunities WHEN NEW.expiring_policy_id='daily-recovery-b' BEGIN SELECT RAISE(ABORT,'DAILY_RECOVERY_TEST_FAILURE'); END",
      )
      .run();
    try {
      await expect(runRenewalGenerationForAgency(db, 'agency-a')).rejects.toThrow(
        /DAILY_RECOVERY_TEST_FAILURE/,
      );
      expect(
        await db
          .prepare(
            "SELECT last_successful_local_date FROM renewal_generation_cursors WHERE agency_id='agency-a'",
          )
          .first(),
      ).toEqual({ last_successful_local_date: '2036-09-20' });
      expect(
        await db
          .prepare(
            "SELECT count(*) AS count FROM renewal_opportunities WHERE expiring_policy_id IN ('daily-recovery-a','daily-recovery-b')",
          )
          .first(),
      ).toEqual({ count: 1 });
    } finally {
      await db.prepare('DROP TRIGGER daily_recovery_failure').run();
    }
    vi.setSystemTime(new Date('2036-09-30T00:00:00.000Z'));
    await runRenewalGenerationForAgency(db, 'agency-a');
    await runRenewalGenerationForAgency(db, 'agency-a');
    const rows = await db
      .prepare(
        `SELECT r.expiring_policy_id,r.state,
      (SELECT count(*) FROM tasks t WHERE t.agency_id=r.agency_id AND t.renewal_id=r.id) AS tasks,
      (SELECT count(*) FROM renewal_state_history h WHERE h.agency_id=r.agency_id AND h.renewal_id=r.id) AS history,
      (SELECT count(*) FROM system_audit_events a WHERE a.agency_id=r.agency_id AND a.idempotency_key='renewal-policy:'||r.expiring_policy_id) AS audits
      FROM renewal_opportunities r WHERE r.expiring_policy_id IN ('daily-recovery-a','daily-recovery-b') ORDER BY r.expiring_policy_id`,
      )
      .all();
    expect(rows.results).toEqual(
      ['daily-recovery-a', 'daily-recovery-b'].map((id) => ({
        expiring_policy_id: id,
        state: 'CONTACT_PENDING',
        tasks: 1,
        history: 1,
        audits: 1,
      })),
    );
    expect(
      await db
        .prepare(
          "SELECT last_successful_local_date FROM renewal_generation_cursors WHERE agency_id='agency-a'",
        )
        .first(),
    ).toEqual({ last_successful_local_date: '2036-09-30' });
  });

  it('drains a representative backlog with bounded statements, rows and durable continuation without advancing the date early', async () => {
    vi.setSystemTime(new Date('2040-01-02T00:00:00.000Z'));
    await db
      .prepare(
        "INSERT INTO renewal_generation_cursors(agency_id,last_successful_local_date,updated_at) VALUES('agency-a','2040-01-01','2040-01-01T00:00:00.000Z') ON CONFLICT(agency_id) DO UPDATE SET last_successful_local_date=excluded.last_successful_local_date,continuation_json=NULL,updated_at=excluded.updated_at,version=renewal_generation_cursors.version+1",
      )
      .run();
    await db
      .prepare(
        `WITH RECURSIVE seq(n) AS (SELECT 0 UNION ALL SELECT n+1 FROM seq WHERE n<63)
      INSERT INTO policies (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency)
      SELECT 'capacity-profile-'||n,'agency-a','customer-a','insurer-a','product-a','branch-a','cash-a','member-a',
        'CAPACITY-'||n,'CAPACITY'||n,'2039-01-01','2040-01-15',10000,'TRY' FROM seq`,
      )
      .run();
    function budgeted() {
      const counts = { calls: 0, statements: 0, candidates: 0 };
      function charge(statements: number) {
        counts.calls++;
        counts.statements += statements;
        if (counts.statements > 50) throw new Error('LOCAL_TEST_STATEMENT_BUDGET');
      }
      function wrap(statement: D1PreparedStatement, query: string): D1PreparedStatement {
        return new Proxy(statement, {
          get(target, property) {
            if (property === 'bind')
              return (...values: unknown[]) => wrap(target.bind(...values), query);
            const value = Reflect.get(target, property, target);
            if (['first', 'all', 'run', 'raw'].includes(String(property)))
              return async (...args: unknown[]) => {
                charge(1);
                const result = await value.apply(target, args);
                if (property === 'all' && query.includes('SELECT p.id AS policy_id'))
                  counts.candidates = Math.max(counts.candidates, result.results.length);
                return result;
              };
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      }
      const bounded = new Proxy(db, {
        get(target, property) {
          if (property === 'prepare') return (query: string) => wrap(target.prepare(query), query);
          if (property === 'batch')
            return (statements: D1PreparedStatement[]) => {
              charge(statements.length);
              return target.batch(statements);
            };
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      });
      return { bounded, counts };
    }
    const countCreated = () =>
      db
        .prepare(
          "SELECT count(*) AS count FROM renewal_opportunities WHERE expiring_policy_id LIKE 'capacity-profile-%'",
        )
        .first<{ count: number }>();
    const first = budgeted();
    await expect(runRenewalGenerationForAgency(first.bounded, 'agency-a')).resolves.toMatchObject({
      createdCount: 4,
      completedThrough: null,
    });
    const firstCreated = await countCreated();
    const retry = budgeted();
    await expect(runRenewalGenerationForAgency(retry.bounded, 'agency-a')).resolves.toMatchObject({
      createdCount: 4,
      completedThrough: null,
    });
    expect(firstCreated?.count).toBe(4);
    expect((await countCreated())!.count).toBe(8);
    expect(first.counts.statements).toBeLessThanOrEqual(50);
    expect(retry.counts.statements).toBeLessThanOrEqual(50);
    expect(first.counts.candidates).toBeLessThanOrEqual(4);
    expect(retry.counts.candidates).toBeLessThanOrEqual(4);
    expect(
      await db
        .prepare(
          "SELECT last_successful_local_date FROM renewal_generation_cursors WHERE agency_id='agency-a'",
        )
        .first(),
    ).toEqual({ last_successful_local_date: '2040-01-01' });
    const progress = await db
      .prepare(
        "SELECT continuation_json FROM renewal_generation_cursors WHERE agency_id='agency-a'",
      )
      .first<{ continuation_json: string }>();
    expect(JSON.parse(progress!.continuation_json)).toMatchObject({
      through: '2040-01-02',
      key: { endDate: '2040-01-15' },
    });
    let completed: string | null = null;
    for (let tick = 0; tick < 20 && completed === null; tick++) {
      const invocation = budgeted();
      completed = (await runRenewalGenerationForAgency(invocation.bounded, 'agency-a'))
        .completedThrough;
      expect(invocation.counts.statements).toBeLessThanOrEqual(50);
      expect(invocation.counts.candidates).toBeLessThanOrEqual(4);
    }
    expect(completed).toBe('2040-01-02');
    expect(
      await db
        .prepare(
          `SELECT
      (SELECT count(*) FROM renewal_opportunities WHERE expiring_policy_id LIKE 'capacity-profile-%') AS renewals,
      (SELECT count(*) FROM tasks WHERE renewal_id IN (SELECT id FROM renewal_opportunities WHERE expiring_policy_id LIKE 'capacity-profile-%')) AS tasks,
      (SELECT count(*) FROM renewal_state_history WHERE renewal_id IN (SELECT id FROM renewal_opportunities WHERE expiring_policy_id LIKE 'capacity-profile-%')) AS history,
      (SELECT count(*) FROM system_audit_events WHERE idempotency_key LIKE 'renewal-policy:capacity-profile-%') AS audits`,
        )
        .first(),
    ).toEqual({ renewals: 64, tasks: 64, history: 64, audits: 64 });
  }, 120000);

  it('still rejects incomplete existing generation evidence before advancing the cursor', async () => {
    vi.setSystemTime(new Date('2041-01-01T00:00:00.000Z'));
    await db
      .prepare(
        "UPDATE renewal_generation_cursors SET last_successful_local_date='2041-01-01',continuation_json=NULL,updated_at='2041-01-01T00:00:00.000Z',version=version+1 WHERE agency_id='agency-a'",
      )
      .run();
    await insertPolicy(
      '000-daily-evidence-gap',
      'DAILY-EVIDENCE-GAP',
      'DAILYEVIDENCEGAP',
      '2041-01-01',
    );
    await db
      .prepare(
        `INSERT INTO renewal_opportunities (id,agency_id,expiring_policy_id,assignee_membership_id,state,version,created_at,updated_at)
      VALUES ('daily-evidence-gap','agency-a','000-daily-evidence-gap','member-a','CONTACT_PENDING',1,'2041-01-01T00:00:00.000Z','2041-01-01T00:00:00.000Z')`,
      )
      .run();
    const before = await db
      .prepare("SELECT * FROM renewal_generation_cursors WHERE agency_id='agency-a'")
      .first();
    await expect(runRenewalGenerationForAgency(db, 'agency-a')).rejects.toThrow(
      'RENEWAL_GENERATION_EXISTING_EFFECT_INCOMPLETE',
    );
    expect(
      await db
        .prepare("SELECT * FROM renewal_generation_cursors WHERE agency_id='agency-a'")
        .first(),
    ).toMatchObject({ last_successful_local_date: before!.last_successful_local_date });
  });
});
