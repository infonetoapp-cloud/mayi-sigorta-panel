// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import miniflare from 'miniflare';
import {
  executeCustomerDomainCommand,
  DomainConstraintViolationError,
} from '../src/server/mutations/internal/customer-domain-executor';
import { OptimisticConcurrencyError } from '../src/server/db/optimistic';
import { IdempotencyConflictError } from '../src/server/mutations/idempotency';
import { computePayloadHash } from '../src/server/mutations/canonical';
import { createCustomer } from '../src/server/customers/service';
import type { AuthenticatedUserContext } from '../src/server/auth/identity';

const { Miniflare, convertV4MiniflareOptions } = miniflare;
const rootDir = resolve(__dirname, '..');

describe('M2-T02 Customer Domain Mutations (Identity, Assign, External Reference) on Real D1', () => {
  let mf: miniflare.Miniflare;
  let db: D1Database;

  const AGENCY_ID = 'ag-m2-t02-dom';
  const OTHER_AGENCY_ID = 'ag-m2-t02-other';

  const OWNER_USER_ID = 'usr-m2t02-owner';
  const OWNER_MEM_ID = 'mem-m2t02-owner';

  const MEMBER_A_USER_ID = 'usr-m2t02-mem-a';
  const MEMBER_A_MEM_ID = 'mem-m2t02-mem-a';

  const MEMBER_B_USER_ID = 'usr-m2t02-mem-b';
  const MEMBER_B_MEM_ID = 'mem-m2t02-mem-b';

  const INACTIVE_USER_ID = 'usr-m2t02-inactive';
  const INACTIVE_MEMBER_ID = 'mem-m2t02-inactive';

  beforeAll(async () => {
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: 'export default { fetch() { return new Response(null); } }',
        d1Databases: {
          DB: '00000000-0000-0000-0000-000000000007',
        },
      }),
    );
    db = await mf.getD1Database('DB');

    // Apply migrations 0000-0005
    for (const file of [
      'db/migrations/0000_good_hammerhead.sql',
      'db/migrations/0001_chunky_blazing_skull.sql',
      'db/migrations/0002_productive_arclight.sql',
      'db/migrations/0003_lonely_zzzax.sql',
      'db/migrations/0004_thankful_pixie.sql',
      'db/migrations/0005_graceful_northstar.sql',
    ]) {
      const sql = readFileSync(resolve(rootDir, file), 'utf8');
      const stmts = sql
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const stmt of stmts) {
        await db.prepare(stmt).run();
      }
    }

    // Helper to seed active agency with owner
    async function seedAgency(agId: string, uId: string, mId: string, email: string) {
      await db
        .prepare("INSERT INTO agencies (id, status, version) VALUES (?, 'PROVISIONING', 1)")
        .bind(agId)
        .run();
      await db
        .prepare("INSERT INTO users (id, status, version) VALUES (?, 'INACTIVE', 1)")
        .bind(uId)
        .run();
      await db
        .prepare(
          `INSERT INTO agency_memberships (
             id, agency_id, user_id, type, status, invitation_email, invitation_expires_at, version, permission_version
           ) VALUES (?, ?, ?, 'OWNER', 'INVITED', ?, '2099-01-01T00:00:00.000Z', 1, 1)`,
        )
        .bind(mId, agId, uId, email)
        .run();
      await db
        .prepare(
          `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
           VALUES (?, ?, 'https://test', ?, ?, 'ACTIVE')`,
        )
        .bind(`ident-${uId}`, uId, `sub-${uId}`, email)
        .run();
      await db
        .prepare("UPDATE users SET status = 'ACTIVE', version = 2 WHERE id = ?")
        .bind(uId)
        .run();
      await db
        .prepare(
          "UPDATE agency_memberships SET status = 'ACTIVE', activated_at = '2026-09-17T00:00:00.000Z', version = 2, permission_version = 2 WHERE id = ?",
        )
        .bind(mId)
        .run();
      await db
        .prepare(
          "UPDATE agencies SET status = 'ACTIVE', bootstrap_completed_at = '2026-09-17T00:00:00.000Z', activated_at = '2026-09-17T00:00:00.000Z', version = 2 WHERE id = ?",
        )
        .bind(agId)
        .run();
    }

    // Seed primary and other agencies
    await seedAgency(AGENCY_ID, OWNER_USER_ID, OWNER_MEM_ID, 'owner-m2t02@test.com');
    await seedAgency(OTHER_AGENCY_ID, 'usr-other-owner', 'mem-other-owner', 'other-owner@test.com');

    // Seed Member A
    await db
      .prepare("INSERT INTO users (id, status, version) VALUES (?, 'ACTIVE', 1)")
      .bind(MEMBER_A_USER_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO agency_memberships (
           id, agency_id, user_id, type, status, invitation_email, invitation_expires_at, version, permission_version, activated_at
         ) VALUES (?, ?, ?, 'MEMBER', 'ACTIVE', 'mem-a@test.com', '2099-01-01T00:00:00.000Z', 1, 1, '2026-09-17T00:00:00.000Z')`,
      )
      .bind(MEMBER_A_MEM_ID, AGENCY_ID, MEMBER_A_USER_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
         VALUES ('ident-mem-a', ?, 'https://test', 'sub-mem-a', 'mem-a@test.com', 'ACTIVE')`,
      )
      .bind(MEMBER_A_USER_ID)
      .run();

    // Seed Member B
    await db
      .prepare("INSERT INTO users (id, status, version) VALUES (?, 'ACTIVE', 1)")
      .bind(MEMBER_B_USER_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO agency_memberships (
           id, agency_id, user_id, type, status, invitation_email, invitation_expires_at, version, permission_version, activated_at
         ) VALUES (?, ?, ?, 'MEMBER', 'ACTIVE', 'mem-b@test.com', '2099-01-01T00:00:00.000Z', 1, 1, '2026-09-17T00:00:00.000Z')`,
      )
      .bind(MEMBER_B_MEM_ID, AGENCY_ID, MEMBER_B_USER_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
         VALUES ('ident-mem-b', ?, 'https://test', 'sub-mem-b', 'mem-b@test.com', 'ACTIVE')`,
      )
      .bind(MEMBER_B_USER_ID)
      .run();

    // Seed inactive member
    await db
      .prepare("INSERT INTO users (id, status, version) VALUES (?, 'INACTIVE', 1)")
      .bind(INACTIVE_USER_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO agency_memberships (
           id, agency_id, user_id, type, status, invitation_email, invitation_expires_at, version, permission_version, activated_at, suspended_at
         ) VALUES (?, ?, ?, 'MEMBER', 'SUSPENDED', 'inactive@test.com', '2099-01-01T00:00:00.000Z', 1, 1, '2026-09-17T00:00:00.000Z', '2026-09-18T00:00:00.000Z')`,
      )
      .bind(INACTIVE_MEMBER_ID, AGENCY_ID, INACTIVE_USER_ID)
      .run();

    // Permissions for Member A: customer.read (ASSIGNED), customer.update (ASSIGNED), customer.assign (ASSIGNED)
    for (const [perm, scope] of [
      ['customer.read', 'ASSIGNED'],
      ['customer.update', 'ASSIGNED'],
      ['customer.assign', 'ASSIGNED'],
      ['sensitive.identity.read', 'UNSCOPED'],
      ['sensitive.identity.write', 'UNSCOPED'],
    ]) {
      await db
        .prepare(
          'INSERT INTO membership_permissions (id, membership_id, permission_code, scope) VALUES (?, ?, ?, ?)',
        )
        .bind(crypto.randomUUID(), MEMBER_A_MEM_ID, perm, scope)
        .run();
    }

    // Permissions for Member B: customer.read (ASSIGNED), customer.update (ASSIGNED)
    for (const [perm, scope] of [
      ['customer.read', 'ASSIGNED'],
      ['customer.update', 'ASSIGNED'],
    ]) {
      await db
        .prepare(
          'INSERT INTO membership_permissions (id, membership_id, permission_code, scope) VALUES (?, ?, ?, ?)',
        )
        .bind(crypto.randomUUID(), MEMBER_B_MEM_ID, perm, scope)
        .run();
    }

    // Permissions for Owner: sensitive grants
    for (const perm of ['sensitive.identity.read', 'sensitive.identity.write']) {
      await db
        .prepare(
          "INSERT INTO membership_permissions (id, membership_id, permission_code, scope) VALUES (?, ?, ?, 'UNSCOPED')",
        )
        .bind(crypto.randomUUID(), OWNER_MEM_ID, perm)
        .run();
    }
  });

  afterAll(async () => {
    if (mf) await mf.dispose();
  });

  function memberContext(
    userId: string,
    identityId: string,
    membershipId: string,
    permissionVersion = 1,
  ): AuthenticatedUserContext {
    return {
      userId,
      identityId,
      assurance: 'NORMAL',
      memberships: [
        {
          id: membershipId,
          agencyId: AGENCY_ID,
          type: 'MEMBER',
          status: 'ACTIVE',
          permissionVersion,
        },
      ],
    };
  }

  const ownerContext: AuthenticatedUserContext = {
    userId: OWNER_USER_ID,
    identityId: `ident-${OWNER_USER_ID}`,
    assurance: 'NORMAL',
    memberships: [
      {
        id: OWNER_MEM_ID,
        agencyId: AGENCY_ID,
        type: 'OWNER',
        status: 'ACTIVE',
        permissionVersion: 2,
      },
    ],
  };

  it('authorizes customer.create replay against the original live Customer record', async () => {
    const payload = {
      type: 'COMPANY' as const,
      companyTitle: 'Original Create Replay Company',
      email: 'original-create@example.test',
      phone: '+905551112233',
      address: 'Synthetic address',
    };
    const key = 'customer-create-replay-current-target';
    const seedReplayMember = async (suffix: string) => {
      const userId = `replay-create-user-${suffix}`;
      const membershipId = `replay-create-member-${suffix}`;
      const identityId = `replay-create-identity-${suffix}`;
      const email = `replay-create-${suffix}@test.com`;
      await db
        .prepare("INSERT INTO users(id,status,version) VALUES(?,'INACTIVE',1)")
        .bind(userId)
        .run();
      await db
        .prepare(
          "INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at,version,permission_version) VALUES(?,? ,?,'MEMBER','INVITED',?,'2099-01-01T00:00:00.000Z',1,1)",
        )
        .bind(membershipId, AGENCY_ID, userId, email)
        .run();
      await db
        .prepare(
          "INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email,status) VALUES(?,?,?, ?, ?, 'ACTIVE')",
        )
        .bind(identityId, userId, `https://create-replay-${suffix}.test`, `sub-${suffix}`, email)
        .run();
      await db
        .prepare("UPDATE users SET status='ACTIVE',version=version+1 WHERE id=?")
        .bind(userId)
        .run();
      await db
        .prepare(
          "UPDATE agency_memberships SET status='ACTIVE',activated_at='2026-09-17T00:00:00.000Z',version=version+1,permission_version=permission_version+1 WHERE id=?",
        )
        .bind(membershipId)
        .run();
      await db
        .prepare(
          "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,'customer.read','ASSIGNED'),(?,?,'customer.update','ASSIGNED'),(?,?,'customer.create','UNSCOPED')",
        )
        .bind(
          crypto.randomUUID(),
          membershipId,
          crypto.randomUUID(),
          membershipId,
          crypto.randomUUID(),
          membershipId,
        )
        .run();
      return {
        userId,
        membershipId,
        identityId,
        context: memberContext(userId, identityId, membershipId, 2),
      };
    };
    const scopeActor = await seedReplayMember('scope');
    const memberA = scopeActor.context;
    const first = await createCustomer(db, memberA, payload, {
      correlationId: 'create-replay-first',
      idempotencyKey: key,
    });
    const immediateReplay = await createCustomer(db, memberA, payload, {
      correlationId: 'create-replay-immediate',
      idempotencyKey: key,
    });
    expect(immediateReplay).toEqual(first);
    expect(
      (
        await db
          .prepare('SELECT count(*) AS count FROM customers WHERE id = ?')
          .bind(first.id)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS count FROM audit_events WHERE idempotency_key = ? AND outcome = 'SUCCESS'",
          )
          .bind(key)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);

    await db
      .prepare('UPDATE customers SET assignee_membership_id = ? WHERE id = ? AND agency_id = ?')
      .bind(MEMBER_B_MEM_ID, first.id, AGENCY_ID)
      .run();
    expect(
      (
        await db
          .prepare(
            "SELECT scope FROM membership_permissions WHERE membership_id = ? AND permission_code = 'customer.create'",
          )
          .bind(scopeActor.membershipId)
          .first<{ scope: string }>()
      )?.scope,
    ).toBe('UNSCOPED');
    await expect(
      createCustomer(db, memberA, payload, {
        correlationId: 'create-replay-reassigned',
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({ code: 'REPLAY_AUTHORIZATION_DENIED' });

    await db
      .prepare(
        "UPDATE membership_permissions SET scope = 'AGENCY', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE membership_id = ? AND permission_code = 'customer.read'",
      )
      .bind(scopeActor.membershipId)
      .run();
    await db
      .prepare(
        "UPDATE agency_memberships SET permission_version = permission_version + 1, version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND permission_version = 2",
      )
      .bind(scopeActor.membershipId)
      .run();
    const scopeActorAgencyScope = memberContext(
      scopeActor.userId,
      scopeActor.identityId,
      scopeActor.membershipId,
      3,
    );
    const agencyReplay = await createCustomer(db, scopeActorAgencyScope, payload, {
      correlationId: 'create-replay-agency-scope',
      idempotencyKey: key,
    });
    expect(agencyReplay).toEqual(first);

    await db
      .prepare(
        "DELETE FROM membership_permissions WHERE membership_id = ? AND permission_code = 'customer.create'",
      )
      .bind(scopeActor.membershipId)
      .run();
    await db
      .prepare(
        "UPDATE agency_memberships SET permission_version = permission_version + 1, version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ? AND permission_version = 3",
      )
      .bind(scopeActor.membershipId)
      .run();
    await expect(
      createCustomer(
        db,
        memberContext(scopeActor.userId, scopeActor.identityId, scopeActor.membershipId, 4),
        payload,
        { correlationId: 'create-replay-create-permission-revoked', idempotencyKey: key },
      ),
    ).rejects.toThrow();

    const suspendedActor = await seedReplayMember('suspended');
    const suspendedPayload = { type: 'COMPANY' as const, companyTitle: 'Suspended Replay' };
    const suspendedKey = 'customer-create-replay-suspended';
    await createCustomer(db, suspendedActor.context, suspendedPayload, {
      correlationId: 'create-suspended-first',
      idempotencyKey: suspendedKey,
    });
    await db
      .prepare(
        "UPDATE agency_memberships SET status = 'SUSPENDED', suspended_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), permission_version = permission_version + 1, version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      )
      .bind(suspendedActor.membershipId)
      .run();
    await expect(
      createCustomer(db, suspendedActor.context, suspendedPayload, {
        correlationId: 'create-suspended-retry',
        idempotencyKey: suspendedKey,
      }),
    ).rejects.toThrow();

    const identityActor = await seedReplayMember('identity');
    const identityPayload = {
      type: 'COMPANY' as const,
      companyTitle: 'Revoked Identity Replay',
    };
    const identityKey = 'customer-create-replay-revoked-identity';
    await createCustomer(db, identityActor.context, identityPayload, {
      correlationId: 'create-identity-first',
      idempotencyKey: identityKey,
    });
    await db
      .prepare(
        "UPDATE auth_identities SET status = 'REVOKED', revoked_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), version = version + 1, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = ?",
      )
      .bind(identityActor.identityId)
      .run();
    await expect(
      createCustomer(db, identityActor.context, identityPayload, {
        correlationId: 'create-identity-retry',
        idempotencyKey: identityKey,
      }),
    ).rejects.toThrow();
  });

  it('fails closed when a completed customer.create receipt has malformed target evidence', async () => {
    const payload = { type: 'COMPANY' as const, companyTitle: 'Malformed Receipt Probe' };
    const key = 'customer-create-malformed-receipt';
    const fingerprint = await computePayloadHash({
      target: null,
      expectedVersion: null,
      payload,
    });
    await db
      .prepare(
        `INSERT INTO operation_receipts (
           id, agency_id, actor_user_id, actor_membership_id, action, idempotency_key,
           payload_fingerprint, status, response_status, response_body
         ) VALUES (?, ?, ?, ?, 'customer.create', ?, ?, 'COMPLETED', 201, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        AGENCY_ID,
        OWNER_USER_ID,
        OWNER_MEM_ID,
        key,
        fingerprint,
        JSON.stringify({ id: 'not-a-customer-dto', agencyId: AGENCY_ID }),
      )
      .run();

    await expect(
      createCustomer(db, ownerContext, payload, {
        correlationId: 'create-malformed-receipt-retry',
        idempotencyKey: key,
      }),
    ).rejects.toMatchObject({ code: 'REPLAY_AUTHORIZATION_DENIED' });

    const auditlessPayload = {
      type: 'COMPANY' as const,
      companyTitle: 'Auditless Receipt Probe',
    };
    const auditlessKey = 'customer-create-auditless-receipt';
    const auditlessFingerprint = await computePayloadHash({
      target: null,
      expectedVersion: null,
      payload: auditlessPayload,
    });
    const timestamp = new Date().toISOString();
    const auditlessDto = {
      id: 'forged-receipt-target',
      agencyId: AGENCY_ID,
      type: 'COMPANY',
      displayName: 'Auditless Receipt Probe',
      firstName: null,
      lastName: null,
      companyTitle: 'Auditless Receipt Probe',
      email: null,
      phone: null,
      address: null,
      assigneeMembershipId: OWNER_MEM_ID,
      archivedAt: null,
      archivedByMembershipId: null,
      archiveReasonCode: null,
      hasIdentity: false,
      identityMasked: null,
      version: 1,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await db
      .prepare(
        `INSERT INTO operation_receipts (
           id, agency_id, actor_user_id, actor_membership_id, action, idempotency_key,
           payload_fingerprint, status, response_status, response_body
         ) VALUES (?, ?, ?, ?, 'customer.create', ?, ?, 'COMPLETED', 201, ?)`,
      )
      .bind(
        crypto.randomUUID(),
        AGENCY_ID,
        OWNER_USER_ID,
        OWNER_MEM_ID,
        auditlessKey,
        auditlessFingerprint,
        JSON.stringify(auditlessDto),
      )
      .run();
    await expect(
      createCustomer(db, ownerContext, auditlessPayload, {
        correlationId: 'create-auditless-receipt-retry',
        idempotencyKey: auditlessKey,
      }),
    ).rejects.toMatchObject({ code: 'REPLAY_AUTHORIZATION_DENIED' });
  });

  it('concurrent service-level create retries with fresh generated IDs converge on one D1 effect', async () => {
    const payload = { type: 'COMPANY' as const, companyTitle: 'Concurrent Create Replay' };
    const key = 'customer-create-concurrent-service-replay';
    const options = (correlationId: string) => ({ correlationId, idempotencyKey: key });
    const [first, concurrentRetry] = await Promise.all([
      createCustomer(db, ownerContext, payload, options('create-concurrent-a')),
      createCustomer(db, ownerContext, payload, options('create-concurrent-b')),
    ]);
    expect(concurrentRetry).toEqual(first);
    expect(
      (
        await db
          .prepare('SELECT count(*) AS count FROM customers WHERE id = ?')
          .bind(first.id)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
    expect(
      (
        await db
          .prepare(
            "SELECT count(*) AS count FROM audit_events WHERE idempotency_key = ? AND outcome = 'SUCCESS'",
          )
          .bind(key)
          .first<{ count: number }>()
      )?.count,
    ).toBe(1);
  });

  describe('customer.identity.update', () => {
    it('updates customer identity envelope atomically and increments version', async () => {
      const custId = 'cust-id-test-1';
      // Create initial customer assigned to Owner
      await db
        .prepare(
          `INSERT INTO customers (id, agency_id, type, display_name, assignee_membership_id, version)
           VALUES (?, ?, 'INDIVIDUAL', 'Identity Customer', ?, 1)`,
        )
        .bind(custId, AGENCY_ID, OWNER_MEM_ID)
        .run();

      const result = await executeCustomerDomainCommand({
        db,
        agencyId: AGENCY_ID,
        actorUserId: OWNER_USER_ID,
        actorIdentityId: `ident-${OWNER_USER_ID}`,
        actorMembershipId: OWNER_MEM_ID,
        expectedPermissionVersion: 2,
        correlationId: 'corr-id-1',
        idempotencyKey: 'idem-id-1',
        payload: { customerId: custId, identityType: 'TCKN' },
        command: {
          kind: 'customer.identity.update',
          customerId: custId,
          expectedVersion: 1,
          identityType: 'TCKN',
          identityCiphertext: 'cipher-1',
          identityIv: 'iv-12345678',
          identityTag: 'tag-123456789012',
          identitySearchHash: 'hash-123',
          identityKeyVersion: 1,
        },
        resultProducer: () => ({
          status: 200,
          body: { id: custId, hasIdentity: true },
        }),
      });

      expect(result.executed).toBe(true);
      expect(result.replayed).toBe(false);

      // Verify row in DB
      const row = await db
        .prepare(
          'SELECT version, identity_type, identity_ciphertext, identity_search_hash FROM customers WHERE id = ?',
        )
        .bind(custId)
        .first<{
          version: number;
          identity_type: string;
          identity_ciphertext: string;
          identity_search_hash: string;
        }>();

      expect(row?.version).toBe(2);
      expect(row?.identity_type).toBe('TCKN');
      expect(row?.identity_ciphertext).toBe('cipher-1');
      expect(row?.identity_search_hash).toBe('hash-123');

      // Verify idempotency replay
      const replay = await executeCustomerDomainCommand({
        db,
        agencyId: AGENCY_ID,
        actorUserId: OWNER_USER_ID,
        actorIdentityId: `ident-${OWNER_USER_ID}`,
        actorMembershipId: OWNER_MEM_ID,
        expectedPermissionVersion: 2,
        correlationId: 'corr-id-1',
        idempotencyKey: 'idem-id-1',
        payload: { customerId: custId, identityType: 'TCKN' },
        command: {
          kind: 'customer.identity.update',
          customerId: custId,
          expectedVersion: 1,
          identityType: 'TCKN',
          identityCiphertext: 'cipher-1',
          identityIv: 'iv-12345678',
          identityTag: 'tag-123456789012',
          identitySearchHash: 'hash-123',
          identityKeyVersion: 1,
        },
        resultProducer: () => ({
          status: 200,
          body: { id: custId, hasIdentity: true },
        }),
      });

      expect(replay.executed).toBe(false);
      expect(replay.replayed).toBe(true);
      expect(replay.body).toEqual({ id: custId, hasIdentity: true });
    });

    it('clears customer identity safely and sets all envelope fields to null', async () => {
      const custId = 'cust-id-test-clear';
      await db
        .prepare(
          `INSERT INTO customers (
             id, agency_id, type, display_name, assignee_membership_id,
             identity_type, identity_ciphertext, identity_iv, identity_tag, identity_search_hash, identity_key_version, version
           ) VALUES (?, ?, 'COMPANY', 'Company To Clear', ?, 'VKN', 'c', 'iv', 't', 'h', 1, 1)`,
        )
        .bind(custId, AGENCY_ID, OWNER_MEM_ID)
        .run();

      const result = await executeCustomerDomainCommand({
        db,
        agencyId: AGENCY_ID,
        actorUserId: OWNER_USER_ID,
        actorIdentityId: `ident-${OWNER_USER_ID}`,
        actorMembershipId: OWNER_MEM_ID,
        expectedPermissionVersion: 2,
        correlationId: 'corr-clear-1',
        idempotencyKey: 'idem-clear-1',
        payload: { customerId: custId, clear: true },
        command: {
          kind: 'customer.identity.update',
          customerId: custId,
          expectedVersion: 1,
          identityType: null,
          identityCiphertext: null,
          identityIv: null,
          identityTag: null,
          identitySearchHash: null,
          identityKeyVersion: null,
        },
        resultProducer: () => ({
          status: 200,
          body: { id: custId, hasIdentity: false },
        }),
      });

      expect(result.executed).toBe(true);

      const row = await db
        .prepare('SELECT version, identity_type, identity_ciphertext FROM customers WHERE id = ?')
        .bind(custId)
        .first<{
          version: number;
          identity_type: string | null;
          identity_ciphertext: string | null;
        }>();

      expect(row?.version).toBe(2);
      expect(row?.identity_type).toBeNull();
      expect(row?.identity_ciphertext).toBeNull();
    });

    it('rejects stale version CAS with OptimisticConcurrencyError', async () => {
      const custId = 'cust-id-test-cas';
      await db
        .prepare(
          `INSERT INTO customers (id, agency_id, type, display_name, assignee_membership_id, version)
           VALUES (?, ?, 'INDIVIDUAL', 'CAS Customer', ?, 5)`,
        )
        .bind(custId, AGENCY_ID, OWNER_MEM_ID)
        .run();

      await expect(
        executeCustomerDomainCommand({
          db,
          agencyId: AGENCY_ID,
          actorUserId: OWNER_USER_ID,
          actorIdentityId: `ident-${OWNER_USER_ID}`,
          actorMembershipId: OWNER_MEM_ID,
          expectedPermissionVersion: 2,
          correlationId: 'corr-stale-1',
          idempotencyKey: 'idem-stale-1',
          payload: { customerId: custId, expectedVersion: 4 },
          command: {
            kind: 'customer.identity.update',
            customerId: custId,
            expectedVersion: 4, // Stale version! (DB has 5)
            identityType: 'TCKN',
            identityCiphertext: 'c',
            identityIv: 'iv',
            identityTag: 't',
            identitySearchHash: 'h',
            identityKeyVersion: 1,
          },
          resultProducer: () => ({ status: 200, body: {} }),
        }),
      ).rejects.toThrowError(OptimisticConcurrencyError);
    });

    it('rolls back identity business effect, receipt, and audit together when the audit insert fails', async () => {
      const custId = 'cust-identity-audit-rollback';
      const idempotencyKey = 'idem-identity-audit-rollback';
      await db
        .prepare(
          `INSERT INTO customers (id, agency_id, type, display_name, assignee_membership_id, version)
           VALUES (?, ?, 'INDIVIDUAL', 'Identity Rollback Customer', ?, 1)`,
        )
        .bind(custId, AGENCY_ID, OWNER_MEM_ID)
        .run();
      await db
        .prepare(
          `CREATE TRIGGER test_identity_audit_failure
           BEFORE INSERT ON audit_events
           WHEN NEW.idempotency_key = 'idem-identity-audit-rollback'
           BEGIN
             SELECT RAISE(ABORT, 'TEST_IDENTITY_AUDIT_FAILURE');
           END`,
        )
        .run();

      try {
        await expect(
          executeCustomerDomainCommand({
            db,
            agencyId: AGENCY_ID,
            actorUserId: OWNER_USER_ID,
            actorIdentityId: `ident-${OWNER_USER_ID}`,
            actorMembershipId: OWNER_MEM_ID,
            expectedPermissionVersion: 2,
            correlationId: 'corr-identity-audit-rollback',
            idempotencyKey,
            payload: { customerId: custId, expectedVersion: 1, identityType: 'TCKN' },
            command: {
              kind: 'customer.identity.update',
              customerId: custId,
              expectedVersion: 1,
              identityType: 'TCKN',
              identityCiphertext: 'ciphertext-fixture',
              identityIv: '00112233445566778899aabb',
              identityTag: '00112233445566778899aabbccddeeff',
              identitySearchHash: 'identity-search-hash-fixture',
              identityKeyVersion: 1,
            },
            resultProducer: () => ({ status: 200, body: { customerId: custId } }),
          }),
        ).rejects.toThrow('TEST_IDENTITY_AUDIT_FAILURE');
      } finally {
        await db.prepare('DROP TRIGGER IF EXISTS test_identity_audit_failure').run();
      }

      const customer = await db
        .prepare('SELECT version, identity_type, identity_ciphertext FROM customers WHERE id = ?')
        .bind(custId)
        .first<{
          version: number;
          identity_type: string | null;
          identity_ciphertext: string | null;
        }>();
      const receipt = await db
        .prepare('SELECT id FROM operation_receipts WHERE idempotency_key = ?')
        .bind(idempotencyKey)
        .first();
      const audit = await db
        .prepare('SELECT id FROM audit_events WHERE idempotency_key = ?')
        .bind(idempotencyKey)
        .first();
      expect(customer).toEqual({ version: 1, identity_type: null, identity_ciphertext: null });
      expect(receipt).toBeNull();
      expect(audit).toBeNull();
    });
  });

  describe('customer.assign', () => {
    it('reassigns customer to another active member and performs immediate live ASSIGNED scope switch', async () => {
      const custId = 'cust-assign-test-1';
      // Customer is initially assigned to Member A
      await db
        .prepare(
          `INSERT INTO customers (id, agency_id, type, display_name, assignee_membership_id, version)
           VALUES (?, ?, 'INDIVIDUAL', 'Customer Assigned to A', ?, 1)`,
        )
        .bind(custId, AGENCY_ID, MEMBER_A_MEM_ID)
        .run();

      // Member A has customer.assign (ASSIGNED) and customer.read (ASSIGNED) -> Member A can reassign
      const assignResult = await executeCustomerDomainCommand({
        db,
        agencyId: AGENCY_ID,
        actorUserId: MEMBER_A_USER_ID,
        actorIdentityId: 'ident-mem-a',
        actorMembershipId: MEMBER_A_MEM_ID,
        expectedPermissionVersion: 1,
        correlationId: 'corr-assign-1',
        idempotencyKey: 'idem-assign-1',
        payload: { customerId: custId, target: MEMBER_B_MEM_ID },
        command: {
          kind: 'customer.assign',
          customerId: custId,
          expectedVersion: 1,
          targetAssigneeMembershipId: MEMBER_B_MEM_ID,
        },
        resultProducer: () => ({
          status: 200,
          body: { id: custId, assigneeMembershipId: MEMBER_B_MEM_ID },
        }),
      });

      expect(assignResult.executed).toBe(true);

      const custRow = await db
        .prepare('SELECT version, assignee_membership_id FROM customers WHERE id = ?')
        .bind(custId)
        .first<{ version: number; assignee_membership_id: string }>();

      expect(custRow?.version).toBe(2);
      expect(custRow?.assignee_membership_id).toBe(MEMBER_B_MEM_ID);

      await expect(
        executeCustomerDomainCommand({
          db,
          agencyId: AGENCY_ID,
          actorUserId: MEMBER_A_USER_ID,
          actorIdentityId: 'ident-mem-a',
          actorMembershipId: MEMBER_A_MEM_ID,
          expectedPermissionVersion: 1,
          correlationId: 'corr-assign-1-retry',
          idempotencyKey: 'idem-assign-1',
          payload: { customerId: custId, target: MEMBER_B_MEM_ID },
          command: {
            kind: 'customer.assign',
            customerId: custId,
            expectedVersion: 1,
            targetAssigneeMembershipId: MEMBER_B_MEM_ID,
          },
          resultProducer: () => ({
            status: 200,
            body: { id: custId, assigneeMembershipId: MEMBER_B_MEM_ID },
          }),
        }),
      ).rejects.toMatchObject({ code: 'REPLAY_AUTHORIZATION_DENIED' });

      const assignmentEffects = await db
        .prepare(
          "SELECT count(*) AS count FROM audit_events WHERE action = 'customer.assign' AND target_id = ?",
        )
        .bind(custId)
        .first<{ count: number }>();
      expect(assignmentEffects?.count).toBe(1);

      // Verify audit record contains before/after membership IDs
      const audit = await db
        .prepare(
          "SELECT metadata_json FROM audit_events WHERE action = 'customer.assign' AND target_id = ?",
        )
        .bind(custId)
        .first<{ metadata_json: string }>();
      const parsedAudit = JSON.parse(audit!.metadata_json);
      expect(parsedAudit.beforeAssigneeMembershipId).toBe(MEMBER_A_MEM_ID);
      expect(parsedAudit.afterAssigneeMembershipId).toBe(MEMBER_B_MEM_ID);

      // LIVE SCOPE SWITCH VERIFICATION:
      // Now Member A (assigned-only scope) attempts to update this customer!
      // Since customer is now assigned to Member B, Member A's CAS assertion MUST fail closed!
      await expect(
        executeCustomerDomainCommand({
          db,
          agencyId: AGENCY_ID,
          actorUserId: MEMBER_A_USER_ID,
          actorIdentityId: 'ident-mem-a',
          actorMembershipId: MEMBER_A_MEM_ID,
          expectedPermissionVersion: 1,
          correlationId: 'corr-update-after-reassign',
          idempotencyKey: 'idem-update-after-reassign',
          payload: { customerId: custId, displayName: 'Hacked' },
          command: {
            kind: 'customer.update',
            customerId: custId,
            expectedVersion: 2,
            displayName: 'Hacked',
            changedFields: ['displayName'],
          },
          resultProducer: () => ({ status: 200, body: {} }),
        }),
      ).rejects.toThrowError(DomainConstraintViolationError);
    });

    it('rejects assignment to inactive or suspended member', async () => {
      const custId = 'cust-assign-inactive';
      await db
        .prepare(
          `INSERT INTO customers (id, agency_id, type, display_name, assignee_membership_id, version)
           VALUES (?, ?, 'INDIVIDUAL', 'Customer for Inactive Assign', ?, 1)`,
        )
        .bind(custId, AGENCY_ID, OWNER_MEM_ID)
        .run();

      await expect(
        executeCustomerDomainCommand({
          db,
          agencyId: AGENCY_ID,
          actorUserId: OWNER_USER_ID,
          actorIdentityId: `ident-${OWNER_USER_ID}`,
          actorMembershipId: OWNER_MEM_ID,
          expectedPermissionVersion: 2,
          correlationId: 'corr-assign-inact',
          idempotencyKey: 'idem-assign-inact',
          payload: { customerId: custId, target: INACTIVE_MEMBER_ID },
          command: {
            kind: 'customer.assign',
            customerId: custId,
            expectedVersion: 1,
            targetAssigneeMembershipId: INACTIVE_MEMBER_ID,
          },
          resultProducer: () => ({ status: 200, body: {} }),
        }),
      ).rejects.toThrowError(DomainConstraintViolationError);
    });

    it('rejects assignment to a member from another agency', async () => {
      const custId = 'cust-assign-cross-agency';
      await db
        .prepare(
          `INSERT INTO customers (id, agency_id, type, display_name, assignee_membership_id, version)
           VALUES (?, ?, 'INDIVIDUAL', 'Customer Cross Assign', ?, 1)`,
        )
        .bind(custId, AGENCY_ID, OWNER_MEM_ID)
        .run();

      await expect(
        executeCustomerDomainCommand({
          db,
          agencyId: AGENCY_ID,
          actorUserId: OWNER_USER_ID,
          actorIdentityId: `ident-${OWNER_USER_ID}`,
          actorMembershipId: OWNER_MEM_ID,
          expectedPermissionVersion: 2,
          correlationId: 'corr-assign-cross',
          idempotencyKey: 'idem-assign-cross',
          payload: { customerId: custId, target: 'mem-other-owner' },
          command: {
            kind: 'customer.assign',
            customerId: custId,
            expectedVersion: 1,
            targetAssigneeMembershipId: 'mem-other-owner', // Belongs to OTHER_AGENCY_ID!
          },
          resultProducer: () => ({ status: 200, body: {} }),
        }),
      ).rejects.toThrowError(DomainConstraintViolationError);
    });
  });

  describe('customer.external_reference.create', () => {
    it('denies completed replay after permission, assignment, membership, or identity authority is revoked', async () => {
      const scenarios = [
        {
          suffix: 'permission',
          revoke: async (_customerId: string, membershipId: string) => {
            await db
              .prepare(
                "DELETE FROM membership_permissions WHERE membership_id=? AND permission_code='customer.update'",
              )
              .bind(membershipId)
              .run();
            await db
              .prepare(
                'UPDATE agency_memberships SET permission_version=2,version=version+1 WHERE id=?',
              )
              .bind(membershipId)
              .run();
          },
        },
        {
          suffix: 'assignment',
          revoke: async (id: string) => {
            await db
              .prepare('UPDATE customers SET assignee_membership_id=? WHERE id=?')
              .bind(OWNER_MEM_ID, id)
              .run();
          },
        },
        {
          suffix: 'membership',
          revoke: async (_customerId: string, membershipId: string) => {
            await db
              .prepare(
                "UPDATE agency_memberships SET status='SUSPENDED',suspended_at='2026-09-23T00:00:00.000Z',version=version+1,permission_version=permission_version+1 WHERE id=?",
              )
              .bind(membershipId)
              .run();
          },
        },
        {
          suffix: 'identity',
          revoke: async (_customerId: string, _membershipId: string, identityId: string) => {
            await db
              .prepare(
                "UPDATE auth_identities SET status='REVOKED',revoked_at='2999-01-01T00:00:00.000Z',version=version+1,updated_at='2999-01-01T00:00:00.000Z' WHERE id=?",
              )
              .bind(identityId)
              .run();
          },
        },
      ];
      for (const scenario of scenarios) {
        const userId = `replay-user-${scenario.suffix}`;
        const membershipId = `replay-member-${scenario.suffix}`;
        const identityId = `replay-identity-${scenario.suffix}`;
        await db.prepare("INSERT INTO users(id,status) VALUES(?,'ACTIVE')").bind(userId).run();
        await db
          .prepare(
            `INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at,version,permission_version,activated_at)
           VALUES(?,?,?,'MEMBER','ACTIVE',?,'2099-01-01T00:00:00.000Z',1,1,'2026-09-17T00:00:00.000Z')`,
          )
          .bind(membershipId, AGENCY_ID, userId, `${scenario.suffix}@test.com`)
          .run();
        await db
          .prepare(
            `INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email,status)
           VALUES(?,?, 'https://test', ?, ?, 'ACTIVE')`,
          )
          .bind(identityId, userId, `sub-${scenario.suffix}`, `${scenario.suffix}@test.com`)
          .run();
        await db
          .prepare(
            "INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,'customer.read','ASSIGNED'),(?,?,'customer.update','ASSIGNED')",
          )
          .bind(
            `perm-read-${scenario.suffix}`,
            membershipId,
            `perm-update-${scenario.suffix}`,
            membershipId,
          )
          .run();
        const customerId = `replay-auth-${scenario.suffix}`;
        const key = `replay-auth-key-${scenario.suffix}`;
        await db
          .prepare(
            `INSERT INTO customers(id,agency_id,type,display_name,assignee_membership_id,version)
           VALUES(?,?,'INDIVIDUAL','Replay Auth',?,1)`,
          )
          .bind(customerId, AGENCY_ID, membershipId)
          .run();
        const request = () =>
          executeCustomerDomainCommand({
            db,
            agencyId: AGENCY_ID,
            actorUserId: userId,
            actorIdentityId: identityId,
            actorMembershipId: membershipId,
            expectedPermissionVersion: 1,
            correlationId: `corr-${key}`,
            idempotencyKey: key,
            payload: { customerId, expectedVersion: 1, sourceNamespace: 'TEST', externalKey: key },
            command: {
              kind: 'customer.external_reference.create' as const,
              customerId,
              referenceId: `ref-${key}`,
              expectedVersion: 1,
              sourceNamespace: 'TEST',
              externalKey: key,
            },
            resultProducer: () => ({ status: 201, body: { id: `ref-${key}`, customerId } }),
          });
        const first = await request();
        expect(first.executed).toBe(true);
        await scenario.revoke(customerId, membershipId, identityId);
        await expect(request()).rejects.toMatchObject({ code: 'REPLAY_AUTHORIZATION_DENIED' });
      }
    });

    it('replays an exact completed create before duplicate prechecks and preserves one effect', async () => {
      const custId = 'cust-ext-replay';
      const refId = 'ref-ext-replay';
      const idempotencyKey = 'idem-ext-replay';
      const payload = {
        customerId: custId,
        expectedVersion: 1,
        sourceNamespace: 'MAPFRE',
        externalKey: 'EXT-REPLAY-1',
      };
      const command = {
        kind: 'customer.external_reference.create' as const,
        customerId: custId,
        referenceId: refId,
        expectedVersion: 1,
        sourceNamespace: 'MAPFRE',
        externalKey: 'EXT-REPLAY-1',
      };

      await db
        .prepare(
          `INSERT INTO customers (id, agency_id, type, display_name, assignee_membership_id, version)
           VALUES (?, ?, 'INDIVIDUAL', 'External Replay Customer', ?, 1)`,
        )
        .bind(custId, AGENCY_ID, OWNER_MEM_ID)
        .run();

      const execute = () =>
        executeCustomerDomainCommand({
          db,
          agencyId: AGENCY_ID,
          actorUserId: OWNER_USER_ID,
          actorIdentityId: `ident-${OWNER_USER_ID}`,
          actorMembershipId: OWNER_MEM_ID,
          expectedPermissionVersion: 2,
          correlationId: crypto.randomUUID(),
          idempotencyKey,
          payload,
          command,
          resultProducer: () => ({ status: 201, body: { id: refId, customerId: custId } }),
        });

      const first = await execute();
      expect(first.executed).toBe(true);
      const replay = await execute();
      expect(replay).toMatchObject({
        executed: false,
        replayed: true,
        status: 201,
        body: { id: refId, customerId: custId },
      });

      const effects = await db
        .prepare('SELECT count(*) AS count FROM external_customer_references WHERE customer_id = ?')
        .bind(custId)
        .first<{ count: number }>();
      const successAudits = await db
        .prepare(
          "SELECT count(*) AS count FROM audit_events WHERE action = 'customer.external_reference.create' AND target_id = ?",
        )
        .bind(refId)
        .first<{ count: number }>();
      expect(effects?.count).toBe(1);
      expect(successAudits?.count).toBe(1);

      await expect(
        executeCustomerDomainCommand({
          db,
          agencyId: AGENCY_ID,
          actorUserId: OWNER_USER_ID,
          actorIdentityId: `ident-${OWNER_USER_ID}`,
          actorMembershipId: OWNER_MEM_ID,
          expectedPermissionVersion: 2,
          correlationId: 'corr-ext-replay-action-mismatch',
          idempotencyKey,
          payload,
          command: {
            kind: 'customer.assign',
            customerId: custId,
            expectedVersion: 2,
            targetAssigneeMembershipId: OWNER_MEM_ID,
          },
          resultProducer: () => ({ status: 200, body: {} }),
        }),
      ).rejects.toMatchObject<Partial<IdempotencyConflictError>>({
        code: 'IDEMPOTENCY_ACTION_MISMATCH',
      });

      await expect(
        executeCustomerDomainCommand({
          db,
          agencyId: AGENCY_ID,
          actorUserId: OWNER_USER_ID,
          actorIdentityId: `ident-${OWNER_USER_ID}`,
          actorMembershipId: OWNER_MEM_ID,
          expectedPermissionVersion: 2,
          correlationId: 'corr-ext-replay-payload-mismatch',
          idempotencyKey,
          payload: { ...payload, externalKey: 'EXT-REPLAY-CHANGED' },
          command: { ...command, externalKey: 'EXT-REPLAY-CHANGED' },
          resultProducer: () => ({ status: 201, body: {} }),
        }),
      ).rejects.toMatchObject<Partial<IdempotencyConflictError>>({
        code: 'IDEMPOTENCY_PAYLOAD_MISMATCH',
      });

      await expect(
        executeCustomerDomainCommand({
          db,
          agencyId: AGENCY_ID,
          actorUserId: OWNER_USER_ID,
          actorIdentityId: `ident-${OWNER_USER_ID}`,
          actorMembershipId: OWNER_MEM_ID,
          expectedPermissionVersion: 2,
          correlationId: 'corr-ext-replay-new-key',
          idempotencyKey: 'idem-ext-replay-new-key',
          payload: { ...payload, expectedVersion: 2 },
          command: { ...command, referenceId: 'ref-ext-replay-new-key', expectedVersion: 2 },
          resultProducer: () => ({ status: 201, body: {} }),
        }),
      ).rejects.toMatchObject<Partial<DomainConstraintViolationError>>({
        code: 'DUPLICATE_EXTERNAL_REFERENCE',
      });
    });

    it('allows at most one business effect for concurrent duplicate external-reference creates', async () => {
      const custId = 'cust-ext-concurrent';
      await db
        .prepare(
          `INSERT INTO customers (id, agency_id, type, display_name, assignee_membership_id, version)
           VALUES (?, ?, 'INDIVIDUAL', 'External Concurrent Customer', ?, 1)`,
        )
        .bind(custId, AGENCY_ID, OWNER_MEM_ID)
        .run();

      const create = (suffix: string) =>
        executeCustomerDomainCommand({
          db,
          agencyId: AGENCY_ID,
          actorUserId: OWNER_USER_ID,
          actorIdentityId: `ident-${OWNER_USER_ID}`,
          actorMembershipId: OWNER_MEM_ID,
          expectedPermissionVersion: 2,
          correlationId: `corr-ext-concurrent-${suffix}`,
          idempotencyKey: `idem-ext-concurrent-${suffix}`,
          payload: {
            customerId: custId,
            expectedVersion: 1,
            sourceNamespace: 'AXA',
            externalKey: 'RACE-1',
          },
          command: {
            kind: 'customer.external_reference.create' as const,
            customerId: custId,
            referenceId: `ref-ext-concurrent-${suffix}`,
            expectedVersion: 1,
            sourceNamespace: 'AXA',
            externalKey: 'RACE-1',
          },
          resultProducer: () => ({ status: 201, body: { id: `ref-ext-concurrent-${suffix}` } }),
        });

      const results = await Promise.allSettled([create('a'), create('b')]);
      expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);

      const effects = await db
        .prepare(
          "SELECT count(*) AS count FROM external_customer_references WHERE agency_id = ? AND source_namespace = 'AXA' AND external_key = 'RACE-1'",
        )
        .bind(AGENCY_ID)
        .first<{ count: number }>();
      expect(effects?.count).toBe(1);
    });

    it('creates external customer reference and increments customer version atomically', async () => {
      const custId = 'cust-ext-test-1';
      const refId = 'ref-ext-test-1';

      await db
        .prepare(
          `INSERT INTO customers (id, agency_id, type, display_name, assignee_membership_id, version)
           VALUES (?, ?, 'INDIVIDUAL', 'Customer With Ext Ref', ?, 1)`,
        )
        .bind(custId, AGENCY_ID, OWNER_MEM_ID)
        .run();

      const result = await executeCustomerDomainCommand({
        db,
        agencyId: AGENCY_ID,
        actorUserId: OWNER_USER_ID,
        actorIdentityId: `ident-${OWNER_USER_ID}`,
        actorMembershipId: OWNER_MEM_ID,
        expectedPermissionVersion: 2,
        correlationId: 'corr-ext-1',
        idempotencyKey: 'idem-ext-1',
        payload: { customerId: custId, namespace: 'ALLIANZ', key: 'EXT-1001' },
        command: {
          kind: 'customer.external_reference.create',
          customerId: custId,
          referenceId: refId,
          expectedVersion: 1,
          sourceNamespace: 'ALLIANZ',
          externalKey: 'EXT-1001',
        },
        resultProducer: () => ({
          status: 201,
          body: {
            id: refId,
            customerId: custId,
            sourceNamespace: 'ALLIANZ',
            externalKey: 'EXT-1001',
          },
        }),
      });

      expect(result.executed).toBe(true);

      // Customer version incremented to 2
      const custRow = await db
        .prepare('SELECT version FROM customers WHERE id = ?')
        .bind(custId)
        .first<{ version: number }>();
      expect(custRow?.version).toBe(2);

      const auditRow = await db
        .prepare(
          "SELECT metadata_json FROM audit_events WHERE action = 'customer.external_reference.create' AND target_id = ?",
        )
        .bind(refId)
        .first<{ metadata_json: string }>();
      const auditMetadata = JSON.parse(auditRow!.metadata_json) as Record<string, unknown>;
      expect(auditMetadata).toMatchObject({
        customerId: custId,
        referenceId: refId,
        sourceNamespace: 'ALLIANZ',
      });
      expect(auditMetadata).not.toHaveProperty('externalKey');
      expect(auditRow!.metadata_json).not.toContain('EXT-1001');

      // External reference exists in DB
      const refRow = await db
        .prepare(
          'SELECT id, agency_id, customer_id, source_namespace, external_key FROM external_customer_references WHERE id = ?',
        )
        .bind(refId)
        .first<{
          id: string;
          agency_id: string;
          customer_id: string;
          source_namespace: string;
          external_key: string;
        }>();

      expect(refRow?.id).toBe(refId);
      expect(refRow?.agency_id).toBe(AGENCY_ID);
      expect(refRow?.customer_id).toBe(custId);
      expect(refRow?.source_namespace).toBe('ALLIANZ');
      expect(refRow?.external_key).toBe('EXT-1001');
    });

    it('rejects duplicate (agency_id, source_namespace, external_key) with DUPLICATE_EXTERNAL_REFERENCE', async () => {
      const custId = 'cust-ext-test-dup';
      await db
        .prepare(
          `INSERT INTO customers (id, agency_id, type, display_name, assignee_membership_id, version)
           VALUES (?, ?, 'INDIVIDUAL', 'Customer Dup Ref', ?, 1)`,
        )
        .bind(custId, AGENCY_ID, OWNER_MEM_ID)
        .run();

      // First ref
      await executeCustomerDomainCommand({
        db,
        agencyId: AGENCY_ID,
        actorUserId: OWNER_USER_ID,
        actorIdentityId: `ident-${OWNER_USER_ID}`,
        actorMembershipId: OWNER_MEM_ID,
        expectedPermissionVersion: 2,
        correlationId: 'corr-ext-dup-1',
        idempotencyKey: 'idem-ext-dup-1',
        payload: { customerId: custId, namespace: 'ANADOLU', key: 'REF-DUP' },
        command: {
          kind: 'customer.external_reference.create',
          customerId: custId,
          referenceId: 'ref-dup-1',
          expectedVersion: 1,
          sourceNamespace: 'ANADOLU',
          externalKey: 'REF-DUP',
        },
        resultProducer: () => ({ status: 201, body: {} }),
      });

      // Second ref with SAME namespace and key
      await expect(
        executeCustomerDomainCommand({
          db,
          agencyId: AGENCY_ID,
          actorUserId: OWNER_USER_ID,
          actorIdentityId: `ident-${OWNER_USER_ID}`,
          actorMembershipId: OWNER_MEM_ID,
          expectedPermissionVersion: 2,
          correlationId: 'corr-ext-dup-2',
          idempotencyKey: 'idem-ext-dup-2',
          payload: { customerId: custId, namespace: 'ANADOLU', key: 'REF-DUP' },
          command: {
            kind: 'customer.external_reference.create',
            customerId: custId,
            referenceId: 'ref-dup-2',
            expectedVersion: 2,
            sourceNamespace: 'ANADOLU',
            externalKey: 'REF-DUP',
          },
          resultProducer: () => ({ status: 201, body: {} }),
        }),
      ).rejects.toThrowError(DomainConstraintViolationError);
    });
  });
});
