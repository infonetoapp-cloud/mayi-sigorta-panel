// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { canonicalizePayload, computePayloadHash } from '../src/server/mutations/canonical';

describe('M1-T09 Canonicalization and Fingerprinting', () => {
  it('produces deterministic JSON and matching SHA-256 hash regardless of object key order', async () => {
    const payloadA = {
      agencyId: 'agency-1',
      action: 'membership.role.change',
      params: { role: 'OWNER', targetUserId: 'user-2' },
      meta: [3, 1, 2],
    };

    const payloadB = {
      meta: [3, 1, 2],
      params: { targetUserId: 'user-2', role: 'OWNER' },
      action: 'membership.role.change',
      agencyId: 'agency-1',
    };

    const canonicalA = canonicalizePayload(payloadA);
    const canonicalB = canonicalizePayload(payloadB);

    expect(canonicalA).toBe(canonicalB);

    const hashA = await computePayloadHash(payloadA);
    const hashB = await computePayloadHash(payloadB);

    expect(hashA).toHaveLength(64);
    expect(hashA).toBe(hashB);
  });
});

describe('M1-T09 Audit Record and Safe Metadata Sanitizer (Hardened)', () => {
  it('restricts metadata to small code-like operational fields, drops all free text, secrets, and JWTs', async () => {
    const { buildSafeAuditRecord, sanitizeAuditMetadata } =
      await import('../src/server/mutations/audit');

    const dirtyMetadata = {
      // Free-text fields that could leak secrets -> MUST BE DROPPED
      clientIp: '192.168.1.1',
      userAgent: 'Mozilla/5.0 (Windows)',
      reason: 'Role update with free text and secrets',
      changeSummary: 'Updated user role from MEMBER to OWNER',
      data: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret',
      value: 'raw_password_here',
      note: 'admin secret note',
      // Valid operational tokens & bounded numbers -> ALLOWED
      reasonCode: 'ROLE_UPGRADE',
      resultCode: 'OK',
      requestSource: 'ADMIN_CONSOLE',
      changedFieldCount: 2,
      targetVersion: 3,
      replayed: false,
      // Invalid code token (contains whitespace/secret) -> DROPPED
      badToken: 'not a valid token!',
    };

    const clean = sanitizeAuditMetadata(dirtyMetadata);

    expect(clean).toEqual({
      reasonCode: 'ROLE_UPGRADE',
      resultCode: 'OK',
      requestSource: 'ADMIN_CONSOLE',
      changedFieldCount: 2,
      targetVersion: 3,
      replayed: false,
    });

    // Verify all arbitrary free text and secrets are eliminated
    expect(clean).not.toHaveProperty('clientIp');
    expect(clean).not.toHaveProperty('userAgent');
    expect(clean).not.toHaveProperty('reason');
    expect(clean).not.toHaveProperty('changeSummary');
    expect(clean).not.toHaveProperty('data');
    expect(clean).not.toHaveProperty('value');
    expect(clean).not.toHaveProperty('note');
    expect(clean).not.toHaveProperty('badToken');

    const record = buildSafeAuditRecord({
      agencyId: 'agency-123',
      actorUserId: 'user-456',
      actorMembershipId: 'mem-789',
      action: 'membership.role.change',
      targetType: 'agency_memberships',
      targetId: 'mem-target',
      correlationId: 'req-corr-1',
      idempotencyKey: 'idem-key-1',
      outcome: 'SUCCESS',
      metadata: dirtyMetadata,
    });

    expect(record.metadataJson).not.toContain('Role update with free text');
    expect(record.metadataJson).not.toContain('eyJhbGciOi');
    expect(record.metadataJson).toContain('ROLE_UPGRADE');
  });
});

