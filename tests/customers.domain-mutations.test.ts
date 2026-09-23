// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import miniflare from 'miniflare';
import { executeCustomerDomainCommand } from '../src/server/mutations/internal/customer-domain-executor';
import { IdempotencyConflictError } from '../src/server/mutations/idempotency';
import { OptimisticConcurrencyError } from '../src/server/db/optimistic';
import { executeProtectedPermissionMutation } from '../src/server/mutations/internal/protected-permission-executor';
import type { AuthenticatedUserContext } from '../src/server/auth/identity';

const { Miniflare, convertV4MiniflareOptions } = miniflare;
const rootDir = resolve(__dirname, '..');

describe('M2-T01 Domain Mutations & Invariants Focused Real D1 Tests', () => {
  let mf: miniflare.Miniflare;
  let db: D1Database;

  const AGENCY_ID = 'ag-test-domain';
  const OWNER_USER_ID = 'usr-owner-dom';
  const OWNER_MEM_ID = 'mem-owner-dom';

  const MEMBER_USER_ID = 'usr-member-dom';
  const MEMBER_MEM_ID = 'mem-member-dom';

  const OTHER_MEMBER_USER_ID = 'usr-other-dom';
  const OTHER_MEMBER_MEM_ID = 'mem-other-dom';

  beforeAll(async () => {
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: 'export default { fetch() { return new Response(null); } }',
        d1Databases: {
          DB: '00000000-0000-0000-0000-000000000002',
        },
      }),
    );
    db = await mf.getD1Database('DB');

    // Apply migrations 0000 to 0004
    const migrationFiles = [
      'db/migrations/0000_good_hammerhead.sql',
      'db/migrations/0001_chunky_blazing_skull.sql',
      'db/migrations/0002_productive_arclight.sql',
      'db/migrations/0003_lonely_zzzax.sql',
      'db/migrations/0004_thankful_pixie.sql',
    ];

    for (const file of migrationFiles) {
      const sql = readFileSync(resolve(rootDir, file), 'utf8');
      const stmts = sql
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const stmt of stmts) {
        await db.prepare(stmt).run();
      }
    }

    // Seed test agency and users following M1 lifecycle trigger rules
    await db
      .prepare("INSERT INTO agencies (id, status, version) VALUES (?, 'PROVISIONING', 1)")
      .bind(AGENCY_ID)
      .run();
    await db
      .prepare("INSERT INTO users (id, status, version) VALUES (?, 'INACTIVE', 1)")
      .bind(OWNER_USER_ID)
      .run();
    await db
      .prepare(
        `
      INSERT INTO agency_memberships (
        id, agency_id, user_id, type, status, invitation_email, invitation_expires_at, version, permission_version
      ) VALUES (?, ?, ?, 'OWNER', 'INVITED', 'owner@test.com', '2099-01-01T00:00:00.000Z', 1, 1)
    `,
      )
      .bind(OWNER_MEM_ID, AGENCY_ID, OWNER_USER_ID)
      .run();
    await db
      .prepare(
        `
      INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
      VALUES (?, ?, 'https://test', 'sub-owner', 'owner@test.com', 'ACTIVE')
    `,
      )
      .bind('ident-owner', OWNER_USER_ID)
      .run();
    await db
      .prepare("UPDATE users SET status = 'ACTIVE', version = version + 1 WHERE id = ?")
      .bind(OWNER_USER_ID)
      .run();
    await db
      .prepare(
        `
      UPDATE agency_memberships
      SET status = 'ACTIVE', activated_at = '2026-09-17T00:00:00.000Z',
          version = version + 1, permission_version = permission_version + 1
      WHERE id = ?
    `,
      )
      .bind(OWNER_MEM_ID)
      .run();
    await db
      .prepare(
        `
      UPDATE agencies
      SET status = 'ACTIVE', bootstrap_completed_at = '2026-09-17T00:00:00.000Z',
          activated_at = '2026-09-17T00:00:00.000Z', version = version + 1
      WHERE id = ?
    `,
      )
      .bind(AGENCY_ID)
      .run();

    async function addMember(
      agencyId: string,
      userId: string,
      memId: string,
      sub: string,
      email: string,
    ) {
      await db
        .prepare("INSERT INTO users (id, status, version) VALUES (?, 'INACTIVE', 1)")
        .bind(userId)
        .run();
      await db
        .prepare(
          `
        INSERT INTO agency_memberships (
          id, agency_id, user_id, type, status, invitation_email, invitation_expires_at, version, permission_version
        ) VALUES (?, ?, ?, 'MEMBER', 'INVITED', ?, '2099-01-01T00:00:00.000Z', 1, 1)
      `,
        )
        .bind(memId, agencyId, userId, email)
        .run();
      await db
        .prepare(
          `
        INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
        VALUES (?, ?, 'https://test', ?, ?, 'ACTIVE')
      `,
        )
        .bind(`ident-${userId}`, userId, sub, email)
        .run();
      await db
        .prepare("UPDATE users SET status = 'ACTIVE', version = version + 1 WHERE id = ?")
        .bind(userId)
        .run();
      await db
        .prepare(
          `
        UPDATE agency_memberships
        SET status = 'ACTIVE', activated_at = '2026-09-17T00:00:00.000Z',
            version = version + 1, permission_version = permission_version + 1
        WHERE id = ?
      `,
        )
        .bind(memId)
        .run();
    }

    // Member with ASSIGNED customer.read, customer.update and UNSCOPED customer.create permissions
    await addMember(AGENCY_ID, MEMBER_USER_ID, MEMBER_MEM_ID, 'sub-member-dom', 'member@test.com');
    await db
      .prepare(
        `
      INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
      VALUES ('perm-cust-read', ?, 'customer.read', 'ASSIGNED'),
             ('perm-cust-update', ?, 'customer.update', 'ASSIGNED'),
             ('perm-cust-create', ?, 'customer.create', 'UNSCOPED')
    `,
      )
      .bind(MEMBER_MEM_ID, MEMBER_MEM_ID, MEMBER_MEM_ID)
      .run();

    // Other Member
    await addMember(
      AGENCY_ID,
      OTHER_MEMBER_USER_ID,
      OTHER_MEMBER_MEM_ID,
      'sub-other-dom',
      'other@test.com',
    );
    await db
      .prepare(
        `
      INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
      VALUES ('perm-other-read', ?, 'customer.read', 'ASSIGNED'),
             ('perm-other-update', ?, 'customer.update', 'ASSIGNED')
    `,
      )
      .bind(OTHER_MEMBER_MEM_ID, OTHER_MEMBER_MEM_ID)
      .run();
  });

  afterAll(async () => {
    if (mf) {
      await mf.dispose();
    }
  });

  // 1. Concurrent duplicate create at-most-one effect and audit
  it('concurrent duplicate create: at-most-one effect and exactly one audit event', async () => {
    const custId = 'cust-concurrent-1';
    const idemKey = 'ik-concurrent-create-key';
    const payload = { type: 'COMPANY', companyTitle: 'Concurrent Co' };

    const task1 = executeCustomerDomainCommand({
      db,
      agencyId: AGENCY_ID,
      actorUserId: OWNER_USER_ID,
      actorIdentityId: 'ident-owner',
      actorMembershipId: OWNER_MEM_ID,
      expectedPermissionVersion: 2,
      correlationId: 'corr-c1',
      idempotencyKey: idemKey,
      payload,
      command: {
        kind: 'customer.create',
        customerId: custId,
        type: 'COMPANY',
        displayName: 'Concurrent Co',
        companyTitle: 'Concurrent Co',
      },
      resultProducer: () => ({ status: 201, body: { id: custId, name: 'Concurrent Co' } }),
    });

    const task2 = executeCustomerDomainCommand({
      db,
      agencyId: AGENCY_ID,
      actorUserId: OWNER_USER_ID,
      actorIdentityId: 'ident-owner',
      actorMembershipId: OWNER_MEM_ID,
      expectedPermissionVersion: 2,
      correlationId: 'corr-c2',
      idempotencyKey: idemKey,
      payload,
      command: {
        kind: 'customer.create',
        customerId: custId,
        type: 'COMPANY',
        displayName: 'Concurrent Co',
        companyTitle: 'Concurrent Co',
      },
      resultProducer: () => ({ status: 201, body: { id: custId, name: 'Concurrent Co' } }),
    });

    const [res1, res2] = await Promise.all([task1, task2]);

    const executedCount = [res1, res2].filter((r) => r.executed).length;
    const replayedCount = [res1, res2].filter((r) => r.replayed).length;
    expect(executedCount).toBe(1);
    expect(replayedCount).toBe(1);

    const customerRows = await db
      .prepare('SELECT count(*) as count FROM customers WHERE id = ?')
      .bind(custId)
      .first<{ count: number }>();
    expect(customerRows?.count).toBe(1);

    const auditRows = await db
      .prepare('SELECT count(*) as count FROM audit_events WHERE idempotency_key = ?')
      .bind(idemKey)
      .first<{ count: number }>();
    expect(auditRows?.count).toBe(1);
  });

  // 2. Same idempotency key different ACTION conflict (not just payload)
  it('same key different ACTION: throws IDEMPOTENCY_ACTION_MISMATCH', async () => {
    const sharedKey = 'ik-action-conflict-key';

    // First: customer.create with sharedKey
    await executeCustomerDomainCommand({
      db,
      agencyId: AGENCY_ID,
      actorUserId: OWNER_USER_ID,
      actorIdentityId: 'ident-owner',
      actorMembershipId: OWNER_MEM_ID,
      expectedPermissionVersion: 2,
      correlationId: 'corr-act-1',
      idempotencyKey: sharedKey,
      payload: { type: 'INDIVIDUAL', firstName: 'Action', lastName: 'First' },
      command: {
        kind: 'customer.create',
        customerId: 'cust-action-first',
        type: 'INDIVIDUAL',
        displayName: 'Action First',
        firstName: 'Action',
        lastName: 'First',
      },
      resultProducer: () => ({ status: 201, body: { ok: true } }),
    });

    // Second: attempting customer.update with the SAME idempotencyKey
    await expect(
      executeCustomerDomainCommand({
        db,
        agencyId: AGENCY_ID,
        actorUserId: OWNER_USER_ID,
        actorIdentityId: 'ident-owner',
        actorMembershipId: OWNER_MEM_ID,
        expectedPermissionVersion: 2,
        correlationId: 'corr-act-2',
        idempotencyKey: sharedKey,
        payload: { firstName: 'DifferentAction' },
        command: {
          kind: 'customer.update',
          customerId: 'cust-action-first',
          expectedVersion: 1,
          firstName: 'DifferentAction',
          changedFields: ['firstName'],
        },
        resultProducer: () => ({ status: 200, body: { ok: true } }),
      }),
    ).rejects.toThrow(IdempotencyConflictError);
  });

  // 3. Zero-row CAS rollback on expectedVersion mismatch
  it('zero-row CAS rollback: version mismatch rolls back entire batch (no receipt, no audit, no partial state)', async () => {
    const custId = 'cust-cas-test';
    const createKey = 'ik-cas-create';
    const updateKey = 'ik-cas-update-stale';

    await executeCustomerDomainCommand({
      db,
      agencyId: AGENCY_ID,
      actorUserId: OWNER_USER_ID,
      actorIdentityId: 'ident-owner',
      actorMembershipId: OWNER_MEM_ID,
      expectedPermissionVersion: 2,
      correlationId: 'corr-cas-create',
      idempotencyKey: createKey,
      payload: { title: 'CAS Co' },
      command: {
        kind: 'customer.create',
        customerId: custId,
        type: 'COMPANY',
        displayName: 'CAS Co',
        companyTitle: 'CAS Co',
      },
      resultProducer: () => ({ status: 201, body: { id: custId } }),
    });

    // Try update with wrong version: expectedVersion=99 (actual is 1)
    await expect(
      executeCustomerDomainCommand({
        db,
        agencyId: AGENCY_ID,
        actorUserId: OWNER_USER_ID,
        actorIdentityId: 'ident-owner',
        actorMembershipId: OWNER_MEM_ID,
        expectedPermissionVersion: 2,
        correlationId: 'corr-cas-update',
        idempotencyKey: updateKey,
        payload: { title: 'New CAS Co' },
        command: {
          kind: 'customer.update',
          customerId: custId,
          expectedVersion: 99,
          companyTitle: 'New CAS Co',
          changedFields: ['companyTitle'],
        },
        resultProducer: () => ({ status: 200, body: { ok: true } }),
      }),
    ).rejects.toThrow(OptimisticConcurrencyError);

    const custAfter = await db
      .prepare('SELECT company_title, version FROM customers WHERE id = ?')
      .bind(custId)
      .first<{ company_title: string; version: number }>();
    expect(custAfter?.version).toBe(1);
    expect(custAfter?.company_title).toBe('CAS Co');

    const receiptAfter = await db
      .prepare('SELECT id FROM operation_receipts WHERE idempotency_key = ?')
      .bind(updateKey)
      .first();
    expect(receiptAfter).toBeNull();

    const auditAfter = await db
      .prepare('SELECT id FROM audit_events WHERE idempotency_key = ?')
      .bind(updateKey)
      .first();
    expect(auditAfter).toBeNull();
  });

  // 4. Atomic permission / scope revocation rollback
  it('atomic authority recheck: revoking permission causes atomic rollback with FINAL_AUTHORITY_RECHECK_FAILED', async () => {
    const otherCustId = 'cust-revocation-test';
    await executeCustomerDomainCommand({
      db,
      agencyId: AGENCY_ID,
      actorUserId: OWNER_USER_ID,
      actorIdentityId: 'ident-owner',
      actorMembershipId: OWNER_MEM_ID,
      expectedPermissionVersion: 2,
      correlationId: 'corr-rev-1',
      idempotencyKey: 'ik-rev-cust-create',
      payload: { title: 'Other Member Cust' },
      command: {
        kind: 'customer.create',
        customerId: otherCustId,
        type: 'COMPANY',
        displayName: 'Other Member Cust',
        companyTitle: 'Other Member Cust',
      },
      resultProducer: () => ({ status: 201, body: { id: otherCustId } }),
    });

    // Reassign customer to OTHER_MEMBER_MEM_ID
    await db
      .prepare('UPDATE customers SET assignee_membership_id = ? WHERE id = ?')
      .bind(OTHER_MEMBER_MEM_ID, otherCustId)
      .run();

    // MEMBER_MEM_ID has ASSIGNED scope for customer.update.
    // When MEMBER_MEM_ID attempts to execute an update command on otherCustId,
    // the batch assertion fails: live assignee (OTHER_MEMBER_MEM_ID) !== actorMembershipId (MEMBER_MEM_ID)
    const revokedKey = 'ik-revocation-attempt';
    await expect(
      executeCustomerDomainCommand({
        db,
        agencyId: AGENCY_ID,
        actorUserId: MEMBER_USER_ID,
        actorIdentityId: `ident-${MEMBER_USER_ID}`,
        actorMembershipId: MEMBER_MEM_ID,
        expectedPermissionVersion: 2,
        correlationId: 'corr-rev-2',
        idempotencyKey: revokedKey,
        payload: { companyTitle: 'Hacked Title' },
        command: {
          kind: 'customer.update',
          customerId: otherCustId,
          expectedVersion: 1,
          companyTitle: 'Hacked Title',
          changedFields: ['companyTitle'],
        },
        resultProducer: () => ({ status: 200, body: { ok: true } }),
      }),
    ).rejects.toThrow(/FINAL_AUTHORITY_RECHECK_FAILED/);

    const custCheck = await db
      .prepare('SELECT company_title, version FROM customers WHERE id = ?')
      .bind(otherCustId)
      .first<{ company_title: string; version: number }>();
    expect(custCheck?.company_title).toBe('Other Member Cust');
    expect(custCheck?.version).toBe(1);

    const receiptCheck = await db
      .prepare('SELECT id FROM operation_receipts WHERE idempotency_key = ?')
      .bind(revokedKey)
      .first();
    expect(receiptCheck).toBeNull();
  });

  // 5. Audit rollback permanent real-D1 test (Customer domain executor audit insert failure after business effect)
  it('audit rollback: audit insert failure after business effect deterministically rolls back entire batch in real D1', async () => {
    const custId = 'cust-audit-rollback-1';
    const idemKey = 'ik-audit-fail-key-1';

    // Set up a deterministic failure trigger on audit_events specifically for this idempotency key
    await db
      .prepare(
        `
      CREATE TRIGGER IF NOT EXISTS test_audit_fail_guard
      BEFORE INSERT ON audit_events
      WHEN NEW.idempotency_key = 'ik-audit-fail-key-1'
      BEGIN
        SELECT RAISE(ABORT, 'DETERMINISTIC_AUDIT_INSERT_FAILURE');
      END;
    `,
      )
      .run();

    try {
      // Execute normal Customer domain executor
      await expect(
        executeCustomerDomainCommand({
          db,
          agencyId: AGENCY_ID,
          actorUserId: OWNER_USER_ID,
          actorIdentityId: 'ident-owner',
          actorMembershipId: OWNER_MEM_ID,
          expectedPermissionVersion: 2,
          correlationId: 'corr-audit-fail',
          idempotencyKey: idemKey,
          payload: { type: 'INDIVIDUAL', firstName: 'Mehmet', lastName: 'AuditFail' },
          command: {
            kind: 'customer.create',
            customerId: custId,
            type: 'INDIVIDUAL',
            displayName: 'Mehmet AuditFail',
            firstName: 'Mehmet',
            lastName: 'AuditFail',
          },
          resultProducer: () => ({ status: 201, body: { id: custId } }),
        }),
      ).rejects.toThrow(/DETERMINISTIC_AUDIT_INSERT_FAILURE/);

      // Verify business effect is completely rolled back (no customer record)
      const custRow = await db
        .prepare('SELECT id FROM customers WHERE id = ?')
        .bind(custId)
        .first();
      expect(custRow).toBeNull();

      // Verify receipt is completely rolled back (no operation_receipts record)
      const receiptRow = await db
        .prepare('SELECT id FROM operation_receipts WHERE idempotency_key = ?')
        .bind(idemKey)
        .first();
      expect(receiptRow).toBeNull();

      // Verify no success audit record exists
      const auditRow = await db
        .prepare('SELECT id FROM audit_events WHERE idempotency_key = ?')
        .bind(idemKey)
        .first();
      expect(auditRow).toBeNull();

      // Verify d1_cas_assertions state is consistent
      const assertionCount = await db
        .prepare('SELECT count(*) as count FROM d1_cas_assertions WHERE id = ?')
        .bind(idemKey)
        .first<{ count: number }>();
      expect(assertionCount?.count ?? 0).toBe(0);
    } finally {
      await db.prepare('DROP TRIGGER IF EXISTS test_audit_fail_guard').run();
    }

    // The exact same logical operation must be retryable after the failed transaction.
    // A successful retry proves that no receipt, CAS assertion, or partial entity state
    // from the failed audit write poisoned the operation.
    const retryResult = await executeCustomerDomainCommand({
      db,
      agencyId: AGENCY_ID,
      actorUserId: OWNER_USER_ID,
      actorIdentityId: 'ident-owner',
      actorMembershipId: OWNER_MEM_ID,
      expectedPermissionVersion: 2,
      correlationId: 'corr-audit-fail-retry',
      idempotencyKey: idemKey,
      payload: { type: 'INDIVIDUAL', firstName: 'Mehmet', lastName: 'AuditFail' },
      command: {
        kind: 'customer.create',
        customerId: custId,
        type: 'INDIVIDUAL',
        displayName: 'Mehmet AuditFail',
        firstName: 'Mehmet',
        lastName: 'AuditFail',
      },
      resultProducer: () => ({ status: 201, body: { id: custId } }),
    });
    expect(retryResult.status).toBe(201);

    const committedCustomer = await db
      .prepare('SELECT id, version FROM customers WHERE id = ?')
      .bind(custId)
      .first<{ id: string; version: number }>();
    expect(committedCustomer).toEqual({ id: custId, version: 1 });

    const committedReceipt = await db
      .prepare('SELECT count(*) as count FROM operation_receipts WHERE idempotency_key = ?')
      .bind(idemKey)
      .first<{ count: number }>();
    expect(committedReceipt?.count).toBe(1);

    const committedAudit = await db
      .prepare('SELECT count(*) as count FROM audit_events WHERE idempotency_key = ?')
      .bind(idemKey)
      .first<{ count: number }>();
    expect(committedAudit?.count).toBe(1);

    const remainingAssertions = await db
      .prepare('SELECT count(*) as count FROM d1_cas_assertions WHERE id = ?')
      .bind(idemKey)
      .first<{ count: number }>();
    expect(remainingAssertions?.count ?? 0).toBe(0);
  });

  // 6. Real Concurrent primary contact race (True Promise.allSettled concurrency on real Miniflare/D1)
  it('concurrent primary contact race: truly concurrent set-primary operations enforce at most one active primary and consistent audit/receipts', async () => {
    const compId = 'comp-race-concurrent-primary';
    await executeCustomerDomainCommand({
      db,
      agencyId: AGENCY_ID,
      actorUserId: OWNER_USER_ID,
      actorIdentityId: 'ident-owner',
      actorMembershipId: OWNER_MEM_ID,
      expectedPermissionVersion: 2,
      correlationId: 'corr-race-comp-create',
      idempotencyKey: 'ik-race-comp-create-real',
      payload: { title: 'Concurrent Primary Race Co' },
      command: {
        kind: 'customer.create',
        customerId: compId,
        type: 'COMPANY',
        displayName: 'Concurrent Primary Race Co',
        companyTitle: 'Concurrent Primary Race Co',
      },
      resultProducer: () => ({ status: 201, body: { id: compId } }),
    });

    const cnt1 = 'cnt-race-c1';
    const cnt2 = 'cnt-race-c2';

    // Create contact 1
    await executeCustomerDomainCommand({
      db,
      agencyId: AGENCY_ID,
      actorUserId: OWNER_USER_ID,
      actorIdentityId: 'ident-owner',
      actorMembershipId: OWNER_MEM_ID,
      expectedPermissionVersion: 2,
      correlationId: 'corr-race-cnt1',
      idempotencyKey: 'ik-race-cnt1-real',
      payload: { firstName: 'One', lastName: 'Race' },
      command: {
        kind: 'company_contact.create',
        customerId: compId,
        contactId: cnt1,
        firstName: 'One',
        lastName: 'Race',
        isPrimary: false,
      },
      resultProducer: () => ({ status: 201, body: { id: cnt1 } }),
    });

    // Create contact 2
    await executeCustomerDomainCommand({
      db,
      agencyId: AGENCY_ID,
      actorUserId: OWNER_USER_ID,
      actorIdentityId: 'ident-owner',
      actorMembershipId: OWNER_MEM_ID,
      expectedPermissionVersion: 2,
      correlationId: 'corr-race-cnt2',
      idempotencyKey: 'ik-race-cnt2-real',
      payload: { firstName: 'Two', lastName: 'Race' },
      command: {
        kind: 'company_contact.create',
        customerId: compId,
        contactId: cnt2,
        firstName: 'Two',
        lastName: 'Race',
        isPrimary: false,
      },
      resultProducer: () => ({ status: 201, body: { id: cnt2 } }),
    });

    // Launch two set-primary operations concurrently using Promise.allSettled
    const task1 = executeCustomerDomainCommand({
      db,
      agencyId: AGENCY_ID,
      actorUserId: OWNER_USER_ID,
      actorIdentityId: 'ident-owner',
      actorMembershipId: OWNER_MEM_ID,
      expectedPermissionVersion: 2,
      correlationId: 'corr-race-prim-c1',
      idempotencyKey: 'ik-race-prim-c1',
      payload: { expectedVersion: 1 },
      command: {
        kind: 'company_contact.set_primary',
        customerId: compId,
        contactId: cnt1,
        expectedVersion: 1,
      },
      resultProducer: () => ({ status: 200, body: { id: cnt1, isPrimary: true } }),
    });

    const task2 = executeCustomerDomainCommand({
      db,
      agencyId: AGENCY_ID,
      actorUserId: OWNER_USER_ID,
      actorIdentityId: 'ident-owner',
      actorMembershipId: OWNER_MEM_ID,
      expectedPermissionVersion: 2,
      correlationId: 'corr-race-prim-c2',
      idempotencyKey: 'ik-race-prim-c2',
      payload: { expectedVersion: 1 },
      command: {
        kind: 'company_contact.set_primary',
        customerId: compId,
        contactId: cnt2,
        expectedVersion: 1,
      },
      resultProducer: () => ({ status: 200, body: { id: cnt2, isPrimary: true } }),
    });

    const results = await Promise.allSettled([task1, task2]);

    // Inspect database invariant: en fazla bir active primary
    const primaryContacts = await db
      .prepare(
        `
        SELECT id, is_primary, status FROM company_contacts
        WHERE customer_id = ? AND is_primary = 1 AND status = 'ACTIVE'
      `,
      )
      .bind(compId)
      .all<{ id: string }>();

    expect(primaryContacts.results.length).toBe(1);

    const successfulTasks = results.filter((r) => r.status === 'fulfilled');
    const failedTasks = results.filter((r) => r.status === 'rejected');

    // Successful effect count must match the active primary in database
    if (failedTasks.length > 0) {
      // One succeeded and one was rejected due to conflict/trigger
      expect(successfulTasks.length).toBe(1);
      const winner = primaryContacts.results[0]!.id;
      expect([cnt1, cnt2]).toContain(winner);

      // Verify audit events match exactly the successful task
      const audits = await db
        .prepare(
          `
          SELECT id, action, idempotency_key FROM audit_events
          WHERE idempotency_key IN ('ik-race-prim-c1', 'ik-race-prim-c2') AND outcome = 'SUCCESS'
        `,
        )
        .all();
      expect(audits.results.length).toBe(1);

      // Verify receipts match exactly the successful task
      const receipts = await db
        .prepare(
          `
          SELECT id, idempotency_key FROM operation_receipts
          WHERE idempotency_key IN ('ik-race-prim-c1', 'ik-race-prim-c2') AND status = 'COMPLETED'
        `,
        )
        .all();
      expect(receipts.results.length).toBe(1);
    } else {
      // Both tasks resolved sequentially within the transaction engine: final state has strictly 1 primary
      expect(successfulTasks.length).toBe(2);
      expect(primaryContacts.results.length).toBe(1);
    }
  });

  // 7. Concurrent race on the exact same contact with same expectedVersion: exactly one winner, one CAS conflict loser
  it('concurrent set-primary race on same contact: exactly one succeeds, loser fails with CAS conflict', async () => {
    const compId = 'comp-race-same-contact';
    await executeCustomerDomainCommand({
      db,
      agencyId: AGENCY_ID,
      actorUserId: OWNER_USER_ID,
      actorIdentityId: 'ident-owner',
      actorMembershipId: OWNER_MEM_ID,
      expectedPermissionVersion: 2,
      correlationId: 'corr-race-same-create',
      idempotencyKey: 'ik-race-same-comp-create',
      payload: { title: 'Same Contact Race Co' },
      command: {
        kind: 'customer.create',
        customerId: compId,
        type: 'COMPANY',
        displayName: 'Same Contact Race Co',
        companyTitle: 'Same Contact Race Co',
      },
      resultProducer: () => ({ status: 201, body: { id: compId } }),
    });

    const targetContactId = 'cnt-same-target';
    await executeCustomerDomainCommand({
      db,
      agencyId: AGENCY_ID,
      actorUserId: OWNER_USER_ID,
      actorIdentityId: 'ident-owner',
      actorMembershipId: OWNER_MEM_ID,
      expectedPermissionVersion: 2,
      correlationId: 'corr-race-same-cnt',
      idempotencyKey: 'ik-race-same-cnt-create',
      payload: { firstName: 'Single', lastName: 'Target' },
      command: {
        kind: 'company_contact.create',
        customerId: compId,
        contactId: targetContactId,
        firstName: 'Single',
        lastName: 'Target',
        isPrimary: false,
      },
      resultProducer: () => ({ status: 201, body: { id: targetContactId } }),
    });

    // Concurrently launch two set-primary on the exact same contact with expectedVersion: 1
    const runA = executeCustomerDomainCommand({
      db,
      agencyId: AGENCY_ID,
      actorUserId: OWNER_USER_ID,
      actorIdentityId: 'ident-owner',
      actorMembershipId: OWNER_MEM_ID,
      expectedPermissionVersion: 2,
      correlationId: 'corr-same-run-A',
      idempotencyKey: 'ik-same-run-A',
      payload: { expectedVersion: 1 },
      command: {
        kind: 'company_contact.set_primary',
        customerId: compId,
        contactId: targetContactId,
        expectedVersion: 1,
      },
      resultProducer: () => ({ status: 200, body: { id: targetContactId, isPrimary: true } }),
    });

    const runB = executeCustomerDomainCommand({
      db,
      agencyId: AGENCY_ID,
      actorUserId: OWNER_USER_ID,
      actorIdentityId: 'ident-owner',
      actorMembershipId: OWNER_MEM_ID,
      expectedPermissionVersion: 2,
      correlationId: 'corr-same-run-B',
      idempotencyKey: 'ik-same-run-B',
      payload: { expectedVersion: 1 },
      command: {
        kind: 'company_contact.set_primary',
        customerId: compId,
        contactId: targetContactId,
        expectedVersion: 1,
      },
      resultProducer: () => ({ status: 200, body: { id: targetContactId, isPrimary: true } }),
    });

    const settled = await Promise.allSettled([runA, runB]);
    const winnerCount = settled.filter((s) => s.status === 'fulfilled').length;
    const loserCount = settled.filter((s) => s.status === 'rejected').length;

    // Exactly 1 winner, exactly 1 loser conflict
    expect(winnerCount).toBe(1);
    expect(loserCount).toBe(1);

    const rejected = settled.find((s) => s.status === 'rejected') as PromiseRejectedResult;
    expect(rejected.reason).toBeInstanceOf(OptimisticConcurrencyError);

    // Exactly 1 primary contact in DB
    const primaryContacts = await db
      .prepare(
        `
        SELECT id, is_primary, version FROM company_contacts
        WHERE customer_id = ? AND is_primary = 1 AND status = 'ACTIVE'
      `,
      )
      .bind(compId)
      .all<{ id: string; version: number }>();
    expect(primaryContacts.results.length).toBe(1);
    expect(primaryContacts.results[0]!.version).toBe(2);

    // No duplicate audit, no duplicate receipt
    const audits = await db
      .prepare(
        `
        SELECT id FROM audit_events
        WHERE idempotency_key IN ('ik-same-run-A', 'ik-same-run-B') AND outcome = 'SUCCESS'
      `,
      )
      .all();
    expect(audits.results.length).toBe(1);

    const receipts = await db
      .prepare(
        `
        SELECT id FROM operation_receipts
        WHERE idempotency_key IN ('ik-same-run-A', 'ik-same-run-B') AND status = 'COMPLETED'
      `,
      )
      .all();
    expect(receipts.results.length).toBe(1);
  });

  // -------------------------------------------------------------
  // BLOCKER A: ÖZEL D1 ATOMİK RECHECK VE KAPSAM AŞIMI GÜVENLİK TESTLERİ
  // -------------------------------------------------------------

  // BLOCKER A Test 1: customer.update with UNSCOPED corrupt grant direct executor call DENY/rollback
  it('BLOCKER A.1: customer.update with UNSCOPED corrupt grant is denied and rolled back', async () => {
    const corruptUserId = 'usr-corrupt-scope';
    const corruptMemId = 'mem-corrupt-scope';

    await db
      .prepare("INSERT INTO users (id, status, version) VALUES (?, 'INACTIVE', 1)")
      .bind(corruptUserId)
      .run();
    await db
      .prepare(
        `
      INSERT INTO agency_memberships (
        id, agency_id, user_id, type, status, invitation_email, invitation_expires_at, version, permission_version
      ) VALUES (?, ?, ?, 'MEMBER', 'INVITED', 'corrupt@test.com', '2099-01-01T00:00:00.000Z', 1, 1)
    `,
      )
      .bind(corruptMemId, AGENCY_ID, corruptUserId)
      .run();
    await db
      .prepare(
        `
      INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
      VALUES (?, ?, 'https://test', 'sub-corrupt-scope', 'corrupt@test.com', 'ACTIVE')
    `,
      )
      .bind(`ident-${corruptUserId}`, corruptUserId)
      .run();
    await db
      .prepare("UPDATE users SET status = 'ACTIVE', version = version + 1 WHERE id = ?")
      .bind(corruptUserId)
      .run();
    await db
      .prepare(
        `
      UPDATE agency_memberships
      SET status = 'ACTIVE', activated_at = '2026-09-17T00:00:00.000Z',
          version = version + 1, permission_version = permission_version + 1
      WHERE id = ?
    `,
      )
      .bind(corruptMemId)
      .run();

    // Corrupt grant: customer.update with UNSCOPED (which is forbidden for record-scoped permissions)
    await db
      .prepare(
        `
      INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
      VALUES ('perm-corr-read', ?, 'customer.read', 'ASSIGNED'),
             ('perm-corr-upd', ?, 'customer.update', 'UNSCOPED')
    `,
      )
      .bind(corruptMemId, corruptMemId)
      .run();

    const targetCustId = 'cust-corrupt-test';
    // Create customer via owner
    await executeCustomerDomainCommand({
      db,
      agencyId: AGENCY_ID,
      actorUserId: OWNER_USER_ID,
      actorIdentityId: 'ident-owner',
      actorMembershipId: OWNER_MEM_ID,
      expectedPermissionVersion: 2,
      correlationId: 'corr-crp-1',
      idempotencyKey: 'ik-crp-1',
      payload: { title: 'Target Corp' },
      command: {
        kind: 'customer.create',
        customerId: targetCustId,
        type: 'COMPANY',
        displayName: 'Target Corp',
        companyTitle: 'Target Corp',
      },
      resultProducer: () => ({ status: 201, body: { id: targetCustId } }),
    });

    // Attempt direct executor update with corrupt UNSCOPED grant
    const updateKey = 'ik-corrupt-update-attempt';
    await expect(
      executeCustomerDomainCommand({
        db,
        agencyId: AGENCY_ID,
        actorUserId: corruptUserId,
        actorIdentityId: `ident-${corruptUserId}`,
        actorMembershipId: corruptMemId,
        expectedPermissionVersion: 2,
        correlationId: 'corr-crp-2',
        idempotencyKey: updateKey,
        payload: { companyTitle: 'Corrupted Bypass' },
        command: {
          kind: 'customer.update',
          customerId: targetCustId,
          expectedVersion: 1,
          companyTitle: 'Corrupted Bypass',
          changedFields: ['companyTitle'],
        },
        resultProducer: () => ({ status: 200, body: { ok: true } }),
      }),
    ).rejects.toThrow(/FINAL_AUTHORITY_RECHECK_FAILED/);

    // Verify rollback: title not modified, no receipt, no audit
    const cust = await db
      .prepare('SELECT company_title, version FROM customers WHERE id = ?')
      .bind(targetCustId)
      .first<{ company_title: string; version: number }>();
    expect(cust?.company_title).toBe('Target Corp');
    expect(cust?.version).toBe(1);

    const receipt = await db
      .prepare('SELECT id FROM operation_receipts WHERE idempotency_key = ?')
      .bind(updateKey)
      .first();
    expect(receipt).toBeNull();
    const audit = await db
      .prepare('SELECT id FROM audit_events WHERE idempotency_key = ?')
      .bind(updateKey)
      .first();
    expect(audit).toBeNull();
  });

  // BLOCKER A Test 2: customer.create without customer.read dependency is denied and rolled back
  it('BLOCKER A.2: customer.create without customer.read dependency is denied and rolled back', async () => {
    const noReadUserId = 'usr-no-read';
    const noReadMemId = 'mem-no-read';

    await db
      .prepare("INSERT INTO users (id, status, version) VALUES (?, 'INACTIVE', 1)")
      .bind(noReadUserId)
      .run();
    await db
      .prepare(
        `
      INSERT INTO agency_memberships (
        id, agency_id, user_id, type, status, invitation_email, invitation_expires_at, version, permission_version
      ) VALUES (?, ?, ?, 'MEMBER', 'INVITED', 'noread@test.com', '2099-01-01T00:00:00.000Z', 1, 1)
    `,
      )
      .bind(noReadMemId, AGENCY_ID, noReadUserId)
      .run();
    await db
      .prepare(
        `
      INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
      VALUES (?, ?, 'https://test', 'sub-no-read', 'noread@test.com', 'ACTIVE')
    `,
      )
      .bind(`ident-${noReadUserId}`, noReadUserId)
      .run();
    await db
      .prepare("UPDATE users SET status = 'ACTIVE', version = version + 1 WHERE id = ?")
      .bind(noReadUserId)
      .run();
    await db
      .prepare(
        `
      UPDATE agency_memberships
      SET status = 'ACTIVE', activated_at = '2026-09-17T00:00:00.000Z',
          version = version + 1, permission_version = permission_version + 1
      WHERE id = ?
    `,
      )
      .bind(noReadMemId)
      .run();

    // Only customer.create granted, customer.read dependency is MISSING
    await db
      .prepare(
        `
      INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
      VALUES ('perm-noread-create', ?, 'customer.create', 'UNSCOPED')
    `,
      )
      .bind(noReadMemId)
      .run();

    const targetCustId = 'cust-noread-test';
    const createKey = 'ik-noread-attempt';
    await expect(
      executeCustomerDomainCommand({
        db,
        agencyId: AGENCY_ID,
        actorUserId: noReadUserId,
        actorIdentityId: `ident-${noReadUserId}`,
        actorMembershipId: noReadMemId,
        expectedPermissionVersion: 2,
        correlationId: 'corr-noread-1',
        idempotencyKey: createKey,
        payload: { title: 'No Read Corp' },
        command: {
          kind: 'customer.create',
          customerId: targetCustId,
          type: 'COMPANY',
          displayName: 'No Read Corp',
          companyTitle: 'No Read Corp',
        },
        resultProducer: () => ({ status: 201, body: { id: targetCustId } }),
      }),
    ).rejects.toThrow(/FINAL_AUTHORITY_RECHECK_FAILED/);

    // Verify rollback: no customer in DB, no receipt, no audit
    const cust = await db
      .prepare('SELECT id FROM customers WHERE id = ?')
      .bind(targetCustId)
      .first();
    expect(cust).toBeNull();
    const receipt = await db
      .prepare('SELECT id FROM operation_receipts WHERE idempotency_key = ?')
      .bind(createKey)
      .first();
    expect(receipt).toBeNull();
    const audit = await db
      .prepare('SELECT id FROM audit_events WHERE idempotency_key = ?')
      .bind(createKey)
      .first();
    expect(audit).toBeNull();
  });

  // BLOCKER A Test 3: concurrent customer assignee change causes atomic batch rollback via live parent check
  it('BLOCKER A.3: concurrent customer assignee change causes atomic batch rollback via live parent check', async () => {
    const raceCustId = 'cust-assignee-race';
    // Create customer via owner
    await executeCustomerDomainCommand({
      db,
      agencyId: AGENCY_ID,
      actorUserId: OWNER_USER_ID,
      actorIdentityId: 'ident-owner',
      actorMembershipId: OWNER_MEM_ID,
      expectedPermissionVersion: 2,
      correlationId: 'corr-race-create',
      idempotencyKey: 'ik-race-create',
      payload: { title: 'Race Assignee Co' },
      command: {
        kind: 'customer.create',
        customerId: raceCustId,
        type: 'COMPANY',
        displayName: 'Race Assignee Co',
        companyTitle: 'Race Assignee Co',
      },
      resultProducer: () => ({ status: 201, body: { id: raceCustId } }),
    });

    // Ensure it was assigned to MEMBER_MEM_ID
    await db
      .prepare('UPDATE customers SET assignee_membership_id = ? WHERE id = ?')
      .bind(MEMBER_MEM_ID, raceCustId)
      .run();

    // Now simulate concurrent re-assignment: another transaction assigns it to OTHER_MEMBER_MEM_ID
    await db
      .prepare('UPDATE customers SET assignee_membership_id = ? WHERE id = ?')
      .bind(OTHER_MEMBER_MEM_ID, raceCustId)
      .run();

    // MEMBER_MEM_ID tries to update the customer. The batch recheck inspects live customer table and aborts!
    const raceUpdateKey = 'ik-race-update-attempt';
    await expect(
      executeCustomerDomainCommand({
        db,
        agencyId: AGENCY_ID,
        actorUserId: MEMBER_USER_ID,
        actorIdentityId: `ident-${MEMBER_USER_ID}`,
        actorMembershipId: MEMBER_MEM_ID,
        expectedPermissionVersion: 2,
        correlationId: 'corr-race-upd',
        idempotencyKey: raceUpdateKey,
        payload: { companyTitle: 'Stale Scope Update' },
        command: {
          kind: 'customer.update',
          customerId: raceCustId,
          expectedVersion: 1,
          companyTitle: 'Stale Scope Update',
          changedFields: ['companyTitle'],
        },
        resultProducer: () => ({ status: 200, body: { ok: true } }),
      }),
    ).rejects.toThrow(/FINAL_AUTHORITY_RECHECK_FAILED/);

    // Verify rollback: title not updated, no receipt, no audit
    const cust = await db
      .prepare('SELECT company_title FROM customers WHERE id = ?')
      .bind(raceCustId)
      .first<{ company_title: string }>();
    expect(cust?.company_title).toBe('Race Assignee Co');

    const receipt = await db
      .prepare('SELECT id FROM operation_receipts WHERE idempotency_key = ?')
      .bind(raceUpdateKey)
      .first();
    expect(receipt).toBeNull();
    const audit = await db
      .prepare('SELECT id FROM audit_events WHERE idempotency_key = ?')
      .bind(raceUpdateKey)
      .first();
    expect(audit).toBeNull();
  });

  // BLOCKER A Test 4: stale permission_version causes atomic batch rollback
  it('BLOCKER A.4: stale permission_version causes atomic rollback with FINAL_AUTHORITY_RECHECK_FAILED', async () => {
    const custId = 'cust-stale-perm-ver';
    await executeCustomerDomainCommand({
      db,
      agencyId: AGENCY_ID,
      actorUserId: OWNER_USER_ID,
      actorIdentityId: 'ident-owner',
      actorMembershipId: OWNER_MEM_ID,
      expectedPermissionVersion: 2,
      correlationId: 'corr-perm-cr',
      idempotencyKey: 'ik-perm-cr',
      payload: { title: 'Perm Ver Co' },
      command: {
        kind: 'customer.create',
        customerId: custId,
        type: 'COMPANY',
        displayName: 'Perm Ver Co',
        companyTitle: 'Perm Ver Co',
      },
      resultProducer: () => ({ status: 201, body: { id: custId } }),
    });

    // Ensure customer is assigned to MEMBER_MEM_ID
    await db
      .prepare('UPDATE customers SET assignee_membership_id = ? WHERE id = ?')
      .bind(MEMBER_MEM_ID, custId)
      .run();

    // MEMBER_MEM_ID has permission_version = 2 in DB. Passing stale expectedPermissionVersion = 1 aborts!
    const staleKey = 'ik-stale-perm-ver-attempt';
    await expect(
      executeCustomerDomainCommand({
        db,
        agencyId: AGENCY_ID,
        actorUserId: MEMBER_USER_ID,
        actorIdentityId: `ident-${MEMBER_USER_ID}`,
        actorMembershipId: MEMBER_MEM_ID,
        expectedPermissionVersion: 1, // STALE! Actual DB version is 2
        correlationId: 'corr-stale-pv',
        idempotencyKey: staleKey,
        payload: { companyTitle: 'Stale Version Attack' },
        command: {
          kind: 'customer.update',
          customerId: custId,
          expectedVersion: 1,
          companyTitle: 'Stale Version Attack',
          changedFields: ['companyTitle'],
        },
        resultProducer: () => ({ status: 200, body: { ok: true } }),
      }),
    ).rejects.toThrow(/FINAL_AUTHORITY_RECHECK_FAILED/);

    const receipt = await db
      .prepare('SELECT id FROM operation_receipts WHERE idempotency_key = ?')
      .bind(staleKey)
      .first();
    expect(receipt).toBeNull();
  });

  // 6. M1 SECURE_GRANT permission mutation regression check
  it('M1 regression: protected permission mutation requires valid SECURE_GRANT and is unharmed', async () => {
    const dummyReq = new Request('https://crm.local/api/protected/permissions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({}),
    });

    const dummyContext: AuthenticatedUserContext = {
      userId: OWNER_USER_ID,
      identityId: 'id-owner',
      email: 'owner@test.com',
      assurance: 'SECURE',
      memberships: [
        {
          id: OWNER_MEM_ID,
          agencyId: AGENCY_ID,
          type: 'OWNER',
          status: 'ACTIVE',
          permissionVersion: 1,
        },
      ],
    };

    // Calling executeProtectedPermissionMutation without valid CSRF and SECURE_GRANT fails closed
    await expect(
      executeProtectedPermissionMutation(db, {
        request: dummyReq,
        csrfSecret: 'a'.repeat(32),
        authenticatedSubject: 'sub-owner',
        context: dummyContext,
        resolveMutation: async () => ({
          agencyId: AGENCY_ID,
          correlationId: 'corr-m1-reg',
          idempotencyKey: 'ik-m1-reg',
          grantEvidenceToken: 'dummy-token',
          operation: {
            kind: 'REVOKE_PERMISSION',
            membershipId: MEMBER_MEM_ID,
            permissionCode: 'customer.update',
            expectedPermissionVersion: 1,
          },
        }),
      }),
    ).rejects.toThrow();
  });
});
