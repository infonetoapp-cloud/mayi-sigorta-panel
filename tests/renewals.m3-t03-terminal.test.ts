// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import miniflare from 'miniflare';
import { createApp, type Env } from '../src/server/index';
import { closeRenewalLost, voidRenewal } from '../src/server/renewals/commands';
import type { AuthenticatedUserContext } from '../src/server/auth/identity';
import type { VerifiedAccessPrincipal } from '../src/server/auth/types';

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
const principal = { subject: 'terminal-subject' } as VerifiedAccessPrincipal;
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
const memberPrincipal = { subject: 'terminal-member-subject' } as VerifiedAccessPrincipal;

function terminalApp(
  context: AuthenticatedUserContext = actor,
  verifiedPrincipal: VerifiedAccessPrincipal = principal,
) {
  return createApp({
    createVerifier: (config) => ({ config, verify: async () => verifiedPrincipal }),
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
              .bind(scope, 'terminal-member-membership', permissionCode)
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
      CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
      CF_ACCESS_AUDIENCE: 'normal-audience',
      CF_ACCESS_SECURE_AUDIENCE: 'secure-audience',
      CSRF_SECRET: 'test-csrf-secret-that-is-long-enough',
    } satisfies Env;
    const app = terminalApp();
    const csrfResponse = await app.request(
      'https://panel.mayisigorta.test/api/csrf-token',
      { method: 'GET' },
      env,
    );
    csrf = ((await csrfResponse.json()) as { data: { token: string } }).data.token;
    const memberCsrfResponse = await terminalApp(memberActor, memberPrincipal).request(
      'https://panel.mayisigorta.test/api/csrf-token',
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
        'https://panel.mayisigorta.test/api/renewals/terminal-renewal/close-lost',
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
      'https://panel.mayisigorta.test/api/renewals/terminal-renewal/close-lost',
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
      'https://panel.mayisigorta.test/api/renewals/terminal-renewal/reopen',
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
      'https://panel.mayisigorta.test/api/renewals/terminal-renewal/reopen',
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
      'https://panel.mayisigorta.test/api/renewals/terminal-renewal/reopen',
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
      'https://panel.mayisigorta.test/api/renewals/terminal-renewal/reopen',
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
      'https://panel.mayisigorta.test/api/renewals/terminal-renewal/reopen',
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
      `https://panel.mayisigorta.test/api/renewals/terminal-renewal/tasks/${envelope.data.primaryTaskId}/assign`,
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
      expectedRenewalVersion: 1,
      expectedTaskVersion: 1,
      voidReasonCode: 'TECHNICAL_ERROR' as const,
    };
    const sendVoid = (
      body: Record<string, unknown> = payload,
      idempotencyKey = 'terminal-close-void-key',
    ) =>
      terminalApp().request(
        'https://panel.mayisigorta.test/api/renewals/terminal-void-renewal/void',
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
        'https://panel.mayisigorta.test/api/renewals/terminal-void-renewal/reopen',
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
      expectedRenewalVersion: 1,
      expectedTaskVersion: 1,
      lossReasonId: 'terminal-loss-price',
      lossReasonNotes: null,
    };
    const voidPayload = {
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

    const replay = await terminalApp().request(
      'https://panel.mayisigorta.test/api/renewals/terminal-renewal/close-lost',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'terminal-close-lost-key',
        },
        body: JSON.stringify({
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
  });
});