describe('M1-T09 Canonicalization Security and Bounded JSON Subset (IMPORTANT 4 & 5 Hardened)', () => {
  it('rejects circular references, non-finite numbers, and oversized payloads fail-closed', async () => {
    // Cyclic reference
    const cyclicObj: Record<string, unknown> = { a: 1 };
    cyclicObj.self = cyclicObj;

    expect(() => canonicalizePayload(cyclicObj)).toThrow('CANONICAL_PAYLOAD_UNSUPPORTED');

    // Non-finite numbers: NaN, Infinity
    expect(() => canonicalizePayload({ val: Number.NaN })).toThrow('CANONICAL_PAYLOAD_UNSUPPORTED');
    expect(() => canonicalizePayload({ val: Number.POSITIVE_INFINITY })).toThrow(
      'CANONICAL_PAYLOAD_UNSUPPORTED',
    );

    // Oversized payload (> 64KB)
    const bigString = 'x'.repeat(70000);
    expect(() => canonicalizePayload({ big: bigString })).toThrow('CANONICAL_PAYLOAD_TOO_LARGE');
  });

  it('rejects accessor getters, undefined properties, array holes, and functions/symbols', async () => {
    // 1. Accessor getter (TOCTOU trap)
    let getterCalled = false;
    const getterObj = {};
    Object.defineProperty(getterObj, 'trap', {
      get() {
        getterCalled = true;
        return 'danger';
      },
      enumerable: true,
    });
    expect(() => canonicalizePayload(getterObj)).toThrow('CANONICAL_PAYLOAD_UNSUPPORTED');
    expect(getterCalled).toBe(false); // Getter must NOT even be invoked!

    // 2. Undefined property
    expect(() => canonicalizePayload({ forbidden: undefined })).toThrow(
      'CANONICAL_PAYLOAD_UNSUPPORTED',
    );

    // 3. Array holes (sparse array)
    // eslint-disable-next-line no-sparse-arrays
    const sparseArr = [1, , 3];
    expect(() => canonicalizePayload({ arr: sparseArr })).toThrow('CANONICAL_PAYLOAD_UNSUPPORTED');

    // 4. Function or symbol
    expect(() => canonicalizePayload({ fn: () => 42 })).toThrow('CANONICAL_PAYLOAD_UNSUPPORTED');
    expect(() => canonicalizePayload({ sym: Symbol('x') })).toThrow(
      'CANONICAL_PAYLOAD_UNSUPPORTED',
    );

    // 5. Duplicate or empty target IDs in canonicalizeTargetIds
    const { canonicalizeTargetIds } = await import('../src/server/mutations/grants');
    expect(() => canonicalizeTargetIds(['id-1', 'id-1'])).toThrow('CANONICAL_PAYLOAD_UNSUPPORTED');
    expect(() => canonicalizeTargetIds([''])).toThrow('CANONICAL_PAYLOAD_UNSUPPORTED');
  });
});

describe('M1-T09 RG-00 SensitiveActionGrant Issuance & Context Verification (IMPORTANT 1 & 5)', () => {
  it('rejects issuance when context assurance is NORMAL, requires SECURE assurance', async () => {
    const { issueAndPersistSensitiveActionGrant } = await import('../src/server/mutations/grants');

    const normalContext = {
      userId: 'user-1',
      identityId: 'id-1',
      assurance: 'NORMAL' as const,
      memberships: [
        {
          id: 'mem-1',
          agencyId: 'agency-1',
          type: 'OWNER' as const,
          status: 'ACTIVE' as const,
          permissionVersion: 1,
        },
      ],
    };

    const mockDb = {
      prepare: () => ({
        bind: () => ({
          run: async () => ({ success: true }),
        }),
      }),
    } as unknown as D1Database;

    await expect(
      issueAndPersistSensitiveActionGrant(mockDb, normalContext, {
        agencyId: 'agency-1',
        action: 'membership.role.change',
        payloadHash: 'a'.repeat(64),
        targetIds: ['mem-2'],
      }),
    ).rejects.toThrow('SECURE_ASSURANCE_REQUIRED');
  });

  it('rejects issuance when user has no active membership in target agency, persists when valid', async () => {
    const { issueAndPersistSensitiveActionGrant } = await import('../src/server/mutations/grants');

    const secureContext = {
      userId: 'user-1',
      identityId: 'id-1',
      assurance: 'SECURE' as const,
      memberships: [
        {
          id: 'mem-1',
          agencyId: 'agency-1',
          type: 'OWNER' as const,
          status: 'ACTIVE' as const,
          permissionVersion: 1,
        },
      ],
    };

    let insertedSql = '';
    const mockDb = {
      prepare: (sql: string) => {
        insertedSql = sql;
        return {
          bind: () => ({
            run: async () => ({ success: true }),
            first: async () => {
              if (sql.includes('FROM users')) return { id: 'user-1', status: 'ACTIVE' };
              if (sql.includes('FROM agencies')) return { id: 'agency-1', status: 'ACTIVE' };
              if (sql.includes('FROM agency_memberships'))
                return { id: 'mem-1', status: 'ACTIVE', permission_version: 1 };
              return null;
            },
          }),
        };
      },
    } as unknown as D1Database;

    // 1. Target agency not in memberships -> rejects
    await expect(
      issueAndPersistSensitiveActionGrant(mockDb, secureContext, {
        agencyId: 'unrelated-agency-99',
        action: 'membership.role.change',
        payloadHash: 'a'.repeat(64),
        targetIds: ['mem-2'],
      }),
    ).rejects.toThrow('ACTIVE_MEMBERSHIP_REQUIRED');

    // 2. Target agency active membership -> succeeds and persists
    const result = await issueAndPersistSensitiveActionGrant(mockDb, secureContext, {
      agencyId: 'agency-1',
      action: 'membership.role.change',
      payloadHash: 'b'.repeat(64),
      targetIds: ['mem-2'],
    });

    expect(result.grantToken).toBeDefined();
    expect(result.grantRecord.assurance).toBe('SECURE_GRANT');
    expect(result.grantRecord.actorUserId).toBe('user-1');
    expect(result.grantRecord.actorMembershipId).toBe('mem-1');
    expect(insertedSql).toContain('INSERT INTO sensitive_action_grants');
  });
});

