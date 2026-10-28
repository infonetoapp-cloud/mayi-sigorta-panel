// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import miniflare from 'miniflare';
import { createApp, type Env } from '../src/server/index';
import { closeRenewalLost, closeRenewalWon, voidRenewal } from '../src/server/renewals/commands';
import type { AuthenticatedUserContext } from '../src/server/auth/identity';
import type { AuthenticatedPrincipal } from '../src/server/auth/types';

const { Miniflare, convertV4MiniflareOptions } = miniflare;
const root = resolve(__dirname, '..');
const actor: AuthenticatedUserContext = {
  userId: 'terminal-user',
  identityId: 'terminal-identity',
  assurance: 'NORMAL',
  memberships: [
    {
      id: 'terminal-membership',
      agencyId: 'terminal-agency',
      type: 'OWNER',
      status: 'ACTIVE',
      permissionVersion: 2,
    },
  ],
};
const principal = { subject: 'terminal-subject' } as AuthenticatedPrincipal;
const memberActor: AuthenticatedUserContext = {
  userId: 'terminal-member-user',
  identityId: 'terminal-member-identity',
  assurance: 'NORMAL',
  memberships: [
    {
      id: 'terminal-member-membership',
      agencyId: 'terminal-agency',
      type: 'MEMBER',
      status: 'ACTIVE',
      permissionVersion: 2,
    },
  ],
};
const memberPrincipal = { subject: 'terminal-member-subject' } as AuthenticatedPrincipal;
const wonActor: AuthenticatedUserContext = {
  userId: 'terminal-won-user',
  identityId: 'terminal-won-identity',
  assurance: 'NORMAL',
  memberships: [
    {
      id: 'terminal-won-membership',
      agencyId: 'terminal-agency',
      type: 'MEMBER',
      status: 'ACTIVE',
      permissionVersion: 2,
    },
  ],
};
const wonPrincipal = { subject: 'terminal-won-subject' } as AuthenticatedPrincipal;

function terminalApp(
  context: AuthenticatedUserContext = actor,
  verifiedPrincipal: AuthenticatedPrincipal = principal,
) {
  return createApp({
    createSessionVerifier: (config) => ({ config, verify: async () => verifiedPrincipal }),
    createResolver: () => ({ resolve: async () => context }) as never,
  });
}

function revokeIdentityBeforeAuditProof(database: D1Database, identityId: string): D1Database {
  let revoked = false;
  return new Proxy(database, {
    get(target, property) {
      if (property !== 'prepare') {
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      }
      return (query: string) => {
        const statement = target.prepare(query);
        if (!query.includes('FROM audit_events a')) return statement;
        return {
          bind: (...bindings: unknown[]) => {
            const bound = statement.bind(...bindings);
            return {
              first: async () => {
                if (!revoked) {
                  revoked = true;
                  await target
                    .prepare(
                      `UPDATE auth_identities SET status='REVOKED',revoked_at='2099-01-01T00:00:00.000Z',
                       version=version+1,updated_at='2099-01-01T00:00:00.000Z' WHERE id=?`,
                    )
                    .bind(identityId)
                    .run();
                }
                return bound.first();
              },
              all: () => bound.all(),
              run: () => bound.run(),
              raw: () => bound.raw(),
            } as unknown as D1PreparedStatement;
          },
        } as unknown as D1PreparedStatement;
      };
    },
  }) as D1Database;
}

