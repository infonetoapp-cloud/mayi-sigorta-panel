// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import miniflare from 'miniflare';
import { createApp, type Env } from '../src/server/index';
import type { AuthenticatedUserContext } from '../src/server/auth/identity';
import type { AuthenticatedPrincipal } from '../src/server/auth/types';
import {
  allocateRenewalPolicyLinks,
  issueRenewalPolicyLinksGrant,
} from '../src/server/renewals/policy-links';

const { Miniflare, convertV4MiniflareOptions } = miniflare;
const root = resolve(__dirname, '..');
const secureOwner: AuthenticatedUserContext = {
  userId: 'link-user',
  identityId: 'link-identity',
  assurance: 'SECURE',
  memberships: [
    {
      id: 'link-membership',
      agencyId: 'link-agency',
      type: 'OWNER',
      status: 'ACTIVE',
      permissionVersion: 2,
    },
  ],
};
const verified = { subject: 'link-subject' } as AuthenticatedPrincipal;

describe('M3 RenewalPolicyLink secure allocation command on Local D1', () => {
  let mf: miniflare.Miniflare;
  let db: D1Database;
  let env: Env;
  let csrf: string;

  const app = (
    context: AuthenticatedUserContext = secureOwner,
    subject: string = verified.subject,
  ) =>
    createApp({
      createSessionVerifier: (config) => ({
        config,
        verify: async () => ({ subject }) as AuthenticatedPrincipal,
      }),
      createResolver: () => ({ resolve: async () => context }) as never,
    });

  beforeAll(async () => {
    vi.useFakeTimers();
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: 'export default { fetch() { return new Response(null); } }',
        d1Databases: { DB: '00000000-0000-0000-0000-000000000122' },
      }),
    );
    db = await mf.getD1Database('DB');
    const databaseNow = await db
      .prepare("SELECT strftime('%Y-%m-%dT%H:%M:%fZ','now') AS now")
      .first<{ now: string }>();
    if (!databaseNow?.now) throw new Error('LOCAL_D1_CLOCK_UNAVAILABLE');
    vi.setSystemTime(new Date(databaseNow.now));
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
      db.prepare("INSERT INTO agencies(id,status) VALUES('link-agency','PROVISIONING')"),
      db.prepare("INSERT INTO users(id,status,version) VALUES('link-user','INACTIVE',1)"),
      db.prepare(
        `INSERT INTO agency_memberships
           (id,agency_id,user_id,type,status,permission_version,version,invitation_email,invitation_expires_at)
         VALUES('link-membership','link-agency','link-user','OWNER','INVITED',1,1,
           'link@test.test','2099-01-01T00:00:00.000Z')`,
      ),
      db.prepare(
        `INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email,status)
         VALUES('link-identity','link-user','https://team.cloudflareaccess.com','link-subject',
           'link@test.test','ACTIVE')`,
      ),
    ]);
    await db.prepare("UPDATE users SET status='ACTIVE',version=2 WHERE id='link-user'").run();
    await db
      .prepare(
        `UPDATE agency_memberships SET status='ACTIVE',activated_at='2026-01-01T00:00:00.000Z',
           permission_version=2,version=2 WHERE id='link-membership'`,
      )
      .run();
    await db
      .prepare(
        `UPDATE agencies SET status='ACTIVE',bootstrap_completed_at='2026-01-01T00:00:00.000Z',
           activated_at='2026-01-01T00:00:00.000Z',version=2 WHERE id='link-agency'`,
      )
      .run();
    await db.batch([
      db.prepare("INSERT INTO agencies(id,status) VALUES('link-foreign-agency','PROVISIONING')"),
      db.prepare(
        `INSERT INTO agency_memberships
           (id,agency_id,user_id,type,status,permission_version,version,invitation_email,invitation_expires_at)
         VALUES('link-foreign-membership','link-foreign-agency','link-user','OWNER','INVITED',1,1,
           'foreign-link@test.test','2099-01-01T00:00:00.000Z')`,
      ),
    ]);
    await db
      .prepare(
        `UPDATE agency_memberships SET status='ACTIVE',activated_at='2026-01-01T00:00:00.000Z',
           permission_version=2,version=2 WHERE id='link-foreign-membership'`,
      )
      .run();
    await db
      .prepare(
        `UPDATE agencies SET status='ACTIVE',bootstrap_completed_at='2026-01-01T00:00:00.000Z',
           activated_at='2026-01-01T00:00:00.000Z',version=2 WHERE id='link-foreign-agency'`,
      )
      .run();
    await db.batch([
      db.prepare(
        `INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id)
         VALUES('link-foreign-customer','link-foreign-agency','INDIVIDUAL','Foreign Link Customer','Foreign','Customer','link-foreign-membership')`,
      ),
      db.prepare(
        `INSERT INTO insurers(id,agency_id,code,name) VALUES('link-foreign-insurer','link-foreign-agency','IF','Foreign Insurer')`,
      ),
      db.prepare(
        `INSERT INTO insurance_branches(id,agency_id,code,name,data_classification)
         VALUES('link-foreign-branch','link-foreign-agency','AUTO','Auto','GENERAL')`,
      ),
      db.prepare(
        `INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name)
         VALUES('link-foreign-product','link-foreign-agency','link-foreign-insurer','link-foreign-branch','AUTO','Auto')`,
      ),
      db.prepare(
        `INSERT INTO payment_methods(id,agency_id,code,name,supports_installments,max_installments)
         VALUES('link-foreign-payment','link-foreign-agency','CASH','Cash',0,12)`,
      ),
      db.prepare(
        `INSERT INTO policies
         (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
          assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
          gross_premium_minor,currency)
         VALUES('link-foreign-policy','link-foreign-agency','link-foreign-customer','link-foreign-insurer',
          'link-foreign-product','link-foreign-branch','link-foreign-payment','link-foreign-membership',
          'FOREIGN-LINK','FOREIGNLINK','2026-10-25','2027-10-24',10000,'TRY')`,
      ),
    ]);
    await db.batch([
      db.prepare(
        `INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id)
         VALUES('link-customer','link-agency','INDIVIDUAL','Link Customer','Link','Customer','link-membership')`,
      ),
      db.prepare(
        "INSERT INTO insurers(id,agency_id,code,name) VALUES('link-insurer','link-agency','I','Insurer')",
      ),
      db.prepare(
        `INSERT INTO insurance_branches(id,agency_id,code,name,data_classification)
         VALUES('link-branch','link-agency','AUTO','Auto','GENERAL')`,
      ),
      db.prepare(
        `INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name)
         VALUES('link-product','link-agency','link-insurer','link-branch','AUTO','Auto')`,
      ),
      db.prepare(
        `INSERT INTO payment_methods(id,agency_id,code,name,supports_installments,max_installments)
         VALUES('link-payment','link-agency','CASH','Cash',0,12)`,
      ),
    ]);
    await db.batch([
      db.prepare(
        `INSERT INTO policies
           (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
            assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
            gross_premium_minor,currency)
         VALUES('link-old-policy','link-agency','link-customer','link-insurer','link-product',
           'link-branch','link-payment','link-membership','LINK-OLD','LINKOLD','2025-10-25',
           '2026-10-24',10000,'TRY'),
               ('link-new-policy','link-agency','link-customer','link-insurer','link-product',
           'link-branch','link-payment','link-membership','LINK-NEW','LINKNEW','2026-10-25',
           '2027-10-24',10000,'TRY')`,
      ),
      db.prepare(
        `INSERT INTO renewal_opportunities
           (id,agency_id,expiring_policy_id,assignee_membership_id,state,version,created_at,updated_at)
         VALUES('link-renewal','link-agency','link-old-policy','link-membership','CONTACT_PENDING',1,
           '2026-09-24T06:00:00.000Z','2026-09-24T06:00:00.000Z')`,
      ),
      db.prepare(
        `INSERT INTO renewal_state_history
           (id,agency_id,renewal_id,from_state,to_state,actor_kind,reason_code,created_at)
         VALUES('link-initial-history','link-agency','link-renewal',NULL,'CONTACT_PENDING',
           'SYSTEM','POLICY_EXPIRING','2026-09-24T06:00:00.000Z')`,
      ),
    ]);
    env = {
      DB: db,
      CSRF_SECRET: 'test-csrf-secret-that-is-long-enough',
    } satisfies Env;
    const csrfResponse = await app().request(
      'https://panel.mayisigorta.com/api/csrf-token',
      {},
      env,
    );
    csrf = ((await csrfResponse.json()) as { data: { token: string } }).data.token;
  });

  afterAll(async () => {
    vi.useRealTimers();
    await mf.dispose();
  });

  it('issues an idempotent secure grant and atomically allocates the RenewalPolicyLink group', async () => {
    const payload = {
      reasonCode: 'SPLIT_MERGE_ALLOCATION',
      links: [
        {
          renewalId: 'link-renewal',
          expectedRenewalVersion: 1,
          newPolicyId: 'link-new-policy',
          expectedPolicyVersion: 1,
          allocatedNewPremiumMinor: 10000,
          currency: 'TRY',
        },
      ],
    };
    expect(
      await db
        .prepare(
          "SELECT state,version,closed_at FROM renewal_opportunities WHERE id='link-renewal'",
        )
        .first(),
    ).toEqual({ state: 'CONTACT_PENDING', version: 1, closed_at: null });
    const crossAgencyGrant = await app().request(
      'https://panel.mayisigorta.com/secure/api/renewals/policy-links/grants',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'link-cross-agency-grant-key',
        },
        body: JSON.stringify({
          ...payload,
          links: [{ ...payload.links[0]!, newPolicyId: 'link-foreign-policy' }],
        }),
      },
      env,
    );
    expect(crossAgencyGrant.status).toBe(404);

    const grantResponse = await app().request(
      'https://panel.mayisigorta.com/secure/api/renewals/policy-links/grants',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'link-grant-key',
        },
        body: JSON.stringify(payload),
      },
      env,
    );
    expect(grantResponse.status).toBe(201);
    const grantEnvelope = (await grantResponse.json()) as {
      data: { grantId: string; grantEvidenceToken: string; expiresAt: string };
    };
    const persistedGrantReceipt = await db
      .prepare(
        "SELECT response_body FROM operation_receipts WHERE action='renewal.policy_links.allocate.grant' AND idempotency_key='link-grant-key'",
      )
      .first<{ response_body: string }>();
    expect(persistedGrantReceipt).not.toBeNull();
    expect(persistedGrantReceipt!.response_body).not.toContain(
      grantEnvelope.data.grantEvidenceToken,
    );
    expect(JSON.parse(persistedGrantReceipt!.response_body)).not.toHaveProperty(
      'grantEvidenceToken',
    );
    const exactGrantRetry = await app().request(
      'https://panel.mayisigorta.com/secure/api/renewals/policy-links/grants',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'link-grant-key',
        },
        body: JSON.stringify(payload),
      },
      env,
    );
    expect(exactGrantRetry.status).toBe(200);
    const exactGrantEnvelope = (await exactGrantRetry.json()) as {
      data: { grantId: string; grantEvidenceToken: string };
      replayed: boolean;
    };
    expect(exactGrantEnvelope.replayed).toBe(true);
    expect(exactGrantEnvelope.data.grantId).toBe(grantEnvelope.data.grantId);
    expect(exactGrantEnvelope.data.grantEvidenceToken).toBe(grantEnvelope.data.grantEvidenceToken);

    const changedGrantPayload = await app().request(
      'https://panel.mayisigorta.com/secure/api/renewals/policy-links/grants',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'link-grant-key',
        },
        body: JSON.stringify({ ...payload, reasonCode: 'CHANGED_GRANT_REASON' }),
      },
      env,
    );
    expect(changedGrantPayload.status).toBe(409);

    const issueRaceGrant = () =>
      app().request(
        'https://panel.mayisigorta.com/secure/api/renewals/policy-links/grants',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://panel.mayisigorta.com',
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'link-grant-issuance-race-key',
          },
          body: JSON.stringify(payload),
        },
        env,
      );
    const concurrentGrantResponses = await Promise.all([issueRaceGrant(), issueRaceGrant()]);
    expect(concurrentGrantResponses.map((response) => response.status).sort()).toEqual([200, 201]);
    const concurrentGrantBodies = await Promise.all(
      concurrentGrantResponses.map(
        (response) =>
          response.json() as Promise<{ data: { grantId: string; grantEvidenceToken: string } }>,
      ),
    );
    expect(new Set(concurrentGrantBodies.map((body) => body.data.grantId)).size).toBe(1);
    expect(new Set(concurrentGrantBodies.map((body) => body.data.grantEvidenceToken)).size).toBe(1);
    expect(
      await db
        .prepare('SELECT count(*) AS count FROM sensitive_action_grants WHERE id=?')
        .bind(concurrentGrantBodies[0]!.data.grantId)
        .first(),
    ).toEqual({ count: 1 });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM audit_events WHERE idempotency_key='link-grant-issuance-race-key' AND action='renewal.policy_links.grant_issued'",
        )
        .first(),
    ).toEqual({ count: 1 });

    const crossActionKey = await app().request(
      'https://panel.mayisigorta.com/secure/api/renewals/policy-links',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'link-grant-key',
        },
        body: JSON.stringify({
          ...payload,
          grantEvidenceToken: grantEnvelope.data.grantEvidenceToken,
        }),
      },
      env,
    );
    expect(crossActionKey.status).toBe(409);
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM operation_receipts WHERE action='renewal.policy_links.allocate' AND idempotency_key='link-grant-key'",
        )
        .first(),
    ).toEqual({ count: 0 });

    let allocationBatchError: string | null = null;
    const observedDatabase = new Proxy(db, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            try {
              return await target.batch(statements);
            } catch (error) {
              allocationBatchError = String(error);
              throw error;
            }
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as D1Database;
    const allocationResponse = await app().request(
      'https://panel.mayisigorta.com/secure/api/renewals/policy-links',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'link-allocation-operation-key',
        },
        body: JSON.stringify({
          ...payload,
          grantEvidenceToken: grantEnvelope.data.grantEvidenceToken,
        }),
      },
      { ...env, DB: observedDatabase },
    );
    expect(
      allocationResponse.status,
      `D1 batch error: ${allocationBatchError}; response: ${await allocationResponse.clone().text()}`,
    ).toBe(201);
    const premiumDecrease = await app().request(
      'https://panel.mayisigorta.com/api/policies/link-new-policy',
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'link-premium-decrease-key',
        },
        body: JSON.stringify({ expectedVersion: 1, grossPremium: '50.00' }),
      },
      env,
    );
    expect(premiumDecrease.status).toBe(409);
    expect(
      await db
        .prepare("SELECT gross_premium_minor,version FROM policies WHERE id='link-new-policy'")
        .first(),
    ).toEqual({ gross_premium_minor: 10000, version: 1 });
    const linkedCurrencyChange = await app().request(
      'https://panel.mayisigorta.com/api/policies/link-new-policy',
      {
        method: 'PATCH',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'link-policy-currency-change-key',
        },
        body: JSON.stringify({ expectedVersion: 1, currency: 'USD' }),
      },
      env,
    );
    expect(linkedCurrencyChange.status).toBe(409);
    expect(
      await db.prepare("SELECT currency,version FROM policies WHERE id='link-new-policy'").first(),
    ).toEqual({ currency: 'TRY', version: 1 });
    const allocation = (await allocationResponse.json()) as {
      data: {
        operationId: string;
        links: Array<{ id: string; renewalId: string; newPolicyId: string }>;
      };
      replayed: boolean;
    };
    expect(allocation.replayed).toBe(false);
    expect(allocation.data.links).toHaveLength(1);
    expect(allocation.data.links[0]).toMatchObject({
      renewalId: 'link-renewal',
      newPolicyId: 'link-new-policy',
    });
    expect(
      await db
        .prepare("SELECT state,version FROM renewal_opportunities WHERE id='link-renewal'")
        .first(),
    ).toEqual({ state: 'CONTACT_PENDING', version: 2 });
    expect(
      await db
        .prepare(
          `SELECT count(*) AS count FROM renewal_policy_links
           WHERE agency_id='link-agency' AND renewal_id='link-renewal'
             AND new_policy_id='link-new-policy' AND status='ACTIVE'
             AND allocation_operation_id=?`,
        )
        .bind(allocation.data.operationId)
        .first(),
    ).toEqual({ count: 1 });
    const exactAllocationRetry = await app().request(
      'https://panel.mayisigorta.com/secure/api/renewals/policy-links',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'link-allocation-operation-key',
        },
        body: JSON.stringify({
          ...payload,
          grantEvidenceToken: grantEnvelope.data.grantEvidenceToken,
        }),
      },
      env,
    );
    expect(exactAllocationRetry.status).toBe(200);
    const replay = (await exactAllocationRetry.json()) as {
      data: { operationId: string; links: Array<{ id: string }> };
      replayed: boolean;
    };
    expect(replay.replayed).toBe(true);
    expect(replay.data.operationId).toBe(allocation.data.operationId);
    expect(replay.data.links[0]?.id).toBe(allocation.data.links[0]?.id);

    const changedAllocationPayload = await app().request(
      'https://panel.mayisigorta.com/secure/api/renewals/policy-links',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'link-allocation-operation-key',
        },
        body: JSON.stringify({
          ...payload,
          links: [{ ...payload.links[0], allocatedNewPremiumMinor: 9000 }],
          grantEvidenceToken: grantEnvelope.data.grantEvidenceToken,
        }),
      },
      env,
    );
    expect(changedAllocationPayload.status).toBe(409);
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM audit_events WHERE action='renewal.policy_links.allocate'",
        )
        .first(),
    ).toEqual({ count: 1 });
  });

  it('rolls back grant consumption, link supersession, Renewal CAS, receipt and audit when the final audit write fails', async () => {
    await db
      .prepare(
        `INSERT INTO policies
         (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
          assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
          gross_premium_minor,currency,version)
         VALUES('link-new-policy-2','link-agency','link-customer','link-insurer','link-product',
          'link-branch','link-payment','link-membership','LINK-NEW-2','link-new-2',
          '2026-01-01','2027-01-01',10000,'TRY',1)`,
      )
      .run();
    const payload = {
      reasonCode: 'ALLOCATION_CORRECTION',
      links: [
        {
          renewalId: 'link-renewal',
          expectedRenewalVersion: 2,
          newPolicyId: 'link-new-policy-2',
          expectedPolicyVersion: 1,
          allocatedNewPremiumMinor: 10000,
          currency: 'TRY',
        },
      ],
    };
    const grantResponse = await app().request(
      'https://panel.mayisigorta.com/secure/api/renewals/policy-links/grants',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'link-failure-grant-key',
        },
        body: JSON.stringify(payload),
      },
      env,
    );
    expect(grantResponse.status).toBe(201);
    const grant = (await grantResponse.json()) as {
      data: { grantId: string; grantEvidenceToken: string };
    };
    await db
      .prepare(
        `
      CREATE TRIGGER fail_link_batch_audit
      BEFORE INSERT ON audit_events
      WHEN NEW.action='renewal.policy_links.allocate'
        AND NEW.idempotency_key='link-failure-operation-key'
      BEGIN SELECT RAISE(ABORT,'INJECTED_LINK_AUDIT_FAILURE'); END
    `,
      )
      .run();
    const failed = await app().request(
      'https://panel.mayisigorta.com/secure/api/renewals/policy-links',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'link-failure-operation-key',
        },
        body: JSON.stringify({ ...payload, grantEvidenceToken: grant.data.grantEvidenceToken }),
      },
      env,
    );
    expect(failed.status).toBe(500);
    await db.prepare('DROP TRIGGER fail_link_batch_audit').run();

    expect(
      await db
        .prepare("SELECT state,version FROM renewal_opportunities WHERE id='link-renewal'")
        .first(),
    ).toEqual({ state: 'CONTACT_PENDING', version: 2 });
    expect(
      await db
        .prepare(
          "SELECT status,superseded_operation_id FROM renewal_policy_links WHERE agency_id='link-agency' AND renewal_id='link-renewal' AND new_policy_id='link-new-policy'",
        )
        .first(),
    ).toMatchObject({ status: 'ACTIVE', superseded_operation_id: null });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM renewal_policy_links WHERE agency_id='link-agency' AND new_policy_id='link-new-policy-2'",
        )
        .first(),
    ).toEqual({ count: 0 });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM operation_receipts WHERE agency_id='link-agency' AND idempotency_key='link-failure-operation-key'",
        )
        .first(),
    ).toEqual({ count: 0 });
    expect(
      await db
        .prepare('SELECT status FROM sensitive_action_grants WHERE id=?')
        .bind(grant.data.grantId)
        .first(),
    ).toEqual({ status: 'ISSUED' });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM audit_events WHERE action='renewal.policy_links.allocate' AND idempotency_key='link-failure-operation-key'",
        )
        .first(),
    ).toEqual({ count: 0 });

    const retry = await app().request(
      'https://panel.mayisigorta.com/secure/api/renewals/policy-links',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'link-failure-operation-key',
        },
        body: JSON.stringify({ ...payload, grantEvidenceToken: grant.data.grantEvidenceToken }),
      },
      env,
    );
    expect(retry.status).toBe(201);
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM renewal_policy_links WHERE agency_id='link-agency' AND renewal_id='link-renewal' AND new_policy_id='link-new-policy-2' AND status='ACTIVE'",
        )
        .first(),
    ).toEqual({ count: 1 });
  });

  it('converges concurrent identical allocation retries on one operation receipt and link set', async () => {
    const payload = {
      reasonCode: 'CONCURRENT_LINK_RETRY',
      links: [
        {
          renewalId: 'link-renewal',
          expectedRenewalVersion: 3,
          newPolicyId: 'link-new-policy',
          expectedPolicyVersion: 1,
          allocatedNewPremiumMinor: 10000,
          currency: 'TRY',
        },
      ],
    };
    const grantResponse = await app().request(
      'https://panel.mayisigorta.com/secure/api/renewals/policy-links/grants',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'link-concurrent-grant-key',
        },
        body: JSON.stringify(payload),
      },
      env,
    );
    expect(grantResponse.status).toBe(201);
    const grant = (await grantResponse.json()) as { data: { grantEvidenceToken: string } };
    let grantReadCount = 0;
    let mutationBatchCount = 0;
    let releaseGrantReaders!: () => void;
    let releaseWinningBatch!: () => void;
    const bothGrantReadersReady = new Promise<void>((resolveReaders) => {
      releaseGrantReaders = resolveReaders;
    });
    const winningBatchComplete = new Promise<void>((resolveBatch) => {
      releaseWinningBatch = resolveBatch;
    });
    const concurrentDatabase = new Proxy(db, {
      get(target, property) {
        if (property === 'prepare') {
          return (query: string) => {
            const statement = target.prepare(query);
            if (
              !query.includes('FROM sensitive_action_grants') ||
              !query.includes('WHERE evidence_hash=?')
            ) {
              return statement;
            }
            return {
              bind(...bindings: unknown[]) {
                const bound = statement.bind(...bindings);
                return {
                  first: async () => {
                    const readOrder = ++grantReadCount;
                    if (grantReadCount === 2) releaseGrantReaders();
                    await bothGrantReadersReady;
                    if (readOrder === 2) await winningBatchComplete;
                    return bound.first();
                  },
                  all: () => bound.all(),
                  run: () => bound.run(),
                  raw: () => bound.raw(),
                } as D1PreparedStatement;
              },
            } as unknown as D1PreparedStatement;
          };
        }
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            mutationBatchCount += 1;
            try {
              return await target.batch(statements);
            } finally {
              if (mutationBatchCount === 1) releaseWinningBatch();
            }
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as D1Database;
    const retry = () =>
      app().request(
        'https://panel.mayisigorta.com/secure/api/renewals/policy-links',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://panel.mayisigorta.com',
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'link-concurrent-operation-key',
          },
          body: JSON.stringify({ ...payload, grantEvidenceToken: grant.data.grantEvidenceToken }),
        },
        { ...env, DB: concurrentDatabase },
      );
    const responses = await Promise.all([retry(), retry()]);
    expect(grantReadCount).toBe(2);
    expect(mutationBatchCount).toBe(1);
    const concurrentBodies = await Promise.all(
      responses.map((response) => response.clone().json()),
    );
    expect(
      responses.map((response) => response.status).sort(),
      JSON.stringify(concurrentBodies),
    ).toEqual([200, 201]);
    const bodies = await Promise.all(
      responses.map(
        (response) =>
          response.json() as Promise<{ data: { operationId: string }; replayed: boolean }>,
      ),
    );
    expect(new Set(bodies.map((body) => body.data.operationId)).size).toBe(1);
    expect(bodies.map((body) => body.replayed).sort()).toEqual([false, true]);
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM operation_receipts WHERE agency_id='link-agency' AND idempotency_key='link-concurrent-operation-key'",
        )
        .first(),
    ).toEqual({ count: 1 });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM audit_events WHERE action='renewal.policy_links.allocate' AND idempotency_key='link-concurrent-operation-key'",
        )
        .first(),
    ).toEqual({ count: 1 });
    expect(
      await db
        .prepare("SELECT state,version FROM renewal_opportunities WHERE id='link-renewal'")
        .first(),
    ).toEqual({ state: 'CONTACT_PENDING', version: 4 });
  });

  it('requires explicit AGENCY grants for MEMBER allocation and keeps the secure action scoped', async () => {
    await db.batch([
      db.prepare("INSERT INTO users(id,status,version) VALUES('link-member-user','INACTIVE',1)"),
      db.prepare(
        `INSERT INTO agency_memberships
         (id,agency_id,user_id,type,status,permission_version,version,invitation_email,invitation_expires_at)
         VALUES('link-member-membership','link-agency','link-member-user','MEMBER','INVITED',1,1,
           'member@test.test','2099-01-01T00:00:00.000Z')`,
      ),
      db.prepare(
        `INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email,status)
         VALUES('link-member-identity','link-member-user','https://team.cloudflareaccess.com',
           'link-member-subject','member@test.test','ACTIVE')`,
      ),
    ]);
    await db
      .prepare("UPDATE users SET status='ACTIVE',version=2 WHERE id='link-member-user'")
      .run();
    await db
      .prepare(
        `UPDATE agency_memberships SET status='ACTIVE',activated_at='2026-01-01T00:00:00.000Z',
          permission_version=2,version=2 WHERE id='link-member-membership'`,
      )
      .run();
    const member: AuthenticatedUserContext = {
      userId: 'link-member-user',
      identityId: 'link-member-identity',
      assurance: 'SECURE',
      memberships: [
        {
          id: 'link-member-membership',
          agencyId: 'link-agency',
          type: 'MEMBER',
          status: 'ACTIVE',
          permissionVersion: 2,
        },
      ],
    };
    const memberApp = app(member, 'link-member-subject');
    const csrfResponse = await memberApp.request(
      'https://panel.mayisigorta.com/api/csrf-token',
      {},
      env,
    );
    const memberCsrf = ((await csrfResponse.json()) as { data: { token: string } }).data.token;
    const payload = {
      reasonCode: 'MEMBER_AGENCY_ALLOCATION',
      links: [
        {
          renewalId: 'link-renewal',
          expectedRenewalVersion: 4,
          newPolicyId: 'link-new-policy-2',
          expectedPolicyVersion: 1,
          allocatedNewPremiumMinor: 10000,
          currency: 'TRY',
        },
      ],
    };
    const staleAndMismatchedMemberGrant = await memberApp.request(
      'https://panel.mayisigorta.com/secure/api/renewals/policy-links/grants',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': memberCsrf,
          'Idempotency-Key': 'link-member-stale-version-key',
        },
        body: JSON.stringify({
          ...payload,
          links: [{ ...payload.links[0], expectedRenewalVersion: 999, currency: 'USD' }],
        }),
      },
      env,
    );
    expect(staleAndMismatchedMemberGrant.status).toBe(403);
    const requestGrant = () =>
      memberApp.request(
        'https://panel.mayisigorta.com/secure/api/renewals/policy-links/grants',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://panel.mayisigorta.com',
            'X-CSRF-Token': memberCsrf,
            'Idempotency-Key': 'link-member-grant-key',
          },
          body: JSON.stringify(payload),
        },
        env,
      );
    expect((await requestGrant()).status).toBe(403);
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM operation_receipts WHERE agency_id='link-agency' AND actor_user_id='link-member-user' AND idempotency_key='link-member-grant-key'",
        )
        .first(),
    ).toEqual({ count: 0 });

    await db.batch([
      db.prepare(
        `INSERT INTO membership_permissions(id,membership_id,permission_code,scope)
         VALUES('link-member-customer-read','link-member-membership','customer.read','AGENCY'),
           ('link-member-policy-read','link-member-membership','policy.read','AGENCY'),
           ('link-member-renewal-read','link-member-membership','renewal.read','AGENCY'),
           ('link-member-renewal-update','link-member-membership','renewal.update','AGENCY')`,
      ),
      db.prepare(
        `UPDATE agency_memberships
         SET permission_version=3,version=version+1,updated_at='2099-01-01T00:00:00.000Z'
         WHERE id='link-member-membership' AND permission_version=2`,
      ),
    ]);
    const authorizedMember: AuthenticatedUserContext = {
      ...member,
      memberships: [{ ...member.memberships[0]!, permissionVersion: 3 }],
    };
    const authorizedApp = app(authorizedMember, 'link-member-subject');
    const grantResponse = await authorizedApp.request(
      'https://panel.mayisigorta.com/secure/api/renewals/policy-links/grants',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': memberCsrf,
          'Idempotency-Key': 'link-member-grant-key',
        },
        body: JSON.stringify(payload),
      },
      env,
    );
    expect(grantResponse.status).toBe(201);
    const grant = (await grantResponse.json()) as { data: { grantEvidenceToken: string } };
    const allocationResponse = await authorizedApp.request(
      'https://panel.mayisigorta.com/secure/api/renewals/policy-links',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': memberCsrf,
          'Idempotency-Key': 'link-member-allocation-key',
        },
        body: JSON.stringify({ ...payload, grantEvidenceToken: grant.data.grantEvidenceToken }),
      },
      env,
    );
    expect(allocationResponse.status).toBe(201);
    let revokedBeforeProof = false;
    const revokeIdentityDb = new Proxy(db, {
      get(target, property) {
        if (property !== 'prepare') {
          const value = Reflect.get(target, property, target) as unknown;
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return (query: string) => {
          const statement = target.prepare(query);
          if (!query.includes('FROM audit_events a')) return statement;
          return {
            bind(...bindings: unknown[]) {
              const bound = statement.bind(...bindings);
              return {
                first: async () => {
                  if (!revokedBeforeProof) {
                    revokedBeforeProof = true;
                    await target
                      .prepare(
                        `UPDATE auth_identities SET status='REVOKED',revoked_at='2099-01-01T00:00:00.000Z',
                           version=version+1,updated_at='2099-01-01T00:00:00.000Z'
                         WHERE id='link-member-identity'`,
                      )
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
    try {
      await expect(
        allocateRenewalPolicyLinks(
          authorizedMember,
          revokeIdentityDb,
          { ...payload, grantEvidenceToken: grant.data.grantEvidenceToken },
          'link-member-allocation-key',
        ),
      ).rejects.toMatchObject({ code: 'REPLAY_NOT_AUTHORIZED', status: 404 });
    } finally {
      await db
        .prepare(
          `UPDATE auth_identities SET status='ACTIVE',revoked_at=NULL,version=version+1,
             updated_at='2100-01-01T00:00:00.000Z'
           WHERE id='link-member-identity'`,
        )
        .run();
    }
    expect(
      await db
        .prepare("SELECT state,version FROM renewal_opportunities WHERE id='link-renewal'")
        .first(),
    ).toEqual({ state: 'CONTACT_PENDING', version: 5 });
    await db.batch([
      db.prepare(
        `INSERT INTO policies
         (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
          assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
          gross_premium_minor,currency,version)
         VALUES('link-scope-old-policy','link-agency','link-customer','link-insurer','link-product',
          'link-branch','link-payment','link-membership','LINK-SCOPE-OLD','link-scope-old',
          '2025-01-01','2026-01-01',10000,'TRY',1)`,
      ),
      db.prepare(
        `INSERT INTO policies
         (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
          assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
          gross_premium_minor,currency,version)
         VALUES('link-scope-new-policy','link-agency','link-customer','link-insurer','link-product',
          'link-branch','link-payment','link-membership','LINK-SCOPE-NEW','link-scope-new',
          '2026-01-01','2027-01-01',10000,'TRY',1)`,
      ),
      db.prepare(
        `INSERT INTO renewal_opportunities
         (id,agency_id,expiring_policy_id,assignee_membership_id,state,version,created_at,updated_at)
         VALUES('link-scope-renewal','link-agency','link-scope-old-policy',
          'link-membership','CONTACT_PENDING',1,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z')`,
      ),
    ]);
    const scopePayload = {
      reasonCode: 'PERMISSION_SET_RECHECK',
      links: [
        {
          renewalId: 'link-scope-renewal',
          expectedRenewalVersion: 1,
          newPolicyId: 'link-scope-new-policy',
          expectedPolicyVersion: 1,
          allocatedNewPremiumMinor: 10000,
          currency: 'TRY',
        },
      ],
    };
    const scopeGrant = await issueRenewalPolicyLinksGrant(
      authorizedMember,
      db,
      scopePayload,
      'link-scope-grant-key',
      env.CSRF_SECRET as string,
    );
    let malformedGrantInserted = false;
    let malformedGrantInsertSucceeded = false;
    const corruptPermissionDb = new Proxy(db, {
      get(target, property) {
        if (property === 'prepare') return target.prepare.bind(target);
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            if (!malformedGrantInserted) {
              malformedGrantInserted = true;
              const injection = await target
                .prepare(
                  `INSERT INTO membership_permissions(id,membership_id,permission_code,scope)
                   VALUES('link-member-invalid-health-scope','link-member-membership',
                     'sensitive.health.read','AGENCY')`,
                )
                .run();
              malformedGrantInsertSucceeded = injection.success;
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as D1Database;
    let permissionSetError: unknown;
    try {
      await allocateRenewalPolicyLinks(
        authorizedMember,
        corruptPermissionDb,
        { ...scopePayload, grantEvidenceToken: scopeGrant.data.grantEvidenceToken },
        'link-scope-operation-key',
      );
    } catch (error) {
      permissionSetError = error;
    } finally {
      if (malformedGrantInserted && malformedGrantInsertSucceeded) {
        await db
          .prepare("DELETE FROM membership_permissions WHERE id='link-member-invalid-health-scope'")
          .run();
      }
    }
    expect(malformedGrantInsertSucceeded).toBe(true);
    expect(permissionSetError).toMatchObject({ status: 403 });
    expect(
      await db
        .prepare("SELECT state,version FROM renewal_opportunities WHERE id='link-scope-renewal'")
        .first(),
    ).toEqual({ state: 'CONTACT_PENDING', version: 1 });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM operation_receipts WHERE idempotency_key='link-scope-operation-key'",
        )
        .first(),
    ).toEqual({ count: 0 });
  });

  it('rechecks active identity inside the allocation batch and preserves the issued grant on denial', async () => {
    await db
      .prepare(
        `INSERT INTO policies
         (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
          assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
          gross_premium_minor,currency,version)
         VALUES('link-new-policy-3','link-agency','link-customer','link-insurer','link-product',
          'link-branch','link-payment','link-membership','LINK-NEW-3','link-new-3',
          '2026-01-01','2027-01-01',10000,'TRY',1)`,
      )
      .run();
    const payload = {
      reasonCode: 'IDENTITY_REVOKED_DURING_RETRY',
      links: [
        {
          renewalId: 'link-renewal',
          expectedRenewalVersion: 5,
          newPolicyId: 'link-new-policy-3',
          expectedPolicyVersion: 1,
          allocatedNewPremiumMinor: 10000,
          currency: 'TRY',
        },
      ],
    };
    const memberContext: AuthenticatedUserContext = {
      userId: 'link-member-user',
      identityId: 'link-member-identity',
      assurance: 'SECURE',
      memberships: [
        {
          id: 'link-member-membership',
          agencyId: 'link-agency',
          type: 'MEMBER',
          status: 'ACTIVE',
          permissionVersion: 3,
        },
      ],
    };
    const grant = await issueRenewalPolicyLinksGrant(
      memberContext,
      db,
      payload,
      'link-identity-race-grant-key',
      env.CSRF_SECRET as string,
    );
    let revoked = false;
    const revokeBeforeBatch = new Proxy(db, {
      get(target, property) {
        if (property === 'prepare') return target.prepare.bind(target);
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            if (!revoked) {
              revoked = true;
              await target
                .prepare(
                  `UPDATE auth_identities SET status='REVOKED',revoked_at='2099-01-01T00:00:00.000Z',
                    version=version+1,updated_at='2099-01-01T00:00:00.000Z' WHERE id='link-member-identity'`,
                )
                .run();
            }
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, target) as unknown;
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as D1Database;
    let resultError: unknown;
    try {
      await allocateRenewalPolicyLinks(
        memberContext,
        revokeBeforeBatch,
        { ...payload, grantEvidenceToken: grant.data.grantEvidenceToken },
        'link-identity-race-operation-key',
      );
    } catch (error) {
      resultError = error;
    } finally {
      await db
        .prepare(
          `UPDATE auth_identities SET status='ACTIVE',revoked_at=NULL,version=version+1,
            updated_at='2100-01-01T00:00:00.000Z' WHERE id='link-member-identity'`,
        )
        .run();
    }
    expect(resultError).toMatchObject({ code: 'FORBIDDEN', status: 403 });
    expect(
      await db
        .prepare("SELECT state,version FROM renewal_opportunities WHERE id='link-renewal'")
        .first(),
    ).toEqual({ state: 'CONTACT_PENDING', version: 5 });
    expect(
      await db
        .prepare('SELECT status FROM sensitive_action_grants WHERE id=?')
        .bind(grant.data.grantId)
        .first(),
    ).toEqual({ status: 'ISSUED' });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM renewal_policy_links WHERE agency_id='link-agency' AND new_policy_id='link-new-policy-3'",
        )
        .first(),
    ).toEqual({ count: 0 });

    const retry = await allocateRenewalPolicyLinks(
      memberContext,
      db,
      { ...payload, grantEvidenceToken: grant.data.grantEvidenceToken },
      'link-identity-race-operation-key',
    );
    expect(retry.replayed).toBe(false);
    expect(
      await db
        .prepare("SELECT state,version FROM renewal_opportunities WHERE id='link-renewal'")
        .first(),
    ).toEqual({ state: 'CONTACT_PENDING', version: 6 });
  });

  it('applies split and merge allocations as one authorized group', async () => {
    await db.batch([
      db.prepare(
        `INSERT INTO policies
         (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
          assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
          gross_premium_minor,currency,version)
         VALUES('link-old-policy-2','link-agency','link-customer','link-insurer','link-product',
          'link-branch','link-payment','link-membership','LINK-OLD-2','link-old-2',
          '2025-10-25','2026-10-24',7000,'TRY',1),
               ('link-old-policy-3','link-agency','link-customer','link-insurer','link-product',
          'link-branch','link-payment','link-membership','LINK-OLD-3','link-old-3',
          '2025-10-25','2026-10-24',8000,'TRY',1),
               ('link-split-policy-1','link-agency','link-customer','link-insurer','link-product',
          'link-branch','link-payment','link-membership','LINK-SPLIT-1','link-split-1',
          '2026-10-25','2027-10-24',6000,'TRY',1),
               ('link-split-policy-2','link-agency','link-customer','link-insurer','link-product',
          'link-branch','link-payment','link-membership','LINK-SPLIT-2','link-split-2',
          '2026-10-25','2027-10-24',4000,'TRY',1),
               ('link-merge-policy','link-agency','link-customer','link-insurer','link-product',
          'link-branch','link-payment','link-membership','LINK-MERGE','link-merge',
          '2026-10-25','2027-10-24',15000,'TRY',1)`,
      ),
      db.prepare(
        `INSERT INTO renewal_opportunities
         (id,agency_id,expiring_policy_id,assignee_membership_id,state,version,created_at,updated_at)
         VALUES('link-renewal-2','link-agency','link-old-policy-2','link-membership','CONTACT_PENDING',1,
           '2026-09-24T06:00:00.000Z','2026-09-24T06:00:00.000Z'),
               ('link-renewal-3','link-agency','link-old-policy-3','link-membership','CONTACT_PENDING',1,
           '2026-09-24T06:00:00.000Z','2026-09-24T06:00:00.000Z')`,
      ),
    ]);
    const payload = {
      reasonCode: 'SPLIT_MERGE_ALLOCATION',
      links: [
        {
          renewalId: 'link-renewal',
          expectedRenewalVersion: 6,
          newPolicyId: 'link-split-policy-1',
          expectedPolicyVersion: 1,
          allocatedNewPremiumMinor: 6000,
          currency: 'TRY',
        },
        {
          renewalId: 'link-renewal',
          expectedRenewalVersion: 6,
          newPolicyId: 'link-split-policy-2',
          expectedPolicyVersion: 1,
          allocatedNewPremiumMinor: 4000,
          currency: 'TRY',
        },
        {
          renewalId: 'link-renewal-2',
          expectedRenewalVersion: 1,
          newPolicyId: 'link-merge-policy',
          expectedPolicyVersion: 1,
          allocatedNewPremiumMinor: 7000,
          currency: 'TRY',
        },
        {
          renewalId: 'link-renewal-3',
          expectedRenewalVersion: 1,
          newPolicyId: 'link-merge-policy',
          expectedPolicyVersion: 1,
          allocatedNewPremiumMinor: 8000,
          currency: 'TRY',
        },
      ],
    };
    const grantResponse = await app().request(
      'https://panel.mayisigorta.com/secure/api/renewals/policy-links/grants',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'link-group-grant-key',
        },
        body: JSON.stringify(payload),
      },
      env,
    );
    expect(grantResponse.status).toBe(201);
    const grant = (await grantResponse.json()) as { data: { grantEvidenceToken: string } };
    const allocation = await app().request(
      'https://panel.mayisigorta.com/secure/api/renewals/policy-links',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'link-group-operation-key',
        },
        body: JSON.stringify({ ...payload, grantEvidenceToken: grant.data.grantEvidenceToken }),
      },
      env,
    );
    expect(allocation.status).toBe(201);
    expect(
      await db
        .prepare(
          "SELECT new_policy_id,allocated_new_premium_minor FROM renewal_policy_links WHERE agency_id='link-agency' AND renewal_id='link-renewal' AND status='ACTIVE' ORDER BY new_policy_id",
        )
        .all(),
    ).toMatchObject({
      results: [
        { new_policy_id: 'link-split-policy-1', allocated_new_premium_minor: 6000 },
        { new_policy_id: 'link-split-policy-2', allocated_new_premium_minor: 4000 },
      ],
    });
    expect(
      await db
        .prepare(
          "SELECT sum(allocated_new_premium_minor) AS total,count(*) AS count FROM renewal_policy_links WHERE agency_id='link-agency' AND new_policy_id='link-merge-policy' AND status='ACTIVE'",
        )
        .first(),
    ).toEqual({ total: 15000, count: 2 });
    expect(
      await db
        .prepare(
          "SELECT id,state,version FROM renewal_opportunities WHERE id IN ('link-renewal','link-renewal-2','link-renewal-3') ORDER BY id",
        )
        .all(),
    ).toMatchObject({
      results: [
        { id: 'link-renewal', state: 'CONTACT_PENDING', version: 7 },
        { id: 'link-renewal-2', state: 'CONTACT_PENDING', version: 2 },
        { id: 'link-renewal-3', state: 'CONTACT_PENDING', version: 2 },
      ],
    });
  });

  it('replays a multi-link supersession with the exact stable link-id order', async () => {
    await db.batch([
      db.prepare(
        `INSERT INTO policies
         (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
          assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
          gross_premium_minor,currency,version)
         VALUES('link-multi-old-policy','link-agency','link-customer','link-insurer','link-product',
          'link-branch','link-payment','link-membership','LINK-MULTI-OLD','link-multi-old',
          '2025-10-25','2026-10-24',10000,'TRY',1),
               ('link-multi-a','link-agency','link-customer','link-insurer','link-product',
          'link-branch','link-payment','link-membership','LINK-MULTI-A','link-multi-a',
          '2026-10-25','2027-10-24',6000,'TRY',1),
               ('link-multi-b','link-agency','link-customer','link-insurer','link-product',
          'link-branch','link-payment','link-membership','LINK-MULTI-B','link-multi-b',
          '2026-10-25','2027-10-24',4000,'TRY',1)`,
      ),
      db.prepare(
        `INSERT INTO renewal_opportunities
         (id,agency_id,expiring_policy_id,assignee_membership_id,state,version,created_at,updated_at)
         VALUES('link-multi-renewal','link-agency','link-multi-old-policy','link-membership',
          'CONTACT_PENDING',1,'2026-09-24T06:00:00.000Z','2026-09-24T06:00:00.000Z')`,
      ),
      db
        .prepare(
          `INSERT INTO operation_receipts
         (id,agency_id,actor_user_id,actor_membership_id,action,idempotency_key,payload_fingerprint,
          status,response_status,response_body)
         VALUES('link-multi-old-operation','link-agency','link-user','link-membership',
          'renewal.policy_links.allocate','link-multi-old-key',?, 'COMPLETED',201,'{}')`,
        )
        .bind('a'.repeat(64)),
      db.prepare(
        `INSERT INTO renewal_policy_links
         (id,agency_id,renewal_id,new_policy_id,allocated_new_premium_minor,currency,
          allocation_operation_id,created_by_membership_id)
         VALUES('z-old-link','link-agency','link-multi-renewal','link-multi-a',6000,'TRY',
          'link-multi-old-operation','link-membership'),
               ('a-old-link','link-agency','link-multi-renewal','link-multi-b',4000,'TRY',
          'link-multi-old-operation','link-membership')`,
      ),
    ]);
    const payload = {
      reasonCode: 'MULTI_LINK_SUPERSESSION',
      links: [
        {
          renewalId: 'link-multi-renewal',
          expectedRenewalVersion: 1,
          newPolicyId: 'link-multi-a',
          expectedPolicyVersion: 1,
          allocatedNewPremiumMinor: 6000,
          currency: 'TRY',
        },
        {
          renewalId: 'link-multi-renewal',
          expectedRenewalVersion: 1,
          newPolicyId: 'link-multi-b',
          expectedPolicyVersion: 1,
          allocatedNewPremiumMinor: 4000,
          currency: 'TRY',
        },
      ],
    };
    const grantResponse = await app().request(
      'https://panel.mayisigorta.com/secure/api/renewals/policy-links/grants',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'link-multi-grant-key',
        },
        body: JSON.stringify(payload),
      },
      env,
    );
    expect(grantResponse.status).toBe(201);
    const grant = (await grantResponse.json()) as { data: { grantEvidenceToken: string } };
    const commandPayload = { ...payload, grantEvidenceToken: grant.data.grantEvidenceToken };
    const operationResponse = await app().request(
      'https://panel.mayisigorta.com/secure/api/renewals/policy-links',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'link-multi-operation-key',
        },
        body: JSON.stringify(commandPayload),
      },
      env,
    );
    expect(operationResponse.status).toBe(201);
    const initial = (await operationResponse.json()) as {
      data: { operationId: string; supersededLinkIds: string[] };
      replayed: boolean;
    };
    expect(initial.data.supersededLinkIds).toEqual(['a-old-link', 'z-old-link']);
    expect(initial.replayed).toBe(false);
    const replay = await app().request(
      'https://panel.mayisigorta.com/secure/api/renewals/policy-links',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'link-multi-operation-key',
        },
        body: JSON.stringify(commandPayload),
      },
      env,
    );
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      data: {
        operationId: initial.data.operationId,
        supersededLinkIds: ['a-old-link', 'z-old-link'],
      },
      replayed: true,
    });
  });

  it('converges a concurrent grant-versus-command key collision to one 409 loser', async () => {
    await db.batch([
      db.prepare(
        `INSERT INTO policies
         (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
          assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
          gross_premium_minor,currency,version)
         VALUES('link-cross-key-old-policy','link-agency','link-customer','link-insurer','link-product',
          'link-branch','link-payment','link-membership','LINK-CROSS-OLD','link-cross-old',
          '2025-10-25','2026-10-24',10000,'TRY',1),
               ('link-cross-key-new-policy','link-agency','link-customer','link-insurer','link-product',
          'link-branch','link-payment','link-membership','LINK-CROSS-NEW','link-cross-new',
          '2026-10-25','2027-10-24',10000,'TRY',1)`,
      ),
      db.prepare(
        `INSERT INTO renewal_opportunities
         (id,agency_id,expiring_policy_id,assignee_membership_id,state,version,created_at,updated_at)
         VALUES('link-cross-key-renewal','link-agency','link-cross-key-old-policy','link-membership',
          'CONTACT_PENDING',1,'2026-09-24T06:00:00.000Z','2026-09-24T06:00:00.000Z')`,
      ),
    ]);
    const payload = {
      reasonCode: 'CROSS_ACTION_KEY_RACE',
      links: [
        {
          renewalId: 'link-cross-key-renewal',
          expectedRenewalVersion: 1,
          newPolicyId: 'link-cross-key-new-policy',
          expectedPolicyVersion: 1,
          allocatedNewPremiumMinor: 10000,
          currency: 'TRY',
        },
      ],
    };
    const baseGrantResponse = await app().request(
      'https://panel.mayisigorta.com/secure/api/renewals/policy-links/grants',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'link-cross-key-base-grant',
        },
        body: JSON.stringify(payload),
      },
      env,
    );
    expect(baseGrantResponse.status).toBe(201);
    const baseGrant = (await baseGrantResponse.json()) as {
      data: { grantId: string; grantEvidenceToken: string };
    };
    const sameKey = 'link-cross-action-race-key';
    const grantAttempt = () =>
      app().request(
        'https://panel.mayisigorta.com/secure/api/renewals/policy-links/grants',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://panel.mayisigorta.com',
            'X-CSRF-Token': csrf,
            'Idempotency-Key': sameKey,
          },
          body: JSON.stringify(payload),
        },
        env,
      );
    const commandAttempt = () =>
      app().request(
        'https://panel.mayisigorta.com/secure/api/renewals/policy-links',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://panel.mayisigorta.com',
            'X-CSRF-Token': csrf,
            'Idempotency-Key': sameKey,
          },
          body: JSON.stringify({
            ...payload,
            grantEvidenceToken: baseGrant.data.grantEvidenceToken,
          }),
        },
        env,
      );
    const [grantResponse, commandResponse] = await Promise.all([grantAttempt(), commandAttempt()]);
    expect([grantResponse.status, commandResponse.status].sort()).toEqual([201, 409]);
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM operation_receipts WHERE agency_id='link-agency' AND actor_user_id='link-user' AND actor_membership_id='link-membership' AND idempotency_key=?",
        )
        .bind(sameKey)
        .first(),
    ).toEqual({ count: 1 });
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM audit_events WHERE agency_id='link-agency' AND actor_user_id='link-user' AND idempotency_key=? AND action IN ('renewal.policy_links.allocate','renewal.policy_links.grant_issued')",
        )
        .bind(sameKey)
        .first(),
    ).toEqual({ count: 1 });
    const winner = await db
      .prepare('SELECT action FROM operation_receipts WHERE agency_id=? AND idempotency_key=?')
      .bind('link-agency', sameKey)
      .first<{ action: string }>();
    const baseGrantRecord = await db
      .prepare('SELECT payload_hash,target_ids_json FROM sensitive_action_grants WHERE id=?')
      .bind(baseGrant.data.grantId)
      .first<{ payload_hash: string; target_ids_json: string }>();
    expect(baseGrantRecord).not.toBeNull();
    const matchingGrantRows = await db
      .prepare(
        `SELECT count(*) AS count FROM sensitive_action_grants
         WHERE actor_membership_id='link-membership' AND action='renewal.policy_links.allocate'
           AND payload_hash=? AND target_ids_json=?`,
      )
      .bind(baseGrantRecord!.payload_hash, baseGrantRecord!.target_ids_json)
      .first();
    if (winner?.action === 'renewal.policy_links.allocate') {
      expect(
        await db
          .prepare(
            "SELECT state,version FROM renewal_opportunities WHERE id='link-cross-key-renewal'",
          )
          .first(),
      ).toEqual({ state: 'CONTACT_PENDING', version: 2 });
      expect(matchingGrantRows).toEqual({ count: 1 });
      expect(
        await db
          .prepare('SELECT status FROM sensitive_action_grants WHERE id=?')
          .bind(baseGrant.data.grantId)
          .first(),
      ).toEqual({ status: 'CONSUMED' });
    } else {
      expect(winner?.action).toBe('renewal.policy_links.allocate.grant');
      expect(
        await db
          .prepare(
            "SELECT state,version FROM renewal_opportunities WHERE id='link-cross-key-renewal'",
          )
          .first(),
      ).toEqual({ state: 'CONTACT_PENDING', version: 1 });
      expect(matchingGrantRows).toEqual({ count: 2 });
      const crossGrantReceipt = await db
        .prepare(
          `SELECT response_body FROM operation_receipts WHERE agency_id='link-agency'
           AND actor_user_id='link-user' AND actor_membership_id='link-membership'
           AND action='renewal.policy_links.allocate.grant' AND idempotency_key=?`,
        )
        .bind(sameKey)
        .first<{ response_body: string }>();
      expect(crossGrantReceipt).not.toBeNull();
      const { grantId: crossGrantId } = JSON.parse(crossGrantReceipt!.response_body) as {
        grantId: string;
      };
      expect(
        await db
          .prepare('SELECT status FROM sensitive_action_grants WHERE id=?')
          .bind(crossGrantId)
          .first(),
      ).toEqual({ status: 'ISSUED' });
    }
  });

  it('uses the current D1 clock when a single-use grant expires during preflight-to-batch time', async () => {
    const fakeTime = new Date();
    vi.useRealTimers();
    try {
      await db.batch([
        db.prepare(
          `INSERT INTO policies
           (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
            assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
            gross_premium_minor,currency)
           VALUES('link-grant-expiry-old','link-agency','link-customer','link-insurer',
            'link-product','link-branch','link-payment','link-membership','LINK-GEXP-OLD',
            'link-gexp-old','2025-01-01','2026-01-01',10000,'TRY'),
                 ('link-grant-expiry-new','link-agency','link-customer','link-insurer',
            'link-product','link-branch','link-payment','link-membership','LINK-GEXP-NEW',
            'link-gexp-new','2026-01-02','2027-01-02',10000,'TRY')`,
        ),
        db.prepare(
          `INSERT INTO renewal_opportunities
           (id,agency_id,expiring_policy_id,assignee_membership_id,state,version)
           VALUES('link-grant-expiry-renewal','link-agency','link-grant-expiry-old',
            'link-membership','CONTACT_PENDING',1)`,
        ),
      ]);
      const payload = {
        reasonCode: 'GRANT_EXPIRY_RACE',
        links: [
          {
            renewalId: 'link-grant-expiry-renewal',
            expectedRenewalVersion: 1,
            newPolicyId: 'link-grant-expiry-new',
            expectedPolicyVersion: 1,
            allocatedNewPremiumMinor: 10000,
            currency: 'TRY',
          },
        ],
      };
      const issueShortGrant = issueRenewalPolicyLinksGrant as unknown as (
        context: AuthenticatedUserContext,
        database: D1Database,
        request: typeof payload,
        idempotencyKey: string,
        csrfSecret: string,
        options: { grantTtlMs: number },
      ) => Promise<{ data: { grantId: string; grantEvidenceToken: string; expiresAt: string } }>;
      const grant = await issueShortGrant(
        secureOwner,
        db,
        payload,
        'link-expiry-race-grant-key',
        env.CSRF_SECRET as string,
        { grantTtlMs: 5_000 },
      );
      let batchReached = false;
      const delayedDatabase = new Proxy(db, {
        get(target, property) {
          if (property === 'prepare') return target.prepare.bind(target);
          if (property === 'batch') {
            return async (statements: D1PreparedStatement[]) => {
              batchReached = true;
              await new Promise((resolveDelay) => setTimeout(resolveDelay, 5_500));
              return target.batch(statements);
            };
          }
          const value = Reflect.get(target, property, target);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }) as D1Database;
      await expect(
        allocateRenewalPolicyLinks(
          secureOwner,
          delayedDatabase,
          { ...payload, grantEvidenceToken: grant.data.grantEvidenceToken },
          'link-expiry-race-operation-key',
        ),
      ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN' });
      expect(batchReached).toBe(true);
      expect(
        await db
          .prepare('SELECT status,consumed_at FROM sensitive_action_grants WHERE id=?')
          .bind(grant.data.grantId)
          .first(),
      ).toEqual({ status: 'ISSUED', consumed_at: null });
      expect(
        await db
          .prepare(
            "SELECT state,version FROM renewal_opportunities WHERE id='link-grant-expiry-renewal'",
          )
          .first(),
      ).toEqual({ state: 'CONTACT_PENDING', version: 1 });
      expect(
        await db
          .prepare(
            "SELECT count(*) AS count FROM renewal_policy_links WHERE renewal_id='link-grant-expiry-renewal'",
          )
          .first(),
      ).toEqual({ count: 0 });
    } finally {
      vi.useFakeTimers();
      vi.setSystemTime(fakeTime);
    }
  });

  it('requires additive HEALTH read authority even for the Owner before allocating links', async () => {
    await db.batch([
      db.prepare(
        `INSERT INTO insurance_branches(id,agency_id,code,name,data_classification)
         VALUES('link-health-branch','link-agency','HEALTH-LINK','Health Link','HEALTH')`,
      ),
      db.prepare(
        `INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name)
         VALUES('link-health-product','link-agency','link-insurer','link-health-branch','HL','Health')`,
      ),
      db.prepare(
        `INSERT INTO policies
         (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
          assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
          gross_premium_minor,currency,version)
         VALUES('link-health-old-policy','link-agency','link-customer','link-insurer','link-health-product',
          'link-health-branch','link-payment','link-membership','LINK-HEALTH-OLD','link-health-old',
          '2025-10-25','2026-10-24',10000,'TRY',1),
               ('link-health-new-policy','link-agency','link-customer','link-insurer','link-health-product',
          'link-health-branch','link-payment','link-membership','LINK-HEALTH-NEW','link-health-new',
          '2026-10-25','2027-10-24',10000,'TRY',1)`,
      ),
      db.prepare(
        `INSERT INTO renewal_opportunities
         (id,agency_id,expiring_policy_id,assignee_membership_id,state,version,created_at,updated_at)
         VALUES('link-health-renewal','link-agency','link-health-old-policy','link-membership',
           'CONTACT_PENDING',1,'2026-09-24T06:00:00.000Z','2026-09-24T06:00:00.000Z')`,
      ),
    ]);
    const payload = {
      reasonCode: 'HEALTH_POLICY_LINK',
      links: [
        {
          renewalId: 'link-health-renewal',
          expectedRenewalVersion: 1,
          newPolicyId: 'link-health-new-policy',
          expectedPolicyVersion: 1,
          allocatedNewPremiumMinor: 10000,
          currency: 'TRY',
        },
      ],
    };
    const denied = await app().request(
      'https://panel.mayisigorta.com/secure/api/renewals/policy-links/grants',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'link-health-grant-key',
        },
        body: JSON.stringify(payload),
      },
      env,
    );
    expect(denied.status).toBe(403);

    await db.batch([
      db.prepare(
        `INSERT INTO membership_permissions(id,membership_id,permission_code,scope)
         VALUES('link-owner-health-read','link-membership','sensitive.health.read','UNSCOPED')`,
      ),
      db.prepare(
        `UPDATE agency_memberships
         SET permission_version=3,version=version+1,updated_at='2099-01-01T00:00:00.000Z'
         WHERE id='link-membership' AND permission_version=2`,
      ),
    ]);
    const ownerHealthContext: AuthenticatedUserContext = {
      ...secureOwner,
      memberships: [{ ...secureOwner.memberships[0]!, permissionVersion: 3 }],
    };
    const authorizedApp = app(ownerHealthContext, 'link-subject');
    const grantResponse = await authorizedApp.request(
      'https://panel.mayisigorta.com/secure/api/renewals/policy-links/grants',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'link-health-grant-key',
        },
        body: JSON.stringify(payload),
      },
      env,
    );
    expect(grantResponse.status).toBe(201);
    const grant = (await grantResponse.json()) as { data: { grantEvidenceToken: string } };
    const commandPayload = { ...payload, grantEvidenceToken: grant.data.grantEvidenceToken };
    const allocation = await authorizedApp.request(
      'https://panel.mayisigorta.com/secure/api/renewals/policy-links',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'link-health-allocation-key',
        },
        body: JSON.stringify(commandPayload),
      },
      env,
    );
    expect(allocation.status).toBe(201);
    const receipt = await db
      .prepare(
        "SELECT id,response_body FROM operation_receipts WHERE action='renewal.policy_links.allocate' AND idempotency_key='link-health-allocation-key'",
      )
      .first<{ id: string; response_body: string }>();
    expect(receipt).not.toBeNull();
    const originalResponseBody = receipt!.response_body;
    const corrupted = JSON.parse(originalResponseBody) as {
      authorizedTargets: Array<{ kind: 'renewal' | 'policy' | 'customer'; id: string }>;
    };
    corrupted.authorizedTargets = corrupted.authorizedTargets.filter(
      (target) =>
        target.kind !== 'policy' ||
        (target.id !== 'link-health-old-policy' && target.id !== 'link-health-new-policy'),
    );
    await db
      .prepare('UPDATE operation_receipts SET response_body=? WHERE id=?')
      .bind(JSON.stringify(corrupted), receipt!.id)
      .run();
    let corruptedResponseError: unknown;
    try {
      await allocateRenewalPolicyLinks(
        ownerHealthContext,
        db,
        commandPayload,
        'link-health-allocation-key',
      );
    } catch (error) {
      corruptedResponseError = error;
    }
    expect(corruptedResponseError).toMatchObject({
      code: 'REPLAY_NOT_AUTHORIZED',
      status: 404,
    });
    await db
      .prepare('UPDATE operation_receipts SET response_body=? WHERE id=?')
      .bind(originalResponseBody, receipt!.id)
      .run();
    await db.batch([
      db.prepare("DELETE FROM membership_permissions WHERE id='link-owner-health-read'"),
      db.prepare(
        `UPDATE agency_memberships
         SET permission_version=4,version=version+1,updated_at='2099-01-01T00:00:00.000Z'
         WHERE id='link-membership' AND permission_version=3`,
      ),
    ]);
    const revokedOwnerContext: AuthenticatedUserContext = {
      ...ownerHealthContext,
      memberships: [{ ...ownerHealthContext.memberships[0]!, permissionVersion: 4 }],
    };
    let replayError: unknown;
    try {
      await allocateRenewalPolicyLinks(
        revokedOwnerContext,
        db,
        commandPayload,
        'link-health-allocation-key',
      );
    } catch (error) {
      replayError = error;
    } finally {
      await db.batch([
        db.prepare(
          `INSERT INTO membership_permissions(id,membership_id,permission_code,scope)
           VALUES('link-owner-health-read','link-membership','sensitive.health.read','UNSCOPED')`,
        ),
        db.prepare(
          `UPDATE agency_memberships
           SET permission_version=5,version=version+1,updated_at='2100-01-01T00:00:00.000Z'
           WHERE id='link-membership' AND permission_version=4`,
        ),
        db
          .prepare('UPDATE operation_receipts SET response_body=? WHERE id=?')
          .bind(originalResponseBody, receipt!.id),
      ]);
    }
    expect(replayError).toMatchObject({ code: 'OWNER_SENSITIVE_GRANT_REQUIRED', status: 403 });
  });

  it('serializes simultaneous competing allocations against the same stale Renewal and Policy versions', async () => {
    await db.batch([
      db.prepare(
        `INSERT INTO policies
           (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
            assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
            gross_premium_minor,currency,version)
         VALUES('link-race-old-policy','link-agency','link-customer','link-insurer','link-product',
           'link-branch','link-payment','link-membership','LINK-RACE-OLD','LINKRACEOLD',
           '2025-10-25','2026-10-24',10000,'TRY',1),
              ('link-race-new-policy','link-agency','link-customer','link-insurer','link-product',
           'link-branch','link-payment','link-membership','LINK-RACE-NEW','LINKRACENEW',
           '2026-10-25','2027-10-24',10000,'TRY',1)`,
      ),
      db.prepare(
        `INSERT INTO renewal_opportunities
           (id,agency_id,expiring_policy_id,assignee_membership_id,state,version,created_at,updated_at)
         VALUES('link-race-renewal','link-agency','link-race-old-policy','link-membership',
           'CONTACT_PENDING',1,'2026-09-24T06:00:00.000Z','2026-09-24T06:00:00.000Z')`,
      ),
      db.prepare(
        `INSERT INTO renewal_state_history
           (id,agency_id,renewal_id,from_state,to_state,actor_kind,reason_code,created_at)
         VALUES('link-race-history','link-agency','link-race-renewal',NULL,'CONTACT_PENDING',
           'SYSTEM','POLICY_EXPIRING','2026-09-24T06:00:00.000Z')`,
      ),
    ]);
    const currentMembership = await db
      .prepare('SELECT permission_version FROM agency_memberships WHERE id=?')
      .bind('link-membership')
      .first<{ permission_version: number }>();
    expect(currentMembership).not.toBeNull();
    const raceActor: AuthenticatedUserContext = {
      ...secureOwner,
      memberships: [
        {
          ...secureOwner.memberships[0]!,
          permissionVersion: currentMembership!.permission_version,
        },
      ],
    };
    const firstInput = {
      reasonCode: 'ALLOCATION_CORRECTION',
      links: [
        {
          renewalId: 'link-race-renewal',
          expectedRenewalVersion: 1,
          newPolicyId: 'link-race-new-policy',
          expectedPolicyVersion: 1,
          allocatedNewPremiumMinor: 7000,
          currency: 'TRY',
        },
      ],
    };
    const secondInput = {
      ...firstInput,
      links: [{ ...firstInput.links[0]!, allocatedNewPremiumMinor: 7000 }],
    };
    const [firstGrant, secondGrant] = await Promise.all([
      issueRenewalPolicyLinksGrant(
        raceActor,
        db,
        firstInput,
        'link-race-grant-a',
        'test-csrf-secret-that-is-long-enough',
      ),
      issueRenewalPolicyLinksGrant(
        raceActor,
        db,
        secondInput,
        'link-race-grant-b',
        'test-csrf-secret-that-is-long-enough',
      ),
    ]);

    let arrivals = 0;
    let releaseBatch!: () => void;
    const batchGate = new Promise<void>((resolveGate) => {
      releaseBatch = resolveGate;
    });
    const racingDatabase = new Proxy(db, {
      get(target, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            arrivals += 1;
            if (arrivals === 2) releaseBatch();
            await batchGate;
            return target.batch(statements);
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as D1Database;
    const outcomes = await Promise.allSettled([
      allocateRenewalPolicyLinks(
        raceActor,
        racingDatabase,
        { ...firstInput, grantEvidenceToken: firstGrant.data.grantEvidenceToken },
        'link-race-operation-a',
      ),
      allocateRenewalPolicyLinks(
        raceActor,
        racingDatabase,
        { ...secondInput, grantEvidenceToken: secondGrant.data.grantEvidenceToken },
        'link-race-operation-b',
      ),
    ]);
    expect(
      arrivals,
      JSON.stringify(
        outcomes.map((outcome) =>
          outcome.status === 'rejected' ? String(outcome.reason) : 'fulfilled',
        ),
      ),
    ).toBe(2);
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter((outcome) => outcome.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]).toMatchObject({ status: 'rejected', reason: { status: 409 } });
    expect(
      await db
        .prepare(
          `SELECT r.version,p.version AS policy_version,p.gross_premium_minor,
                  count(l.id) AS active_links,COALESCE(sum(l.allocated_new_premium_minor),0) AS allocated
           FROM renewal_opportunities r JOIN policies p
             ON p.agency_id=r.agency_id AND p.id='link-race-new-policy'
           LEFT JOIN renewal_policy_links l ON l.agency_id=r.agency_id AND l.renewal_id=r.id
             AND l.status='ACTIVE'
           WHERE r.id='link-race-renewal' GROUP BY r.id,p.id`,
        )
        .first(),
    ).toEqual({
      version: 2,
      policy_version: 1,
      gross_premium_minor: 10000,
      active_links: 1,
      allocated: 7000,
    });
  });

  it('replays an exact retry whose initial receipt read races ahead of single-use grant consumption', async () => {
    await db.batch([
      db.prepare(
        `INSERT INTO policies
           (id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,
            assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,
            gross_premium_minor,currency,version)
         VALUES('link-late-race-old-policy','link-agency','link-customer','link-insurer',
           'link-product','link-branch','link-payment','link-membership','LINK-LATE-RACE-OLD',
           'LINKLATERACEOLD','2025-10-25','2026-10-24',10000,'TRY',1),
              ('link-late-race-new-policy','link-agency','link-customer','link-insurer',
           'link-product','link-branch','link-payment','link-membership','LINK-LATE-RACE-NEW',
           'LINKLATERACENEW','2026-10-25','2027-10-24',10000,'TRY',1)`,
      ),
      db.prepare(
        `INSERT INTO renewal_opportunities
           (id,agency_id,expiring_policy_id,assignee_membership_id,state,version,created_at,updated_at)
         VALUES('link-late-race-renewal','link-agency','link-late-race-old-policy',
           'link-membership','CONTACT_PENDING',1,'2026-09-24T06:00:00.000Z',
           '2026-09-24T06:00:00.000Z')`,
      ),
      db.prepare(
        `INSERT INTO renewal_state_history
           (id,agency_id,renewal_id,from_state,to_state,actor_kind,reason_code,created_at)
         VALUES('link-late-race-history','link-agency','link-late-race-renewal',NULL,
           'CONTACT_PENDING','SYSTEM','POLICY_EXPIRING','2026-09-24T06:00:00.000Z')`,
      ),
    ]);
    const currentMembership = await db
      .prepare('SELECT permission_version FROM agency_memberships WHERE id=?')
      .bind('link-membership')
      .first<{ permission_version: number }>();
    expect(currentMembership).not.toBeNull();
    const lateRaceActor: AuthenticatedUserContext = {
      ...secureOwner,
      memberships: [
        {
          ...secureOwner.memberships[0]!,
          permissionVersion: currentMembership!.permission_version,
        },
      ],
    };
    const lateRaceApp = app(lateRaceActor);
    const payload = {
      reasonCode: 'LATE_EXACT_RETRY',
      links: [
        {
          renewalId: 'link-late-race-renewal',
          expectedRenewalVersion: 1,
          newPolicyId: 'link-late-race-new-policy',
          expectedPolicyVersion: 1,
          allocatedNewPremiumMinor: 10000,
          currency: 'TRY',
        },
      ],
    };
    const grantResponse = await lateRaceApp.request(
      'https://panel.mayisigorta.com/secure/api/renewals/policy-links/grants',
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Origin: 'https://panel.mayisigorta.com',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': 'link-late-race-grant-key',
        },
        body: JSON.stringify(payload),
      },
      env,
    );
    expect(grantResponse.status, await grantResponse.clone().text()).toBe(201);
    const grant = (await grantResponse.json()) as {
      data: { grantId: string; grantEvidenceToken: string };
    };
    const command = { ...payload, grantEvidenceToken: grant.data.grantEvidenceToken };
    let releaseDelayedReceiptRead!: () => void;
    let signalDelayedReceiptRead!: () => void;
    const delayedReceiptRead = new Promise<void>((resolveRead) => {
      signalDelayedReceiptRead = resolveRead;
    });
    const continueDelayedRequest = new Promise<void>((resolveRequest) => {
      releaseDelayedReceiptRead = resolveRequest;
    });
    let paused = false;
    const delayedDatabase = new Proxy(db, {
      get(target, property) {
        if (property === 'prepare') {
          return (query: string) => {
            const statement = target.prepare(query);
            if (
              !query.includes('FROM operation_receipts') ||
              !query.includes('action=? AND idempotency_key=?') ||
              !query.includes('payload_fingerprint,status,response_status,response_body')
            ) {
              return statement;
            }
            return {
              bind(...bindings: unknown[]) {
                const bound = statement.bind(...bindings);
                return {
                  first: async () => {
                    const receipt = await bound.first();
                    if (!paused) {
                      paused = true;
                      signalDelayedReceiptRead();
                      await continueDelayedRequest;
                    }
                    return receipt;
                  },
                  all: () => bound.all(),
                  run: () => bound.run(),
                  raw: () => bound.raw(),
                } as D1PreparedStatement;
              },
            } as unknown as D1PreparedStatement;
          };
        }
        const value = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as D1Database;
    const request = (database: D1Database) =>
      lateRaceApp.request(
        'https://panel.mayisigorta.com/secure/api/renewals/policy-links',
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Origin: 'https://panel.mayisigorta.com',
            'X-CSRF-Token': csrf,
            'Idempotency-Key': 'link-late-race-operation-key',
          },
          body: JSON.stringify(command),
        },
        { ...env, DB: database },
      );
    const delayedRetry = request(delayedDatabase);
    await delayedReceiptRead;
    const winner = await request(db);
    expect(winner.status, await winner.clone().text()).toBe(201);
    releaseDelayedReceiptRead();
    const replay = await delayedRetry;
    expect(replay.status, await replay.clone().text()).toBe(200);
    expect(await replay.json()).toMatchObject({ replayed: true });
    expect(
      await db
        .prepare(
          `SELECT
             (SELECT count(*) FROM operation_receipts WHERE idempotency_key='link-late-race-operation-key'
               AND action='renewal.policy_links.allocate') AS receipts,
             (SELECT count(*) FROM audit_events WHERE idempotency_key='link-late-race-operation-key'
               AND action='renewal.policy_links.allocate' AND outcome='SUCCESS') AS audits,
             (SELECT count(*) FROM renewal_policy_links WHERE renewal_id='link-late-race-renewal'
               AND status='ACTIVE') AS links,
             (SELECT version FROM renewal_opportunities WHERE id='link-late-race-renewal') AS renewal_version,
             (SELECT status FROM sensitive_action_grants WHERE id=?) AS grant_status`,
        )
        .bind(grant.data.grantId)
        .first(),
    ).toEqual({ receipts: 1, audits: 1, links: 1, renewal_version: 2, grant_status: 'CONSUMED' });
  });
});
