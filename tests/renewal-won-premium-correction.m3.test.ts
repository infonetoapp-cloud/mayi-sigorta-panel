// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import miniflare from 'miniflare';
import { createApp, type Env } from '../src/server/index';
import type { AuthenticatedUserContext } from '../src/server/auth/identity';
import type { VerifiedAccessPrincipal } from '../src/server/auth/types';
import { correctWonPolicyPremium } from '../src/server/renewals/won-premium-correction';

const { Miniflare, convertV4MiniflareOptions } = miniflare;
const root = resolve(__dirname, '..');
const owner: AuthenticatedUserContext = {
  userId: 'premium-owner-user',
  identityId: 'premium-owner-identity',
  assurance: 'SECURE',
  memberships: [
    {
      id: 'premium-owner-membership',
      agencyId: 'premium-agency',
      type: 'OWNER',
      status: 'ACTIVE',
      permissionVersion: 2,
    },
  ],
};
const principal = { subject: 'premium-owner-subject' } as VerifiedAccessPrincipal;

function createTestApp(context = owner) {
  return createApp({
    createVerifier: (config) => ({ config, verify: async () => principal }),
    createResolver: () => ({ resolve: async () => context }) as never,
  });
}

describe('M3 WON Policy premium correction on local D1', () => {
  let mf: miniflare.Miniflare;
  let db: D1Database;
  let env: Env;
  let csrf: string;
  const app = createTestApp();

  beforeAll(async () => {
    vi.useFakeTimers();
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: 'export default { fetch() { return new Response(null); } }',
        d1Databases: { DB: '00000000-0000-0000-0000-000000000114' },
      }),
    );
    db = await mf.getD1Database('DB');
    const now = await db
      .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now")
      .first<{ now: string }>();
    if (!now?.now) throw new Error('LOCAL_D1_CLOCK_UNAVAILABLE');
    vi.setSystemTime(new Date(now.now));
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
      db.prepare("INSERT INTO agencies(id,status) VALUES('premium-agency','PROVISIONING')"),
      db.prepare("INSERT INTO users(id,status,version) VALUES('premium-owner-user','INACTIVE',1)"),
      db.prepare(
        `INSERT INTO agency_memberships
           (id,agency_id,user_id,type,status,permission_version,version,invitation_email,
            invitation_expires_at)
         VALUES('premium-owner-membership','premium-agency','premium-owner-user','OWNER','INVITED',1,1,
           'premium-owner@test.test','2099-01-01T00:00:00.000Z')`,
      ),
      db.prepare(
        `INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email,status)
         VALUES('premium-owner-identity','premium-owner-user','https://team.cloudflareaccess.com',
           'premium-owner-subject','premium-owner@test.test','ACTIVE')`,
      ),
    ]);
    await db
      .prepare("UPDATE users SET status='ACTIVE',version=2 WHERE id='premium-owner-user'")
      .run();
    await db
      .prepare(
        `UPDATE agency_memberships SET status='ACTIVE',activated_at='2026-01-01T00:00:00.000Z',
           permission_version=2,version=2 WHERE id='premium-owner-membership'`,
      )
      .run();
    await db
      .prepare(
        `UPDATE agencies SET status='ACTIVE',bootstrap_completed_at='2026-01-01T00:00:00.000Z',
           activated_at='2026-01-01T00:00:00.000Z',version=2 WHERE id='premium-agency'`,
      )
      .run();
    await db.batch([
      db.prepare(
        `INSERT INTO membership_permissions(id,membership_id,permission_code,scope)
         VALUES('premium-customer-read','premium-owner-membership','customer.read','AGENCY'),
               ('premium-policy-read','premium-owner-membership','policy.read','AGENCY'),
               ('premium-policy-update','premium-owner-membership','policy.update','AGENCY'),
               ('premium-renewal-read','premium-owner-membership','renewal.read','AGENCY'),
               ('premium-renewal-update','premium-owner-membership','renewal.update','AGENCY')`,
      ),
      db.prepare(
        `INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id)
         VALUES('premium-customer','premium-agency','INDIVIDUAL','Premium Customer','Premium','Customer',
           'premium-owner-membership')`,
      ),
      db.prepare(
        "INSERT INTO insurers(id,agency_id,code,name) VALUES('premium-insurer','premium-agency','I','Insurer')",
      ),
      db.prepare(
        `INSERT INTO insurance_branches(id,agency_id,code,name,data_classification)
         VALUES('premium-branch','premium-agency','B','Branch','GENERAL')`,
      ),
      db.prepare(
        `INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name)
         VALUES('premium-product','premium-agency','premium-insurer','premium-branch','P','Product')`,
      ),
      db.prepare(
        "INSERT INTO payment_methods(id,agency_id,code,name) VALUES('premium-payment','premium-agency','PM','Cash')",
      ),
    ]);
    await db.batch([
      db.prepare(
        `INSERT INTO policies
           (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
            assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
            gross_premium_minor,currency,version)
         VALUES('premium-old-policy','premium-agency','premium-customer','premium-insurer',
           'premium-product','premium-branch','premium-payment','premium-owner-membership',
           'PREMIUM-OLD','PREMIUMOLD','2025-10-25','2026-10-24',10000,'TRY',1),
              ('premium-new-policy','premium-agency','premium-customer','premium-insurer',
           'premium-product','premium-branch','premium-payment','premium-owner-membership',
           'PREMIUM-NEW','PREMIUMNEW','2026-10-25','2027-10-24',10000,'TRY',1)`,
      ),
      db.prepare(
        `INSERT INTO renewal_opportunities
           (id,agency_id,expiring_policy_id,assignee_membership_id,state,version,closed_at,
            closed_by_membership_id,created_at,updated_at)
         VALUES('premium-renewal','premium-agency','premium-old-policy','premium-owner-membership',
           'CONTACT_PENDING',1,NULL,NULL,
           '2026-09-24T06:00:00.000Z','2026-09-24T06:00:00.000Z')`,
      ),
      db.prepare(
        `INSERT INTO renewal_state_history
           (id,agency_id,renewal_id,from_state,to_state,actor_kind,actor_user_id,
            actor_membership_id,reason_code,created_at)
         VALUES('premium-initial-history','premium-agency','premium-renewal',NULL,'CONTACT_PENDING',
           'SYSTEM',NULL,NULL,'POLICY_EXPIRING','2026-09-24T06:00:00.000Z')`,
      ),
      db.prepare(
        `INSERT INTO operation_receipts
           (id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,payload_fingerprint,
            status,response_status,response_body)
         VALUES('premium-allocation-operation','premium-agency','premium-owner-user',
           'premium-owner-membership','renewal.policy_links.allocate','premium-allocation-key',
           '${'a'.repeat(64)}','COMPLETED',201,'{}')`,
      ),
      db.prepare(
        `INSERT INTO renewal_policy_links
           (id,agency_id,renewal_id,new_policy_id,allocated_new_premium_minor,currency,
            allocation_operation_id,created_by_membership_id,created_at)
         VALUES('premium-original-link','premium-agency','premium-renewal','premium-new-policy',
           10000,'TRY','premium-allocation-operation','premium-owner-membership',
           '2026-09-24T06:00:00.000Z')`,
      ),
    ]);
    await db.batch([
      db.prepare(
        `UPDATE renewal_opportunities
         SET state='WON',closed_at='2026-09-24T06:00:00.000Z',
             closed_by_membership_id='premium-owner-membership',version=2,
             updated_at='2026-09-24T06:00:00.000Z'
         WHERE id='premium-renewal' AND state='CONTACT_PENDING' AND version=1`,
      ),
      db.prepare(
        `INSERT INTO renewal_state_history
         (id,agency_id,renewal_id,from_state,to_state,actor_kind,actor_user_id,
          actor_membership_id,reason_code,created_at)
         VALUES('premium-won-history','premium-agency','premium-renewal','CONTACT_PENDING','WON',
           'USER','premium-owner-user','premium-owner-membership','WON','2026-09-24T06:00:00.000Z')`,
      ),
    ]);
    env = {
      DB: db,
      CF_ACCESS_TEAM_DOMAIN: 'team.cloudflareaccess.com',
      CF_ACCESS_AUDIENCE: 'normal-audience',
      CF_ACCESS_SECURE_AUDIENCE: 'secure-audience',
      CSRF_SECRET: 'test-csrf-secret-that-is-long-enough',
    } satisfies Env;
    const csrfResponse = await app.request(
      'https://panel.mayisigorta.test/api/csrf-token',
      {},
      env,
    );
    csrf = ((await csrfResponse.json()) as { data: { token: string } }).data.token;
  });

  afterAll(async () => {
    vi.useRealTimers();
    await mf.dispose();
  });

  it('corrects all WON allocations atomically while preserving Policy identity and completed-replay semantics', async () => {
    const payload = {
      expectedPolicyVersion: 1,
      correctedPremiumMinor: 12000,
      reasonCode: 'PREMIUM_RECONCILIATION',
      allocations: [
        {
          linkId: 'premium-original-link',
          expectedRenewalVersion: 2,
          allocatedPremiumMinor: 12000,
        },
      ],
    };
    const send = (
      body: unknown,
      key = 'premium-correction-operation-key',
      policyId = 'premium-new-policy',
    ) =>
      app.request(
        `https://panel.mayisigorta.test/secure/api/policies/${policyId}/correct-won-premium`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://panel.mayisigorta.com',
            'X-CSRF-Token': csrf,
            'Idempotency-Key': key,
          },
          body: JSON.stringify(body),
        },
        env,
      );
    const first = await send(payload);
    expect(first.status, await first.clone().text()).toBe(200);
    const firstEnvelope = (await first.json()) as {
      data: {
        operationId: string;
        policyId: string;
        previousPremiumMinor: number;
        correctedPremiumMinor: number;
        links: Array<{ supersededLinkId: string; newLinkId: string; renewalId: string }>;
      };
      replayed: boolean;
    };
    expect(firstEnvelope.replayed).toBe(false);
    expect(firstEnvelope.data).toMatchObject({
      policyId: 'premium-new-policy',
      previousPremiumMinor: 10000,
      correctedPremiumMinor: 12000,
      links: [
        expect.objectContaining({
          supersededLinkId: 'premium-original-link',
          renewalId: 'premium-renewal',
        }),
      ],
    });
    expect(
      await db
        .prepare(
          `SELECT p.id,p.status,p.gross_premium_minor,p.version,
                  (SELECT count(*) FROM policies WHERE id='premium-old-policy') AS old_policy,
                  (SELECT count(*) FROM renewal_opportunities WHERE id='premium-renewal' AND state='WON') AS won_renewal,
                  (SELECT count(*) FROM renewal_policy_links WHERE id='premium-original-link' AND status='SUPERSEDED') AS old_link,
                  (SELECT count(*) FROM renewal_policy_links WHERE supersedes_link_id='premium-original-link'
                    AND status='ACTIVE' AND allocated_new_premium_minor=12000) AS replacement_links,
                  (SELECT count(*) FROM renewal_won_policy_premium_corrections WHERE id=?) AS correction_evidence,
                  (SELECT count(*) FROM audit_events WHERE idempotency_key='premium-correction-operation-key'
                    AND action='renewal.won.premium.corrected' AND outcome='SUCCESS') AS success_audits
           FROM policies p WHERE p.id='premium-new-policy'`,
        )
        .bind(firstEnvelope.data.operationId)
        .first(),
    ).toEqual({
      id: 'premium-new-policy',
      status: 'ACTIVE',
      gross_premium_minor: 12000,
      version: 2,
      old_policy: 1,
      won_renewal: 1,
      old_link: 1,
      replacement_links: 1,
      correction_evidence: 1,
      success_audits: 1,
    });
    const directReplay = await correctWonPolicyPremium(
      owner,
      db,
      'premium-new-policy',
      payload,
      'premium-correction-operation-key',
    );
    expect(directReplay.replayed).toBe(true);
    const replay = await send(payload);
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toMatchObject({ data: firstEnvelope.data, replayed: true });
    const changedPayload = await send({ ...payload, reasonCode: 'CHANGED_REASON' });
    expect(changedPayload.status).toBe(409);
    await db.batch([
      db.prepare(
        `INSERT INTO policies
           (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
            assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
            gross_premium_minor,currency,version)
         VALUES('premium-rollback-old-policy','premium-agency','premium-customer','premium-insurer',
           'premium-product','premium-branch','premium-payment','premium-owner-membership',
           'PREMIUM-ROLLBACK-OLD','PREMIUMROLLBACKOLD','2025-10-26','2026-10-25',10000,'TRY',1),
              ('premium-rollback-new-policy','premium-agency','premium-customer','premium-insurer',
           'premium-product','premium-branch','premium-payment','premium-owner-membership',
           'PREMIUM-ROLLBACK-NEW','PREMIUMROLLBACKNEW','2026-10-26','2027-10-25',10000,'TRY',1)`,
      ),
      db.prepare(
        `INSERT INTO renewal_opportunities
           (id,agency_id,expiring_policy_id,assignee_membership_id,state,version,created_at,updated_at)
         VALUES('premium-rollback-renewal','premium-agency','premium-rollback-old-policy',
           'premium-owner-membership','CONTACT_PENDING',1,'2026-09-24T06:00:00.000Z',
           '2026-09-24T06:00:00.000Z')`,
      ),
      db.prepare(
        `INSERT INTO renewal_state_history
           (id,agency_id,renewal_id,from_state,to_state,actor_kind,reason_code,created_at)
         VALUES('premium-rollback-initial-history','premium-agency','premium-rollback-renewal',
           NULL,'CONTACT_PENDING','SYSTEM','POLICY_EXPIRING','2026-09-24T06:00:00.000Z')`,
      ),
      db.prepare(
        `INSERT INTO operation_receipts
           (id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,
            payload_fingerprint,status,response_status,response_body)
         VALUES('premium-rollback-allocation','premium-agency','premium-owner-user',
           'premium-owner-membership','renewal.policy_links.allocate','premium-rollback-allocation-key',
           '${'c'.repeat(64)}','COMPLETED',201,'{}')`,
      ),
      db.prepare(
        `INSERT INTO renewal_policy_links
           (id,agency_id,renewal_id,new_policy_id,allocated_new_premium_minor,currency,
            allocation_operation_id,created_by_membership_id,created_at)
         VALUES('premium-rollback-link','premium-agency','premium-rollback-renewal',
           'premium-rollback-new-policy',10000,'TRY','premium-rollback-allocation',
           'premium-owner-membership','2026-09-24T06:00:00.000Z')`,
      ),
    ]);
    await db.batch([
      db.prepare(
        `UPDATE renewal_opportunities
         SET state='WON',closed_at='2026-09-24T06:00:00.000Z',
             closed_by_membership_id='premium-owner-membership',version=2,
             updated_at='2026-09-24T06:00:00.000Z'
         WHERE id='premium-rollback-renewal' AND state='CONTACT_PENDING' AND version=1`,
      ),
      db.prepare(
        `INSERT INTO renewal_state_history
         (id,agency_id,renewal_id,from_state,to_state,actor_kind,actor_user_id,
          actor_membership_id,reason_code,created_at)
         VALUES('premium-rollback-won-history','premium-agency','premium-rollback-renewal',
           'CONTACT_PENDING','WON','USER','premium-owner-user','premium-owner-membership','WON',
           '2026-09-24T06:00:00.000Z')`,
      ),
    ]);
    const rollbackPayload = {
      expectedPolicyVersion: 1,
      correctedPremiumMinor: 11000,
      reasonCode: 'ROLLBACK_TEST',
      allocations: [
        {
          linkId: 'premium-rollback-link',
          expectedRenewalVersion: 2,
          allocatedPremiumMinor: 11000,
        },
      ],
    };
    await db
      .prepare(
        `CREATE TRIGGER fail_premium_correction_audit
         BEFORE INSERT ON audit_events
         WHEN NEW.action='renewal.won.premium.corrected'
           AND NEW.target_id='premium-rollback-new-policy'
         BEGIN SELECT RAISE(ABORT,'INJECTED_PREMIUM_CORRECTION_AUDIT_FAILURE'); END`,
      )
      .run();
    const failedCorrection = await send(
      rollbackPayload,
      'premium-rollback-operation-key',
      'premium-rollback-new-policy',
    );
    expect(failedCorrection.status, await failedCorrection.clone().text()).toBe(500);
    await db.prepare('DROP TRIGGER fail_premium_correction_audit').run();
    expect(
      await db
        .prepare(
          `SELECT p.gross_premium_minor,p.version,
                  (SELECT count(*) FROM renewal_policy_links WHERE id='premium-rollback-link'
                    AND status='ACTIVE') AS old_link,
                  (SELECT count(*) FROM renewal_policy_links WHERE supersedes_link_id='premium-rollback-link') AS new_links,
                  (SELECT count(*) FROM renewal_won_policy_premium_corrections
                    WHERE policy_id='premium-rollback-new-policy') AS corrections,
                  (SELECT count(*) FROM operation_receipts
                    WHERE idempotency_key='premium-rollback-operation-key') AS receipts,
                  (SELECT count(*) FROM audit_events
                    WHERE idempotency_key='premium-rollback-operation-key'
                      AND action='renewal.won.premium.corrected') AS audits
           FROM policies p WHERE p.id='premium-rollback-new-policy'`,
        )
        .first(),
    ).toEqual({
      gross_premium_minor: 10000,
      version: 1,
      old_link: 1,
      new_links: 0,
      corrections: 0,
      receipts: 0,
      audits: 0,
    });
    const retryCorrection = await send(
      rollbackPayload,
      'premium-rollback-operation-key',
      'premium-rollback-new-policy',
    );
    expect(retryCorrection.status, await retryCorrection.clone().text()).toBe(200);
    expect(
      await db
        .prepare(
          `SELECT
             (SELECT count(*) FROM operation_receipts WHERE idempotency_key='premium-correction-operation-key'
               AND action='renewal.won.premium.correct') AS receipts,
             (SELECT count(*) FROM audit_events WHERE idempotency_key='premium-correction-operation-key'
               AND action='renewal.won.premium.corrected') AS audits,
             (SELECT count(*) FROM renewal_policy_links WHERE new_policy_id='premium-new-policy'
               AND status='ACTIVE') AS active_links`,
        )
        .first(),
    ).toEqual({ receipts: 1, audits: 1, active_links: 1 });
  });

  it('rebalances a split at the same total without double-counting and rejects an exact no-op', async () => {
    const now = '2026-09-24T06:00:00.000Z';
    await db.batch([
      db.prepare(
        `INSERT INTO policies
           (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
            assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
            gross_premium_minor,currency,version)
         VALUES('premium-split-old-policy-a','premium-agency','premium-customer','premium-insurer',
           'premium-product','premium-branch','premium-payment','premium-owner-membership',
           'PREMIUM-SPLIT-OLD-A','PREMIUMSPLITOLDA','2025-10-25','2026-10-24',6000,'TRY',1),
              ('premium-split-old-policy-b','premium-agency','premium-customer','premium-insurer',
           'premium-product','premium-branch','premium-payment','premium-owner-membership',
           'PREMIUM-SPLIT-OLD-B','PREMIUMSPLITOLDB','2025-10-25','2026-10-24',4000,'TRY',1),
              ('premium-split-new-policy','premium-agency','premium-customer','premium-insurer',
           'premium-product','premium-branch','premium-payment','premium-owner-membership',
           'PREMIUM-SPLIT-NEW','PREMIUMSPLITNEW','2026-10-25','2027-10-24',10000,'TRY',1)`,
      ),
      db
        .prepare(
          `INSERT INTO renewal_opportunities
           (id,agency_id,expiring_policy_id,assignee_membership_id,state,version,created_at,updated_at)
         VALUES('premium-split-renewal-a','premium-agency','premium-split-old-policy-a',
           'premium-owner-membership','CONTACT_PENDING',1,?,?),
              ('premium-split-renewal-b','premium-agency','premium-split-old-policy-b',
           'premium-owner-membership','CONTACT_PENDING',1,?,?)`,
        )
        .bind(now, now, now, now),
      db
        .prepare(
          `INSERT INTO renewal_state_history
           (id,agency_id,renewal_id,from_state,to_state,actor_kind,reason_code,created_at)
         VALUES('premium-split-initial-a','premium-agency','premium-split-renewal-a',NULL,
           'CONTACT_PENDING','SYSTEM','POLICY_EXPIRING',?),
              ('premium-split-initial-b','premium-agency','premium-split-renewal-b',NULL,
           'CONTACT_PENDING','SYSTEM','POLICY_EXPIRING',?)`,
        )
        .bind(now, now),
      db
        .prepare(
          `INSERT INTO operation_receipts
           (id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,payload_fingerprint,
            status,response_status,response_body,created_at,updated_at)
         VALUES('premium-split-allocation','premium-agency','premium-owner-user',
           'premium-owner-membership','renewal.policy_links.allocate','premium-split-allocation-key',
           '${'d'.repeat(64)}','COMPLETED',201,'{}',?,?)`,
        )
        .bind(now, now),
      db
        .prepare(
          `INSERT INTO renewal_policy_links
           (id,agency_id,renewal_id,new_policy_id,allocated_new_premium_minor,currency,
            allocation_operation_id,created_by_membership_id,created_at)
         VALUES('premium-split-link-a','premium-agency','premium-split-renewal-a',
           'premium-split-new-policy',6000,'TRY','premium-split-allocation',
           'premium-owner-membership',?),
              ('premium-split-link-b','premium-agency','premium-split-renewal-b',
           'premium-split-new-policy',4000,'TRY','premium-split-allocation',
           'premium-owner-membership',?)`,
        )
        .bind(now, now),
    ]);
    await db.batch([
      db
        .prepare(
          `UPDATE renewal_opportunities
         SET state='WON',closed_at=?,closed_by_membership_id='premium-owner-membership',version=2,updated_at=?
         WHERE id IN ('premium-split-renewal-a','premium-split-renewal-b') AND state='CONTACT_PENDING' AND version=1`,
        )
        .bind(now, now),
      db
        .prepare(
          `INSERT INTO renewal_state_history
           (id,agency_id,renewal_id,from_state,to_state,actor_kind,actor_user_id,
            actor_membership_id,reason_code,created_at)
         VALUES('premium-split-won-a','premium-agency','premium-split-renewal-a','CONTACT_PENDING','WON',
           'USER','premium-owner-user','premium-owner-membership','WON',?),
              ('premium-split-won-b','premium-agency','premium-split-renewal-b','CONTACT_PENDING','WON',
           'USER','premium-owner-user','premium-owner-membership','WON',?)`,
        )
        .bind(now, now),
    ]);

    const send = (body: unknown, key: string) =>
      app.request(
        'https://panel.mayisigorta.test/secure/api/policies/premium-split-new-policy/correct-won-premium',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://panel.mayisigorta.com',
            'X-CSRF-Token': csrf,
            'Idempotency-Key': key,
          },
          body: JSON.stringify(body),
        },
        env,
      );
    const payload = {
      expectedPolicyVersion: 1,
      correctedPremiumMinor: 10000,
      reasonCode: 'SPLIT_REALLOCATION',
      allocations: [
        {
          linkId: 'premium-split-link-a',
          expectedRenewalVersion: 2,
          allocatedPremiumMinor: 7000,
        },
        {
          linkId: 'premium-split-link-b',
          expectedRenewalVersion: 2,
          allocatedPremiumMinor: 3000,
        },
      ],
    };
    const response = await send(payload, 'premium-split-reallocation-key');
    expect(response.status, await response.clone().text()).toBe(200);
    const result = (await response.json()) as {
      data: {
        links: Array<{
          supersededLinkId: string;
          newLinkId: string;
          renewalId: string;
          allocatedPremiumMinor: number;
        }>;
      };
    };
    expect(result.data.links).toEqual([
      expect.objectContaining({
        supersededLinkId: 'premium-split-link-a',
        renewalId: 'premium-split-renewal-a',
        allocatedPremiumMinor: 7000,
      }),
      expect.objectContaining({
        supersededLinkId: 'premium-split-link-b',
        renewalId: 'premium-split-renewal-b',
        allocatedPremiumMinor: 3000,
      }),
    ]);
    expect(
      await db
        .prepare(
          `SELECT p.gross_premium_minor,p.version,
                  (SELECT count(*) FROM policies WHERE id IN ('premium-split-old-policy-a','premium-split-old-policy-b')) AS old_policies,
                  (SELECT count(*) FROM renewal_policy_links WHERE new_policy_id='premium-split-new-policy'
                    AND status='SUPERSEDED') AS superseded_links,
                  (SELECT count(*) FROM renewal_policy_links WHERE new_policy_id='premium-split-new-policy'
                    AND status='ACTIVE') AS active_links,
                  (SELECT sum(allocated_new_premium_minor) FROM renewal_policy_links
                    WHERE new_policy_id='premium-split-new-policy' AND status='ACTIVE') AS active_total,
                  (SELECT count(*) FROM renewal_won_policy_premium_corrections
                    WHERE policy_id='premium-split-new-policy') AS corrections
           FROM policies p WHERE p.id='premium-split-new-policy'`,
        )
        .first(),
    ).toEqual({
      gross_premium_minor: 10000,
      version: 2,
      old_policies: 2,
      superseded_links: 2,
      active_links: 2,
      active_total: 10000,
      corrections: 1,
    });

    const noOp = await send(
      {
        expectedPolicyVersion: 2,
        correctedPremiumMinor: 10000,
        reasonCode: 'NO_CHANGE',
        allocations: result.data.links.map((link) => ({
          linkId: link.newLinkId,
          expectedRenewalVersion: 2,
          allocatedPremiumMinor: link.allocatedPremiumMinor,
        })),
      },
      'premium-split-noop-key',
    );
    expect(noOp.status).toBe(409);
    expect(await noOp.json()).toMatchObject({ error: { code: 'NO_CHANGE' } });
    expect(
      await db
        .prepare(
          `SELECT count(*) AS count FROM operation_receipts
           WHERE idempotency_key='premium-split-noop-key'`,
        )
        .first(),
    ).toEqual({ count: 0 });
  });

  it('preserves OWNER implicit AGENCY write permission in the final correction assertion', async () => {
    const now = '2026-09-24T06:00:00.000Z';
    await db.batch([
      db.prepare(
        `INSERT INTO policies
           (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
            assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
            gross_premium_minor,currency,version)
         VALUES('premium-owner-old-policy','premium-agency','premium-customer','premium-insurer',
           'premium-product','premium-branch','premium-payment','premium-owner-membership',
           'PREMIUM-OWNER-OLD','PREMIUMOWNEROLD','2025-10-25','2026-10-24',8000,'TRY',1),
              ('premium-owner-policy','premium-agency','premium-customer','premium-insurer',
           'premium-product','premium-branch','premium-payment','premium-owner-membership',
           'PREMIUM-OWNER-NEW','PREMIUMOWNERNEW','2026-10-25','2027-10-24',8000,'TRY',1)`,
      ),
      db
        .prepare(
          `INSERT INTO renewal_opportunities
           (id,agency_id,expiring_policy_id,assignee_membership_id,state,version,created_at,updated_at)
         VALUES('premium-owner-renewal','premium-agency','premium-owner-old-policy',
           'premium-owner-membership','CONTACT_PENDING',1,?,?)`,
        )
        .bind(now, now),
      db
        .prepare(
          `INSERT INTO renewal_state_history
           (id,agency_id,renewal_id,from_state,to_state,actor_kind,reason_code,created_at)
         VALUES('premium-owner-initial-history','premium-agency','premium-owner-renewal',NULL,
           'CONTACT_PENDING','SYSTEM','POLICY_EXPIRING',?)`,
        )
        .bind(now),
      db
        .prepare(
          `INSERT INTO operation_receipts
           (id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,payload_fingerprint,
            status,response_status,response_body,created_at,updated_at)
         VALUES('premium-owner-allocation','premium-agency','premium-owner-user',
           'premium-owner-membership','renewal.policy_links.allocate','premium-owner-allocation-key',
           '${'e'.repeat(64)}','COMPLETED',201,'{}',?,?)`,
        )
        .bind(now, now),
      db
        .prepare(
          `INSERT INTO renewal_policy_links
           (id,agency_id,renewal_id,new_policy_id,allocated_new_premium_minor,currency,
            allocation_operation_id,created_by_membership_id,created_at)
         VALUES('premium-owner-link','premium-agency','premium-owner-renewal',
           'premium-owner-policy',8000,'TRY','premium-owner-allocation',
           'premium-owner-membership',?)`,
        )
        .bind(now),
    ]);
    await db.batch([
      db
        .prepare(
          `UPDATE renewal_opportunities
         SET state='WON',closed_at=?,closed_by_membership_id='premium-owner-membership',version=2,updated_at=?
         WHERE id='premium-owner-renewal' AND state='CONTACT_PENDING' AND version=1`,
        )
        .bind(now, now),
      db
        .prepare(
          `INSERT INTO renewal_state_history
           (id,agency_id,renewal_id,from_state,to_state,actor_kind,actor_user_id,
            actor_membership_id,reason_code,created_at)
         VALUES('premium-owner-won-history','premium-agency','premium-owner-renewal','CONTACT_PENDING','WON',
           'USER','premium-owner-user','premium-owner-membership','WON',?)`,
        )
        .bind(now),
    ]);
    const target = await db
      .prepare(
        `SELECT link.id AS link_id,renewal.version AS renewal_version,policy.version AS policy_version
         FROM renewal_policy_links link
         JOIN renewal_opportunities renewal
           ON renewal.agency_id=link.agency_id AND renewal.id=link.renewal_id
         JOIN policies policy ON policy.agency_id=link.agency_id AND policy.id=link.new_policy_id
         WHERE link.new_policy_id='premium-owner-policy' AND link.status='ACTIVE'`,
      )
      .first<{ link_id: string; renewal_version: number; policy_version: number }>();
    expect(target).toMatchObject({ renewal_version: 2, policy_version: 1 });
    await db
      .prepare(
        `DELETE FROM membership_permissions
         WHERE membership_id='premium-owner-membership'
           AND permission_code IN ('policy.update','renewal.update')`,
      )
      .run();
    try {
      const result = await correctWonPolicyPremium(
        owner,
        db,
        'premium-owner-policy',
        {
          expectedPolicyVersion: 1,
          correctedPremiumMinor: 9000,
          reasonCode: 'OWNER_IMPLICIT_NORMAL',
          allocations: [
            {
              linkId: target!.link_id,
              expectedRenewalVersion: target!.renewal_version,
              allocatedPremiumMinor: 9000,
            },
          ],
        },
        'premium-owner-implicit-correction-key',
      );
      expect(result.replayed).toBe(false);
      expect(result.data).toMatchObject({
        policyId: 'premium-owner-policy',
        previousPremiumMinor: 8000,
        correctedPremiumMinor: 9000,
      });
      expect(
        await db
          .prepare('SELECT gross_premium_minor,version FROM policies WHERE id=?')
          .bind('premium-owner-policy')
          .first(),
      ).toEqual({ gross_premium_minor: 9000, version: 2 });
    } finally {
      await db.batch([
        db.prepare(
          `INSERT INTO membership_permissions(id,membership_id,permission_code,scope)
             VALUES('premium-policy-update','premium-owner-membership','policy.update','AGENCY')`,
        ),
        db.prepare(
          `INSERT INTO membership_permissions(id,membership_id,permission_code,scope)
             VALUES('premium-renewal-update','premium-owner-membership','renewal.update','AGENCY')`,
        ),
      ]);
    }
  });

  it('replays an exact concurrent premium-correction command after the receipt race', async () => {
    const now = '2026-09-24T06:00:00.000Z';
    await db.batch([
      db.prepare(
        `INSERT INTO policies
           (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
            assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
            gross_premium_minor,currency,version)
         VALUES('premium-race-old-policy','premium-agency','premium-customer','premium-insurer',
           'premium-product','premium-branch','premium-payment','premium-owner-membership',
           'PREMIUM-RACE-OLD','PREMIUMRACEOLD','2025-10-25','2026-10-24',10000,'TRY',1),
              ('premium-race-new-policy','premium-agency','premium-customer','premium-insurer',
           'premium-product','premium-branch','premium-payment','premium-owner-membership',
           'PREMIUM-RACE-NEW','PREMIUMRACENEW','2026-10-25','2027-10-24',10000,'TRY',1)`,
      ),
      db
        .prepare(
          `INSERT INTO renewal_opportunities
           (id,agency_id,expiring_policy_id,assignee_membership_id,state,version,closed_at,
            closed_by_membership_id,created_at,updated_at)
         VALUES('premium-race-renewal','premium-agency','premium-race-old-policy',
           'premium-owner-membership','CONTACT_PENDING',1,NULL,NULL,?,?)`,
        )
        .bind(now, now),
      db
        .prepare(
          `INSERT INTO renewal_state_history
         (id,agency_id,renewal_id,from_state,to_state,actor_kind,reason_code,created_at)
         VALUES('premium-race-initial-history','premium-agency','premium-race-renewal',NULL,
           'CONTACT_PENDING','SYSTEM','POLICY_EXPIRING',?)`,
        )
        .bind(now),
      db
        .prepare(
          `INSERT INTO operation_receipts
           (id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,
            payload_fingerprint,status,response_status,response_body,created_at,updated_at)
         VALUES('premium-race-allocation','premium-agency','premium-owner-user',
           'premium-owner-membership','renewal.policy_links.allocate','premium-race-allocation-key',
           ?,'COMPLETED',201,'{}',?,?)`,
        )
        .bind('f'.repeat(64), now, now),
      db
        .prepare(
          `INSERT INTO renewal_policy_links
           (id,agency_id,renewal_id,new_policy_id,allocated_new_premium_minor,currency,
            allocation_operation_id,created_by_membership_id,created_at)
         VALUES('premium-race-link','premium-agency','premium-race-renewal',
           'premium-race-new-policy',10000,'TRY','premium-race-allocation',
           'premium-owner-membership',?)`,
        )
        .bind(now),
    ]);
    await db.batch([
      db
        .prepare(
          `UPDATE renewal_opportunities
           SET state='WON',closed_at=?,closed_by_membership_id='premium-owner-membership',
               version=2,updated_at=? WHERE id='premium-race-renewal' AND version=1`,
        )
        .bind(now, now),
      db
        .prepare(
          `INSERT INTO renewal_state_history
         (id,agency_id,renewal_id,from_state,to_state,actor_kind,actor_user_id,
          actor_membership_id,reason_code,created_at)
         VALUES('premium-race-won-history','premium-agency','premium-race-renewal',
           'CONTACT_PENDING','WON','USER','premium-owner-user','premium-owner-membership','WON',?)`,
        )
        .bind(now),
    ]);

    let mutationBatches = 0;
    let releaseMutationBatches!: () => void;
    const bothMutationBatchesReady = new Promise<void>((resolve) => {
      releaseMutationBatches = resolve;
    });
    const concurrentDatabase = new Proxy(db, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            mutationBatches += 1;
            if (mutationBatches === 2) releaseMutationBatches();
            await bothMutationBatchesReady;
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as D1Database;
    const payload = {
      expectedPolicyVersion: 1,
      correctedPremiumMinor: 11000,
      reasonCode: 'CONCURRENT_RETRY',
      allocations: [
        {
          linkId: 'premium-race-link',
          expectedRenewalVersion: 2,
          allocatedPremiumMinor: 11000,
        },
      ],
    };
    const sendConcurrent = () =>
      app.request(
        'https://panel.mayisigorta.test/secure/api/policies/premium-race-new-policy/correct-won-premium',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://panel.mayisigorta.com',
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'premium-race-operation-key',
          },
          body: JSON.stringify(payload),
        },
        { ...env, DB: concurrentDatabase },
      );
    const responses = await Promise.all([sendConcurrent(), sendConcurrent()]);
    expect(mutationBatches).toBe(2);
    expect(
      responses.map((response) => response.status).sort(),
      JSON.stringify(await Promise.all(responses.map((response) => response.clone().json()))),
    ).toEqual([200, 200]);
    const results = await Promise.all(
      responses.map(
        (response) =>
          response.json() as Promise<{
            data: { operationId: string; policyId: string };
            replayed: boolean;
          }>,
      ),
    );
    expect(new Set(results.map((result) => result.data.operationId)).size).toBe(1);
    expect(results.map((result) => result.replayed).sort()).toEqual([false, true]);
    expect(
      await db
        .prepare(
          `SELECT p.gross_premium_minor,p.version,
                  (SELECT count(*) FROM operation_receipts WHERE idempotency_key='premium-race-operation-key') AS receipts,
                  (SELECT count(*) FROM renewal_won_policy_premium_corrections
                    WHERE policy_id='premium-race-new-policy') AS corrections,
                  (SELECT count(*) FROM renewal_won_policy_premium_correction_links
                    WHERE policy_id='premium-race-new-policy') AS correction_links,
                  (SELECT count(*) FROM renewal_policy_links WHERE new_policy_id='premium-race-new-policy'
                    AND status='ACTIVE' AND allocated_new_premium_minor=11000) AS active_links,
                  (SELECT count(*) FROM audit_events WHERE idempotency_key='premium-race-operation-key'
                    AND action='renewal.won.premium.corrected' AND outcome='SUCCESS') AS audits
           FROM policies p WHERE p.id='premium-race-new-policy'`,
        )
        .first(),
    ).toEqual({
      gross_premium_minor: 11000,
      version: 2,
      receipts: 1,
      corrections: 1,
      correction_links: 1,
      active_links: 1,
      audits: 1,
    });
  });
});
