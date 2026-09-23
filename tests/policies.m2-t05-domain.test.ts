// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import miniflare from 'miniflare';
import {
  archivePolicy,
  assignPolicy,
  createPolicyAmendment,
  createPolicyExternalReference,
  createPolicyParty,
  deactivatePolicyParty,
  listPolicyAmendments,
  listPolicyExternalReferences,
  listPolicyParties,
  listPolicies,
  updatePolicy,
} from '../src/server/policies/service';
import { IdempotencyConflictError } from '../src/server/mutations/idempotency';
import { archiveCustomer, assignCustomer, listCustomers } from '../src/server/customers/service';
import {
  executePolicyCommand,
  PolicyAuthorizationRaceError,
} from '../src/server/mutations/internal/policy-domain-executor';
import { executePolicyRelationshipCommand } from '../src/server/mutations/internal/policy-relationship-executor';
import { executeCustomerDomainCommand } from '../src/server/mutations/internal/customer-domain-executor';

const { Miniflare, convertV4MiniflareOptions } = miniflare;
const root = resolve(__dirname, '..');
const owner = {
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
const worker = {
  userId: 'user-w',
  identityId: 'identity-w',
  assurance: 'NORMAL' as const,
  memberships: [
    {
      id: 'member-w',
      agencyId: 'agency-a',
      type: 'MEMBER' as const,
      status: 'ACTIVE' as const,
      permissionVersion: 1,
    },
  ],
};

describe('M2-T05 policy relationships and lifecycle on real D1', () => {
  let mf: miniflare.Miniflare;
  let db: D1Database;
  beforeAll(async () => {
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: 'export default {fetch(){return new Response()}}',
        d1Databases: { DB: '00000000-0000-0000-0000-000000000025' },
      }),
    );
    db = await mf.getD1Database('DB');
    for (const file of readdirSync(resolve(root, 'db/migrations'))
      .filter((x) => /^000[0-8]_.*\.sql$/.test(x))
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
        "INSERT INTO users(id,status) VALUES('user-a','INACTIVE'),('user-w','INACTIVE'),('user-b','INACTIVE'),('user-i','INACTIVE')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO agency_memberships(id,agency_id,user_id,type,status,permission_version,invitation_email,invitation_expires_at,activated_at) VALUES('member-a','agency-a','user-a','OWNER','INVITED',1,'a@test.test','2099-01-01Z',NULL),('member-b','agency-b','user-b','OWNER','INVITED',1,'b@test.test','2099-01-01Z',NULL)",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email,status) VALUES('identity-a','user-a','https://test','a','a@test.test','ACTIVE'),('identity-w','user-w','https://test','w','w@test.test','ACTIVE'),('identity-b','user-b','https://test','b','b@test.test','ACTIVE')",
      )
      .run();
    await db.prepare("UPDATE users SET status='ACTIVE',version=2").run();
    await db
      .prepare(
        "UPDATE agency_memberships SET status='ACTIVE',activated_at='2026-01-01Z',version=2,permission_version=2 WHERE id IN ('member-a','member-b')",
      )
      .run();
    await db
      .prepare(
        "UPDATE agencies SET status='ACTIVE',bootstrap_completed_at='2026-01-01Z',activated_at='2026-01-01Z',version=2",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO agency_memberships(id,agency_id,user_id,type,status,permission_version,invitation_email,invitation_expires_at,activated_at) VALUES('member-w','agency-a','user-w','MEMBER','ACTIVE',1,'w@test.test','2099-01-01Z','2026-01-01Z')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO agency_memberships(id,agency_id,user_id,type,status,permission_version,invitation_email,invitation_expires_at,inactivated_at) VALUES('member-i','agency-a','user-i','MEMBER','INACTIVE',1,'i@test.test','2099-01-01Z','2026-01-01Z')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES('r','member-w','policy.read','ASSIGNED'),('u','member-w','policy.update','ASSIGNED'),('ar','member-w','policy.archive','ASSIGNED'),('cr','member-w','customer.read','ASSIGNED'),('ca','member-w','customer.assign','ASSIGNED')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES('customer-policy','agency-a','INDIVIDUAL','Policy Owner','P','O','member-a'),('customer-party','agency-a','INDIVIDUAL','Party','P','A','member-w'),('customer-free','agency-a','INDIVIDUAL','Free','F','R','member-a'),('customer-race','agency-a','INDIVIDUAL','Race','R','C','member-a'),('customer-audit','agency-a','INDIVIDUAL','Audit','A','U','member-a'),('customer-unarchive','agency-a','INDIVIDUAL','Unarchive','U','A','member-a'),('customer-assign','agency-a','INDIVIDUAL','Assign','A','S','member-a'),('customer-assign-race','agency-a','INDIVIDUAL','Assign Race','A','R','member-a'),('customer-worker-replay','agency-a','INDIVIDUAL','Worker Replay','W','R','member-w'),('customer-isolated','agency-a','INDIVIDUAL','Isolated','I','S','member-a'),('customer-b','agency-b','INDIVIDUAL','Other','O','B','member-b')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO insurers(id,agency_id,code,name) VALUES('insurer-a','agency-a','A','A'),('insurer-b','agency-b','B','B')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('branch-a','agency-a','AUTO','Auto','GENERAL'),('branch-b','agency-b','AUTO','Auto','GENERAL')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('product-a','agency-a','insurer-a','branch-a','P','P'),('product-b','agency-b','insurer-b','branch-b','P','P')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO payment_methods(id,agency_id,code,name,supports_installments,max_installments) VALUES('cash-a','agency-a','CASH','Cash',0,12),('cash-b','agency-b','CASH','Cash',0,12)",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency,status,version) VALUES('policy-a','agency-a','customer-policy','insurer-a','product-a','branch-a','cash-a','member-a','PA','PA','2026-01-01','2026-12-31',100,'TRY','ACTIVE',1),('policy-assign','agency-a','customer-policy','insurer-a','product-a','branch-a','cash-a','member-a','PASN','PASN','2026-01-01','2026-12-31',100,'TRY','ACTIVE',1),('policy-party-parent','agency-a','customer-policy','insurer-a','product-a','branch-a','cash-a','member-w','PPAR','PPAR','2026-01-01','2026-12-31',100,'TRY','ACTIVE',1),('policy-isolated-other','agency-a','customer-isolated','insurer-a','product-a','branch-a','cash-a','member-a','POTH','POTH','2026-01-01','2026-12-31',100,'TRY','ACTIVE',1),('policy-b','agency-b','customer-b','insurer-b','product-b','branch-b','cash-b','member-b','PB','PB','2026-01-01','2026-12-31',100,'TRY','ACTIVE',1)",
      )
      .run();
  });
  afterAll(async () => mf.dispose());

  it('creates INSURED and BENEFICIARY parties, rejects cross-agency relations, and party ownership does not widen policy scope', async () => {
    const insured = await createPolicyParty(
      owner,
      db,
      'policy-a',
      { expectedVersion: 1, customerId: 'customer-party', role: 'INSURED' },
      'party-1',
    );
    const beneficiary = await createPolicyParty(
      owner,
      db,
      'policy-a',
      { expectedVersion: 2, customerId: 'customer-policy', role: 'BENEFICIARY' },
      'party-2',
    );
    expect([insured.data.role, beneficiary.data.role]).toEqual(['INSURED', 'BENEFICIARY']);
    expect(insured.data.customerDisplayName).toBe('Party');
    expect(
      (await listPolicyParties(owner, db, 'policy-a')).map((x) => x.customerDisplayName),
    ).toEqual(['Party', 'Policy Owner']);
    await expect(listPolicyParties(worker, db, 'policy-a')).rejects.toThrow();
    await expect(
      createPolicyParty(
        owner,
        db,
        'policy-a',
        { expectedVersion: 3, customerId: 'customer-b', role: 'INSURED' },
        'party-cross',
      ),
    ).rejects.toMatchObject({ code: 'CUSTOMER_NOT_FOUND' });
    await expect(
      createPolicyParty(
        worker,
        db,
        'policy-a',
        { expectedVersion: 3, customerId: 'customer-party', role: 'INSURED' },
        'party-scope',
      ),
    ).rejects.toThrow();
    await expect(
      createPolicyParty(
        owner,
        db,
        'policy-b',
        { expectedVersion: 1, customerId: 'customer-policy', role: 'INSURED' },
        'party-parent-cross',
      ),
    ).rejects.toThrow();
    await expect(
      createPolicyParty(
        owner,
        db,
        'policy-a',
        { expectedVersion: 2, customerId: 'customer-free', role: 'INSURED' },
        'party-stale',
      ),
    ).rejects.toThrow();
    expect((await listPolicies(worker, db, {})).items.map((item) => item.id)).toEqual([
      'policy-party-parent',
    ]);
    await expect(
      createPolicyParty(
        worker,
        db,
        'policy-party-parent',
        { expectedVersion: 1, customerId: 'customer-isolated', role: 'INSURED' },
        'party-portfolio-denied',
      ),
    ).rejects.toThrow();
    await createPolicyParty(
      owner,
      db,
      'policy-party-parent',
      { expectedVersion: 1, customerId: 'customer-isolated', role: 'INSURED' },
      'party-portfolio-isolation',
    );
    expect(await listPolicyParties(worker, db, 'policy-party-parent')).toHaveLength(1);
    const workerPolicies = (await listPolicies(worker, db, {})).items.map((item) => item.id);
    expect(workerPolicies).toContain('policy-party-parent');
    expect(workerPolicies).not.toContain('policy-isolated-other');
  });

  it('deactivates by CAS and exact retry creates no second effect or audit', async () => {
    const created = await createPolicyParty(
      owner,
      db,
      'policy-a',
      { expectedVersion: 3, customerId: 'customer-party', role: 'BENEFICIARY' },
      'party-3',
    );
    const payload = { expectedVersion: 1 };
    const first = await deactivatePolicyParty(
      owner,
      db,
      'policy-a',
      created.data.id,
      payload,
      'party-deactivate',
    );
    const replay = await deactivatePolicyParty(
      owner,
      db,
      'policy-a',
      created.data.id,
      payload,
      'party-deactivate',
    );
    expect(first.data.status).toBe('INACTIVE');
    expect(replay.replayed).toBe(true);
    const otherParty = (await listPolicyParties(owner, db, 'policy-a')).find(
      (item) => item.id !== created.data.id,
    )!;
    await expect(
      deactivatePolicyParty(owner, db, 'policy-a', otherParty.id, payload, 'party-deactivate'),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    expect(
      (await db
        .prepare(
          "SELECT count(*) n FROM audit_events WHERE action='policy_party.deactivated' AND target_id=?",
        )
        .bind(created.data.id)
        .first<{ n: number }>())!.n,
    ).toBe(1);
  });

  it('rejects party deactivation after its policy is archived', async () => {
    await db
      .prepare(
        "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency,status,version) VALUES('policy-party-archive','agency-a','customer-policy','insurer-a','product-a','branch-a','cash-a','member-a','PARCH','PARCH','2026-01-01','2026-12-31',100,'TRY','ACTIVE',1)",
      )
      .run();
    const party = await createPolicyParty(
      owner,
      db,
      'policy-party-archive',
      { expectedVersion: 1, customerId: 'customer-party', role: 'INSURED' },
      'party-before-archive',
    );
    await archivePolicy(
      owner,
      db,
      'policy-party-archive',
      { expectedVersion: 2, reasonCode: 'OTHER' },
      'archive-with-party',
    );
    await expect(
      deactivatePolicyParty(
        owner,
        db,
        'policy-party-archive',
        party.data.id,
        { expectedVersion: 1 },
        'deactivate-after-archive',
      ),
    ).rejects.toMatchObject({ code: 'POLICY_ARCHIVED' });
  });

  it('rechecks live authority before returning exact executor replays', async () => {
    await db
      .prepare(
        "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency,status,version) VALUES('policy-replay-auth','agency-a','customer-policy','insurer-a','product-a','branch-a','cash-a','member-w','PRA','PRA','2026-01-01','2026-12-31',100,'TRY','ACTIVE',1),('policy-rel-replay-auth','agency-a','customer-policy','insurer-a','product-a','branch-a','cash-a','member-w','PRRA','PRRA','2026-01-01','2026-12-31',100,'TRY','ACTIVE',1)",
      )
      .run();
    const domainInput = {
      db,
      agencyId: 'agency-a',
      actorUserId: 'user-w',
      actorMembershipId: 'member-w',
      actorIdentityId: 'identity-w',
      permissionVersion: 1,
      idempotencyKey: 'domain-replay-authority',
      payload: { expectedVersion: 1, policyNumber: 'PRA-UPDATED' },
      command: {
        kind: 'update' as const,
        policyId: 'policy-replay-auth',
        expectedVersion: 1,
        changes: { policyNumber: 'PRA-UPDATED', normalizedPolicyNumber: 'PRA-UPDATED' },
        resource: {
          assigneeMembershipId: 'member-a',
          customerAssigneeMembershipId: 'member-a',
          branchId: 'branch-a',
        },
      },
      result: { id: 'policy-replay-auth' },
      status: 200,
    };
    await executePolicyCommand(domainInput);
    await db
      .prepare(
        "UPDATE auth_identities SET status='REVOKED',revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='identity-w'",
      )
      .run();
    await expect(executePolicyCommand(domainInput)).rejects.toBeInstanceOf(
      PolicyAuthorizationRaceError,
    );
    await db
      .prepare(
        "UPDATE auth_identities SET status='ACTIVE',revoked_at=NULL,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='identity-w'",
      )
      .run();

    const relationshipInput = {
      db,
      agencyId: 'agency-a',
      actorUserId: 'user-w',
      actorMembershipId: 'member-w',
      actorIdentityId: 'identity-w',
      permissionVersion: 1,
      idempotencyKey: 'relationship-replay-authority',
      payload: { expectedVersion: 1, sourceNamespace: 'TEST', externalKey: 'REPLAY' },
      command: {
        kind: 'policy_external_reference.create' as const,
        policyId: 'policy-rel-replay-auth',
        expectedVersion: 1,
        referenceId: 'reference-replay-auth',
        sourceNamespace: 'TEST',
        externalKey: 'REPLAY',
      },
      result: { id: 'reference-replay-auth' },
      status: 201,
    };
    await executePolicyRelationshipCommand(relationshipInput);
    await db
      .prepare(
        "UPDATE auth_identities SET status='REVOKED',revoked_at=strftime('%Y-%m-%dT%H:%M:%fZ','now'),version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='identity-w'",
      )
      .run();
    await expect(executePolicyRelationshipCommand(relationshipInput)).rejects.toBeInstanceOf(
      PolicyAuthorizationRaceError,
    );
    await db
      .prepare(
        "UPDATE auth_identities SET status='ACTIVE',revoked_at=NULL,version=version+1,updated_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id='identity-w'",
      )
      .run();
  });

  it('assigns policy with live scope, CAS, idempotency, and atomic active same-agency target enforcement', async () => {
    const payload = { expectedVersion: 1, assigneeMembershipId: 'member-w' };
    const assigned = await assignPolicy(owner, db, 'policy-assign', payload, 'policy-assign-1');
    const replay = await assignPolicy(owner, db, 'policy-assign', payload, 'policy-assign-1');
    expect(assigned.data.assigneeMembershipId).toBe('member-w');
    expect(replay.replayed).toBe(true);
    expect(
      (await listPolicies(worker, db, {})).items.some((item) => item.id === 'policy-assign'),
    ).toBe(true);
    await expect(
      assignPolicy(
        owner,
        db,
        'policy-assign',
        { expectedVersion: 1, assigneeMembershipId: 'member-a' },
        'policy-assign-stale',
      ),
    ).rejects.toThrow();
    await expect(
      assignPolicy(
        owner,
        db,
        'policy-assign',
        { expectedVersion: 2, assigneeMembershipId: 'member-i' },
        'policy-assign-inactive',
      ),
    ).rejects.toMatchObject({ code: 'ASSIGNEE_NOT_ACTIVE' });
    await expect(
      assignPolicy(
        owner,
        db,
        'policy-assign',
        { expectedVersion: 2, assigneeMembershipId: 'member-b' },
        'policy-assign-cross',
      ),
    ).rejects.toMatchObject({ code: 'ASSIGNEE_NOT_ACTIVE' });
    await expect(
      executePolicyCommand({
        db,
        agencyId: 'agency-a',
        actorUserId: 'user-a',
        actorMembershipId: 'member-a',
        actorIdentityId: 'identity-a',
        permissionVersion: 2,
        idempotencyKey: 'policy-assign-atomic-target',
        payload: { expectedVersion: 2, assigneeMembershipId: 'member-i' },
        command: {
          kind: 'assign',
          policyId: 'policy-assign',
          expectedVersion: 2,
          assigneeMembershipId: 'member-i',
          resource: {
            assigneeMembershipId: 'member-w',
            customerAssigneeMembershipId: 'member-a',
            branchId: 'branch-a',
          },
        },
        result: assigned.data,
        status: 200,
      }),
    ).rejects.toMatchObject({ code: 'ASSIGNEE_NOT_ACTIVE' });
    expect(
      (await db
        .prepare(
          "SELECT count(*) n FROM audit_events WHERE action='policy.assign' AND target_id='policy-assign'",
        )
        .first<{ n: number }>())!.n,
    ).toBe(1);
  });

  it('rejects a dependency scope narrower than the direct permission inside both atomic executors', async () => {
    await db
      .prepare(
        "UPDATE membership_permissions SET scope='AGENCY' WHERE membership_id='member-w' AND permission_code='policy.update'",
      )
      .run();
    const resource = {
      assigneeMembershipId: 'member-w',
      customerAssigneeMembershipId: 'member-a',
      branchId: 'branch-a',
    };
    try {
      await expect(
        executePolicyCommand({
          db,
          agencyId: 'agency-a',
          actorUserId: 'user-w',
          actorMembershipId: 'member-w',
          actorIdentityId: 'identity-w',
          permissionVersion: 1,
          idempotencyKey: 'policy-scope-order-domain',
          payload: { expectedVersion: 2, currency: 'TRY' },
          command: {
            kind: 'update',
            policyId: 'policy-assign',
            expectedVersion: 2,
            changes: { currency: 'TRY' },
            resource,
          },
          result: { id: 'policy-assign' },
          status: 200,
        }),
      ).rejects.toThrow('FINAL_AUTHORITY_RECHECK_FAILED');
      await expect(
        executePolicyRelationshipCommand({
          db,
          agencyId: 'agency-a',
          actorUserId: 'user-w',
          actorMembershipId: 'member-w',
          actorIdentityId: 'identity-w',
          permissionVersion: 1,
          idempotencyKey: 'policy-scope-order-relationship',
          payload: { expectedVersion: 2, customerId: 'customer-policy', role: 'BENEFICIARY' },
          command: {
            kind: 'policy_party.create',
            policyId: 'policy-assign',
            expectedVersion: 2,
            partyId: 'party-scope-order',
            customerId: 'customer-policy',
            role: 'BENEFICIARY',
          },
          result: { id: 'party-scope-order' },
          status: 201,
        }),
      ).rejects.toThrow('FINAL_AUTHORITY_RECHECK_FAILED');
    } finally {
      await db
        .prepare(
          "UPDATE membership_permissions SET scope='ASSIGNED' WHERE membership_id='member-w' AND permission_code='policy.update'",
        )
        .run();
    }
  });

  it('creates a minimal amendment without creating a policy and rolls back when audit fails', async () => {
    const before = (await db.prepare('SELECT count(*) n FROM policies').first<{ n: number }>())!.n;
    const amendment = await createPolicyAmendment(
      owner,
      db,
      'policy-a',
      {
        expectedVersion: 4,
        externalReference: 'END-1',
        effectiveDate: '2026-06-01',
        description: 'Coverage corrected',
        premiumDifference: '-12.34',
        currency: 'TRY',
      },
      'amend-1',
    );
    const retry = await createPolicyAmendment(
      owner,
      db,
      'policy-a',
      {
        expectedVersion: 4,
        externalReference: 'END-1',
        effectiveDate: '2026-06-01',
        description: 'Coverage corrected',
        premiumDifference: '-12.34',
        currency: 'TRY',
      },
      'amend-1',
    );
    expect(amendment.data.premiumDifferenceMinor).toBe(-1234);
    expect(retry.replayed).toBe(true);
    expect(await listPolicyAmendments(owner, db, 'policy-a')).toHaveLength(1);
    await expect(
      createPolicyAmendment(
        owner,
        db,
        'policy-b',
        {
          expectedVersion: 1,
          externalReference: 'CROSS',
          effectiveDate: '2026-06-01',
          description: 'Cross',
          premiumDifference: null,
          currency: null,
        },
        'amend-cross',
      ),
    ).rejects.toThrow();
    expect((await db.prepare('SELECT count(*) n FROM policies').first<{ n: number }>())!.n).toBe(
      before,
    );
    await db
      .prepare(
        "CREATE TRIGGER fail_amend_audit BEFORE INSERT ON audit_events WHEN NEW.action='policy_amendment.created' BEGIN SELECT RAISE(ABORT,'AUDIT_FAIL'); END",
      )
      .run();
    await expect(
      createPolicyAmendment(
        owner,
        db,
        'policy-a',
        {
          expectedVersion: 5,
          externalReference: 'END-2',
          effectiveDate: '2026-07-01',
          description: 'Must roll back',
          premiumDifference: null,
          currency: null,
        },
        'amend-fail',
      ),
    ).rejects.toThrow('AUDIT_FAIL');
    expect(
      (await db
        .prepare("SELECT count(*) n FROM policy_amendments WHERE external_reference='END-2'")
        .first<{ n: number }>())!.n,
    ).toBe(0);
    await db.prepare('DROP TRIGGER fail_amend_audit').run();
  });

  it('binds external-reference replay before canonical duplicate handling and permits cross-agency namespaces', async () => {
    const payload = { expectedVersion: 5, sourceNamespace: 'LEGACY', externalKey: '42' };
    const first = await createPolicyExternalReference(owner, db, 'policy-a', payload, 'ref-1');
    const replay = await createPolicyExternalReference(owner, db, 'policy-a', payload, 'ref-1');
    expect(replay.data.id).toBe(first.data.id);
    expect(replay.replayed).toBe(true);
    expect(await listPolicyExternalReferences(owner, db, 'policy-a')).toHaveLength(1);
    await expect(
      createPolicyExternalReference(
        owner,
        db,
        'policy-a',
        { ...payload, externalKey: '43' },
        'ref-1',
      ),
    ).rejects.toBeInstanceOf(IdempotencyConflictError);
    await expect(
      createPolicyExternalReference(
        owner,
        db,
        'policy-a',
        { ...payload, expectedVersion: 6 },
        'ref-2',
      ),
    ).rejects.toMatchObject({ code: 'DUPLICATE_EXTERNAL_REFERENCE' });
    const concurrent = await Promise.allSettled([
      createPolicyExternalReference(
        owner,
        db,
        'policy-a',
        { expectedVersion: 6, sourceNamespace: 'LEGACY', externalKey: '99' },
        'ref-race-1',
      ),
      createPolicyExternalReference(
        owner,
        db,
        'policy-a',
        { expectedVersion: 6, sourceNamespace: 'LEGACY', externalKey: '99' },
        'ref-race-2',
      ),
    ]);
    expect(concurrent.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    await db
      .prepare(
        "INSERT INTO policy_external_references(id,agency_id,policy_id,source_namespace,external_key) VALUES('ref-b','agency-b','policy-b','LEGACY','42')",
      )
      .run();
    expect(
      (await db
        .prepare(
          "SELECT count(*) n FROM audit_events WHERE action='policy_external_reference.created' AND target_id=?",
        )
        .bind(first.data.id)
        .first<{ n: number }>())!.n,
    ).toBe(1);
    const audit = await db
      .prepare(
        "SELECT metadata_json FROM audit_events WHERE action='policy_external_reference.created' AND target_id=?",
      )
      .bind(first.data.id)
      .first<{ metadata_json: string }>();
    expect(audit!.metadata_json).not.toContain('42');
  });

  it('archives separately from lifecycle status, preserves history, enforces CAS/reason, and replays exactly', async () => {
    const payload = { expectedVersion: 7, reasonCode: 'DUPLICATE_RECORD' };
    const first = await archivePolicy(owner, db, 'policy-a', payload, 'policy-archive');
    const replay = await archivePolicy(owner, db, 'policy-a', payload, 'policy-archive');
    expect(first.data.status).toBe('ACTIVE');
    expect(first.data.archivedAt).not.toBeNull();
    expect(replay.replayed).toBe(true);
    expect(
      (await db
        .prepare("SELECT count(*) n FROM policy_parties WHERE policy_id='policy-a'")
        .first<{ n: number }>())!.n,
    ).toBeGreaterThan(0);
    expect(
      (await db
        .prepare("SELECT count(*) n FROM policy_amendments WHERE policy_id='policy-a'")
        .first<{ n: number }>())!.n,
    ).toBe(1);
    await expect(
      db
        .prepare(
          "INSERT INTO policy_parties(id,agency_id,policy_id,customer_id,role) VALUES('party-after-archive','agency-a','policy-a','customer-policy','INSURED')",
        )
        .run(),
    ).rejects.toThrow('POLICY_ARCHIVED');
    await expect(
      db
        .prepare(
          "INSERT INTO policy_amendments(id,agency_id,policy_id,external_reference,effective_date,description) VALUES('amend-after-archive','agency-a','policy-a','X','2026-08-01','x')",
        )
        .run(),
    ).rejects.toThrow('POLICY_ARCHIVED');
    await expect(
      db
        .prepare(
          "INSERT INTO policy_external_references(id,agency_id,policy_id,source_namespace,external_key) VALUES('ref-after-archive','agency-a','policy-a','X','X')",
        )
        .run(),
    ).rejects.toThrow('POLICY_ARCHIVED');
    await db
      .prepare(
        "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency,status) VALUES('policy-open-child','agency-a','customer-policy','insurer-a','product-a','branch-a','cash-a','member-a','OPENCH','OPENCH','2026-01-01','2026-12-31',100,'TRY','ACTIVE')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO policy_parties(id,agency_id,policy_id,customer_id,role) VALUES('party-reparent','agency-a','policy-open-child','customer-policy','BENEFICIARY')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO policy_amendments(id,agency_id,policy_id,external_reference,effective_date,description) VALUES('amend-reparent','agency-a','policy-open-child','REPAR','2026-08-01','x')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO policy_external_references(id,agency_id,policy_id,source_namespace,external_key) VALUES('ref-reparent','agency-a','policy-open-child','REPAR','1')",
      )
      .run();
    await expect(
      db.prepare("UPDATE policy_parties SET policy_id='policy-a' WHERE id='party-reparent'").run(),
    ).rejects.toThrow('POLICY_ARCHIVED');
    await expect(
      db
        .prepare("UPDATE policy_amendments SET policy_id='policy-a' WHERE id='amend-reparent'")
        .run(),
    ).rejects.toThrow('POLICY_ARCHIVED');
    await expect(
      db
        .prepare(
          "UPDATE policy_external_references SET policy_id='policy-a' WHERE id='ref-reparent'",
        )
        .run(),
    ).rejects.toThrow('POLICY_ARCHIVED');
    await db.prepare("UPDATE policies SET status='CANCELLED' WHERE id='policy-b'").run();
    expect(
      (await db
        .prepare("SELECT archived_at FROM policies WHERE id='policy-b'")
        .first<{ archived_at: string | null }>())!.archived_at,
    ).toBeNull();

    await db
      .prepare(
        "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency,status) VALUES('policy-archive-audit','agency-a','customer-policy','insurer-a','product-a','branch-a','cash-a','member-a','AUDIT','AUDIT','2026-01-01','2026-12-31',100,'TRY','VOIDED')",
      )
      .run();
    await expect(
      archivePolicy(
        owner,
        db,
        'policy-archive-audit',
        { expectedVersion: 99, reasonCode: 'DUPLICATE_RECORD' },
        'policy-archive-stale',
      ),
    ).rejects.toThrow();
    await db
      .prepare(
        "CREATE TRIGGER fail_policy_archive_audit BEFORE INSERT ON audit_events WHEN NEW.action='policy.archived' BEGIN SELECT RAISE(ABORT,'AUDIT_FAIL'); END",
      )
      .run();
    await expect(
      archivePolicy(
        owner,
        db,
        'policy-archive-audit',
        { expectedVersion: 1, reasonCode: 'DUPLICATE_RECORD' },
        'policy-archive-audit',
      ),
    ).rejects.toThrow('AUDIT_FAIL');
    expect(
      (await db
        .prepare("SELECT archived_at,status FROM policies WHERE id='policy-archive-audit'")
        .first<{ archived_at: string | null; status: string }>())!,
    ).toMatchObject({ archived_at: null, status: 'VOIDED' });
    await db.prepare('DROP TRIGGER fail_policy_archive_audit').run();

    await db
      .prepare(
        "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency,status) VALUES('policy-archive-race','agency-a','customer-policy','insurer-a','product-a','branch-a','cash-a','member-a','ARCHR','ARCHR','2026-01-01','2026-12-31',100,'TRY','VOIDED')",
      )
      .run();
    const archiveRace = await Promise.allSettled([
      archivePolicy(
        owner,
        db,
        'policy-archive-race',
        { expectedVersion: 1, reasonCode: 'DUPLICATE_RECORD' },
        'policy-archive-race-1',
      ),
      archivePolicy(
        owner,
        db,
        'policy-archive-race',
        { expectedVersion: 1, reasonCode: 'DUPLICATE_RECORD' },
        'policy-archive-race-2',
      ),
    ]);
    expect(archiveRace.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(
      (await db
        .prepare(
          "SELECT count(*) n FROM audit_events WHERE action='policy.archived' AND target_id='policy-archive-race'",
        )
        .first<{ n: number }>())!.n,
    ).toBe(1);
    expect(
      (await db
        .prepare(
          "SELECT count(*) n FROM operation_receipts WHERE action='policy.archive' AND idempotency_key LIKE 'policy-archive-race-%'",
        )
        .first<{ n: number }>())!.n,
    ).toBe(1);
  });

  it('rejects normal update and assignment commands for archived policies', async () => {
    for (const id of ['policy-archived-update', 'policy-archived-assign']) {
      await db
        .prepare(
          `INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency,status,archived_at,archived_by_membership_id,archive_reason)
           VALUES(?,'agency-a','customer-policy','insurer-a','product-a','branch-a','cash-a','member-a',?,?, '2026-01-01','2026-12-31',100,'TRY','ACTIVE','2026-09-21T00:00:00.000Z','member-a','DUPLICATE_RECORD')`,
        )
        .bind(id, id, id.toUpperCase())
        .run();
    }
    await expect(
      updatePolicy(
        owner,
        db,
        'policy-archived-update',
        { expectedVersion: 1, policyNumber: 'SHOULD-NOT-CHANGE' },
        'archived-update',
      ),
    ).rejects.toMatchObject({ code: 'POLICY_ARCHIVED' });
    await expect(
      assignPolicy(
        owner,
        db,
        'policy-archived-assign',
        { expectedVersion: 1, assigneeMembershipId: 'member-w' },
        'archived-assign',
      ),
    ).rejects.toMatchObject({ code: 'POLICY_ARCHIVED' });
  });

  it('allows health archive with archive authority and health grants without policy update', async () => {
    await db
      .prepare(
        "INSERT INTO insurance_branches(id,agency_id,code,name,data_classification) VALUES('branch-health-archive','agency-a','HEALTH-ARCHIVE','Health Archive','HEALTH')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('product-health-archive','agency-a','insurer-a','branch-health-archive','PHA','PHA')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency,status) VALUES('policy-health-archive','agency-a','customer-party','insurer-a','product-health-archive','branch-health-archive','cash-a','member-w','PHA','PHA','2026-01-01','2026-12-31',100,'TRY','ACTIVE')",
      )
      .run();
    await db.prepare("DELETE FROM membership_permissions WHERE id='u'").run();
    await db
      .prepare(
        "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES('health-archive-read','member-w','sensitive.health.read','UNSCOPED'),('health-archive-write','member-w','sensitive.health.write','UNSCOPED')",
      )
      .run();
    try {
      const archived = await archivePolicy(
        worker,
        db,
        'policy-health-archive',
        { expectedVersion: 1, reasonCode: 'DUPLICATE_RECORD' },
        'health-archive',
      );
      expect(archived.data.archivedAt).not.toBeNull();
    } finally {
      await db
        .prepare(
          "DELETE FROM membership_permissions WHERE id IN ('health-archive-read','health-archive-write')",
        )
        .run();
      await db
        .prepare(
          "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES('u','member-w','policy.update','ASSIGNED')",
        )
        .run();
    }
  });

  it('archives customers atomically against open-policy creation and rolls back with audit', async () => {
    await db
      .prepare(
        "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency,status) VALUES('policy-open','agency-a','customer-party','insurer-a','product-a','branch-a','cash-a','member-a','OPEN','OPEN','2026-01-01','2026-12-31',100,'TRY','ACTIVE')",
      )
      .run();
    await expect(
      archiveCustomer(
        db,
        owner,
        'customer-party',
        { expectedVersion: 1, reasonCode: 'DUPLICATE_RECORD' },
        { correlationId: 'c-open', idempotencyKey: 'customer-open' },
      ),
    ).rejects.toMatchObject({ code: 'OPEN_DEPENDENCIES' });

    const first = await archiveCustomer(
      db,
      owner,
      'customer-free',
      { expectedVersion: 1, reasonCode: 'DUPLICATE_RECORD' },
      { correlationId: 'c-free', idempotencyKey: 'customer-free' },
    );
    const replay = await archiveCustomer(
      db,
      owner,
      'customer-free',
      { expectedVersion: 1, reasonCode: 'DUPLICATE_RECORD' },
      { correlationId: 'c-free-2', idempotencyKey: 'customer-free' },
    );
    expect(first.archivedAt).not.toBeNull();
    expect(replay.id).toBe(first.id);
    await expect(
      db
        .prepare(
          "INSERT INTO policy_parties(id,agency_id,policy_id,customer_id,role) VALUES('party-archived-customer','agency-a','policy-assign','customer-free','INSURED')",
        )
        .run(),
    ).rejects.toThrow('CUSTOMER_ARCHIVED');
    expect(
      (await db
        .prepare(
          "SELECT count(*) n FROM audit_events WHERE action='customer.archived' AND target_id='customer-free'",
        )
        .first<{ n: number }>())!.n,
    ).toBe(1);

    const archiveRace = archiveCustomer(
      db,
      owner,
      'customer-race',
      { expectedVersion: 1, reasonCode: 'DUPLICATE_RECORD' },
      { correlationId: 'c-race', idempotencyKey: 'customer-race' },
    );
    const policyRace = db
      .prepare(
        "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency,status) VALUES('policy-race','agency-a','customer-race','insurer-a','product-a','branch-a','cash-a','member-a','RACE','RACE','2026-01-01','2026-12-31',100,'TRY','ACTIVE')",
      )
      .run();
    const outcomes = await Promise.allSettled([archiveRace, policyRace]);
    expect(outcomes.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const state = await db
      .prepare(
        "SELECT c.archived_at,(SELECT count(*) FROM policies p WHERE p.customer_id=c.id AND p.archived_at IS NULL) open_count FROM customers c WHERE c.id='customer-race'",
      )
      .first<{ archived_at: string | null; open_count: number }>();
    expect(state!.archived_at !== null && state!.open_count > 0).toBe(false);
    const expectedCommittedArchives = state!.archived_at === null ? 0 : 1;
    expect(
      (await db
        .prepare(
          "SELECT count(*) n FROM audit_events WHERE action='customer.archived' AND target_id='customer-race'",
        )
        .first<{ n: number }>())!.n,
    ).toBe(expectedCommittedArchives);
    expect(
      (await db
        .prepare(
          "SELECT count(*) n FROM operation_receipts WHERE action='customer.archive' AND idempotency_key='customer-race'",
        )
        .first<{ n: number }>())!.n,
    ).toBe(expectedCommittedArchives);

    await db
      .prepare(
        "CREATE TRIGGER fail_customer_archive_audit BEFORE INSERT ON audit_events WHEN NEW.action='customer.archived' BEGIN SELECT RAISE(ABORT,'AUDIT_FAIL'); END",
      )
      .run();
    await expect(
      archiveCustomer(
        db,
        owner,
        'customer-audit',
        { expectedVersion: 1, reasonCode: 'DUPLICATE_RECORD' },
        { correlationId: 'c-audit', idempotencyKey: 'customer-audit' },
      ),
    ).rejects.toThrow('AUDIT_FAIL');
    expect(
      (await db
        .prepare("SELECT archived_at FROM customers WHERE id='customer-audit'")
        .first<{ archived_at: string | null }>())!.archived_at,
    ).toBeNull();
    await db.prepare('DROP TRIGGER fail_customer_archive_audit').run();

    await expect(
      db
        .prepare(
          "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency,status,archived_at,archived_by_membership_id,archive_reason) VALUES('policy-bad-reason','agency-a','customer-policy','insurer-a','product-a','branch-a','cash-a','member-a','BADR','BADR','2026-01-01','2026-12-31',100,'TRY','VOIDED','2026-01-01Z','member-a','bad reason')",
        )
        .run(),
    ).rejects.toThrow('POLICY_ARCHIVE_REASON_INVALID');
    await expect(
      db
        .prepare(
          "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency,status,archived_at,archived_by_membership_id,archive_reason) VALUES('policy-null-reason','agency-a','customer-policy','insurer-a','product-a','branch-a','cash-a','member-a','NULLR','NULLR','2026-01-01','2026-12-31',100,'TRY','VOIDED','2026-01-01Z','member-a',NULL)",
        )
        .run(),
    ).rejects.toThrow('POLICY_ARCHIVE_REASON_INVALID');
    await expect(
      db
        .prepare(
          "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id,archived_at,archived_by_membership_id,archive_reason_code) VALUES('customer-null-reason','agency-a','INDIVIDUAL','Null Reason','Null','Reason','member-a','2026-01-01Z','member-a',NULL)",
        )
        .run(),
    ).rejects.toThrow('CUSTOMER_ARCHIVE_STATE_INVALID');
    await expect(
      db.prepare("UPDATE customers SET agency_id='agency-b' WHERE id='customer-free'").run(),
    ).rejects.toThrow('CUSTOMER_ARCHIVE_STATE_INVALID');
    await db
      .prepare(
        "INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES('customer-party-only','agency-a','INDIVIDUAL','Party Only','Party','Only','member-a')",
      )
      .run();
    await db
      .prepare(
        "INSERT INTO policy_parties(id,agency_id,policy_id,customer_id,role) VALUES('party-only-dependency','agency-a','policy-assign','customer-party-only','INSURED')",
      )
      .run();
    await expect(
      archiveCustomer(
        db,
        owner,
        'customer-party-only',
        { expectedVersion: 1, reasonCode: 'DUPLICATE_RECORD' },
        { correlationId: 'c-party-only', idempotencyKey: 'customer-party-only' },
      ),
    ).rejects.toMatchObject({ code: 'OPEN_DEPENDENCIES' });
    await db
      .prepare(
        "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency,status,archived_at,archived_by_membership_id,archive_reason) VALUES('policy-unarchive','agency-a','customer-unarchive','insurer-a','product-a','branch-a','cash-a','member-a','UNAR','UNAR','2026-01-01','2026-12-31',100,'TRY','VOIDED','2026-01-01Z','member-a','DUPLICATE_RECORD')",
      )
      .run();
    await archiveCustomer(
      db,
      owner,
      'customer-unarchive',
      { expectedVersion: 1, reasonCode: 'DUPLICATE_RECORD' },
      { correlationId: 'c-unarchive', idempotencyKey: 'customer-unarchive' },
    );
    await expect(
      db
        .prepare(
          "UPDATE policies SET archived_at=NULL,archived_by_membership_id=NULL,archive_reason=NULL WHERE id='policy-unarchive'",
        )
        .run(),
    ).rejects.toThrow('CUSTOMER_ARCHIVED');
  });

  it('assigns customers with CAS, exact replay, live scope, race rollback, and fresh replay authorization', async () => {
    const payload = { expectedVersion: 1, assigneeMembershipId: 'member-w' };
    const first = await assignCustomer(db, owner, 'customer-assign', payload, {
      correlationId: 'ca-1',
      idempotencyKey: 'customer-assign-1',
    });
    const replay = await assignCustomer(db, owner, 'customer-assign', payload, {
      correlationId: 'ca-2',
      idempotencyKey: 'customer-assign-1',
    });
    expect(first.assigneeMembershipId).toBe('member-w');
    expect(replay.id).toBe(first.id);
    expect(
      (await listCustomers(db, worker, {})).items.some((item) => item.id === 'customer-assign'),
    ).toBe(true);
    await expect(
      assignCustomer(
        db,
        owner,
        'customer-assign',
        { expectedVersion: 1, assigneeMembershipId: 'member-a' },
        { correlationId: 'ca-stale', idempotencyKey: 'customer-assign-stale' },
      ),
    ).rejects.toThrow();
    await expect(
      assignCustomer(
        db,
        owner,
        'customer-assign',
        { expectedVersion: 2, assigneeMembershipId: 'member-i' },
        { correlationId: 'ca-i', idempotencyKey: 'customer-assign-i' },
      ),
    ).rejects.toThrow();
    await expect(
      assignCustomer(
        db,
        owner,
        'customer-assign',
        { expectedVersion: 2, assigneeMembershipId: 'member-b' },
        { correlationId: 'ca-b', idempotencyKey: 'customer-assign-b' },
      ),
    ).rejects.toThrow();

    const race = await Promise.allSettled([
      assignCustomer(
        db,
        owner,
        'customer-assign-race',
        { expectedVersion: 1, assigneeMembershipId: 'member-w' },
        { correlationId: 'car-1', idempotencyKey: 'customer-assign-race-1' },
      ),
      assignCustomer(
        db,
        owner,
        'customer-assign-race',
        { expectedVersion: 1, assigneeMembershipId: 'member-a' },
        { correlationId: 'car-2', idempotencyKey: 'customer-assign-race-2' },
      ),
    ]);
    expect(race.filter((item) => item.status === 'fulfilled')).toHaveLength(1);
    expect(
      (await db
        .prepare(
          "SELECT count(*) n FROM audit_events WHERE action='customer.assign' AND target_id='customer-assign-race'",
        )
        .first<{ n: number }>())!.n,
    ).toBe(1);
    expect(
      (await db
        .prepare(
          "SELECT count(*) n FROM operation_receipts WHERE action='customer.assign' AND idempotency_key LIKE 'customer-assign-race-%'",
        )
        .first<{ n: number }>())!.n,
    ).toBe(1);

    const raceCustomer = await db
      .prepare("SELECT version FROM customers WHERE id='customer-assign-race'")
      .first<{ version: number }>();
    await archiveCustomer(
      db,
      owner,
      'customer-assign-race',
      { expectedVersion: raceCustomer!.version, reasonCode: 'OTHER' },
      { correlationId: 'car-archive', idempotencyKey: 'customer-assign-race-archive' },
    );
    await expect(
      assignCustomer(
        db,
        owner,
        'customer-assign-race',
        { expectedVersion: raceCustomer!.version + 1, assigneeMembershipId: 'member-a' },
        {
          correlationId: 'car-archived-assign',
          idempotencyKey: 'customer-assign-race-after-archive',
        },
      ),
    ).rejects.toMatchObject({ code: 'CUSTOMER_ARCHIVED' });

    const workerReplayPayload = { expectedVersion: 1, assigneeMembershipId: 'member-w' };
    await assignCustomer(db, worker, 'customer-worker-replay', workerReplayPayload, {
      correlationId: 'cwr-1',
      idempotencyKey: 'customer-worker-replay',
    });
    await db
      .prepare(
        "UPDATE auth_identities SET status='REVOKED',revoked_at=created_at,updated_at=created_at,version=version+1 WHERE id='identity-w'",
      )
      .run();
    await expect(
      executeCustomerDomainCommand({
        db,
        agencyId: 'agency-a',
        actorUserId: 'user-w',
        actorMembershipId: 'member-w',
        actorIdentityId: 'identity-w',
        expectedPermissionVersion: 1,
        correlationId: 'ca-identity-race',
        idempotencyKey: 'customer-assign-identity-race',
        payload: { expectedVersion: 2, assigneeMembershipId: 'member-a' },
        command: {
          kind: 'customer.assign',
          customerId: 'customer-assign',
          expectedVersion: 2,
          targetAssigneeMembershipId: 'member-a',
        },
        resultProducer: () => ({ status: 200, body: first }),
      }),
    ).rejects.toThrow();
    await expect(
      assignCustomer(db, worker, 'customer-worker-replay', workerReplayPayload, {
        correlationId: 'cwr-2',
        idempotencyKey: 'customer-worker-replay',
      }),
    ).rejects.toThrow();
    await db
      .prepare(
        "UPDATE agency_memberships SET status='SUSPENDED',suspended_at='2026-09-21T09:45:00.000Z',version=version+1,permission_version=permission_version+1 WHERE id='member-w'",
      )
      .run();
    const policyReplay = await assignPolicy(
      owner,
      db,
      'policy-assign',
      { expectedVersion: 1, assigneeMembershipId: 'member-w' },
      'policy-assign-1',
    );
    expect(policyReplay.replayed).toBe(true);
  });
});
