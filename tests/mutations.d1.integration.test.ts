// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Hono } from 'hono';
import miniflare from 'miniflare';
import { issueAndPersistSensitiveActionGrant } from '../src/server/mutations/grants';
import { computePayloadHash } from '../src/server/mutations/canonical';
import { executeAtomicMutation } from './support/atomic-executor-fixture';
import {
  executeProtectedPermissionMutation,
  type PermissionMutationOperation,
} from '../src/server/mutations/internal/protected-permission-executor';
import { generateIdentityBoundCsrfToken } from '../src/server/security/csrf';
import { registerProtectedPermissionMutationRoute } from '../src/server/mutations/protected-route';
import { OptimisticConcurrencyError } from '../src/server/db/optimistic';
import { evaluateAuthorization } from '../src/server/auth/authorization';
import type { AuthenticatedUserContext } from '../src/server/auth/identity';

const { Miniflare, convertV4MiniflareOptions } = miniflare;
const rootDir = resolve(__dirname, '..');
const CSRF_SECRET = 'mutation-d1-integration-secret-32-chars';

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
          UPGRADE_DB: '00000000-0000-0000-0000-000000000002',
          CONFLICT_UPGRADE_DB: '00000000-0000-0000-0000-000000000003',
        },
      }),
    );
    db = await mf.getD1Database('DB');

    // Run migrations 0000, 0001, 0002, 0003 sequentially
    const m0 = readFileSync(resolve(rootDir, 'db/migrations/0000_good_hammerhead.sql'), 'utf8');
    const m1 = readFileSync(
      resolve(rootDir, 'db/migrations/0001_chunky_blazing_skull.sql'),
      'utf8',
    );
    const m2 = readFileSync(resolve(rootDir, 'db/migrations/0002_productive_arclight.sql'), 'utf8');
    const m3 = readFileSync(resolve(rootDir, 'db/migrations/0003_lonely_zzzax.sql'), 'utf8');

    for (const sql of [m0, m1, m2, m3]) {
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

  async function createProtectedRequest(subject: string): Promise<Request> {
    const csrfToken = await generateIdentityBoundCsrfToken({ subject }, CSRF_SECRET);
    return new Request('https://panel.mayisigorta.com/api/permission', {
      method: 'POST',
      headers: { 'x-csrf-token': csrfToken },
    });
  }

  async function seedRecoveryOwner(prefix: string, agencyId: string): Promise<void> {
    const userId = `${prefix}-recovery-user`;
    const membershipId = `${prefix}-recovery-mem`;
    await db
      .prepare("INSERT INTO users (id, status, version) VALUES (?, 'ACTIVE', 1)")
      .bind(userId)
      .run();
    await db
      .prepare(
        `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
         VALUES (?, ?, 'https://synthetic.cloudflareaccess.com', ?, ?, 'ACTIVE')`,
      )
      .bind(
        `${prefix}-recovery-ident`,
        userId,
        `${prefix}-recovery-sub`,
        `${prefix}-recovery@example.test`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO agency_memberships (
           id, agency_id, user_id, type, status, invitation_email, invitation_expires_at,
           activated_at, version, permission_version
         ) VALUES (?, ?, ?, 'OWNER', 'ACTIVE', ?, '2099-01-01T00:00:00.000Z',
           '2026-09-17T00:00:00.000Z', 1, 1)`,
      )
      .bind(membershipId, agencyId, userId, `${prefix}-recovery@example.test`)
      .run();
  }

  async function seedTargetMember(prefix: string, agencyId: string) {
    const userId = `${prefix}-target-user`;
    const membershipId = `${prefix}-target-mem`;
    await db
      .prepare("INSERT INTO users (id, status, version) VALUES (?, 'ACTIVE', 1)")
      .bind(userId)
      .run();
    await db
      .prepare(
        `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
         VALUES (?, ?, 'https://synthetic.cloudflareaccess.com', ?, ?, 'ACTIVE')`,
      )
      .bind(
        `${prefix}-target-ident`,
        userId,
        `${prefix}-target-sub`,
        `${prefix}-target@example.test`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO agency_memberships (
           id, agency_id, user_id, type, status, invitation_email, invitation_expires_at,
           activated_at, version, permission_version
         ) VALUES (?, ?, ?, 'MEMBER', 'ACTIVE', ?, '2099-01-01T00:00:00.000Z',
           '2026-09-17T00:00:00.000Z', 1, 1)`,
      )
      .bind(membershipId, agencyId, userId, `${prefix}-target@example.test`)
      .run();
    return { membershipId, permissionVersion: 1 };
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

  it.each([
    {
      name: 'permission_version preflight sonrasında değişirse',
      prefix: 'race-permission-version',
      race: async (actors: Awaited<ReturnType<typeof seedTestActors>>) => {
        await db
          .prepare(
            `UPDATE agency_memberships
             SET permission_version = permission_version + 1, version = version + 1
             WHERE id = ?`,
          )
          .bind(actors.membershipId)
          .run();
      },
    },
    {
      name: 'membership preflight sonrasında SUSPENDED olursa',
      prefix: 'race-membership-status',
      race: async (actors: Awaited<ReturnType<typeof seedTestActors>>) => {
        await db
          .prepare(
            `UPDATE agency_memberships
             SET status = 'SUSPENDED', suspended_at = (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
                 permission_version = permission_version + 1, version = version + 1
             WHERE id = ?`,
          )
          .bind(actors.membershipId)
          .run();
      },
    },
    {
      name: 'User preflight sonrasında INACTIVE olursa',
      prefix: 'race-user-status',
      race: async (actors: Awaited<ReturnType<typeof seedTestActors>>) => {
        await db
          .prepare(
            `UPDATE users
             SET status = 'INACTIVE', version = version + 1
             WHERE id = ?`,
          )
          .bind(actors.userId)
          .run();
      },
    },
  ])(
    '14. Atomic final authority: $name bütün korunan işlemi geri alır',
    async ({ prefix, race }) => {
      const actors = await seedTestActors(prefix);
      await seedRecoveryOwner(prefix, actors.agencyId);
      const target = await seedTargetMember(prefix, actors.agencyId);
      const operation: PermissionMutationOperation = {
        kind: 'GRANT_PERMISSION',
        membershipId: target.membershipId,
        permissionCode: 'customer.read',
        scope: 'ASSIGNED',
        expectedPermissionVersion: target.permissionVersion,
      };
      const payload = { ...operation };
      const payloadHash = await computePayloadHash(payload);
      const { grantToken, grantRecord } = await issueAndPersistSensitiveActionGrant(
        db,
        createSecureContext(actors),
        {
          agencyId: actors.agencyId,
          action: 'permission.grant',
          payloadHash,
          targetIds: [target.membershipId],
          expectedTargetVersion: target.permissionVersion,
        },
      );
      let intercepted = false;
      const racingDb = {
        prepare: db.prepare.bind(db),
        batch: async (statements: D1PreparedStatement[]) => {
          intercepted = true;
          await race(actors);
          return db.batch(statements);
        },
      } as unknown as D1Database;

      await expect(
        executeProtectedPermissionMutation(racingDb, {
          request: await createProtectedRequest(actors.identityId),
          csrfSecret: CSRF_SECRET,
          authenticatedSubject: actors.identityId,
          context: createSecureContext(actors),
          resolveMutation: async () => ({
            agencyId: actors.agencyId,
            correlationId: `${prefix}-correlation`,
            idempotencyKey: `${prefix}-idempotency`,
            grantEvidenceToken: grantToken,
            operation,
          }),
        }),
      ).rejects.toBeInstanceOf(OptimisticConcurrencyError);
      expect(intercepted).toBe(true);

      const grantAfter = await db
        .prepare('SELECT status, consumed_at FROM sensitive_action_grants WHERE id = ?')
        .bind(grantRecord.id)
        .first<{ status: string; consumed_at: string | null }>();
      const businessCount = await db
        .prepare(
          `SELECT count(*) AS count FROM membership_permissions
         WHERE membership_id = ? AND permission_code = 'customer.read'`,
        )
        .bind(target.membershipId)
        .first<{ count: number }>();
      const receiptCount = await db
        .prepare('SELECT count(*) AS count FROM operation_receipts WHERE idempotency_key = ?')
        .bind(`${prefix}-idempotency`)
        .first<{ count: number }>();
      const auditCount = await db
        .prepare('SELECT count(*) AS count FROM audit_events WHERE correlation_id = ?')
        .bind(`${prefix}-correlation`)
        .first<{ count: number }>();

      expect(grantAfter).toEqual({ status: 'ISSUED', consumed_at: null });
      expect(businessCount?.count).toBe(0);
      expect(receiptCount?.count).toBe(0);
      expect(auditCount?.count).toBe(0);
    },
  );

  it('15. Atomic target version: hedef preflight sonrasında değişirse bütün korunan işlemi geri alır', async () => {
    const actors = await seedTestActors('race-target-version');
    const target = await seedTargetMember('race-target-version', actors.agencyId);
    const operation: PermissionMutationOperation = {
      kind: 'GRANT_PERMISSION',
      membershipId: target.membershipId,
      permissionCode: 'customer.read',
      scope: 'ASSIGNED',
      expectedPermissionVersion: 1,
    };
    const payload = { ...operation };
    const payloadHash = await computePayloadHash(payload);
    const { grantToken, grantRecord } = await issueAndPersistSensitiveActionGrant(
      db,
      createSecureContext(actors),
      {
        agencyId: actors.agencyId,
        action: 'permission.grant',
        payloadHash,
        targetIds: [target.membershipId],
        expectedTargetVersion: 1,
      },
    );
    const racingDb = {
      prepare: db.prepare.bind(db),
      batch: async (statements: D1PreparedStatement[]) => {
        await db
          .prepare(
            `UPDATE agency_memberships
             SET version = version + 1, permission_version = permission_version + 1
             WHERE id = ?`,
          )
          .bind(target.membershipId)
          .run();
        return db.batch(statements);
      },
    } as unknown as D1Database;

    await expect(
      executeProtectedPermissionMutation(racingDb, {
        request: await createProtectedRequest(actors.identityId),
        csrfSecret: CSRF_SECRET,
        authenticatedSubject: actors.identityId,
        context: createSecureContext(actors),
        resolveMutation: async () => ({
          agencyId: actors.agencyId,
          correlationId: 'race-target-version-correlation',
          idempotencyKey: 'race-target-version-idempotency',
          grantEvidenceToken: grantToken,
          operation,
        }),
      }),
    ).rejects.toBeInstanceOf(OptimisticConcurrencyError);

    const grantAfter = await db
      .prepare('SELECT status, consumed_at FROM sensitive_action_grants WHERE id = ?')
      .bind(grantRecord.id)
      .first<{ status: string; consumed_at: string | null }>();
    const receiptCount = await db
      .prepare('SELECT count(*) AS count FROM operation_receipts WHERE idempotency_key = ?')
      .bind('race-target-version-idempotency')
      .first<{ count: number }>();
    const businessCount = await db
      .prepare(
        `SELECT count(*) AS count FROM membership_permissions
         WHERE membership_id = ? AND permission_code = 'customer.read'`,
      )
      .bind(target.membershipId)
      .first<{ count: number }>();
    const auditCount = await db
      .prepare('SELECT count(*) AS count FROM audit_events WHERE correlation_id = ?')
      .bind('race-target-version-correlation')
      .first<{ count: number }>();

    expect(grantAfter).toEqual({ status: 'ISSUED', consumed_at: null });
    expect(businessCount?.count).toBe(0);
    expect(receiptCount?.count).toBe(0);
    expect(auditCount?.count).toBe(0);
  });

  it('16. Korumalı permission grant intent/action/payload/target bağını korur ve atomik başarı kaydeder', async () => {
    const actors = await seedTestActors('protected-grant');
    const target = await seedTargetMember('protected-grant', actors.agencyId);
    const operation: PermissionMutationOperation = {
      kind: 'GRANT_PERMISSION',
      membershipId: target.membershipId,
      permissionCode: 'customer.read',
      scope: 'ASSIGNED',
      expectedPermissionVersion: 1,
    };
    const payloadHash = await computePayloadHash({ ...operation });
    const { grantToken, grantRecord } = await issueAndPersistSensitiveActionGrant(
      db,
      createSecureContext(actors),
      {
        agencyId: actors.agencyId,
        action: 'permission.grant',
        payloadHash,
        targetIds: [target.membershipId],
        expectedTargetVersion: 1,
      },
    );
    const mismatches: PermissionMutationOperation[] = [
      { ...operation, kind: 'REVOKE_PERMISSION' },
      { ...operation, scope: 'AGENCY' },
      { ...operation, membershipId: `${target.membershipId}-wrong` },
      { ...operation, expectedPermissionVersion: 2 },
    ];
    for (const mismatch of mismatches) {
      const request = await createProtectedRequest(actors.identityId);
      await expect(
        executeProtectedPermissionMutation(db, {
          request,
          csrfSecret: CSRF_SECRET,
          authenticatedSubject: actors.identityId,
          context: createSecureContext(actors),
          resolveMutation: async () => ({
            agencyId: actors.agencyId,
            correlationId: 'protected-grant-correlation',
            idempotencyKey: 'protected-grant-idempotency',
            grantEvidenceToken: grantToken,
            operation: mismatch,
          }),
        }),
      ).rejects.toThrow();
    }

    const result = await executeProtectedPermissionMutation(db, {
      request: await createProtectedRequest(actors.identityId),
      csrfSecret: CSRF_SECRET,
      authenticatedSubject: actors.identityId,
      context: createSecureContext(actors),
      resolveMutation: async () => ({
        agencyId: actors.agencyId,
        correlationId: 'protected-grant-correlation',
        idempotencyKey: 'protected-grant-idempotency',
        grantEvidenceToken: grantToken,
        operation,
      }),
    });
    expect(result).toMatchObject({ executed: true, replayed: false, status: 200 });

    const replay = await executeProtectedPermissionMutation(db, {
      request: await createProtectedRequest(actors.identityId),
      csrfSecret: CSRF_SECRET,
      authenticatedSubject: actors.identityId,
      context: createSecureContext(actors),
      resolveMutation: async () => ({
        agencyId: actors.agencyId,
        correlationId: 'protected-grant-retry-correlation',
        idempotencyKey: 'protected-grant-idempotency',
        grantEvidenceToken: grantToken,
        operation,
      }),
    });
    expect(replay).toEqual({
      executed: false,
      replayed: true,
      status: 200,
      body: result.body,
    });

    await expect(
      executeProtectedPermissionMutation(db, {
        request: await createProtectedRequest(actors.identityId),
        csrfSecret: CSRF_SECRET,
        authenticatedSubject: actors.identityId,
        context: createSecureContext(actors),
        resolveMutation: async () => ({
          agencyId: actors.agencyId,
          correlationId: 'protected-grant-payload-conflict',
          idempotencyKey: 'protected-grant-idempotency',
          grantEvidenceToken: grantToken,
          operation: { ...operation, scope: 'AGENCY' },
        }),
      }),
    ).rejects.toThrow('IDEMPOTENCY_PAYLOAD_MISMATCH');

    await expect(
      executeProtectedPermissionMutation(db, {
        request: await createProtectedRequest(actors.identityId),
        csrfSecret: CSRF_SECRET,
        authenticatedSubject: actors.identityId,
        context: createSecureContext(actors),
        resolveMutation: async () => ({
          agencyId: actors.agencyId,
          correlationId: 'protected-grant-action-conflict',
          idempotencyKey: 'protected-grant-idempotency',
          grantEvidenceToken: grantToken,
          operation: { ...operation, kind: 'REVOKE_PERMISSION' },
        }),
      }),
    ).rejects.toThrow('IDEMPOTENCY_ACTION_MISMATCH');

    const wrongActorContext = {
      ...createSecureContext(actors),
      userId: `${actors.userId}-wrong`,
    };
    await expect(
      executeProtectedPermissionMutation(db, {
        request: await createProtectedRequest(actors.identityId),
        csrfSecret: CSRF_SECRET,
        authenticatedSubject: actors.identityId,
        context: wrongActorContext,
        resolveMutation: async () => ({
          agencyId: actors.agencyId,
          correlationId: 'protected-grant-actor-reuse',
          idempotencyKey: 'protected-grant-idempotency',
          grantEvidenceToken: grantToken,
          operation,
        }),
      }),
    ).rejects.toThrow();

    const wrongMembershipContext = {
      ...createSecureContext(actors),
      memberships: createSecureContext(actors).memberships.map((membership) => ({
        ...membership,
        id: `${membership.id}-wrong`,
      })),
    };
    await expect(
      executeProtectedPermissionMutation(db, {
        request: await createProtectedRequest(actors.identityId),
        csrfSecret: CSRF_SECRET,
        authenticatedSubject: actors.identityId,
        context: wrongMembershipContext,
        resolveMutation: async () => ({
          agencyId: actors.agencyId,
          correlationId: 'protected-grant-membership-reuse',
          idempotencyKey: 'protected-grant-idempotency',
          grantEvidenceToken: grantToken,
          operation,
        }),
      }),
    ).rejects.toThrow();

    await expect(
      executeProtectedPermissionMutation(db, {
        request: await createProtectedRequest(actors.identityId),
        csrfSecret: CSRF_SECRET,
        authenticatedSubject: actors.identityId,
        context: createSecureContext(actors),
        resolveMutation: async () => ({
          agencyId: `${actors.agencyId}-wrong`,
          correlationId: 'protected-grant-agency-reuse',
          idempotencyKey: 'protected-grant-idempotency',
          grantEvidenceToken: grantToken,
          operation,
        }),
      }),
    ).rejects.toThrow();

    const grantAfter = await db
      .prepare('SELECT status, consumed_operation_id FROM sensitive_action_grants WHERE id = ?')
      .bind(grantRecord.id)
      .first<{ status: string; consumed_operation_id: string | null }>();
    const businessRow = await db
      .prepare(
        `SELECT scope FROM membership_permissions
         WHERE membership_id = ? AND permission_code = 'customer.read'`,
      )
      .bind(target.membershipId)
      .first<{ scope: string }>();
    const receiptCount = await db
      .prepare('SELECT count(*) AS count FROM operation_receipts WHERE idempotency_key = ?')
      .bind('protected-grant-idempotency')
      .first<{ count: number }>();
    const auditCount = await db
      .prepare('SELECT count(*) AS count FROM audit_events WHERE correlation_id = ?')
      .bind('protected-grant-correlation')
      .first<{ count: number }>();

    expect(grantAfter).toEqual({
      status: 'CONSUMED',
      consumed_operation_id: 'protected-grant-correlation',
    });
    expect(businessRow).toEqual({ scope: 'ASSIGNED' });
    expect(receiptCount?.count).toBe(1);
    expect(auditCount?.count).toBe(1);
  });

  it('17. Desteklenen protected route internal executor üzerinden tek etkili mutasyon çalıştırır', async () => {
    const actors = await seedTestActors('protected-route-success');
    const target = await seedTargetMember('protected-route-success', actors.agencyId);
    const operation: PermissionMutationOperation = {
      kind: 'GRANT_PERMISSION',
      membershipId: target.membershipId,
      permissionCode: 'customer.read',
      scope: 'ASSIGNED',
      expectedPermissionVersion: 1,
    };
    const { grantToken } = await issueAndPersistSensitiveActionGrant(
      db,
      createSecureContext(actors),
      {
        agencyId: actors.agencyId,
        action: 'permission.grant',
        payloadHash: await computePayloadHash({ ...operation }),
        targetIds: [target.membershipId],
        expectedTargetVersion: 1,
      },
    );
    const app = new Hono<{ Bindings: { DB: D1Database } }>();
    registerProtectedPermissionMutationRoute(app, {
      method: 'POST',
      path: '/secure/api/permission',
      authenticate: async () => ({
        context: createSecureContext(actors),
        subject: actors.identityId,
      }),
      resolveCsrfSecret: () => CSRF_SECRET,
      parseRequest: async (context) => context.req.json(),
    });
    const csrfToken = await generateIdentityBoundCsrfToken(
      { subject: actors.identityId },
      CSRF_SECRET,
    );
    const requestBody = {
      agencyId: actors.agencyId,
      correlationId: 'protected-route-success-correlation',
      idempotencyKey: 'protected-route-success-idempotency',
      grantEvidenceToken: grantToken,
      operation,
    };
    const send = () =>
      app.request(
        'https://panel.mayisigorta.com/secure/api/permission',
        {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin: 'https://panel.mayisigorta.com',
            'sec-fetch-site': 'same-origin',
            'sec-fetch-mode': 'cors',
            'x-csrf-token': csrfToken,
          },
          body: JSON.stringify(requestBody),
        },
        { DB: db },
      );
    const responses = await Promise.all([send(), send()]);
    const responseBodies = await Promise.all(
      responses.map((response) =>
        response.json<{
          success: boolean;
          replayed: boolean;
          data: Readonly<Record<string, string | number>>;
        }>(),
      ),
    );

    expect(responses.map((response) => response.status)).toEqual([200, 200]);
    expect(responseBodies.every((body) => body.success)).toBe(true);
    expect(responseBodies.filter((body) => body.replayed)).toHaveLength(1);
    expect(responseBodies[0]?.data).toMatchObject({
      membershipId: target.membershipId,
      permissionCode: 'customer.read',
      scope: 'ASSIGNED',
      newPermissionVersion: 2,
    });
    const businessCount = await db
      .prepare(
        `SELECT count(*) AS count FROM membership_permissions
         WHERE membership_id = ? AND permission_code = 'customer.read'`,
      )
      .bind(target.membershipId)
      .first<{ count: number }>();
    expect(businessCount?.count).toBe(1);
    const receiptCount = await db
      .prepare('SELECT count(*) AS count FROM operation_receipts WHERE idempotency_key = ?')
      .bind('protected-route-success-idempotency')
      .first<{ count: number }>();
    const auditCount = await db
      .prepare('SELECT count(*) AS count FROM audit_events WHERE idempotency_key = ?')
      .bind('protected-route-success-idempotency')
      .first<{ count: number }>();
    expect(receiptCount?.count).toBe(1);
    expect(auditCount?.count).toBe(1);
  });

  it('18. Eşzamanlı aynı scope/key farklı action işlemlerinden yalnız biri anahtarı sahiplenir', async () => {
    const actors = await seedTestActors('different-action-race');
    const grantTarget = await seedTargetMember('different-action-race-grant', actors.agencyId);
    const revokeTarget = await seedTargetMember('different-action-race-revoke', actors.agencyId);
    await db
      .prepare(
        `INSERT INTO membership_permissions (
           id, membership_id, permission_code, scope
         ) VALUES (?, ?, 'customer.read', 'ASSIGNED')`,
      )
      .bind(crypto.randomUUID(), revokeTarget.membershipId)
      .run();

    const grantOperation: PermissionMutationOperation = {
      kind: 'GRANT_PERMISSION',
      membershipId: grantTarget.membershipId,
      permissionCode: 'customer.read',
      scope: 'ASSIGNED',
      expectedPermissionVersion: 1,
    };
    const revokeOperation: PermissionMutationOperation = {
      kind: 'REVOKE_PERMISSION',
      membershipId: revokeTarget.membershipId,
      permissionCode: 'customer.read',
      expectedPermissionVersion: 1,
    };
    const [{ grantToken: grantToken }, { grantToken: revokeToken }] = await Promise.all([
      issueAndPersistSensitiveActionGrant(db, createSecureContext(actors), {
        agencyId: actors.agencyId,
        action: 'permission.grant',
        payloadHash: await computePayloadHash({ ...grantOperation }),
        targetIds: [grantTarget.membershipId],
        expectedTargetVersion: 1,
      }),
      issueAndPersistSensitiveActionGrant(db, createSecureContext(actors), {
        agencyId: actors.agencyId,
        action: 'permission.revoke',
        payloadHash: await computePayloadHash({ ...revokeOperation }),
        targetIds: [revokeTarget.membershipId],
        expectedTargetVersion: 1,
      }),
    ]);
    const idempotencyKey = 'different-action-race-key';
    const execute = async (
      operation: PermissionMutationOperation,
      grantEvidenceToken: string,
      correlationId: string,
    ) =>
      executeProtectedPermissionMutation(db, {
        request: await createProtectedRequest(actors.identityId),
        csrfSecret: CSRF_SECRET,
        authenticatedSubject: actors.identityId,
        context: createSecureContext(actors),
        resolveMutation: async () => ({
          agencyId: actors.agencyId,
          correlationId,
          idempotencyKey,
          grantEvidenceToken,
          operation,
        }),
      });

    const outcomes = await Promise.allSettled([
      execute(grantOperation, grantToken, 'different-action-race-grant-correlation'),
      execute(revokeOperation, revokeToken, 'different-action-race-revoke-correlation'),
    ]);
    const fulfilled = outcomes.filter(
      (outcome): outcome is PromiseFulfilledResult<Awaited<ReturnType<typeof execute>>> =>
        outcome.status === 'fulfilled',
    );
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({
      name: 'IdempotencyConflictError',
      code: 'IDEMPOTENCY_ACTION_MISMATCH',
    });

    const receipts = await db
      .prepare(
        `SELECT action, status FROM operation_receipts
         WHERE agency_id = ? AND actor_user_id = ? AND actor_membership_id = ?
           AND idempotency_key = ?`,
      )
      .bind(actors.agencyId, actors.userId, actors.membershipId, idempotencyKey)
      .all<{ action: string; status: string }>();
    const auditCount = await db
      .prepare('SELECT count(*) AS count FROM audit_events WHERE idempotency_key = ?')
      .bind(idempotencyKey)
      .first<{ count: number }>();
    const consumedGrantCount = await db
      .prepare(
        `SELECT count(*) AS count FROM sensitive_action_grants
         WHERE id IN (
           SELECT id FROM sensitive_action_grants
           WHERE actor_membership_id = ? AND action IN ('permission.grant', 'permission.revoke')
         ) AND status = 'CONSUMED'`,
      )
      .bind(actors.membershipId)
      .first<{ count: number }>();
    const businessRows = await db
      .prepare(
        `SELECT membership_id FROM membership_permissions
         WHERE permission_code = 'customer.read' AND membership_id IN (?, ?)
         ORDER BY membership_id`,
      )
      .bind(grantTarget.membershipId, revokeTarget.membershipId)
      .all<{ membership_id: string }>();

    expect(receipts.results).toHaveLength(1);
    expect(receipts.results[0]?.status).toBe('COMPLETED');
    expect(auditCount?.count).toBe(1);
    expect(consumedGrantCount?.count).toBe(1);
    if (receipts.results[0]?.action === 'permission.grant') {
      expect(businessRows.results.map((row) => row.membership_id)).toEqual([
        grantTarget.membershipId,
        revokeTarget.membershipId,
      ]);
    } else {
      expect(receipts.results[0]?.action).toBe('permission.revoke');
      expect(businessRows.results).toEqual([]);
    }
  });

  it('19. Eşzamanlı aynı scope/key farklı target payload işlemlerinden yalnız biri çalışır', async () => {
    const actors = await seedTestActors('different-payload-race');
    const firstTarget = await seedTargetMember('different-payload-race-first', actors.agencyId);
    const secondTarget = await seedTargetMember('different-payload-race-second', actors.agencyId);
    const operations: PermissionMutationOperation[] = [firstTarget, secondTarget].map((target) => ({
      kind: 'GRANT_PERMISSION',
      membershipId: target.membershipId,
      permissionCode: 'customer.read',
      scope: 'ASSIGNED',
      expectedPermissionVersion: 1,
    }));
    const grants = await Promise.all(
      operations.map(async (operation) =>
        issueAndPersistSensitiveActionGrant(db, createSecureContext(actors), {
          agencyId: actors.agencyId,
          action: 'permission.grant',
          payloadHash: await computePayloadHash({ ...operation }),
          targetIds: [operation.membershipId],
          expectedTargetVersion: operation.expectedPermissionVersion,
        }),
      ),
    );
    const idempotencyKey = 'different-payload-race-key';
    const execute = async (index: number) => {
      const operation = operations[index]!;
      return executeProtectedPermissionMutation(db, {
        request: await createProtectedRequest(actors.identityId),
        csrfSecret: CSRF_SECRET,
        authenticatedSubject: actors.identityId,
        context: createSecureContext(actors),
        resolveMutation: async () => ({
          agencyId: actors.agencyId,
          correlationId: `different-payload-race-${index}`,
          idempotencyKey,
          grantEvidenceToken: grants[index]!.grantToken,
          operation,
        }),
      });
    };

    const outcomes = await Promise.allSettled([execute(0), execute(1)]);
    const fulfilled = outcomes.filter((outcome) => outcome.status === 'fulfilled');
    const rejected = outcomes.filter(
      (outcome): outcome is PromiseRejectedResult => outcome.status === 'rejected',
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toMatchObject({
      name: 'IdempotencyConflictError',
      code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
    });

    const receipt = await db
      .prepare(
        `SELECT response_body FROM operation_receipts
         WHERE agency_id = ? AND actor_user_id = ? AND actor_membership_id = ?
           AND idempotency_key = ?`,
      )
      .bind(actors.agencyId, actors.userId, actors.membershipId, idempotencyKey)
      .first<{ response_body: string }>();
    const auditCount = await db
      .prepare('SELECT count(*) AS count FROM audit_events WHERE idempotency_key = ?')
      .bind(idempotencyKey)
      .first<{ count: number }>();
    const consumedGrantCount = await db
      .prepare(
        `SELECT count(*) AS count FROM sensitive_action_grants
         WHERE actor_membership_id = ? AND action = 'permission.grant'
           AND status = 'CONSUMED' AND id IN (?, ?)`,
      )
      .bind(actors.membershipId, grants[0]!.grantRecord.id, grants[1]!.grantRecord.id)
      .first<{ count: number }>();
    const businessRows = await db
      .prepare(
        `SELECT membership_id FROM membership_permissions
         WHERE permission_code = 'customer.read' AND membership_id IN (?, ?)`,
      )
      .bind(firstTarget.membershipId, secondTarget.membershipId)
      .all<{ membership_id: string }>();
    const winner = JSON.parse(receipt?.response_body ?? '{}') as { membershipId?: string };

    expect(receipt).not.toBeNull();
    expect(auditCount?.count).toBe(1);
    expect(consumedGrantCount?.count).toBe(1);
    expect(businessRows.results).toEqual([{ membership_id: winner.membershipId }]);
  });

  it('20. Mevcut 0000/0001/0002 verisini koruyarak 0003 idempotency namespace şemasına yükseltir', async () => {
    const upgradeDb = await mf.getD1Database('UPGRADE_DB');
    const migrationPaths = [
      'db/migrations/0000_good_hammerhead.sql',
      'db/migrations/0001_chunky_blazing_skull.sql',
    ];
    for (const migrationPath of migrationPaths) {
      const sql = readFileSync(resolve(rootDir, migrationPath), 'utf8');
      for (const statement of sql
        .split('--> statement-breakpoint')
        .map((item) => item.trim())
        .filter(Boolean)) {
        await upgradeDb.prepare(statement).run();
      }
    }
    await upgradeDb
      .prepare(
        "INSERT INTO agencies (id, status, version) VALUES ('upgrade-agency', 'PROVISIONING', 7)",
      )
      .run();

    const migration2 = readFileSync(
      resolve(rootDir, 'db/migrations/0002_productive_arclight.sql'),
      'utf8',
    );
    for (const statement of migration2
      .split('--> statement-breakpoint')
      .map((item) => item.trim())
      .filter(Boolean)) {
      await upgradeDb.prepare(statement).run();
    }

    await upgradeDb
      .prepare("INSERT INTO users (id, status, version) VALUES ('upgrade-user', 'INACTIVE', 1)")
      .run();
    await upgradeDb
      .prepare(
        `INSERT INTO agency_memberships (
           id, agency_id, user_id, type, status, invitation_email, invitation_expires_at,
           version, permission_version
         ) VALUES (
           'upgrade-membership', 'upgrade-agency', 'upgrade-user', 'OWNER', 'INVITED',
           'upgrade@example.test', '2099-01-01T00:00:00.000Z', 1, 1
         )`,
      )
      .run();
    await upgradeDb
      .prepare(
        `INSERT INTO operation_receipts (
           id, agency_id, actor_user_id, actor_membership_id, action,
           idempotency_key, payload_fingerprint, status, response_status, response_body
         ) VALUES (
           'upgrade-receipt', 'upgrade-agency', 'upgrade-user', 'upgrade-membership',
           'permission.grant', 'upgrade-key', 'upgrade-fingerprint', 'COMPLETED', 200, '{}'
         )`,
      )
      .run();

    const migration3 = readFileSync(
      resolve(rootDir, 'db/migrations/0003_lonely_zzzax.sql'),
      'utf8',
    );
    const migration3Statements = migration3
      .split('--> statement-breakpoint')
      .map((item) => item.trim())
      .filter(Boolean);
    for (const statement of migration3Statements) {
      await upgradeDb.prepare(statement).run();
    }
    for (const statement of migration3Statements) {
      await upgradeDb.prepare(statement).run();
    }

    const preservedAgency = await upgradeDb
      .prepare("SELECT id, status, version FROM agencies WHERE id = 'upgrade-agency'")
      .first<{ id: string; status: string; version: number }>();
    const securityObjects = await upgradeDb
      .prepare(
        `SELECT type, name FROM sqlite_master
         WHERE name IN (
           'audit_events_no_update',
           'operation_receipts_update_guard',
           'sensitive_action_grants_update_guard',
           'sensitive_action_grants'
         )
         ORDER BY name`,
      )
      .all<{ type: string; name: string }>();
    const preservedReceipt = await upgradeDb
      .prepare(
        `SELECT action, idempotency_key, payload_fingerprint, status
         FROM operation_receipts WHERE id = 'upgrade-receipt'`,
      )
      .first<{
        action: string;
        idempotency_key: string;
        payload_fingerprint: string;
        status: string;
      }>();
    const idempotencyIndex = await upgradeDb
      .prepare("PRAGMA index_info('operation_receipts_idem_uq')")
      .all<{ seqno: number; name: string }>();

    expect(preservedAgency).toEqual({
      id: 'upgrade-agency',
      status: 'PROVISIONING',
      version: 7,
    });
    expect(preservedReceipt).toEqual({
      action: 'permission.grant',
      idempotency_key: 'upgrade-key',
      payload_fingerprint: 'upgrade-fingerprint',
      status: 'COMPLETED',
    });
    expect(idempotencyIndex.results.map((column) => column.name)).toEqual([
      'agency_id',
      'actor_user_id',
      'actor_membership_id',
      'idempotency_key',
    ]);
    expect(securityObjects.results).toEqual([
      { type: 'trigger', name: 'audit_events_no_update' },
      { type: 'trigger', name: 'operation_receipts_update_guard' },
      { type: 'table', name: 'sensitive_action_grants' },
      { type: 'trigger', name: 'sensitive_action_grants_update_guard' },
    ]);
  });

  it('21. 0003 eski cross-action duplicate key verisini silmeden atomik olarak reddeder', async () => {
    const conflictDb = await mf.getD1Database('CONFLICT_UPGRADE_DB');
    for (const migrationPath of [
      'db/migrations/0000_good_hammerhead.sql',
      'db/migrations/0001_chunky_blazing_skull.sql',
      'db/migrations/0002_productive_arclight.sql',
    ]) {
      const sql = readFileSync(resolve(rootDir, migrationPath), 'utf8');
      for (const statement of sql
        .split('--> statement-breakpoint')
        .map((item) => item.trim())
        .filter(Boolean)) {
        await conflictDb.prepare(statement).run();
      }
    }
    await conflictDb
      .prepare(
        "INSERT INTO agencies (id, status, version) VALUES ('conflict-agency', 'PROVISIONING', 1)",
      )
      .run();
    await conflictDb
      .prepare("INSERT INTO users (id, status, version) VALUES ('conflict-user', 'INACTIVE', 1)")
      .run();
    await conflictDb
      .prepare(
        `INSERT INTO agency_memberships (
           id, agency_id, user_id, type, status, invitation_email, invitation_expires_at,
           version, permission_version
         ) VALUES (
           'conflict-membership', 'conflict-agency', 'conflict-user', 'OWNER', 'INVITED',
           'conflict@example.test', '2099-01-01T00:00:00.000Z', 1, 1
         )`,
      )
      .run();
    for (const [id, action, fingerprint] of [
      ['conflict-receipt-grant', 'permission.grant', 'grant-fingerprint'],
      ['conflict-receipt-revoke', 'permission.revoke', 'revoke-fingerprint'],
    ]) {
      await conflictDb
        .prepare(
          `INSERT INTO operation_receipts (
             id, agency_id, actor_user_id, actor_membership_id, action,
             idempotency_key, payload_fingerprint, status, response_status, response_body
           ) VALUES (?, 'conflict-agency', 'conflict-user', 'conflict-membership', ?,
             'duplicate-key', ?, 'COMPLETED', 200, '{}')`,
        )
        .bind(id, action, fingerprint)
        .run();
    }

    const migration3Statements = readFileSync(
      resolve(rootDir, 'db/migrations/0003_lonely_zzzax.sql'),
      'utf8',
    )
      .split('--> statement-breakpoint')
      .map((item) => item.trim())
      .filter(Boolean)
      .map((statement) => conflictDb.prepare(statement));
    await expect(conflictDb.batch(migration3Statements)).rejects.toThrow();

    const preservedRows = await conflictDb
      .prepare(
        `SELECT id, action FROM operation_receipts
         WHERE idempotency_key = 'duplicate-key' ORDER BY action`,
      )
      .all<{ id: string; action: string }>();
    const preservedIndex = await conflictDb
      .prepare("PRAGMA index_info('operation_receipts_idem_uq')")
      .all<{ name: string }>();
    expect(preservedRows.results).toEqual([
      { id: 'conflict-receipt-grant', action: 'permission.grant' },
      { id: 'conflict-receipt-revoke', action: 'permission.revoke' },
    ]);
    expect(preservedIndex.results.map((column) => column.name)).toEqual([
      'agency_id',
      'actor_user_id',
      'actor_membership_id',
      'action',
      'idempotency_key',
    ]);
  });
});
