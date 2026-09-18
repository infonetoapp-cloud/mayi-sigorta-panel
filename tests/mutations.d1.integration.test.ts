// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import miniflare from 'miniflare';
import { issueAndPersistSensitiveActionGrant } from '../src/server/mutations/grants';
import { computePayloadHash } from '../src/server/mutations/canonical';
import { executeAtomicMutation } from '../src/server/mutations/executor';
import { OptimisticConcurrencyError } from '../src/server/db/optimistic';
import { evaluateAuthorization } from '../src/server/auth/authorization';
import type { AuthenticatedUserContext } from '../src/server/auth/identity';

const { Miniflare, convertV4MiniflareOptions } = miniflare;
const rootDir = resolve(__dirname, '..');

describe('M1-T09 Real Miniflare/D1 Mutation Security Foundation', () => {
  let mf: miniflare.Miniflare;
  let db: D1Database;

  beforeAll(async () => {
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: 'export default { fetch() { return new Response(null); } }',
        d1Databases: {
          DB: '00000000-0000-0000-0000-000000000001',
        },
      }),
    );
    db = await mf.getD1Database('DB');

    // Run migrations 0000, 0001, 0002 sequentially
    const m0 = readFileSync(resolve(rootDir, 'db/migrations/0000_good_hammerhead.sql'), 'utf8');
    const m1 = readFileSync(
      resolve(rootDir, 'db/migrations/0001_chunky_blazing_skull.sql'),
      'utf8',
    );
    const m2 = readFileSync(resolve(rootDir, 'db/migrations/0002_productive_arclight.sql'), 'utf8');

    for (const sql of [m0, m1, m2]) {
      const stmts = sql
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const stmt of stmts) {
        await db.prepare(stmt).run();
      }
    }
  });

  afterAll(async () => {
    if (mf) {
      await mf.dispose();
    }
  });

  // Seed agency, user, membership, and auth identity following M1-T03 bootstrap lifecycle
  async function seedTestActors(prefix: string) {
    const agencyId = `${prefix}-agency`;
    const userId = `${prefix}-user`;
    const membershipId = `${prefix}-mem`;
    const identityId = `${prefix}-ident`;

    // 1. PROVISIONING agency
    await db
      .prepare("INSERT INTO agencies (id, status, version) VALUES (?, 'PROVISIONING', 1)")
      .bind(agencyId)
      .run();

    // 2. INACTIVE user
    await db
      .prepare("INSERT INTO users (id, status, version) VALUES (?, 'INACTIVE', 1)")
      .bind(userId)
      .run();

    // 3. INVITED OWNER membership
    await db
      .prepare(
        `INSERT INTO agency_memberships (
           id, agency_id, user_id, type, status, invitation_email, invitation_expires_at,
           version, permission_version
         ) VALUES (
           ?, ?, ?, 'OWNER', 'INVITED', ?, '2099-01-01T00:00:00.000Z', 1, 1
         )`,
      )
      .bind(membershipId, agencyId, userId, `${prefix}@example.test`)
      .run();

    // 4. ACTIVE auth identity
    await db
      .prepare(
        `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
         VALUES (?, ?, 'https://synthetic.cloudflareaccess.com', ?, ?, 'ACTIVE')`,
      )
      .bind(identityId, userId, `${prefix}-sub`, `${prefix}@example.test`)
      .run();

    // 5. Activate user
    await db
      .prepare("UPDATE users SET status = 'ACTIVE', version = version + 1 WHERE id = ?")
      .bind(userId)
      .run();

    // 6. Activate membership (permission_version becomes 2)
    await db
      .prepare(
        `UPDATE agency_memberships
         SET status = 'ACTIVE', activated_at = '2026-09-17T00:00:00.000Z',
             version = version + 1, permission_version = permission_version + 1
         WHERE id = ?`,
      )
      .bind(membershipId)
      .run();

    // 7. Activate agency
    await db
      .prepare(
        `UPDATE agencies
         SET status = 'ACTIVE', bootstrap_completed_at = '2026-09-17T00:00:00.000Z',
             activated_at = '2026-09-17T00:00:00.000Z', version = version + 1
         WHERE id = ?`,
      )
      .bind(agencyId)
      .run();

    return { agencyId, userId, membershipId, identityId, permissionVersion: 2 };
  }

  function createSecureContext(seed: {
    userId: string;
    identityId: string;
    agencyId: string;
    membershipId: string;
    permissionVersion: number;
  }): AuthenticatedUserContext {
    return {
      userId: seed.userId,
      identityId: seed.identityId,
      email: `${seed.userId}@example.test`,
      assurance: 'SECURE',
      memberships: [
        {
          id: seed.membershipId,
          agencyId: seed.agencyId,
          type: 'OWNER',
          status: 'ACTIVE',
          permissionVersion: seed.permissionVersion,
        },
      ],
    };
  }

  // 1. Valid consume: grant + business mutation + idempotency + audit in 1 atomic batch
  it('1. Valid consume: atomically consumes grant, applies business mutation, records idempotency and safe audit', async () => {
    const actors = await seedTestActors('t1');
    const { agencyId, userId, membershipId } = actors;
    const targetId = `${agencyId}-target`;
    const action = 'membership.role.change';
    const payload = { newRole: 'OWNER', targetMembershipId: targetId };
    const payloadHash = await computePayloadHash(payload);

    const context = createSecureContext(actors);
    const { grantToken, grantRecord } = await issueAndPersistSensitiveActionGrant(db, context, {
      agencyId,
      action,
      payloadHash,
      targetIds: [targetId],
    });

    const businessStmt = db
      .prepare(
        `UPDATE agency_memberships
         SET version = version + 1
         WHERE id = ? AND version = 2`,
      )
      .bind(membershipId);

    const result = await executeAtomicMutation({
      db,
      assurance: 'SECURE_GRANT',
      agencyId,
      actorUserId: userId,
      actorMembershipId: membershipId,
      action,
      correlationId: 'req-corr-1',
      idempotencyKey: 'idem-1',
      payload,
      grantEvidenceToken: grantToken,
      targetType: 'agency_memberships',
      targetId,
      auditMetadata: {
        reasonCode: 'OWNERSHIP_UPGRADE',
        resultCode: 'UPGRADE_SUCCESS',
        requestSource: 'SECURE_DASHBOARD',
        changedFieldCount: 1,
        targetVersion: 2,
        replayed: false,
        password: 'DoNotLeakThisPassword!',
        authorization: 'Bearer secret-bearer-token',
        arbitraryNote: 'ShouldBeDropped',
      },
      businessOperations: [{ statement: businessStmt, expectedChanges: 1 }],
      resultProducer: () => ({ status: 200, body: { success: true, updatedRole: 'OWNER' } }),
    });

    expect(result.executed).toBe(true);
    expect(result.replayed).toBe(false);
    expect(result.body).toEqual({ success: true, updatedRole: 'OWNER' });

    // Verify in DB: grant is CONSUMED
    const updatedGrant = await db
      .prepare(
        'SELECT status, consumed_at, consumed_operation_id FROM sensitive_action_grants WHERE id = ?',
      )
      .bind(grantRecord.id)
      .first<{ status: string; consumed_at: string; consumed_operation_id: string }>();

    expect(updatedGrant?.status).toBe('CONSUMED');
    expect(updatedGrant?.consumed_at).toBeDefined();
    expect(updatedGrant?.consumed_operation_id).toBe('req-corr-1');

    // Verify in DB: idempotency receipt is recorded as COMPLETED
    const receipt = await db
      .prepare('SELECT status, response_body FROM operation_receipts WHERE idempotency_key = ?')
      .bind('idem-1')
      .first<{ status: string; response_body: string }>();

    expect(receipt?.status).toBe('COMPLETED');
    expect(JSON.parse(receipt?.response_body ?? '{}')).toEqual({
      success: true,
      updatedRole: 'OWNER',
    });

    // Verify in DB: audit record exists and has safe metadata only
    const audit = await db
      .prepare('SELECT outcome, metadata_json FROM audit_events WHERE correlation_id = ?')
      .bind('req-corr-1')
      .first<{ outcome: string; metadata_json: string }>();

    expect(audit?.outcome).toBe('SUCCESS');
    expect(audit?.metadata_json).toContain('OWNERSHIP_UPGRADE');
    expect(audit?.metadata_json).toContain('UPGRADE_SUCCESS');
    expect(audit?.metadata_json).not.toContain('DoNotLeakThisPassword');
    expect(audit?.metadata_json).not.toContain('secret-bearer-token');
    expect(audit?.metadata_json).not.toContain('ShouldBeDropped');
  });

  // 2. Expiry: expired grant fails closed and leaves grant unconsumed and no success audit
  it('2. Expiry: expired grant fails closed, rollback leaves grant unchanged and no success audit', async () => {
    const actors = await seedTestActors('t2');
    const { agencyId, userId, membershipId } = actors;
    const targetId = `${agencyId}-target`;
    const action = 'membership.role.change';
    const payload = { targetMembershipId: targetId };
    const payloadHash = await computePayloadHash(payload);

    const pastTime = new Date('2020-01-01T00:00:00.000Z');
    const context = createSecureContext(actors);
    const { grantToken, grantRecord } = await issueAndPersistSensitiveActionGrant(db, context, {
      agencyId,
      action,
      payloadHash,
      targetIds: [targetId],
      ttlSeconds: 60,
      now: pastTime,
    });

    await expect(
      executeAtomicMutation({
        db,
        assurance: 'SECURE_GRANT',
        agencyId,
        actorUserId: userId,
        actorMembershipId: membershipId,
        action,
        correlationId: 'req-corr-2',
        idempotencyKey: 'idem-2',
        payload,
        grantEvidenceToken: grantToken,
        targetType: 'agency_memberships',
        targetId,
        businessOperations: [{ statement: db.prepare('SELECT 1'), expectedChanges: 0 }],
        resultProducer: () => ({ status: 200, body: { success: true } }),
      }),
    ).rejects.toThrow('GRANT_EXPIRED');

    // Grant remains ISSUED, not consumed
    const checkGrant = await db
      .prepare('SELECT status, consumed_at FROM sensitive_action_grants WHERE id = ?')
      .bind(grantRecord.id)
      .first<{ status: string; consumed_at: string | null }>();
    expect(checkGrant?.status).toBe('ISSUED');
    expect(checkGrant?.consumed_at).toBeNull();

    // No audit record exists
    const checkAudit = await db
      .prepare('SELECT count(*) as count FROM audit_events WHERE correlation_id = ?')
      .bind('req-corr-2')
      .first<{ count: number }>();
    expect(checkAudit?.count).toBe(0);
  });

  // 3. Replay: already consumed grant fails closed
  it('3. Replay: already consumed grant fails closed', async () => {
    const actors = await seedTestActors('t3');
    const { agencyId, userId, membershipId } = actors;
    const targetId = `${agencyId}-target`;
    const action = 'membership.role.change';
    const payload = { targetMembershipId: targetId };
    const payloadHash = await computePayloadHash(payload);

    const context = createSecureContext(actors);
    const { grantToken, grantRecord } = await issueAndPersistSensitiveActionGrant(db, context, {
      agencyId,
      action,
      payloadHash,
      targetIds: [targetId],
    });

    // Mark directly as CONSUMED in DB
    await db
      .prepare(
        `UPDATE sensitive_action_grants
         SET status = 'CONSUMED',
             consumed_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
             consumed_operation_id = 'prev-op'
         WHERE id = ?`,
      )
      .bind(grantRecord.id)
      .run();

    await expect(
      executeAtomicMutation({
        db,
        assurance: 'SECURE_GRANT',
        agencyId,
        actorUserId: userId,
        actorMembershipId: membershipId,
        action,
        correlationId: 'req-corr-3',
        idempotencyKey: 'idem-3',
        payload,
        grantEvidenceToken: grantToken,
        targetType: 'agency_memberships',
        targetId,
        businessOperations: [{ statement: db.prepare('SELECT 1'), expectedChanges: 0 }],
        resultProducer: () => ({ status: 200, body: { success: true } }),
      }),
    ).rejects.toThrow('GRANT_ALREADY_CONSUMED');
  });

  // 4. Every binding class mismatch fails closed
  it('4. Every binding class mismatch fails closed', async () => {
    const actors = await seedTestActors('t4');
    const { agencyId, userId, membershipId } = actors;
    const targetId = 'mem-target-1';
    const action = 'membership.role.change';
    const payload = { target: targetId };
    const payloadHash = await computePayloadHash(payload);

    const context = createSecureContext(actors);
    const { grantToken } = await issueAndPersistSensitiveActionGrant(db, context, {
      agencyId,
      action,
      payloadHash,
      targetIds: [targetId],
      expectedTargetVersion: 1,
    });

    const dummyOps = [{ statement: db.prepare('SELECT 1'), expectedChanges: 0 }];

    // Actor mismatch
    await expect(
      executeAtomicMutation({
        db,
        assurance: 'SECURE_GRANT',
        agencyId,
        actorUserId: 'wrong-actor-user',
        actorMembershipId: membershipId,
        action,
        correlationId: 'c1',
        idempotencyKey: 'k1',
        payload,
        grantEvidenceToken: grantToken,
        targetType: 'agency_memberships',
        targetId,
        businessOperations: dummyOps,
        resultProducer: () => ({ status: 200, body: {} }),
      }),
    ).rejects.toThrow('GRANT_ACTOR_USER_MISMATCH');

    // Membership mismatch
    await expect(
      executeAtomicMutation({
        db,
        assurance: 'SECURE_GRANT',
        agencyId,
        actorUserId: userId,
        actorMembershipId: 'wrong-membership',
        action,
        correlationId: 'c2',
        idempotencyKey: 'k2',
        payload,
        grantEvidenceToken: grantToken,
        targetType: 'agency_memberships',
        targetId,
        businessOperations: dummyOps,
        resultProducer: () => ({ status: 200, body: {} }),
      }),
    ).rejects.toThrow('GRANT_MEMBERSHIP_MISMATCH');

    // Agency mismatch
    await expect(
      executeAtomicMutation({
        db,
        assurance: 'SECURE_GRANT',
        agencyId: 'wrong-agency',
        actorUserId: userId,
        actorMembershipId: membershipId,
        action,
        correlationId: 'c3',
        idempotencyKey: 'k3',
        payload,
        grantEvidenceToken: grantToken,
        targetType: 'agency_memberships',
        targetId,
        businessOperations: dummyOps,
        resultProducer: () => ({ status: 200, body: {} }),
      }),
    ).rejects.toThrow('GRANT_AGENCY_MISMATCH');

    // Action mismatch
    await expect(
      executeAtomicMutation({
        db,
        assurance: 'SECURE_GRANT',
        agencyId,
        actorUserId: userId,
        actorMembershipId: membershipId,
        action: 'membership.suspend',
        correlationId: 'c4',
        idempotencyKey: 'k4',
        payload,
        grantEvidenceToken: grantToken,
        targetType: 'agency_memberships',
        targetId,
        businessOperations: dummyOps,
        resultProducer: () => ({ status: 200, body: {} }),
      }),
    ).rejects.toThrow('GRANT_ACTION_MISMATCH');

    // Payload mismatch
    await expect(
      executeAtomicMutation({
        db,
        assurance: 'SECURE_GRANT',
        agencyId,
        actorUserId: userId,
        actorMembershipId: membershipId,
        action,
        correlationId: 'c5',
        idempotencyKey: 'k5',
        payload: { differentField: 'altered' },
        grantEvidenceToken: grantToken,
        targetType: 'agency_memberships',
        targetId,
        businessOperations: dummyOps,
        resultProducer: () => ({ status: 200, body: {} }),
      }),
    ).rejects.toThrow('GRANT_PAYLOAD_MISMATCH');

    // Target version mismatch
    await expect(
      executeAtomicMutation({
        db,
        assurance: 'SECURE_GRANT',
        agencyId,
        actorUserId: userId,
        actorMembershipId: membershipId,
        action,
        correlationId: 'c6',
        idempotencyKey: 'k6',
        payload,
        grantEvidenceToken: grantToken,
        expectedTargetVersion: 99, // grant was bound to version 1
        targetType: 'agency_memberships',
        targetId,
        businessOperations: dummyOps,
        resultProducer: () => ({ status: 200, body: {} }),
      }),
    ).rejects.toThrow('GRANT_TARGET_VERSION_MISMATCH');
  });

  // 5. Stale permission_version in DB fails closed
  it('5. Stale permission_version fails closed when live DB permission_version changes after grant', async () => {
    const actors = await seedTestActors('t5');
    const { agencyId, userId, membershipId } = actors;
    const targetId = 'mem-target-5';
    const action = 'membership.role.change';
    const payload = { target: targetId };
    const payloadHash = await computePayloadHash(payload);

    const context = createSecureContext(actors);
    const { grantToken } = await issueAndPersistSensitiveActionGrant(db, context, {
      agencyId,
      action,
      payloadHash,
      targetIds: [targetId],
    });

    // Increment permission_version in D1 after grant issuance
    await db
      .prepare(
        `UPDATE agency_memberships
         SET version = version + 1,
             permission_version = permission_version + 1,
             updated_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
         WHERE id = ?`,
      )
      .bind(membershipId)
      .run();

    await expect(
      executeAtomicMutation({
        db,
        assurance: 'SECURE_GRANT',
        agencyId,
        actorUserId: userId,
        actorMembershipId: membershipId,
        action,
        correlationId: 'c-stale-perm',
        idempotencyKey: 'k-stale',
        payload,
        grantEvidenceToken: grantToken,
        targetType: 'agency_memberships',
        targetId,
        businessOperations: [{ statement: db.prepare('SELECT 1'), expectedChanges: 0 }],
        resultProducer: () => ({ status: 200, body: {} }),
      }),
    ).rejects.toThrow('GRANT_PERMISSION_VERSION_STALE');
  });

  // 6. Concurrent double consume: at most one execution succeeds
  it('6. Concurrent double consume: at most one execution succeeds', async () => {
    const actors = await seedTestActors('t6');
    const { agencyId, userId, membershipId } = actors;
    const targetId = 'mem-target-6';
    const action = 'membership.role.change';
    const payload = { target: targetId };
    const payloadHash = await computePayloadHash(payload);

    const context = createSecureContext(actors);
    const { grantToken } = await issueAndPersistSensitiveActionGrant(db, context, {
      agencyId,
      action,
      payloadHash,
      targetIds: [targetId],
    });

    const runAttempt = (corrId: string, key: string) =>
      executeAtomicMutation({
        db,
        assurance: 'SECURE_GRANT',
        agencyId,
        actorUserId: userId,
        actorMembershipId: membershipId,
        action,
        correlationId: corrId,
        idempotencyKey: key,
        payload,
        grantEvidenceToken: grantToken,
        targetType: 'agency_memberships',
        targetId,
        businessOperations: [
          {
            statement: db
              .prepare('UPDATE agencies SET version = version + 1 WHERE id = ?')
              .bind(agencyId),
            expectedChanges: 1,
          },
        ],
        resultProducer: () => ({ status: 200, body: { done: true } }),
      });

    const results = await Promise.allSettled([
      runAttempt('corr-6-a', 'key-6-a'),
      runAttempt('corr-6-b', 'key-6-b'),
    ]);

    const fulfilled = results.filter((r) => r.status === 'fulfilled');
    const rejected = results.filter((r) => r.status === 'rejected');

    // Exactly one must succeed, the other must fail because the grant can only be consumed once!
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);

    // Audit count for this grant is exactly 1 success
    const audits = await db
      .prepare('SELECT count(*) as count FROM audit_events WHERE action = ? AND agency_id = ?')
      .bind(action, agencyId)
      .first<{ count: number }>();
    expect(audits?.count).toBe(1);
  });

  // 7. Idempotent replay: same key + same payload returns previous response without re-executing
  it('7. Idempotent replay: same key and same payload returns cached response without duplicate execution', async () => {
    const { agencyId, userId, membershipId } = await seedTestActors('t7');
    const targetId = 'mem-target-7';
    const action = 'customer.create';
    const payload = { branch: 'KASKO', customerName: 'Ahmet Yilmaz' };

    let businessEffectCount = 0;
    const mutate = () =>
      executeAtomicMutation({
        db,
        assurance: 'NORMAL_SESSION',
        agencyId,
        actorUserId: userId,
        actorMembershipId: membershipId,
        action,
        correlationId: `corr-7-${++businessEffectCount}`,
        idempotencyKey: 'idem-key-7',
        payload,
        targetType: 'customers',
        targetId,
        businessOperations: [
          {
            statement: db
              .prepare('UPDATE agencies SET version = version + 1 WHERE id = ?')
              .bind(agencyId),
            expectedChanges: 1,
          },
        ],
        resultProducer: () => ({
          status: 201,
          body: { customerId: 'cust-123', name: 'Ahmet Yilmaz' },
        }),
      });

    const firstResult = await mutate();
    expect(firstResult.executed).toBe(true);
    expect(firstResult.replayed).toBe(false);
    expect(firstResult.status).toBe(201);
    expect(firstResult.body).toEqual({ customerId: 'cust-123', name: 'Ahmet Yilmaz' });

    // Second call with same idempotency key and same payload
    const secondResult = await mutate();
    expect(secondResult.executed).toBe(false);
    expect(secondResult.replayed).toBe(true);
    expect(secondResult.status).toBe(201);
    expect(secondResult.body).toEqual({ customerId: 'cust-123', name: 'Ahmet Yilmaz' });

    // Verify audit log has exactly ONE entry
    const audits = await db
      .prepare('SELECT count(*) as count FROM audit_events WHERE agency_id = ? AND action = ?')
      .bind(agencyId, action)
      .first<{ count: number }>();
    expect(audits?.count).toBe(1);
  });

  // 8. Key / payload conflict: same key with different payload throws IDEMPOTENCY_PAYLOAD_MISMATCH
  it('8. Key / payload conflict: same key with different payload throws IDEMPOTENCY_PAYLOAD_MISMATCH', async () => {
    const { agencyId, userId, membershipId } = await seedTestActors('t8');
    const targetId = 'mem-target-8';
    const action = 'customer.create';
    const payloadA = { customerName: 'Original Name' };
    const payloadB = { customerName: 'Different Name' };

    const ops = [
      {
        statement: db
          .prepare('UPDATE agencies SET version = version + 1 WHERE id = ?')
          .bind(agencyId),
        expectedChanges: 1,
      },
    ];

    await executeAtomicMutation({
      db,
      assurance: 'NORMAL_SESSION',
      agencyId,
      actorUserId: userId,
      actorMembershipId: membershipId,
      action,
      correlationId: 'corr-8-orig',
      idempotencyKey: 'idem-key-8',
      payload: payloadA,
      targetType: 'customers',
      targetId,
      businessOperations: ops,
      resultProducer: () => ({ status: 200, body: { done: true } }),
    });

    await expect(
      executeAtomicMutation({
        db,
        assurance: 'NORMAL_SESSION',
        agencyId,
        actorUserId: userId,
        actorMembershipId: membershipId,
        action,
        correlationId: 'corr-8-conflict',
        idempotencyKey: 'idem-key-8', // Same key!
        payload: payloadB, // Different payload!
        targetType: 'customers',
        targetId,
        businessOperations: ops,
        resultProducer: () => ({ status: 200, body: { done: true } }),
      }),
    ).rejects.toThrow('IDEMPOTENCY_PAYLOAD_MISMATCH');
  });

  // 9. Concurrent duplicate mutation with one effect (both settle successfully, one executed, one replayed)
  it('9. Concurrent duplicate mutation with one effect', async () => {
    const { agencyId, userId, membershipId } = await seedTestActors('t9');
    const targetId = 'mem-target-9';
    const action = 'customer.create';
    const payload = { customerName: 'Concurrent Customer' };

    const runMutation = (corrId: string) =>
      executeAtomicMutation({
        db,
        assurance: 'NORMAL_SESSION',
        agencyId,
        actorUserId: userId,
        actorMembershipId: membershipId,
        action,
        correlationId: corrId,
        idempotencyKey: 'idem-key-concurrent-9',
        payload,
        targetType: 'customers',
        targetId,
        businessOperations: [
          {
            statement: db
              .prepare('UPDATE agencies SET version = version + 1 WHERE id = ?')
              .bind(agencyId),
            expectedChanges: 1,
          },
        ],
        resultProducer: () => ({ status: 201, body: { created: true } }),
      });

    const results = await Promise.allSettled([runMutation('corr-9-a'), runMutation('corr-9-b')]);

    // Both concurrent identical requests must succeed (one executed, one replayed)
    expect(results.every((r) => r.status === 'fulfilled')).toBe(true);

    // Verify DB has only ONE receipt and ONE audit record
    const receipts = await db
      .prepare('SELECT count(*) as count FROM operation_receipts WHERE idempotency_key = ?')
      .bind('idem-key-concurrent-9')
      .first<{ count: number }>();
    expect(receipts?.count).toBe(1);

    const audits = await db
      .prepare('SELECT count(*) as count FROM audit_events WHERE idempotency_key = ?')
      .bind('idem-key-concurrent-9')
      .first<{ count: number }>();
    expect(audits?.count).toBe(1);
  });

  // 10. Audit success and rollback / no false success:
  // When business mutation fails due to CAS conflict, no false success audit is left
  it('10. Rollback integrity: failed business CAS assertion leaves no false success audit or consumed grant', async () => {
    const actors = await seedTestActors('t10');
    const { agencyId, userId, membershipId } = actors;
    const targetId = 'mem-target-10';
    const action = 'membership.role.change';
    const payload = { target: targetId };
    const payloadHash = await computePayloadHash(payload);

    const context = createSecureContext(actors);
    const { grantToken, grantRecord } = await issueAndPersistSensitiveActionGrant(db, context, {
      agencyId,
      action,
      payloadHash,
      targetIds: [targetId],
    });

    // Business statement with stale version condition (expecting version 999 which does not exist)
    const failingBusinessStmt = db
      .prepare('UPDATE agency_memberships SET version = 100 WHERE id = ? AND version = 999')
      .bind(membershipId);

    await expect(
      executeAtomicMutation({
        db,
        assurance: 'SECURE_GRANT',
        agencyId,
        actorUserId: userId,
        actorMembershipId: membershipId,
        action,
        correlationId: 'corr-10-fail',
        idempotencyKey: 'idem-10-fail',
        payload,
        grantEvidenceToken: grantToken,
        targetType: 'agency_memberships',
        targetId,
        businessOperations: [{ statement: failingBusinessStmt, expectedChanges: 1 }],
        resultProducer: () => ({ status: 200, body: { done: true } }),
      }),
    ).rejects.toBeInstanceOf(OptimisticConcurrencyError);

    // Invariant: Grant is NOT consumed
    const grantAfter = await db
      .prepare('SELECT status, consumed_at FROM sensitive_action_grants WHERE id = ?')
      .bind(grantRecord.id)
      .first<{ status: string; consumed_at: string | null }>();
    expect(grantAfter?.status).toBe('ISSUED');
    expect(grantAfter?.consumed_at).toBeNull();

    // Invariant: No false success audit record
    const auditAfter = await db
      .prepare('SELECT count(*) as count FROM audit_events WHERE correlation_id = ?')
      .bind('corr-10-fail')
      .first<{ count: number }>();
    expect(auditAfter?.count).toBe(0);

    // Invariant: No idempotency receipt
    const receiptAfter = await db
      .prepare('SELECT count(*) as count FROM operation_receipts WHERE idempotency_key = ?')
      .bind('idem-10-fail')
      .first<{ count: number }>();
    expect(receiptAfter?.count).toBe(0);
  });

  // 11. T07 SECURE_GRANT_REQUIRED integration: evaluateAuthorization allow / deny
  it('11. T07 Integration: evaluateAuthorization denies when grant is missing or mismatched, allows when grant is valid', async () => {
    const actors = await seedTestActors('t11');
    const { agencyId, userId, membershipId, identityId, permissionVersion } = actors;

    const authContext: AuthenticatedUserContext = {
      userId,
      identityId,
      email: 't11@example.test',
      assurance: 'SECURE',
      memberships: [
        {
          id: membershipId,
          agencyId,
          type: 'OWNER',
          status: 'ACTIVE',
          permissionVersion,
        },
      ],
    };

    const targetPayload = { fileFormat: 'CSV', filter: 'active' };
    const payloadHash = await computePayloadHash(targetPayload);

    // 1. Without secureGrantBinding -> DENY with SECURE_GRANT_REQUIRED
    const withoutGrant = await evaluateAuthorization(db, {
      context: authContext,
      action: 'export.scoped',
      agencyId,
    });
    expect(withoutGrant.decision).toBe('DENY');
    expect(withoutGrant.code).toBe('SECURE_GRANT_REQUIRED');

    // 2. With invalid/unrelated grant token -> DENY with SECURE_GRANT_REQUIRED
    const withBadGrant = await evaluateAuthorization(db, {
      context: authContext,
      action: 'export.scoped',
      agencyId,
      secureGrantBinding: {
        evidence: 'completely-invalid-opaque-token-string',
        payload: targetPayload,
        targetIds: [agencyId],
        expectedTargetVersion: null,
      },
    });
    expect(withBadGrant.decision).toBe('DENY');
    expect(withBadGrant.code).toBe('SECURE_GRANT_REQUIRED');

    // 3. With valid grant evidence created for export.scoped
    const { grantToken } = await issueAndPersistSensitiveActionGrant(db, authContext, {
      agencyId,
      action: 'export.scoped',
      payloadHash,
      targetIds: [agencyId],
      expectedTargetVersion: null,
    });

    const withValidGrant = await evaluateAuthorization(db, {
      context: authContext,
      action: 'export.scoped',
      agencyId,
      secureGrantBinding: {
        evidence: grantToken,
        payload: targetPayload,
        targetIds: [agencyId],
        expectedTargetVersion: null,
      },
    });

    // OWNER has implicit NORMAL grants for export.scoped, so with valid grant it ALLOWS!
    expect(withValidGrant.decision).toBe('ALLOW');
    expect(withValidGrant.code).toBe('ALLOWED');

    // 4. Adversarial check: Mismatched payload -> DENY SECURE_GRANT_REQUIRED
    const withWrongPayload = await evaluateAuthorization(db, {
      context: authContext,
      action: 'export.scoped',
      agencyId,
      secureGrantBinding: {
        evidence: grantToken,
        payload: { fileFormat: 'PDF', filter: 'active' }, // Altered payload!
        targetIds: [agencyId],
        expectedTargetVersion: null,
      },
    });
    expect(withWrongPayload.decision).toBe('DENY');
    expect(withWrongPayload.code).toBe('SECURE_GRANT_REQUIRED');

    // 5. Adversarial check: Mismatched targetIds -> DENY SECURE_GRANT_REQUIRED
    const withWrongTargets = await evaluateAuthorization(db, {
      context: authContext,
      action: 'export.scoped',
      agencyId,
      secureGrantBinding: {
        evidence: grantToken,
        payload: targetPayload,
        targetIds: ['unauthorized-agency-id'],
        expectedTargetVersion: null,
      },
    });
    expect(withWrongTargets.decision).toBe('DENY');
    expect(withWrongTargets.code).toBe('SECURE_GRANT_REQUIRED');

    // 6. Adversarial check: Malformed secureGrantBinding envelope (empty targetIds) -> DENY MALFORMED_INPUT
    const withMalformedEnvelope = await evaluateAuthorization(db, {
      context: authContext,
      action: 'export.scoped',
      agencyId,
      secureGrantBinding: {
        evidence: grantToken,
        payload: targetPayload,
        targetIds: [], // Empty!
        expectedTargetVersion: null,
      },
    });
    expect(withMalformedEnvelope.decision).toBe('DENY');
    expect(withMalformedEnvelope.code).toBe('MALFORMED_INPUT');

    let payloadGetterReads = 0;
    const accessorBinding = {
      evidence: grantToken,
      get payload() {
        payloadGetterReads += 1;
        return targetPayload;
      },
      targetIds: [agencyId],
      expectedTargetVersion: null,
    };
    const withAccessorPayload = await evaluateAuthorization(db, {
      context: authContext,
      action: 'export.scoped',
      agencyId,
      secureGrantBinding: accessorBinding,
    });
    expect(withAccessorPayload.decision).toBe('DENY');
    expect(withAccessorPayload.code).toBe('MALFORMED_INPUT');
    expect(payloadGetterReads).toBe(0);
  });

  // 12. Contract 4: Zero-row business mutation auto-rollback without caller CAS assertion
  it('12. Zero-row business mutation auto-rollback without caller CAS assertion aborts atomic mutation', async () => {
    const actors = await seedTestActors('t12');
    const { agencyId, userId, membershipId } = actors;
    const targetId = 'mem-target-12';
    const action = 'membership.role.change';
    const payload = { target: targetId };
    const payloadHash = await computePayloadHash(payload);

    const context = createSecureContext(actors);
    const { grantToken, grantRecord } = await issueAndPersistSensitiveActionGrant(db, context, {
      agencyId,
      action,
      payloadHash,
      targetIds: [targetId],
    });

    // Zero-row business UPDATE without caller CAS assertion statement
    const zeroRowUpdateStmt = db
      .prepare('UPDATE agencies SET version = 999 WHERE id = ? AND version = -1')
      .bind(agencyId);

    await expect(
      executeAtomicMutation({
        db,
        assurance: 'SECURE_GRANT',
        agencyId,
        actorUserId: userId,
        actorMembershipId: membershipId,
        action,
        correlationId: 'corr-12-zero-row',
        idempotencyKey: 'idem-12-zero-row',
        payload,
        grantEvidenceToken: grantToken,
        targetType: 'agency_memberships',
        targetId,
        // Caller only provides business statement without any manual CAS assertion statement
        businessOperations: [{ statement: zeroRowUpdateStmt, expectedChanges: 1 }],
        resultProducer: () => ({ status: 200, body: { done: true } }),
      }),
    ).rejects.toBeInstanceOf(OptimisticConcurrencyError);

    // Grant must NOT be consumed
    const grantCheck = await db
      .prepare('SELECT status, consumed_at FROM sensitive_action_grants WHERE id = ?')
      .bind(grantRecord.id)
      .first<{ status: string; consumed_at: string | null }>();
    expect(grantCheck?.status).toBe('ISSUED');
    expect(grantCheck?.consumed_at).toBeNull();

    // No false audit or receipt
    const auditCheck = await db
      .prepare('SELECT count(*) as count FROM audit_events WHERE correlation_id = ?')
      .bind('corr-12-zero-row')
      .first<{ count: number }>();
    expect(auditCheck?.count).toBe(0);
  });

  // 13. Schema Check Constraints & TTL Boundary Invariants
  it('13. Enforces DB check constraints on grant TTL <= 180s and hash lengths', async () => {
    const actors = await seedTestActors('t13');
    const { agencyId, userId, membershipId } = actors;

    // Direct insert with invalid hash length (must fail SQLite check constraint)
    await expect(
      db
        .prepare(
          `INSERT INTO sensitive_action_grants (
             id, evidence_hash, agency_id, actor_user_id, actor_membership_id, action,
             payload_hash, target_ids_json, expected_target_version, permission_version,
             assurance, status, issued_at, expires_at
           ) VALUES (?, 'too-short', ?, ?, ?, 'action', ?, '["id"]', null, 1, 'SECURE_GRANT', 'ISSUED', '2026-09-18T00:00:00.000Z', '2026-09-18T00:01:00.000Z')`,
        )
        .bind(crypto.randomUUID(), agencyId, userId, membershipId, 'a'.repeat(64))
        .run(),
    ).rejects.toThrow();

    // Direct insert with TTL > 180 seconds (must fail SQLite check constraint)
    await expect(
      db
        .prepare(
          `INSERT INTO sensitive_action_grants (
             id, evidence_hash, agency_id, actor_user_id, actor_membership_id, action,
             payload_hash, target_ids_json, expected_target_version, permission_version,
             assurance, status, issued_at, expires_at
           ) VALUES (?, ?, ?, ?, ?, 'action', ?, '["id"]', null, 1, 'SECURE_GRANT', 'ISSUED', '2026-09-18T00:00:00.000Z', '2026-09-18T00:05:00.000Z')`,
        )
        .bind(crypto.randomUUID(), 'b'.repeat(64), agencyId, userId, membershipId, 'a'.repeat(64))
        .run(),
    ).rejects.toThrow();
  });
});