describe('M1-T09 Executor Assurance Discriminator & Idempotency Key Obligation (BLOCKER 3)', () => {
  it('rejects SECURE_GRANT execution when grantEvidenceToken is omitted, and requires non-empty idempotency key', async () => {
    const { executeAtomicMutation } = await import('../src/server/mutations/executor');

    const mockDb = {
      prepare: () => ({
        bind: () => ({
          first: async () => null,
          run: async () => ({ success: true }),
        }),
      }),
      batch: async () => [],
    } as unknown as D1Database;

    // 1. Missing idempotencyKey must throw
    await expect(
      executeAtomicMutation({
        db: mockDb,
        assurance: 'NORMAL_SESSION',
        agencyId: 'agency-1',
        actorUserId: 'user-1',
        actorMembershipId: 'mem-1',
        action: 'customer.create',
        correlationId: 'req-1',
        idempotencyKey: '', // Empty!
        payload: { name: 'Test' },
        targetType: 'customers',
        targetId: 'cust-1',
        businessOperations: [],
        resultProducer: () => ({ status: 200, body: {} }),
      }),
    ).rejects.toThrow('IDEMPOTENCY_KEY_REQUIRED');

    // 2. SECURE_GRANT mode without grantEvidenceToken must throw
    await expect(
      executeAtomicMutation({
        db: mockDb,
        assurance: 'SECURE_GRANT',
        agencyId: 'agency-1',
        actorUserId: 'user-1',
        actorMembershipId: 'mem-1',
        action: 'membership.role.change',
        correlationId: 'req-2',
        idempotencyKey: 'idem-2',
        payload: { targetMembershipId: 'mem-2' },
        targetType: 'agency_memberships',
        targetId: 'mem-2',
        businessOperations: [],
        resultProducer: () => ({ status: 200, body: {} }),
      }),
    ).rejects.toThrow('GRANT_EVIDENCE_REQUIRED');

    // 3. SECURE_GRANT mode looks up grant in DB by evidence_hash (never trusts caller record)
    await expect(
      executeAtomicMutation({
        db: mockDb, // mock returns null for first()
        assurance: 'SECURE_GRANT',
        agencyId: 'agency-1',
        actorUserId: 'user-1',
        actorMembershipId: 'mem-1',
        action: 'membership.role.change',
        correlationId: 'req-3',
        idempotencyKey: 'idem-3',
        payload: { targetMembershipId: 'mem-2' },
        grantEvidenceToken: 'forged-or-nonexistent-token',
        targetType: 'agency_memberships',
        targetId: 'mem-2',
        businessOperations: [{ statement: mockDb.prepare(''), expectedChanges: 1 }],
        resultProducer: () => ({ status: 200, body: {} }),
      }),
    ).rejects.toThrow('GRANT_NOT_FOUND');

    // 4. Rejects empty businessOperations for executed mutation
    await expect(
      executeAtomicMutation({
        db: mockDb,
        assurance: 'NORMAL_SESSION',
        agencyId: 'agency-1',
        actorUserId: 'user-1',
        actorMembershipId: 'mem-1',
        action: 'customer.create',
        correlationId: 'req-4',
        idempotencyKey: 'idem-4',
        payload: { name: 'Test' },
        targetType: 'customers',
        targetId: 'cust-1',
        businessOperations: [], // Empty!
        resultProducer: () => ({ status: 200, body: {} }),
      }),
    ).rejects.toThrow('BUSINESS_OPERATIONS_REQUIRED');
  });
});

describe('M1-T09 Unsafe Grant API Elimination & Live D1 Validation (Contract 1)', () => {
  it('does not export unsafe issueSensitiveActionGrant, and requires live ACTIVE user/membership/agency in D1', async () => {
    const grantsModule = await import('../src/server/mutations/grants');
    // Unsafe API must not be exported!
    expect(
      (grantsModule as unknown as Record<string, unknown>).issueSensitiveActionGrant,
    ).toBeUndefined();

    const secureContext = {
      userId: 'user-1',
      identityId: 'id-1',
      assurance: 'SECURE' as const,
      memberships: [
        {
          id: 'mem-1',
          agencyId: 'agency-1',
          type: 'OWNER' as const,
          status: 'ACTIVE' as const,
          permissionVersion: 1,
        },
      ],
    };

    // Mock DB that returns inactive user
    const mockDbInactiveUser = {
      prepare: () => ({
        bind: () => ({
          first: async () => ({ status: 'INACTIVE' }),
          run: async () => ({ success: true }),
        }),
      }),
    } as unknown as D1Database;

    await expect(
      grantsModule.issueAndPersistSensitiveActionGrant(mockDbInactiveUser, secureContext, {
        agencyId: 'agency-1',
        action: 'membership.role.change',
        payloadHash: 'a'.repeat(64),
        targetIds: ['mem-2'],
      }),
    ).rejects.toThrow('ACTIVE_USER_REQUIRED');
  });
});