function changeGrantScopeBeforeMutationBatch(
  database: D1Database,
  permissionCode: string,
  scope: 'ASSIGNED' | 'AGENCY',
  membershipId = 'terminal-member-membership',
): D1Database {
  let changed = false;
  return new Proxy(database, {
    get(target, property) {
      if (property === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          if (!changed) {
            changed = true;
            await target
              .prepare(
                'UPDATE membership_permissions SET scope=? WHERE membership_id=? AND permission_code=?',
              )
              .bind(scope, membershipId, permissionCode)
              .run();
          }
          return target.batch(statements);
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as D1Database;
}

describe('M3-T03 explicit Renewal outcome commands on local D1', () => {
  let mf: miniflare.Miniflare;
  let db: D1Database;
  let env: Env;
  let csrf: string;
  let memberCsrf: string;

  beforeAll(async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-09-24T06:00:00.000Z'));
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: 'export default { fetch() { return new Response(null); } }',
        d1Databases: { DB: '00000000-0000-0000-0000-000000000033' },
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
      db.prepare("INSERT INTO agencies(id,status) VALUES('terminal-agency','PROVISIONING')"),
      db.prepare("INSERT INTO users(id,status,version) VALUES('terminal-user','INACTIVE',1)"),
      db.prepare(
        `INSERT INTO agency_memberships
           (id,agency_id,user_id,type,status,permission_version,version,invitation_email,
            invitation_expires_at)
         VALUES('terminal-membership','terminal-agency','terminal-user','OWNER','INVITED',1,1,
           'terminal@test.test','2099-01-01T00:00:00.000Z')`,
      ),
      db.prepare(
        `INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email,status)
         VALUES('terminal-identity','terminal-user','https://team.cloudflareaccess.com',
           'terminal-subject','terminal@test.test','ACTIVE')`,
      ),
      db.prepare(
        `INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email,status)
         VALUES('terminal-identity-backup','terminal-user','https://team.cloudflareaccess.com',
           'terminal-subject-backup','terminal@test.test','ACTIVE')`,
      ),
    ]);
    await db.prepare("UPDATE users SET status='ACTIVE',version=2 WHERE id='terminal-user'").run();
    await db
      .prepare(
        `UPDATE agency_memberships SET status='ACTIVE',activated_at='2026-01-01T00:00:00.000Z',
           permission_version=2,version=2 WHERE id='terminal-membership'`,
      )
      .run();
    await db
      .prepare(
        `UPDATE agencies SET status='ACTIVE',bootstrap_completed_at='2026-01-01T00:00:00.000Z',
           activated_at='2026-01-01T00:00:00.000Z',version=2 WHERE id='terminal-agency'`,
      )
      .run();
    await db.batch([
      db.prepare(
        "INSERT INTO users(id,status,version) VALUES('terminal-member-user','INACTIVE',1)",
      ),
      db.prepare(
        `INSERT INTO agency_memberships
           (id,agency_id,user_id,type,status,permission_version,version,invitation_email,
            invitation_expires_at)
         VALUES('terminal-member-membership','terminal-agency','terminal-member-user','MEMBER','INVITED',1,1,
           'terminal-member@test.test','2099-01-01T00:00:00.000Z')`,
      ),
      db.prepare(
        `INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email,status)
         VALUES('terminal-member-identity','terminal-member-user','https://team.cloudflareaccess.com',
           'terminal-member-subject','terminal-member@test.test','ACTIVE')`,
      ),
    ]);
    await db
      .prepare("UPDATE users SET status='ACTIVE',version=2 WHERE id='terminal-member-user'")
      .run();
    await db
      .prepare(
        `UPDATE agency_memberships SET status='ACTIVE',activated_at='2026-01-01T00:00:00.000Z',
           permission_version=2,version=2 WHERE id='terminal-member-membership'`,
      )
      .run();
    await db.batch([
      db.prepare("INSERT INTO users(id,status,version) VALUES('terminal-won-user','INACTIVE',1)"),
      db.prepare(
        `INSERT INTO agency_memberships
           (id,agency_id,user_id,type,status,permission_version,version,invitation_email,
            invitation_expires_at)
         VALUES('terminal-won-membership','terminal-agency','terminal-won-user','MEMBER','INVITED',1,1,
           'terminal-won@test.test','2099-01-01T00:00:00.000Z')`,
      ),
      db.prepare(
        `INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email,status)
         VALUES('terminal-won-identity','terminal-won-user','https://team.cloudflareaccess.com',
           'terminal-won-subject','terminal-won@test.test','ACTIVE')`,
      ),
    ]);
    await db
      .prepare("UPDATE users SET status='ACTIVE',version=2 WHERE id='terminal-won-user'")
      .run();
    await db
      .prepare(
        `UPDATE agency_memberships SET status='ACTIVE',activated_at='2026-01-01T00:00:00.000Z',
           permission_version=2,version=2 WHERE id='terminal-won-membership'`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO membership_permissions(id,membership_id,permission_code,scope)
         VALUES('terminal-won-customer-read','terminal-won-membership','customer.read','AGENCY'),
               ('terminal-won-policy-read','terminal-won-membership','policy.read','AGENCY'),
               ('terminal-won-policy-create','terminal-won-membership','policy.create','UNSCOPED'),
               ('terminal-won-renewal-read','terminal-won-membership','renewal.read','AGENCY'),
               ('terminal-won-renewal-close','terminal-won-membership','renewal.close_won','AGENCY'),
               ('terminal-won-loss-close','terminal-won-membership','renewal.close_lost','AGENCY'),
               ('terminal-won-task-read','terminal-won-membership','task.read','AGENCY'),
               ('terminal-won-task-update','terminal-won-membership','task.update','AGENCY')`,
      )
      .run();
    await db.batch([
      db.prepare(
        `INSERT INTO membership_permissions(id,membership_id,permission_code,scope)
         VALUES('terminal-member-customer-read','terminal-member-membership','customer.read','AGENCY'),
               ('terminal-member-policy-read','terminal-member-membership','policy.read','AGENCY'),
               ('terminal-member-renewal-read','terminal-member-membership','renewal.read','AGENCY'),
               ('terminal-member-task-read','terminal-member-membership','task.read','AGENCY'),
               ('terminal-member-task-update','terminal-member-membership','task.update','AGENCY')`,
      ),
    ]);
    await db.batch([
      db.prepare(
        `INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id)
         VALUES('terminal-customer','terminal-agency','INDIVIDUAL','Terminal Customer','Terminal','Customer',
           'terminal-membership')`,
      ),
      db.prepare(
        "INSERT INTO insurers(id,agency_id,code,name) VALUES('terminal-insurer','terminal-agency','I','Insurer')",
      ),
      db.prepare(
        `INSERT INTO insurance_branches(id,agency_id,code,name,data_classification)
         VALUES('terminal-branch','terminal-agency','AUTO','Auto','GENERAL')`,
      ),
      db.prepare(
        `INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name)
         VALUES('terminal-product','terminal-agency','terminal-insurer','terminal-branch','AUTO','Auto')`,
      ),
      db.prepare(
        `INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name)
         VALUES('terminal-product-alt','terminal-agency','terminal-insurer','terminal-branch','AUTO-PLUS','Auto Plus')`,
      ),
      db.prepare(
        `INSERT INTO payment_methods(id,agency_id,code,name,supports_installments,max_installments)
         VALUES('terminal-payment','terminal-agency','CASH','Cash',0,12)`,
      ),
      db.prepare(
        `INSERT INTO loss_reasons(id,agency_id,code,name,status,version)
         VALUES('terminal-loss-price','terminal-agency','PRICE','Price','ACTIVE',1),
               ('terminal-loss-other','terminal-agency','OTHER','Other','ACTIVE',1)`,
      ),
      db.prepare(
        `INSERT INTO policies
           (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
            assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
            gross_premium_minor,currency)
         VALUES('terminal-old-policy','terminal-agency','terminal-customer','terminal-insurer',
           'terminal-product','terminal-branch','terminal-payment','terminal-membership',
           'TERM-001','TERM001','2026-01-01','2026-10-24',10000,'TRY'),
               ('terminal-void-policy','terminal-agency','terminal-customer','terminal-insurer',
           'terminal-product','terminal-branch','terminal-payment','terminal-membership',
           'TERM-002','TERM002','2026-01-01','2026-10-25',12000,'TRY'),
               ('terminal-race-policy','terminal-agency','terminal-customer','terminal-insurer',
           'terminal-product','terminal-branch','terminal-payment','terminal-membership',
           'TERM-003','TERM003','2026-01-01','2026-10-26',9000,'TRY'),
               ('terminal-cross-race-policy','terminal-agency','terminal-customer','terminal-insurer',
           'terminal-product','terminal-branch','terminal-payment','terminal-membership',
           'TERM-004','TERM004','2026-01-01','2026-10-27',11000,'TRY'),
               ('terminal-scope-policy','terminal-agency','terminal-customer','terminal-insurer',
           'terminal-product','terminal-branch','terminal-payment','terminal-membership',
           'TERM-005','TERM005','2026-01-01','2026-10-28',13000,'TRY')`,
      ),
      db.prepare(
        `INSERT INTO renewal_opportunities
           (id,agency_id,expiring_policy_id,assignee_membership_id,state,version,created_at,updated_at)
         VALUES('terminal-renewal','terminal-agency','terminal-old-policy','terminal-membership',
           'CONTACT_PENDING',1,'2026-09-24T06:00:00.000Z','2026-09-24T06:00:00.000Z'),
               ('terminal-void-renewal','terminal-agency','terminal-void-policy','terminal-membership',
           'CONTACT_PENDING',1,'2026-09-24T06:00:00.000Z','2026-09-24T06:00:00.000Z'),
               ('terminal-race-renewal','terminal-agency','terminal-race-policy','terminal-membership',
           'CONTACT_PENDING',1,'2026-09-24T06:00:00.000Z','2026-09-24T06:00:00.000Z'),
               ('terminal-cross-race-renewal','terminal-agency','terminal-cross-race-policy','terminal-membership',
           'CONTACT_PENDING',1,'2026-09-24T06:00:00.000Z','2026-09-24T06:00:00.000Z'),
               ('terminal-scope-renewal','terminal-agency','terminal-scope-policy','terminal-membership',
           'CONTACT_PENDING',1,'2026-09-24T06:00:00.000Z','2026-09-24T06:00:00.000Z')`,
      ),
      db.prepare(
        `INSERT INTO renewal_state_history
           (id,agency_id,renewal_id,from_state,to_state,actor_kind,reason_code,created_at)
         VALUES('terminal-initial-history','terminal-agency','terminal-renewal',NULL,
           'CONTACT_PENDING','SYSTEM','POLICY_EXPIRING','2026-09-24T06:00:00.000Z'),
               ('terminal-void-initial-history','terminal-agency','terminal-void-renewal',NULL,
           'CONTACT_PENDING','SYSTEM','POLICY_EXPIRING','2026-09-24T06:00:00.000Z'),
               ('terminal-race-initial-history','terminal-agency','terminal-race-renewal',NULL,
           'CONTACT_PENDING','SYSTEM','POLICY_EXPIRING','2026-09-24T06:00:00.000Z'),
               ('terminal-cross-race-initial-history','terminal-agency','terminal-cross-race-renewal',NULL,
           'CONTACT_PENDING','SYSTEM','POLICY_EXPIRING','2026-09-24T06:00:00.000Z'),
               ('terminal-scope-initial-history','terminal-agency','terminal-scope-renewal',NULL,
           'CONTACT_PENDING','SYSTEM','POLICY_EXPIRING','2026-09-24T06:00:00.000Z')`,
      ),
      db.prepare(
        `INSERT INTO tasks
           (id,agency_id,customer_id,renewal_id,kind,title,due_at,assignee_membership_id,
            status,actor_kind,version,created_at,updated_at)
         VALUES('terminal-primary-task','terminal-agency','terminal-customer','terminal-renewal',
           'RENEWAL_FOLLOWUP','Renewal follow-up','2026-09-24T06:00:00.000Z',
           'terminal-membership','OPEN','SYSTEM',1,'2026-09-24T06:00:00.000Z','2026-09-24T06:00:00.000Z'),
               ('terminal-void-primary-task','terminal-agency','terminal-customer','terminal-void-renewal',
           'RENEWAL_FOLLOWUP','Void candidate follow-up','2026-09-24T06:00:00.000Z',
           'terminal-membership','OPEN','SYSTEM',1,'2026-09-24T06:00:00.000Z','2026-09-24T06:00:00.000Z'),
               ('terminal-race-primary-task','terminal-agency','terminal-customer','terminal-race-renewal',
           'RENEWAL_FOLLOWUP','Concurrent close follow-up','2026-09-24T06:00:00.000Z',
           'terminal-membership','OPEN','SYSTEM',1,'2026-09-24T06:00:00.000Z','2026-09-24T06:00:00.000Z'),
               ('terminal-cross-race-primary-task','terminal-agency','terminal-customer','terminal-cross-race-renewal',
           'RENEWAL_FOLLOWUP','Cross-command race follow-up','2026-09-24T06:00:00.000Z',
           'terminal-membership','OPEN','SYSTEM',1,'2026-09-24T06:00:00.000Z','2026-09-24T06:00:00.000Z'),
               ('terminal-scope-primary-task','terminal-agency','terminal-customer','terminal-scope-renewal',
           'RENEWAL_FOLLOWUP','Permission scope follow-up','2026-09-24T06:00:00.000Z',
           'terminal-membership','OPEN','SYSTEM',1,'2026-09-24T06:00:00.000Z','2026-09-24T06:00:00.000Z')`,
      ),
    ]);

    env = {
      DB: db,
      CSRF_SECRET: 'test-csrf-secret-that-is-long-enough',
    } satisfies Env;
    const app = terminalApp();
    const csrfResponse = await app.request(
      'https://panel.mayisigorta.com/api/csrf-token',
      { method: 'GET' },
      env,
    );
    csrf = ((await csrfResponse.json()) as { data: { token: string } }).data.token;
    const memberCsrfResponse = await terminalApp(memberActor, memberPrincipal).request(
      'https://panel.mayisigorta.com/api/csrf-token',
      { method: 'GET' },
      env,
    );
    memberCsrf = ((await memberCsrfResponse.json()) as { data: { token: string } }).data.token;
  });

  afterAll(async () => {
    vi.useRealTimers();
    await mf.dispose();
  });

  it('closes an open renewal as LOST with its primary Task, history, audit and receipt atomically', async () => {
    const payload = {
      expectedPrimaryTaskId: 'terminal-primary-task',
      expectedRenewalVersion: 1,
      expectedTaskVersion: 1,
      lossReasonId: 'terminal-loss-other',
      lossReasonNotes: 'Renewal no longer needed',
    };
    const closeLost = (
      body: Record<string, unknown> = payload,
      idempotencyKey = 'terminal-close-lost-key',
    ) =>
      terminalApp().request(
        'https://panel.mayisigorta.com/api/renewals/terminal-renewal/close-lost',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://panel.mayisigorta.com',
            'X-CSRF-Token': csrf,
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify(body),
        },
        env,
      );

    const unauthorized = await terminalApp(memberActor, memberPrincipal).request(
      'https://panel.mayisigorta.com/api/renewals/terminal-renewal/close-lost',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': memberCsrf,
          'Idempotency-Key': 'terminal-member-close-lost-key',
        },
        body: JSON.stringify(payload),
      },
      env,
    );
    expect(unauthorized.status).toBe(403);
    expect(
      await db
        .prepare('SELECT state,version FROM renewal_opportunities WHERE id=?')
        .bind('terminal-renewal')
        .first(),
    ).toEqual({ state: 'CONTACT_PENDING', version: 1 });

    const missingOtherNotes = await closeLost({
      ...payload,
      lossReasonId: 'terminal-loss-other',
      lossReasonNotes: null,
    });
    expect(missingOtherNotes.status).toBe(400);
    const staleVersion = await closeLost(
      { ...payload, expectedRenewalVersion: 2 },
      'terminal-stale-renewal-version',
    );
    expect(staleVersion.status).toBe(409);
    const staleTaskVersion = await closeLost(
      { ...payload, expectedTaskVersion: 2 },
      'terminal-stale-task-version',
    );
    expect(staleTaskVersion.status).toBe(409);

    await db
      .prepare(
        `CREATE TRIGGER fail_terminal_lost_audit BEFORE INSERT ON audit_events
         WHEN NEW.action='renewal.closed_lost'
         BEGIN SELECT RAISE(ABORT,'INJECTED_AUDIT_FAILURE'); END`,
      )
      .run();
    const auditFailure = await closeLost();
    expect(auditFailure.status).toBe(500);
    expect(
      await db
        .prepare('SELECT state,version,closed_at FROM renewal_opportunities WHERE id=?')
        .bind('terminal-renewal')
        .first(),
    ).toEqual({ state: 'CONTACT_PENDING', version: 1, closed_at: null });
    expect(
      await db
        .prepare('SELECT status,version,completed_at FROM tasks WHERE id=?')
        .bind('terminal-primary-task')
        .first(),
    ).toEqual({ status: 'OPEN', version: 1, completed_at: null });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM operation_receipts WHERE idempotency_key='terminal-close-lost-key'",
        )
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM renewal_state_history WHERE renewal_id='terminal-renewal'",
        )
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM audit_events WHERE action='renewal.closed_lost' AND target_id='terminal-renewal'",
        )
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
    await db.prepare('DROP TRIGGER fail_terminal_lost_audit').run();

    const response = await closeLost();
    expect(response.status, await response.clone().text()).toBe(200);
    const envelope = (await response.json()) as {
      data: {
        renewalId: string;
        state: string;
        renewalVersion: number;
        taskVersion: number;
      };
      replayed: boolean;
    };
    expect(envelope.data).toMatchObject({
      renewalId: 'terminal-renewal',
      state: 'LOST',
      renewalVersion: 2,
      taskVersion: 2,
    });
    expect(envelope.replayed).toBe(false);
    const exactReplay = await closeLost();
    expect(exactReplay.status, await exactReplay.clone().text()).toBe(200);
    expect(await exactReplay.json()).toMatchObject({
      success: true,
      data: envelope.data,
      replayed: true,
    });
    const changedPayloadReplay = await closeLost({
      ...payload,
      lossReasonId: 'terminal-loss-price',
      lossReasonNotes: null,
    });
    expect(changedPayloadReplay.status).toBe(409);
    expect(await changedPayloadReplay.json()).toMatchObject({
      success: false,
      error: { code: 'IDEMPOTENCY_CONFLICT' },
    });
    expect(
      await db
        .prepare(
          'SELECT state,loss_reason_id,loss_reason_notes,closed_at,closed_by_membership_id,version FROM renewal_opportunities WHERE id=?',
        )
        .bind('terminal-renewal')
        .first(),
    ).toEqual({
      state: 'LOST',
      loss_reason_id: 'terminal-loss-other',
      loss_reason_notes: 'Renewal no longer needed',
      closed_at: '2026-09-24T06:00:00.000Z',
      closed_by_membership_id: 'terminal-membership',
      version: 2,
    });
    expect(
      await db
        .prepare(
          'SELECT status,completed_at,completed_by_membership_id,version FROM tasks WHERE id=?',
        )
        .bind('terminal-primary-task')
        .first(),
    ).toEqual({
      status: 'COMPLETED',
      completed_at: '2026-09-24T06:00:00.000Z',
      completed_by_membership_id: 'terminal-membership',
      version: 2,
    });
    const history = await db
      .prepare(
        'SELECT from_state,to_state,reason_code FROM renewal_state_history WHERE renewal_id=?',
      )
      .bind('terminal-renewal')
      .all<{ from_state: string | null; to_state: string; reason_code: string }>();
    expect(history.success).toBe(true);
    expect(history.results).toHaveLength(2);
    expect(history.results).toEqual(
      expect.arrayContaining([
        { from_state: null, to_state: 'CONTACT_PENDING', reason_code: 'POLICY_EXPIRING' },
        { from_state: 'CONTACT_PENDING', to_state: 'LOST', reason_code: 'LOST' },
      ]),
    );
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM operation_receipts WHERE idempotency_key='terminal-close-lost-key'",
        )
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM audit_events WHERE idempotency_key='terminal-close-lost-key' AND outcome='SUCCESS'",
        )
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });

  it('rechecks current identity in the same query that proves an exact LOST replay', async () => {
    const payload = {
      expectedPrimaryTaskId: 'terminal-primary-task',
      expectedRenewalVersion: 1,
      expectedTaskVersion: 1,
      lossReasonId: 'terminal-loss-other',
      lossReasonNotes: 'Renewal no longer needed',
    };
    try {
      await expect(
        closeRenewalLost(
          actor,
          revokeIdentityBeforeAuditProof(db, 'terminal-identity'),
          'terminal-renewal',
          payload,
          'terminal-close-lost-key',
        ),
      ).rejects.toMatchObject({ code: 'REPLAY_NOT_AUTHORIZED', status: 404 });
    } finally {
      await db
        .prepare(
          `UPDATE auth_identities SET status='ACTIVE',revoked_at=NULL,version=version+1,
                    updated_at='2100-01-01T00:00:00.000Z' WHERE id='terminal-identity'`,
        )
        .run();
    }
  });

  it('replays a completed LOST receipt after its policy is later cancelled', async () => {
    await db
      .prepare(
        `UPDATE policies SET status='CANCELLED',version=version+1,updated_at='2026-09-24T06:00:00.000Z'
         WHERE id='terminal-old-policy'`,
      )
      .run();
    try {
      const replay = await closeRenewalLost(
        actor,
        db,
        'terminal-renewal',
        {
          expectedPrimaryTaskId: 'terminal-primary-task',
          expectedRenewalVersion: 1,
          expectedTaskVersion: 1,
          lossReasonId: 'terminal-loss-other',
          lossReasonNotes: 'Renewal no longer needed',
        },
        'terminal-close-lost-key',
      );
      expect(replay.replayed).toBe(true);
      expect(replay.data).toMatchObject({ state: 'LOST', renewalVersion: 2, taskVersion: 2 });
      expect(
        await db
          .prepare(
            "SELECT count(*) AS count FROM audit_events WHERE action='renewal.closed_lost' AND target_id='terminal-renewal'",
          )
          .first<{ count: number }>(),
      ).toEqual({ count: 1 });
    } finally {
      await db
        .prepare(
          `UPDATE policies SET status='ACTIVE',version=version+1,updated_at='2026-09-24T06:00:00.000Z'
           WHERE id='terminal-old-policy'`,
        )
        .run();
    }
  });

  it('reopens a LOST renewal to its previous state and atomically creates a new primary Task', async () => {
    const payload = {
      expectedRenewalVersion: 2,
      expectedTaskVersion: 2,
      replacementDueAt: '2026-09-25T06:00:00.000Z',
      reopenReasonCode: 'CUSTOMER_REQUESTED_RENEWAL',
    };
    const unauthorized = await terminalApp(memberActor, memberPrincipal).request(
      'https://panel.mayisigorta.com/api/renewals/terminal-renewal/reopen',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': memberCsrf,
          'Idempotency-Key': 'terminal-member-reopen-key',
        },
        body: JSON.stringify(payload),
      },
      env,
    );
    expect(unauthorized.status).toBe(403);
    const staleTaskVersion = await terminalApp().request(
      'https://panel.mayisigorta.com/api/renewals/terminal-renewal/reopen',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'terminal-reopen-stale-task-version',
        },
        body: JSON.stringify({ ...payload, expectedTaskVersion: 1 }),
      },
      env,
    );
    expect(staleTaskVersion.status).toBe(409);
    await db
      .prepare(
        `CREATE TRIGGER fail_reopen_task_insert BEFORE INSERT ON tasks
         WHEN NEW.renewal_id='terminal-renewal' AND NEW.kind='RENEWAL_FOLLOWUP'
           AND NEW.status='OPEN' AND NEW.actor_kind='USER'
         BEGIN SELECT RAISE(ABORT,'INJECTED_REOPEN_TASK_FAILURE'); END`,
      )
      .run();
    const taskFailure = await terminalApp().request(
      'https://panel.mayisigorta.com/api/renewals/terminal-renewal/reopen',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'terminal-reopen-lost-key',
        },
        body: JSON.stringify(payload),
      },
      env,
    );
    expect(taskFailure.status, await taskFailure.clone().text()).toBe(500);
    expect(
      await db
        .prepare('SELECT state,version,closed_at FROM renewal_opportunities WHERE id=?')
        .bind('terminal-renewal')
        .first(),
    ).toEqual({ state: 'LOST', version: 2, closed_at: '2026-09-24T06:00:00.000Z' });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM tasks WHERE renewal_id='terminal-renewal' AND status='OPEN'",
        )
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM operation_receipts WHERE idempotency_key='terminal-reopen-lost-key'",
        )
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
    await db.prepare('DROP TRIGGER fail_reopen_task_insert').run();
    const response = await terminalApp().request(
      'https://panel.mayisigorta.com/api/renewals/terminal-renewal/reopen',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'terminal-reopen-lost-key',
        },
        body: JSON.stringify(payload),
      },
      env,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const envelope = (await response.json()) as {
      data: {
        renewalId: string;
        previousState: string;
        state: string;
        primaryTaskId: string;
        closedTaskId: string;
        closedTaskVersion: number;
        terminalClosedAt: string;
        renewalVersion: number;
        taskVersion: number;
        reopenedAt: string;
      };
      replayed: boolean;
    };
    expect(envelope.data).toMatchObject({
      renewalId: 'terminal-renewal',
      previousState: 'LOST',
      state: 'CONTACT_PENDING',
      closedTaskId: 'terminal-primary-task',
      closedTaskVersion: 2,
      terminalClosedAt: '2026-09-24T06:00:00.000Z',
      renewalVersion: 3,
      taskVersion: 1,
      reopenedAt: '2026-09-24T06:00:00.000Z',
    });
    expect(envelope.data.primaryTaskId).not.toBe('terminal-primary-task');
    expect(envelope.replayed).toBe(false);
    expect(
      await db
        .prepare(
          'SELECT state,loss_reason_id,loss_reason_notes,void_reason_code,closed_at,version FROM renewal_opportunities WHERE id=?',
        )
        .bind('terminal-renewal')
        .first(),
    ).toEqual({
      state: 'CONTACT_PENDING',
      loss_reason_id: null,
      loss_reason_notes: null,
      void_reason_code: null,
      closed_at: null,
      version: 3,
    });
    expect(
      await db
        .prepare('SELECT status,version FROM tasks WHERE id=?')
        .bind('terminal-primary-task')
        .first(),
    ).toEqual({ status: 'COMPLETED', version: 2 });
    expect(
      await db
        .prepare(
          `SELECT loss_reason_id,loss_reason_notes,void_reason_code
           FROM renewal_state_history WHERE agency_id=? AND renewal_id=?
             AND to_state='LOST' AND reason_code='LOST'`,
        )
        .bind('terminal-agency', 'terminal-renewal')
        .first(),
    ).toEqual({
      loss_reason_id: 'terminal-loss-other',
      loss_reason_notes: 'Renewal no longer needed',
      void_reason_code: null,
    });
    expect(
      await db
        .prepare(
          'SELECT kind,status,version,due_at,assignee_membership_id,actor_kind,created_by_user_id FROM tasks WHERE id=?',
        )
        .bind(envelope.data.primaryTaskId)
        .first(),
    ).toEqual({
      kind: 'RENEWAL_FOLLOWUP',
      status: 'OPEN',
      version: 1,
      due_at: payload.replacementDueAt,
      assignee_membership_id: 'terminal-membership',
      actor_kind: 'USER',
      created_by_user_id: 'terminal-user',
    });
    const replay = await terminalApp().request(
      'https://panel.mayisigorta.com/api/renewals/terminal-renewal/reopen',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'terminal-reopen-lost-key',
        },
        body: JSON.stringify(payload),
      },
      env,
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      success: true,
      data: envelope.data,
      replayed: true,
    });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM audit_events WHERE action='renewal.reopened' AND idempotency_key='terminal-reopen-lost-key'",
        )
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
    const assignment = await terminalApp().request(
      `https://panel.mayisigorta.com/api/renewals/terminal-renewal/tasks/${envelope.data.primaryTaskId}/assign`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'terminal-post-reopen-assignment-key',
        },
        body: JSON.stringify({
          expectedRenewalVersion: 3,
          expectedTaskVersion: 1,
          assigneeMembershipId: 'terminal-member-membership',
        }),
      },
      env,
    );
    expect(assignment.status, await assignment.clone().text()).toBe(200);
    expect(
      await db
        .prepare('SELECT assignee_membership_id FROM tasks WHERE id=?')
        .bind('terminal-primary-task')
        .first(),
    ).toEqual({ assignee_membership_id: 'terminal-membership' });
    expect(
      await db
        .prepare('SELECT assignee_membership_id FROM tasks WHERE id=?')
        .bind(envelope.data.primaryTaskId)
        .first(),
    ).toEqual({ assignee_membership_id: 'terminal-member-membership' });
    const originalLostReplay = await closeRenewalLost(
      actor,
      db,
      'terminal-renewal',
      {
        expectedPrimaryTaskId: 'terminal-primary-task',
        expectedRenewalVersion: 1,
        expectedTaskVersion: 1,
        lossReasonId: 'terminal-loss-other',
        lossReasonNotes: 'Renewal no longer needed',
      },
      'terminal-close-lost-key',
    );
    expect(originalLostReplay.replayed).toBe(true);
    expect(originalLostReplay.data).toMatchObject({
      state: 'LOST',
      primaryTaskId: 'terminal-primary-task',
      renewalVersion: 2,
      taskVersion: 2,
    });
  });

  it('converges concurrent identical LOST retries on one result, receipt, history and audit', async () => {
    const payload = {
      expectedPrimaryTaskId: 'terminal-race-primary-task',
      expectedRenewalVersion: 1,
      expectedTaskVersion: 1,
      lossReasonId: 'terminal-loss-price',
      lossReasonNotes: null,
    };
    const [first, second] = await Promise.all([
      closeRenewalLost(actor, db, 'terminal-race-renewal', payload, 'terminal-race-close-lost-key'),
      closeRenewalLost(actor, db, 'terminal-race-renewal', payload, 'terminal-race-close-lost-key'),
    ]);
    expect([first.replayed, second.replayed].sort()).toEqual([false, true]);
    expect(first.data).toEqual(second.data);
    expect(first.data).toMatchObject({
      state: 'LOST',
      primaryTaskId: 'terminal-race-primary-task',
    });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM operation_receipts WHERE idempotency_key='terminal-race-close-lost-key'",
        )
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM audit_events WHERE idempotency_key='terminal-race-close-lost-key' AND outcome='SUCCESS'",
        )
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM renewal_state_history WHERE renewal_id='terminal-race-renewal' AND to_state='LOST'",
        )
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });

  it('closes an open renewal as VOIDED without classifying it as commercial loss', async () => {
    const payload = {
      expectedPrimaryTaskId: 'terminal-void-primary-task',
      expectedRenewalVersion: 1,
      expectedTaskVersion: 1,
      voidReasonCode: 'TECHNICAL_ERROR' as const,
    };
    const sendVoid = (
      body: Record<string, unknown> = payload,
      idempotencyKey = 'terminal-close-void-key',
    ) =>
      terminalApp().request(
        'https://panel.mayisigorta.com/api/renewals/terminal-void-renewal/void',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://panel.mayisigorta.com',
            'X-CSRF-Token': csrf,
            'Idempotency-Key': idempotencyKey,
          },
          body: JSON.stringify(body),
        },
        env,
      );

    await db
      .prepare(
        `CREATE TRIGGER fail_terminal_void_audit BEFORE INSERT ON audit_events
         WHEN NEW.action='renewal.voided'
         BEGIN SELECT RAISE(ABORT,'INJECTED_VOID_AUDIT_FAILURE'); END`,
      )
      .run();
    const auditFailure = await sendVoid();
    expect(auditFailure.status).toBe(500);
    expect(
      await db
        .prepare('SELECT state,version,closed_at FROM renewal_opportunities WHERE id=?')
        .bind('terminal-void-renewal')
        .first(),
    ).toEqual({ state: 'CONTACT_PENDING', version: 1, closed_at: null });
    expect(
      await db
        .prepare('SELECT status,version,completed_at FROM tasks WHERE id=?')
        .bind('terminal-void-primary-task')
        .first(),
    ).toEqual({ status: 'OPEN', version: 1, completed_at: null });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM operation_receipts WHERE idempotency_key='terminal-close-void-key'",
        )
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
    await db.prepare('DROP TRIGGER fail_terminal_void_audit').run();

    const response = await sendVoid();
    expect(response.status, await response.clone().text()).toBe(200);
    expect(await response.json()).toMatchObject({
      success: true,
      data: {
        renewalId: 'terminal-void-renewal',
        state: 'VOIDED',
        voidReasonCode: 'TECHNICAL_ERROR',
        renewalVersion: 2,
        taskVersion: 2,
      },
      replayed: false,
    });
    const exactReplay = await sendVoid();
    expect(exactReplay.status).toBe(200);
    expect(await exactReplay.json()).toMatchObject({
      success: true,
      data: {
        renewalId: 'terminal-void-renewal',
        state: 'VOIDED',
        voidReasonCode: 'TECHNICAL_ERROR',
      },
      replayed: true,
    });
    const changedVoidReplay = await sendVoid({ ...payload, voidReasonCode: 'DUPLICATE' });
    expect(changedVoidReplay.status).toBe(409);
    expect(await changedVoidReplay.json()).toMatchObject({
      success: false,
      error: { code: 'IDEMPOTENCY_CONFLICT' },
    });
    expect(
      await db
        .prepare(
          'SELECT state,loss_reason_id,void_reason_code,version FROM renewal_opportunities WHERE id=?',
        )
        .bind('terminal-void-renewal')
        .first(),
    ).toEqual({
      state: 'VOIDED',
      loss_reason_id: null,
      void_reason_code: 'TECHNICAL_ERROR',
      version: 2,
    });
    expect(
      await db
        .prepare('SELECT status,version FROM tasks WHERE id=?')
        .bind('terminal-void-primary-task')
        .first(),
    ).toEqual({ status: 'COMPLETED', version: 2 });
    expect(
      await db
        .prepare('SELECT to_state,reason_code FROM renewal_state_history WHERE renewal_id=?')
        .bind('terminal-void-renewal')
        .all(),
    ).toMatchObject({
      success: true,
      results: expect.arrayContaining([
        { to_state: 'CONTACT_PENDING', reason_code: 'POLICY_EXPIRING' },
        { to_state: 'VOIDED', reason_code: 'TECHNICAL_ERROR' },
      ]),
    });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM audit_events WHERE idempotency_key='terminal-close-void-key' AND action='renewal.voided'",
        )
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });

  it('reopens VOIDED records without deleting their original history or closed Task', async () => {
    const payload = {
      expectedRenewalVersion: 2,
      expectedTaskVersion: 2,
      replacementDueAt: '2026-09-26T06:00:00.000Z',
      reopenReasonCode: 'TECHNICAL_RECORD_CORRECTED',
    };
    const request = (body = payload) =>
      terminalApp().request(
        'https://panel.mayisigorta.com/api/renewals/terminal-void-renewal/reopen',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://panel.mayisigorta.com',
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'terminal-reopen-void-key',
          },
          body: JSON.stringify(body),
        },
        env,
      );
    const response = await request();
    expect(response.status).toBe(200);
    const envelope = (await response.json()) as {
      success: boolean;
      replayed: boolean;
      data: { previousState: string; state: string; closedTaskId: string; primaryTaskId: string };
    };
    expect(envelope).toMatchObject({
      success: true,
      replayed: false,
      data: {
        previousState: 'VOIDED',
        state: 'CONTACT_PENDING',
        closedTaskId: 'terminal-void-primary-task',
      },
    });
    const replay = await request();
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      replayed: true,
      data: { primaryTaskId: envelope.data.primaryTaskId },
    });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM tasks WHERE renewal_id='terminal-void-renewal' AND status='OPEN'",
        )
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
    expect(
      await db
        .prepare('SELECT count(*) AS count FROM renewal_state_history WHERE renewal_id=?')
        .bind('terminal-void-renewal')
        .first<{ count: number }>(),
    ).toEqual({ count: 3 });
    expect(
      await db
        .prepare('SELECT status,version FROM tasks WHERE id=?')
        .bind('terminal-void-primary-task')
        .first(),
    ).toEqual({ status: 'COMPLETED', version: 2 });
  });

  it('rechecks direct and dependency permission scopes inside the terminal D1 batch', async () => {
    await db
      .prepare(
        `INSERT INTO membership_permissions(id,membership_id,permission_code,scope)
         VALUES('terminal-member-renewal-close-lost','terminal-member-membership','renewal.close_lost','AGENCY')`,
      )
      .run();
    const payload = {
      expectedPrimaryTaskId: 'terminal-scope-primary-task',
      expectedRenewalVersion: 1,
      expectedTaskVersion: 1,
      lossReasonId: 'terminal-loss-price',
      lossReasonNotes: null,
    };
    const attempt = (permissionCode: string, scope: 'ASSIGNED' | 'AGENCY', key: string) =>
      closeRenewalLost(
        memberActor,
        changeGrantScopeBeforeMutationBatch(db, permissionCode, scope),
        'terminal-scope-renewal',
        payload,
        key,
      );
    try {
      await expect(
        attempt('task.update', 'ASSIGNED', 'terminal-scope-stale-task-grant'),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
      await db
        .prepare(
          `UPDATE membership_permissions SET scope='AGENCY'
           WHERE membership_id='terminal-member-membership' AND permission_code='task.update'`,
        )
        .run();
      await expect(
        attempt('renewal.read', 'ASSIGNED', 'terminal-scope-narrow-dependency'),
      ).rejects.toMatchObject({ code: 'FORBIDDEN', status: 403 });
    } finally {
      await db.batch([
        db.prepare(
          `UPDATE membership_permissions SET scope='AGENCY'
             WHERE membership_id='terminal-member-membership' AND permission_code IN ('task.update','renewal.read')`,
        ),
        db.prepare(
          `DELETE FROM membership_permissions
             WHERE id='terminal-member-renewal-close-lost' AND membership_id='terminal-member-membership'`,
        ),
      ]);
    }
    expect(
      await db
        .prepare('SELECT state,version FROM renewal_opportunities WHERE id=?')
        .bind('terminal-scope-renewal')
        .first(),
    ).toEqual({ state: 'CONTACT_PENDING', version: 1 });
    expect(
      await db
        .prepare('SELECT status,version FROM tasks WHERE id=?')
        .bind('terminal-scope-primary-task')
        .first(),
    ).toEqual({ status: 'OPEN', version: 1 });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM operation_receipts WHERE idempotency_key LIKE 'terminal-scope-%'",
        )
        .first<{ count: number }>(),
    ).toEqual({ count: 0 });
  });

  it('allows only one competing LOST/VOIDED terminal command to commit', async () => {
    const lostPayload = {
      expectedPrimaryTaskId: 'terminal-cross-race-primary-task',
      expectedRenewalVersion: 1,
      expectedTaskVersion: 1,
      lossReasonId: 'terminal-loss-price',
      lossReasonNotes: null,
    };
    const voidPayload = {
      expectedPrimaryTaskId: 'terminal-cross-race-primary-task',
      expectedRenewalVersion: 1,
      expectedTaskVersion: 1,
      voidReasonCode: 'DUPLICATE' as const,
    };
    const outcomes = await Promise.allSettled([
      closeRenewalLost(
        actor,
        db,
        'terminal-cross-race-renewal',
        lostPayload,
        'terminal-cross-race-lost-key',
      ),
      voidRenewal(
        actor,
        db,
        'terminal-cross-race-renewal',
        voidPayload,
        'terminal-cross-race-void-key',
      ),
    ]);
    const succeeded = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const failed = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(succeeded).toHaveLength(1);
    expect(failed).toHaveLength(1);
    expect(failed[0]?.reason).toMatchObject({ status: 409 });
    const winner = succeeded[0];
    if (!winner || winner.status !== 'fulfilled') throw new Error('TERMINAL_RACE_WINNER_MISSING');
    expect(['LOST', 'VOIDED']).toContain(winner.value.data.state);
    expect(
      await db
        .prepare(
          "SELECT state,version FROM renewal_opportunities WHERE id='terminal-cross-race-renewal'",
        )
        .first(),
    ).toMatchObject({ state: winner.value.data.state, version: 2 });
    expect(
      await db
        .prepare("SELECT status,version FROM tasks WHERE id='terminal-cross-race-primary-task'")
        .first(),
    ).toEqual({ status: 'COMPLETED', version: 2 });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM renewal_state_history WHERE renewal_id='terminal-cross-race-renewal' AND to_state IN ('LOST','VOIDED')",
        )
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM operation_receipts WHERE idempotency_key IN ('terminal-cross-race-lost-key','terminal-cross-race-void-key')",
        )
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM audit_events WHERE target_id='terminal-cross-race-renewal' AND action IN ('renewal.closed_lost','renewal.voided') AND outcome='SUCCESS'",
        )
        .first<{ count: number }>(),
    ).toEqual({ count: 1 });
  });

  it('denies an exact LOST replay after the current identity is revoked', async () => {
    await db
      .prepare(
        `UPDATE auth_identities SET status='REVOKED',revoked_at='2099-01-01T00:00:00.000Z',
           version=version+1,updated_at='2099-01-01T00:00:00.000Z' WHERE id='terminal-identity'`,
      )
      .run();
    try {
      const replay = await terminalApp().request(
        'https://panel.mayisigorta.com/api/renewals/terminal-renewal/close-lost',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://panel.mayisigorta.com',
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'terminal-close-lost-key',
          },
          body: JSON.stringify({
            expectedPrimaryTaskId: 'terminal-primary-task',
            expectedRenewalVersion: 1,
            expectedTaskVersion: 1,
            lossReasonId: 'terminal-loss-other',
            lossReasonNotes: 'Renewal no longer needed',
          }),
        },
        env,
      );
      expect(replay.status).toBe(404);
      expect(await replay.json()).toMatchObject({
        success: false,
        error: { code: 'REPLAY_NOT_AUTHORIZED' },
      });
      expect(
        await db
          .prepare('SELECT state,version FROM renewal_opportunities WHERE id=?')
          .bind('terminal-renewal')
          .first(),
      ).toEqual({ state: 'CONTACT_PENDING', version: 4 });
      expect(
        await db
          .prepare(
            "SELECT count(*) AS count FROM audit_events WHERE action='renewal.closed_lost' AND target_id='terminal-renewal'",
          )
          .first<{ count: number }>(),
      ).toEqual({ count: 1 });
    } finally {
      await db
        .prepare(
          `UPDATE auth_identities SET status='ACTIVE',revoked_at=NULL,version=version+1,
            updated_at='2100-01-01T00:00:00.000Z' WHERE id='terminal-identity'`,
        )
        .run();
    }
  });

  it('closes WON by creating and linking one new Policy in the same idempotent command', async () => {
    await db.batch([
      db.prepare(
        `INSERT INTO policies
           (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
            assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
            gross_premium_minor,currency)
         VALUES('won-create-old-policy','terminal-agency','terminal-customer','terminal-insurer',
           'terminal-product','terminal-branch','terminal-payment','terminal-membership',
           'WON-OLD-001','WONOLD001','2025-10-25','2026-10-24',10000,'TRY')`,
      ),
      db.prepare(
        `INSERT INTO renewal_opportunities
           (id,agency_id,expiring_policy_id,assignee_membership_id,state,version,created_at,updated_at)
         VALUES('won-create-renewal','terminal-agency','won-create-old-policy','terminal-won-membership',
           'CONTACT_PENDING',1,'2026-09-24T06:00:00.000Z','2026-09-24T06:00:00.000Z')`,
      ),
      db.prepare(
        `INSERT INTO renewal_state_history
           (id,agency_id,renewal_id,from_state,to_state,actor_kind,reason_code,created_at)
         VALUES('won-create-initial-history','terminal-agency','won-create-renewal',NULL,
           'CONTACT_PENDING','SYSTEM','POLICY_EXPIRING','2026-09-24T06:00:00.000Z')`,
      ),
      db.prepare(
        `INSERT INTO tasks
           (id,agency_id,customer_id,renewal_id,kind,title,due_at,assignee_membership_id,
            status,actor_kind,version,created_at,updated_at)
         VALUES('won-create-primary-task','terminal-agency','terminal-customer','won-create-renewal',
           'RENEWAL_FOLLOWUP','WON follow-up','2026-09-24T06:00:00.000Z','terminal-won-membership',
           'OPEN','SYSTEM',1,'2026-09-24T06:00:00.000Z','2026-09-24T06:00:00.000Z')`,
      ),
    ]);
    const payload = {
      expectedPrimaryTaskId: 'won-create-primary-task',
      expectedRenewalVersion: 1,
      expectedTaskVersion: 1,
      result: {
        kind: 'CREATE_POLICY',
        policy: {
          customerId: 'terminal-customer',
          insurerId: 'terminal-insurer',
          productId: 'terminal-product',
          branchId: 'terminal-branch',
          paymentMethodId: 'terminal-payment',
          policyNumber: 'WON-NEW-001',
          startDate: '2026-10-25',
          endDate: '2027-10-24',
          grossPremium: '125.00',
          currency: 'TRY',
          installmentCount: null,
          status: 'ACTIVE',
        },
      },
    };
    const wonApp = terminalApp(wonActor, wonPrincipal);
    const wonCsrfResponse = await wonApp.request(
      'https://panel.mayisigorta.com/api/csrf-token',
      {},
      env,
    );
    const wonCsrf = ((await wonCsrfResponse.json()) as { data: { token: string } }).data.token;
    const close = () =>
      wonApp.request(
        'https://panel.mayisigorta.com/api/renewals/won-create-renewal/close-won',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://panel.mayisigorta.com',
            'X-CSRF-Token': wonCsrf,
            'Idempotency-Key': 'won-create-operation-key',
          },
          body: JSON.stringify(payload),
        },
        env,
      );

    await db
      .prepare(
        `CREATE TRIGGER fail_won_close_audit BEFORE INSERT ON audit_events
         WHEN NEW.action='renewal.closed_won' AND NEW.idempotency_key='won-create-operation-key'
         BEGIN SELECT RAISE(ABORT,'INJECTED_WON_AUDIT_FAILURE'); END`,
      )
      .run();
    const failed = await close();
    expect(failed.status).toBe(500);
    await db.prepare('DROP TRIGGER fail_won_close_audit').run();
    expect(
      await db
        .prepare(
          `SELECT r.state,r.version,t.status AS task_status,t.version AS task_version,
                  (SELECT count(*) FROM policies WHERE policy_number='WON-NEW-001') AS created_policy_count,
                  (SELECT count(*) FROM renewal_policy_links WHERE renewal_id=r.id) AS link_count,
                  (SELECT count(*) FROM operation_receipts WHERE action='renewal.close_won'
                    AND idempotency_key='won-create-operation-key') AS receipt_count,
                  (SELECT count(*) FROM renewal_state_history WHERE renewal_id=r.id AND to_state='WON') AS won_history_count,
                  (SELECT count(*) FROM audit_events WHERE target_id=r.id AND action='renewal.closed_won') AS won_audit_count
           FROM renewal_opportunities r JOIN tasks t ON t.renewal_id=r.id
           WHERE r.id='won-create-renewal' AND t.id='won-create-primary-task'`,
        )
        .first(),
    ).toEqual({
      state: 'CONTACT_PENDING',
      version: 1,
      task_status: 'OPEN',
      task_version: 1,
      created_policy_count: 0,
      link_count: 0,
      receipt_count: 0,
      won_history_count: 0,
      won_audit_count: 0,
    });
    const first = await close();
    expect(first.status, await first.clone().text()).toBe(201);
    const firstBody = (await first.json()) as {
      data: { renewalId: string; createdPolicyId: string | null; linkIds: string[]; state: string };
      replayed: boolean;
    };
    expect(firstBody.replayed).toBe(false);
    expect(firstBody.data).toMatchObject({ renewalId: 'won-create-renewal', state: 'WON' });
    expect(firstBody.data.linkIds).toHaveLength(1);
    const replay = await close();
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toMatchObject({ data: firstBody.data, replayed: true });
    expect(
      await db
        .prepare(
          "SELECT id,gross_premium_minor,currency FROM policies WHERE policy_number='WON-NEW-001'",
        )
        .all(),
    ).toMatchObject({
      results: [
        { id: firstBody.data.createdPolicyId, gross_premium_minor: 12500, currency: 'TRY' },
      ],
    });
    expect(
      await db
        .prepare(
          `SELECT r.state,r.version AS renewal_version,t.status,t.version AS task_version,
                  l.allocated_new_premium_minor
           FROM renewal_opportunities r
           JOIN tasks t ON t.renewal_id=r.id AND t.id='won-create-primary-task'
           JOIN renewal_policy_links l ON l.renewal_id=r.id AND l.new_policy_id=? AND l.status='ACTIVE'
           WHERE r.id='won-create-renewal'`,
        )
        .bind(firstBody.data.createdPolicyId)
        .first(),
    ).toEqual({
      state: 'WON',
      renewal_version: 2,
      status: 'COMPLETED',
      task_version: 2,
      allocated_new_premium_minor: 12500,
    });
    expect(
      await db
        .prepare(
          `SELECT (SELECT count(*) FROM audit_events WHERE target_id=? AND action='policy.create') AS policy_audits,
                  (SELECT count(*) FROM audit_events WHERE target_id='won-create-renewal' AND action='renewal.closed_won') AS won_audits,
                  (SELECT count(*) FROM renewal_state_history WHERE renewal_id='won-create-renewal' AND to_state='WON') AS won_history`,
        )
        .bind(firstBody.data.createdPolicyId)
        .first(),
    ).toEqual({ policy_audits: 1, won_audits: 1, won_history: 1 });
  });

  it('allows only one of two concurrent single-WON commands to create a result', async () => {
    const now = '2026-09-24T06:00:00.000Z';
    await db.batch([
      db.prepare(
        `INSERT INTO policies
           (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
            assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
            gross_premium_minor,currency)
         VALUES('won-only-race-old','terminal-agency','terminal-customer','terminal-insurer',
           'terminal-product','terminal-branch','terminal-payment','terminal-membership',
           'WON-ONLY-RACE-OLD','WONONLYRACEOLD','2025-10-25','2026-10-24',10000,'TRY')`,
      ),
      db
        .prepare(
          `INSERT INTO renewal_opportunities
           (id,agency_id,expiring_policy_id,assignee_membership_id,state,version,created_at,updated_at)
           VALUES('won-only-race-renewal','terminal-agency','won-only-race-old',
             'terminal-won-membership','CONTACT_PENDING',1,?,?)`,
        )
        .bind(now, now),
      db
        .prepare(
          `INSERT INTO renewal_state_history
           (id,agency_id,renewal_id,from_state,to_state,actor_kind,reason_code,created_at)
           VALUES('won-only-race-initial-history','terminal-agency','won-only-race-renewal',NULL,
             'CONTACT_PENDING','SYSTEM','POLICY_EXPIRING',?)`,
        )
        .bind(now),
      db
        .prepare(
          `INSERT INTO tasks
           (id,agency_id,customer_id,renewal_id,kind,title,due_at,assignee_membership_id,
            status,actor_kind,version,created_at,updated_at)
           VALUES('won-only-race-task','terminal-agency','terminal-customer','won-only-race-renewal',
             'RENEWAL_FOLLOWUP','Two WON race','2026-09-24T06:00:00.000Z',
             'terminal-won-membership','OPEN','SYSTEM',1,?,?)`,
        )
        .bind(now, now),
    ]);

    let arrivals = 0;
    let release!: () => void;
    const bothBatchesReady = new Promise<void>((resolveBatches) => {
      release = resolveBatches;
    });
    const raceDatabase = new Proxy(db, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            arrivals += 1;
            if (arrivals === 2) release();
            await bothBatchesReady;
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as D1Database;
    const app = terminalApp(wonActor, wonPrincipal);
    const csrfResponse = await app.request('https://panel.mayisigorta.com/api/csrf-token', {}, env);
    const csrf = ((await csrfResponse.json()) as { data: { token: string } }).data.token;
    const policyInput = (policyNumber: string) => ({
      customerId: 'terminal-customer',
      insurerId: 'terminal-insurer',
      productId: 'terminal-product',
      branchId: 'terminal-branch',
      paymentMethodId: 'terminal-payment',
      policyNumber,
      startDate: '2026-10-25',
      endDate: '2027-10-24',
      grossPremium: '100.00',
      currency: 'TRY',
      installmentCount: null,
      status: 'ACTIVE',
    });
    const close = (key: string, policyNumber: string) =>
      app.request(
        'https://panel.mayisigorta.com/api/renewals/won-only-race-renewal/close-won',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://panel.mayisigorta.com',
            'X-CSRF-Token': csrf,
            'Idempotency-Key': key,
          },
          body: JSON.stringify({
            expectedPrimaryTaskId: 'won-only-race-task',
            expectedRenewalVersion: 1,
            expectedTaskVersion: 1,
            result: { kind: 'CREATE_POLICY', policy: policyInput(policyNumber) },
          }),
        },
        { ...env, DB: raceDatabase },
      );
    const responses = await Promise.all([
      close('won-only-race-key-a', 'WON-ONLY-RACE-CREATED-A'),
      close('won-only-race-key-b', 'WON-ONLY-RACE-CREATED-B'),
    ]);
    expect(arrivals).toBe(2);
    expect(
      responses.map((response) => response.status).sort(),
      (await Promise.all(responses.map((response) => response.clone().text()))).join('\n'),
    ).toEqual([201, 409]);
    const winningResponse = responses.find((response) => response.status === 201)!;
    const winningBody = (await winningResponse.json()) as {
      data: { createdPolicyId: string | null; state: string };
      replayed: boolean;
    };
    expect(winningBody.replayed).toBe(false);
    expect(winningBody.data).toMatchObject({ state: 'WON' });
    expect(winningBody.data.createdPolicyId).not.toBeNull();
    expect(
      await db
        .prepare(
          `SELECT r.state,r.version,t.status AS task_status,t.version AS task_version,
             (SELECT count(*) FROM policies WHERE policy_number IN
               ('WON-ONLY-RACE-CREATED-A','WON-ONLY-RACE-CREATED-B')) AS new_policies,
             (SELECT count(*) FROM renewal_policy_links WHERE renewal_id=r.id AND status='ACTIVE') AS active_links,
             (SELECT count(*) FROM operation_receipts WHERE idempotency_key IN
               ('won-only-race-key-a','won-only-race-key-b') AND action='renewal.close_won') AS receipts,
             (SELECT count(*) FROM audit_events WHERE idempotency_key IN
               ('won-only-race-key-a','won-only-race-key-b') AND action='policy.create' AND outcome='SUCCESS') AS policy_audits,
             (SELECT count(*) FROM audit_events WHERE idempotency_key IN
               ('won-only-race-key-a','won-only-race-key-b') AND action='renewal.closed_won' AND outcome='SUCCESS') AS won_audits,
             (SELECT count(*) FROM renewal_state_history WHERE renewal_id=r.id AND to_state='WON') AS won_history
           FROM renewal_opportunities r JOIN tasks t ON t.renewal_id=r.id
           WHERE r.id='won-only-race-renewal'`,
        )
        .first(),
    ).toEqual({
      state: 'WON',
      version: 2,
      task_status: 'COMPLETED',
      task_version: 2,
      new_policies: 1,
      active_links: 1,
      receipts: 1,
      policy_audits: 1,
      won_audits: 1,
      won_history: 1,
    });
    const committedLink = await db
      .prepare(
        "SELECT new_policy_id FROM renewal_policy_links WHERE renewal_id='won-only-race-renewal' AND status='ACTIVE'",
      )
      .first<{ new_policy_id: string }>();
    expect(committedLink?.new_policy_id).toBe(winningBody.data.createdPolicyId);
  });

  it('allows only one terminal winner across concurrent WON and LOST commands', async () => {
    await db.batch([
      db.prepare(
        `INSERT INTO policies
           (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
            assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
            gross_premium_minor,currency)
         VALUES('won-race-old-policy','terminal-agency','terminal-customer','terminal-insurer',
           'terminal-product','terminal-branch','terminal-payment','terminal-membership',
           'WON-RACE-OLD','WONRACEOLD','2025-10-25','2026-10-24',10000,'TRY')`,
      ),
      db.prepare(
        `INSERT INTO renewal_opportunities
           (id,agency_id,expiring_policy_id,assignee_membership_id,state,version,created_at,updated_at)
         VALUES('won-race-renewal','terminal-agency','won-race-old-policy','terminal-won-membership',
           'CONTACT_PENDING',1,'2026-09-24T06:00:00.000Z','2026-09-24T06:00:00.000Z')`,
      ),
      db.prepare(
        `INSERT INTO renewal_state_history
           (id,agency_id,renewal_id,from_state,to_state,actor_kind,reason_code,created_at)
         VALUES('won-race-initial-history','terminal-agency','won-race-renewal',NULL,
           'CONTACT_PENDING','SYSTEM','POLICY_EXPIRING','2026-09-24T06:00:00.000Z')`,
      ),
      db.prepare(
        `INSERT INTO tasks
           (id,agency_id,customer_id,renewal_id,kind,title,due_at,assignee_membership_id,
            status,actor_kind,version,created_at,updated_at)
         VALUES('won-race-primary-task','terminal-agency','terminal-customer','won-race-renewal',
           'RENEWAL_FOLLOWUP','WON race follow-up','2026-09-24T06:00:00.000Z','terminal-won-membership',
           'OPEN','SYSTEM',1,'2026-09-24T06:00:00.000Z','2026-09-24T06:00:00.000Z')`,
      ),
    ]);
    const wonApp = terminalApp(wonActor, wonPrincipal);
    const csrfResponse = await wonApp.request(
      'https://panel.mayisigorta.com/api/csrf-token',
      {},
      env,
    );
    const wonCsrf = ((await csrfResponse.json()) as { data: { token: string } }).data.token;
    const policy = {
      customerId: 'terminal-customer',
      insurerId: 'terminal-insurer',
      productId: 'terminal-product',
      branchId: 'terminal-branch',
      paymentMethodId: 'terminal-payment',
      policyNumber: 'WON-RACE-NEW',
      startDate: '2026-10-25',
      endDate: '2027-10-24',
      grossPremium: '95.00',
      currency: 'TRY',
      installmentCount: null,
      status: 'ACTIVE',
    };
    const post = (path: string, key: string, body: unknown) =>
      wonApp.request(
        `https://panel.mayisigorta.com${path}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://panel.mayisigorta.com',
            'X-CSRF-Token': wonCsrf,
            'Idempotency-Key': key,
          },
          body: JSON.stringify(body),
        },
        env,
      );
    const payload = {
      expectedPrimaryTaskId: 'won-race-primary-task',
      expectedRenewalVersion: 1,
      expectedTaskVersion: 1,
      result: { kind: 'CREATE_POLICY', policy },
    };
    const responses = await Promise.all([
      post('/api/renewals/won-race-renewal/close-won', 'won-race-key-a', payload),
      post('/api/renewals/won-race-renewal/close-won', 'won-race-key-b', payload),
      post('/api/renewals/won-race-renewal/close-lost', 'won-race-lost-key', {
        expectedPrimaryTaskId: 'won-race-primary-task',
        expectedRenewalVersion: 1,
        expectedTaskVersion: 1,
        lossReasonId: 'terminal-loss-price',
        lossReasonNotes: null,
      }),
    ]);
    const statuses = responses.map((response) => response.status).sort((a, b) => a - b);
    expect(statuses.filter((status) => status === 200 || status === 201)).toHaveLength(1);
    expect(statuses.filter((status) => status === 409)).toHaveLength(2);
    const stored = await db
      .prepare(
        `SELECT r.state,r.version,t.status AS task_status,t.version AS task_version,
                (SELECT count(*) FROM renewal_state_history h WHERE h.renewal_id=r.id
                  AND h.to_state IN ('WON','LOST')) AS terminal_history_count,
                (SELECT count(*) FROM audit_events a WHERE a.target_id=r.id
                  AND a.action IN ('renewal.closed_won','renewal.closed_lost')
                  AND a.outcome='SUCCESS') AS terminal_audit_count,
                (SELECT count(*) FROM policies p WHERE p.policy_number='WON-RACE-NEW') AS new_policy_count,
                (SELECT count(*) FROM renewal_policy_links l WHERE l.renewal_id=r.id
                  AND l.status='ACTIVE') AS active_link_count
         FROM renewal_opportunities r JOIN tasks t ON t.renewal_id=r.id
         WHERE r.id='won-race-renewal'`,
      )
      .first();
    expect(stored).toMatchObject({
      version: 2,
      task_status: 'COMPLETED',
      task_version: 2,
      terminal_history_count: 1,
      terminal_audit_count: 1,
    });
    expect(['WON', 'LOST']).toContain((stored as { state: string }).state);
    if ((stored as { state: string }).state === 'WON') {
      expect(stored).toMatchObject({ new_policy_count: 1, active_link_count: 1 });
    } else {
      expect(stored).toMatchObject({ new_policy_count: 0, active_link_count: 0 });
    }
  });

  it('closes an allocated split as WON without replacing its existing link evidence', async () => {
    await db.batch([
      db.prepare(
        `INSERT INTO policies
           (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
            assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
            gross_premium_minor,currency)
         VALUES('won-split-old-policy','terminal-agency','terminal-customer','terminal-insurer',
           'terminal-product','terminal-branch','terminal-payment','terminal-membership',
           'WON-SPLIT-OLD','WONSPLITOLD','2025-10-25','2026-10-24',10000,'TRY'),
               ('won-split-new-a','terminal-agency','terminal-customer','terminal-insurer',
           'terminal-product','terminal-branch','terminal-payment','terminal-membership',
           'WON-SPLIT-A','WONSPLITA','2026-10-25','2027-04-24',6000,'TRY'),
               ('won-split-new-b','terminal-agency','terminal-customer','terminal-insurer',
           'terminal-product','terminal-branch','terminal-payment','terminal-membership',
           'WON-SPLIT-B','WONSPLITB','2026-10-25','2027-10-24',4000,'TRY')`,
      ),
      db.prepare(
        `INSERT INTO renewal_opportunities
           (id,agency_id,expiring_policy_id,assignee_membership_id,state,version,created_at,updated_at)
         VALUES('won-split-renewal','terminal-agency','won-split-old-policy','terminal-won-membership',
           'CONTACT_PENDING',2,'2026-09-24T06:00:00.000Z','2026-09-24T06:00:00.000Z')`,
      ),
      db.prepare(
        `INSERT INTO renewal_state_history
           (id,agency_id,renewal_id,from_state,to_state,actor_kind,reason_code,created_at)
         VALUES('won-split-initial-history','terminal-agency','won-split-renewal',NULL,
           'CONTACT_PENDING','SYSTEM','POLICY_EXPIRING','2026-09-24T06:00:00.000Z')`,
      ),
      db.prepare(
        `INSERT INTO tasks
           (id,agency_id,customer_id,renewal_id,kind,title,due_at,assignee_membership_id,
            status,actor_kind,version,created_at,updated_at)
         VALUES('won-split-primary-task','terminal-agency','terminal-customer','won-split-renewal',
           'RENEWAL_FOLLOWUP','WON split follow-up','2026-09-24T06:00:00.000Z','terminal-won-membership',
           'OPEN','SYSTEM',2,'2026-09-24T06:00:00.000Z','2026-09-24T06:00:00.000Z')`,
      ),
      db.prepare(
        `INSERT INTO operation_receipts
           (id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,
            payload_fingerprint,status,response_status,response_body,created_at,updated_at)
         VALUES('won-split-allocation','terminal-agency','terminal-won-user','terminal-won-membership',
           'renewal.policy_links.allocate','won-split-allocation-key','${'a'.repeat(64)}',
           'COMPLETED',201,'{}','2026-09-24T06:00:00.000Z','2026-09-24T06:00:00.000Z')`,
      ),
      db.prepare(
        `INSERT INTO renewal_policy_links
           (id,agency_id,renewal_id,new_policy_id,allocated_new_premium_minor,currency,
            allocation_operation_id,created_by_membership_id)
         VALUES('won-split-link-a','terminal-agency','won-split-renewal','won-split-new-a',6000,
           'TRY','won-split-allocation','terminal-won-membership'),
               ('won-split-link-b','terminal-agency','won-split-renewal','won-split-new-b',4000,
           'TRY','won-split-allocation','terminal-won-membership')`,
      ),
    ]);
    const wonApp = terminalApp(wonActor, wonPrincipal);
    const csrfResponse = await wonApp.request(
      'https://panel.mayisigorta.com/api/csrf-token',
      {},
      env,
    );
    const wonCsrf = ((await csrfResponse.json()) as { data: { token: string } }).data.token;
    const payload = {
      expectedPrimaryTaskId: 'won-split-primary-task',
      expectedRenewalVersion: 2,
      expectedTaskVersion: 2,
      result: { kind: 'EXISTING_LINKS' },
    };
    const request = () =>
      wonApp.request(
        'https://panel.mayisigorta.com/api/renewals/won-split-renewal/close-won',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://panel.mayisigorta.com',
            'X-CSRF-Token': wonCsrf,
            'Idempotency-Key': 'won-split-close-key',
          },
          body: JSON.stringify(payload),
        },
        env,
      );
    const closed = await request();
    expect(closed.status, await closed.clone().text()).toBe(200);
    const result = (await closed.json()) as {
      data: { linkIds: string[]; createdPolicyId: string | null };
      replayed: boolean;
    };
    expect(result.replayed).toBe(false);
    expect(result.data.createdPolicyId).toBeNull();
    expect(result.data.linkIds).toEqual(['won-split-link-a', 'won-split-link-b']);
    const replay = await request();
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toMatchObject({ data: result.data, replayed: true });
    const preservedLinks = await db
      .prepare(
        `SELECT id,allocation_operation_id,allocated_new_premium_minor
         FROM renewal_policy_links WHERE renewal_id=? ORDER BY id`,
      )
      .bind('won-split-renewal')
      .all<{ id: string; allocation_operation_id: string; allocated_new_premium_minor: number }>();
    expect(preservedLinks.results).toEqual([
      {
        id: 'won-split-link-a',
        allocation_operation_id: 'won-split-allocation',
        allocated_new_premium_minor: 6000,
      },
      {
        id: 'won-split-link-b',
        allocation_operation_id: 'won-split-allocation',
        allocated_new_premium_minor: 4000,
      },
    ]);
    expect(
      await db
        .prepare(
          `SELECT r.state,r.version,t.status AS task_status,
                  (SELECT count(*) FROM renewal_policy_links l WHERE l.renewal_id=r.id
                    AND l.status='ACTIVE') AS active_links
           FROM renewal_opportunities r JOIN tasks t ON t.renewal_id=r.id
           WHERE r.id='won-split-renewal' AND t.id='won-split-primary-task'`,
        )
        .first(),
    ).toEqual({ state: 'WON', version: 3, task_status: 'COMPLETED', active_links: 2 });
  });

  it('links an already-created same-customer Policy in the atomic WON command', async () => {
    await db.batch([
      db.prepare(
        `INSERT INTO policies
           (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
            assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
            gross_premium_minor,currency)
         VALUES('won-link-old-policy','terminal-agency','terminal-customer','terminal-insurer',
           'terminal-product','terminal-branch','terminal-payment','terminal-membership',
           'WON-LINK-OLD','WONLINKOLD','2025-10-25','2026-10-24',10000,'TRY'),
               ('won-link-new-policy','terminal-agency','terminal-customer','terminal-insurer',
           'terminal-product','terminal-branch','terminal-payment','terminal-membership',
           'WON-LINK-NEW','WONLINKNEW','2026-10-25','2027-10-24',10000,'TRY')`,
      ),
      db.prepare(
        `INSERT INTO renewal_opportunities
           (id,agency_id,expiring_policy_id,assignee_membership_id,state,version,created_at,updated_at)
         VALUES('won-link-renewal','terminal-agency','won-link-old-policy','terminal-won-membership',
           'CONTACT_PENDING',1,'2026-09-24T06:00:00.000Z','2026-09-24T06:00:00.000Z')`,
      ),
      db.prepare(
        `INSERT INTO renewal_state_history
           (id,agency_id,renewal_id,from_state,to_state,actor_kind,reason_code,created_at)
         VALUES('won-link-initial-history','terminal-agency','won-link-renewal',NULL,
           'CONTACT_PENDING','SYSTEM','POLICY_EXPIRING','2026-09-24T06:00:00.000Z')`,
      ),
      db.prepare(
        `INSERT INTO tasks
           (id,agency_id,customer_id,renewal_id,kind,title,due_at,assignee_membership_id,
            status,actor_kind,version,created_at,updated_at)
         VALUES('won-link-primary-task','terminal-agency','terminal-customer','won-link-renewal',
           'RENEWAL_FOLLOWUP','WON policy link follow-up','2026-09-24T06:00:00.000Z',
           'terminal-won-membership','OPEN','SYSTEM',1,'2026-09-24T06:00:00.000Z','2026-09-24T06:00:00.000Z')`,
      ),
    ]);
    const wonApp = terminalApp(wonActor, wonPrincipal);
    const csrfResponse = await wonApp.request(
      'https://panel.mayisigorta.com/api/csrf-token',
      {},
      env,
    );
    const wonCsrf = ((await csrfResponse.json()) as { data: { token: string } }).data.token;
    const payload = {
      expectedPrimaryTaskId: 'won-link-primary-task',
      expectedRenewalVersion: 1,
      expectedTaskVersion: 1,
      result: {
        kind: 'LINK_POLICY',
        newPolicyId: 'won-link-new-policy',
        expectedPolicyVersion: 1,
        allocatedNewPremiumMinor: 10000,
        currency: 'TRY',
      },
    };
    const close = () =>
      wonApp.request(
        'https://panel.mayisigorta.com/api/renewals/won-link-renewal/close-won',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://panel.mayisigorta.com',
            'X-CSRF-Token': wonCsrf,
            'Idempotency-Key': 'won-link-operation-key',
          },
          body: JSON.stringify(payload),
        },
        env,
      );
    const first = await close();
    expect(first.status, await first.clone().text()).toBe(200);
    const firstBody = (await first.json()) as {
      data: { createdPolicyId: string | null; links: Array<{ id: string; newPolicyId: string }> };
      replayed: boolean;
    };
    expect(firstBody.replayed).toBe(false);
    expect(firstBody.data.createdPolicyId).toBeNull();
    expect(firstBody.data.links).toEqual([
      expect.objectContaining({ newPolicyId: 'won-link-new-policy' }),
    ]);
    const replay = await close();
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toMatchObject({ data: firstBody.data, replayed: true });
    expect(
      await db
        .prepare(
          `SELECT count(*) AS count FROM renewal_policy_links
           WHERE renewal_id='won-link-renewal' AND new_policy_id='won-link-new-policy' AND status='ACTIVE'`,
        )
        .first(),
    ).toEqual({ count: 1 });

    const secureOwner: AuthenticatedUserContext = {
      ...actor,
      identityId: 'terminal-identity-backup',
      assurance: 'SECURE',
    };
    const correctionPrincipal = { subject: 'terminal-subject-backup' } as AuthenticatedPrincipal;
    const correctionApp = terminalApp(secureOwner, correctionPrincipal);
    const correctionCsrfResponse = await correctionApp.request(
      'https://panel.mayisigorta.com/api/csrf-token',
      {},
      env,
    );
    const correctionCsrf = ((await correctionCsrfResponse.json()) as { data: { token: string } })
      .data.token;
    const correctionInput = {
      expectedRenewalVersion: 2,
      expectedTaskVersion: 2,
      replacementDueAt: '2026-09-25T06:00:00.000Z',
      correctionReasonCode: 'WON_RESULT_CORRECTION',
    };
    const correctionGrant = await correctionApp.request(
      'https://panel.mayisigorta.com/secure/api/renewals/won-link-renewal/won-correction-grants',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': correctionCsrf,
          'Idempotency-Key': 'won-correction-grant-key',
        },
        body: JSON.stringify(correctionInput),
      },
      env,
    );
    expect(correctionGrant.status, await correctionGrant.clone().text()).toBe(201);
    const correctionGrantBody = (await correctionGrant.json()) as {
      data: { grantId: string; grantEvidenceToken: string };
    };
    const exactCorrectionGrantRetry = await correctionApp.request(
      'https://panel.mayisigorta.com/secure/api/renewals/won-link-renewal/won-correction-grants',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': correctionCsrf,
          'Idempotency-Key': 'won-correction-grant-key',
        },
        body: JSON.stringify(correctionInput),
      },
      env,
    );
    expect(exactCorrectionGrantRetry.status).toBe(200);
    expect(await exactCorrectionGrantRetry.json()).toMatchObject({
      data: correctionGrantBody.data,
      replayed: true,
    });
    const changedCorrectionGrant = await correctionApp.request(
      'https://panel.mayisigorta.com/secure/api/renewals/won-link-renewal/won-correction-grants',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': correctionCsrf,
          'Idempotency-Key': 'won-correction-grant-key',
        },
        body: JSON.stringify({ ...correctionInput, correctionReasonCode: 'CHANGED_REASON' }),
      },
      env,
    );
    expect(changedCorrectionGrant.status).toBe(409);
    const correctionPayload = {
      ...correctionInput,
      grantEvidenceToken: correctionGrantBody.data.grantEvidenceToken,
    };
    const correct = (database: D1Database = db) =>
      correctionApp.request(
        'https://panel.mayisigorta.com/secure/api/renewals/won-link-renewal/correct-won',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://panel.mayisigorta.com',
            'X-CSRF-Token': correctionCsrf,
            'Idempotency-Key': 'won-correction-operation-key',
          },
          body: JSON.stringify(correctionPayload),
        },
        { ...env, DB: database },
      );
    const auditFailureDatabase = new Proxy(db, {
      get(target, property) {
        if (property === 'batch') {
          return (statements: D1PreparedStatement[]) =>
            target.batch([
              ...statements,
              target.prepare(
                `INSERT INTO audit_events
                   (id,agency_id,actor_user_id,actor_membership_id,action,target_type,target_id,
                    correlation_id,idempotency_key,outcome,metadata_json,created_at)
                   VALUES('won-correction-forced-audit-failure','terminal-agency','terminal-user',
                     'terminal-membership','renewal.won.corrected','renewal_opportunities',
                     'won-link-renewal','forced-failure','forced-failure','INVALID','{}',
                     '2026-09-24T06:00:00.000Z')`,
              ),
            ]);
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as D1Database;
    const failedCorrection = await correct(auditFailureDatabase);
    expect(failedCorrection.status).toBe(500);
    expect(
      await db
        .prepare(
          `SELECT r.state,r.version,
                  (SELECT status FROM sensitive_action_grants WHERE id=?) AS grant_status,
                  (SELECT count(*) FROM operation_receipts WHERE action='renewal.won.correct'
                    AND idempotency_key='won-correction-operation-key') AS receipts,
                  (SELECT count(*) FROM renewal_policy_links WHERE renewal_id=r.id
                    AND status='ACTIVE') AS active_links,
                  (SELECT count(*) FROM tasks WHERE renewal_id=r.id AND status='OPEN') AS open_tasks,
                  (SELECT count(*) FROM renewal_state_history WHERE renewal_id=r.id
                    AND reason_code='WON_CORRECTED') AS correction_history,
                  (SELECT count(*) FROM audit_events WHERE target_id=r.id
                    AND action='renewal.won.corrected') AS correction_audits
           FROM renewal_opportunities r WHERE r.id='won-link-renewal'`,
        )
        .bind(correctionGrantBody.data.grantId)
        .first(),
    ).toEqual({
      state: 'WON',
      version: 2,
      grant_status: 'ISSUED',
      receipts: 0,
      active_links: 1,
      open_tasks: 0,
      correction_history: 0,
      correction_audits: 0,
    });
    const corrected = await correct();
    expect(corrected.status, await corrected.clone().text()).toBe(200);
    const correctedBody = (await corrected.json()) as {
      data: { primaryTaskId: string; supersededLinkIds: string[] };
      replayed: boolean;
    };
    expect(correctedBody.replayed).toBe(false);
    expect(correctedBody.data.supersededLinkIds).toHaveLength(1);
    const correctionReplay = await correct();
    expect(correctionReplay.status).toBe(200);
    expect(await correctionReplay.json()).toMatchObject({
      data: correctedBody.data,
      replayed: true,
    });
    expect(
      await db
        .prepare(
          `SELECT r.state,r.version,r.closed_at,
                  old_task.status AS old_task_status,new_task.status AS new_task_status,
                  (SELECT count(*) FROM renewal_policy_links WHERE renewal_id=r.id
                    AND status='SUPERSEDED') AS superseded_links,
                  (SELECT count(*) FROM renewal_policy_links WHERE renewal_id=r.id
                    AND status='ACTIVE') AS active_links
           FROM renewal_opportunities r
           JOIN tasks old_task ON old_task.id='won-link-primary-task'
           JOIN tasks new_task ON new_task.id=?
           WHERE r.id='won-link-renewal'`,
        )
        .bind(correctedBody.data.primaryTaskId)
        .first(),
    ).toEqual({
      state: 'CONTACT_PENDING',
      version: 3,
      closed_at: null,
      old_task_status: 'COMPLETED',
      new_task_status: 'OPEN',
      superseded_links: 1,
      active_links: 0,
    });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM policies WHERE id IN ('won-link-old-policy','won-link-new-policy')",
        )
        .first(),
    ).toEqual({ count: 2 });
    expect(
      await db
        .prepare(
          `SELECT
             (SELECT count(*) FROM audit_events WHERE action='renewal.closed_won'
               AND target_id='won-link-renewal') AS won_audits,
             (SELECT count(*) FROM audit_events WHERE action='renewal.won.corrected'
               AND target_id='won-link-renewal') AS correction_audits,
             (SELECT count(*) FROM renewal_state_history WHERE renewal_id='won-link-renewal'
               AND from_state='WON' AND to_state='CONTACT_PENDING' AND reason_code='WON_CORRECTED')
               AS correction_history`,
        )
        .first(),
    ).toEqual({ won_audits: 1, correction_audits: 1, correction_history: 1 });
    const originalWonReplayAfterCorrection = await close();
    expect(
      originalWonReplayAfterCorrection.status,
      await originalWonReplayAfterCorrection.clone().text(),
    ).toBe(200);
    expect(await originalWonReplayAfterCorrection.json()).toMatchObject({
      data: firstBody.data,
      replayed: true,
    });
    await db
      .prepare(
        `UPDATE policies SET status='CANCELLED',version=version+1 WHERE id='won-link-new-policy'`,
      )
      .run();
    const originalWonReplayAfterPolicyCancellation = await close();
    expect(
      originalWonReplayAfterPolicyCancellation.status,
      await originalWonReplayAfterPolicyCancellation.clone().text(),
    ).toBe(200);
    expect(await originalWonReplayAfterPolicyCancellation.json()).toMatchObject({
      data: firstBody.data,
      replayed: true,
    });
  });

  it('records distinct interaction outcomes and binds both Individual and Company WON to the sent QuoteVersion', async () => {
    await db.batch([
      db.prepare(
        `INSERT INTO membership_permissions(id,membership_id,permission_code,scope)
           VALUES('terminal-won-quote-read','terminal-won-membership','quote.read','AGENCY'),
                 ('terminal-won-quote-manage','terminal-won-membership','quote.manage','AGENCY'),
                 ('terminal-won-interaction-read','terminal-won-membership','interaction.read','AGENCY'),
                 ('terminal-won-interaction-create','terminal-won-membership','interaction.create','AGENCY')`,
      ),
      db.prepare(
        `INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,company_title,assignee_membership_id)
           VALUES('terminal-company-customer','terminal-agency','COMPANY','Terminal Company',NULL,NULL,
             'Terminal Company','terminal-membership')`,
      ),
      db.prepare(
        `INSERT INTO company_contacts(id,agency_id,customer_id,first_name,last_name,role,is_primary,status,version)
           VALUES('terminal-company-contact','terminal-agency','terminal-company-customer','Ada','Contact',
             'Fleet Manager',1,'ACTIVE',1)`,
      ),
      db.prepare(
        `INSERT INTO policies
           (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
            assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
            gross_premium_minor,currency)
           VALUES('terminal-company-old-policy','terminal-agency','terminal-company-customer',
             'terminal-insurer','terminal-product','terminal-branch','terminal-payment','terminal-membership',
             'M3-COMPANY-OLD','M3COMPANYOLD','2025-10-25','2026-10-24',10000,'TRY')`,
      ),
      db.prepare(
        `INSERT INTO renewal_opportunities
           (id,agency_id,expiring_policy_id,assignee_membership_id,state,version,created_at,updated_at)
           VALUES('terminal-company-renewal','terminal-agency','terminal-company-old-policy',
             'terminal-membership','CONTACT_PENDING',1,'2026-09-24T06:00:00.000Z','2026-09-24T06:00:00.000Z')`,
      ),
      db.prepare(
        `INSERT INTO renewal_state_history
           (id,agency_id,renewal_id,from_state,to_state,actor_kind,reason_code,created_at)
           VALUES('terminal-company-initial-history','terminal-agency','terminal-company-renewal',NULL,
             'CONTACT_PENDING','SYSTEM','POLICY_EXPIRING','2026-09-24T06:00:00.000Z')`,
      ),
      db.prepare(
        `INSERT INTO tasks
           (id,agency_id,customer_id,renewal_id,kind,title,due_at,assignee_membership_id,
            status,actor_kind,version,created_at,updated_at)
           VALUES('terminal-company-primary-task','terminal-agency','terminal-company-customer',
             'terminal-company-renewal','RENEWAL_FOLLOWUP','Company renewal follow-up',
             '2026-09-24T06:00:00.000Z','terminal-membership','OPEN','SYSTEM',1,
             '2026-09-24T06:00:00.000Z','2026-09-24T06:00:00.000Z')`,
      ),
    ]);
    const app = terminalApp(wonActor, wonPrincipal);
    const csrfResponse = await app.request('https://panel.mayisigorta.com/api/csrf-token', {}, env);
    const wonCsrf = ((await csrfResponse.json()) as { data: { token: string } }).data.token;
    const request = (path: string, key: string, body?: unknown) =>
      app.request(
        `https://panel.mayisigorta.com${path}`,
        {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
            ...(body === undefined ? {} : { Origin: 'https://panel.mayisigorta.com' }),
            ...(body === undefined ? {} : { 'X-CSRF-Token': wonCsrf }),
            ...(body === undefined ? {} : { 'Idempotency-Key': key }),
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        },
        env,
      );

    const runFlow = async (input: {
      renewalId: string;
      customerId: string;
      policyNumber: string;
      contactId: string | null;
      prefix: string;
      resultProductId: string;
      resultGrossPremium: string;
      quoteDifferenceReasonCode?: string;
    }) => {
      const confirmedAt = '2026-09-24T07:00:00.000Z';
      const attemptAt = '2026-09-24T08:00:00.000Z';
      const createdAt = '2026-09-24T06:00:00.000Z';
      const oldPolicyId = `${input.prefix}-source-policy`;
      const primaryTaskId = `${input.prefix}-primary-task`;
      const normalizedPolicyNumber = input.policyNumber.toUpperCase().replace(/[^A-Z0-9]/g, '');
      await db.batch([
        db
          .prepare(
            `INSERT INTO policies
             (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
              assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
              gross_premium_minor,currency,version)
             VALUES(?,'terminal-agency',?,'terminal-insurer','terminal-product','terminal-branch',
               'terminal-payment','terminal-membership',?,?, '2025-10-25','2026-10-24',10000,'TRY',1)`,
          )
          .bind(
            oldPolicyId,
            input.customerId,
            `${input.policyNumber}-OLD`,
            `${normalizedPolicyNumber}OLD`,
          ),
        db
          .prepare(
            `INSERT INTO renewal_opportunities
             (id,agency_id,expiring_policy_id,assignee_membership_id,state,version,created_at,updated_at)
             VALUES(?,'terminal-agency',?,'terminal-won-membership','CONTACT_PENDING',1,?,?)`,
          )
          .bind(input.renewalId, oldPolicyId, createdAt, createdAt),
        db
          .prepare(
            `INSERT INTO renewal_state_history
             (id,agency_id,renewal_id,from_state,to_state,actor_kind,reason_code,created_at)
             VALUES(?,'terminal-agency',?,NULL,'CONTACT_PENDING','SYSTEM','POLICY_EXPIRING',?)`,
          )
          .bind(`${input.prefix}-initial-history`, input.renewalId, createdAt),
        db
          .prepare(
            `INSERT INTO tasks
             (id,agency_id,customer_id,renewal_id,kind,title,due_at,assignee_membership_id,
              status,actor_kind,created_by_user_id,created_by_membership_id,version,created_at,updated_at)
             VALUES(?,'terminal-agency',?,?,'RENEWAL_FOLLOWUP','Quote and interaction flow',?,
               'terminal-won-membership','OPEN','USER','terminal-won-user','terminal-won-membership',1,?,?)`,
          )
          .bind(primaryTaskId, input.customerId, input.renewalId, createdAt, createdAt, createdAt),
      ]);
      const confirmed = await request(
        `/api/renewals/${input.renewalId}/interactions`,
        `${input.prefix}-confirmed-key`,
        {
          outcome: 'CONTACT_CONFIRMED',
          channel: 'PHONE',
          occurredAt: confirmedAt,
          companyContactId: input.contactId,
          note: null,
        },
      );
      expect(confirmed.status, await confirmed.clone().text()).toBe(201);
      const replayedContact = await request(
        `/api/renewals/${input.renewalId}/interactions`,
        `${input.prefix}-confirmed-key`,
        {
          outcome: 'CONTACT_CONFIRMED',
          channel: 'PHONE',
          occurredAt: confirmedAt,
          companyContactId: input.contactId,
          note: null,
        },
      );
      expect(replayedContact.status).toBe(200);
      expect(await replayedContact.json()).toMatchObject({ replayed: true });
      const attempt = await request(
        `/api/renewals/${input.renewalId}/interactions`,
        `${input.prefix}-attempt-key`,
        {
          outcome: 'ATTEMPT_NO_RESPONSE',
          channel: 'PHONE',
          occurredAt: attemptAt,
          companyContactId: input.contactId,
          note: null,
        },
      );
      expect(attempt.status, await attempt.clone().text()).toBe(201);
      const invalidBlendedContact = await request(
        `/api/renewals/${input.renewalId}/interactions`,
        `${input.prefix}-attempt-payload-conflict`,
        {
          outcome: 'ATTEMPT_NO_RESPONSE',
          channel: 'PHONE',
          occurredAt: attemptAt,
          companyContactId: input.contactId,
          note: 'This must not be counted as contact',
        },
      );
      expect(invalidBlendedContact.status).toBe(400);

      const versionPayload = {
        insurerId: 'terminal-insurer',
        productId: 'terminal-product',
        branchId: 'terminal-branch',
        paymentMethodId: 'terminal-payment',
        startDate: '2026-10-25',
        endDate: '2027-10-24',
        // SQLite's real clock is independent of the historical JS test clock.
        validUntil: '2099-09-30T00:00:00.000Z',
        grossPremiumMinor: 10000,
        currency: 'TRY',
        installmentCount: null,
        termsSummary: null,
      };
      const createdQuote = await request(
        `/api/renewals/${input.renewalId}/quotes`,
        `${input.prefix}-quote-create`,
        {
          expectedRenewalVersion: 1,
          version: versionPayload,
        },
      );
      expect(createdQuote.status, await createdQuote.clone().text()).toBe(201);
      const quoteResult = (await createdQuote.json()) as {
        data: { quoteId: string; quoteVersionId: string; versionNumber: number };
      };
      expect(quoteResult.data.versionNumber).toBe(1);
      const sentFirstVersion = await request(
        `/api/renewals/${input.renewalId}/quotes/${quoteResult.data.quoteId}/send`,
        `${input.prefix}-quote-send-v1`,
        { expectedQuoteVersion: 1, quoteVersionId: quoteResult.data.quoteVersionId },
      );
      expect(sentFirstVersion.status, await sentFirstVersion.clone().text()).toBe(201);
      const secondVersion = await request(
        `/api/renewals/${input.renewalId}/quotes/${quoteResult.data.quoteId}/versions`,
        `${input.prefix}-quote-version-v2`,
        {
          expectedQuoteVersion: 2,
          version: { ...versionPayload, termsSummary: 'Revised synthetic offer' },
        },
      );
      expect(secondVersion.status, await secondVersion.clone().text()).toBe(201);
      const secondVersionResult = (await secondVersion.json()) as {
        data: { quoteVersionId: string; versionNumber: number; status: string };
      };
      expect(secondVersionResult.data).toMatchObject({ versionNumber: 2, status: 'DRAFT' });
      const sentSecondVersion = await request(
        `/api/renewals/${input.renewalId}/quotes/${quoteResult.data.quoteId}/send`,
        `${input.prefix}-quote-send-v2`,
        { expectedQuoteVersion: 3, quoteVersionId: secondVersionResult.data.quoteVersionId },
      );
      expect(sentSecondVersion.status, await sentSecondVersion.clone().text()).toBe(201);

      const interactionsResponse = await request(
        `/api/renewals/${input.renewalId}/interactions`,
        'unused',
      );
      expect(interactionsResponse.status, await interactionsResponse.clone().text()).toBe(200);
      const interactionsBody = (await interactionsResponse.json()) as {
        data: {
          interactions: Array<{ outcome: string }>;
          lastContactAt: string | null;
          lastAttemptAt: string | null;
        };
      };
      expect(interactionsBody.data.interactions.map((item) => item.outcome)).toEqual([
        'CONTACT_CONFIRMED',
        'ATTEMPT_NO_RESPONSE',
      ]);
      expect(interactionsBody.data.lastContactAt).toBe(confirmedAt);
      expect(interactionsBody.data.lastAttemptAt).toBe(attemptAt);

      const wonKey = `${input.prefix}-won-key`;
      const wonPayload = {
        expectedPrimaryTaskId: primaryTaskId,
        expectedRenewalVersion: 1,
        expectedTaskVersion: 1,
        acceptedQuoteVersionId: secondVersionResult.data.quoteVersionId,
        result: {
          kind: 'CREATE_POLICY' as const,
          policy: {
            customerId: input.customerId,
            insurerId: 'terminal-insurer',
            productId: input.resultProductId,
            branchId: 'terminal-branch',
            paymentMethodId: 'terminal-payment',
            policyNumber: input.policyNumber,
            startDate: '2026-10-25',
            endDate: '2027-10-24',
            grossPremium: input.resultGrossPremium,
            currency: 'TRY',
            installmentCount: null,
            status: 'ACTIVE',
          },
        },
      };
      const wonRequestPayload = {
        ...wonPayload,
        ...(input.quoteDifferenceReasonCode
          ? { quoteDifferenceReasonCode: input.quoteDifferenceReasonCode }
          : {}),
      };
      if (input.quoteDifferenceReasonCode) {
        const missingDifferenceReason = await request(
          `/api/renewals/${input.renewalId}/close-won`,
          wonKey,
          wonPayload,
        );
        expect(missingDifferenceReason.status, await missingDifferenceReason.clone().text()).toBe(
          400,
        );
        expect(await missingDifferenceReason.json()).toMatchObject({
          error: { code: 'QUOTE_DIFFERENCE_REASON_REQUIRED' },
        });
        expect(
          await db
            .prepare('SELECT count(*) AS count FROM policies WHERE policy_number=?')
            .bind(input.policyNumber)
            .first(),
        ).toEqual({ count: 0 });
        expect(
          await db
            .prepare('SELECT count(*) AS count FROM operation_receipts WHERE idempotency_key=?')
            .bind(wonKey)
            .first(),
        ).toEqual({ count: 0 });
      }
      const won = await request(
        `/api/renewals/${input.renewalId}/close-won`,
        wonKey,
        wonRequestPayload,
      );
      expect(won.status, await won.clone().text()).toBe(201);
      const wonBody = (await won.json()) as {
        data: {
          acceptedQuoteVersionId: string;
          acceptedPolicyId: string;
          createdPolicyId: string;
        };
      };
      expect(wonBody.data).toMatchObject({
        acceptedQuoteVersionId: secondVersionResult.data.quoteVersionId,
        acceptedPolicyId: expect.any(String),
        createdPolicyId: expect.any(String),
      });
      expect(wonBody.data.acceptedPolicyId).toBe(wonBody.data.createdPolicyId);
      expect(
        await db
          .prepare(
            `SELECT json_extract(metadata_json,'$.quoteDifferenceReasonCode') AS quote_difference_reason
             FROM audit_events WHERE idempotency_key=? AND action='renewal.closed_won'`,
          )
          .bind(wonKey)
          .first(),
      ).toEqual({ quote_difference_reason: input.quoteDifferenceReasonCode ?? null });
      const replay = await request(
        `/api/renewals/${input.renewalId}/close-won`,
        wonKey,
        wonRequestPayload,
      );
      expect(replay.status, await replay.clone().text()).toBe(200);
      const evidence = await db
        .prepare(
          `SELECT q.status,q.accepted_version_id,q.accepted_policy_id,
             (SELECT count(*) FROM renewal_quote_versions v WHERE v.quote_id=q.id) AS versions,
             (SELECT count(*) FROM renewal_quote_events e WHERE e.quote_id=q.id AND e.event='SENT') AS sent_events,
             (SELECT count(*) FROM renewal_quote_events e WHERE e.quote_id=q.id AND e.event='ACCEPTED'
               AND e.quote_version_id=q.accepted_version_id AND e.accepted_policy_id=q.accepted_policy_id) AS accepted_events
           FROM renewal_quotes q WHERE q.id=?`,
        )
        .bind(quoteResult.data.quoteId)
        .first();
      expect(evidence).toEqual({
        status: 'ACCEPTED',
        accepted_version_id: secondVersionResult.data.quoteVersionId,
        accepted_policy_id: wonBody.data.createdPolicyId,
        versions: 2,
        sent_events: 2,
        accepted_events: 1,
      });
      return interactionsBody.data;
    };

    const individual = await runFlow({
      renewalId: 'm3-individual-renewal',
      customerId: 'terminal-customer',
      policyNumber: 'M3-INDIVIDUAL-NEW',
      contactId: null,
      prefix: 'm3-individual',
      resultProductId: 'terminal-product',
      resultGrossPremium: '100.00',
    });
    expect(individual.lastContactAt).toBe('2026-09-24T07:00:00.000Z');
    expect(individual.lastAttemptAt).toBe('2026-09-24T08:00:00.000Z');
    const company = await runFlow({
      renewalId: 'm3-company-renewal',
      customerId: 'terminal-company-customer',
      policyNumber: 'M3-COMPANY-NEW',
      contactId: 'terminal-company-contact',
      prefix: 'm3-company',
      resultProductId: 'terminal-product-alt',
      resultGrossPremium: '110.00',
      quoteDifferenceReasonCode: 'CUSTOMER_REQUEST',
    });
    expect(company.lastContactAt).toBe('2026-09-24T07:00:00.000Z');
    expect(company.lastAttemptAt).toBe('2026-09-24T08:00:00.000Z');

    expect(
      await db
        .prepare(
          `SELECT count(*) AS count FROM renewal_interactions
           WHERE renewal_id='m3-company-renewal' AND company_contact_id='terminal-company-contact'`,
        )
        .first(),
    ).toEqual({ count: 2 });

    const memberWorkspaceApp = terminalApp(memberActor, memberPrincipal);
    await db.batch([
      db.prepare(
        `INSERT INTO membership_permissions(id,membership_id,permission_code,scope)
         VALUES('terminal-member-quote-read','terminal-member-membership','quote.read','AGENCY'),
               ('terminal-member-interaction-read','terminal-member-membership','interaction.read','AGENCY')`,
      ),
    ]);
    const quotesUrl = 'https://panel.mayisigorta.com/api/renewals/m3-individual-renewal/quotes';
    const interactionsUrl =
      'https://panel.mayisigorta.com/api/renewals/m3-individual-renewal/interactions';
    const parentReadPermissions = [
      ['terminal-member-renewal-read', 'renewal.read'],
      ['terminal-member-policy-read', 'policy.read'],
      ['terminal-member-customer-read', 'customer.read'],
    ] as const;
    try {
      expect((await memberWorkspaceApp.request(quotesUrl, {}, env)).status).toBe(200);
      expect((await memberWorkspaceApp.request(interactionsUrl, {}, env)).status).toBe(200);
      for (const [permissionId, permissionCode] of parentReadPermissions) {
        await db.prepare('DELETE FROM membership_permissions WHERE id=?').bind(permissionId).run();
        const quotes = await memberWorkspaceApp.request(quotesUrl, {}, env);
        const interactions = await memberWorkspaceApp.request(interactionsUrl, {}, env);
        expect(quotes.status, await quotes.clone().text()).toBe(403);
        expect(interactions.status, await interactions.clone().text()).toBe(403);
        await db
          .prepare(
            `INSERT INTO membership_permissions(id,membership_id,permission_code,scope)
             VALUES(?, 'terminal-member-membership', ?, 'AGENCY')`,
          )
          .bind(permissionId, permissionCode)
          .run();
      }
    } finally {
      await db.batch([
        db.prepare(
          `DELETE FROM membership_permissions WHERE membership_id='terminal-member-membership'
           AND permission_code IN ('quote.read','interaction.read','renewal.read','policy.read','customer.read')`,
        ),
        db.prepare(
          `INSERT INTO membership_permissions(id,membership_id,permission_code,scope)
           VALUES('terminal-member-quote-read','terminal-member-membership','quote.read','AGENCY'),
                 ('terminal-member-interaction-read','terminal-member-membership','interaction.read','AGENCY'),
                 ('terminal-member-renewal-read','terminal-member-membership','renewal.read','AGENCY'),
                 ('terminal-member-policy-read','terminal-member-membership','policy.read','AGENCY'),
                 ('terminal-member-customer-read','terminal-member-membership','customer.read','AGENCY')`,
        ),
      ]);
    }
  });

  it('allows OWNER implicit normal permissions across interaction and SENT QuoteVersion writes', async () => {
    const now = '2026-09-24T06:00:00.000Z';
    expect(
      await db
        .prepare(
          `SELECT count(*) AS count FROM membership_permissions
           WHERE membership_id='terminal-membership'
             AND permission_code IN ('quote.read','quote.manage','interaction.read','interaction.create')`,
        )
        .first(),
    ).toEqual({ count: 0 });
    await db.batch([
      db.prepare(
        `INSERT INTO policies
         (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
          assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
          gross_premium_minor,currency,version)
         VALUES('owner-implicit-source-policy','terminal-agency','terminal-customer','terminal-insurer',
          'terminal-product','terminal-branch','terminal-payment','terminal-membership',
          'OWNER-IMPLICIT-SOURCE','OWNERIMPLICITSOURCE','2025-10-25','2026-10-24',10000,'TRY',1)`,
      ),
      db
        .prepare(
          `INSERT INTO renewal_opportunities
         (id,agency_id,expiring_policy_id,assignee_membership_id,state,version,created_at,updated_at)
         VALUES('owner-implicit-engagement-renewal','terminal-agency','owner-implicit-source-policy',
          'terminal-membership','CONTACT_PENDING',1,?,?)`,
        )
        .bind(now, now),
      db
        .prepare(
          `INSERT INTO renewal_state_history
         (id,agency_id,renewal_id,from_state,to_state,actor_kind,actor_user_id,
          actor_membership_id,created_at,reason_code)
         VALUES('owner-implicit-history','terminal-agency','owner-implicit-engagement-renewal',
          NULL,'CONTACT_PENDING','SYSTEM',NULL,NULL,?,'RENEWAL_CREATED')`,
        )
        .bind(now),
      db
        .prepare(
          `INSERT INTO tasks
         (id,agency_id,customer_id,renewal_id,kind,title,due_at,assignee_membership_id,
          status,actor_kind,version,created_at,updated_at)
         VALUES('owner-implicit-task','terminal-agency','terminal-customer',
          'owner-implicit-engagement-renewal','RENEWAL_FOLLOWUP','Owner quote renewal',?,
          'terminal-membership','OPEN','SYSTEM',1,?,?)`,
        )
        .bind(now, now, now),
    ]);
    const ownerApp = terminalApp();
    const csrfResponse = await ownerApp.request(
      'https://panel.mayisigorta.com/api/csrf-token',
      {},
      env,
    );
    const csrfToken = ((await csrfResponse.json()) as { data: { token: string } }).data.token;
    const post = (path: string, key: string, body: unknown) =>
      ownerApp.request(
        `https://panel.mayisigorta.com${path}`,
        {
          method: 'POST',
          headers: {
            Origin: 'https://panel.mayisigorta.com',
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
            'Idempotency-Key': key,
          },
          body: JSON.stringify(body),
        },
        env,
      );
    const interaction = await post(
      '/api/renewals/owner-implicit-engagement-renewal/interactions',
      'owner-implicit-interaction-key',
      {
        outcome: 'CONTACT_CONFIRMED',
        channel: 'PHONE',
        occurredAt: now,
        companyContactId: null,
        note: null,
      },
    );
    expect(interaction.status, await interaction.clone().text()).toBe(201);
    const quote = await post(
      '/api/renewals/owner-implicit-engagement-renewal/quotes',
      'owner-implicit-quote-key',
      {
        expectedRenewalVersion: 1,
        version: {
          insurerId: 'terminal-insurer',
          productId: 'terminal-product',
          branchId: 'terminal-branch',
          paymentMethodId: 'terminal-payment',
          startDate: '2026-10-25',
          endDate: '2027-10-24',
          validUntil: '2099-09-30T00:00:00.000Z',
          grossPremiumMinor: 10000,
          currency: 'TRY',
          installmentCount: null,
          termsSummary: null,
        },
      },
    );
    expect(quote.status, await quote.clone().text()).toBe(201);
    const quoteData = (await quote.json()) as {
      data: { quoteId: string; quoteVersionId: string };
    };
    const sent = await post(
      `/api/renewals/owner-implicit-engagement-renewal/quotes/${quoteData.data.quoteId}/send`,
      'owner-implicit-quote-send-key',
      { expectedQuoteVersion: 1, quoteVersionId: quoteData.data.quoteVersionId },
    );
    expect(sent.status, await sent.clone().text()).toBe(201);
    const won = await closeRenewalWon(
      actor,
      db,
      'owner-implicit-engagement-renewal',
      {
        expectedPrimaryTaskId: 'owner-implicit-task',
        expectedRenewalVersion: 1,
        expectedTaskVersion: 1,
        acceptedQuoteVersionId: quoteData.data.quoteVersionId,
        result: {
          kind: 'CREATE_POLICY',
          policy: {
            policyNumber: 'OWNER-IMPLICIT-NEW',
            customerId: 'terminal-customer',
            insurerId: 'terminal-insurer',
            productId: 'terminal-product',
            branchId: 'terminal-branch',
            paymentMethodId: 'terminal-payment',
            startDate: '2026-10-25',
            endDate: '2027-10-24',
            grossPremium: '100.00',
            currency: 'TRY',
            installmentCount: null,
            status: 'ACTIVE',
          },
        },
      },
      'owner-implicit-won-key',
    );
    expect(won.status).toBe(201);
  });

  it('uses canonical sensitive health permissions for Health Renewal engagement', async () => {
    const now = '2026-09-25T13:00:00.000Z';
    await db.batch([
      db.prepare(
        `INSERT INTO insurance_branches(id,agency_id,code,name,data_classification)
         VALUES('owner-health-branch','terminal-agency','OWNER_HEALTH','Owner Health','HEALTH')`,
      ),
      db.prepare(
        `INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name)
         VALUES('owner-health-product','terminal-agency','terminal-insurer','owner-health-branch',
          'OWNER_HEALTH','Owner Health')`,
      ),
      db.prepare(
        `INSERT INTO policies
         (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
          assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
          gross_premium_minor,currency,version)
         VALUES('owner-health-source-policy','terminal-agency','terminal-customer','terminal-insurer',
          'owner-health-product','owner-health-branch','terminal-payment','terminal-membership',
          'OWNER-HEALTH-SOURCE','OWNERHEALTHSOURCE','2025-10-25','2026-10-24',10000,'TRY',1)`,
      ),
      db
        .prepare(
          `INSERT INTO renewal_opportunities
         (id,agency_id,expiring_policy_id,assignee_membership_id,state,version,created_at,updated_at)
         VALUES('owner-health-renewal','terminal-agency','owner-health-source-policy',
          'terminal-membership','CONTACT_PENDING',1,?,?)`,
        )
        .bind(now, now),
      db
        .prepare(
          `INSERT INTO renewal_state_history
         (id,agency_id,renewal_id,from_state,to_state,actor_kind,actor_user_id,
          actor_membership_id,created_at,reason_code)
         VALUES('owner-health-history','terminal-agency','owner-health-renewal',
          NULL,'CONTACT_PENDING','SYSTEM',NULL,NULL,?,'RENEWAL_CREATED')`,
        )
        .bind(now),
    ]);
    const ownerApp = terminalApp();
    const csrfResponse = await ownerApp.request(
      'https://panel.mayisigorta.com/api/csrf-token',
      {},
      env,
    );
    const csrfToken = ((await csrfResponse.json()) as { data: { token: string } }).data.token;
    const post = (path: string, key: string, body: unknown) =>
      ownerApp.request(
        `https://panel.mayisigorta.com${path}`,
        {
          method: 'POST',
          headers: {
            Origin: 'https://panel.mayisigorta.com',
            'Content-Type': 'application/json',
            'X-CSRF-Token': csrfToken,
            'Idempotency-Key': key,
          },
          body: JSON.stringify(body),
        },
        env,
      );
    const interactionInput = {
      outcome: 'CONTACT_CONFIRMED',
      channel: 'PHONE',
      occurredAt: now,
      companyContactId: null,
      note: null,
    };
    const deniedInteraction = await post(
      '/api/renewals/owner-health-renewal/interactions',
      'owner-health-denied-interaction-key',
      interactionInput,
    );
    expect(deniedInteraction.status).toBe(403);
    try {
      await db.batch([
        db.prepare(
          `INSERT INTO membership_permissions(id,membership_id,permission_code,scope)
           VALUES('owner-health-sensitive-read','terminal-membership','sensitive.health.read','UNSCOPED'),
                 ('owner-health-sensitive-write','terminal-membership','sensitive.health.write','UNSCOPED')`,
        ),
      ]);
      const interaction = await post(
        '/api/renewals/owner-health-renewal/interactions',
        'owner-health-interaction-key',
        interactionInput,
      );
      expect(interaction.status, await interaction.clone().text()).toBe(201);
      const quote = await post(
        '/api/renewals/owner-health-renewal/quotes',
        'owner-health-quote-key',
        {
          expectedRenewalVersion: 1,
          version: {
            insurerId: 'terminal-insurer',
            productId: 'owner-health-product',
            branchId: 'owner-health-branch',
            paymentMethodId: 'terminal-payment',
            startDate: '2026-10-25',
            endDate: '2027-10-24',
            validUntil: '2026-09-30T00:00:00.000Z',
            grossPremiumMinor: 10000,
            currency: 'TRY',
            installmentCount: null,
            termsSummary: null,
          },
        },
      );
      expect(quote.status, await quote.clone().text()).toBe(201);
    } finally {
      await db
        .prepare(
          `DELETE FROM membership_permissions WHERE id IN
           ('owner-health-sensitive-read','owner-health-sensitive-write')`,
        )
        .run();
    }
  });

  it('closes a split/merge Renewal group atomically with replay and adversarial rollback', async () => {
    const now = '2026-09-24T06:00:00.000Z';
    await db.batch([
      db.prepare(
        `INSERT INTO policies
           (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
            assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
            gross_premium_minor,currency,version)
         VALUES('won-group-old-policy-a','terminal-agency','terminal-customer','terminal-insurer',
           'terminal-product','terminal-branch','terminal-payment','terminal-membership',
           'WON-GROUP-OLD-A','WONGROUPOA','2025-10-25','2026-10-24',10000,'TRY',1),
              ('won-group-old-policy-b','terminal-agency','terminal-customer','terminal-insurer',
           'terminal-product','terminal-branch','terminal-payment','terminal-membership',
           'WON-GROUP-OLD-B','WONGROUPB','2025-10-25','2026-10-24',12000,'TRY',1),
              ('won-group-new-policy','terminal-agency','terminal-customer','terminal-insurer',
           'terminal-product','terminal-branch','terminal-payment','terminal-membership',
           'WON-GROUP-NEW','WONGROUPNEW','2026-10-25','2027-10-24',10000,'TRY',1)`,
      ),
      db
        .prepare(
          `INSERT INTO renewal_opportunities
           (id,agency_id,expiring_policy_id,assignee_membership_id,state,version,created_at,updated_at)
         VALUES('won-group-renewal-a','terminal-agency','won-group-old-policy-a',
           'terminal-won-membership','CONTACT_PENDING',1,?,?),
              ('won-group-renewal-b','terminal-agency','won-group-old-policy-b',
           'terminal-won-membership','CONTACT_PENDING',1,?,?)`,
        )
        .bind(now, now, now, now),
      db
        .prepare(
          `INSERT INTO renewal_state_history
           (id,agency_id,renewal_id,from_state,to_state,actor_kind,reason_code,created_at)
         VALUES('won-group-history-a','terminal-agency','won-group-renewal-a',NULL,
           'CONTACT_PENDING','SYSTEM','POLICY_EXPIRING',?),
              ('won-group-history-b','terminal-agency','won-group-renewal-b',NULL,
           'CONTACT_PENDING','SYSTEM','POLICY_EXPIRING',?)`,
        )
        .bind(now, now),
      db
        .prepare(
          `INSERT INTO tasks
           (id,agency_id,customer_id,renewal_id,kind,title,due_at,assignee_membership_id,
            status,actor_kind,created_by_user_id,created_by_membership_id,version,created_at,updated_at)
         VALUES('won-group-task-a','terminal-agency','terminal-customer','won-group-renewal-a',
           'RENEWAL_FOLLOWUP','Group WON A',?, 'terminal-won-membership','OPEN','USER',
           'terminal-won-user','terminal-won-membership',1,?,?),
              ('won-group-task-b','terminal-agency','terminal-customer','won-group-renewal-b',
           'RENEWAL_FOLLOWUP','Group WON B',?, 'terminal-won-membership','OPEN','USER',
           'terminal-won-user','terminal-won-membership',1,?,?)`,
        )
        .bind(now, now, now, now, now, now),
    ]);

    const groupActor: AuthenticatedUserContext = {
      ...wonActor,
      assurance: 'SECURE',
    };
    const groupPrincipal = wonPrincipal;
    const groupApp = terminalApp(groupActor, groupPrincipal);
    const csrfResponse = await groupApp.request(
      'https://panel.mayisigorta.com/api/csrf-token',
      {},
      env,
    );
    const groupCsrf = ((await csrfResponse.json()) as { data: { token: string } }).data.token;
    const groupInput = {
      reasonCode: 'GROUP_ALLOCATION',
      renewals: [
        { renewalId: 'won-group-renewal-b', expectedRenewalVersion: 1, expectedTaskVersion: 1 },
        { renewalId: 'won-group-renewal-a', expectedRenewalVersion: 1, expectedTaskVersion: 1 },
      ],
      links: [
        {
          renewalId: 'won-group-renewal-b',
          newPolicyId: 'won-group-new-policy',
          expectedPolicyVersion: 1,
          allocatedNewPremiumMinor: 5000,
          currency: 'TRY',
        },
        {
          renewalId: 'won-group-renewal-a',
          newPolicyId: 'won-group-new-policy',
          expectedPolicyVersion: 1,
          allocatedNewPremiumMinor: 5000,
          currency: 'TRY',
        },
      ],
    };
    const issueGroupGrant = (key: string, database: D1Database = db, payload = groupInput) =>
      groupApp.request(
        'https://panel.mayisigorta.com/secure/api/renewals/won-group/grants',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://panel.mayisigorta.com',
            'X-CSRF-Token': groupCsrf,
            'Idempotency-Key': key,
          },
          body: JSON.stringify(payload),
        },
        { ...env, DB: database },
      );
    const overflowGrant = await issueGroupGrant('won-group-overflow-grant-key', db, {
      ...groupInput,
      links: groupInput.links.map((link, index) => ({
        ...link,
        allocatedNewPremiumMinor: link.allocatedNewPremiumMinor + (index === 0 ? 1 : 0),
      })),
    });
    expect(overflowGrant.status).toBe(409);
    const stalePolicyGrant = await issueGroupGrant('won-group-stale-policy-grant-key', db, {
      ...groupInput,
      links: groupInput.links.map((link) => ({
        ...link,
        expectedPolicyVersion: 2,
      })),
    });
    expect(stalePolicyGrant.status).toBe(409);
    const duplicateLinkGrant = await issueGroupGrant('won-group-duplicate-link-grant-key', db, {
      ...groupInput,
      links: [...groupInput.links, groupInput.links[0]!],
    });
    expect(duplicateLinkGrant.status).toBe(400);
    const grantResponse = await issueGroupGrant('won-group-grant-key-a');
    expect(grantResponse.status, await grantResponse.clone().text()).toBe(201);
    const grantBody = (await grantResponse.json()) as {
      data: { grantId: string; grantEvidenceToken: string };
    };
    const groupGrantToken = grantBody.data.grantEvidenceToken;
    const repeatedGrant = await issueGroupGrant('won-group-grant-key-a');
    expect(repeatedGrant.status).toBe(200);
    expect(await repeatedGrant.json()).toMatchObject({
      data: { grantEvidenceToken: groupGrantToken },
      replayed: true,
    });
    const changedGrantPayload = await issueGroupGrant('won-group-grant-key-a', db, {
      ...groupInput,
      reasonCode: 'GROUP_ALLOCATION_CHANGED',
    });
    expect(changedGrantPayload.status).toBe(409);
    const linkFailureDatabase = new Proxy(db, {
      get(target, property) {
        if (property === 'batch') {
          return (statements: D1PreparedStatement[]) =>
            target.batch([
              ...statements,
              target
                .prepare(
                  `INSERT INTO renewal_policy_links
                   (id,agency_id,renewal_id,new_policy_id,allocated_new_premium_minor,currency,
                    allocation_operation_id,created_by_membership_id,created_at)
                   VALUES('won-group-forced-link-failure','terminal-agency','won-group-renewal-a',
                     'won-group-new-policy',5000,'TRY','missing-group-receipt','terminal-membership',?)`,
                )
                .bind(now),
            ]);
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as D1Database;
    const sendGroup = (
      key: string,
      database: D1Database = db,
      payload = groupInput,
      token = groupGrantToken,
    ) =>
      groupApp.request(
        'https://panel.mayisigorta.com/secure/api/renewals/won-group',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://panel.mayisigorta.com',
            'X-CSRF-Token': groupCsrf,
            'Idempotency-Key': key,
          },
          body: JSON.stringify({ ...payload, grantEvidenceToken: token }),
        },
        { ...env, DB: database },
      );
    const seedGroupFixture = async (prefix: string, crossCustomer = false) => {
      const oldPolicyA = `${prefix}-old-policy-a`;
      const oldPolicyB = `${prefix}-old-policy-b`;
      const newPolicy = `${prefix}-new-policy`;
      const newPolicyB = `${prefix}-new-policy-b`;
      const customerB = `${prefix}-customer-b`;
      const renewalA = `${prefix}-renewal-a`;
      const renewalB = `${prefix}-renewal-b`;
      const taskA = `${prefix}-task-a`;
      const taskB = `${prefix}-task-b`;
      const policyPrefix = prefix.toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (crossCustomer) {
        await db
          .prepare(
            `INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id)
             VALUES(?,'terminal-agency','INDIVIDUAL','Group Customer B','Group','Customer B',
               'terminal-membership')`,
          )
          .bind(customerB)
          .run();
      }
      await db.batch([
        ...[
          [
            oldPolicyA,
            'terminal-customer',
            `WON-${policyPrefix}-OLD-A`,
            `WON${policyPrefix}OLDA`,
            '2025-10-25',
            '2026-10-24',
            10000,
          ],
          [
            oldPolicyB,
            crossCustomer ? customerB : 'terminal-customer',
            `WON-${policyPrefix}-OLD-B`,
            `WON${policyPrefix}OLDB`,
            '2025-10-25',
            '2026-10-24',
            12000,
          ],
          [
            newPolicy,
            'terminal-customer',
            `WON-${policyPrefix}-NEW`,
            `WON${policyPrefix}NEW`,
            '2026-10-25',
            '2027-10-24',
            crossCustomer ? 5000 : 10000,
          ],
          ...(crossCustomer
            ? [
                [
                  newPolicyB,
                  customerB,
                  `WON-${policyPrefix}-NEW-B`,
                  `WON${policyPrefix}NEWB`,
                  '2026-10-25',
                  '2027-10-24',
                  5000,
                ],
              ]
            : []),
        ].map(([id, customerId, number, normalized, startDate, endDate, premium]) =>
          db
            .prepare(
              `INSERT INTO policies
               (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
                assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
                gross_premium_minor,currency,version)
               VALUES(?,'terminal-agency',?,'terminal-insurer','terminal-product',
                 'terminal-branch','terminal-payment','terminal-membership',?,?,?,?,?, 'TRY',1)`,
            )
            .bind(id, customerId, number, normalized, startDate, endDate, premium),
        ),
        db
          .prepare(
            `INSERT INTO renewal_opportunities
             (id,agency_id,expiring_policy_id,assignee_membership_id,state,version,created_at,updated_at)
             VALUES(?,'terminal-agency',?,'terminal-won-membership','CONTACT_PENDING',1,?,?),
                   (?,'terminal-agency',?,'terminal-won-membership','CONTACT_PENDING',1,?,?)`,
          )
          .bind(renewalA, oldPolicyA, now, now, renewalB, oldPolicyB, now, now),
        db
          .prepare(
            `INSERT INTO renewal_state_history
             (id,agency_id,renewal_id,from_state,to_state,actor_kind,reason_code,created_at)
             VALUES(?, 'terminal-agency', ?, NULL,'CONTACT_PENDING','SYSTEM','POLICY_EXPIRING',?),
                   (?, 'terminal-agency', ?, NULL,'CONTACT_PENDING','SYSTEM','POLICY_EXPIRING',?)`,
          )
          .bind(`${prefix}-history-a`, renewalA, now, `${prefix}-history-b`, renewalB, now),
        db
          .prepare(
            `INSERT INTO tasks
             (id,agency_id,customer_id,renewal_id,kind,title,due_at,assignee_membership_id,
              status,actor_kind,version,created_at,updated_at)
             VALUES(?, 'terminal-agency',?,?,'RENEWAL_FOLLOWUP',?,?,'terminal-won-membership',
               'OPEN','SYSTEM',1,?,?),
                   (?, 'terminal-agency',?,?,'RENEWAL_FOLLOWUP',?,?,'terminal-won-membership',
               'OPEN','SYSTEM',1,?,?)`,
          )
          .bind(
            taskA,
            'terminal-customer',
            renewalA,
            `${prefix} group A`,
            now,
            now,
            now,
            taskB,
            crossCustomer ? customerB : 'terminal-customer',
            renewalB,
            `${prefix} group B`,
            now,
            now,
            now,
          ),
      ]);
      return {
        targetPolicyId: newPolicy,
        targetPolicyIdB: newPolicyB,
        renewalA,
        renewalB,
        taskA,
        taskB,
        input: {
          reasonCode: 'GROUP_ALLOCATION',
          renewals: [
            { renewalId: renewalA, expectedRenewalVersion: 1, expectedTaskVersion: 1 },
            { renewalId: renewalB, expectedRenewalVersion: 1, expectedTaskVersion: 1 },
          ],
          links: [
            {
              renewalId: renewalA,
              newPolicyId: newPolicy,
              expectedPolicyVersion: 1,
              allocatedNewPremiumMinor: 5000,
              currency: 'TRY',
            },
            {
              renewalId: renewalB,
              newPolicyId: crossCustomer ? newPolicyB : newPolicy,
              expectedPolicyVersion: 1,
              allocatedNewPremiumMinor: 5000,
              currency: 'TRY',
            },
          ],
        },
      };
    };
    const postGrantScopeFixture = await seedGroupFixture('won-group-postgrant-scope-race');
    const postGrantScopeInput = {
      ...groupInput,
      renewals: groupInput.renewals.map((member, index) => ({
        ...member,
        renewalId: index === 0 ? postGrantScopeFixture.renewalB : postGrantScopeFixture.renewalA,
      })),
      links: groupInput.links.map((link, index) => ({
        ...link,
        renewalId: index === 0 ? postGrantScopeFixture.renewalB : postGrantScopeFixture.renewalA,
        newPolicyId: postGrantScopeFixture.targetPolicyId,
      })),
    };
    const postGrantScopeGrantResponse = await issueGroupGrant(
      'won-group-postgrant-scope-grant-key',
      db,
      postGrantScopeInput,
    );
    expect(
      postGrantScopeGrantResponse.status,
      await postGrantScopeGrantResponse.clone().text(),
    ).toBe(201);
    const postGrantScopeGrant = (await postGrantScopeGrantResponse.json()) as {
      data: { grantId: string; grantEvidenceToken: string };
    };
    let postGrantScopeResponse: Response;
    try {
      postGrantScopeResponse = await sendGroup(
        'won-group-postgrant-scope-command-key',
        changeGrantScopeBeforeMutationBatch(
          db,
          'renewal.close_won',
          'ASSIGNED',
          'terminal-won-membership',
        ),
        postGrantScopeInput,
        postGrantScopeGrant.data.grantEvidenceToken,
      );
    } finally {
      await db
        .prepare(
          `UPDATE membership_permissions SET scope='AGENCY'
           WHERE membership_id='terminal-won-membership' AND permission_code='renewal.close_won'`,
        )
        .run();
    }
    expect(postGrantScopeResponse!.status, await postGrantScopeResponse!.clone().text()).toBe(403);
    expect(
      await db
        .prepare(
          `SELECT
             (SELECT count(*) FROM renewal_opportunities WHERE id IN (?,?)
               AND state='CONTACT_PENDING' AND version=1) AS open_renewals,
             (SELECT count(*) FROM tasks WHERE renewal_id IN (?,?) AND status='OPEN' AND version=1) AS open_tasks,
             (SELECT count(*) FROM renewal_policy_links WHERE renewal_id IN (?,?)) AS links,
             (SELECT count(*) FROM operation_receipts WHERE idempotency_key=?) AS command_receipts,
             (SELECT count(*) FROM renewal_state_history WHERE renewal_id IN (?,?) AND to_state='WON') AS won_history,
             (SELECT count(*) FROM audit_events WHERE target_id IN (?,?) AND action='renewal.closed_won') AS won_audits,
             (SELECT count(*) FROM sensitive_action_grants WHERE id=? AND status='ISSUED' AND consumed_at IS NULL) AS unconsumed_grants`,
        )
        .bind(
          postGrantScopeFixture.renewalA,
          postGrantScopeFixture.renewalB,
          postGrantScopeFixture.renewalA,
          postGrantScopeFixture.renewalB,
          postGrantScopeFixture.renewalA,
          postGrantScopeFixture.renewalB,
          'won-group-postgrant-scope-command-key',
          postGrantScopeFixture.renewalA,
          postGrantScopeFixture.renewalB,
          postGrantScopeFixture.renewalA,
          postGrantScopeFixture.renewalB,
          postGrantScopeGrant.data.grantId,
        )
        .first(),
    ).toEqual({
      open_renewals: 2,
      open_tasks: 2,
      links: 0,
      command_receipts: 0,
      won_history: 0,
      won_audits: 0,
      unconsumed_grants: 1,
    });
    const preallocatedGroupFixture = await seedGroupFixture('won-group-preallocated');
    const preallocatedOperationId = 'won-group-preallocated-link-operation';
    const preallocatedLinks = [
      {
        id: 'won-group-preallocated-link-a',
        renewalId: preallocatedGroupFixture.renewalA,
        newPolicyId: preallocatedGroupFixture.targetPolicyId,
        allocatedNewPremiumMinor: 5000,
        currency: 'TRY',
        differentPolicyholderReasonCode: null,
      },
      {
        id: 'won-group-preallocated-link-b',
        renewalId: preallocatedGroupFixture.renewalB,
        newPolicyId: preallocatedGroupFixture.targetPolicyId,
        allocatedNewPremiumMinor: 5000,
        currency: 'TRY',
        differentPolicyholderReasonCode: null,
      },
    ];
    await db.batch([
      db
        .prepare(
          `INSERT INTO operation_receipts
           (id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,
            payload_fingerprint,status,response_status,response_body,created_at,updated_at)
           VALUES(?,'terminal-agency','terminal-won-user','terminal-won-membership',
             'renewal.policy_links.allocate','won-group-preallocated-link-key',?,
             'COMPLETED',201,?,?,?)`,
        )
        .bind(
          preallocatedOperationId,
          'a'.repeat(64),
          JSON.stringify({
            operationId: preallocatedOperationId,
            reasonCode: 'PREALLOCATED_GROUP',
            ownerRequired: false,
            authorizedTargets: [],
            links: preallocatedLinks,
            supersededLinkIds: [],
          }),
          now,
          now,
        ),
      db
        .prepare(
          `INSERT INTO renewal_policy_links
           (id,agency_id,renewal_id,new_policy_id,allocated_new_premium_minor,currency,
            allocation_operation_id,different_policyholder_reason_code,created_by_membership_id,created_at)
           VALUES(?,?,?,?,?,? ,?, ?, 'terminal-won-membership',?),
                 (?,?,?,?,?,? ,?, ?, 'terminal-won-membership',?)`,
        )
        .bind(
          preallocatedLinks[0]!.id,
          'terminal-agency',
          preallocatedLinks[0]!.renewalId,
          preallocatedLinks[0]!.newPolicyId,
          preallocatedLinks[0]!.allocatedNewPremiumMinor,
          preallocatedLinks[0]!.currency,
          preallocatedOperationId,
          preallocatedLinks[0]!.differentPolicyholderReasonCode,
          now,
          preallocatedLinks[1]!.id,
          'terminal-agency',
          preallocatedLinks[1]!.renewalId,
          preallocatedLinks[1]!.newPolicyId,
          preallocatedLinks[1]!.allocatedNewPremiumMinor,
          preallocatedLinks[1]!.currency,
          preallocatedOperationId,
          preallocatedLinks[1]!.differentPolicyholderReasonCode,
          now,
        ),
    ]);
    const preallocatedGrantResponse = await issueGroupGrant(
      'won-group-preallocated-grant-key',
      db,
      preallocatedGroupFixture.input,
    );
    expect(preallocatedGrantResponse.status, await preallocatedGrantResponse.clone().text()).toBe(
      201,
    );
    const preallocatedGrant = (await preallocatedGrantResponse.json()) as {
      data: { grantEvidenceToken: string };
    };
    const preallocatedWonResponse = await sendGroup(
      'won-group-preallocated-command-key',
      db,
      preallocatedGroupFixture.input,
      preallocatedGrant.data.grantEvidenceToken,
    );
    expect(preallocatedWonResponse.status, await preallocatedWonResponse.clone().text()).toBe(201);
    const preallocatedWonBody = (await preallocatedWonResponse.json()) as {
      data: {
        operationId: string;
        renewals: Array<{
          renewalId: string;
          state: string;
          links: Array<{ id: string; allocationOperationId: string }>;
        }>;
      };
      replayed: boolean;
    };
    expect(preallocatedWonBody.replayed).toBe(false);
    expect(
      preallocatedWonBody.data.renewals.flatMap((member) =>
        member.links.map((link) => ({
          renewalId: member.renewalId,
          state: member.state,
          id: link.id,
          allocationOperationId: link.allocationOperationId,
        })),
      ),
    ).toEqual([
      {
        renewalId: preallocatedGroupFixture.renewalA,
        state: 'WON',
        id: 'won-group-preallocated-link-a',
        allocationOperationId: preallocatedOperationId,
      },
      {
        renewalId: preallocatedGroupFixture.renewalB,
        state: 'WON',
        id: 'won-group-preallocated-link-b',
        allocationOperationId: preallocatedOperationId,
      },
    ]);
    const preallocatedWonReplay = await sendGroup(
      'won-group-preallocated-command-key',
      db,
      preallocatedGroupFixture.input,
      preallocatedGrant.data.grantEvidenceToken,
    );
    expect(preallocatedWonReplay.status, await preallocatedWonReplay.clone().text()).toBe(200);
    expect(await preallocatedWonReplay.json()).toMatchObject({
      data: preallocatedWonBody.data,
      replayed: true,
    });
    const preallocatedChangedReplay = await sendGroup(
      'won-group-preallocated-command-key',
      db,
      { ...preallocatedGroupFixture.input, reasonCode: 'GROUP_ALLOCATION_CHANGED' },
      preallocatedGrant.data.grantEvidenceToken,
    );
    expect(preallocatedChangedReplay.status).toBe(409);
    const preallocatedEvidence = await db
      .prepare(
        `SELECT id,status,allocation_operation_id,supersedes_link_id,superseded_operation_id,
                allocated_new_premium_minor
         FROM renewal_policy_links WHERE renewal_id IN (?,?) ORDER BY id`,
      )
      .bind(preallocatedGroupFixture.renewalA, preallocatedGroupFixture.renewalB)
      .all<{
        id: string;
        status: 'ACTIVE' | 'SUPERSEDED';
        allocation_operation_id: string;
        supersedes_link_id: string | null;
        superseded_operation_id: string | null;
        allocated_new_premium_minor: number;
      }>();
    expect(preallocatedEvidence.results).toEqual([
      {
        id: 'won-group-preallocated-link-a',
        status: 'ACTIVE',
        allocation_operation_id: preallocatedOperationId,
        supersedes_link_id: null,
        superseded_operation_id: null,
        allocated_new_premium_minor: 5000,
      },
      {
        id: 'won-group-preallocated-link-b',
        status: 'ACTIVE',
        allocation_operation_id: preallocatedOperationId,
        supersedes_link_id: null,
        superseded_operation_id: null,
        allocated_new_premium_minor: 5000,
      },
    ]);
    expect(
      await db
        .prepare(
          `SELECT
             (SELECT count(*) FROM renewal_opportunities WHERE id IN (?,?) AND state='WON') AS won_renewals,
             (SELECT count(*) FROM tasks WHERE renewal_id IN (?,?) AND status='COMPLETED') AS completed_tasks,
             (SELECT count(*) FROM operation_receipts WHERE id=? AND action='renewal.close_won.group'
               AND status='COMPLETED' AND response_status=201) AS group_receipts`,
        )
        .bind(
          preallocatedGroupFixture.renewalA,
          preallocatedGroupFixture.renewalB,
          preallocatedGroupFixture.renewalA,
          preallocatedGroupFixture.renewalB,
          preallocatedWonBody.data.operationId,
        )
        .first(),
    ).toEqual({ won_renewals: 2, completed_tasks: 2, group_receipts: 1 });
    const unauthorizedHealthFixture = await seedGroupFixture('won-group-health-member-denied');
    await db.batch([
      db.prepare(
        `INSERT INTO insurance_branches(id,agency_id,code,name,data_classification)
         VALUES('won-group-denied-health-branch','terminal-agency','WON_GROUP_HEALTH','Health','HEALTH')`,
      ),
      db.prepare(
        `INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name)
         VALUES('won-group-denied-health-product','terminal-agency','terminal-insurer',
           'won-group-denied-health-branch','WON_GROUP_HEALTH','Health')`,
      ),
      db.prepare(
        `INSERT INTO policies
         (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
          assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
          gross_premium_minor,currency,version)
         VALUES('won-group-denied-general-policy','terminal-agency','terminal-customer','terminal-insurer',
           'terminal-product','terminal-branch','terminal-payment','terminal-membership',
           'WON-GROUP-DENIED-GENERAL','WONGROUPDENIEDGENERAL','2026-10-25','2027-10-24',5000,'TRY',1),
               ('won-group-denied-health-policy','terminal-agency','terminal-customer','terminal-insurer',
           'won-group-denied-health-product','won-group-denied-health-branch','terminal-payment',
           'terminal-membership','WON-GROUP-DENIED-HEALTH','WONGROUPDENIEDHEALTH',
           '2026-10-25','2027-10-24',5000,'TRY',1)`,
      ),
    ]);
    const groupGrantsBeforeUnauthorizedTarget = await db
      .prepare(
        "SELECT count(*) AS count FROM sensitive_action_grants WHERE action='renewal.close_won.group'",
      )
      .first<{ count: number }>();
    const unauthorizedMemberGrant = await issueGroupGrant(
      'won-group-health-member-denied-grant-key',
      db,
      {
        ...unauthorizedHealthFixture.input,
        links: [
          {
            renewalId: unauthorizedHealthFixture.renewalA,
            newPolicyId: 'won-group-denied-general-policy',
            expectedPolicyVersion: 1,
            allocatedNewPremiumMinor: 5000,
            currency: 'TRY',
          },
          {
            renewalId: unauthorizedHealthFixture.renewalB,
            newPolicyId: 'won-group-denied-health-policy',
            expectedPolicyVersion: 1,
            allocatedNewPremiumMinor: 5000,
            currency: 'TRY',
          },
        ],
      },
    );
    expect(unauthorizedMemberGrant.status).toBe(403);
    expect(
      await db
        .prepare(
          `SELECT
             (SELECT count(*) FROM renewal_opportunities WHERE id IN (?,?) AND state='CONTACT_PENDING') AS open_renewals,
             (SELECT count(*) FROM tasks WHERE renewal_id IN (?,?) AND status='OPEN') AS open_tasks,
             (SELECT count(*) FROM renewal_policy_links WHERE renewal_id IN (?,?)) AS links,
             (SELECT count(*) FROM operation_receipts WHERE idempotency_key='won-group-health-member-denied-grant-key') AS receipts,
             (SELECT count(*) FROM sensitive_action_grants WHERE action='renewal.close_won.group') AS grants`,
        )
        .bind(
          unauthorizedHealthFixture.renewalA,
          unauthorizedHealthFixture.renewalB,
          unauthorizedHealthFixture.renewalA,
          unauthorizedHealthFixture.renewalB,
          unauthorizedHealthFixture.renewalA,
          unauthorizedHealthFixture.renewalB,
        )
        .first(),
    ).toEqual({
      open_renewals: 2,
      open_tasks: 2,
      links: 0,
      receipts: 0,
      grants: groupGrantsBeforeUnauthorizedTarget?.count,
    });
    const createBatchBarrier = () => {
      let arrivals = 0;
      let release!: () => void;
      const gate = new Promise<void>((resolveGate) => {
        release = resolveGate;
      });
      const database = new Proxy(db, {
        get(target, property) {
          if (property === 'batch') {
            return async (statements: D1PreparedStatement[]) => {
              arrivals += 1;
              if (arrivals === 2) release();
              await gate;
              return target.batch(statements);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as D1Database;
      return { database, arrivals: () => arrivals };
    };

    const auditFailureDatabase = new Proxy(db, {
      get(target, property) {
        if (property === 'batch') {
          return (statements: D1PreparedStatement[]) =>
            target.batch([
              ...statements,
              target
                .prepare(
                  `INSERT INTO audit_events
                   (id,agency_id,actor_user_id,actor_membership_id,action,target_type,target_id,
                    correlation_id,idempotency_key,outcome,metadata_json,created_at)
                   VALUES('won-group-forced-audit-failure','terminal-agency','terminal-won-user',
                     'terminal-won-membership','renewal.closed_won','renewal_opportunities',
                     'won-group-renewal-a','forced','forced','INVALID','{}',?)`,
                )
                .bind(now),
            ]);
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as D1Database;
    const auditFailed = await sendGroup('won-group-audit-failure-key', auditFailureDatabase);

    expect(auditFailed.status, await auditFailed.clone().text()).toBe(500);
    expect(
      await db
        .prepare(
          `SELECT
             (SELECT count(*) FROM renewal_opportunities WHERE id IN
                ('won-group-renewal-a','won-group-renewal-b') AND state='CONTACT_PENDING' AND version=1) AS open_renewals,
             (SELECT count(*) FROM tasks WHERE id IN ('won-group-task-a','won-group-task-b')
                AND status='OPEN' AND version=1) AS open_tasks,
             (SELECT count(*) FROM renewal_state_history WHERE renewal_id IN
                ('won-group-renewal-a','won-group-renewal-b') AND to_state='WON') AS won_history,
             (SELECT count(*) FROM audit_events WHERE target_id IN
                ('won-group-renewal-a','won-group-renewal-b') AND action='renewal.closed_won') AS won_audits,
             (SELECT count(*) FROM operation_receipts WHERE idempotency_key='won-group-audit-failure-key') AS receipts,
             (SELECT count(*) FROM renewal_policy_links WHERE renewal_id IN ('won-group-renewal-a','won-group-renewal-b')
                AND status='ACTIVE') AS active_links`,
        )
        .first(),
    ).toEqual({
      open_renewals: 2,
      open_tasks: 2,
      won_history: 0,
      won_audits: 0,
      receipts: 0,
      active_links: 0,
    });

    let invalidPolicyInjected = false;
    const invalidPolicyDatabase = new Proxy(db, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            if (!invalidPolicyInjected) {
              invalidPolicyInjected = true;
              await target
                .prepare(
                  `UPDATE policies SET status='CANCELLED',version=2,
                     updated_at='2099-01-01T00:00:00.000Z' WHERE id='won-group-new-policy'`,
                )
                .run();
            }
            try {
              return await target.batch(statements);
            } finally {
              if (invalidPolicyInjected) {
                await target
                  .prepare(
                    `UPDATE policies SET status='ACTIVE',version=1,updated_at=?
                     WHERE id='won-group-new-policy'`,
                  )
                  .bind(now)
                  .run();
              }
            }
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as D1Database;
    const invalidPolicyGroup = await sendGroup(
      'won-group-invalid-policy-key',
      invalidPolicyDatabase,
    );
    expect(invalidPolicyGroup.status).toBe(403);
    expect(
      await db
        .prepare(
          `SELECT
             (SELECT count(*) FROM renewal_opportunities WHERE id IN
                ('won-group-renewal-a','won-group-renewal-b') AND state='CONTACT_PENDING' AND version=1) AS open_renewals,
             (SELECT count(*) FROM tasks WHERE id IN ('won-group-task-a','won-group-task-b')
                AND status='OPEN' AND version=1) AS open_tasks,
             (SELECT count(*) FROM renewal_state_history WHERE renewal_id IN
                ('won-group-renewal-a','won-group-renewal-b') AND to_state='WON') AS won_history,
             (SELECT count(*) FROM audit_events WHERE target_id IN
                ('won-group-renewal-a','won-group-renewal-b') AND action='renewal.closed_won') AS won_audits,
             (SELECT count(*) FROM operation_receipts WHERE idempotency_key='won-group-invalid-policy-key') AS receipts,
             (SELECT count(*) FROM renewal_policy_links WHERE renewal_id IN ('won-group-renewal-a','won-group-renewal-b')
                AND status='ACTIVE') AS active_links,
             (SELECT status FROM sensitive_action_grants WHERE id=?) AS grant_status`,
        )
        .bind(grantBody.data.grantId)
        .first(),
    ).toEqual({
      open_renewals: 2,
      open_tasks: 2,
      won_history: 0,
      won_audits: 0,
      receipts: 0,
      active_links: 0,
      grant_status: 'ISSUED',
    });

    let staleInjected = false;
    const staleSecondRenewalDatabase = new Proxy(db, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            if (!staleInjected) {
              staleInjected = true;
              await target
                .prepare(
                  `UPDATE renewal_opportunities SET version=2,updated_at='2099-01-01T00:00:00.000Z'
                   WHERE id='won-group-renewal-b' AND version=1`,
                )
                .run();
            }
            try {
              return await target.batch(statements);
            } finally {
              if (staleInjected) {
                await target
                  .prepare(
                    `UPDATE renewal_opportunities SET version=1,updated_at=?
                     WHERE id='won-group-renewal-b' AND version=2`,
                  )
                  .bind(now)
                  .run();
              }
            }
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as D1Database;
    const staleGroup = await sendGroup('won-group-stale-key', staleSecondRenewalDatabase);
    expect(staleGroup.status).toBe(409);
    expect(
      await db
        .prepare(
          `SELECT
             (SELECT count(*) FROM renewal_opportunities WHERE id IN
                ('won-group-renewal-a','won-group-renewal-b') AND state='CONTACT_PENDING' AND version=1) AS open_renewals,
             (SELECT count(*) FROM tasks WHERE id IN ('won-group-task-a','won-group-task-b')
                AND status='OPEN' AND version=1) AS open_tasks,
             (SELECT count(*) FROM renewal_state_history WHERE renewal_id IN
                ('won-group-renewal-a','won-group-renewal-b') AND to_state='WON') AS won_history,
             (SELECT count(*) FROM operation_receipts WHERE idempotency_key='won-group-stale-key') AS receipts,
             (SELECT count(*) FROM renewal_policy_links WHERE renewal_id IN ('won-group-renewal-a','won-group-renewal-b')
                AND status='ACTIVE') AS active_links`,
        )
        .first(),
    ).toEqual({ open_renewals: 2, open_tasks: 2, won_history: 0, receipts: 0, active_links: 0 });

    const historyFailureDatabase = new Proxy(db, {
      get(target, property) {
        if (property === 'batch') {
          return (statements: D1PreparedStatement[]) =>
            target.batch([
              ...statements,
              target
                .prepare(
                  `INSERT INTO renewal_state_history
                   (id,agency_id,renewal_id,from_state,to_state,actor_kind,actor_user_id,
                    actor_membership_id,reason_code,created_at)
                   VALUES('won-group-forced-history-failure','terminal-agency','won-group-renewal-a',
                     'CONTACT_PENDING','INVALID','USER','terminal-user','terminal-membership','WON',?)`,
                )
                .bind(now),
            ]);
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as D1Database;
    const historyFailed = await sendGroup('won-group-history-failure-key', historyFailureDatabase);
    expect(historyFailed.status).toBe(500);
    expect(
      await db
        .prepare(
          `SELECT
             (SELECT count(*) FROM renewal_opportunities WHERE id IN
                ('won-group-renewal-a','won-group-renewal-b') AND state='CONTACT_PENDING' AND version=1) AS open_renewals,
             (SELECT count(*) FROM tasks WHERE id IN ('won-group-task-a','won-group-task-b')
                AND status='OPEN' AND version=1) AS open_tasks,
             (SELECT count(*) FROM renewal_state_history WHERE renewal_id IN
                ('won-group-renewal-a','won-group-renewal-b') AND to_state='WON') AS won_history,
             (SELECT count(*) FROM renewal_policy_links WHERE new_policy_id='won-group-new-policy') AS links,
             (SELECT count(*) FROM operation_receipts WHERE idempotency_key='won-group-history-failure-key') AS receipts`,
        )
        .first(),
    ).toEqual({ open_renewals: 2, open_tasks: 2, won_history: 0, links: 0, receipts: 0 });

    const linkFailed = await sendGroup('won-group-link-failure-key', linkFailureDatabase);
    expect(linkFailed.status, await linkFailed.clone().text()).toBe(409);
    expect(
      await db
        .prepare(
          `SELECT
             (SELECT count(*) FROM renewal_opportunities WHERE id IN
                ('won-group-renewal-a','won-group-renewal-b') AND state='CONTACT_PENDING' AND version=1) AS open_renewals,
             (SELECT count(*) FROM tasks WHERE id IN ('won-group-task-a','won-group-task-b')
                AND status='OPEN' AND version=1) AS open_tasks,
             (SELECT count(*) FROM renewal_state_history WHERE renewal_id IN
                ('won-group-renewal-a','won-group-renewal-b') AND to_state='WON') AS won_history,
             (SELECT count(*) FROM operation_receipts WHERE idempotency_key='won-group-link-failure-key') AS receipts,
             (SELECT count(*) FROM renewal_policy_links WHERE new_policy_id='won-group-new-policy') AS links`,
        )
        .first(),
    ).toEqual({ open_renewals: 2, open_tasks: 2, won_history: 0, receipts: 0, links: 0 });

    const unknownTarget = await sendGroup('won-group-unknown-target-key', db, {
      ...groupInput,
      renewals: [
        ...groupInput.renewals,
        {
          renewalId: 'renewal-from-another-agency',
          expectedRenewalVersion: 1,
          expectedTaskVersion: 1,
        },
      ],
      links: [
        ...groupInput.links,
        {
          renewalId: 'renewal-from-another-agency',
          newPolicyId: 'won-group-new-policy',
          expectedPolicyVersion: 1,
          allocatedNewPremiumMinor: 1,
          currency: 'TRY',
        },
      ],
    });
    expect(unknownTarget.status).toBe(404);
    expect(
      await db
        .prepare(
          `SELECT count(*) AS count FROM operation_receipts WHERE idempotency_key='won-group-unknown-target-key'`,
        )
        .first(),
    ).toEqual({ count: 0 });

    let batchArrivals = 0;
    let releaseBatches!: () => void;
    const bothAtBatch = new Promise<void>((resolveBatches) => {
      releaseBatches = resolveBatches;
    });
    const racingDatabase = new Proxy(db, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            batchArrivals += 1;
            if (batchArrivals === 2) releaseBatches();
            await bothAtBatch;
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as D1Database;
    const secondGrantResponse = await issueGroupGrant('won-group-grant-key-b');
    expect(secondGrantResponse.status, await secondGrantResponse.clone().text()).toBe(201);
    const secondGrantBody = (await secondGrantResponse.json()) as {
      data: { grantEvidenceToken: string };
    };
    const raceKeys = ['won-group-race-key-a', 'won-group-race-key-b'] as const;
    const raceTokens = [groupGrantToken, secondGrantBody.data.grantEvidenceToken] as const;
    const raced = await Promise.all(
      raceKeys.map((key, index) => sendGroup(key, racingDatabase, groupInput, raceTokens[index]!)),
    );
    expect(batchArrivals).toBe(2);
    expect(raced.map((response) => response.status).sort()).toEqual([201, 409]);
    const winnerIndex = raced.findIndex((response) => response.status === 201);
    const winnerKey = raceKeys[winnerIndex]!;
    const winnerToken = raceTokens[winnerIndex]!;
    const winnerBody = (await raced[winnerIndex]!.json()) as {
      data: {
        operationId: string;
        renewals: Array<{
          renewalId: string;
          links: Array<{
            id: string;
            newPolicyId: string;
            allocatedNewPremiumMinor: number;
            currency: string;
            allocationOperationId: string;
            policyVersion: number;
          }>;
        }>;
      };
      replayed: boolean;
    };
    expect(winnerBody.replayed).toBe(false);
    expect(winnerBody.data.renewals.map((item) => item.renewalId)).toEqual([
      'won-group-renewal-a',
      'won-group-renewal-b',
    ]);
    expect(winnerBody.data.renewals.every((item) => item.links.length === 1)).toBe(true);
    const committedGroupLinks = winnerBody.data.renewals.flatMap((item) => item.links);
    expect(committedGroupLinks).toHaveLength(2);
    expect(committedGroupLinks.map((link) => link.allocatedNewPremiumMinor)).toEqual([5000, 5000]);
    expect(
      committedGroupLinks.every(
        (link) =>
          link.newPolicyId === 'won-group-new-policy' &&
          link.currency === 'TRY' &&
          link.allocationOperationId === winnerBody.data.operationId &&
          link.policyVersion === 1,
      ),
    ).toBe(true);
    const replayPayload = {
      ...groupInput,
      renewals: [...groupInput.renewals].reverse(),
      links: [...groupInput.links].reverse(),
    };
    const replay = await sendGroup(winnerKey, db, replayPayload, winnerToken);
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toMatchObject({ data: winnerBody.data, replayed: true });
    const changedPayload = await sendGroup(
      winnerKey,
      db,
      {
        ...groupInput,
        renewals: groupInput.renewals.map((item) => ({ ...item, expectedRenewalVersion: 2 })),
      },
      winnerToken,
    );
    expect(changedPayload.status).toBe(409);

    expect(
      await db
        .prepare(
          `SELECT
             (SELECT count(*) FROM renewal_opportunities WHERE id IN
                ('won-group-renewal-a','won-group-renewal-b') AND state='WON' AND version=2) AS won_renewals,
             (SELECT count(*) FROM tasks WHERE id IN ('won-group-task-a','won-group-task-b')
                AND status='COMPLETED' AND version=2) AS completed_tasks,
             (SELECT count(*) FROM renewal_state_history WHERE renewal_id IN
                ('won-group-renewal-a','won-group-renewal-b') AND to_state='WON') AS won_history,
             (SELECT count(*) FROM audit_events WHERE target_id IN
                ('won-group-renewal-a','won-group-renewal-b') AND action='renewal.closed_won') AS won_audits,
             (SELECT count(*) FROM operation_receipts WHERE idempotency_key IN
                ('won-group-race-key-a','won-group-race-key-b') AND action='renewal.close_won.group') AS receipts,
             (SELECT count(*) FROM renewal_policy_links WHERE renewal_id IN ('won-group-renewal-a','won-group-renewal-b')
                AND status='ACTIVE') AS active_links,
             (SELECT COALESCE(sum(allocated_new_premium_minor),0) FROM renewal_policy_links
                WHERE new_policy_id='won-group-new-policy' AND status='ACTIVE') AS allocated`,
        )
        .first(),
    ).toEqual({
      won_renewals: 2,
      completed_tasks: 2,
      won_history: 2,
      won_audits: 2,
      receipts: 1,
      active_links: 2,
      allocated: 10000,
    });

    const lostRaceFixture = await seedGroupFixture('won-lost-group-race');
    const lostRaceGrantResponse = await issueGroupGrant(
      'won-lost-group-race-grant-key',
      db,
      lostRaceFixture.input,
    );
    expect(lostRaceGrantResponse.status).toBe(201);
    const lostRaceGrant = (await lostRaceGrantResponse.json()) as {
      data: { grantEvidenceToken: string };
    };
    const lostBarrier = createBatchBarrier();
    const [groupAgainstLost, individualLost] = await Promise.allSettled([
      sendGroup(
        'won-lost-group-race-command-key',
        lostBarrier.database,
        lostRaceFixture.input,
        lostRaceGrant.data.grantEvidenceToken,
      ),
      closeRenewalLost(
        groupActor,
        lostBarrier.database,
        lostRaceFixture.renewalA,
        {
          expectedPrimaryTaskId: lostRaceFixture.taskA,
          expectedRenewalVersion: 1,
          expectedTaskVersion: 1,
          lossReasonId: 'terminal-loss-price',
          lossReasonNotes: null,
        },
        'won-lost-group-race-individual-key',
      ),
    ]);
    expect(lostBarrier.arrivals()).toBe(2);
    if (groupAgainstLost.status !== 'fulfilled') throw groupAgainstLost.reason;
    const lostRaceResponse = groupAgainstLost.value;
    const lostRaceState = await db
      .prepare(
        `SELECT
           (SELECT count(*) FROM renewal_opportunities WHERE id IN (?,?) AND state='WON' AND version=2) AS won,
           (SELECT count(*) FROM renewal_opportunities WHERE id=? AND state='LOST' AND version=2) AS lost,
           (SELECT count(*) FROM renewal_opportunities WHERE id=? AND state='CONTACT_PENDING' AND version=1) AS open,
           (SELECT count(*) FROM tasks WHERE renewal_id IN (?,?) AND status='COMPLETED' AND version=2) AS completed_tasks,
           (SELECT count(*) FROM renewal_policy_links WHERE new_policy_id=? AND status='ACTIVE') AS active_group_links,
           (SELECT count(*) FROM operation_receipts WHERE idempotency_key='won-lost-group-race-command-key') AS group_receipt`,
      )
      .bind(
        lostRaceFixture.renewalA,
        lostRaceFixture.renewalB,
        lostRaceFixture.renewalA,
        lostRaceFixture.renewalB,
        lostRaceFixture.renewalA,
        lostRaceFixture.renewalB,
        lostRaceFixture.targetPolicyId,
      )
      .first();
    if (lostRaceResponse.status === 201) {
      expect(individualLost.status).toBe('rejected');
      expect(lostRaceState).toEqual({
        won: 2,
        lost: 0,
        open: 0,
        completed_tasks: 2,
        active_group_links: 2,
        group_receipt: 1,
      });
    } else {
      expect(lostRaceResponse.status).toBe(409);
      expect(individualLost.status).toBe('fulfilled');
      expect(lostRaceState).toEqual({
        won: 0,
        lost: 1,
        open: 1,
        completed_tasks: 1,
        active_group_links: 0,
        group_receipt: 0,
      });
    }

    const wonRaceFixture = await seedGroupFixture('won-individual-group-race');
    const wonRaceGrantResponse = await issueGroupGrant(
      'won-individual-group-race-grant-key',
      db,
      wonRaceFixture.input,
    );
    expect(wonRaceGrantResponse.status).toBe(201);
    const wonRaceGrant = (await wonRaceGrantResponse.json()) as {
      data: { grantEvidenceToken: string };
    };
    const wonBarrier = createBatchBarrier();
    const individualWonPayload = {
      expectedPrimaryTaskId: wonRaceFixture.taskA,
      expectedRenewalVersion: 1,
      expectedTaskVersion: 1,
      result: {
        kind: 'CREATE_POLICY',
        policy: {
          customerId: 'terminal-customer',
          insurerId: 'terminal-insurer',
          productId: 'terminal-product',
          branchId: 'terminal-branch',
          paymentMethodId: 'terminal-payment',
          policyNumber: 'WON-GROUP-INDIVIDUAL-RACE',
          startDate: '2026-10-25',
          endDate: '2027-10-24',
          grossPremium: '95.00',
          currency: 'TRY',
          installmentCount: null,
          status: 'ACTIVE',
        },
      },
    };
    const [groupAgainstWon, individualWon] = await Promise.allSettled([
      sendGroup(
        'won-individual-group-race-command-key',
        wonBarrier.database,
        wonRaceFixture.input,
        wonRaceGrant.data.grantEvidenceToken,
      ),
      closeRenewalWon(
        groupActor,
        wonBarrier.database,
        wonRaceFixture.renewalA,
        individualWonPayload,
        'won-individual-group-race-individual-key',
      ),
    ]);
    expect(wonBarrier.arrivals()).toBe(2);
    if (groupAgainstWon.status !== 'fulfilled') throw groupAgainstWon.reason;
    const wonRaceResponse = groupAgainstWon.value;
    const wonRaceState = await db
      .prepare(
        `SELECT
           (SELECT state FROM renewal_opportunities WHERE id=?) AS state_a,
           (SELECT state FROM renewal_opportunities WHERE id=?) AS state_b,
           (SELECT status FROM tasks WHERE renewal_id=?) AS task_a,
           (SELECT status FROM tasks WHERE renewal_id=?) AS task_b,
           (SELECT count(*) FROM renewal_policy_links WHERE new_policy_id=? AND status='ACTIVE') AS group_links,
           (SELECT count(*) FROM policies WHERE policy_number='WON-GROUP-INDIVIDUAL-RACE') AS individual_policy,
           (SELECT count(*) FROM operation_receipts WHERE idempotency_key='won-individual-group-race-command-key') AS group_receipt`,
      )
      .bind(
        wonRaceFixture.renewalA,
        wonRaceFixture.renewalB,
        wonRaceFixture.renewalA,
        wonRaceFixture.renewalB,
        wonRaceFixture.targetPolicyId,
      )
      .first();
    if (wonRaceResponse.status === 201) {
      expect(individualWon.status).toBe('rejected');
      expect(wonRaceState).toEqual({
        state_a: 'WON',
        state_b: 'WON',
        task_a: 'COMPLETED',
        task_b: 'COMPLETED',
        group_links: 2,
        individual_policy: 0,
        group_receipt: 1,
      });
    } else {
      expect(wonRaceResponse.status).toBe(409);
      expect(individualWon.status).toBe('fulfilled');
      expect(wonRaceState).toEqual({
        state_a: 'WON',
        state_b: 'CONTACT_PENDING',
        task_a: 'COMPLETED',
        task_b: 'OPEN',
        group_links: 0,
        individual_policy: 1,
        group_receipt: 0,
      });
    }

    const groupCorrectionActor: AuthenticatedUserContext = {
      ...actor,
      identityId: 'terminal-identity-backup',
      assurance: 'SECURE',
    };
    const groupCorrectionPrincipal = {
      subject: 'terminal-subject-backup',
    } as AuthenticatedPrincipal;
    const groupCorrectionApp = terminalApp(groupCorrectionActor, groupCorrectionPrincipal);
    const groupCorrectionCsrfResponse = await groupCorrectionApp.request(
      'https://panel.mayisigorta.com/api/csrf-token',
      {},
      { ...env, DB: db },
    );
    const groupCorrectionCsrf = (await groupCorrectionCsrfResponse.json()) as {
      data: { token: string };
    };
    const groupCorrectionCsrfToken = groupCorrectionCsrf.data.token;
    const groupCorrectionInput = {
      expectedRenewalVersion: 2,
      expectedTaskVersion: 2,
      replacementDueAt: '2026-10-30T08:00:00.000Z',
      correctionReasonCode: 'GROUP_CORRECTION_TEST',
    };
    const preallocatedPremiumCorrection = await groupCorrectionApp.request(
      `https://panel.mayisigorta.com/secure/api/policies/${preallocatedGroupFixture.targetPolicyId}/correct-won-premium`,
      {
        method: 'POST',
        headers: {
          Origin: 'https://panel.mayisigorta.com',
          'Content-Type': 'application/json',
          'X-CSRF-Token': groupCorrectionCsrfToken,
          'Idempotency-Key': 'won-group-preallocated-premium-correction-key',
        },
        body: JSON.stringify({
          expectedPolicyVersion: 1,
          correctedPremiumMinor: 12000,
          reasonCode: 'GROUP_PREMIUM_REBALANCE',
          allocations: [
            {
              linkId: preallocatedLinks[0]!.id,
              expectedRenewalVersion: 2,
              allocatedPremiumMinor: 7000,
            },
            {
              linkId: preallocatedLinks[1]!.id,
              expectedRenewalVersion: 2,
              allocatedPremiumMinor: 5000,
            },
          ],
        }),
      },
      { ...env, DB: db },
    );
    expect(
      preallocatedPremiumCorrection.status,
      await preallocatedPremiumCorrection.clone().text(),
    ).toBe(200);
    const preallocatedPremiumCorrectionResult = (await preallocatedPremiumCorrection.json()) as {
      data: { links: Array<{ newLinkId: string; renewalId: string }> };
    };
    const preallocatedCorrectionGrantResponse = await groupCorrectionApp.request(
      `https://panel.mayisigorta.com/secure/api/renewals/${preallocatedGroupFixture.renewalA}/won-correction-grants`,
      {
        method: 'POST',
        headers: {
          Origin: 'https://panel.mayisigorta.com',
          'Content-Type': 'application/json',
          'X-CSRF-Token': groupCorrectionCsrfToken,
          'Idempotency-Key': 'won-group-preallocated-correction-grant-key',
        },
        body: JSON.stringify(groupCorrectionInput),
      },
      { ...env, DB: db },
    );
    expect(
      preallocatedCorrectionGrantResponse.status,
      await preallocatedCorrectionGrantResponse.clone().text(),
    ).toBe(201);
    const preallocatedCorrectionGrant = (await preallocatedCorrectionGrantResponse.json()) as {
      data: { grantEvidenceToken: string };
    };
    const preallocatedCorrectionResponse = await groupCorrectionApp.request(
      `https://panel.mayisigorta.com/secure/api/renewals/${preallocatedGroupFixture.renewalA}/correct-won`,
      {
        method: 'POST',
        headers: {
          Origin: 'https://panel.mayisigorta.com',
          'Content-Type': 'application/json',
          'X-CSRF-Token': groupCorrectionCsrfToken,
          'Idempotency-Key': 'won-group-preallocated-correction-operation-key',
        },
        body: JSON.stringify({
          ...groupCorrectionInput,
          grantEvidenceToken: preallocatedCorrectionGrant.data.grantEvidenceToken,
        }),
      },
      { ...env, DB: db },
    );
    expect(
      preallocatedCorrectionResponse.status,
      await preallocatedCorrectionResponse.clone().text(),
    ).toBe(200);
    const preallocatedCorrection = (await preallocatedCorrectionResponse.json()) as {
      data: { groupOperationId: string; renewals: Array<{ renewalId: string }> };
    };
    expect(preallocatedCorrection.data.groupOperationId).toBe(preallocatedWonBody.data.operationId);
    expect(preallocatedCorrection.data.renewals).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          renewalId: preallocatedGroupFixture.renewalA,
          state: 'CONTACT_PENDING',
          renewalVersion: 3,
          taskVersion: 1,
          supersededLinkIds: [
            preallocatedPremiumCorrectionResult.data.links.find(
              (link) => link.renewalId === preallocatedGroupFixture.renewalA,
            )!.newLinkId,
          ],
        }),
        expect.objectContaining({
          renewalId: preallocatedGroupFixture.renewalB,
          state: 'CONTACT_PENDING',
          renewalVersion: 3,
          taskVersion: 1,
          supersededLinkIds: [
            preallocatedPremiumCorrectionResult.data.links.find(
              (link) => link.renewalId === preallocatedGroupFixture.renewalB,
            )!.newLinkId,
          ],
        }),
      ]),
    );
    const groupCorrectionGrantResponse = await groupCorrectionApp.request(
      'https://panel.mayisigorta.com/secure/api/renewals/won-group-renewal-a/won-correction-grants',
      {
        method: 'POST',
        headers: {
          Origin: 'https://panel.mayisigorta.com',
          'Content-Type': 'application/json',
          'X-CSRF-Token': groupCorrectionCsrfToken,
          'Idempotency-Key': 'won-group-correction-grant-key',
        },
        body: JSON.stringify(groupCorrectionInput),
      },
      { ...env, DB: db },
    );
    expect(
      groupCorrectionGrantResponse.status,
      await groupCorrectionGrantResponse.clone().text(),
    ).toBe(201);
    const groupCorrectionGrant = (await groupCorrectionGrantResponse.json()) as {
      data: { grantEvidenceToken: string };
    };
    const groupCorrectionResponse = await groupCorrectionApp.request(
      'https://panel.mayisigorta.com/secure/api/renewals/won-group-renewal-a/correct-won',
      {
        method: 'POST',
        headers: {
          Origin: 'https://panel.mayisigorta.com',
          'Content-Type': 'application/json',
          'X-CSRF-Token': groupCorrectionCsrfToken,
          'Idempotency-Key': 'won-group-correction-command-key',
        },
        body: JSON.stringify({
          ...groupCorrectionInput,
          grantEvidenceToken: groupCorrectionGrant.data.grantEvidenceToken,
        }),
      },
      { ...env, DB: db },
    );
    expect(groupCorrectionResponse.status, await groupCorrectionResponse.clone().text()).toBe(200);
    const correctionResult = (await groupCorrectionResponse.json()) as {
      data: {
        operationId: string;
        groupOperationId: string;
        renewals: Array<{
          renewalId: string;
          state: string;
          renewalVersion: number;
          taskVersion: number;
          supersededLinkIds: string[];
          preservedPolicyIds: string[];
        }>;
      };
      replayed: boolean;
    };
    expect(correctionResult.data.groupOperationId).toBe(winnerBody.data.operationId);
    expect(correctionResult.data.renewals).toHaveLength(2);
    expect(
      correctionResult.data.renewals.every(
        (item) =>
          item.state === 'CONTACT_PENDING' &&
          item.renewalVersion === 3 &&
          item.taskVersion === 1 &&
          item.supersededLinkIds.length === 1,
      ),
    ).toBe(true);
    const correctedGroupEffects = await db
      .prepare(
        `SELECT
          (SELECT count(*) FROM renewal_opportunities WHERE id IN ('won-group-renewal-a','won-group-renewal-b')
            AND state='CONTACT_PENDING' AND version=3) AS renewals,
          (SELECT count(*) FROM tasks WHERE renewal_id IN ('won-group-renewal-a','won-group-renewal-b')
            AND status='OPEN' AND version=1) AS open_tasks,
          (SELECT count(*) FROM renewal_policy_links WHERE renewal_id IN ('won-group-renewal-a','won-group-renewal-b')
            AND status='SUPERSEDED' AND superseded_operation_id=?) AS links,
          (SELECT count(*) FROM policies WHERE id IN ('won-group-old-policy-a','won-group-old-policy-b','won-group-new-policy')
            AND status='ACTIVE') AS policies,
          (SELECT count(*) FROM renewal_state_history WHERE renewal_id IN ('won-group-renewal-a','won-group-renewal-b')
            AND to_state='WON') AS won_history,
          (SELECT count(*) FROM renewal_state_history WHERE renewal_id IN ('won-group-renewal-a','won-group-renewal-b')
            AND reason_code='WON_CORRECTED') AS correction_history,
          (SELECT count(*) FROM audit_events WHERE action='renewal.won.corrected'
            AND target_id IN ('won-group-renewal-a','won-group-renewal-b') AND idempotency_key=?) AS correction_audits`,
      )
      .bind(correctionResult.data.operationId, 'won-group-correction-command-key')
      .first();
    expect(correctedGroupEffects).toEqual({
      renewals: 2,
      open_tasks: 2,
      links: 2,
      policies: 3,
      won_history: 2,
      correction_history: 2,
      correction_audits: 2,
    });
    const correctionReplay = await groupCorrectionApp.request(
      'https://panel.mayisigorta.com/secure/api/renewals/won-group-renewal-a/correct-won',
      {
        method: 'POST',
        headers: {
          Origin: 'https://panel.mayisigorta.com',
          'Content-Type': 'application/json',
          'X-CSRF-Token': groupCorrectionCsrfToken,
          'Idempotency-Key': 'won-group-correction-command-key',
        },
        body: JSON.stringify({
          ...groupCorrectionInput,
          grantEvidenceToken: groupCorrectionGrant.data.grantEvidenceToken,
        }),
      },
      { ...env, DB: db },
    );
    expect(correctionReplay.status, await correctionReplay.clone().text()).toBe(200);
    expect(await correctionReplay.json()).toMatchObject({
      data: correctionResult.data,
      replayed: true,
    });
    const originalGroupAfterCorrection = await sendGroup(winnerKey, db, replayPayload, winnerToken);
    expect(
      originalGroupAfterCorrection.status,
      await originalGroupAfterCorrection.clone().text(),
    ).toBe(200);
    expect(await originalGroupAfterCorrection.json()).toMatchObject({
      data: winnerBody.data,
      replayed: true,
    });
    await db
      .prepare(
        `UPDATE policies SET status='CANCELLED',version=version+1 WHERE id='won-group-new-policy'`,
      )
      .run();
    const cancelledPolicyGroupReplay = await sendGroup(winnerKey, db, replayPayload, winnerToken);
    expect(cancelledPolicyGroupReplay.status, await cancelledPolicyGroupReplay.clone().text()).toBe(
      200,
    );
    const cancelledPolicyCorrectionReplay = await groupCorrectionApp.request(
      'https://panel.mayisigorta.com/secure/api/renewals/won-group-renewal-a/correct-won',
      {
        method: 'POST',
        headers: {
          Origin: 'https://panel.mayisigorta.com',
          'Content-Type': 'application/json',
          'X-CSRF-Token': groupCorrectionCsrfToken,
          'Idempotency-Key': 'won-group-correction-command-key',
        },
        body: JSON.stringify({
          ...groupCorrectionInput,
          grantEvidenceToken: groupCorrectionGrant.data.grantEvidenceToken,
        }),
      },
      { ...env, DB: db },
    );
    expect(
      cancelledPolicyCorrectionReplay.status,
      await cancelledPolicyCorrectionReplay.clone().text(),
    ).toBe(200);

    const crossCustomerGroup = await seedGroupFixture('won-group-cross-customer', true);
    const crossCustomerGrantResponse = await groupCorrectionApp.request(
      'https://panel.mayisigorta.com/secure/api/renewals/won-group/grants',
      {
        method: 'POST',
        headers: {
          Origin: 'https://panel.mayisigorta.com',
          'Content-Type': 'application/json',
          'X-CSRF-Token': groupCorrectionCsrfToken,
          'Idempotency-Key': 'won-group-cross-customer-grant-key',
        },
        body: JSON.stringify(crossCustomerGroup.input),
      },
      { ...env, DB: db },
    );
    expect(crossCustomerGrantResponse.status, await crossCustomerGrantResponse.clone().text()).toBe(
      201,
    );
    const crossCustomerGrant = (await crossCustomerGrantResponse.json()) as {
      data: { grantEvidenceToken: string };
    };
    const crossCustomerWonResponse = await groupCorrectionApp.request(
      'https://panel.mayisigorta.com/secure/api/renewals/won-group',
      {
        method: 'POST',
        headers: {
          Origin: 'https://panel.mayisigorta.com',
          'Content-Type': 'application/json',
          'X-CSRF-Token': groupCorrectionCsrfToken,
          'Idempotency-Key': 'won-group-cross-customer-operation-key',
        },
        body: JSON.stringify({
          ...crossCustomerGroup.input,
          grantEvidenceToken: crossCustomerGrant.data.grantEvidenceToken,
        }),
      },
      { ...env, DB: db },
    );
    expect(crossCustomerWonResponse.status, await crossCustomerWonResponse.clone().text()).toBe(
      201,
    );
    const crossLinks = await db
      .prepare(
        `SELECT r.id AS renewal_id,old.customer_id AS renewal_customer_id,
                link.new_policy_id,linked.customer_id AS linked_customer_id,
                link.different_policyholder_reason_code,link.status
         FROM renewal_opportunities r
         JOIN policies old ON old.id=r.expiring_policy_id AND old.agency_id=r.agency_id
         JOIN renewal_policy_links link ON link.renewal_id=r.id AND link.agency_id=r.agency_id
         JOIN policies linked ON linked.id=link.new_policy_id AND linked.agency_id=link.agency_id
         WHERE r.id IN (?,?) ORDER BY r.id`,
      )
      .bind(crossCustomerGroup.renewalA, crossCustomerGroup.renewalB)
      .all();
    expect(crossLinks).toMatchObject({
      results: [
        {
          renewal_id: crossCustomerGroup.renewalA,
          renewal_customer_id: 'terminal-customer',
          linked_customer_id: 'terminal-customer',
          different_policyholder_reason_code: null,
          status: 'ACTIVE',
        },
        {
          renewal_id: crossCustomerGroup.renewalB,
          renewal_customer_id: `${crossCustomerGroup.renewalB.replace('-renewal-b', '')}-customer-b`,
          linked_customer_id: `${crossCustomerGroup.renewalB.replace('-renewal-b', '')}-customer-b`,
          different_policyholder_reason_code: null,
          status: 'ACTIVE',
        },
      ],
    });
    await db
      .prepare(
        `INSERT INTO membership_permissions(id,membership_id,permission_code,scope)
         -- task.create is catalogued as UNSCOPED; record access is checked separately.
         VALUES('terminal-won-group-renewal-update','terminal-won-membership','renewal.update','AGENCY'),
               ('terminal-won-group-task-create','terminal-won-membership','task.create','UNSCOPED')`,
      )
      .run();
    expect(
      await db
        .prepare(
          `SELECT scope FROM membership_permissions
           WHERE membership_id='terminal-won-membership' AND permission_code='task.create'`,
        )
        .first(),
    ).toEqual({ scope: 'UNSCOPED' });
    const crossCustomerCorrectionGrantResponse = await groupApp.request(
      `https://panel.mayisigorta.com/secure/api/renewals/${crossCustomerGroup.renewalA}/won-correction-grants`,
      {
        method: 'POST',
        headers: {
          Origin: 'https://panel.mayisigorta.com',
          'Content-Type': 'application/json',
          'X-CSRF-Token': groupCsrf,
          'Idempotency-Key': 'won-group-cross-customer-correction-grant-key',
        },
        body: JSON.stringify(groupCorrectionInput),
      },
      { ...env, DB: db },
    );
    expect(
      crossCustomerCorrectionGrantResponse.status,
      await crossCustomerCorrectionGrantResponse.clone().text(),
    ).toBe(201);
    const crossCustomerCorrectionGrant = (await crossCustomerCorrectionGrantResponse.json()) as {
      data: { grantEvidenceToken: string };
    };
    const crossCustomerCorrectionResponse = await groupApp.request(
      `https://panel.mayisigorta.com/secure/api/renewals/${crossCustomerGroup.renewalA}/correct-won`,
      {
        method: 'POST',
        headers: {
          Origin: 'https://panel.mayisigorta.com',
          'Content-Type': 'application/json',
          'X-CSRF-Token': groupCsrf,
          'Idempotency-Key': 'won-group-cross-customer-correction-key',
        },
        body: JSON.stringify({
          ...groupCorrectionInput,
          grantEvidenceToken: crossCustomerCorrectionGrant.data.grantEvidenceToken,
        }),
      },
      { ...env, DB: db },
    );
    expect(
      crossCustomerCorrectionResponse.status,
      await crossCustomerCorrectionResponse.clone().text(),
    ).toBe(200);

    await db
      .prepare(
        `UPDATE agency_memberships
         SET version=version+1,permission_version=permission_version+1
         WHERE id='terminal-won-membership'`,
      )
      .run();
    const authorityLostReplay = await sendGroup(winnerKey, db, replayPayload, winnerToken);
    expect(authorityLostReplay.status).toBe(403);
  }, 180_000);
});
