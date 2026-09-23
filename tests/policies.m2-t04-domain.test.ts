// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import miniflare from 'miniflare';
import {
  createPolicy,
  createPolicyIdentityVariant,
  getPolicy,
  listPolicies,
  PolicyNotFoundError,
  updatePolicy,
  assignPolicy,
  issuePolicyIdentityVariantGrant,
  listPolicyAssignmentOptions,
} from '../src/server/policies/service';
import { issueAndPersistSensitiveActionGrant } from '../src/server/mutations/grants';
import { computePayloadHash } from '../src/server/mutations/canonical';
import { IdempotencyConflictError } from '../src/server/mutations/idempotency';
import {
  executePolicyCommand,
  executePolicyVariantCommand,
  PolicyAuthorizationRaceError,
} from '../src/server/mutations/internal/policy-domain-executor';

const { Miniflare, convertV4MiniflareOptions } = miniflare;
const root = resolve(__dirname, '..');
const ctx = {
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

describe('M2-T04 policy domain on real D1', () => {
  let mf: miniflare.Miniflare;
  let db: D1Database;
  beforeAll(async () => {
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: 'export default {fetch(){return new Response()}}',
        d1Databases: { DB: '00000000-0000-0000-0000-000000000024' },
      }),
    );
    db = await mf.getD1Database('DB');
    for (const file of readdirSync(resolve(root, 'db/migrations'))
      .filter((x) => /^000[0-7]_.*\.sql$/.test(x))
      .sort()) {
      for (const statement of readFileSync(resolve(root, 'db/migrations', file), 'utf8')
        .split('--> statement-breakpoint')
        .map((x) => x.trim())
        .filter(Boolean))
        await db.prepare(statement).run();
    }
    await db
      .prepare(
        "INSERT INTO agencies(id,status,bootstrap_completed_at,activated_at) VALUES('agency-a','PROVISIONING',NULL,NULL),('agency-b','PROVISIONING',NULL,NULL)",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO users(id,status) VALUES('user-a','INACTIVE'),('user-b','INACTIVE'),('user-member','INACTIVE')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO agency_memberships(id,agency_id,user_id,type,status,permission_version,invitation_email,invitation_expires_at,activated_at) VALUES('member-a','agency-a','user-a','OWNER','INVITED',1,'a@test.test','2099-01-01Z',NULL),('member-b','agency-b','user-b','OWNER','INVITED',1,'b@test.test','2099-01-01Z',NULL)",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email,status) VALUES('identity-a','user-a','https://test','sub-a','a@test.test','ACTIVE'),('identity-worker','user-member','https://test','sub-worker','worker@test.test','ACTIVE')",
      )
      .run();
    await db.prepare("UPDATE users SET status='ACTIVE',version=2 WHERE id='user-a'").run();
    await db
      .prepare(
        "UPDATE agency_memberships SET status='ACTIVE',activated_at='2026-01-01Z',version=2,permission_version=2 WHERE id='member-a'",
      )
      .run();
    await db
      .prepare(
        "UPDATE agencies SET status='ACTIVE',bootstrap_completed_at='2026-01-01Z',activated_at='2026-01-01Z',version=2 WHERE id='agency-a'",
      )
      .run();
    await db.prepare("UPDATE users SET status='ACTIVE',version=2 WHERE id='user-member'").run();
    await db
      .prepare(
        "INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email,status) VALUES('identity-b','user-b','https://agency-b.test','subject-b','b-owner@test.test','ACTIVE')",
      )
      .run();
    await db.prepare("UPDATE users SET status='ACTIVE',version=2 WHERE id='user-b'").run();
    await db
      .prepare(
        "UPDATE agency_memberships SET status='ACTIVE',activated_at='2026-01-01Z',version=2,permission_version=2 WHERE id='member-b'",
      )
      .run();
    await db
      .prepare(
        "UPDATE agencies SET status='ACTIVE',bootstrap_completed_at='2026-01-01Z',activated_at='2026-01-01Z',version=2 WHERE id='agency-b'",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO agency_memberships(id,agency_id,user_id,type,status,permission_version,invitation_email,invitation_expires_at,activated_at) VALUES('member-worker','agency-a','user-member','MEMBER','ACTIVE',1,'worker@test.test','2099-01-01Z','2026-01-01Z')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES('cr','member-worker','customer.read','ASSIGNED'),('pr','member-worker','policy.read','ASSIGNED'),('pc','member-worker','policy.create','UNSCOPED'),('pu','member-worker','policy.update','ASSIGNED'),('pa','member-worker','policy.assign','ASSIGNED')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES('customer-a','agency-a','INDIVIDUAL','A','A','B','member-a'),('customer-worker','agency-a','INDIVIDUAL','Worker','W','C','member-worker')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO insurers(id,agency_id,code,name) VALUES('insurer-a','agency-a','A','A'),('insurer-b','agency-b','B','B')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('branch-a','agency-a','AUTO','Auto','GENERAL'),('branch-health','agency-a','HEALTH','Health','HEALTH')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('product-a','agency-a','insurer-a','branch-a','PA','PA'),('product-health','agency-a','insurer-a','branch-health','PH','PH')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO payment_methods(id,agency_id,code,name,supports_installments,max_installments) VALUES('cash-a','agency-a','CASH','Cash',0,12),('card-a','agency-a','CARD','Card',1,12)",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO agency_settings(id,agency_id,default_insurer_id) VALUES('settings-a','agency-a','insurer-a')",
      )
      .run();
  });
  afterAll(async () => mf.dispose());

  const input = {
    customerId: 'customer-a',
    productId: 'product-a',
    branchId: 'branch-a',
    paymentMethodId: 'cash-a',
    policyNumber: 'AB-123',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    grossPremium: '100.25',
    currency: 'TRY',
    installmentCount: null,
    status: 'ACTIVE',
  };

  it('allows the same number for different periods and rejects a duplicate candidate', async () => {
    const first = await createPolicy(ctx, db, input, 'create-1');
    expect(first.data.identityVariant).toBe(0);
    const second = await createPolicy(
      ctx,
      db,
      { ...input, startDate: '2027-01-01', endDate: '2027-12-31' },
      'create-2',
    );
    expect(second.data.normalizedPolicyNumber).toBe(first.data.normalizedPolicyNumber);
    await expect(createPolicy(ctx, db, input, 'create-3')).rejects.toMatchObject({
      code: 'DUPLICATE_POLICY_CANDIDATE',
    });
  });

  it('searches policy numbers by normalized exact value and prefix within the authorized portfolio', async () => {
    await createPolicy(ctx, db, { ...input, policyNumber: 'İLK-2026/001' }, 'search-policy');
    const prefix = await listPolicies(ctx, db, { search: 'İLK-2026' });
    const exact = await listPolicies(ctx, db, { search: 'İLK 2026/001' });
    expect(prefix.items.map((item) => item.normalizedPolicyNumber)).toContain('İLK2026001');
    expect(exact.items.map((item) => item.normalizedPolicyNumber)).toEqual(['İLK2026001']);
  });

  it('enforces payment semantics, active consistent catalogs, and same-agency database relations', async () => {
    await expect(
      createPolicy(
        ctx,
        db,
        { ...input, policyNumber: 'P-2', paymentMethodId: 'cash-a', installmentCount: 2 },
        'bad-cash',
      ),
    ).rejects.toMatchObject({ code: 'INSTALLMENT_NOT_ALLOWED' });
    await expect(
      createPolicy(
        ctx,
        db,
        { ...input, policyNumber: 'P-3', paymentMethodId: 'card-a', installmentCount: 13 },
        'bad-limit',
      ),
    ).rejects.toMatchObject({ code: 'INSTALLMENT_COUNT_INVALID' });
    await expect(
      createPolicy(
        ctx,
        db,
        { ...input, policyNumber: 'P-CROSS', insurerId: 'insurer-b' },
        'bad-cross',
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_REFERENCE_NOT_SELECTABLE' });
    await db.prepare("UPDATE payment_methods SET status='INACTIVE' WHERE id='cash-a'").run();
    await expect(
      createPolicy(ctx, db, { ...input, policyNumber: 'P-INACTIVE' }, 'bad-inactive'),
    ).rejects.toMatchObject({ code: 'CATALOG_REFERENCE_NOT_SELECTABLE' });
    await db.prepare("UPDATE payment_methods SET status='ACTIVE' WHERE id='cash-a'").run();
    await expect(
      db
        .prepare(
          `INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency,status) VALUES('cross-db','agency-a','customer-a','insurer-b','product-a','branch-a','cash-a','member-a','X','X','2026-01-01','2026-12-31',1,'TRY','ACTIVE')`,
        )
        .run(),
    ).rejects.toThrow();
  });

  it('uses CAS, prevents PATCH assignment/variant, and keeps inactive historical references readable', async () => {
    const created = await createPolicy(ctx, db, { ...input, policyNumber: 'UP-1' }, 'up-create');
    await expect(
      updatePolicy(
        ctx,
        db,
        created.data.id,
        { expectedVersion: 99, status: 'CANCELLED' },
        'up-stale',
      ),
    ).rejects.toThrow();
    const assigned = await assignPolicy(
      ctx,
      db,
      created.data.id,
      { expectedVersion: 1, assigneeMembershipId: 'member-a' },
      'up-assign',
    );
    expect(assigned.data.version).toBe(2);
    await db
      .prepare("UPDATE agency_settings SET default_insurer_id=NULL WHERE agency_id='agency-a'")
      .run();
    await db.prepare("UPDATE insurers SET status='INACTIVE' WHERE id='insurer-a'").run();
    expect((await getPolicy(ctx, db, created.data.id)).insurer.status).toBe('INACTIVE');
    await db.prepare("UPDATE insurers SET status='ACTIVE' WHERE id='insurer-a'").run();
    await db
      .prepare(
        "UPDATE agency_settings SET default_insurer_id='insurer-a' WHERE agency_id='agency-a'",
      )
      .run();
  });

  it('requires secure audience and an exact single-use grant for a positive identity variant', async () => {
    const source = await db
      .prepare("SELECT id,version FROM policies WHERE policy_number='UP-1' LIMIT 1")
      .first<{ id: string; version: number }>();
    expect(source).toBeDefined();
    const reason = 'Aynı adayda gerçek ayrı sözleşme';
    const payload = { expectedVersion: source!.version, reason };
    const secureCtx = { ...ctx, assurance: 'SECURE' as const };
    const grant = await issueAndPersistSensitiveActionGrant(db, secureCtx, {
      agencyId: 'agency-a',
      action: 'policy.identity_variant.create',
      payloadHash: await computePayloadHash(payload),
      targetIds: [source!.id],
      expectedTargetVersion: source!.version,
    });
    await expect(
      createPolicyIdentityVariant(
        ctx,
        db,
        source!.id,
        { ...payload, grantEvidenceToken: grant.grantToken },
        'variant-normal',
      ),
    ).rejects.toThrow();
    const created = await createPolicyIdentityVariant(
      secureCtx,
      db,
      source!.id,
      { ...payload, grantEvidenceToken: grant.grantToken },
      'variant-1',
    );
    expect(created.data.identityVariant).toBe(1);
    const replay = await createPolicyIdentityVariant(
      secureCtx,
      db,
      source!.id,
      { ...payload, grantEvidenceToken: grant.grantToken },
      'variant-1',
    );
    expect(replay.replayed).toBe(true);
    const row = await db
      .prepare('SELECT identity_variant_reason FROM policies WHERE id=?')
      .bind(created.data.id)
      .first<{ identity_variant_reason: string }>();
    expect(row?.identity_variant_reason).toBe(reason);
  });

  it('returns only active same-agency policy assignment options after policy.assign authorization', async () => {
    const source = await db
      .prepare("SELECT id FROM policies WHERE policy_number='UP-1' LIMIT 1")
      .first<{ id: string }>();
    const options = await listPolicyAssignmentOptions(ctx, db, source!.id);
    expect(options.map((option) => option.membershipId)).toContain('member-a');
    expect(options.map((option) => option.membershipId)).toContain('member-worker');
    expect(options.map((option) => option.membershipId)).not.toContain('member-b');
  });

  it('issues a secure identity-variant grant with a server-owned action and exact payload', async () => {
    const source = await createPolicy(
      ctx,
      db,
      { ...input, policyNumber: 'GRANT-RETRY' },
      'grant-source-key',
    );
    const secureCtx = { ...ctx, assurance: 'SECURE' as const };
    const payload = {
      expectedVersion: source.data.version,
      reason: 'Gerçek farklı sözleşme',
    };
    const issued = await issuePolicyIdentityVariantGrant(
      secureCtx,
      db,
      source.data.id,
      payload,
      'grant-retry-key',
    );
    const replay = await issuePolicyIdentityVariantGrant(
      secureCtx,
      db,
      source.data.id,
      payload,
      'grant-retry-key',
    );
    expect(replay).toEqual(issued);
    await expect(
      issuePolicyIdentityVariantGrant(
        secureCtx,
        db,
        source.data.id,
        { ...payload, reason: 'Farklı gerekçe' },
        'grant-retry-key',
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' });
    expect(issued.grantEvidenceToken.length).toBeGreaterThanOrEqual(20);
    const row = await db
      .prepare(
        'SELECT action,expected_target_version,status FROM sensitive_action_grants WHERE id=?',
      )
      .bind(issued.grantId)
      .first<{ action: string; expected_target_version: number; status: string }>();
    expect(row).toEqual({
      action: 'policy.identity_variant.create',
      expected_target_version: source.data.version,
      status: 'ISSUED',
    });
  });

  it('does not let the secure uniqueness exception bypass active catalog selection', async () => {
    const source = await createPolicy(
      ctx,
      db,
      { ...input, policyNumber: 'SECURE-INACTIVE-CATALOG' },
      'secure-inactive-source',
    );
    const secureCtx = { ...ctx, assurance: 'SECURE' as const };
    const payload = { expectedVersion: 1, reason: 'Katalog yaşam döngüsü testi' };
    const grant = await issueAndPersistSensitiveActionGrant(db, secureCtx, {
      agencyId: 'agency-a',
      action: 'policy.identity_variant.create',
      payloadHash: await computePayloadHash(payload),
      targetIds: [source.data.id],
      expectedTargetVersion: 1,
    });
    await db
      .prepare("UPDATE agency_settings SET default_insurer_id=NULL WHERE agency_id='agency-a'")
      .run();
    await db.prepare("UPDATE insurers SET status='INACTIVE' WHERE id='insurer-a'").run();
    await expect(
      createPolicyIdentityVariant(
        secureCtx,
        db,
        source.data.id,
        { ...payload, grantEvidenceToken: grant.grantToken },
        'secure-inactive-variant',
      ),
    ).rejects.toMatchObject({ code: 'CATALOG_REFERENCE_NOT_SELECTABLE' });
    expect(
      (
        await db
          .prepare('SELECT status FROM sensitive_action_grants WHERE id=?')
          .bind(grant.grantRecord.id)
          .first<{ status: string }>()
      )?.status,
    ).toBe('ISSUED');
    await db.prepare("UPDATE insurers SET status='ACTIVE' WHERE id='insurer-a'").run();
    await db
      .prepare(
        "UPDATE agency_settings SET default_insurer_id='insurer-a' WHERE agency_id='agency-a'",
      )
      .run();
  });

  it('enforces exact replay, changed-operation conflict, and concurrent default duplicate uniqueness', async () => {
    const payload = { ...input, policyNumber: 'IDEM-1' };
    const first = await createPolicy(ctx, db, payload, 'idem-exact');
    const replay = await createPolicy(ctx, db, payload, 'idem-exact');
    expect(replay.replayed).toBe(true);
    expect(replay.data.id).toBe(first.data.id);
    await expect(
      createPolicy(ctx, db, { ...payload, currency: 'USD' }, 'idem-exact'),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    const concurrent = { ...input, policyNumber: 'CONCURRENT-1' };
    const settled = await Promise.allSettled([
      createPolicy(ctx, db, concurrent, 'concurrent-a'),
      createPolicy(ctx, db, concurrent, 'concurrent-b'),
    ]);
    expect(settled.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const count = await db
      .prepare(
        "SELECT count(*) n FROM policies WHERE normalized_policy_number='CONCURRENT1' AND identity_variant=0",
      )
      .first<{ n: number }>();
    expect(count?.n).toBe(1);
  });

  it('resolves an exact create replay before mutable catalog preconditions', async () => {
    const payload = { ...input, policyNumber: 'REPLAY-CATALOG' };
    const first = await createPolicy(ctx, db, payload, 'replay-catalog');
    await db.prepare("UPDATE insurance_products SET status='INACTIVE' WHERE id='product-a'").run();
    try {
      const replay = await createPolicy(ctx, db, payload, 'replay-catalog');
      expect(replay.replayed).toBe(true);
      expect(replay.data.id).toBe(first.data.id);
    } finally {
      await db.prepare("UPDATE insurance_products SET status='ACTIVE' WHERE id='product-a'").run();
    }
  });

  it('denies an exact create replay after the actor loses access to the persisted result', async () => {
    const worker = {
      userId: 'user-member',
      identityId: 'identity-worker',
      assurance: 'NORMAL' as const,
      memberships: [
        {
          id: 'member-worker',
          agencyId: 'agency-a',
          type: 'MEMBER' as const,
          status: 'ACTIVE' as const,
          permissionVersion: 1,
        },
      ],
    };
    const payload = {
      ...input,
      customerId: 'customer-worker',
      policyNumber: 'REPLAY-SCOPE',
    };
    const first = await createPolicy(worker, db, payload, 'replay-scope');
    await db
      .prepare("UPDATE policies SET assignee_membership_id='member-a' WHERE id=?")
      .bind(first.data.id)
      .run();
    await db.prepare("UPDATE membership_permissions SET scope='AGENCY' WHERE id='cr'").run();
    await db
      .prepare("UPDATE customers SET assignee_membership_id='member-a' WHERE id='customer-worker'")
      .run();
    try {
      await expect(createPolicy(worker, db, payload, 'replay-scope')).rejects.toBeInstanceOf(
        PolicyAuthorizationRaceError,
      );
    } finally {
      await db.prepare("UPDATE membership_permissions SET scope='ASSIGNED' WHERE id='cr'").run();
      await db
        .prepare(
          "UPDATE customers SET assignee_membership_id='member-worker' WHERE id='customer-worker'",
        )
        .run();
    }
  });

  it('replays concurrent identical idempotent creates without duplicate policy or audit', async () => {
    const payload = { ...input, policyNumber: 'CONCURRENT-IDEMPOTENT' };
    const settled = await Promise.allSettled([
      createPolicy(ctx, db, payload, 'concurrent-idempotent-key'),
      createPolicy(ctx, db, payload, 'concurrent-idempotent-key'),
    ]);
    expect(
      settled.every((result) => result.status === 'fulfilled'),
      settled
        .map((result) => (result.status === 'rejected' ? String(result.reason) : 'fulfilled'))
        .join(' | '),
    ).toBe(true);
    const fulfilled = settled
      .filter((result) => result.status === 'fulfilled')
      .map((result) => result.value);
    expect(new Set(fulfilled.map((result) => result.data.id)).size).toBe(1);
    expect(fulfilled.filter((result) => result.replayed)).toHaveLength(1);
    const policyCount = await db
      .prepare(
        "SELECT count(*) n FROM policies WHERE normalized_policy_number='CONCURRENTIDEMPOTENT'",
      )
      .first<{ n: number }>();
    expect(policyCount?.n).toBe(1);
    const auditCount = await db
      .prepare(
        "SELECT count(*) n FROM audit_events WHERE idempotency_key='concurrent-idempotent-key' AND action='policy.create'",
      )
      .first<{ n: number }>();
    expect(auditCount?.n).toBe(1);
  });

  it('resolves ASSIGNED scope through policy assignee and policyholder assignee and denies other records', async () => {
    const workerCtx = {
      userId: 'user-member',
      identityId: 'identity-worker',
      assurance: 'NORMAL' as const,
      memberships: [
        {
          id: 'member-worker',
          agencyId: 'agency-a',
          type: 'MEMBER' as const,
          status: 'ACTIVE' as const,
          permissionVersion: 1,
        },
      ],
    };
    const byCustomer = await createPolicy(
      workerCtx,
      db,
      { ...input, customerId: 'customer-worker', policyNumber: 'ASSIGNED-CUSTOMER' },
      'assigned-customer',
    );
    expect((await getPolicy(workerCtx, db, byCustomer.data.id)).id).toBe(byCustomer.data.id);
    const byPolicy = await createPolicy(
      ctx,
      db,
      { ...input, policyNumber: 'ASSIGNED-POLICY', assigneeMembershipId: 'member-worker' },
      'assigned-policy',
    );
    expect((await getPolicy(workerCtx, db, byPolicy.data.id)).id).toBe(byPolicy.data.id);
    const hidden = await createPolicy(
      ctx,
      db,
      { ...input, policyNumber: 'ASSIGNED-HIDDEN' },
      'assigned-hidden',
    );
    await expect(getPolicy(workerCtx, db, hidden.data.id)).rejects.toThrow();
    const hiddenSearch = await listPolicies(workerCtx, db, { search: 'ASSIGNED-HIDDEN' });
    expect(hiddenSearch.items.map((item) => item.id)).not.toContain(hidden.data.id);
    await expect(
      createPolicy(
        workerCtx,
        db,
        { ...input, customerId: 'customer-a', policyNumber: 'INACCESSIBLE-CUSTOMER' },
        'inaccessible-customer',
      ),
    ).rejects.toThrow();
    await expect(
      assignPolicy(
        workerCtx,
        db,
        byPolicy.data.id,
        { expectedVersion: 1, assigneeMembershipId: 'member-a' },
        'assigned-no-agency',
      ),
    ).rejects.toThrow();
  });

  it('denies a live actor from another agency without disclosing the policy', async () => {
    const source = await createPolicy(
      ctx,
      db,
      { ...input, policyNumber: 'CROSS-AGENCY-HIDDEN' },
      'cross-agency-source',
    );
    const otherAgencyContext = {
      userId: 'user-b',
      identityId: 'identity-b',
      assurance: 'NORMAL' as const,
      memberships: [
        {
          id: 'member-b',
          agencyId: 'agency-b',
          type: 'OWNER' as const,
          status: 'ACTIVE' as const,
          permissionVersion: 2,
        },
      ],
    };
    await expect(getPolicy(otherAgencyContext, db, source.data.id)).rejects.toBeInstanceOf(
      PolicyNotFoundError,
    );
  });

  it('rechecks accessible policyholder scope inside the create transaction', async () => {
    const policyId = crypto.randomUUID();
    await expect(
      executePolicyCommand({
        db,
        agencyId: 'agency-a',
        actorUserId: 'user-member',
        actorMembershipId: 'member-worker',
        actorIdentityId: 'identity-worker',
        permissionVersion: 1,
        idempotencyKey: 'final-customer-scope-denied',
        payload: { policyNumber: 'FINAL-CUSTOMER-DENIED' },
        command: {
          kind: 'create',
          policyId,
          customerId: 'customer-a',
          requiresAgencyAssign: false,
          values: [
            'customer-a',
            'insurer-a',
            'product-a',
            'branch-a',
            'cash-a',
            'member-worker',
            'FINAL-CUSTOMER-DENIED',
            'FINALCUSTOMERDENIED',
            '2026-01-01',
            '2026-12-31',
            100,
            'TRY',
            null,
            'ACTIVE',
          ],
          resource: {
            assigneeMembershipId: 'member-worker',
            customerAssigneeMembershipId: 'member-a',
            branchId: 'branch-a',
          },
        },
        result: { id: policyId },
        status: 201,
      }),
    ).rejects.toBeInstanceOf(PolicyAuthorizationRaceError);
    expect(
      await db.prepare('SELECT id FROM policies WHERE id=?').bind(policyId).first(),
    ).toBeNull();
  });

  it('rechecks the active authenticated identity inside the mutation transaction', async () => {
    const policyId = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email,status) VALUES('identity-race','user-member','https://race.test','subject-race','race@test.test','ACTIVE')",
      )
      .run();
    await db
      .prepare(
        "UPDATE auth_identities SET status='REVOKED',revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='identity-race'",
      )
      .run();
    await expect(
      executePolicyCommand({
        db,
        agencyId: 'agency-a',
        actorUserId: 'user-member',
        actorMembershipId: 'member-worker',
        actorIdentityId: 'identity-race',
        permissionVersion: 1,
        idempotencyKey: 'final-identity-denied',
        payload: { policyNumber: 'FINAL-IDENTITY-DENIED' },
        command: {
          kind: 'create',
          policyId,
          customerId: 'customer-worker',
          requiresAgencyAssign: false,
          values: [
            'customer-worker',
            'insurer-a',
            'product-a',
            'branch-a',
            'cash-a',
            'member-worker',
            'FINAL-IDENTITY-DENIED',
            'FINALIDENTITYDENIED',
            '2026-01-01',
            '2026-12-31',
            100,
            'TRY',
            null,
            'ACTIVE',
          ],
          resource: {
            assigneeMembershipId: 'member-worker',
            customerAssigneeMembershipId: 'member-worker',
            branchId: 'branch-a',
          },
        },
        result: { id: policyId },
        status: 201,
      }),
    ).rejects.toBeInstanceOf(PolicyAuthorizationRaceError);
    expect(
      await db.prepare('SELECT id FROM policies WHERE id=?').bind(policyId).first(),
    ).toBeNull();
  });

  it('derives health sensitivity from live catalog state inside the mutation transaction', async () => {
    const policyId = crypto.randomUUID();
    await expect(
      executePolicyCommand({
        db,
        agencyId: 'agency-a',
        actorUserId: 'user-a',
        actorMembershipId: 'member-a',
        actorIdentityId: 'identity-a',
        permissionVersion: 2,
        idempotencyKey: 'final-health-denied',
        payload: { policyNumber: 'FINAL-HEALTH-DENIED' },
        command: {
          kind: 'create',
          policyId,
          customerId: 'customer-a',
          requiresAgencyAssign: false,
          values: [
            'customer-a',
            'insurer-a',
            'product-health',
            'branch-health',
            'cash-a',
            'member-a',
            'FINAL-HEALTH-DENIED',
            'FINALHEALTHDENIED',
            '2026-01-01',
            '2026-12-31',
            100,
            'TRY',
            null,
            'ACTIVE',
          ],
          resource: {
            assigneeMembershipId: 'member-a',
            customerAssigneeMembershipId: 'member-a',
            branchId: 'branch-health',
          },
        },
        result: { id: policyId },
        status: 201,
      }),
    ).rejects.toBeInstanceOf(PolicyAuthorizationRaceError);
    expect(
      await db.prepare('SELECT id FROM policies WHERE id=?').bind(policyId).first(),
    ).toBeNull();
  });

  it('treats health access as additive and requires explicit OWNER sensitive permissions', async () => {
    const healthInput = {
      ...input,
      productId: 'product-health',
      branchId: 'branch-health',
      policyNumber: 'HEALTH-1',
    };
    await expect(createPolicy(ctx, db, healthInput, 'health-denied')).rejects.toThrow();
    await db
      .prepare(
        "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES('owner-health-read','member-a','sensitive.health.read','UNSCOPED'),('owner-health-write','member-a','sensitive.health.write','UNSCOPED')",
      )
      .run();
    const health = await createPolicy(ctx, db, healthInput, 'health-allowed');
    expect((await getPolicy(ctx, db, health.data.id)).id).toBe(health.data.id);
    await db
      .prepare(
        "DELETE FROM membership_permissions WHERE id IN ('owner-health-read','owner-health-write')",
      )
      .run();
    await expect(getPolicy(ctx, db, health.data.id)).rejects.toThrow();
    const listed = await listPolicies(ctx, db, {});
    expect(listed.items.some((p) => p.id === health.data.id)).toBe(false);
  });

  it('keeps health permissions additive during the secure identity-variant mutation', async () => {
    const health = await db
      .prepare("SELECT id,version FROM policies WHERE policy_number='HEALTH-1'")
      .first<{ id: string; version: number }>();
    const secureCtx = { ...ctx, assurance: 'SECURE' as const };
    const payload = {
      expectedVersion: health!.version,
      reason: 'Sağlık poliçesi ayrı sözleşme gerekçesi',
    };
    const grant = await issueAndPersistSensitiveActionGrant(db, secureCtx, {
      agencyId: 'agency-a',
      action: 'policy.identity_variant.create',
      payloadHash: await computePayloadHash(payload),
      targetIds: [health!.id],
      expectedTargetVersion: health!.version,
    });
    await expect(
      createPolicyIdentityVariant(
        secureCtx,
        db,
        health!.id,
        { ...payload, grantEvidenceToken: grant.grantToken },
        'health-variant-denied',
      ),
    ).rejects.toBeInstanceOf(PolicyAuthorizationRaceError);
    const grantState = await db
      .prepare('SELECT status FROM sensitive_action_grants WHERE id=?')
      .bind(grant.grantRecord.id)
      .first<{ status: string }>();
    expect(grantState?.status).toBe('ISSUED');
  });

  it('authorizes secure replay against the persisted variant classification, not mutable source state', async () => {
    await db
      .prepare(
        "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES('owner-health-replay-read','member-a','sensitive.health.read','UNSCOPED'),('owner-health-replay-write','member-a','sensitive.health.write','UNSCOPED')",
      )
      .run();
    const source = await db
      .prepare("SELECT id,version FROM policies WHERE policy_number='HEALTH-1'")
      .first<{ id: string; version: number }>();
    const secureCtx = { ...ctx, assurance: 'SECURE' as const };
    const payload = {
      expectedVersion: source!.version,
      reason: 'Sağlık sınıfı tekrar yetki denetimi',
    };
    const grant = await issueAndPersistSensitiveActionGrant(db, secureCtx, {
      agencyId: 'agency-a',
      action: 'policy.identity_variant.create',
      payloadHash: await computePayloadHash(payload),
      targetIds: [source!.id],
      expectedTargetVersion: source!.version,
    });
    await createPolicyIdentityVariant(
      secureCtx,
      db,
      source!.id,
      { ...payload, grantEvidenceToken: grant.grantToken },
      'health-replay-classification',
    );
    await db
      .prepare("UPDATE policies SET product_id='product-a',branch_id='branch-a' WHERE id=?")
      .bind(source!.id)
      .run();
    await db
      .prepare(
        "DELETE FROM membership_permissions WHERE id IN ('owner-health-replay-read','owner-health-replay-write')",
      )
      .run();
    await expect(
      createPolicyIdentityVariant(
        secureCtx,
        db,
        source!.id,
        { ...payload, grantEvidenceToken: grant.grantToken },
        'health-replay-classification',
      ),
    ).rejects.toBeInstanceOf(PolicyAuthorizationRaceError);
  });

  it('binds secure grants to target, action, payload and version and denies reuse or ASSIGNED scope', async () => {
    const source = await createPolicy(
      ctx,
      db,
      { ...input, policyNumber: 'SECURE-BIND' },
      'secure-bind-source',
    );
    const other = await createPolicy(
      ctx,
      db,
      { ...input, policyNumber: 'SECURE-OTHER' },
      'secure-bind-other',
    );
    const secureCtx = { ...ctx, assurance: 'SECURE' as const };
    const issue = async (
      action: string,
      target: string,
      payload: { expectedVersion: number; reason: string },
    ) =>
      issueAndPersistSensitiveActionGrant(db, secureCtx, {
        agencyId: 'agency-a',
        action,
        payloadHash: await computePayloadHash(payload),
        targetIds: [target],
        expectedTargetVersion: payload.expectedVersion,
      });
    const payload = { expectedVersion: 1, reason: 'Bağlama testi için ayrı sözleşme' };
    const wrongPayload = await issue('policy.identity_variant.create', source.data.id, payload);
    await expect(
      createPolicyIdentityVariant(
        secureCtx,
        db,
        source.data.id,
        { ...payload, reason: 'Başka bir gerekçe', grantEvidenceToken: wrongPayload.grantToken },
        'wrong-payload',
      ),
    ).rejects.toThrow();
    const wrongTarget = await issue('policy.identity_variant.create', source.data.id, payload);
    await expect(
      createPolicyIdentityVariant(
        secureCtx,
        db,
        other.data.id,
        { ...payload, grantEvidenceToken: wrongTarget.grantToken },
        'wrong-target',
      ),
    ).rejects.toThrow();
    const wrongAction = await issue('policy.update', source.data.id, payload);
    await expect(
      createPolicyIdentityVariant(
        secureCtx,
        db,
        source.data.id,
        { ...payload, grantEvidenceToken: wrongAction.grantToken },
        'wrong-action',
      ),
    ).rejects.toThrow();
    const stalePayload = { ...payload, expectedVersion: 2 };
    const stale = await issue('policy.identity_variant.create', source.data.id, stalePayload);
    await expect(
      createPolicyIdentityVariant(
        secureCtx,
        db,
        source.data.id,
        { ...stalePayload, grantEvidenceToken: stale.grantToken },
        'wrong-version',
      ),
    ).rejects.toThrow();
    const valid = await issue('policy.identity_variant.create', source.data.id, payload);
    await createPolicyIdentityVariant(
      secureCtx,
      db,
      source.data.id,
      { ...payload, grantEvidenceToken: valid.grantToken },
      'consume-once',
    );
    await expect(
      createPolicyIdentityVariant(
        secureCtx,
        db,
        source.data.id,
        { ...payload, grantEvidenceToken: valid.grantToken },
        'reuse-different-operation',
      ),
    ).rejects.toThrow();

    const workerSecure = {
      userId: 'user-member',
      identityId: 'identity-worker',
      assurance: 'SECURE' as const,
      memberships: [
        {
          id: 'member-worker',
          agencyId: 'agency-a',
          type: 'MEMBER' as const,
          status: 'ACTIVE' as const,
          permissionVersion: 1,
        },
      ],
    };
    const assignedSource = await db
      .prepare("SELECT id,version FROM policies WHERE policy_number='ASSIGNED-POLICY'")
      .first<{ id: string; version: number }>();
    const assignedPayload = {
      expectedVersion: assignedSource!.version,
      reason: 'Atanmış kapsam reddi testi',
    };
    const assignedGrant = await issueAndPersistSensitiveActionGrant(db, workerSecure, {
      agencyId: 'agency-a',
      action: 'policy.identity_variant.create',
      payloadHash: await computePayloadHash(assignedPayload),
      targetIds: [assignedSource!.id],
      expectedTargetVersion: assignedSource!.version,
    });
    await expect(
      createPolicyIdentityVariant(
        workerSecure,
        db,
        assignedSource!.id,
        { ...assignedPayload, grantEvidenceToken: assignedGrant.grantToken },
        'assigned-secure-denied',
      ),
    ).rejects.toThrow();
    await db
      .prepare(
        "UPDATE membership_permissions SET scope='AGENCY' WHERE membership_id='member-worker' AND permission_code IN ('policy.read','policy.update')",
      )
      .run();
    const workerGrant = await issueAndPersistSensitiveActionGrant(db, workerSecure, {
      agencyId: 'agency-a',
      action: 'policy.identity_variant.create',
      payloadHash: await computePayloadHash(payload),
      targetIds: [source.data.id],
      expectedTargetVersion: 1,
    });
    await db
      .prepare(
        "DELETE FROM membership_permissions WHERE membership_id='member-worker' AND permission_code='policy.update'",
      )
      .run();
    await expect(
      executePolicyVariantCommand({
        db,
        agencyId: 'agency-a',
        actorUserId: 'user-member',
        actorMembershipId: 'member-worker',
        actorIdentityId: 'identity-worker',
        permissionVersion: 1,
        idempotencyKey: 'permission-race',
        payload,
        sourcePolicyId: source.data.id,
        expectedVersion: 1,
        reason: payload.reason,
        grantToken: workerGrant.grantToken,
        result: (id, variant, now) => ({ id, variant, now }),
      }),
    ).rejects.toBeInstanceOf(PolicyAuthorizationRaceError);
    const grantState = await db
      .prepare('SELECT status FROM sensitive_action_grants WHERE id=?')
      .bind(workerGrant.grantRecord.id)
      .first<{ status: string }>();
    expect(grantState?.status).toBe('ISSUED');

    await db
      .prepare(
        "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES('pu-replay','member-worker','policy.update','AGENCY')",
      )
      .run();
    const replayGrant = await issueAndPersistSensitiveActionGrant(db, workerSecure, {
      agencyId: 'agency-a',
      action: 'policy.identity_variant.create',
      payloadHash: await computePayloadHash(payload),
      targetIds: [source.data.id],
      expectedTargetVersion: 1,
    });
    await createPolicyIdentityVariant(
      workerSecure,
      db,
      source.data.id,
      { ...payload, grantEvidenceToken: replayGrant.grantToken },
      'member-secure-replay-revoked',
    );
    await db.prepare("DELETE FROM membership_permissions WHERE id='pu-replay'").run();
    await expect(
      createPolicyIdentityVariant(
        workerSecure,
        db,
        source.data.id,
        { ...payload, grantEvidenceToken: replayGrant.grantToken },
        'member-secure-replay-revoked',
      ),
    ).rejects.toBeInstanceOf(PolicyAuthorizationRaceError);
  });

  it('rolls back secure grant consumption, variant and receipt when audit persistence fails', async () => {
    const source = await createPolicy(
      ctx,
      db,
      { ...input, policyNumber: 'SECURE-AUDIT' },
      'secure-audit-source',
    );
    const secureCtx = { ...ctx, assurance: 'SECURE' as const },
      payload = { expectedVersion: 1, reason: 'Denetim geri alma testi' };
    const grant = await issueAndPersistSensitiveActionGrant(db, secureCtx, {
      agencyId: 'agency-a',
      action: 'policy.identity_variant.create',
      payloadHash: await computePayloadHash(payload),
      targetIds: [source.data.id],
      expectedTargetVersion: 1,
    });
    await db
      .prepare(
        "CREATE TRIGGER fail_secure_policy_audit BEFORE INSERT ON audit_events WHEN NEW.action='policy.identity_variant.create' BEGIN SELECT RAISE(ABORT,'AUDIT_FAIL'); END",
      )
      .run();
    await expect(
      createPolicyIdentityVariant(
        secureCtx,
        db,
        source.data.id,
        { ...payload, grantEvidenceToken: grant.grantToken },
        'secure-audit-fail',
      ),
    ).rejects.toThrow('AUDIT_FAIL');
    expect(
      (
        await db
          .prepare('SELECT status FROM sensitive_action_grants WHERE id=?')
          .bind(grant.grantRecord.id)
          .first<{ status: string }>()
      )?.status,
    ).toBe('ISSUED');
    expect(
      (
        await db
          .prepare('SELECT count(*) n FROM policies WHERE normalized_policy_number=?')
          .bind(source.data.normalizedPolicyNumber)
          .first<{ n: number }>()
      )?.n,
    ).toBe(1);
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) n FROM operation_receipts WHERE idempotency_key='secure-audit-fail'",
          )
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    await db.prepare('DROP TRIGGER fail_secure_policy_audit').run();
  });

  it('rolls back business effect and receipt when audit persistence fails', async () => {
    await db
      .prepare(
        "CREATE TRIGGER fail_policy_audit BEFORE INSERT ON audit_events WHEN NEW.target_type='policies' BEGIN SELECT RAISE(ABORT,'AUDIT_FAIL'); END",
      )
      .run();
    await expect(
      createPolicy(ctx, db, { ...input, policyNumber: 'AUDIT-ROLLBACK' }, 'audit-rollback'),
    ).rejects.toThrow('AUDIT_FAIL');
    expect(
      (
        await db
          .prepare("SELECT count(*) n FROM policies WHERE normalized_policy_number='AUDITROLLBACK'")
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) n FROM operation_receipts WHERE idempotency_key='audit-rollback'",
          )
          .first<{ n: number }>()
      )?.n,
    ).toBe(0);
    await db.prepare('DROP TRIGGER fail_policy_audit').run();
  });
});
