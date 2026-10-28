// @vitest-environment node
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import miniflare from 'miniflare';
import {
  evaluateAuthorization,
  createAuthorizationEvaluator,
  validateAndCreateActionDefinition,
  createActionRegistry,
  DEFAULT_ACTION_REGISTRY,
  type ActionAuthority,
  type ActionDefinition,
  type ActionRegistry,
  type AuthorizationOptions,
  type AuthorizationRequest,
  type ScopeResolverRegistry,
  type ScopeResolutionContext,
  quoteRecordResolver,
  interactionRecordResolver,
} from '../src/server/auth/authorization';
import type { AuthenticatedUserContext } from '../src/server/auth/identity';
import { grantPermission } from './support/permissions-fixture';

const { Miniflare, convertV4MiniflareOptions } = miniflare;
const rootDir = resolve(__dirname, '..');

describe('M3 quote and interaction record scopes', () => {
  const resource = {
    agencyId: 'agency-a',
    renewalAssigneeMembershipId: 'membership-a',
    customerAssigneeMembershipId: 'membership-b',
  };

  it('uses the Renewal assignment and customer assignment without widening to source Policy assignment', () => {
    const context = (
      permissionCode: string,
      membershipId: string,
      agencyId = 'agency-a',
      effectiveScope: 'ASSIGNED' | 'AGENCY' = 'ASSIGNED',
    ): ScopeResolutionContext => ({
      userId: 'user',
      membershipId,
      agencyId,
      effectiveScope,
      permissionCode,
      resource,
    });
    for (const [resolver, permission] of [
      [quoteRecordResolver, 'quote.read'],
      [interactionRecordResolver, 'interaction.read'],
    ] as const) {
      expect(resolver(context(permission, 'membership-a'))).toBe(true);
      expect(resolver(context(permission, 'membership-b'))).toBe(true);
      expect(resolver(context(permission, 'membership-c'))).toBe(false);
      expect(resolver(context(permission, 'membership-a', 'agency-b'))).toBe(false);
      expect(resolver(context(permission, 'membership-c', 'agency-a', 'AGENCY'))).toBe(true);
    }
  });
});

describe('M1-T07 Runtime Authorization Evaluator Testleri (Miniflare D1)', () => {
  let mf: miniflare.Miniflare;
  let db: D1Database;

  const TEST_AGENCY = 't07-agency-1';
  const OTHER_AGENCY = 't07-agency-2';

  const OWNER_USER_ID = 't07-owner-user';
  const OWNER_MEMBERSHIP_ID = 't07-owner-mem';
  const OWNER_IDENTITY_ID = 't07-owner-ident';

  const MEMBER_USER_ID = 't07-member-user';
  const MEMBER_MEMBERSHIP_ID = 't07-member-mem';
  const MEMBER_IDENTITY_ID = 't07-member-ident';

  // Injected test-only resolver fixture that allows records where isAllowedRecord === true
  const TEST_RESOLVERS: Partial<ScopeResolverRegistry> = {
    customer_record_resolver: (ctx) => {
      const res = ctx.resource as Record<string, unknown> | undefined;
      return res?.isAllowedRecord === true;
    },
    policy_record_resolver: (ctx) => {
      const res = ctx.resource as Record<string, unknown> | undefined;
      return res?.isAllowedRecord === true;
    },
    renewal_record_resolver: (ctx) => {
      const res = ctx.resource as Record<string, unknown> | undefined;
      return res?.isAllowedRecord === true;
    },
  };

  const TEST_COMPOUND_ACTION: ActionDefinition = validateAndCreateActionDefinition({
    code: 'customer.view_sensitive_identity',
    authority: 'MEMBERSHIP_AUTHORIZED',
    requiredNormalPermissions: ['customer.read'],
    requiredSensitivePermissions: ['sensitive.identity.read'],
    assurance: 'NORMAL_SESSION',
  });

  const TEST_ACTIONS: ActionRegistry = createActionRegistry([
    ...DEFAULT_ACTION_REGISTRY.entries(),
    [TEST_COMPOUND_ACTION.code, TEST_COMPOUND_ACTION],
  ]);

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

    const m0 = readFileSync(resolve(rootDir, 'db/migrations/0000_good_hammerhead.sql'), 'utf8');
    const m1 = readFileSync(
      resolve(rootDir, 'db/migrations/0001_chunky_blazing_skull.sql'),
      'utf8',
    );

    for (const sql of [m0, m1]) {
      const stmts = sql
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const stmt of stmts) {
        await db.prepare(stmt).run();
      }
    }

    // Bootstrap test agencies
    for (const agencyId of [TEST_AGENCY, OTHER_AGENCY]) {
      await db
        .prepare("INSERT INTO agencies (id, status, version) VALUES (?, 'PROVISIONING', 1)")
        .bind(agencyId)
        .run();

      const ownerUserId = `${agencyId}-initial-owner-user`;
      const ownerMemId = `${agencyId}-initial-owner-mem`;
      await db
        .prepare("INSERT INTO users (id, status, version) VALUES (?, 'INACTIVE', 1)")
        .bind(ownerUserId)
        .run();

      await db
        .prepare(
          `INSERT INTO agency_memberships (
             id, agency_id, user_id, type, status, invitation_email, invitation_expires_at, version, permission_version
           ) VALUES (?, ?, ?, 'OWNER', 'INVITED', ?, '2099-01-01T00:00:00.000Z', 1, 1)`,
        )
        .bind(ownerMemId, agencyId, ownerUserId, `${agencyId}-init@example.test`)
        .run();

      await db
        .prepare(
          `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
           VALUES (?, ?, 'https://test.access.com', ?, ?, 'ACTIVE')`,
        )
        .bind(
          `${agencyId}-init-ident`,
          ownerUserId,
          `${agencyId}-sub`,
          `${agencyId}-init@example.test`,
        )
        .run();

      await db
        .prepare("UPDATE users SET status = 'ACTIVE', version = 2 WHERE id = ?")
        .bind(ownerUserId)
        .run();
      await db
        .prepare(
          `UPDATE agency_memberships
           SET status = 'ACTIVE',
               activated_at = '2026-09-17T00:00:00.000Z',
               version = version + 1,
               permission_version = permission_version + 1
           WHERE id = ?`,
        )
        .bind(ownerMemId)
        .run();

      await db
        .prepare(
          `UPDATE agencies
           SET status = 'ACTIVE',
               bootstrap_completed_at = '2026-09-17T00:00:00.000Z',
               activated_at = '2026-09-17T00:00:00.000Z',
               version = 2
           WHERE id = ?`,
        )
        .bind(agencyId)
        .run();
    }

    // Setup OWNER user for TEST_AGENCY
    await db
      .prepare("INSERT INTO users (id, status, version) VALUES (?, 'ACTIVE', 1)")
      .bind(OWNER_USER_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
         VALUES (?, ?, 'https://test.access.com', 'owner-sub', 'owner@agency1.test', 'ACTIVE')`,
      )
      .bind(OWNER_IDENTITY_ID, OWNER_USER_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO agency_memberships (
           id, agency_id, user_id, type, status, invitation_email, invitation_expires_at,
           activated_at, version, permission_version
         ) VALUES (?, ?, ?, 'OWNER', 'ACTIVE', 'owner@agency1.test', '2099-01-01T00:00:00.000Z',
           (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), 1, 1)`,
      )
      .bind(OWNER_MEMBERSHIP_ID, TEST_AGENCY, OWNER_USER_ID)
      .run();

    // Setup MEMBER user for TEST_AGENCY
    await db
      .prepare("INSERT INTO users (id, status, version) VALUES (?, 'ACTIVE', 1)")
      .bind(MEMBER_USER_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
         VALUES (?, ?, 'https://test.access.com', 'member-sub', 'member@agency1.test', 'ACTIVE')`,
      )
      .bind(MEMBER_IDENTITY_ID, MEMBER_USER_ID)
      .run();
    await db
      .prepare(
        `INSERT INTO agency_memberships (
           id, agency_id, user_id, type, status, invitation_email, invitation_expires_at,
           activated_at, version, permission_version
         ) VALUES (?, ?, ?, 'MEMBER', 'ACTIVE', 'member@agency1.test', '2099-01-01T00:00:00.000Z',
           (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), 1, 1)`,
      )
      .bind(MEMBER_MEMBERSHIP_ID, TEST_AGENCY, MEMBER_USER_ID)
      .run();
  });

  afterAll(async () => {
    if (mf) {
      await mf.dispose();
    }
  });

  function createOwnerContext(
    overrides?: Partial<AuthenticatedUserContext>,
  ): AuthenticatedUserContext {
    return {
      userId: OWNER_USER_ID,
      identityId: OWNER_IDENTITY_ID,
      assurance: 'NORMAL',
      memberships: [
        {
          id: OWNER_MEMBERSHIP_ID,
          agencyId: TEST_AGENCY,
          type: 'OWNER',
          status: 'ACTIVE',
          permissionVersion: 1,
        },
      ],
      ...overrides,
    };
  }

  function createMemberContext(
    overrides?: Partial<AuthenticatedUserContext>,
  ): AuthenticatedUserContext {
    return {
      userId: MEMBER_USER_ID,
      identityId: MEMBER_IDENTITY_ID,
      assurance: 'NORMAL',
      memberships: [
        {
          id: MEMBER_MEMBERSHIP_ID,
          agencyId: TEST_AGENCY,
          type: 'MEMBER',
          status: 'ACTIVE',
          permissionVersion: 1,
        },
      ],
      ...overrides,
    };
  }

  // ---------------------------------------------------------------------------
  // 1. MEMBER explicit valid NORMAL -> ALLOW (with resource + injected resolver)
  // ---------------------------------------------------------------------------
  it('1. MEMBER explicit valid NORMAL -> ALLOW with valid effectiveScope and resource', async () => {
    // Grant customer.read (ASSIGNED) to member
    await grantPermission(db, {
      agencyId: TEST_AGENCY,
      membershipId: MEMBER_MEMBERSHIP_ID,
      permissionCode: 'customer.read',
      scope: 'ASSIGNED',
      expectedPermissionVersion: 1,
    });

    const context = createMemberContext({
      memberships: [
        {
          id: MEMBER_MEMBERSHIP_ID,
          agencyId: TEST_AGENCY,
          type: 'MEMBER',
          status: 'ACTIVE',
          permissionVersion: 2,
        },
      ],
    });

    const result = await evaluateAuthorization(
      db,
      {
        context,
        permissionCode: 'customer.read',
        agencyId: TEST_AGENCY,
        resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
      },
      { resolvers: TEST_RESOLVERS },
    );

    expect(result.decision).toBe('ALLOW');
    expect(result.code).toBe('ALLOWED');
    expect(result.effectiveScope).toBe('ASSIGNED');
  });

  // ---------------------------------------------------------------------------
  // 2. MEMBER missing grant -> DENY
  // ---------------------------------------------------------------------------
  it('2. MEMBER missing grant -> DENY (PERMISSION_NOT_GRANTED)', async () => {
    const context = createMemberContext({
      memberships: [
        {
          id: MEMBER_MEMBERSHIP_ID,
          agencyId: TEST_AGENCY,
          type: 'MEMBER',
          status: 'ACTIVE',
          permissionVersion: 2,
        },
      ],
    });
    const result = await evaluateAuthorization(db, {
      context,
      permissionCode: 'policy.read',
      agencyId: TEST_AGENCY,
      resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
    });

    expect(result.decision).toBe('DENY');
    expect(result.code).toBe('PERMISSION_NOT_GRANTED');
    expect(result.effectiveScope).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // 3. OWNER NORMAL -> ALLOW with AGENCY, with no row
  // ---------------------------------------------------------------------------
  it('3. OWNER NORMAL -> ALLOW with AGENCY without any DB permission row', async () => {
    const context = createOwnerContext();

    // 3a: RECORD_SCOPED with resource and injected resolver
    const recordScopedResult = await evaluateAuthorization(
      db,
      {
        context,
        permissionCode: 'customer.read',
        agencyId: TEST_AGENCY,
        resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
      },
      { resolvers: TEST_RESOLVERS },
    );
    expect(recordScopedResult.decision).toBe('ALLOW');
    expect(recordScopedResult.code).toBe('ALLOWED');
    expect(recordScopedResult.effectiveScope).toBe('AGENCY');

    // 3b: Truly UNSCOPED audit.read does not need resource
    const unscopedResult = await evaluateAuthorization(db, {
      context,
      permissionCode: 'audit.read',
      agencyId: TEST_AGENCY,
    });
    expect(unscopedResult.decision).toBe('ALLOW');
    expect(unscopedResult.effectiveScope).toBe('UNSCOPED');
  });

  // ---------------------------------------------------------------------------
  // 4. OWNER corrupt/unknown explicit NORMAL row cannot create or alter authority
  // ---------------------------------------------------------------------------
  it('4. OWNER corrupt/unknown explicit NORMAL row cannot create or alter authority', async () => {
    // Insert corrupt rows directly into DB for OWNER
    await db
      .prepare(
        `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
         VALUES ('corrupt-grant-1', ?, 'customer.read', 'ASSIGNED')`,
      )
      .bind(OWNER_MEMBERSHIP_ID)
      .run();

    await db
      .prepare(
        `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
         VALUES ('corrupt-grant-2', ?, 'totally.fake.permission', 'AGENCY')`,
      )
      .bind(OWNER_MEMBERSHIP_ID)
      .run();

    const context = createOwnerContext();

    try {
      // Normal permission should still be ALLOW with AGENCY (not narrowed to ASSIGNED)
      const normalResult = await evaluateAuthorization(
        db,
        {
          context,
          permissionCode: 'customer.read',
          agencyId: TEST_AGENCY,
          resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
        },
        { resolvers: TEST_RESOLVERS },
      );
      expect(normalResult.decision).toBe('ALLOW');
      expect(normalResult.effectiveScope).toBe('AGENCY');

      // Unknown permission cannot grant authority
      const fakeResult = await evaluateAuthorization(db, {
        context,
        permissionCode: 'totally.fake.permission',
        agencyId: TEST_AGENCY,
      });
      expect(fakeResult.decision).toBe('DENY');
      expect(['UNKNOWN_ACTION', 'UNKNOWN_PERMISSION']).toContain(fakeResult.code);
    } finally {
      // Clean up corrupt rows
      await db
        .prepare(
          "DELETE FROM membership_permissions WHERE id IN ('corrupt-grant-1', 'corrupt-grant-2')",
        )
        .run();
    }
  });

  // ---------------------------------------------------------------------------
  // 5. OWNER SENSITIVE missing explicit -> DENY
  // ---------------------------------------------------------------------------
  it('5. OWNER SENSITIVE missing explicit -> DENY (OWNER_SENSITIVE_GRANT_REQUIRED)', async () => {
    const context = createOwnerContext();
    const result = await evaluateAuthorization(
      db,
      {
        context,
        action: 'customer.view_sensitive_identity',
        agencyId: TEST_AGENCY,
        resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
      },
      { actions: TEST_ACTIONS, resolvers: TEST_RESOLVERS },
    );

    expect(result.decision).toBe('DENY');
    expect(result.code).toBe('OWNER_SENSITIVE_GRANT_REQUIRED');
  });

  // ---------------------------------------------------------------------------
  // 6. OWNER and MEMBER SENSITIVE explicit valid grant; SECURE_GRANT still DENY
  // ---------------------------------------------------------------------------
  it('6. OWNER and MEMBER SENSITIVE explicit valid grant reach remaining gates; SECURE_GRANT still DENY', async () => {
    // 6a: Explicit sensitive grant for owner
    await grantPermission(db, {
      agencyId: TEST_AGENCY,
      membershipId: OWNER_MEMBERSHIP_ID,
      permissionCode: 'sensitive.identity.read',
      scope: 'UNSCOPED',
      expectedPermissionVersion: 1,
    });

    const ownerCtx = createOwnerContext({
      memberships: [
        {
          id: OWNER_MEMBERSHIP_ID,
          agencyId: TEST_AGENCY,
          type: 'OWNER',
          status: 'ACTIVE',
          permissionVersion: 2,
        },
      ],
    });

    const sensitiveResult = await evaluateAuthorization(
      db,
      {
        context: ownerCtx,
        action: 'customer.view_sensitive_identity',
        agencyId: TEST_AGENCY,
        resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
      },
      { actions: TEST_ACTIONS, resolvers: TEST_RESOLVERS },
    );
    expect(sensitiveResult.decision).toBe('ALLOW');
    expect(sensitiveResult.effectiveScope).toBe('AGENCY');

    // 6b: SECURE_GRANT (e.g. export.scoped) must always DENY in T07 even with SECURE assurance
    const secureCtx = createOwnerContext({
      assurance: 'SECURE',
      memberships: [
        {
          id: OWNER_MEMBERSHIP_ID,
          agencyId: TEST_AGENCY,
          type: 'OWNER',
          status: 'ACTIVE',
          permissionVersion: 2,
        },
      ],
    });
    const secureResult = await evaluateAuthorization(db, {
      context: secureCtx,
      permissionCode: 'export.scoped',
      agencyId: TEST_AGENCY,
    });
    expect(secureResult.decision).toBe('DENY');
    expect(secureResult.code).toBe('SECURE_GRANT_REQUIRED');
  });

  // ---------------------------------------------------------------------------
  // 7. Inactive/corrupt user, identity, agency, membership context -> DENY
  // ---------------------------------------------------------------------------
  it('7. Inactive/corrupt user, identity, agency, membership context -> DENY (INVALID_CONTEXT)', async () => {
    const corruptContexts = [
      null,
      undefined,
      {},
      { userId: '' },
      { userId: 'u1', identityId: 'i1', assurance: 'NORMAL', memberships: [] },
      {
        userId: 'u1',
        identityId: 'i1',
        assurance: 'NORMAL',
        memberships: [
          {
            id: 'm1',
            agencyId: TEST_AGENCY,
            type: 'MEMBER',
            status: 'SUSPENDED',
            permissionVersion: 1,
          },
        ],
      },
      {
        userId: 'u1',
        identityId: 'i1',
        assurance: 'NORMAL',
        memberships: [
          {
            id: 'm1',
            agencyId: TEST_AGENCY,
            type: 'MEMBER',
            status: 'INACTIVE',
            permissionVersion: 1,
          },
        ],
      },
      {
        userId: 'u1',
        identityId: 'i1',
        assurance: 'INVALID_ASSURANCE',
        memberships: [
          {
            id: 'm1',
            agencyId: TEST_AGENCY,
            type: 'MEMBER',
            status: 'ACTIVE',
            permissionVersion: 1,
          },
        ],
      },
    ];

    for (const ctx of corruptContexts) {
      const result = await evaluateAuthorization(db, {
        context: ctx as unknown as AuthenticatedUserContext,
        permissionCode: 'customer.read',
        agencyId: TEST_AGENCY,
      });
      expect(result.decision).toBe('DENY');
      expect(result.code).toBe('INVALID_CONTEXT');
    }
  });

  // ---------------------------------------------------------------------------
  // 8. Unknown/malformed permission/action/catalog metadata -> DENY
  // ---------------------------------------------------------------------------
  it('8. Unknown/malformed permission/action/catalog metadata -> DENY', async () => {
    const context = createOwnerContext({
      memberships: [
        {
          id: OWNER_MEMBERSHIP_ID,
          agencyId: TEST_AGENCY,
          type: 'OWNER',
          status: 'ACTIVE',
          permissionVersion: 2,
        },
      ],
    });

    const badInputs = [
      '',
      ' ',
      'CUSTOMER.READ',
      ' customer.read ',
      'customer.read\n',
      'nonexistent.code',
      123,
      null,
      undefined,
    ];

    for (const input of badInputs) {
      const result = await evaluateAuthorization(db, {
        context,
        permissionCode: input as unknown as string,
        agencyId: TEST_AGENCY,
      });
      expect(result.decision).toBe('DENY');
      expect(['MALFORMED_INPUT', 'UNKNOWN_PERMISSION', 'UNKNOWN_ACTION']).toContain(result.code);
    }
  });

  // ---------------------------------------------------------------------------
  // 9. UNSCOPED/RECORD_SCOPED malformed stored scopes -> DENY
  // ---------------------------------------------------------------------------
  it('9. UNSCOPED/RECORD_SCOPED malformed stored scopes -> DENY (INVALID_STORED_SCOPE)', async () => {
    // Directly insert invalid scope for RECORD_SCOPED permission
    await db
      .prepare(
        `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
         VALUES ('bad-scope-1', ?, 'policy.read', 'UNSCOPED')`,
      )
      .bind(MEMBER_MEMBERSHIP_ID)
      .run();

    const context = createMemberContext({
      memberships: [
        {
          id: MEMBER_MEMBERSHIP_ID,
          agencyId: TEST_AGENCY,
          type: 'MEMBER',
          status: 'ACTIVE',
          permissionVersion: 2,
        },
      ],
    });
    const result = await evaluateAuthorization(
      db,
      {
        context,
        permissionCode: 'policy.read',
        agencyId: TEST_AGENCY,
        resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
      },
      { resolvers: TEST_RESOLVERS },
    );

    expect(result.decision).toBe('DENY');
    expect(result.code).toBe('INVALID_STORED_SCOPE');

    await db.prepare("DELETE FROM membership_permissions WHERE id = 'bad-scope-1'").run();
  });

  // ---------------------------------------------------------------------------
  // 10. Missing, malformed, narrower, unknown dependency -> DENY
  // ---------------------------------------------------------------------------
  it('10. Missing, malformed, narrower, unknown dependency -> DENY', async () => {
    const newMemberId = 't07-member-dep-mem';
    const newUserId = 't07-member-dep-user';
    const newIdentId = 't07-member-dep-ident';
    await db
      .prepare("INSERT INTO users (id, status, version) VALUES (?, 'ACTIVE', 1)")
      .bind(newUserId)
      .run();
    await db
      .prepare(
        `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
         VALUES (?, ?, 'https://test.access.com', 'dep-sub', 'dep@test.com', 'ACTIVE')`,
      )
      .bind(newIdentId, newUserId)
      .run();
    await db
      .prepare(
        `INSERT INTO agency_memberships (
           id, agency_id, user_id, type, status, invitation_email, invitation_expires_at,
           activated_at, version, permission_version
         ) VALUES (?, ?, ?, 'MEMBER', 'ACTIVE', 'dep@test.com', '2099-01-01T00:00:00.000Z',
           (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), 1, 1)`,
      )
      .bind(newMemberId, TEST_AGENCY, newUserId)
      .run();

    await db
      .prepare(
        `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
         VALUES ('direct-update', ?, 'customer.update', 'AGENCY')`,
      )
      .bind(newMemberId)
      .run();

    const context = {
      userId: newUserId,
      identityId: newIdentId,
      assurance: 'NORMAL' as const,
      memberships: [
        {
          id: newMemberId,
          agencyId: TEST_AGENCY,
          type: 'MEMBER' as const,
          status: 'ACTIVE' as const,
          permissionVersion: 1,
        },
      ],
    };

    // Missing dependency customer.read -> DENY
    const missingDepResult = await evaluateAuthorization(
      db,
      {
        context,
        permissionCode: 'customer.update',
        agencyId: TEST_AGENCY,
        resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
      },
      { resolvers: TEST_RESOLVERS },
    );
    expect(missingDepResult.decision).toBe('DENY');
    expect(missingDepResult.code).toBe('DEPENDENCY_MISSING');

    // 10b: customer.read is ASSIGNED, but customer.update is AGENCY (narrower dependency) -> DENY
    await db
      .prepare(
        `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
         VALUES ('narrower-dep', ?, 'customer.read', 'ASSIGNED')`,
      )
      .bind(newMemberId)
      .run();

    const narrowerResult = await evaluateAuthorization(
      db,
      {
        context,
        permissionCode: 'customer.update',
        agencyId: TEST_AGENCY,
        resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
      },
      { resolvers: TEST_RESOLVERS },
    );
    expect(narrowerResult.decision).toBe('DENY');
    expect(narrowerResult.code).toBe('DEPENDENCY_SCOPE_TOO_NARROW');

    // Clean up
    await db
      .prepare('DELETE FROM membership_permissions WHERE membership_id = ?')
      .bind(newMemberId)
      .run();
    await db
      .prepare(
        `UPDATE agency_memberships
         SET status = 'INACTIVE',
             inactivated_at = '2026-09-17T00:00:00.000Z',
             version = version + 1,
             permission_version = permission_version + 1
         WHERE id = ?`,
      )
      .bind(newMemberId)
      .run();
  });

  it('M3-T01 task.read accepts a server-confirmed Renewal parent without customer.read', async () => {
    const membershipId = 't07-task-parent-member';
    const userId = 't07-task-parent-user';
    const identityId = 't07-task-parent-identity';
    await db
      .prepare("INSERT INTO users (id,status,version) VALUES (?,'ACTIVE',1)")
      .bind(userId)
      .run();
    await db
      .prepare(
        `INSERT INTO auth_identities(id,user_id,issuer,subject,verified_email,status)
         VALUES (?,?,'https://test.access.com','task-parent-sub','task-parent@test.com','ACTIVE')`,
      )
      .bind(identityId, userId)
      .run();
    await db
      .prepare(
        `INSERT INTO agency_memberships
           (id,agency_id,user_id,type,status,invitation_email,invitation_expires_at,
            activated_at,version,permission_version)
         VALUES (?,?,?,'MEMBER','ACTIVE','task-parent@test.com','2099-01-01T00:00:00.000Z',
           '2026-09-17T00:00:00.000Z',1,1)`,
      )
      .bind(membershipId, TEST_AGENCY, userId)
      .run();
    await db
      .prepare(
        `INSERT INTO membership_permissions(id,membership_id,permission_code,scope)
         VALUES ('task-parent-read','${membershipId}','task.read','ASSIGNED')`,
      )
      .run();
    const context = {
      userId,
      identityId,
      assurance: 'NORMAL' as const,
      memberships: [
        {
          id: membershipId,
          agencyId: TEST_AGENCY,
          type: 'MEMBER' as const,
          status: 'ACTIVE' as const,
          permissionVersion: 1,
        },
      ],
    };
    const resource = {
      agencyId: TEST_AGENCY,
      isAllowedRecord: true,
      parentReadAuthorized: true,
      taskAssigneeMembershipId: membershipId,
      renewalAssigneeMembershipId: membershipId,
      policyAssigneeMembershipId: 'another-policy-member',
      customerAssigneeMembershipId: 'another-customer-member',
    };

    try {
      const withRenewalParentRead = await evaluateAuthorization(
        db,
        { context, permissionCode: 'task.read', agencyId: TEST_AGENCY, resource },
        { resolvers: TEST_RESOLVERS },
      );
      expect(withRenewalParentRead.decision).toBe('ALLOW');

      const missingParentProof = await evaluateAuthorization(
        db,
        {
          context,
          permissionCode: 'task.read',
          agencyId: TEST_AGENCY,
          resource: { ...resource, parentReadAuthorized: false },
        },
        { resolvers: TEST_RESOLVERS },
      );
      expect(missingParentProof.decision).toBe('DENY');
    } finally {
      await db
        .prepare('DELETE FROM membership_permissions WHERE membership_id=?')
        .bind(membershipId)
        .run();
      await db
        .prepare(
          `UPDATE agency_memberships SET status='INACTIVE',inactivated_at='2026-09-18T00:00:00.000Z',
             version=version+1,permission_version=permission_version+1 WHERE id=?`,
        )
        .bind(membershipId)
        .run();
      await db
        .prepare(
          `UPDATE auth_identities SET status='REVOKED',revoked_at='2099-01-01T00:00:00.000Z',
             version=version+1,updated_at='2099-01-01T00:00:00.000Z' WHERE id=?`,
        )
        .bind(identityId)
        .run();
      await db
        .prepare("UPDATE users SET status='INACTIVE',version=version+1 WHERE id=?")
        .bind(userId)
        .run();
    }
  });

  // ---------------------------------------------------------------------------
  // 11. Cross-agency context/resource -> DENY
  // ---------------------------------------------------------------------------
  it('11. Cross-agency context/resource -> DENY (MEMBERSHIP_NOT_FOUND or AGENCY_MISMATCH)', async () => {
    const context = createOwnerContext({
      memberships: [
        {
          id: OWNER_MEMBERSHIP_ID,
          agencyId: TEST_AGENCY,
          type: 'OWNER',
          status: 'ACTIVE',
          permissionVersion: 2,
        },
      ],
    });

    // User only has membership in TEST_AGENCY, attempting to authorize in OTHER_AGENCY
    const crossAgencyResult = await evaluateAuthorization(db, {
      context,
      permissionCode: 'customer.create',
      agencyId: OTHER_AGENCY,
    });
    expect(crossAgencyResult.decision).toBe('DENY');
    expect(crossAgencyResult.code).toBe('MEMBERSHIP_NOT_FOUND');

    // Resource from other agency passed to same-agency request
    const crossResourceResult = await evaluateAuthorization(db, {
      context,
      permissionCode: 'customer.read',
      agencyId: TEST_AGENCY,
      resource: { agencyId: OTHER_AGENCY, id: 'cust-99' },
    });
    expect(crossResourceResult.decision).toBe('DENY');
    expect(crossResourceResult.code).toBe('AGENCY_MISMATCH');
  });

  // ---------------------------------------------------------------------------
  // 12. ASSIGNED pass/fail and AGENCY pass; resolver throw/error -> DENY
  // ---------------------------------------------------------------------------
  it('12. ASSIGNED pass/fail and AGENCY pass with injected resolver; resolver throw/error -> DENY', async () => {
    const memberCtx = createMemberContext({
      memberships: [
        {
          id: MEMBER_MEMBERSHIP_ID,
          agencyId: TEST_AGENCY,
          type: 'MEMBER',
          status: 'ACTIVE',
          permissionVersion: 2,
        },
      ],
    });

    // Injected resolver checks explicit property
    const passResult = await evaluateAuthorization(
      db,
      {
        context: memberCtx,
        permissionCode: 'customer.read',
        agencyId: TEST_AGENCY,
        resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
      },
      { resolvers: TEST_RESOLVERS },
    );
    expect(passResult.decision).toBe('ALLOW');
    expect(passResult.effectiveScope).toBe('ASSIGNED');

    // Injected resolver returns false for unauthorized record -> DENY
    const failResult = await evaluateAuthorization(
      db,
      {
        context: memberCtx,
        permissionCode: 'customer.read',
        agencyId: TEST_AGENCY,
        resource: { agencyId: TEST_AGENCY, isAllowedRecord: false },
      },
      { resolvers: TEST_RESOLVERS },
    );
    expect(failResult.decision).toBe('DENY');
    expect(failResult.code).toBe('SCOPE_RESOLVER_DENIED');

    // Resolver throwing an error -> DENY (SCOPE_RESOLVER_ERROR)
    const explodeResolvers: Partial<ScopeResolverRegistry> = {
      customer_record_resolver: () => {
        throw new Error('Resolver explosion');
      },
    };
    const errorResult = await evaluateAuthorization(
      db,
      {
        context: memberCtx,
        permissionCode: 'customer.read',
        agencyId: TEST_AGENCY,
        resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
      },
      { resolvers: explodeResolvers },
    );
    expect(errorResult.decision).toBe('DENY');
    expect(errorResult.code).toBe('SCOPE_RESOLVER_ERROR');
  });

  // ---------------------------------------------------------------------------
  // 13. Client/token role, agency, assignee, permissions irrelevant
  // ---------------------------------------------------------------------------
  it('13. Client/token role, agency, assignee, permissions claims are completely ignored', async () => {
    const attackerContext = {
      ...createMemberContext({
        memberships: [
          {
            id: MEMBER_MEMBERSHIP_ID,
            agencyId: TEST_AGENCY,
            type: 'MEMBER',
            status: 'ACTIVE',
            permissionVersion: 2,
          },
        ],
      }),
      role: 'ADMIN',
      isOwner: true,
      permissions: ['*'],
      agency: TEST_AGENCY,
      assignee: 'me',
    };

    const requestWithSpoofs = {
      context: attackerContext,
      permissionCode: 'policy.archive', // Member does not have this
      agencyId: TEST_AGENCY,
      role: 'OWNER',
      assignee: MEMBER_USER_ID,
      isOwner: true,
      resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
    };

    const result = await evaluateAuthorization(
      db,
      requestWithSpoofs as unknown as AuthorizationRequest,
    );
    expect(result.decision).toBe('DENY');
    expect(result.code).toBe('PERMISSION_NOT_GRANTED');
  });

  // ---------------------------------------------------------------------------
  // 14. Direct SQL corrupt grant cannot create authority
  // ---------------------------------------------------------------------------
  it('14. Direct SQL corrupt grant cannot create authority', async () => {
    const context = createMemberContext({
      memberships: [
        {
          id: MEMBER_MEMBERSHIP_ID,
          agencyId: TEST_AGENCY,
          type: 'MEMBER',
          status: 'ACTIVE',
          permissionVersion: 2,
        },
      ],
    });

    // Direct SQL inserts an unknown permission code grant
    await db
      .prepare(
        `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
         VALUES ('corrupt-unknown-grant', ?, 'completely.fake.permission', 'UNSCOPED')`,
      )
      .bind(MEMBER_MEMBERSHIP_ID)
      .run();

    try {
      const unknownResult = await evaluateAuthorization(db, {
        context,
        permissionCode: 'completely.fake.permission',
        agencyId: TEST_AGENCY,
      });
      expect(unknownResult.decision).toBe('DENY');
      expect(unknownResult.code).toBe('UNKNOWN_PERMISSION');
    } finally {
      // Clean up
      await db
        .prepare("DELETE FROM membership_permissions WHERE id = 'corrupt-unknown-grant'")
        .run();
    }
  });

  // ---------------------------------------------------------------------------
  // 15. Permission lookup failure and malformed D1 envelopes -> DENY
  // ---------------------------------------------------------------------------
  it('15. Permission lookup failure and malformed D1 envelopes -> DENY (DATABASE_ERROR)', async () => {
    const mockDbFailure: D1Database = {
      prepare: () => ({
        bind: () => ({
          all: async () => {
            throw new Error('D1 connection lost');
          },
        }),
      }),
    } as unknown as D1Database;

    const context = createMemberContext({
      memberships: [
        {
          id: MEMBER_MEMBERSHIP_ID,
          agencyId: TEST_AGENCY,
          type: 'MEMBER',
          status: 'ACTIVE',
          permissionVersion: 2,
        },
      ],
    });
    const result = await evaluateAuthorization(mockDbFailure, {
      context,
      permissionCode: 'customer.read',
      agencyId: TEST_AGENCY,
      resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
    });

    expect(result.decision).toBe('DENY');
    expect(result.code).toBe('DATABASE_ERROR');
  });

  // ---------------------------------------------------------------------------
  // 16. Factory creation and absence of test bypass hooks
  // ---------------------------------------------------------------------------
  it('16. createAuthorizationEvaluator creates functional evaluator with no bypass hooks', async () => {
    const evaluator = createAuthorizationEvaluator({ db, resolvers: TEST_RESOLVERS });
    const context = createOwnerContext({
      memberships: [
        {
          id: OWNER_MEMBERSHIP_ID,
          agencyId: TEST_AGENCY,
          type: 'OWNER',
          status: 'ACTIVE',
          permissionVersion: 2,
        },
      ],
    });

    const result = await evaluator.authorize({
      context,
      permissionCode: 'customer.read',
      agencyId: TEST_AGENCY,
      resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
    });

    expect(result.decision).toBe('ALLOW');
    expect(result.code).toBe('ALLOWED');
    expect(result.effectiveScope).toBe('AGENCY');
  });

  // ---------------------------------------------------------------------------
  // I-01: Live Persisted Lifecycle & Version State Recheck Tests
  // ---------------------------------------------------------------------------
  describe('I-01 Live persisted lifecycle/version state recheck', () => {
    it('I-01a: Suspended membership in DB causes immediate DENY, even for OWNER NORMAL', async () => {
      const liveOwnerCtx = createOwnerContext({
        memberships: [
          {
            id: OWNER_MEMBERSHIP_ID,
            agencyId: TEST_AGENCY,
            type: 'OWNER',
            status: 'ACTIVE',
            permissionVersion: 2,
          },
        ],
      });

      // Suspend owner membership in DB
      await db
        .prepare(
          `UPDATE agency_memberships
           SET status = 'SUSPENDED',
               suspended_at = '2026-09-17T00:00:00.000Z',
               version = version + 1,
               permission_version = permission_version + 1
           WHERE id = ?`,
        )
        .bind(OWNER_MEMBERSHIP_ID)
        .run();

      const result = await evaluateAuthorization(db, {
        context: liveOwnerCtx,
        permissionCode: 'customer.create',
        agencyId: TEST_AGENCY,
      });

      expect(result.decision).toBe('DENY');
      expect(['MEMBERSHIP_INACTIVE', 'INVALID_CONTEXT']).toContain(result.code);

      // Reactivate owner membership
      await db
        .prepare(
          `UPDATE agency_memberships
           SET status = 'ACTIVE',
               suspended_at = NULL,
               version = version + 1,
               permission_version = permission_version + 1
           WHERE id = ?`,
        )
        .bind(OWNER_MEMBERSHIP_ID)
        .run();
    });

    it('I-01b: Inactive User in DB causes immediate DENY, even for OWNER NORMAL', async () => {
      // Deactivate user in DB
      await db
        .prepare("UPDATE users SET status = 'INACTIVE', version = version + 1 WHERE id = ?")
        .bind(OWNER_USER_ID)
        .run();

      const liveOwnerCtx = createOwnerContext({
        memberships: [
          {
            id: OWNER_MEMBERSHIP_ID,
            agencyId: TEST_AGENCY,
            type: 'OWNER',
            status: 'ACTIVE',
            permissionVersion: 4,
          },
        ],
      });

      const result = await evaluateAuthorization(db, {
        context: liveOwnerCtx,
        permissionCode: 'customer.create',
        agencyId: TEST_AGENCY,
      });

      expect(result.decision).toBe('DENY');
      expect(['USER_INACTIVE', 'INVALID_CONTEXT']).toContain(result.code);

      // Reactivate user in DB
      await db
        .prepare("UPDATE users SET status = 'ACTIVE', version = version + 1 WHERE id = ?")
        .bind(OWNER_USER_ID)
        .run();
    });

    it('I-01c: Stale context permission_version causes DENY (concurrency/stale token protection)', async () => {
      // DB currently has permission_version 4 for OWNER_MEMBERSHIP_ID
      const staleContext = createOwnerContext({
        memberships: [
          {
            id: OWNER_MEMBERSHIP_ID,
            agencyId: TEST_AGENCY,
            type: 'OWNER',
            status: 'ACTIVE',
            permissionVersion: 1, // STALE! Live DB has 4
          },
        ],
      });

      const result = await evaluateAuthorization(db, {
        context: staleContext,
        permissionCode: 'customer.create',
        agencyId: TEST_AGENCY,
      });

      expect(result.decision).toBe('DENY');
      expect(['MEMBERSHIP_INACTIVE', 'INVALID_CONTEXT']).toContain(result.code);
    });

    it('I-01d: Revoked AuthIdentity causes DENY', async () => {
      await db
        .prepare(
          `UPDATE auth_identities
           SET status = 'REVOKED', revoked_at = '2026-09-17T00:00:00.000Z', version = version + 1
           WHERE id = ?`,
        )
        .bind(OWNER_IDENTITY_ID)
        .run();

      const liveOwnerCtx = createOwnerContext({
        memberships: [
          {
            id: OWNER_MEMBERSHIP_ID,
            agencyId: TEST_AGENCY,
            type: 'OWNER',
            status: 'ACTIVE',
            permissionVersion: 4,
          },
        ],
      });

      const result = await evaluateAuthorization(db, {
        context: liveOwnerCtx,
        permissionCode: 'customer.create',
        agencyId: TEST_AGENCY,
      });

      expect(result.decision).toBe('DENY');
      expect(result.code).toBe('INVALID_CONTEXT');

      // Restore active identity
      await db
        .prepare(
          `UPDATE auth_identities
           SET status = 'ACTIVE', revoked_at = NULL, version = version + 1
           WHERE id = ?`,
        )
        .bind(OWNER_IDENTITY_ID)
        .run();
    });
  });

  // ---------------------------------------------------------------------------
  // I-02: Scope Resolvers Fail-Closed Production Defaults & Injected Fixture
  // ---------------------------------------------------------------------------
  describe('I-02 Scope resolvers fail-closed production defaults', () => {
    it('I-02a: Crafted resource with assignedUserId/assigneeId/assignedTo CANNOT ALLOW through default production resolvers', async () => {
      const memberCtx = createMemberContext({
        memberships: [
          {
            id: MEMBER_MEMBERSHIP_ID,
            agencyId: TEST_AGENCY,
            type: 'MEMBER',
            status: 'ACTIVE',
            permissionVersion: 2,
          },
        ],
      });

      // Crafted resource with multiple alias fields
      const craftedResource = {
        agencyId: TEST_AGENCY,
        assignedUserId: MEMBER_USER_ID,
        assignedMembershipId: MEMBER_MEMBERSHIP_ID,
        assigneeUserId: MEMBER_USER_ID,
        assigneeId: MEMBER_USER_ID,
        assignedTo: MEMBER_USER_ID,
      };

      // Call WITHOUT custom resolvers (using production defaults)
      const result = await evaluateAuthorization(db, {
        context: memberCtx,
        permissionCode: 'customer.read',
        agencyId: TEST_AGENCY,
        resource: craftedResource,
      });

      // Must be rejected by fail-closed production default
      expect(result.decision).toBe('DENY');
      expect(result.code).toBe('SCOPE_RESOLVER_DENIED');
    });

    it('I-02b: Injected trusted server-side resolver controls evaluation', async () => {
      const memberCtx = createMemberContext({
        memberships: [
          {
            id: MEMBER_MEMBERSHIP_ID,
            agencyId: TEST_AGENCY,
            type: 'MEMBER',
            status: 'ACTIVE',
            permissionVersion: 2,
          },
        ],
      });

      const allowedRes = { agencyId: TEST_AGENCY, isAllowedRecord: true };
      const deniedRes = { agencyId: TEST_AGENCY, isAllowedRecord: false };

      const allowResult = await evaluateAuthorization(
        db,
        {
          context: memberCtx,
          permissionCode: 'customer.read',
          agencyId: TEST_AGENCY,
          resource: allowedRes,
        },
        { resolvers: TEST_RESOLVERS },
      );
      expect(allowResult.decision).toBe('ALLOW');

      const denyResult = await evaluateAuthorization(
        db,
        {
          context: memberCtx,
          permissionCode: 'customer.read',
          agencyId: TEST_AGENCY,
          resource: deniedRes,
        },
        { resolvers: TEST_RESOLVERS },
      );
      expect(denyResult.decision).toBe('DENY');
      expect(denyResult.code).toBe('SCOPE_RESOLVER_DENIED');
    });
  });

  // ---------------------------------------------------------------------------
  // I-03: Persisted Corruption Validation & Coexistence
  // ---------------------------------------------------------------------------
  describe('I-03 Persisted corruption validation', () => {
    it('I-03a: Valid target grant coexisting with an unknown permission code grant fails closed', async () => {
      // Member has valid customer.read grant. Add corrupt unknown grant.
      await db
        .prepare(
          `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
           VALUES ('corrupt-unknown-grant', ?, 'completely.fake.permission', 'UNSCOPED')`,
        )
        .bind(MEMBER_MEMBERSHIP_ID)
        .run();

      const memberCtx = createMemberContext({
        memberships: [
          {
            id: MEMBER_MEMBERSHIP_ID,
            agencyId: TEST_AGENCY,
            type: 'MEMBER',
            status: 'ACTIVE',
            permissionVersion: 2,
          },
        ],
      });

      const result = await evaluateAuthorization(
        db,
        {
          context: memberCtx,
          permissionCode: 'customer.read',
          agencyId: TEST_AGENCY,
          resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
        },
        { resolvers: TEST_RESOLVERS },
      );

      expect(result.decision).toBe('DENY');
      expect(['INVALID_STORED_GRANT', 'UNKNOWN_PERMISSION', 'DATABASE_ERROR']).toContain(
        result.code,
      );

      await db
        .prepare("DELETE FROM membership_permissions WHERE id = 'corrupt-unknown-grant'")
        .run();
    });

    it('I-03b: Valid target grant coexisting with a malformed scope on another grant fails closed', async () => {
      // Insert malformed scope grant for policy.read (UNSCOPED instead of RECORD_SCOPED)
      await db
        .prepare(
          `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
           VALUES ('corrupt-malformed-scope', ?, 'policy.read', 'UNSCOPED')`,
        )
        .bind(MEMBER_MEMBERSHIP_ID)
        .run();

      const memberCtx = createMemberContext({
        memberships: [
          {
            id: MEMBER_MEMBERSHIP_ID,
            agencyId: TEST_AGENCY,
            type: 'MEMBER',
            status: 'ACTIVE',
            permissionVersion: 2,
          },
        ],
      });

      const result = await evaluateAuthorization(
        db,
        {
          context: memberCtx,
          permissionCode: 'customer.read',
          agencyId: TEST_AGENCY,
          resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
        },
        { resolvers: TEST_RESOLVERS },
      );

      expect(result.decision).toBe('DENY');
      expect(result.code).toBe('INVALID_STORED_SCOPE');

      await db
        .prepare("DELETE FROM membership_permissions WHERE id = 'corrupt-malformed-scope'")
        .run();
    });

    it('I-03c: Corrupt reverse dependent state fails closed even when evaluating dependency', async () => {
      // Member has customer.read (ASSIGNED). Add customer.update (AGENCY).
      await db
        .prepare(
          `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
           VALUES ('corrupt-reverse-dep', ?, 'customer.update', 'AGENCY')`,
        )
        .bind(MEMBER_MEMBERSHIP_ID)
        .run();

      const memberCtx = createMemberContext({
        memberships: [
          {
            id: MEMBER_MEMBERSHIP_ID,
            agencyId: TEST_AGENCY,
            type: 'MEMBER',
            status: 'ACTIVE',
            permissionVersion: 2,
          },
        ],
      });

      // Even when requesting customer.read, the corrupt reverse dependent state in the grant set must fail closed
      const result = await evaluateAuthorization(
        db,
        {
          context: memberCtx,
          permissionCode: 'customer.read',
          agencyId: TEST_AGENCY,
          resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
        },
        { resolvers: TEST_RESOLVERS },
      );

      expect(result.decision).toBe('DENY');
      expect([
        'DEPENDENCY_SCOPE_TOO_NARROW',
        'DEPENDENCY_INVALID',
        'INVALID_STORED_GRANT',
      ]).toContain(result.code);

      await db.prepare("DELETE FROM membership_permissions WHERE id = 'corrupt-reverse-dep'").run();
    });

    it('I-03d: OWNER NORMAL ignores corrupt MembershipPermission rows as authority', async () => {
      // Direct SQL inserts corrupt row for owner
      await db
        .prepare(
          `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
           VALUES ('owner-corrupt-grant', ?, 'customer.read', 'ASSIGNED')`,
        )
        .bind(OWNER_MEMBERSHIP_ID)
        .run();

      const ownerCtx = createOwnerContext({
        memberships: [
          {
            id: OWNER_MEMBERSHIP_ID,
            agencyId: TEST_AGENCY,
            type: 'OWNER',
            status: 'ACTIVE',
            permissionVersion: 4,
          },
        ],
      });

      // Owner normal must STILL succeed with AGENCY scope
      const result = await evaluateAuthorization(
        db,
        {
          context: ownerCtx,
          permissionCode: 'customer.read',
          agencyId: TEST_AGENCY,
          resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
        },
        { resolvers: TEST_RESOLVERS },
      );

      expect(result.decision).toBe('ALLOW');
      expect(result.effectiveScope).toBe('AGENCY');

      await db.prepare("DELETE FROM membership_permissions WHERE id = 'owner-corrupt-grant'").run();
    });
  });

  // ---------------------------------------------------------------------------
  // I-04: Record-scoped requires resource for final ALLOW
  // ---------------------------------------------------------------------------
  describe('I-04 Record-scoped requires resource for final ALLOW', () => {
    it('I-04a: RECORD_SCOPED permission without resource DENIES (MALFORMED_INPUT)', async () => {
      const memberCtx = createMemberContext({
        memberships: [
          {
            id: MEMBER_MEMBERSHIP_ID,
            agencyId: TEST_AGENCY,
            type: 'MEMBER',
            status: 'ACTIVE',
            permissionVersion: 2,
          },
        ],
      });

      const result = await evaluateAuthorization(db, {
        context: memberCtx,
        permissionCode: 'customer.read',
        agencyId: TEST_AGENCY,
        // resource deliberately omitted
      });

      expect(result.decision).toBe('DENY');
      expect(result.code).toBe('MALFORMED_INPUT');
    });

    it('I-04b: UNSCOPED permission does NOT require resource to ALLOW', async () => {
      const ownerCtx = createOwnerContext({
        memberships: [
          {
            id: OWNER_MEMBERSHIP_ID,
            agencyId: TEST_AGENCY,
            type: 'OWNER',
            status: 'ACTIVE',
            permissionVersion: 4,
          },
        ],
      });

      const result = await evaluateAuthorization(db, {
        context: ownerCtx,
        permissionCode: 'audit.read', // Truly UNSCOPED with 0 dependencies
        agencyId: TEST_AGENCY,
      });

      expect(result.decision).toBe('ALLOW');
      expect(result.effectiveScope).toBe('UNSCOPED');
    });
  });

  // ---------------------------------------------------------------------------
  // Additional Corrections: Exact IDs (No Trim Normalization)
  // ---------------------------------------------------------------------------
  describe('Exact IDs without trim normalization', () => {
    it('Trailing or leading whitespace in agencyId or resource.agencyId DENIES', async () => {
      const ownerCtx = createOwnerContext({
        memberships: [
          {
            id: OWNER_MEMBERSHIP_ID,
            agencyId: TEST_AGENCY,
            type: 'OWNER',
            status: 'ACTIVE',
            permissionVersion: 4,
          },
        ],
      });

      // Whitespace in agencyId
      const badAgencyResult = await evaluateAuthorization(db, {
        context: ownerCtx,
        permissionCode: 'customer.create',
        agencyId: ` ${TEST_AGENCY} `,
      });
      expect(badAgencyResult.decision).toBe('DENY');
      expect(['MALFORMED_INPUT', 'MEMBERSHIP_NOT_FOUND']).toContain(badAgencyResult.code);

      // Whitespace in resource agencyId
      const badResourceResult = await evaluateAuthorization(
        db,
        {
          context: ownerCtx,
          permissionCode: 'customer.read',
          agencyId: TEST_AGENCY,
          resource: { agencyId: ` ${TEST_AGENCY} `, isAllowedRecord: true },
        },
        { resolvers: TEST_RESOLVERS },
      );
      expect(badResourceResult.decision).toBe('DENY');
      expect(['AGENCY_MISMATCH', 'MALFORMED_INPUT']).toContain(badResourceResult.code);
    });
  });

  // ---------------------------------------------------------------------------
  // I-05: Live lifecycle row relationships and schema validation
  // ---------------------------------------------------------------------------
  describe('I-05 Live lifecycle row relationship & schema validation', () => {
    const validOwnerRow = {
      identity_id: OWNER_IDENTITY_ID,
      identity_status: 'ACTIVE',
      user_id: OWNER_USER_ID,
      user_status: 'ACTIVE',
      membership_id: OWNER_MEMBERSHIP_ID,
      membership_status: 'ACTIVE',
      membership_type: 'OWNER',
      permission_version: 4,
      agency_id: TEST_AGENCY,
      agency_status: 'ACTIVE',
    };

    function createMockDb(envelope: unknown) {
      return {
        prepare: () => ({
          bind: () => ({
            all: async () => envelope,
            run: async () => ({ success: true }),
          }),
        }),
      } as unknown as D1Database;
    }

    it('I-05a: Mismatched IDs in coherent-looking active row must DENY with INVALID_CONTEXT (exercising OWNER NORMAL)', async () => {
      const ownerCtx = createOwnerContext({
        memberships: [
          {
            id: OWNER_MEMBERSHIP_ID,
            agencyId: TEST_AGENCY,
            type: 'OWNER',
            status: 'ACTIVE',
            permissionVersion: 4,
          },
        ],
      });

      // Mismatched identity_id
      const mismatchedIdentDb = createMockDb({
        success: true,
        results: [{ ...validOwnerRow, identity_id: 'adversarial-identity-id' }],
      });
      const res1 = await evaluateAuthorization(mismatchedIdentDb, {
        context: ownerCtx,
        permissionCode: 'customer.create',
        agencyId: TEST_AGENCY,
      });
      expect(res1.decision).toBe('DENY');
      expect(res1.code).toBe('INVALID_CONTEXT');

      // Mismatched user_id
      const mismatchedUserDb = createMockDb({
        success: true,
        results: [{ ...validOwnerRow, user_id: 'adversarial-user-id' }],
      });
      const res2 = await evaluateAuthorization(mismatchedUserDb, {
        context: ownerCtx,
        permissionCode: 'customer.create',
        agencyId: TEST_AGENCY,
      });
      expect(res2.decision).toBe('DENY');
      expect(res2.code).toBe('INVALID_CONTEXT');

      // Mismatched membership_id
      const mismatchedMemDb = createMockDb({
        success: true,
        results: [{ ...validOwnerRow, membership_id: 'adversarial-membership-id' }],
      });
      const res3 = await evaluateAuthorization(mismatchedMemDb, {
        context: ownerCtx,
        permissionCode: 'customer.create',
        agencyId: TEST_AGENCY,
      });
      expect(res3.decision).toBe('DENY');
      expect(res3.code).toBe('INVALID_CONTEXT');

      // Mismatched agency_id
      const mismatchedAgencyDb = createMockDb({
        success: true,
        results: [{ ...validOwnerRow, agency_id: 'adversarial-agency-id' }],
      });
      const res4 = await evaluateAuthorization(mismatchedAgencyDb, {
        context: ownerCtx,
        permissionCode: 'customer.create',
        agencyId: TEST_AGENCY,
      });
      expect(res4.decision).toBe('DENY');
      expect(res4.code).toBe('INVALID_CONTEXT');

      // Mismatched membership_type (e.g. returns MEMBER when context has OWNER)
      const mismatchedTypeDb = createMockDb({
        success: true,
        results: [{ ...validOwnerRow, membership_type: 'MEMBER' }],
      });
      const res5 = await evaluateAuthorization(mismatchedTypeDb, {
        context: ownerCtx,
        permissionCode: 'customer.create',
        agencyId: TEST_AGENCY,
      });
      expect(res5.decision).toBe('DENY');
      expect(res5.code).toBe('INVALID_CONTEXT');
    });

    it('I-05b: Missing fields in lifecycle row DENIES with DATABASE_ERROR', async () => {
      const ownerCtx = createOwnerContext({
        memberships: [
          {
            id: OWNER_MEMBERSHIP_ID,
            agencyId: TEST_AGENCY,
            type: 'OWNER',
            status: 'ACTIVE',
            permissionVersion: 4,
          },
        ],
      });

      const requiredKeys = Object.keys(validOwnerRow);
      for (const key of requiredKeys) {
        const incompleteRow = { ...validOwnerRow } as Record<string, unknown>;
        delete incompleteRow[key];

        const mockDb = createMockDb({
          success: true,
          results: [incompleteRow],
        });

        const res = await evaluateAuthorization(mockDb, {
          context: ownerCtx,
          permissionCode: 'customer.create',
          agencyId: TEST_AGENCY,
        });

        expect(res.decision).toBe('DENY');
        expect(res.code).toBe('DATABASE_ERROR');
      }
    });

    it('I-05c: Null, array, or primitive row in lifecycle results DENIES with DATABASE_ERROR', async () => {
      const ownerCtx = createOwnerContext({
        memberships: [
          {
            id: OWNER_MEMBERSHIP_ID,
            agencyId: TEST_AGENCY,
            type: 'OWNER',
            status: 'ACTIVE',
            permissionVersion: 4,
          },
        ],
      });

      const malformedRows = [null, undefined, 42, 'string-row', ['array-row'], true];
      for (const badRow of malformedRows) {
        const mockDb = createMockDb({
          success: true,
          results: [badRow],
        });

        const res = await evaluateAuthorization(mockDb, {
          context: ownerCtx,
          permissionCode: 'customer.create',
          agencyId: TEST_AGENCY,
        });

        expect(res.decision).toBe('DENY');
        expect(res.code).toBe('DATABASE_ERROR');
      }
    });

    it('I-05d: Wrong field primitive types in lifecycle row DENIES with DATABASE_ERROR', async () => {
      const ownerCtx = createOwnerContext({
        memberships: [
          {
            id: OWNER_MEMBERSHIP_ID,
            agencyId: TEST_AGENCY,
            type: 'OWNER',
            status: 'ACTIVE',
            permissionVersion: 4,
          },
        ],
      });

      const badTypeCases = [
        { ...validOwnerRow, permission_version: '4' }, // string instead of number
        { ...validOwnerRow, permission_version: 4.5 }, // float instead of integer
        { ...validOwnerRow, permission_version: 0 }, // less than 1
        { ...validOwnerRow, user_id: 12345 }, // number instead of string
        { ...validOwnerRow, identity_id: ['array'] }, // array instead of string
        { ...validOwnerRow, agency_status: null }, // null instead of string
      ];

      for (const badRow of badTypeCases) {
        const mockDb = createMockDb({
          success: true,
          results: [badRow],
        });

        const res = await evaluateAuthorization(mockDb, {
          context: ownerCtx,
          permissionCode: 'customer.create',
          agencyId: TEST_AGENCY,
        });

        expect(res.decision).toBe('DENY');
        expect(res.code).toBe('DATABASE_ERROR');
      }
    });

    it('I-05e: Malformed envelope (success: false, non-array results, or throws) DENIES with DATABASE_ERROR', async () => {
      const ownerCtx = createOwnerContext({
        memberships: [
          {
            id: OWNER_MEMBERSHIP_ID,
            agencyId: TEST_AGENCY,
            type: 'OWNER',
            status: 'ACTIVE',
            permissionVersion: 4,
          },
        ],
      });

      const badEnvelopes = [
        { success: false, results: [validOwnerRow] },
        { success: true, results: 'not-an-array' },
        { success: true, results: null },
        { success: true, results: { row: validOwnerRow } },
        null,
        'string-envelope',
      ];

      for (const envelope of badEnvelopes) {
        const mockDb = createMockDb(envelope);
        const res = await evaluateAuthorization(mockDb, {
          context: ownerCtx,
          permissionCode: 'customer.create',
          agencyId: TEST_AGENCY,
        });

        expect(res.decision).toBe('DENY');
        expect(res.code).toBe('DATABASE_ERROR');
      }

      // DB throws
      const throwingDb = {
        prepare: () => {
          throw new Error('D1 engine crash');
        },
      } as unknown as D1Database;

      const resThrow = await evaluateAuthorization(throwingDb, {
        context: ownerCtx,
        permissionCode: 'customer.create',
        agencyId: TEST_AGENCY,
      });
      expect(resThrow.decision).toBe('DENY');
      expect(resThrow.code).toBe('DATABASE_ERROR');
    });

    it('I-05f: Duplicate or extra lifecycle rows DENIES with DATABASE_ERROR', async () => {
      const ownerCtx = createOwnerContext({
        memberships: [
          {
            id: OWNER_MEMBERSHIP_ID,
            agencyId: TEST_AGENCY,
            type: 'OWNER',
            status: 'ACTIVE',
            permissionVersion: 4,
          },
        ],
      });

      const mockDb = createMockDb({
        success: true,
        results: [validOwnerRow, validOwnerRow],
      });

      const res = await evaluateAuthorization(mockDb, {
        context: ownerCtx,
        permissionCode: 'customer.create',
        agencyId: TEST_AGENCY,
      });

      expect(res.decision).toBe('DENY');
      expect(res.code).toBe('DATABASE_ERROR');
    });
  });

  // ---------------------------------------------------------------------------
  // I-06: No Attacker-Controlled / Dynamic Values Echoed in Decision Messages
  // ---------------------------------------------------------------------------
  describe('I-06 No attacker-controlled values echoed in decision messages', () => {
    it('Distinctive attacker probe strings in stored grants or inputs are strictly absent from result', async () => {
      const ATTACKER_CODE = 'attacker.probe_x999_sqli_injection_code_999x';
      const ATTACKER_SCOPE = '__ATTACKER_INJECTED_SCOPE_PAYLOAD__';

      // Insert an attacker probe row in membership_permissions with valid DB scope but unknown permission code
      await db
        .prepare(
          `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
           VALUES ('attacker-probe-row', ?, ?, 'UNSCOPED')`,
        )
        .bind(MEMBER_MEMBERSHIP_ID, ATTACKER_CODE)
        .run();

      const memberCtx = createMemberContext({
        memberships: [
          {
            id: MEMBER_MEMBERSHIP_ID,
            agencyId: TEST_AGENCY,
            type: 'MEMBER',
            status: 'ACTIVE',
            permissionVersion: 2,
          },
        ],
      });

      // 1. Evaluate valid customer.read while attacker probe grant is in DB
      const res1 = await evaluateAuthorization(
        db,
        {
          context: memberCtx,
          permissionCode: 'customer.read',
          agencyId: TEST_AGENCY,
          resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
        },
        { resolvers: TEST_RESOLVERS },
      );

      expect(res1.decision).toBe('DENY');
      const json1 = JSON.stringify(res1);
      expect(json1).not.toContain(ATTACKER_CODE);
      expect(json1).not.toContain('sqli_injection');
      expect(json1).not.toContain('x999');

      // 2. Corrupt scope from DB adapter / storage layer
      const mockCorruptScopeDb = {
        prepare: (query: string) => {
          if (query.includes('FROM agency_memberships m')) {
            return {
              bind: () => ({
                all: async () => ({
                  success: true,
                  results: [
                    {
                      identity_id: MEMBER_IDENTITY_ID,
                      identity_status: 'ACTIVE',
                      user_id: MEMBER_USER_ID,
                      user_status: 'ACTIVE',
                      membership_id: MEMBER_MEMBERSHIP_ID,
                      membership_status: 'ACTIVE',
                      membership_type: 'MEMBER',
                      permission_version: 2,
                      agency_id: TEST_AGENCY,
                      agency_status: 'ACTIVE',
                    },
                  ],
                }),
              }),
            };
          }
          return {
            bind: () => ({
              all: async () => ({
                success: true,
                results: [
                  {
                    id: 'corrupt-scope-id',
                    membership_id: MEMBER_MEMBERSHIP_ID,
                    permission_code: 'customer.read',
                    scope: ATTACKER_SCOPE,
                  },
                ],
              }),
            }),
          };
        },
      } as unknown as D1Database;

      const resScope = await evaluateAuthorization(
        mockCorruptScopeDb,
        {
          context: memberCtx,
          permissionCode: 'customer.read',
          agencyId: TEST_AGENCY,
          resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
        },
        { resolvers: TEST_RESOLVERS },
      );

      expect(resScope.decision).toBe('DENY');
      const jsonScope = JSON.stringify(resScope);
      expect(jsonScope).not.toContain(ATTACKER_SCOPE);
      expect(jsonScope).not.toContain('PAYLOAD');

      // 3. Evaluate with attacker-supplied permissionCode input
      const ATTACKER_INPUT_CODE = 'probe.hacked_code_xyz123';
      const res2 = await evaluateAuthorization(db, {
        context: memberCtx,
        permissionCode: ATTACKER_INPUT_CODE,
        agencyId: TEST_AGENCY,
      });

      expect(res2.decision).toBe('DENY');
      const json2 = JSON.stringify(res2);
      expect(json2).not.toContain(ATTACKER_INPUT_CODE);
      expect(json2).not.toContain('hacked_code_xyz123');

      // 4. Evaluate with attacker-supplied agencyId
      const ATTACKER_AGENCY = 'malicious-agency-probe-777';
      const res3 = await evaluateAuthorization(db, {
        context: memberCtx,
        permissionCode: 'customer.read',
        agencyId: ATTACKER_AGENCY,
      });

      expect(res3.decision).toBe('DENY');
      const json3 = JSON.stringify(res3);
      expect(json3).not.toContain(ATTACKER_AGENCY);

      // Clean up attacker probe row
      await db.prepare("DELETE FROM membership_permissions WHERE id = 'attacker-probe-row'").run();
    });
  });

  // ---------------------------------------------------------------------------
  // Sol High BLOCKER-1: Standalone Sensitive vs Compound Sensitive Actions
  // ---------------------------------------------------------------------------
  describe('Sol High BLOCKER-1: Compound sensitive action evaluation', () => {
    it('Direct standalone sensitive permission code against default registry returns UNKNOWN_ACTION', async () => {
      const ownerCtx = createOwnerContext();

      const res = await evaluateAuthorization(db, {
        context: ownerCtx,
        action: 'sensitive.identity.read',
        agencyId: TEST_AGENCY,
      });

      expect(res.decision).toBe('DENY');
      expect(res.code).toBe('UNKNOWN_ACTION');
    });

    it('Member with only explicit sensitive.identity.read (no normal record grant) DENIES (PERMISSION_NOT_GRANTED)', async () => {
      const standMemberId = 't07-member-stand-mem';
      const standUserId = 't07-member-stand-user';
      const standIdentId = 't07-member-stand-ident';

      await db
        .prepare("INSERT INTO users (id, status, version) VALUES (?, 'ACTIVE', 1)")
        .bind(standUserId)
        .run();
      await db
        .prepare(
          `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
           VALUES (?, ?, 'https://test.access.com', 'stand-sub', 'stand@test.com', 'ACTIVE')`,
        )
        .bind(standIdentId, standUserId)
        .run();
      await db
        .prepare(
          `INSERT INTO agency_memberships (
             id, agency_id, user_id, type, status, invitation_email, invitation_expires_at,
             activated_at, version, permission_version
           ) VALUES (?, ?, ?, 'MEMBER', 'ACTIVE', 'stand@test.com', '2099-01-01T00:00:00.000Z',
             (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), 1, 1)`,
        )
        .bind(standMemberId, TEST_AGENCY, standUserId)
        .run();

      // Only grant sensitive.identity.read, NO normal permission grant
      await db
        .prepare(
          `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
           VALUES ('stand-grant-1', ?, 'sensitive.identity.read', 'UNSCOPED')`,
        )
        .bind(standMemberId)
        .run();

      const memberCtx: AuthenticatedUserContext = {
        userId: standUserId,
        identityId: standIdentId,
        assurance: 'NORMAL',
        memberships: [
          {
            id: standMemberId,
            agencyId: TEST_AGENCY,
            type: 'MEMBER',
            status: 'ACTIVE',
            permissionVersion: 1,
          },
        ],
      };

      // Compound action requiring customer.read + sensitive.identity.read
      const res = await evaluateAuthorization(
        db,
        {
          context: memberCtx,
          action: 'customer.view_sensitive_identity',
          agencyId: TEST_AGENCY,
          resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
        },
        { actions: TEST_ACTIONS, resolvers: TEST_RESOLVERS },
      );

      // Must fail closed because customer.read is not granted
      expect(res.decision).toBe('DENY');
      expect(res.code).toBe('PERMISSION_NOT_GRANTED');

      // Clean up
      await db
        .prepare('DELETE FROM membership_permissions WHERE membership_id = ?')
        .bind(standMemberId)
        .run();
      await db
        .prepare(
          `UPDATE agency_memberships
           SET status = 'INACTIVE',
               inactivated_at = '2026-09-17T00:00:00.000Z',
               version = version + 1,
               permission_version = permission_version + 1
           WHERE id = ?`,
        )
        .bind(standMemberId)
        .run();
    });

    it('Member with both normal and sensitive grants: missing resource -> MALFORMED_INPUT, resolver deny -> SCOPE_RESOLVER_DENIED, resolver allow -> ALLOW (ASSIGNED)', async () => {
      // Member already has customer.read (ASSIGNED) in test suite setup
      await grantPermission(db, {
        agencyId: TEST_AGENCY,
        membershipId: MEMBER_MEMBERSHIP_ID,
        permissionCode: 'sensitive.identity.read',
        scope: 'UNSCOPED',
        expectedPermissionVersion: 2,
      });

      const memberCtx = createMemberContext({
        memberships: [
          {
            id: MEMBER_MEMBERSHIP_ID,
            agencyId: TEST_AGENCY,
            type: 'MEMBER',
            status: 'ACTIVE',
            permissionVersion: 3,
          },
        ],
      });

      // 1. Missing resource
      const missingResResult = await evaluateAuthorization(
        db,
        {
          context: memberCtx,
          action: 'customer.view_sensitive_identity',
          agencyId: TEST_AGENCY,
          // resource omitted
        },
        { actions: TEST_ACTIONS, resolvers: TEST_RESOLVERS },
      );
      expect(missingResResult.decision).toBe('DENY');
      expect(missingResResult.code).toBe('MALFORMED_INPUT');

      // 2. Resource provided, but resolver denies
      const deniedResResult = await evaluateAuthorization(
        db,
        {
          context: memberCtx,
          action: 'customer.view_sensitive_identity',
          agencyId: TEST_AGENCY,
          resource: { agencyId: TEST_AGENCY, isAllowedRecord: false },
        },
        { actions: TEST_ACTIONS, resolvers: TEST_RESOLVERS },
      );
      expect(deniedResResult.decision).toBe('DENY');
      expect(deniedResResult.code).toBe('SCOPE_RESOLVER_DENIED');

      // 3. Resource provided, resolver allows -> ALLOW with ASSIGNED (intersection from customer.read)
      const allowedResResult = await evaluateAuthorization(
        db,
        {
          context: memberCtx,
          action: 'customer.view_sensitive_identity',
          agencyId: TEST_AGENCY,
          resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
        },
        { actions: TEST_ACTIONS, resolvers: TEST_RESOLVERS },
      );
      expect(allowedResResult.decision).toBe('ALLOW');
      expect(allowedResResult.effectiveScope).toBe('ASSIGNED');
    });
  });

  // ---------------------------------------------------------------------------
  // Sol High IMPORTANT-1: Unscoped action propagating record-scoped dependency
  // ---------------------------------------------------------------------------
  describe('Sol High IMPORTANT-1: Record-scoped dependency propagation', () => {
    it('Member with customer.create (UNSCOPED) and customer.read (ASSIGNED) enforces resource & resolver', async () => {
      // Grant customer.create to member
      await grantPermission(db, {
        agencyId: TEST_AGENCY,
        membershipId: MEMBER_MEMBERSHIP_ID,
        permissionCode: 'customer.create',
        scope: 'UNSCOPED',
        expectedPermissionVersion: 3,
      });

      const memberCtx = createMemberContext({
        memberships: [
          {
            id: MEMBER_MEMBERSHIP_ID,
            agencyId: TEST_AGENCY,
            type: 'MEMBER',
            status: 'ACTIVE',
            permissionVersion: 4,
          },
        ],
      });

      // 1. Without resource -> DENY (MALFORMED_INPUT)
      const noResResult = await evaluateAuthorization(
        db,
        {
          context: memberCtx,
          action: 'customer.create',
          agencyId: TEST_AGENCY,
        },
        { resolvers: TEST_RESOLVERS },
      );
      expect(noResResult.decision).toBe('DENY');
      expect(noResResult.code).toBe('MALFORMED_INPUT');

      // 2. With resource and failing resolver -> DENY (SCOPE_RESOLVER_DENIED)
      const failResolverResult = await evaluateAuthorization(
        db,
        {
          context: memberCtx,
          action: 'customer.create',
          agencyId: TEST_AGENCY,
          resource: { agencyId: TEST_AGENCY, isAllowedRecord: false },
        },
        { resolvers: TEST_RESOLVERS },
      );
      expect(failResolverResult.decision).toBe('DENY');
      expect(failResolverResult.code).toBe('SCOPE_RESOLVER_DENIED');

      // 3. With resource and passing resolver -> ALLOW with ASSIGNED (inherited from customer.read)
      const passResolverResult = await evaluateAuthorization(
        db,
        {
          context: memberCtx,
          action: 'customer.create',
          agencyId: TEST_AGENCY,
          resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
        },
        { resolvers: TEST_RESOLVERS },
      );
      expect(passResolverResult.decision).toBe('ALLOW');
      expect(passResolverResult.effectiveScope).toBe('ASSIGNED');
    });

    it('Compound action with multiple record requirements intersects to narrowest scope (ASSIGNED)', async () => {
      // Create a compound action requiring both customer.update (RECORD_SCOPED) and customer.read (RECORD_SCOPED)
      const compoundRecordAction = validateAndCreateActionDefinition({
        code: 'customer.full_update',
        authority: 'MEMBERSHIP_AUTHORIZED',
        requiredNormalPermissions: ['customer.update', 'customer.read'],
        requiredSensitivePermissions: [],
        assurance: 'NORMAL_SESSION',
      });

      const actionRegistry = new Map<string, ActionDefinition>([
        ...DEFAULT_ACTION_REGISTRY.entries(),
        [compoundRecordAction.code, compoundRecordAction],
      ]);

      const memberCtx = createMemberContext({
        memberships: [
          {
            id: MEMBER_MEMBERSHIP_ID,
            agencyId: TEST_AGENCY,
            type: 'MEMBER',
            status: 'ACTIVE',
            permissionVersion: 4,
          },
        ],
      });

      // customer.update is not granted yet -> missing dependency/grant DENY
      const missingResult = await evaluateAuthorization(
        db,
        {
          context: memberCtx,
          action: 'customer.full_update',
          agencyId: TEST_AGENCY,
          resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
        },
        { actions: actionRegistry, resolvers: TEST_RESOLVERS },
      );
      expect(missingResult.decision).toBe('DENY');
      expect(missingResult.code).toBe('PERMISSION_NOT_GRANTED');

      // Grant customer.update with ASSIGNED
      await grantPermission(db, {
        agencyId: TEST_AGENCY,
        membershipId: MEMBER_MEMBERSHIP_ID,
        permissionCode: 'customer.update',
        scope: 'ASSIGNED',
        expectedPermissionVersion: 4,
      });

      const updatedMemberCtx = createMemberContext({
        memberships: [
          {
            id: MEMBER_MEMBERSHIP_ID,
            agencyId: TEST_AGENCY,
            type: 'MEMBER',
            status: 'ACTIVE',
            permissionVersion: 5,
          },
        ],
      });

      const successResult = await evaluateAuthorization(
        db,
        {
          context: updatedMemberCtx,
          action: 'customer.full_update',
          agencyId: TEST_AGENCY,
          resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
        },
        { actions: actionRegistry, resolvers: TEST_RESOLVERS },
      );
      expect(successResult.decision).toBe('ALLOW');
      expect(successResult.effectiveScope).toBe('ASSIGNED');
    });
  });

  // ---------------------------------------------------------------------------
  // Sol High IMPORTANT-2: Same-Agency Membership Ambiguity
  // ---------------------------------------------------------------------------
  describe('Sol High IMPORTANT-2: Same-agency membership ambiguity protection', () => {
    it('Duplicate identical membership entries for the same agency DENIES with INVALID_CONTEXT', async () => {
      const ambiguousContext: AuthenticatedUserContext = {
        userId: OWNER_USER_ID,
        identityId: OWNER_IDENTITY_ID,
        assurance: 'NORMAL',
        memberships: [
          {
            id: OWNER_MEMBERSHIP_ID,
            agencyId: TEST_AGENCY,
            type: 'OWNER',
            status: 'ACTIVE',
            permissionVersion: 2,
          },
          {
            id: OWNER_MEMBERSHIP_ID,
            agencyId: TEST_AGENCY,
            type: 'OWNER',
            status: 'ACTIVE',
            permissionVersion: 2,
          },
        ],
      };

      const res = await evaluateAuthorization(db, {
        context: ambiguousContext,
        action: 'audit.read',
        agencyId: TEST_AGENCY,
      });

      expect(res.decision).toBe('DENY');
      expect(res.code).toBe('INVALID_CONTEXT');
    });

    it('Conflicting OWNER and MEMBER entries for the same agency DENIES with INVALID_CONTEXT (no first match)', async () => {
      const conflictingContext: AuthenticatedUserContext = {
        userId: OWNER_USER_ID,
        identityId: OWNER_IDENTITY_ID,
        assurance: 'NORMAL',
        memberships: [
          {
            id: 'mem-1',
            agencyId: TEST_AGENCY,
            type: 'OWNER',
            status: 'ACTIVE',
            permissionVersion: 2,
          },
          {
            id: 'mem-2',
            agencyId: TEST_AGENCY,
            type: 'MEMBER',
            status: 'ACTIVE',
            permissionVersion: 2,
          },
        ],
      };

      const res = await evaluateAuthorization(db, {
        context: conflictingContext,
        action: 'audit.read',
        agencyId: TEST_AGENCY,
      });

      expect(res.decision).toBe('DENY');
      expect(res.code).toBe('INVALID_CONTEXT');
    });

    it('Duplicate membership ID across different agencies DENIES with INVALID_CONTEXT', async () => {
      const duplicateMemIdContext: AuthenticatedUserContext = {
        userId: OWNER_USER_ID,
        identityId: OWNER_IDENTITY_ID,
        assurance: 'NORMAL',
        memberships: [
          {
            id: 'reused-mem-id',
            agencyId: TEST_AGENCY,
            type: 'OWNER',
            status: 'ACTIVE',
            permissionVersion: 2,
          },
          {
            id: 'reused-mem-id',
            agencyId: OTHER_AGENCY,
            type: 'OWNER',
            status: 'ACTIVE',
            permissionVersion: 1,
          },
        ],
      };

      const res = await evaluateAuthorization(db, {
        context: duplicateMemIdContext,
        action: 'audit.read',
        agencyId: TEST_AGENCY,
      });

      expect(res.decision).toBe('DENY');
      expect(res.code).toBe('INVALID_CONTEXT');
    });

    it('Valid multi-agency context (distinct IDs and distinct agencies) passes validation', async () => {
      const multiAgencyContext: AuthenticatedUserContext = {
        userId: OWNER_USER_ID,
        identityId: OWNER_IDENTITY_ID,
        assurance: 'NORMAL',
        memberships: [
          {
            id: OWNER_MEMBERSHIP_ID,
            agencyId: TEST_AGENCY,
            type: 'OWNER',
            status: 'ACTIVE',
            permissionVersion: 4,
          },
          {
            id: 't07-other-agency-owner-mem',
            agencyId: OTHER_AGENCY,
            type: 'OWNER',
            status: 'ACTIVE',
            permissionVersion: 1,
          },
        ],
      };

      const res = await evaluateAuthorization(db, {
        context: multiAgencyContext,
        action: 'audit.read',
        agencyId: TEST_AGENCY,
      });

      expect(res.decision).toBe('ALLOW');
      expect(res.effectiveScope).toBe('UNSCOPED');
    });
  });

  // ---------------------------------------------------------------------------
  // Sol High Recovery: Sensitive permission must be additive, never standalone operational authority
  // ---------------------------------------------------------------------------
  describe('Sol High Recovery: SENSITIVE additive invariant & ActionDefinition validation', () => {
    const REC_MEMBER_USER_ID = 't07-rec-member-user';
    const REC_MEMBER_MEMBERSHIP_ID = 't07-rec-member-mem';
    const REC_MEMBER_IDENTITY_ID = 't07-rec-member-ident';

    const REC_OWNER_USER_ID = 't07-rec-owner-user';
    const REC_OWNER_MEMBERSHIP_ID = 't07-rec-owner-mem';
    const REC_OWNER_IDENTITY_ID = 't07-rec-owner-ident';

    beforeAll(async () => {
      // Setup isolated Member user
      await db
        .prepare("INSERT INTO users (id, status, version) VALUES (?, 'ACTIVE', 1)")
        .bind(REC_MEMBER_USER_ID)
        .run();
      await db
        .prepare(
          `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
           VALUES (?, ?, 'https://test.access.com', 'rec-member-sub', 'rec-member@agency1.test', 'ACTIVE')`,
        )
        .bind(REC_MEMBER_IDENTITY_ID, REC_MEMBER_USER_ID)
        .run();
      await db
        .prepare(
          `INSERT INTO agency_memberships (
             id, agency_id, user_id, type, status, invitation_email, invitation_expires_at,
             activated_at, version, permission_version
           ) VALUES (?, ?, ?, 'MEMBER', 'ACTIVE', 'rec-member@agency1.test', '2099-01-01T00:00:00.000Z',
             (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), 1, 1)`,
        )
        .bind(REC_MEMBER_MEMBERSHIP_ID, TEST_AGENCY, REC_MEMBER_USER_ID)
        .run();

      // Setup isolated Owner user
      await db
        .prepare("INSERT INTO users (id, status, version) VALUES (?, 'ACTIVE', 1)")
        .bind(REC_OWNER_USER_ID)
        .run();
      await db
        .prepare(
          `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
           VALUES (?, ?, 'https://test.access.com', 'rec-owner-sub', 'rec-owner@agency1.test', 'ACTIVE')`,
        )
        .bind(REC_OWNER_IDENTITY_ID, REC_OWNER_USER_ID)
        .run();
      await db
        .prepare(
          `INSERT INTO agency_memberships (
             id, agency_id, user_id, type, status, invitation_email, invitation_expires_at,
             activated_at, version, permission_version
           ) VALUES (?, ?, ?, 'OWNER', 'ACTIVE', 'rec-owner@agency1.test', '2099-01-01T00:00:00.000Z',
             (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')), 1, 1)`,
        )
        .bind(REC_OWNER_MEMBERSHIP_ID, TEST_AGENCY, REC_OWNER_USER_ID)
        .run();
    });

    beforeEach(async () => {
      await db
        .prepare('DELETE FROM membership_permissions WHERE membership_id IN (?, ?)')
        .bind(REC_MEMBER_MEMBERSHIP_ID, REC_OWNER_MEMBERSHIP_ID)
        .run();
    });

    afterEach(async () => {
      await db
        .prepare('DELETE FROM membership_permissions WHERE membership_id IN (?, ?)')
        .bind(REC_MEMBER_MEMBERSHIP_ID, REC_OWNER_MEMBERSHIP_ID)
        .run();
    });

    function getRecMemberContext(permissionVersion = 1): AuthenticatedUserContext {
      return {
        userId: REC_MEMBER_USER_ID,
        identityId: REC_MEMBER_IDENTITY_ID,
        assurance: 'NORMAL',
        memberships: [
          {
            id: REC_MEMBER_MEMBERSHIP_ID,
            agencyId: TEST_AGENCY,
            type: 'MEMBER',
            status: 'ACTIVE',
            permissionVersion,
          },
        ],
      };
    }

    function getRecOwnerContext(permissionVersion = 1): AuthenticatedUserContext {
      return {
        userId: REC_OWNER_USER_ID,
        identityId: REC_OWNER_IDENTITY_ID,
        assurance: 'NORMAL',
        memberships: [
          {
            id: REC_OWNER_MEMBERSHIP_ID,
            agencyId: TEST_AGENCY,
            type: 'OWNER',
            status: 'ACTIVE',
            permissionVersion,
          },
        ],
      };
    }

    // A. Supported constructor with only valid SENSITIVE permission rejects
    it('A. validateAndCreateActionDefinition rejects zero-permission and SENSITIVE-only action definitions', () => {
      // 1. SENSITIVE only with empty normal permissions array -> must throw
      expect(() =>
        validateAndCreateActionDefinition({
          code: 'sensitive.only_action',
          authority: 'MEMBERSHIP_AUTHORIZED',
          requiredNormalPermissions: [],
          requiredSensitivePermissions: ['sensitive.identity.read'],
        }),
      ).toThrow();

      // 2. SENSITIVE only with omitted requiredNormalPermissions -> must throw
      expect(() =>
        validateAndCreateActionDefinition({
          code: 'sensitive.only_omitted_normal',
          authority: 'MEMBERSHIP_AUTHORIZED',
          requiredSensitivePermissions: ['sensitive.identity.read'],
        }),
      ).toThrow();

      // 3. Zero permissions total -> must throw
      expect(() =>
        validateAndCreateActionDefinition({
          code: 'empty.perms',
          authority: 'MEMBERSHIP_AUTHORIZED',
          requiredNormalPermissions: [],
          requiredSensitivePermissions: [],
        }),
      ).toThrow();
    });

    // B. Malformed/cast registry ActionDefinition with only SENSITIVE permission evaluates DENY
    it('B. Malformed/cast registry ActionDefinition with only SENSITIVE permission evaluates DENY, never ALLOW', async () => {
      // Grant explicit sensitive.identity.read to Member
      await db
        .prepare(
          `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
           VALUES ('rec-grant-sens-only', ?, 'sensitive.identity.read', 'UNSCOPED')`,
        )
        .bind(REC_MEMBER_MEMBERSHIP_ID)
        .run();

      const sensitiveOnlyBypass = {
        code: 'custom.sensitive_only_bypass',
        authority: 'MEMBERSHIP_AUTHORIZED',
        requiredNormalPermissions: [],
        requiredSensitivePermissions: ['sensitive.identity.read'],
        assurance: 'NORMAL_SESSION',
      } as unknown as ActionDefinition;

      const customActions = new Map<string, ActionDefinition>([
        [sensitiveOnlyBypass.code, sensitiveOnlyBypass],
      ]);

      const res = await evaluateAuthorization(
        db,
        {
          context: getRecMemberContext(1),
          action: 'custom.sensitive_only_bypass',
          agencyId: TEST_AGENCY,
        },
        { actions: customActions, resolvers: TEST_RESOLVERS },
      );

      expect(res.decision).toBe('DENY');
      expect(res.code).toBe('UNKNOWN_ACTION');

      // Clean up grant
      await db
        .prepare('DELETE FROM membership_permissions WHERE id = ?')
        .bind('rec-grant-sens-only')
        .run();
    });

    // C. Combined NORMAL RECORD_SCOPED + SENSITIVE action, actor has sensitive only / missing normal: DENY
    it('C. Combined NORMAL RECORD_SCOPED + SENSITIVE action with actor having sensitive only -> DENY (PERMISSION_NOT_GRANTED)', async () => {
      const combinedAction = validateAndCreateActionDefinition({
        code: 'customer.view_identity_custom',
        authority: 'MEMBERSHIP_AUTHORIZED',
        requiredNormalPermissions: ['customer.read'],
        requiredSensitivePermissions: ['sensitive.identity.read'],
        assurance: 'NORMAL_SESSION',
      });

      const customActions = new Map<string, ActionDefinition>([
        [combinedAction.code, combinedAction],
      ]);

      // Only grant sensitive.identity.read
      await db
        .prepare(
          `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
           VALUES ('rec-grant-sens-c', ?, 'sensitive.identity.read', 'UNSCOPED')`,
        )
        .bind(REC_MEMBER_MEMBERSHIP_ID)
        .run();

      const res = await evaluateAuthorization(
        db,
        {
          context: getRecMemberContext(1),
          action: 'customer.view_identity_custom',
          agencyId: TEST_AGENCY,
          resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
        },
        { actions: customActions, resolvers: TEST_RESOLVERS },
      );

      expect(res.decision).toBe('DENY');
      expect(res.code).toBe('PERMISSION_NOT_GRANTED');

      await db
        .prepare('DELETE FROM membership_permissions WHERE id = ?')
        .bind('rec-grant-sens-c')
        .run();
    });

    // D. Combined action actor has both grants but NORMAL record scope resolver denies resource: DENY
    it('D. Combined action actor has both grants but NORMAL record scope resolver denies resource -> DENY (SCOPE_RESOLVER_DENIED)', async () => {
      const combinedAction = validateAndCreateActionDefinition({
        code: 'customer.view_identity_custom_d',
        authority: 'MEMBERSHIP_AUTHORIZED',
        requiredNormalPermissions: ['customer.read'],
        requiredSensitivePermissions: ['sensitive.identity.read'],
        assurance: 'NORMAL_SESSION',
      });

      const customActions = new Map<string, ActionDefinition>([
        [combinedAction.code, combinedAction],
      ]);

      // Grant both customer.read (ASSIGNED) and sensitive.identity.read (UNSCOPED)
      await db
        .prepare(
          `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
           VALUES ('rec-grant-norm-d', ?, 'customer.read', 'ASSIGNED'),
                  ('rec-grant-sens-d', ?, 'sensitive.identity.read', 'UNSCOPED')`,
        )
        .bind(REC_MEMBER_MEMBERSHIP_ID, REC_MEMBER_MEMBERSHIP_ID)
        .run();

      const res = await evaluateAuthorization(
        db,
        {
          context: getRecMemberContext(1),
          action: 'customer.view_identity_custom_d',
          agencyId: TEST_AGENCY,
          resource: { agencyId: TEST_AGENCY, isAllowedRecord: false }, // Resolver will deny!
        },
        { actions: customActions, resolvers: TEST_RESOLVERS },
      );

      expect(res.decision).toBe('DENY');
      expect(res.code).toBe('SCOPE_RESOLVER_DENIED');

      await db
        .prepare(
          "DELETE FROM membership_permissions WHERE id IN ('rec-grant-norm-d', 'rec-grant-sens-d')",
        )
        .run();
    });

    // E. Valid combined NORMAL + SENSITIVE and valid operational scope follows current T07 assurance
    it('E. Valid combined NORMAL + SENSITIVE follows assurance (NORMAL_SESSION allows, SECURE_GRANT denies)', async () => {
      // 1. NORMAL_SESSION passes when resolver allows
      const normalSessionAction = validateAndCreateActionDefinition({
        code: 'customer.view_identity_normal_sess',
        authority: 'MEMBERSHIP_AUTHORIZED',
        requiredNormalPermissions: ['customer.read'],
        requiredSensitivePermissions: ['sensitive.identity.read'],
        assurance: 'NORMAL_SESSION',
      });

      // 2. SECURE_GRANT requires step-up (fail-closed in T07)
      const secureGrantAction = validateAndCreateActionDefinition({
        code: 'customer.view_identity_secure_grant',
        authority: 'MEMBERSHIP_AUTHORIZED',
        requiredNormalPermissions: ['customer.read'],
        requiredSensitivePermissions: ['sensitive.identity.read'],
        assurance: 'SECURE_GRANT',
      });

      const customActions = new Map<string, ActionDefinition>([
        [normalSessionAction.code, normalSessionAction],
        [secureGrantAction.code, secureGrantAction],
      ]);

      await db
        .prepare(
          `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
           VALUES ('rec-grant-norm-e', ?, 'customer.read', 'ASSIGNED'),
                  ('rec-grant-sens-e', ?, 'sensitive.identity.read', 'UNSCOPED')`,
        )
        .bind(REC_MEMBER_MEMBERSHIP_ID, REC_MEMBER_MEMBERSHIP_ID)
        .run();

      // Normal session -> ALLOW
      const normalRes = await evaluateAuthorization(
        db,
        {
          context: getRecMemberContext(1),
          action: 'customer.view_identity_normal_sess',
          agencyId: TEST_AGENCY,
          resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
        },
        { actions: customActions, resolvers: TEST_RESOLVERS },
      );
      expect(normalRes.decision).toBe('ALLOW');
      expect(normalRes.effectiveScope).toBe('ASSIGNED');

      // Secure grant -> DENY (SECURE_GRANT_REQUIRED)
      const secureRes = await evaluateAuthorization(
        db,
        {
          context: getRecMemberContext(1),
          action: 'customer.view_identity_secure_grant',
          agencyId: TEST_AGENCY,
          resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
        },
        { actions: customActions, resolvers: TEST_RESOLVERS },
      );
      expect(secureRes.decision).toBe('DENY');
      expect(secureRes.code).toBe('SECURE_GRANT_REQUIRED');

      await db
        .prepare(
          "DELETE FROM membership_permissions WHERE id IN ('rec-grant-norm-e', 'rec-grant-sens-e')",
        )
        .run();
    });

    // F. OWNER: NORMAL-only keeps implicit AGENCY semantics; NORMAL+SENSITIVE without explicit sensitive grant DENY; malformed SENSITIVE-only action DENY
    it('F. OWNER evaluation: NORMAL-only allows AGENCY, NORMAL+SENSITIVE without explicit grant DENIES, malformed SENSITIVE-only DENIES', async () => {
      const combinedAction = validateAndCreateActionDefinition({
        code: 'customer.view_identity_owner_f',
        authority: 'MEMBERSHIP_AUTHORIZED',
        requiredNormalPermissions: ['customer.read'],
        requiredSensitivePermissions: ['sensitive.identity.read'],
        assurance: 'NORMAL_SESSION',
      });

      const malformedSensitiveOnly = {
        code: 'custom.owner_sensitive_only_bypass',
        authority: 'MEMBERSHIP_AUTHORIZED',
        requiredNormalPermissions: [],
        requiredSensitivePermissions: ['sensitive.identity.read'],
        assurance: 'NORMAL_SESSION',
      } as unknown as ActionDefinition;

      const customActions = new Map<string, ActionDefinition>([
        ...DEFAULT_ACTION_REGISTRY.entries(),
        [combinedAction.code, combinedAction],
        [malformedSensitiveOnly.code, malformedSensitiveOnly],
      ]);

      // 1. NORMAL-only: implicit AGENCY
      const normOnlyRes = await evaluateAuthorization(
        db,
        {
          context: getRecOwnerContext(1),
          action: 'customer.read',
          agencyId: TEST_AGENCY,
          resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
        },
        { actions: customActions, resolvers: TEST_RESOLVERS },
      );
      expect(normOnlyRes.decision).toBe('ALLOW');
      expect(normOnlyRes.effectiveScope).toBe('AGENCY');

      // 2. NORMAL+SENSITIVE without explicit grant -> DENY (OWNER_SENSITIVE_GRANT_REQUIRED)
      const combinedNoGrantRes = await evaluateAuthorization(
        db,
        {
          context: getRecOwnerContext(1),
          action: 'customer.view_identity_owner_f',
          agencyId: TEST_AGENCY,
          resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
        },
        { actions: customActions, resolvers: TEST_RESOLVERS },
      );
      expect(combinedNoGrantRes.decision).toBe('DENY');
      expect(combinedNoGrantRes.code).toBe('OWNER_SENSITIVE_GRANT_REQUIRED');

      // 3. Malformed SENSITIVE-only action with explicit sensitive grant on owner -> must still DENY!
      await db
        .prepare(
          `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
           VALUES ('rec-grant-owner-sens', ?, 'sensitive.identity.read', 'UNSCOPED')`,
        )
        .bind(REC_OWNER_MEMBERSHIP_ID)
        .run();

      const malformedRes = await evaluateAuthorization(
        db,
        {
          context: getRecOwnerContext(1),
          action: 'custom.owner_sensitive_only_bypass',
          agencyId: TEST_AGENCY,
        },
        { actions: customActions, resolvers: TEST_RESOLVERS },
      );
      expect(malformedRes.decision).toBe('DENY');
      expect(malformedRes.code).toBe('UNKNOWN_ACTION');

      await db
        .prepare('DELETE FROM membership_permissions WHERE id = ?')
        .bind('rec-grant-owner-sens')
        .run();
    });

    // G. MEMBER matrix: normal-only, sensitive-only, both, neither — NORMAL remains explicit and SENSITIVE additive
    it('G. MEMBER matrix: normal-only, sensitive-only, both, neither for combined action', async () => {
      const combinedAction = validateAndCreateActionDefinition({
        code: 'customer.view_identity_matrix_g',
        authority: 'MEMBERSHIP_AUTHORIZED',
        requiredNormalPermissions: ['customer.read'],
        requiredSensitivePermissions: ['sensitive.identity.read'],
        assurance: 'NORMAL_SESSION',
      });

      const customActions = new Map<string, ActionDefinition>([
        [combinedAction.code, combinedAction],
      ]);

      // 1. NEITHER
      const neitherRes = await evaluateAuthorization(
        db,
        {
          context: getRecMemberContext(1),
          action: 'customer.view_identity_matrix_g',
          agencyId: TEST_AGENCY,
          resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
        },
        { actions: customActions, resolvers: TEST_RESOLVERS },
      );
      expect(neitherRes.decision).toBe('DENY');
      expect(neitherRes.code).toBe('PERMISSION_NOT_GRANTED');

      // 2. NORMAL-ONLY
      await db
        .prepare(
          `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
           VALUES ('rec-matrix-norm', ?, 'customer.read', 'ASSIGNED')`,
        )
        .bind(REC_MEMBER_MEMBERSHIP_ID)
        .run();

      const normOnlyRes = await evaluateAuthorization(
        db,
        {
          context: getRecMemberContext(1),
          action: 'customer.view_identity_matrix_g',
          agencyId: TEST_AGENCY,
          resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
        },
        { actions: customActions, resolvers: TEST_RESOLVERS },
      );
      expect(normOnlyRes.decision).toBe('DENY');
      expect(normOnlyRes.code).toBe('PERMISSION_NOT_GRANTED');

      // 3. SENSITIVE-ONLY (remove normal, add sensitive)
      await db
        .prepare('DELETE FROM membership_permissions WHERE id = ?')
        .bind('rec-matrix-norm')
        .run();
      await db
        .prepare(
          `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
           VALUES ('rec-matrix-sens', ?, 'sensitive.identity.read', 'UNSCOPED')`,
        )
        .bind(REC_MEMBER_MEMBERSHIP_ID)
        .run();

      const sensOnlyRes = await evaluateAuthorization(
        db,
        {
          context: getRecMemberContext(1),
          action: 'customer.view_identity_matrix_g',
          agencyId: TEST_AGENCY,
          resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
        },
        { actions: customActions, resolvers: TEST_RESOLVERS },
      );
      expect(sensOnlyRes.decision).toBe('DENY');
      expect(sensOnlyRes.code).toBe('PERMISSION_NOT_GRANTED');

      // 4. BOTH (add back normal)
      await db
        .prepare(
          `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
           VALUES ('rec-matrix-norm', ?, 'customer.read', 'ASSIGNED')`,
        )
        .bind(REC_MEMBER_MEMBERSHIP_ID)
        .run();

      const bothRes = await evaluateAuthorization(
        db,
        {
          context: getRecMemberContext(1),
          action: 'customer.view_identity_matrix_g',
          agencyId: TEST_AGENCY,
          resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
        },
        { actions: customActions, resolvers: TEST_RESOLVERS },
      );
      expect(bothRes.decision).toBe('ALLOW');
      expect(bothRes.effectiveScope).toBe('ASSIGNED');

      await db
        .prepare(
          "DELETE FROM membership_permissions WHERE id IN ('rec-matrix-norm', 'rec-matrix-sens')",
        )
        .run();
    });

    // H. Unknown, duplicate, malformed, misclassified action requirements fail closed
    it('H. Unknown, duplicate, malformed, misclassified action requirements fail closed', async () => {
      // 1. Registry key / definition code mismatch -> DENY (UNKNOWN_ACTION)
      const validDef = validateAndCreateActionDefinition({
        code: 'action.real_code',
        authority: 'MEMBERSHIP_AUTHORIZED',
        requiredNormalPermissions: ['customer.read'],
      });
      const mismatchedRegistry = new Map<string, ActionDefinition>([['action.fake_key', validDef]]);
      const mismatchRes = await evaluateAuthorization(
        db,
        {
          context: getRecOwnerContext(1),
          action: 'action.fake_key',
          agencyId: TEST_AGENCY,
          resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
        },
        { actions: mismatchedRegistry, resolvers: TEST_RESOLVERS },
      );
      expect(mismatchRes.decision).toBe('DENY');
      expect(mismatchRes.code).toBe('UNKNOWN_ACTION');

      // 2. Malformed requiredNormalPermissions (non-array, duplicate, unknown code)
      expect(() =>
        validateAndCreateActionDefinition({
          code: 'action.bad_norm_array',
          authority: 'MEMBERSHIP_AUTHORIZED',
          requiredNormalPermissions: 'customer.read' as unknown as string[],
        }),
      ).toThrow();

      expect(() =>
        validateAndCreateActionDefinition({
          code: 'action.dup_norm',
          authority: 'MEMBERSHIP_AUTHORIZED',
          requiredNormalPermissions: ['customer.read', 'customer.read'],
        }),
      ).toThrow();

      expect(() =>
        validateAndCreateActionDefinition({
          code: 'action.unknown_norm',
          authority: 'MEMBERSHIP_AUTHORIZED',
          requiredNormalPermissions: ['unknown.not_a_perm'],
        }),
      ).toThrow();

      // 3. Misclassification: SENSITIVE perm in requiredNormalPermissions -> constructor throws, cast in evaluator DENIES
      expect(() =>
        validateAndCreateActionDefinition({
          code: 'action.misclassified_norm',
          authority: 'MEMBERSHIP_AUTHORIZED',
          requiredNormalPermissions: ['sensitive.identity.read'],
        }),
      ).toThrow();

      const misclassifiedCast = {
        code: 'action.misclassified_cast',
        authority: 'MEMBERSHIP_AUTHORIZED',
        requiredNormalPermissions: ['sensitive.identity.read'],
        requiredSensitivePermissions: [],
        assurance: 'NORMAL_SESSION',
      } as unknown as ActionDefinition;
      const misclassRegistry = new Map<string, ActionDefinition>([
        [misclassifiedCast.code, misclassifiedCast],
      ]);
      const misclassRes = await evaluateAuthorization(
        db,
        {
          context: getRecOwnerContext(1),
          action: 'action.misclassified_cast',
          agencyId: TEST_AGENCY,
        },
        { actions: misclassRegistry },
      );
      expect(misclassRes.decision).toBe('DENY');
      expect(misclassRes.code).toBe('UNKNOWN_ACTION');

      // 4. Misclassification: NORMAL perm in requiredSensitivePermissions -> constructor throws
      expect(() =>
        validateAndCreateActionDefinition({
          code: 'action.misclassified_sens',
          authority: 'MEMBERSHIP_AUTHORIZED',
          requiredNormalPermissions: ['customer.read'],
          requiredSensitivePermissions: ['customer.update'],
        }),
      ).toThrow();

      // 5. Malformed assurance value -> constructor throws, cast in evaluator DENIES
      expect(() =>
        validateAndCreateActionDefinition({
          code: 'action.bad_assurance',
          authority: 'MEMBERSHIP_AUTHORIZED',
          requiredNormalPermissions: ['customer.read'],
          assurance: 'INVALID_ASSURANCE' as unknown as 'NORMAL_SESSION',
        }),
      ).toThrow();

      const badAssuranceCast = {
        code: 'action.bad_assurance_cast',
        authority: 'MEMBERSHIP_AUTHORIZED',
        requiredNormalPermissions: ['customer.read'],
        requiredSensitivePermissions: [],
        assurance: 'INVALID_ASSURANCE',
      } as unknown as ActionDefinition;
      const badAssuranceRegistry = new Map<string, ActionDefinition>([
        [badAssuranceCast.code, badAssuranceCast],
      ]);
      const badAssuranceRes = await evaluateAuthorization(
        db,
        {
          context: getRecOwnerContext(1),
          action: 'action.bad_assurance_cast',
          agencyId: TEST_AGENCY,
        },
        { actions: badAssuranceRegistry },
      );
      expect(badAssuranceRes.decision).toBe('DENY');
      expect(badAssuranceRes.code).toBe('UNKNOWN_ACTION');

      // 6. Extra unexpected fields -> constructor throws
      expect(() =>
        validateAndCreateActionDefinition({
          code: 'action.extra_fields',
          authority: 'MEMBERSHIP_AUTHORIZED',
          requiredNormalPermissions: ['customer.read'],
          maliciousProperty: true,
        } as unknown as {
          code: string;
          authority: ActionAuthority;
          requiredNormalPermissions: string[];
        }),
      ).toThrow();
    });

    // I. Legitimate UNSCOPED NORMAL action definition remains valid
    it('I. Legitimate UNSCOPED NORMAL action definition remains valid and authorizable', async () => {
      const unscopedNormalAction = validateAndCreateActionDefinition({
        code: 'audit.custom_inspect',
        authority: 'MEMBERSHIP_AUTHORIZED',
        requiredNormalPermissions: ['audit.read'],
        requiredSensitivePermissions: [],
        assurance: 'NORMAL_SESSION',
      });

      const customActions = new Map<string, ActionDefinition>([
        [unscopedNormalAction.code, unscopedNormalAction],
      ]);

      // 1. OWNER allows UNSCOPED
      const ownerRes = await evaluateAuthorization(
        db,
        {
          context: getRecOwnerContext(1),
          action: 'audit.custom_inspect',
          agencyId: TEST_AGENCY,
        },
        { actions: customActions },
      );
      expect(ownerRes.decision).toBe('ALLOW');
      expect(ownerRes.effectiveScope).toBe('UNSCOPED');

      // 2. MEMBER with audit.read allows UNSCOPED
      await db
        .prepare(
          `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
           VALUES ('rec-audit-grant', ?, 'audit.read', 'UNSCOPED')`,
        )
        .bind(REC_MEMBER_MEMBERSHIP_ID)
        .run();

      const memberRes = await evaluateAuthorization(
        db,
        {
          context: getRecMemberContext(1),
          action: 'audit.custom_inspect',
          agencyId: TEST_AGENCY,
        },
        { actions: customActions },
      );
      expect(memberRes.decision).toBe('ALLOW');
      expect(memberRes.effectiveScope).toBe('UNSCOPED');

      await db
        .prepare('DELETE FROM membership_permissions WHERE id = ?')
        .bind('rec-audit-grant')
        .run();
    });

    // J. Adversarial malformed custom registry & ActionDefinition with throwing getters/Proxy traps fail-closed to DENY
    it('J. Adversarial throwing custom registry and throwing getter/Proxy action definitions fail-closed to DENY without throwing', async () => {
      // 1. Custom registry whose .get() throws
      const throwingRegistry = {
        get: () => {
          throw new Error('Hostile registry get trap');
        },
      } as unknown as ActionRegistry;

      const throwingRegRes = await evaluateAuthorization(
        db,
        {
          context: getRecOwnerContext(1),
          action: 'customer.read',
          agencyId: TEST_AGENCY,
        },
        { actions: throwingRegistry },
      );
      expect(throwingRegRes.decision).toBe('DENY');
      expect(throwingRegRes.code).toBe('UNKNOWN_ACTION');

      // 2. ActionDefinition with throwing getter on 'code'
      const throwingCodeDef = {
        get code() {
          throw new Error('Hostile code getter');
        },
        authority: 'MEMBERSHIP_AUTHORIZED',
        requiredNormalPermissions: ['customer.read'],
        requiredSensitivePermissions: [],
        assurance: 'NORMAL_SESSION',
      } as unknown as ActionDefinition;

      const throwingCodeRegistry = new Map<string, ActionDefinition>([
        ['customer.throwing_code', throwingCodeDef],
      ]);

      const throwingCodeRes = await evaluateAuthorization(
        db,
        {
          context: getRecOwnerContext(1),
          action: 'customer.throwing_code',
          agencyId: TEST_AGENCY,
        },
        { actions: throwingCodeRegistry },
      );
      expect(throwingCodeRes.decision).toBe('DENY');
      expect(throwingCodeRes.code).toBe('UNKNOWN_ACTION');

      // Constructor still throws as expected
      expect(() =>
        validateAndCreateActionDefinition(
          throwingCodeDef as unknown as { code: string; authority: ActionAuthority },
        ),
      ).toThrow();

      // 3. ActionDefinition with throwing getter on 'requiredNormalPermissions'
      const throwingPermsDef = {
        code: 'customer.throwing_perms',
        authority: 'MEMBERSHIP_AUTHORIZED',
        get requiredNormalPermissions() {
          throw new Error('Hostile permissions getter');
        },
        requiredSensitivePermissions: [],
        assurance: 'NORMAL_SESSION',
      } as unknown as ActionDefinition;

      const throwingPermsRegistry = new Map<string, ActionDefinition>([
        ['customer.throwing_perms', throwingPermsDef],
      ]);

      const throwingPermsRes = await evaluateAuthorization(
        db,
        {
          context: getRecOwnerContext(1),
          action: 'customer.throwing_perms',
          agencyId: TEST_AGENCY,
        },
        { actions: throwingPermsRegistry },
      );
      expect(throwingPermsRes.decision).toBe('DENY');
      expect(throwingPermsRes.code).toBe('UNKNOWN_ACTION');

      // 4. ActionDefinition Proxy with throwing ownKeys trap
      const throwingProxyDef = new Proxy(
        {
          code: 'customer.throwing_proxy',
          authority: 'MEMBERSHIP_AUTHORIZED',
          requiredNormalPermissions: ['customer.read'],
          requiredSensitivePermissions: [],
          assurance: 'NORMAL_SESSION',
        },
        {
          ownKeys() {
            throw new Error('Hostile ownKeys trap');
          },
        },
      ) as unknown as ActionDefinition;

      const throwingProxyRegistry = new Map<string, ActionDefinition>([
        ['customer.throwing_proxy', throwingProxyDef],
      ]);

      const throwingProxyRes = await evaluateAuthorization(
        db,
        {
          context: getRecOwnerContext(1),
          action: 'customer.throwing_proxy',
          agencyId: TEST_AGENCY,
        },
        { actions: throwingProxyRegistry },
      );
      expect(throwingProxyRes.decision).toBe('DENY');
      expect(throwingProxyRes.code).toBe('UNKNOWN_ACTION');

      // 5. ActionDefinition Proxy with throwing get trap
      const throwingGetProxyDef = new Proxy(
        {},
        {
          get(_target, prop) {
            throw new Error(`Hostile Proxy get trap for ${String(prop)}`);
          },
        },
      ) as unknown as ActionDefinition;

      const throwingGetProxyRegistry = new Map<string, ActionDefinition>([
        ['customer.throwing_get_proxy', throwingGetProxyDef],
      ]);

      const throwingGetProxyRes = await evaluateAuthorization(
        db,
        {
          context: getRecOwnerContext(1),
          action: 'customer.throwing_get_proxy',
          agencyId: TEST_AGENCY,
        },
        { actions: throwingGetProxyRegistry },
      );
      expect(throwingGetProxyRes.decision).toBe('DENY');
      expect(throwingGetProxyRes.code).toBe('UNKNOWN_ACTION');
    });

    // =========================================================================
    // Sol High Recovery: 18-Vector Adversarial ActionRegistry & TOCTOU Suite
    // =========================================================================
    describe('Focused Adversarial Matrix: ActionRegistry Immutability & Action Metadata TOCTOU', () => {
      // 1. set/delete/clear
      it('1. DEFAULT_ACTION_REGISTRY rejects set, delete, and clear mutations with zero authority effect', () => {
        const fakeAction = validateAndCreateActionDefinition({
          code: 'customer.read',
          authority: 'MEMBERSHIP_AUTHORIZED',
          requiredNormalPermissions: ['audit.read'],
          requiredSensitivePermissions: [],
          assurance: 'NORMAL_SESSION',
        });

        // Attempt .set()
        expect(() => {
          (DEFAULT_ACTION_REGISTRY as unknown as { set: (k: string, v: unknown) => void }).set(
            'customer.read',
            fakeAction,
          );
        }).toThrow();

        // Attempt .delete()
        expect(() => {
          (DEFAULT_ACTION_REGISTRY as unknown as { delete: (k: string) => boolean }).delete(
            'customer.read',
          );
        }).toThrow();

        // Attempt .clear()
        expect(() => {
          (DEFAULT_ACTION_REGISTRY as unknown as { clear: () => void }).clear();
        }).toThrow();

        // Assert registry remains intact and unchanged
        expect(DEFAULT_ACTION_REGISTRY.has('customer.read')).toBe(true);
        const def = DEFAULT_ACTION_REGISTRY.get('customer.read');
        expect(def).toBeDefined();
        expect(def?.code).toBe('customer.read');
        expect(def?.requiredNormalPermissions).toEqual(['customer.read']);
      });

      // 2. any-cast mutation
      it('2. any-cast property assignment on DEFAULT_ACTION_REGISTRY fails with zero effect', () => {
        const fakeAction = validateAndCreateActionDefinition({
          code: 'customer.read',
          authority: 'MEMBERSHIP_AUTHORIZED',
          requiredNormalPermissions: ['audit.read'],
          requiredSensitivePermissions: [],
          assurance: 'NORMAL_SESSION',
        });

        try {
          (DEFAULT_ACTION_REGISTRY as unknown as Record<string, unknown>)['customer.read'] =
            fakeAction;
        } catch {
          // In strict mode, mutating frozen object throws
        }

        try {
          (DEFAULT_ACTION_REGISTRY as unknown as Record<string, unknown>)['arbitraryHostileProp'] =
            'compromised';
        } catch {
          // Expected in strict mode
        }

        expect(DEFAULT_ACTION_REGISTRY.get('customer.read')?.requiredNormalPermissions).toEqual([
          'customer.read',
        ]);
        expect(
          (DEFAULT_ACTION_REGISTRY as unknown as Record<string, unknown>)['arbitraryHostileProp'],
        ).toBeUndefined();
      });

      // 3. property reassignment
      it('3. Property reassignment on registry and action definitions fails with zero effect', () => {
        try {
          (DEFAULT_ACTION_REGISTRY as unknown as Record<string, unknown>).get = () => undefined;
        } catch {
          // Expected
        }
        try {
          (DEFAULT_ACTION_REGISTRY as unknown as Record<string, unknown>).has = () => false;
        } catch {
          // Expected
        }

        expect(typeof DEFAULT_ACTION_REGISTRY.get).toBe('function');
        expect(DEFAULT_ACTION_REGISTRY.has('customer.read')).toBe(true);

        const def = DEFAULT_ACTION_REGISTRY.get('customer.read')!;
        try {
          (def as unknown as Record<string, unknown>).code = 'audit.read';
        } catch {
          // Expected
        }
        try {
          (def as unknown as Record<string, unknown>).assurance = 'SECURE_GRANT';
        } catch {
          // Expected
        }

        expect(def.code).toBe('customer.read');
        expect(def.assurance).toBe('NORMAL_SESSION');
      });

      // 4. nested array and nested requirement mutation
      it('4. Nested array and requirement mutation on returned ActionDefinition fails with zero effect', () => {
        const def = DEFAULT_ACTION_REGISTRY.get('customer.read')!;
        const normalPerms = def.requiredNormalPermissions as string[];
        const sensPerms = def.requiredSensitivePermissions as string[];

        try {
          normalPerms.push('audit.read');
        } catch {
          // Expected
        }
        try {
          normalPerms[0] = 'audit.read';
        } catch {
          // Expected
        }
        try {
          normalPerms.pop();
        } catch {
          // Expected
        }
        try {
          sensPerms.push('sensitive.identity.read');
        } catch {
          // Expected
        }

        expect(def.requiredNormalPermissions).toEqual(['customer.read']);
        expect(def.requiredSensitivePermissions).toEqual([]);

        // New lookup is completely unaffected
        const freshDef = DEFAULT_ACTION_REGISTRY.get('customer.read')!;
        expect(freshDef.requiredNormalPermissions).toEqual(['customer.read']);
        expect(freshDef.requiredSensitivePermissions).toEqual([]);
      });

      // 5. mutation through returned list/snapshot
      it('5. Mutation through returned list snapshot fails and cannot alter registry contents', () => {
        const list = DEFAULT_ACTION_REGISTRY.list();
        const fakeAction = validateAndCreateActionDefinition({
          code: 'customer.fake',
          authority: 'MEMBERSHIP_AUTHORIZED',
          requiredNormalPermissions: ['customer.read'],
          requiredSensitivePermissions: [],
          assurance: 'NORMAL_SESSION',
        });

        try {
          (list as ActionDefinition[]).push(fakeAction);
        } catch {
          // Expected
        }
        try {
          (list as ActionDefinition[])[0] = fakeAction;
        } catch {
          // Expected
        }

        const freshList = DEFAULT_ACTION_REGISTRY.list();
        expect(freshList.some((a) => a.code === 'customer.fake')).toBe(false);

        const customerReadInList = list.find((a) => a.code === 'customer.read')!;
        try {
          (customerReadInList.requiredNormalPermissions as string[]).push('audit.read');
        } catch {
          // Expected
        }

        expect(DEFAULT_ACTION_REGISTRY.get('customer.read')?.requiredNormalPermissions).toEqual([
          'customer.read',
        ]);
      });

      // 6. prototype mutation where meaningful
      it('6. Prototype mutation cannot hijack DEFAULT_ACTION_REGISTRY or returned definitions', () => {
        try {
          Object.setPrototypeOf(DEFAULT_ACTION_REGISTRY, {
            get: () => ({
              code: 'customer.read',
              authority: 'MEMBERSHIP_AUTHORIZED',
              requiredNormalPermissions: ['audit.read'],
              requiredSensitivePermissions: [],
              assurance: 'NORMAL_SESSION',
            }),
          });
        } catch {
          // Expected for frozen object
        }

        const def = DEFAULT_ACTION_REGISTRY.get('customer.read');
        expect(def?.requiredNormalPermissions).toEqual(['customer.read']);
      });

      // 7. original audit.read-only remap exploit against customer.read
      it('7. Remap exploit of customer.read to audit.read fails with zero authority effect', async () => {
        // Grant ONLY audit.read to Member
        await db
          .prepare(
            `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
             VALUES ('rec-grant-audit-only', ?, 'audit.read', 'UNSCOPED')`,
          )
          .bind(REC_MEMBER_MEMBERSHIP_ID)
          .run();

        // Attacker attempts to remap customer.read in DEFAULT_ACTION_REGISTRY
        try {
          (DEFAULT_ACTION_REGISTRY as unknown as { set: (k: string, v: unknown) => void }).set?.(
            'customer.read',
            validateAndCreateActionDefinition({
              code: 'customer.read',
              authority: 'MEMBERSHIP_AUTHORIZED',
              requiredNormalPermissions: ['audit.read'],
              requiredSensitivePermissions: [],
              assurance: 'NORMAL_SESSION',
            }),
          );
        } catch {
          // Safely catches
        }

        // Evaluate customer.read for the member who only has audit.read
        const res = await evaluateAuthorization(
          db,
          {
            context: getRecMemberContext(1),
            action: 'customer.read',
            agencyId: TEST_AGENCY,
            resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
          },
          { resolvers: TEST_RESOLVERS },
        );

        // MUST be denied with PERMISSION_NOT_GRANTED (not remapped to audit.read)
        expect(res.decision).toBe('DENY');
        expect(res.code).toBe('PERMISSION_NOT_GRANTED');
      });

      // 8. assurance getter flip
      it('8. Assurance getter flip is rejected by the registry builder and cannot bypass direct evaluation', async () => {
        let assuranceReads = 0;
        const flipAssuranceDef = {
          code: 'customer.flip_assurance',
          authority: 'MEMBERSHIP_AUTHORIZED',
          requiredNormalPermissions: ['customer.read'],
          requiredSensitivePermissions: [],
          get assurance() {
            assuranceReads++;
            // Returns NORMAL_SESSION on 1st read, flips to SECURE_GRANT on 2nd read
            return assuranceReads === 1 ? 'NORMAL_SESSION' : 'SECURE_GRANT';
          },
        } as unknown as ActionDefinition;

        expect(() => createActionRegistry([flipAssuranceDef])).toThrow();
        expect(assuranceReads).toBe(0);

        // Second test: Flip from SECURE_GRANT to NORMAL_SESSION (attempting to bypass SECURE_GRANT)
        let bypassReads = 0;
        const bypassAssuranceDef = {
          code: 'customer.bypass_assurance',
          authority: 'MEMBERSHIP_AUTHORIZED',
          requiredNormalPermissions: ['customer.read'],
          requiredSensitivePermissions: [],
          get assurance() {
            bypassReads++;
            return bypassReads === 1 ? 'SECURE_GRANT' : 'NORMAL_SESSION';
          },
        } as unknown as ActionDefinition;

        const bypassRegistry = {
          get: (_c: string) => bypassAssuranceDef,
        };

        const bypassRes = await evaluateAuthorization(
          db,
          {
            context: getRecOwnerContext(1),
            action: 'customer.bypass_assurance',
            agencyId: TEST_AGENCY,
            resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
          },
          { actions: bypassRegistry, resolvers: TEST_RESOLVERS },
        );

        // Captured as SECURE_GRANT, so MUST DENY with SECURE_GRANT_REQUIRED
        expect(bypassRes.decision).toBe('DENY');
        expect(bypassRes.code).toBe('SECURE_GRANT_REQUIRED');
      });

      // 9. permission/permissions getter flip
      it('9. Permission getter flip is captured once and cannot grant unauthorized access', async () => {
        // Grant ONLY audit.read to member
        await db
          .prepare(
            `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
             VALUES ('rec-flip-grant', ?, 'audit.read', 'UNSCOPED')`,
          )
          .bind(REC_MEMBER_MEMBERSHIP_ID)
          .run();

        let getterCallCount = 0;
        const flipPermsDef = {
          code: 'customer.flip_perms',
          authority: 'MEMBERSHIP_AUTHORIZED',
          get requiredNormalPermissions() {
            getterCallCount++;
            // 1st call during validation: customer.read
            // 2nd call if re-read during evaluation: audit.read
            return getterCallCount === 1 ? ['customer.read'] : ['audit.read'];
          },
          requiredSensitivePermissions: [],
          assurance: 'NORMAL_SESSION',
        } as unknown as ActionDefinition;

        const customRegistry = {
          get: (_c: string) => flipPermsDef,
        };

        const res = await evaluateAuthorization(
          db,
          {
            context: getRecMemberContext(1),
            action: 'customer.flip_perms',
            agencyId: TEST_AGENCY,
            resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
          },
          { actions: customRegistry, resolvers: TEST_RESOLVERS },
        );

        // Evaluator captured customer.read once and evaluated only that.
        // Member does not have customer.read -> DENY
        expect(res.decision).toBe('DENY');
        expect(res.code).toBe('PERMISSION_NOT_GRANTED');
      });

      // 10. original array mutation
      it('10. Caller array mutation after validateAndCreateActionDefinition has zero authority effect', () => {
        const callerNormal = ['customer.read'];
        const callerSens = ['sensitive.identity.read'];

        const def = validateAndCreateActionDefinition({
          code: 'customer.array_test',
          authority: 'MEMBERSHIP_AUTHORIZED',
          requiredNormalPermissions: callerNormal,
          requiredSensitivePermissions: callerSens,
          assurance: 'NORMAL_SESSION',
        });

        // Caller mutates original arrays
        callerNormal[0] = 'audit.read';
        callerNormal.push('task.create');
        callerSens.length = 0;

        expect(def.requiredNormalPermissions).toEqual(['customer.read']);
        expect(def.requiredSensitivePermissions).toEqual(['sensitive.identity.read']);
        expect(def.requiredNormalPermissions).not.toBe(callerNormal);
        expect(def.requiredSensitivePermissions).not.toBe(callerSens);
      });

      // 11. nested object mutation if representation supports it
      it('11. Nested object structures are frozen and cannot be mutated', () => {
        const def = validateAndCreateActionDefinition({
          code: 'customer.nested_test',
          authority: 'MEMBERSHIP_AUTHORIZED',
          requiredNormalPermissions: ['customer.read'],
          requiredSensitivePermissions: [],
          assurance: 'NORMAL_SESSION',
        });

        expect(Object.isFrozen(def)).toBe(true);
        expect(Object.isFrozen(def.requiredNormalPermissions)).toBe(true);
        expect(Object.isFrozen(def.requiredSensitivePermissions)).toBe(true);

        try {
          Object.defineProperty(def, 'assurance', { value: 'SECURE_GRANT' });
        } catch {
          // Expected
        }
        expect(def.assurance).toBe('NORMAL_SESSION');
      });

      // 12. alternating Proxy
      it('12. Alternating Proxy values fail-closed or evaluate consistently on canonical snapshot', async () => {
        let flip = false;
        const alternatingDef = new Proxy(
          {
            code: 'customer.alt_proxy',
            authority: 'MEMBERSHIP_AUTHORIZED',
            assurance: 'NORMAL_SESSION',
            requiredSensitivePermissions: [],
          },
          {
            get(target, prop) {
              if (prop === 'requiredNormalPermissions') {
                flip = !flip;
                return flip ? ['customer.read'] : ['audit.read'];
              }
              return (target as Record<string, unknown>)[prop as string];
            },
          },
        ) as unknown as ActionDefinition;

        const customRegistry = {
          get: (_c: string) => alternatingDef,
        };

        // Member has NO permissions
        const res = await evaluateAuthorization(
          db,
          {
            context: getRecMemberContext(1),
            action: 'customer.alt_proxy',
            agencyId: TEST_AGENCY,
            resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
          },
          { actions: customRegistry, resolvers: TEST_RESOLVERS },
        );

        // Regardless of which alternation was captured, member has no permissions -> DENY
        expect(res.decision).toBe('DENY');
      });

      // 13. throwing getter
      it('13. Throwing getter on any ActionDefinition field fails closed to UNKNOWN_ACTION', async () => {
        const fields = [
          'code',
          'authority',
          'requiredNormalPermissions',
          'requiredSensitivePermissions',
          'assurance',
        ] as const;

        for (const field of fields) {
          const base: Record<string, unknown> = {
            code: 'customer.throw_field',
            authority: 'MEMBERSHIP_AUTHORIZED',
            requiredNormalPermissions: ['customer.read'],
            requiredSensitivePermissions: [],
            assurance: 'NORMAL_SESSION',
          };
          Object.defineProperty(base, field, {
            get() {
              throw new Error(`Hostile getter explosion on ${field}`);
            },
          });

          const registry = {
            get: (_c: string) => base as unknown as ActionDefinition,
          };

          const res = await evaluateAuthorization(
            db,
            {
              context: getRecOwnerContext(1),
              action: 'customer.throw_field',
              agencyId: TEST_AGENCY,
            },
            { actions: registry },
          );

          expect(res.decision).toBe('DENY');
          expect(res.code).toBe('UNKNOWN_ACTION');
        }
      });

      // 14. malformed cast direct evaluator path
      it('14. Malformed cast ActionDefinitions via custom registry fail closed to UNKNOWN_ACTION', async () => {
        const malformedDefs: unknown[] = [
          // Non-string code
          {
            code: 12345,
            requiredNormalPermissions: ['customer.read'],
            assurance: 'NORMAL_SESSION',
          },
          // Untrimmed code
          {
            code: ' customer.read ',
            requiredNormalPermissions: ['customer.read'],
            assurance: 'NORMAL_SESSION',
          },
          // Code mismatch with requested action
          {
            code: 'customer.other',
            requiredNormalPermissions: ['customer.read'],
            assurance: 'NORMAL_SESSION',
          },
          // Not an array
          {
            code: 'customer.bad',
            requiredNormalPermissions: 'customer.read',
            assurance: 'NORMAL_SESSION',
          },
          // Empty normal perms array
          { code: 'customer.bad', requiredNormalPermissions: [], assurance: 'NORMAL_SESSION' },
          // Unknown permission
          {
            code: 'customer.bad',
            requiredNormalPermissions: ['unknown.perm'],
            assurance: 'NORMAL_SESSION',
          },
          // Sensitive permission placed in normal perms
          {
            code: 'customer.bad',
            requiredNormalPermissions: ['sensitive.identity.read'],
            assurance: 'NORMAL_SESSION',
          },
          // Normal permission placed in sensitive perms
          {
            code: 'customer.bad',
            requiredNormalPermissions: ['customer.read'],
            requiredSensitivePermissions: ['customer.update'],
            assurance: 'NORMAL_SESSION',
          },
          // Invalid assurance string
          {
            code: 'customer.bad',
            requiredNormalPermissions: ['customer.read'],
            assurance: 'INVALID_VALUE',
          },
          // Extra unrecognized field
          {
            code: 'customer.bad',
            requiredNormalPermissions: ['customer.read'],
            exploitPayload: true,
            assurance: 'NORMAL_SESSION',
          },
        ];

        for (const malformed of malformedDefs) {
          const registry = {
            get: (_c: string) => malformed as ActionDefinition,
          };

          const res = await evaluateAuthorization(
            db,
            {
              context: getRecOwnerContext(1),
              action: 'customer.bad',
              agencyId: TEST_AGENCY,
            },
            { actions: registry },
          );

          expect(res.decision).toBe('DENY');
          expect(res.code).toBe('UNKNOWN_ACTION');
        }
      });

      // 15. registry alias mutation
      it('15. Custom registry alias mutation attempts have zero effect on internal storage', () => {
        const action = validateAndCreateActionDefinition({
          code: 'customer.alias_action',
          authority: 'MEMBERSHIP_AUTHORIZED',
          requiredNormalPermissions: ['customer.read'],
          requiredSensitivePermissions: [],
          assurance: 'NORMAL_SESSION',
        });

        const registry = createActionRegistry([action]);
        const alias = registry;

        try {
          (alias as unknown as { set: (k: string, v: unknown) => void }).set?.(
            'customer.alias_action',
            {},
          );
        } catch {
          // Expected
        }

        try {
          (alias as unknown as Record<string, unknown>)['customer.alias_action'] = {};
        } catch {
          // Expected
        }

        expect(registry.get('customer.alias_action')?.code).toBe('customer.alias_action');
      });

      // 16. original input mutation after canonicalization
      it('16. Original input object mutation after canonicalization does not affect ActionDefinition', () => {
        const inputObj = {
          code: 'customer.input_test',
          authority: 'MEMBERSHIP_AUTHORIZED' as const,
          requiredNormalPermissions: ['customer.read'],
          requiredSensitivePermissions: [] as string[],
          assurance: 'NORMAL_SESSION' as const,
        };

        const canonical = validateAndCreateActionDefinition(inputObj);

        // Mutate original input object
        inputObj.code = 'audit.read';
        inputObj.requiredNormalPermissions.push('audit.read');
        inputObj.requiredSensitivePermissions.push('sensitive.identity.read');
        (inputObj as Record<string, unknown>).assurance = 'SECURE_GRANT';

        expect(canonical.code).toBe('customer.input_test');
        expect(canonical.requiredNormalPermissions).toEqual(['customer.read']);
        expect(canonical.requiredSensitivePermissions).toEqual([]);
        expect(canonical.assurance).toBe('NORMAL_SESSION');
      });

      // 17. SENSITIVE-only regression
      it('17. SENSITIVE-only actions cannot be created and evaluate to UNKNOWN_ACTION', async () => {
        expect(() => {
          validateAndCreateActionDefinition({
            code: 'sensitive.identity_only',
            authority: 'MEMBERSHIP_AUTHORIZED',
            requiredNormalPermissions: [],
            requiredSensitivePermissions: ['sensitive.identity.read'],
            assurance: 'NORMAL_SESSION',
          });
        }).toThrow();

        const fakeSensOnly = {
          code: 'sensitive.identity_only',
          authority: 'MEMBERSHIP_AUTHORIZED',
          requiredNormalPermissions: [],
          requiredSensitivePermissions: ['sensitive.identity.read'],
          assurance: 'NORMAL_SESSION',
        } as unknown as ActionDefinition;

        const registry = {
          get: (_c: string) => fakeSensOnly,
        };

        const res = await evaluateAuthorization(
          db,
          {
            context: getRecOwnerContext(1),
            action: 'sensitive.identity_only',
            agencyId: TEST_AGENCY,
          },
          { actions: registry },
        );

        expect(res.decision).toBe('DENY');
        expect(res.code).toBe('UNKNOWN_ACTION');
      });

      // 18. NORMAL record-scope bypass regression
      it('18. NORMAL record-scope cannot be bypassed without valid matching resource and resolver', async () => {
        // Grant customer.read (RECORD_SCOPED) to member
        await db
          .prepare(
            `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
             VALUES ('rec-record-scope-grant', ?, 'customer.read', 'ASSIGNED')`,
          )
          .bind(REC_MEMBER_MEMBERSHIP_ID)
          .run();

        // A. Missing resource -> MALFORMED_INPUT
        const noRes = await evaluateAuthorization(
          db,
          {
            context: getRecMemberContext(1),
            action: 'customer.read',
            agencyId: TEST_AGENCY,
          },
          { resolvers: TEST_RESOLVERS },
        );
        expect(noRes.decision).toBe('DENY');
        expect(noRes.code).toBe('MALFORMED_INPUT');

        // B. Null resource -> MALFORMED_INPUT
        const nullRes = await evaluateAuthorization(
          db,
          {
            context: getRecMemberContext(1),
            action: 'customer.read',
            agencyId: TEST_AGENCY,
            resource: null,
          },
          { resolvers: TEST_RESOLVERS },
        );
        expect(nullRes.decision).toBe('DENY');
        expect(nullRes.code).toBe('MALFORMED_INPUT');

        // C. Cross-agency resource -> AGENCY_MISMATCH
        const crossAgencyRes = await evaluateAuthorization(
          db,
          {
            context: getRecMemberContext(1),
            action: 'customer.read',
            agencyId: TEST_AGENCY,
            resource: { agencyId: OTHER_AGENCY, isAllowedRecord: true },
          },
          { resolvers: TEST_RESOLVERS },
        );
        expect(crossAgencyRes.decision).toBe('DENY');
        expect(crossAgencyRes.code).toBe('AGENCY_MISMATCH');

        // D. Resolver rejects -> SCOPE_RESOLVER_DENIED
        const deniedRes = await evaluateAuthorization(
          db,
          {
            context: getRecMemberContext(1),
            action: 'customer.read',
            agencyId: TEST_AGENCY,
            resource: { agencyId: TEST_AGENCY, isAllowedRecord: false },
          },
          { resolvers: TEST_RESOLVERS },
        );
        expect(deniedRes.decision).toBe('DENY');
        expect(deniedRes.code).toBe('SCOPE_RESOLVER_DENIED');
      });

      // 19. request.action flipping prevents TOCTOU desynchronization and ensures single capture
      it('19. request.action flipping getter is captured exactly once and prevents TOCTOU', async () => {
        let reads = 0;
        const req = {
          context: getRecMemberContext(1),
          get action() {
            reads += 1;
            if (reads === 1) return 'customer.read';
            if (reads === 2) return 'audit.read';
            return undefined;
          },
          agencyId: TEST_AGENCY,
          resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
        } as unknown as AuthorizationRequest;

        const res = await evaluateAuthorization(db, req, { resolvers: TEST_RESOLVERS });
        expect(reads).toBe(1);
        expect(res.decision).toBe('DENY');
        expect(res.code).toBe('PERMISSION_NOT_GRANTED');
      });

      // 20. request.action throwing getter fails closed to MALFORMED_INPUT
      it('20. request.action throwing getter fails closed to MALFORMED_INPUT', async () => {
        const req = {
          context: getRecOwnerContext(1),
          get action() {
            throw new Error('Hostile action getter');
          },
          agencyId: TEST_AGENCY,
        } as unknown as AuthorizationRequest;

        const res = await evaluateAuthorization(db, req);
        expect(res.decision).toBe('DENY');
        expect(res.code).toBe('MALFORMED_INPUT');
      });

      // 21. request.permissionCode flipping prevents TOCTOU desynchronization
      it('21. request.permissionCode flipping getter is captured exactly once and prevents TOCTOU', async () => {
        let reads = 0;
        const req = {
          context: getRecMemberContext(1),
          get permissionCode() {
            reads += 1;
            if (reads === 1) return 'customer.read';
            if (reads === 2) return 'audit.read';
            return undefined;
          },
          agencyId: TEST_AGENCY,
          resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
        } as unknown as AuthorizationRequest;

        const res = await evaluateAuthorization(db, req, { resolvers: TEST_RESOLVERS });
        expect(reads).toBe(1);
        expect(res.decision).toBe('DENY');
        expect(res.code).toBe('PERMISSION_NOT_GRANTED');
      });

      // 22. request.permissionCode throwing getter fails closed to MALFORMED_INPUT
      it('22. request.permissionCode throwing getter fails closed to MALFORMED_INPUT', async () => {
        const req = {
          context: getRecOwnerContext(1),
          get permissionCode() {
            throw new Error('Hostile permissionCode getter');
          },
          agencyId: TEST_AGENCY,
        } as unknown as AuthorizationRequest;

        const res = await evaluateAuthorization(db, req);
        expect(res.decision).toBe('DENY');
        expect(res.code).toBe('MALFORMED_INPUT');
      });

      // 23. request.agencyId flipping is captured once and prevents bypass
      it('23. request.agencyId flipping getter is captured exactly once', async () => {
        let reads = 0;
        const req = {
          context: getRecOwnerContext(1),
          action: 'customer.read',
          get agencyId() {
            reads += 1;
            return reads === 1 ? TEST_AGENCY : OTHER_AGENCY;
          },
          resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
        } as unknown as AuthorizationRequest;

        const res = await evaluateAuthorization(db, req, { resolvers: TEST_RESOLVERS });
        expect(reads).toBe(1);
        expect(res.decision).toBe('ALLOW');

        // Second variation: starts with invalid agencyId then flips to valid
        let reads2 = 0;
        const req2 = {
          context: getRecOwnerContext(1),
          action: 'customer.read',
          get agencyId() {
            reads2 += 1;
            return reads2 === 1 ? OTHER_AGENCY : TEST_AGENCY;
          },
          resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
        } as unknown as AuthorizationRequest;

        const res2 = await evaluateAuthorization(db, req2, { resolvers: TEST_RESOLVERS });
        expect(reads2).toBe(1);
        expect(res2.decision).toBe('DENY');
      });

      // 24. request.agencyId throwing getter fails closed to MALFORMED_INPUT
      it('24. request.agencyId throwing getter fails closed to MALFORMED_INPUT', async () => {
        const req = {
          context: getRecOwnerContext(1),
          action: 'customer.read',
          get agencyId() {
            throw new Error('Hostile agencyId getter');
          },
        } as unknown as AuthorizationRequest;

        const res = await evaluateAuthorization(db, req);
        expect(res.decision).toBe('DENY');
        expect(res.code).toBe('MALFORMED_INPUT');
      });

      // 25. request.resource flipping is captured once
      it('25. request.resource flipping getter is captured exactly once and prevents TOCTOU', async () => {
        let reads = 0;
        const req = {
          context: getRecOwnerContext(1),
          action: 'customer.read',
          agencyId: TEST_AGENCY,
          get resource() {
            reads += 1;
            return reads === 1 ? null : { agencyId: TEST_AGENCY, isAllowedRecord: true };
          },
        } as unknown as AuthorizationRequest;

        const res = await evaluateAuthorization(db, req, { resolvers: TEST_RESOLVERS });
        expect(reads).toBe(1);
        expect(res.decision).toBe('DENY');
        expect(res.code).toBe('MALFORMED_INPUT');
      });

      // 26. request.resource throwing getter fails closed to MALFORMED_INPUT
      it('26. request.resource throwing getter fails closed to MALFORMED_INPUT', async () => {
        const req = {
          context: getRecOwnerContext(1),
          action: 'customer.read',
          agencyId: TEST_AGENCY,
          get resource() {
            throw new Error('Hostile resource getter');
          },
        } as unknown as AuthorizationRequest;

        const res = await evaluateAuthorization(db, req);
        expect(res.decision).toBe('DENY');
        expect(res.code).toBe('MALFORMED_INPUT');
      });

      // 27. resource.agencyId flipping is captured once and prevents boundary bypass
      it('27. resource.agencyId flipping getter is captured once and prevents bypass', async () => {
        let agencyReads = 0;
        const hostileResource = {
          get agencyId() {
            agencyReads += 1;
            return agencyReads === 1 ? OTHER_AGENCY : TEST_AGENCY;
          },
          isAllowedRecord: true,
        };

        const req = {
          context: getRecOwnerContext(1),
          action: 'customer.read',
          agencyId: TEST_AGENCY,
          resource: hostileResource,
        } as unknown as AuthorizationRequest;

        const res = await evaluateAuthorization(db, req, { resolvers: TEST_RESOLVERS });
        expect(agencyReads).toBe(1);
        expect(res.decision).toBe('DENY');
        expect(res.code).toBe('AGENCY_MISMATCH');
      });

      // 28. resource.agencyId throwing getter fails closed to MALFORMED_INPUT
      it('28. resource.agencyId throwing getter fails closed to MALFORMED_INPUT', async () => {
        const hostileResource = {
          get agencyId() {
            throw new Error('Hostile resource.agencyId getter');
          },
          isAllowedRecord: true,
        };

        const req = {
          context: getRecOwnerContext(1),
          action: 'customer.read',
          agencyId: TEST_AGENCY,
          resource: hostileResource,
        } as unknown as AuthorizationRequest;

        const res = await evaluateAuthorization(db, req);
        expect(res.decision).toBe('DENY');
        expect(res.code).toBe('MALFORMED_INPUT');
      });

      // 29. Exact audit.read-only MEMBER exploit via request TOCTOU fails closed with zero authority effect
      it('29. Exact audit.read-only MEMBER exploit via request.action TOCTOU getter fails closed', async () => {
        // Grant ONLY audit.read to Member
        await db
          .prepare(
            `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
             VALUES ('rec-audit-toctou-grant', ?, 'audit.read', 'UNSCOPED')`,
          )
          .bind(REC_MEMBER_MEMBERSHIP_ID)
          .run();

        let actionReads = 0;
        const maliciousReq = {
          context: getRecMemberContext(1),
          get action() {
            actionReads += 1;
            if (actionReads === 1) return 'customer.read';
            return 'audit.read';
          },
          agencyId: TEST_AGENCY,
          resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
        } as unknown as AuthorizationRequest;

        const res = await evaluateAuthorization(db, maliciousReq, { resolvers: TEST_RESOLVERS });

        expect(actionReads).toBe(1);
        expect(res.decision).toBe('DENY');
        expect(res.code).toBe('PERMISSION_NOT_GRANTED');
      });
    });

    describe('Final recovery: detached snapshots, OWNER integrity, and action authority', () => {
      const memberCustomerGrantId = 'final-rec-member-customer-read';

      async function grantMemberCustomerRead(): Promise<void> {
        await db
          .prepare(
            `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
             VALUES (?, ?, 'customer.read', 'ASSIGNED')`,
          )
          .bind(memberCustomerGrantId, REC_MEMBER_MEMBERSHIP_ID)
          .run();
      }

      function withPrepareHook(hook: () => void): D1Database {
        let fired = false;
        return new Proxy(db, {
          get(target, property, receiver) {
            if (property === 'prepare') {
              return (query: string) => {
                if (!fired) {
                  fired = true;
                  hook();
                }
                return target.prepare(query);
              };
            }
            const value = Reflect.get(target, property, receiver) as unknown;
            return typeof value === 'function' ? value.bind(target) : value;
          },
        });
      }

      function customerReadRequest(
        context: AuthenticatedUserContext,
        resource: Record<string, unknown> = {
          agencyId: TEST_AGENCY,
          isAllowedRecord: true,
        },
      ): AuthorizationRequest {
        return {
          context,
          action: 'customer.read',
          agencyId: TEST_AGENCY,
          resource,
        };
      }

      it('1. snapshots membership.type once when its getter changes MEMBER to OWNER', async () => {
        let reads = 0;
        const membership = {
          ...getRecMemberContext().memberships[0],
          get type() {
            reads += 1;
            return reads === 1 ? 'MEMBER' : 'OWNER';
          },
        } as unknown as AuthenticatedUserContext['memberships'][number];
        const context = { ...getRecMemberContext(), memberships: [membership] };

        const result = await evaluateAuthorization(db, customerReadRequest(context), {
          resolvers: TEST_RESOLVERS,
        });

        expect(reads).toBe(1);
        expect(result.decision).toBe('DENY');
        expect(result.code).toBe('PERMISSION_NOT_GRANTED');
      });

      it('2. preserves canonical MEMBER semantics when caller mutates type during D1 lifecycle work', async () => {
        const context = getRecMemberContext();
        const mutableMembership = context.memberships[0] as { type: 'MEMBER' | 'OWNER' };
        const hookedDb = withPrepareHook(() => {
          mutableMembership.type = 'OWNER';
        });

        const result = await evaluateAuthorization(hookedDb, customerReadRequest(context), {
          resolvers: TEST_RESOLVERS,
        });

        expect(mutableMembership.type).toBe('OWNER');
        expect(result.decision).toBe('DENY');
        expect(result.code).toBe('PERMISSION_NOT_GRANTED');
      });

      it('3. does not expand authority when membership agencyId changes during lifecycle work', async () => {
        await grantMemberCustomerRead();
        const context = getRecMemberContext();
        const mutableMembership = context.memberships[0] as { agencyId: string };
        const hookedDb = withPrepareHook(() => {
          mutableMembership.agencyId = OTHER_AGENCY;
        });

        const result = await evaluateAuthorization(hookedDb, customerReadRequest(context), {
          resolvers: TEST_RESOLVERS,
        });

        expect(result.decision).toBe('ALLOW');
        expect(mutableMembership.agencyId).toBe(OTHER_AGENCY);

        let agencyReads = 0;
        const unstableMembership = {
          ...getRecMemberContext().memberships[0],
          get agencyId() {
            agencyReads += 1;
            return agencyReads === 1 ? OTHER_AGENCY : TEST_AGENCY;
          },
        } as AuthenticatedUserContext['memberships'][number];
        const unstableResult = await evaluateAuthorization(
          db,
          customerReadRequest({
            ...getRecMemberContext(),
            memberships: [unstableMembership],
          }),
          { resolvers: TEST_RESOLVERS },
        );
        expect(agencyReads).toBe(1);
        expect(unstableResult.decision).toBe('DENY');
        expect(unstableResult.code).toBe('MEMBERSHIP_NOT_FOUND');
      });

      it('4. snapshots membership status and denies an initially inactive membership despite mutation', async () => {
        const context = getRecMemberContext();
        const mutableMembership = context.memberships[0] as { status: 'ACTIVE' | 'SUSPENDED' };
        mutableMembership.status = 'SUSPENDED';
        const hookedDb = withPrepareHook(() => {
          mutableMembership.status = 'ACTIVE';
        });

        const result = await evaluateAuthorization(hookedDb, customerReadRequest(context), {
          resolvers: TEST_RESOLVERS,
        });

        expect(result.decision).toBe('DENY');
        expect(result.code).toBe('INVALID_CONTEXT');
      });

      it('5. fails closed for alternating and throwing membership accessors', async () => {
        let typeReads = 0;
        const alternating = new Proxy(getRecMemberContext().memberships[0]!, {
          get(target, property, receiver) {
            if (property === 'type') {
              typeReads += 1;
              return typeReads % 2 === 1 ? 'MEMBER' : 'OWNER';
            }
            return Reflect.get(target, property, receiver);
          },
        });
        const alternatingContext = {
          ...getRecMemberContext(),
          memberships: [alternating],
        } as AuthenticatedUserContext;
        const alternatingResult = await evaluateAuthorization(
          db,
          customerReadRequest(alternatingContext),
          { resolvers: TEST_RESOLVERS },
        );
        expect(typeReads).toBe(1);
        expect(alternatingResult.decision).toBe('DENY');

        const throwing = {
          ...getRecMemberContext().memberships[0],
          get agencyId(): string {
            throw new Error('hostile membership getter');
          },
        } as AuthenticatedUserContext['memberships'][number];
        const throwingResult = await evaluateAuthorization(
          db,
          customerReadRequest({ ...getRecMemberContext(), memberships: [throwing] }),
          { resolvers: TEST_RESOLVERS },
        );
        expect(throwingResult.decision).toBe('DENY');
        expect(throwingResult.code).toBe('INVALID_CONTEXT');
      });

      it('6. keeps assigned=false when caller changes it to true during asynchronous evaluation', async () => {
        await grantMemberCustomerRead();
        const resource = { agencyId: TEST_AGENCY, assigned: false };
        const hookedDb = withPrepareHook(() => {
          resource.assigned = true;
        });
        const resolvers: Partial<ScopeResolverRegistry> = {
          customer_record_resolver: ({ resource: snapshot }) =>
            (snapshot as { assigned?: boolean } | undefined)?.assigned === true,
        };

        const result = await evaluateAuthorization(
          hookedDb,
          customerReadRequest(getRecMemberContext(), resource),
          { resolvers },
        );

        expect(resource.assigned).toBe(true);
        expect(result.decision).toBe('DENY');
        expect(result.code).toBe('SCOPE_RESOLVER_DENIED');
      });

      it('7. keeps assigned=true when caller changes it to false during asynchronous evaluation', async () => {
        await grantMemberCustomerRead();
        const resource = { agencyId: TEST_AGENCY, assigned: true };
        const hookedDb = withPrepareHook(() => {
          resource.assigned = false;
        });
        const resolvers: Partial<ScopeResolverRegistry> = {
          customer_record_resolver: ({ resource: snapshot }) =>
            (snapshot as { assigned?: boolean } | undefined)?.assigned === true,
        };

        const result = await evaluateAuthorization(
          hookedDb,
          customerReadRequest(getRecMemberContext(), resource),
          { resolvers },
        );

        expect(resource.assigned).toBe(false);
        expect(result.decision).toBe('ALLOW');
      });

      it('8. detaches resource agencyId before caller mutation', async () => {
        await grantMemberCustomerRead();
        const resource = { agencyId: TEST_AGENCY, isAllowedRecord: true };
        const hookedDb = withPrepareHook(() => {
          resource.agencyId = OTHER_AGENCY;
        });

        const result = await evaluateAuthorization(
          hookedDb,
          customerReadRequest(getRecMemberContext(), resource),
          { resolvers: TEST_RESOLVERS },
        );

        expect(resource.agencyId).toBe(OTHER_AGENCY);
        expect(result.decision).toBe('ALLOW');
      });

      it('9. deeply detaches nested resource authorization data', async () => {
        await grantMemberCustomerRead();
        const resource = {
          agencyId: TEST_AGENCY,
          authorization: { ownership: { assigned: false } },
        };
        const hookedDb = withPrepareHook(() => {
          resource.authorization.ownership.assigned = true;
        });
        const resolvers: Partial<ScopeResolverRegistry> = {
          customer_record_resolver: ({ resource: snapshot }) =>
            (snapshot as { authorization?: { ownership?: { assigned?: boolean } } } | undefined)
              ?.authorization?.ownership?.assigned === true,
        };

        const result = await evaluateAuthorization(
          hookedDb,
          customerReadRequest(getRecMemberContext(), resource),
          { resolvers },
        );

        expect(resource.authorization.ownership.assigned).toBe(true);
        expect(result.decision).toBe('DENY');
        expect(result.code).toBe('SCOPE_RESOLVER_DENIED');
      });

      it('10. deterministically snapshots alternating resource accessors and denies throwing getters', async () => {
        await grantMemberCustomerRead();
        let assignedReads = 0;
        const alternatingResource = {
          agencyId: TEST_AGENCY,
          get assigned() {
            assignedReads += 1;
            return assignedReads === 1;
          },
        };
        const resolvers: Partial<ScopeResolverRegistry> = {
          customer_record_resolver: ({ resource }) =>
            (resource as { assigned?: boolean } | undefined)?.assigned === true,
        };
        const alternatingResult = await evaluateAuthorization(
          db,
          customerReadRequest(getRecMemberContext(), alternatingResource),
          { resolvers },
        );
        expect(assignedReads).toBe(1);
        expect(alternatingResult.decision).toBe('ALLOW');

        const throwingResource = {
          get agencyId(): string {
            throw new Error('hostile resource getter');
          },
          assigned: true,
        };
        const throwingResult = await evaluateAuthorization(
          db,
          customerReadRequest(getRecMemberContext(), throwingResource),
          { resolvers },
        );
        expect(throwingResult.decision).toBe('DENY');
        expect(throwingResult.code).toBe('MALFORMED_INPUT');
      });

      function ownerSensitiveAction(): ActionDefinition {
        return validateAndCreateActionDefinition({
          code: 'customer.final_sensitive',
          authority: 'MEMBERSHIP_AUTHORIZED',
          requiredNormalPermissions: ['customer.read'],
          requiredSensitivePermissions: ['sensitive.identity.read'],
          assurance: 'NORMAL_SESSION',
        });
      }

      async function evaluateOwnerSensitive(): Promise<
        Awaited<ReturnType<typeof evaluateAuthorization>>
      > {
        const action = ownerSensitiveAction();
        return evaluateAuthorization(
          db,
          {
            context: getRecOwnerContext(),
            action: action.code,
            agencyId: TEST_AGENCY,
            resource: { agencyId: TEST_AGENCY, isAllowedRecord: true },
          },
          {
            actions: new Map([[action.code, action]]),
            resolvers: TEST_RESOLVERS,
          },
        );
      }

      it('11. denies OWNER when an explicit SENSITIVE dependency is missing', async () => {
        await db
          .prepare(
            `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
             VALUES ('final-owner-identity', ?, 'sensitive.identity.read', 'UNSCOPED'),
                    ('final-owner-health-write', ?, 'sensitive.health.write', 'UNSCOPED')`,
          )
          .bind(REC_OWNER_MEMBERSHIP_ID, REC_OWNER_MEMBERSHIP_ID)
          .run();

        const result = await evaluateOwnerSensitive();
        expect(result.decision).toBe('DENY');
        expect(result.code).toBe('DEPENDENCY_MISSING');
      });

      it('12. denies OWNER when an explicit SENSITIVE dependency has malformed stored scope', async () => {
        await db
          .prepare(
            `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
             VALUES ('final-owner-identity', ?, 'sensitive.identity.read', 'UNSCOPED'),
                    ('final-owner-health-read', ?, 'sensitive.health.read', 'AGENCY'),
                    ('final-owner-health-write', ?, 'sensitive.health.write', 'UNSCOPED')`,
          )
          .bind(REC_OWNER_MEMBERSHIP_ID, REC_OWNER_MEMBERSHIP_ID, REC_OWNER_MEMBERSHIP_ID)
          .run();

        const result = await evaluateOwnerSensitive();
        expect(result.decision).toBe('DENY');
        expect(result.code).toBe('INVALID_STORED_SCOPE');
      });

      it('13. allows OWNER with a complete valid explicit SENSITIVE dependency chain', async () => {
        await db
          .prepare(
            `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
             VALUES ('final-owner-identity', ?, 'sensitive.identity.read', 'UNSCOPED'),
                    ('final-owner-health-read', ?, 'sensitive.health.read', 'UNSCOPED'),
                    ('final-owner-health-write', ?, 'sensitive.health.write', 'UNSCOPED')`,
          )
          .bind(REC_OWNER_MEMBERSHIP_ID, REC_OWNER_MEMBERSHIP_ID, REC_OWNER_MEMBERSHIP_ID)
          .run();

        const result = await evaluateOwnerSensitive();
        expect(result.decision).toBe('ALLOW');
      });

      it('14. ignores known malformed OWNER NORMAL rows during SENSITIVE evaluation', async () => {
        await db
          .prepare(
            `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
             VALUES ('final-owner-identity', ?, 'sensitive.identity.read', 'UNSCOPED'),
                    ('final-owner-normal-corrupt', ?, 'customer.read', 'UNSCOPED')`,
          )
          .bind(REC_OWNER_MEMBERSHIP_ID, REC_OWNER_MEMBERSHIP_ID)
          .run();

        const result = await evaluateOwnerSensitive();
        expect(result.decision).toBe('ALLOW');
      });

      it('15. denies unknown explicit OWNER rows during SENSITIVE evaluation', async () => {
        await db
          .prepare(
            `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
             VALUES ('final-owner-identity', ?, 'sensitive.identity.read', 'UNSCOPED'),
                    ('final-owner-unknown', ?, 'sensitive.unknown.read', 'UNSCOPED')`,
          )
          .bind(REC_OWNER_MEMBERSHIP_ID, REC_OWNER_MEMBERSHIP_ID)
          .run();

        const unknownRowResult = await evaluateOwnerSensitive();
        expect(unknownRowResult.decision).toBe('DENY');
        expect(unknownRowResult.code).toBe('UNKNOWN_PERMISSION');
      });

      function authorityAction(code: string, authority: ActionAuthority): ActionDefinition {
        return validateAndCreateActionDefinition({
          code,
          authority,
          requiredNormalPermissions: ['audit.read'],
          assurance: 'NORMAL_SESSION',
        });
      }

      it('16. permits an ACTIVE OWNER through OWNER_ONLY when ordinary gates pass', async () => {
        const action = authorityAction('audit.owner_only_final', 'OWNER_ONLY');
        const result = await evaluateAuthorization(
          db,
          {
            context: getRecOwnerContext(),
            action: action.code,
            agencyId: TEST_AGENCY,
          },
          { actions: new Map([[action.code, action]]) },
        );
        expect(result.decision).toBe('ALLOW');
      });

      it('17. denies MEMBER and forged request metadata for OWNER_ONLY despite ordinary grant', async () => {
        await db
          .prepare(
            `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
             VALUES ('final-member-audit', ?, 'audit.read', 'UNSCOPED')`,
          )
          .bind(REC_MEMBER_MEMBERSHIP_ID)
          .run();
        const action = authorityAction('audit.owner_only_member_final', 'OWNER_ONLY');
        const request = {
          context: getRecMemberContext(),
          action: action.code,
          agencyId: TEST_AGENCY,
          role: 'OWNER',
          membershipType: 'OWNER',
          token: { role: 'OWNER', type: 'OWNER' },
        } as unknown as AuthorizationRequest;

        const result = await evaluateAuthorization(db, request, {
          actions: new Map([[action.code, action]]),
        });
        expect(result.decision).toBe('DENY');
        expect(result.code).toBe('OWNER_REQUIRED');
      });

      it('18. always denies PROVISIONING_ONLY in the ACTIVE runtime evaluator', async () => {
        const action = authorityAction('audit.provisioning_final', 'PROVISIONING_ONLY');
        const result = await evaluateAuthorization(
          db,
          {
            context: getRecOwnerContext(),
            action: action.code,
            agencyId: TEST_AGENCY,
          },
          { actions: new Map([[action.code, action]]) },
        );
        expect(result.decision).toBe('DENY');
        expect(result.code).toBe('PROVISIONING_NOT_ALLOWED');
      });

      it('19. rejects missing or unknown action authority and denies malformed registry entries', async () => {
        expect(() =>
          validateAndCreateActionDefinition({
            code: 'audit.missing_authority_final',
            requiredNormalPermissions: ['audit.read'],
          } as unknown as {
            code: string;
            authority: ActionAuthority;
            requiredNormalPermissions: string[];
          }),
        ).toThrow();
        expect(() =>
          validateAndCreateActionDefinition({
            code: 'audit.unknown_authority_final',
            authority: 'ROOT_ONLY',
            requiredNormalPermissions: ['audit.read'],
          } as unknown as {
            code: string;
            authority: ActionAuthority;
            requiredNormalPermissions: string[];
          }),
        ).toThrow();

        const malformed = {
          code: 'audit.malformed_authority_final',
          authority: 'ROOT_ONLY',
          requiredNormalPermissions: ['audit.read'],
          requiredSensitivePermissions: [],
          assurance: 'NORMAL_SESSION',
        } as unknown as ActionDefinition;
        const result = await evaluateAuthorization(
          db,
          {
            context: getRecOwnerContext(),
            action: malformed.code,
            agencyId: TEST_AGENCY,
          },
          { actions: new Map([[malformed.code, malformed]]) },
        );
        expect(result.decision).toBe('DENY');
        expect(result.code).toBe('UNKNOWN_ACTION');
      });

      it('20. captures action authority getter once and source mutation cannot change it', async () => {
        await db
          .prepare(
            `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
             VALUES ('final-member-audit', ?, 'audit.read', 'UNSCOPED')`,
          )
          .bind(REC_MEMBER_MEMBERSHIP_ID)
          .run();
        let authorityReads = 0;
        const source = {
          code: 'audit.authority_getter_final',
          get authority(): ActionAuthority {
            authorityReads += 1;
            return authorityReads === 1 ? 'MEMBERSHIP_AUTHORIZED' : 'OWNER_ONLY';
          },
          requiredNormalPermissions: ['audit.read'],
          assurance: 'NORMAL_SESSION' as const,
        };
        const action = validateAndCreateActionDefinition(source);
        Object.defineProperty(source, 'authority', { value: 'OWNER_ONLY' });

        const result = await evaluateAuthorization(
          db,
          {
            context: getRecMemberContext(),
            action: action.code,
            agencyId: TEST_AGENCY,
          },
          { actions: new Map([[action.code, action]]) },
        );

        expect(authorityReads).toBe(1);
        expect(action.authority).toBe('MEMBERSHIP_AUTHORIZED');
        expect(result.decision).toBe('ALLOW');
      });
    });
  });

  describe('Factory configuration snapshot regressions', () => {
    const FACTORY_USER_ID = 'factory-member-user';
    const FACTORY_IDENTITY_ID = 'factory-member-identity';
    const FACTORY_MEMBERSHIP_ID = 'factory-member-membership';

    function factoryContext(type: 'OWNER' | 'MEMBER' = 'MEMBER'): AuthenticatedUserContext {
      return {
        userId: FACTORY_USER_ID,
        identityId: FACTORY_IDENTITY_ID,
        assurance: 'NORMAL',
        memberships: [
          {
            id: FACTORY_MEMBERSHIP_ID,
            agencyId: TEST_AGENCY,
            type,
            status: 'ACTIVE',
            permissionVersion: 1,
          },
        ],
      };
    }

    function factoryLifecycleRow(type: 'OWNER' | 'MEMBER' = 'MEMBER') {
      return {
        identity_id: FACTORY_IDENTITY_ID,
        identity_status: 'ACTIVE',
        user_id: FACTORY_USER_ID,
        user_status: 'ACTIVE',
        membership_id: FACTORY_MEMBERSHIP_ID,
        membership_status: 'ACTIVE',
        membership_type: type,
        permission_version: 1,
        agency_id: TEST_AGENCY,
        agency_status: 'ACTIVE',
      };
    }

    function factoryGrant(permissionCode: string, scope: 'UNSCOPED' | 'ASSIGNED' | 'AGENCY') {
      return {
        id: `factory-${permissionCode}-grant`,
        membership_id: FACTORY_MEMBERSHIP_ID,
        permission_code: permissionCode,
        scope,
      };
    }

    function createFactoryDb(
      permissionRows: unknown[],
      lifecycleRow: Record<string, unknown> = factoryLifecycleRow(),
      onLifecycleQuery?: () => void,
    ): D1Database {
      return {
        prepare: (query: string) => ({
          bind: () => ({
            all: async () => {
              if (query.includes('FROM agency_memberships m')) {
                onLifecycleQuery?.();
                return { success: true, results: [lifecycleRow] };
              }
              return { success: true, results: permissionRows };
            },
          }),
        }),
      } as unknown as D1Database;
    }

    it('captures a mutable action registry once and ignores a later customer.read remap', async () => {
      const original = validateAndCreateActionDefinition({
        code: 'customer.read',
        authority: 'MEMBERSHIP_AUTHORIZED',
        requiredNormalPermissions: ['customer.read'],
      });
      const remapped = validateAndCreateActionDefinition({
        code: 'customer.read',
        authority: 'MEMBERSHIP_AUTHORIZED',
        requiredNormalPermissions: ['audit.read'],
      });
      const actions = new Map<string, ActionDefinition>([['customer.read', original]]);
      const factoryDb = createFactoryDb([factoryGrant('audit.read', 'UNSCOPED')]);
      const evaluator = createAuthorizationEvaluator({ db: factoryDb, actions });

      actions.set('customer.read', remapped);

      const result = await evaluator.authorize({
        context: factoryContext(),
        action: 'customer.read',
        agencyId: TEST_AGENCY,
      });

      expect(result.decision).toBe('DENY');
      expect(result.code).toBe('PERMISSION_NOT_GRANTED');
    });

    it.each(['delete', 'clear'] as const)(
      'keeps the captured action after the source registry is %s',
      async (mutation) => {
        const action = validateAndCreateActionDefinition({
          code: 'audit.factory_snapshot',
          authority: 'MEMBERSHIP_AUTHORIZED',
          requiredNormalPermissions: ['audit.read'],
        });
        const actions = new Map<string, ActionDefinition>([[action.code, action]]);
        const evaluator = createAuthorizationEvaluator({
          db: createFactoryDb([factoryGrant('audit.read', 'UNSCOPED')]),
          actions,
        });

        if (mutation === 'delete') actions.delete(action.code);
        else actions.clear();

        const result = await evaluator.authorize({
          context: factoryContext(),
          action: action.code,
          agencyId: TEST_AGENCY,
        });
        expect(result.decision).toBe('ALLOW');
      },
    );

    it('detaches nested action definition arrays from later source mutation', async () => {
      const normalPermissions = ['audit.read'];
      const sourceDefinition = {
        code: 'audit.factory_nested_snapshot',
        authority: 'MEMBERSHIP_AUTHORIZED' as const,
        requiredNormalPermissions: normalPermissions,
        requiredSensitivePermissions: [] as string[],
        assurance: 'NORMAL_SESSION' as const,
      };
      const actions = new Map<string, ActionDefinition>([
        [sourceDefinition.code, sourceDefinition],
      ]);
      const evaluator = createAuthorizationEvaluator({
        db: createFactoryDb([factoryGrant('audit.read', 'UNSCOPED')]),
        actions,
      });

      normalPermissions[0] = 'catalog.manage';
      sourceDefinition.requiredSensitivePermissions.push('sensitive.identity.read');

      const result = await evaluator.authorize({
        context: factoryContext(),
        action: sourceDefinition.code,
        agencyId: TEST_AGENCY,
      });
      expect(result.decision).toBe('ALLOW');
    });

    it('rejects a Map mutated by a definition getter during factory construction', () => {
      const injected = validateAndCreateActionDefinition({
        code: 'audit.factory_injected',
        authority: 'MEMBERSHIP_AUTHORIZED',
        requiredNormalPermissions: ['audit.read'],
      });
      const actions = new Map<string, ActionDefinition>();
      const sourceDefinition = {
        get code() {
          actions.set(injected.code, injected);
          return 'audit.factory_trigger';
        },
        authority: 'MEMBERSHIP_AUTHORIZED' as const,
        requiredNormalPermissions: ['audit.read'],
        requiredSensitivePermissions: [] as string[],
        assurance: 'NORMAL_SESSION' as const,
      };
      actions.set('audit.factory_trigger', sourceDefinition);

      expect(() =>
        createAuthorizationEvaluator({
          db: createFactoryDb([factoryGrant('audit.read', 'UNSCOPED')]),
          actions,
        }),
      ).toThrow();
    });

    it('captures each yielded definition before a later iterator step can mutate it', async () => {
      const normalPermissions = ['customer.read'];
      const sourceDefinition = {
        code: 'customer.read',
        authority: 'MEMBERSHIP_AUTHORIZED' as const,
        requiredNormalPermissions: normalPermissions,
        requiredSensitivePermissions: [] as string[],
        assurance: 'NORMAL_SESSION' as const,
      };
      const actions = {
        entries() {
          let completed = false;
          return {
            next() {
              if (!completed) {
                completed = true;
                return { done: false as const, value: ['customer.read', sourceDefinition] };
              }
              normalPermissions[0] = 'audit.read';
              return { done: true as const, value: undefined };
            },
          };
        },
      } as unknown as AuthorizationOptions['actions'];
      const evaluator = createAuthorizationEvaluator({
        db: createFactoryDb([factoryGrant('audit.read', 'UNSCOPED')]),
        actions,
      });

      const result = await evaluator.authorize({
        context: factoryContext(),
        action: 'customer.read',
        agencyId: TEST_AGENCY,
      });

      expect(result.decision).toBe('DENY');
      expect(result.code).toBe('PERMISSION_NOT_GRANTED');
    });

    it('rejects getter-driven action injection from a custom iterator', () => {
      const injected = validateAndCreateActionDefinition({
        code: 'audit.iterator_injected',
        authority: 'MEMBERSHIP_AUTHORIZED',
        requiredNormalPermissions: ['audit.read'],
      });
      const pending: Array<readonly [string, ActionDefinition]> = [];
      const sourceDefinition = {
        get code() {
          pending.push([injected.code, injected]);
          return 'audit.iterator_trigger';
        },
        authority: 'MEMBERSHIP_AUTHORIZED' as const,
        requiredNormalPermissions: ['audit.read'],
        requiredSensitivePermissions: [] as string[],
        assurance: 'NORMAL_SESSION' as const,
      };
      const actions = {
        entries() {
          let first = true;
          return {
            next() {
              if (first) {
                first = false;
                return {
                  done: false as const,
                  value: ['audit.iterator_trigger', sourceDefinition] as const,
                };
              }
              const next = pending.shift();
              return next
                ? { done: false as const, value: next }
                : { done: true as const, value: undefined };
            },
          };
        },
      } as unknown as AuthorizationOptions['actions'];

      expect(() =>
        createAuthorizationEvaluator({
          db: createFactoryDb([]),
          actions,
        }),
      ).toThrow();
    });

    it('rejects a same-size Map value replacement triggered by an action getter', () => {
      const strictSecond = validateAndCreateActionDefinition({
        code: 'catalog.manage',
        authority: 'MEMBERSHIP_AUTHORIZED',
        requiredNormalPermissions: ['catalog.manage'],
      });
      const weakenedSecond = validateAndCreateActionDefinition({
        code: 'catalog.manage',
        authority: 'MEMBERSHIP_AUTHORIZED',
        requiredNormalPermissions: ['audit.read'],
      });
      const actions = new Map<string, ActionDefinition>();
      const first = {
        get code() {
          actions.set('catalog.manage', weakenedSecond);
          return 'audit.map_trigger';
        },
        authority: 'MEMBERSHIP_AUTHORIZED' as const,
        requiredNormalPermissions: ['audit.read'],
        requiredSensitivePermissions: [] as string[],
        assurance: 'NORMAL_SESSION' as const,
      };
      actions.set('audit.map_trigger', first);
      actions.set('catalog.manage', strictSecond);

      expect(() =>
        createAuthorizationEvaluator({
          db: createFactoryDb([]),
          actions,
        }),
      ).toThrow();
    });

    it('rejects a same-size Map value replacement triggered by a Proxy ownKeys trap', () => {
      const strictSecond = validateAndCreateActionDefinition({
        code: 'customer.read',
        authority: 'MEMBERSHIP_AUTHORIZED',
        requiredNormalPermissions: ['customer.read'],
      });
      const weakenedSecond = validateAndCreateActionDefinition({
        code: 'customer.read',
        authority: 'MEMBERSHIP_AUTHORIZED',
        requiredNormalPermissions: ['audit.read'],
      });
      const actions = new Map<string, ActionDefinition>();
      const triggerTarget = {
        code: 'audit.proxy_map_trigger',
        authority: 'MEMBERSHIP_AUTHORIZED' as const,
        requiredNormalPermissions: ['audit.read'],
        requiredSensitivePermissions: [] as string[],
        assurance: 'NORMAL_SESSION' as const,
      };
      const trigger = new Proxy(triggerTarget, {
        ownKeys(target) {
          actions.set('customer.read', weakenedSecond);
          return Reflect.ownKeys(target);
        },
      });
      actions.set('audit.proxy_map_trigger', trigger);
      actions.set('customer.read', strictSecond);

      expect(() =>
        createAuthorizationEvaluator({
          db: createFactoryDb([]),
          actions,
        }),
      ).toThrow();
    });

    it('rejects action getters that could append authority to createActionRegistry input', () => {
      const injected = validateAndCreateActionDefinition({
        code: 'audit.builder_injected',
        authority: 'MEMBERSHIP_AUTHORIZED',
        requiredNormalPermissions: ['audit.read'],
      });
      const definitions: ActionDefinition[] = [];
      const trigger = {
        get code() {
          definitions.push(injected);
          return 'audit.builder_trigger';
        },
        authority: 'MEMBERSHIP_AUTHORIZED' as const,
        requiredNormalPermissions: ['audit.read'],
        requiredSensitivePermissions: [] as string[],
        assurance: 'NORMAL_SESSION' as const,
      };
      definitions.push(trigger);

      expect(() => createActionRegistry(definitions)).toThrow();
    });

    it('rejects a custom registry list with an index getter', () => {
      const trigger = validateAndCreateActionDefinition({
        code: 'audit.factory_list_trigger',
        authority: 'MEMBERSHIP_AUTHORIZED',
        requiredNormalPermissions: ['audit.read'],
      });
      const injected = validateAndCreateActionDefinition({
        code: 'audit.factory_list_injected',
        authority: 'MEMBERSHIP_AUTHORIZED',
        requiredNormalPermissions: ['audit.read'],
      });
      const definitions: ActionDefinition[] = [];
      Object.defineProperty(definitions, 0, {
        configurable: true,
        enumerable: true,
        get: () => {
          definitions.push(injected);
          return trigger;
        },
      });
      definitions.length = 1;
      const actions = {
        list: () => definitions,
      } as unknown as AuthorizationOptions['actions'];
      expect(() =>
        createAuthorizationEvaluator({
          db: createFactoryDb([factoryGrant('audit.read', 'UNSCOPED')]),
          actions,
        }),
      ).toThrow();
    });

    it('rejects duplicate action codes through the public registry builder', () => {
      const strict = validateAndCreateActionDefinition({
        code: 'customer.read',
        authority: 'MEMBERSHIP_AUTHORIZED',
        requiredNormalPermissions: ['customer.read'],
      });
      const weakened = validateAndCreateActionDefinition({
        code: 'customer.read',
        authority: 'MEMBERSHIP_AUTHORIZED',
        requiredNormalPermissions: ['audit.read'],
      });

      expect(() => createActionRegistry([strict, weakened])).toThrow();
    });

    it('rejects malformed and oversized public registry iterables', () => {
      const valid = validateAndCreateActionDefinition({
        code: 'audit.builder_valid',
        authority: 'MEMBERSHIP_AUTHORIZED',
        requiredNormalPermissions: ['audit.read'],
      });
      expect(() => createActionRegistry([valid, null as unknown as ActionDefinition])).toThrow();

      const oversized = {
        *[Symbol.iterator]() {
          for (let index = 0; index <= 1000; index++) {
            yield {
              code: `audit.builder_bound_${index}`,
              authority: 'MEMBERSHIP_AUTHORIZED' as const,
              requiredNormalPermissions: ['audit.read'],
              requiredSensitivePermissions: [] as string[],
              assurance: 'NORMAL_SESSION' as const,
            };
          }
        },
      };
      expect(() => createActionRegistry(oversized)).toThrow();
    });

    it('rejects non-enumerable, duplicate, mismatched, malformed, and throwing action registries', () => {
      const db = createFactoryDb([]);
      const action = validateAndCreateActionDefinition({
        code: 'audit.factory_validation',
        authority: 'MEMBERSHIP_AUTHORIZED',
        requiredNormalPermissions: ['audit.read'],
      });
      const invalidRegistries: unknown[] = [
        { get: () => action },
        {
          *entries() {
            yield [action.code, action];
            yield [action.code, action];
          },
        },
        new Map([['audit.wrong_key', action]]),
        new Map([
          [
            'audit.malformed_factory',
            {
              code: 'audit.malformed_factory',
              authority: 'MEMBERSHIP_AUTHORIZED',
              requiredNormalPermissions: [],
              requiredSensitivePermissions: [],
              assurance: 'NORMAL_SESSION',
            },
          ],
        ]),
        {
          entries() {
            throw new Error('hostile registry iterator');
          },
        },
      ];

      for (const actions of invalidRegistries) {
        expect(() =>
          createAuthorizationEvaluator({
            db,
            actions: actions as AuthorizationOptions['actions'],
          }),
        ).toThrow();
      }
    });

    it('captures resolver identities once across awaited and later authorizations', async () => {
      const resolvers: {
        customer_record_resolver: ScopeResolverRegistry['customer_record_resolver'];
      } = {
        customer_record_resolver: () => false,
      };
      const db = createFactoryDb(
        [factoryGrant('customer.read', 'ASSIGNED')],
        factoryLifecycleRow(),
        () => {
          resolvers.customer_record_resolver = () => true;
        },
      );
      const evaluator = createAuthorizationEvaluator({ db, resolvers });
      const request: AuthorizationRequest = {
        context: factoryContext(),
        action: 'customer.read',
        agencyId: TEST_AGENCY,
        resource: { agencyId: TEST_AGENCY, assigned: false },
      };

      const duringAwait = await evaluator.authorize(request);
      const laterCall = await evaluator.authorize(request);
      const newEvaluator = createAuthorizationEvaluator({
        db: createFactoryDb([factoryGrant('customer.read', 'ASSIGNED')]),
        resolvers,
      });
      const explicitlyReconfigured = await newEvaluator.authorize(request);

      expect(duringAwait.decision).toBe('DENY');
      expect(duringAwait.code).toBe('SCOPE_RESOLVER_DENIED');
      expect(laterCall.decision).toBe('DENY');
      expect(laterCall.code).toBe('SCOPE_RESOLVER_DENIED');
      expect(explicitlyReconfigured.decision).toBe('ALLOW');
    });

    it('captures the D1 prepare function once for the evaluator lifetime', async () => {
      const forgedPrepare = (query: string) => ({
        bind: () => ({
          all: async () =>
            query.includes('FROM agency_memberships m')
              ? { success: true, results: [factoryLifecycleRow()] }
              : { success: true, results: [factoryGrant('audit.read', 'UNSCOPED')] },
        }),
      });
      const mutableDb = {} as { prepare: (query: string) => unknown };
      mutableDb.prepare = (query: string) => ({
        bind: () => ({
          all: async () => {
            if (query.includes('FROM agency_memberships m')) {
              mutableDb.prepare = forgedPrepare;
              return { success: true, results: [factoryLifecycleRow()] };
            }
            return { success: true, results: [] };
          },
        }),
      });
      const evaluator = createAuthorizationEvaluator({
        db: mutableDb as unknown as D1Database,
      });

      const result = await evaluator.authorize({
        context: factoryContext(),
        action: 'audit.read',
        agencyId: TEST_AGENCY,
      });

      expect(result.decision).toBe('DENY');
      expect(result.code).toBe('PERMISSION_NOT_GRANTED');
    });

    it('reads a getter-backed resolver once and rejects a throwing resolver getter', async () => {
      let resolverReads = 0;
      const resolvers = {} as Record<string, unknown>;
      Object.defineProperty(resolvers, 'customer_record_resolver', {
        enumerable: true,
        get: () => {
          resolverReads += 1;
          return resolverReads === 1 ? () => false : () => true;
        },
      });
      const evaluator = createAuthorizationEvaluator({
        db: createFactoryDb([factoryGrant('customer.read', 'ASSIGNED')]),
        resolvers: resolvers as Partial<ScopeResolverRegistry>,
      });
      const result = await evaluator.authorize({
        context: factoryContext(),
        action: 'customer.read',
        agencyId: TEST_AGENCY,
        resource: { agencyId: TEST_AGENCY, assigned: false },
      });

      expect(result.decision).toBe('DENY');
      expect(result.code).toBe('SCOPE_RESOLVER_DENIED');
      expect(resolverReads).toBe(1);

      const throwingResolvers = {} as Record<string, unknown>;
      Object.defineProperty(throwingResolvers, 'customer_record_resolver', {
        enumerable: true,
        get: () => {
          throw new Error('hostile resolver getter');
        },
      });
      expect(() =>
        createAuthorizationEvaluator({
          db: createFactoryDb([]),
          resolvers: throwingResolvers as Partial<ScopeResolverRegistry>,
        }),
      ).toThrow();
    });

    it('reads D1 envelope success and results exactly once', async () => {
      let lifecycleSuccessReads = 0;
      let lifecycleResultsReads = 0;
      let permissionSuccessReads = 0;
      let permissionResultsReads = 0;
      const envelopeDb = {
        prepare: (query: string) => ({
          bind: () => ({
            all: async () => {
              const isLifecycle = query.includes('FROM agency_memberships m');
              const envelope = {} as Record<string, unknown>;
              Object.defineProperty(envelope, 'success', {
                enumerable: true,
                get: () => {
                  if (isLifecycle) {
                    lifecycleSuccessReads += 1;
                    return lifecycleSuccessReads === 1;
                  }
                  permissionSuccessReads += 1;
                  return permissionSuccessReads === 1;
                },
              });
              Object.defineProperty(envelope, 'results', {
                enumerable: true,
                get: () => {
                  if (isLifecycle) {
                    lifecycleResultsReads += 1;
                    return lifecycleResultsReads === 1 ? [factoryLifecycleRow()] : [];
                  }
                  permissionResultsReads += 1;
                  return permissionResultsReads === 1
                    ? [factoryGrant('audit.read', 'UNSCOPED')]
                    : [];
                },
              });
              return envelope;
            },
          }),
        }),
      } as unknown as D1Database;
      const evaluator = createAuthorizationEvaluator({ db: envelopeDb });

      const result = await evaluator.authorize({
        context: factoryContext(),
        action: 'audit.read',
        agencyId: TEST_AGENCY,
      });

      expect(result.decision).toBe('ALLOW');
      expect(lifecycleSuccessReads).toBe(1);
      expect(lifecycleResultsReads).toBe(1);
      expect(permissionSuccessReads).toBe(1);
      expect(permissionResultsReads).toBe(1);
    });

    it('fails closed when a D1 envelope getter throws', async () => {
      const envelopeDb = {
        prepare: () => ({
          bind: () => ({
            all: async () => {
              const envelope = { success: true } as Record<string, unknown>;
              Object.defineProperty(envelope, 'results', {
                enumerable: true,
                get: () => {
                  throw new Error('hostile D1 results getter');
                },
              });
              return envelope;
            },
          }),
        }),
      } as unknown as D1Database;
      const evaluator = createAuthorizationEvaluator({ db: envelopeDb });

      const result = await evaluator.authorize({
        context: factoryContext(),
        action: 'audit.read',
        agencyId: TEST_AGENCY,
      });

      expect(result.decision).toBe('DENY');
      expect(result.code).toBe('DATABASE_ERROR');
    });

    it('reads D1 result-array length and row indices once and rejects revoked arrays', async () => {
      const reads = {
        lifecycleLength: 0,
        lifecycleIndex: 0,
        permissionLength: 0,
        permissionIndex: 0,
      };
      const resultsProxy = (isLifecycle: boolean): unknown[] =>
        new Proxy(
          isLifecycle ? [factoryLifecycleRow()] : [factoryGrant('audit.read', 'UNSCOPED')],
          {
            get(target, property, receiver) {
              if (property === 'length') {
                if (isLifecycle) reads.lifecycleLength += 1;
                else reads.permissionLength += 1;
              }
              if (property === '0') {
                if (isLifecycle) reads.lifecycleIndex += 1;
                else reads.permissionIndex += 1;
              }
              return Reflect.get(target, property, receiver);
            },
          },
        );
      const proxyDb = {
        prepare: (query: string) => ({
          bind: () => ({
            all: async () => ({
              success: true,
              results: resultsProxy(query.includes('FROM agency_memberships m')),
            }),
          }),
        }),
      } as unknown as D1Database;

      const result = await createAuthorizationEvaluator({ db: proxyDb }).authorize({
        context: factoryContext(),
        action: 'audit.read',
        agencyId: TEST_AGENCY,
      });
      expect(result.decision).toBe('ALLOW');
      expect(reads).toEqual({
        lifecycleLength: 1,
        lifecycleIndex: 1,
        permissionLength: 1,
        permissionIndex: 1,
      });

      const revokedResults = Proxy.revocable([factoryLifecycleRow()], {});
      revokedResults.revoke();
      const revokedResultsDb = {
        prepare: () => ({
          bind: () => ({
            all: async () => ({ success: true, results: revokedResults.proxy }),
          }),
        }),
      } as unknown as D1Database;
      const revokedResult = await createAuthorizationEvaluator({ db: revokedResultsDb }).authorize({
        context: factoryContext('OWNER'),
        action: 'audit.read',
        agencyId: TEST_AGENCY,
      });
      expect(revokedResult).toMatchObject({ decision: 'DENY', code: 'DATABASE_ERROR' });
    });

    it('reads every remaining lifecycle authority field once and fails closed on access errors', async () => {
      const cases: Array<readonly [string, unknown, unknown]> = [
        ['identity_id', FACTORY_IDENTITY_ID, 'other-identity'],
        ['user_id', FACTORY_USER_ID, 'other-user'],
        ['membership_id', FACTORY_MEMBERSHIP_ID, 'other-membership'],
        ['permission_version', 1, 2],
        ['agency_id', TEST_AGENCY, OTHER_AGENCY],
        ['agency_status', 'ACTIVE', 'SUSPENDED'],
      ];

      for (const [field, firstValue, laterValue] of cases) {
        const row = factoryLifecycleRow('OWNER');
        let reads = 0;
        Object.defineProperty(row, field, {
          enumerable: true,
          get: () => (++reads === 1 ? firstValue : laterValue),
        });
        const result = await createAuthorizationEvaluator({
          db: createFactoryDb([], row),
        }).authorize({
          context: factoryContext('OWNER'),
          action: 'audit.read',
          agencyId: TEST_AGENCY,
        });
        expect(result.decision, field).toBe('ALLOW');
        expect(reads, field).toBe(1);
      }

      const throwingRow = factoryLifecycleRow('OWNER');
      Object.defineProperty(throwingRow, 'agency_id', {
        enumerable: true,
        get: () => {
          throw new Error('hostile lifecycle agency getter');
        },
      });
      const throwingResult = await createAuthorizationEvaluator({
        db: createFactoryDb([], throwingRow),
      }).authorize({
        context: factoryContext('OWNER'),
        action: 'audit.read',
        agencyId: TEST_AGENCY,
      });
      expect(throwingResult).toMatchObject({ decision: 'DENY', code: 'DATABASE_ERROR' });
    });

    it('reads permission row id and membership_id once and fails closed on access errors', async () => {
      const cases: Array<readonly [string, unknown, unknown]> = [
        ['id', 'stable-grant-id', ''],
        ['membership_id', FACTORY_MEMBERSHIP_ID, 'other-membership'],
      ];

      for (const [field, firstValue, laterValue] of cases) {
        const row = factoryGrant('audit.read', 'UNSCOPED');
        let reads = 0;
        Object.defineProperty(row, field, {
          enumerable: true,
          get: () => (++reads === 1 ? firstValue : laterValue),
        });
        const result = await createAuthorizationEvaluator({
          db: createFactoryDb([row]),
        }).authorize({
          context: factoryContext(),
          action: 'audit.read',
          agencyId: TEST_AGENCY,
        });
        expect(result.decision, field).toBe('ALLOW');
        expect(reads, field).toBe(1);
      }

      const throwingRow = factoryGrant('audit.read', 'UNSCOPED');
      Object.defineProperty(throwingRow, 'id', {
        enumerable: true,
        get: () => {
          throw new Error('hostile permission id getter');
        },
      });
      const throwingResult = await createAuthorizationEvaluator({
        db: createFactoryDb([throwingRow]),
      }).authorize({
        context: factoryContext(),
        action: 'audit.read',
        agencyId: TEST_AGENCY,
      });
      expect(throwingResult).toMatchObject({ decision: 'DENY', code: 'DATABASE_ERROR' });
    });

    it('uses the first canonical user_status value from a lifecycle row', async () => {
      const lifecycleRow = factoryLifecycleRow('OWNER');
      let userStatusReads = 0;
      Object.defineProperty(lifecycleRow, 'user_status', {
        enumerable: true,
        get: () => {
          userStatusReads += 1;
          return userStatusReads === 1 ? 'INACTIVE' : 'ACTIVE';
        },
      });
      const evaluator = createAuthorizationEvaluator({
        db: createFactoryDb([], lifecycleRow),
      });

      const result = await evaluator.authorize({
        context: factoryContext('OWNER'),
        action: 'audit.read',
        agencyId: TEST_AGENCY,
      });

      expect(result.decision).toBe('DENY');
      expect(result.code).toBe('USER_INACTIVE');
      expect(userStatusReads).toBe(1);
    });

    it('uses the first canonical membership_status value from a lifecycle row', async () => {
      const lifecycleRow = factoryLifecycleRow('OWNER');
      let membershipStatusReads = 0;
      Object.defineProperty(lifecycleRow, 'membership_status', {
        enumerable: true,
        get: () => {
          membershipStatusReads += 1;
          return membershipStatusReads === 1 ? 'SUSPENDED' : 'ACTIVE';
        },
      });
      const evaluator = createAuthorizationEvaluator({
        db: createFactoryDb([], lifecycleRow),
      });

      const result = await evaluator.authorize({
        context: factoryContext('OWNER'),
        action: 'audit.read',
        agencyId: TEST_AGENCY,
      });

      expect(result.decision).toBe('DENY');
      expect(result.code).toBe('MEMBERSHIP_INACTIVE');
      expect(membershipStatusReads).toBe(1);
    });

    it('does not reread a persisted MEMBER type as OWNER', async () => {
      const lifecycleRow = factoryLifecycleRow();
      let membershipTypeReads = 0;
      Object.defineProperty(lifecycleRow, 'membership_type', {
        enumerable: true,
        get: () => {
          membershipTypeReads += 1;
          return membershipTypeReads === 1 ? 'MEMBER' : 'OWNER';
        },
      });
      const evaluator = createAuthorizationEvaluator({
        db: createFactoryDb([], lifecycleRow),
      });

      const result = await evaluator.authorize({
        context: factoryContext(),
        action: 'audit.read',
        agencyId: TEST_AGENCY,
      });

      expect(result.decision).toBe('DENY');
      expect(result.code).toBe('PERMISSION_NOT_GRANTED');
      expect(membershipTypeReads).toBe(1);
    });

    it('does not turn an audit.read row into catalog.manage authority', async () => {
      const permissionRow = factoryGrant('audit.read', 'UNSCOPED');
      let permissionCodeReads = 0;
      Object.defineProperty(permissionRow, 'permission_code', {
        enumerable: true,
        get: () => {
          permissionCodeReads += 1;
          return permissionCodeReads === 1 ? 'audit.read' : 'catalog.manage';
        },
      });
      const evaluator = createAuthorizationEvaluator({
        db: createFactoryDb([permissionRow]),
      });

      const result = await evaluator.authorize({
        context: factoryContext(),
        action: 'catalog.manage',
        agencyId: TEST_AGENCY,
      });

      expect(result.decision).toBe('DENY');
      expect(result.code).toBe('PERMISSION_NOT_GRANTED');
      expect(permissionCodeReads).toBe(1);
    });

    it('does not expand an ASSIGNED grant when its persisted scope later reads as AGENCY', async () => {
      const permissionRow = factoryGrant('customer.read', 'ASSIGNED');
      let scopeReads = 0;
      Object.defineProperty(permissionRow, 'scope', {
        enumerable: true,
        get: () => {
          scopeReads += 1;
          return scopeReads === 1 ? 'ASSIGNED' : 'AGENCY';
        },
      });
      const evaluator = createAuthorizationEvaluator({
        db: createFactoryDb([permissionRow]),
      });

      const result = await evaluator.authorize({
        context: factoryContext(),
        action: 'customer.read',
        agencyId: TEST_AGENCY,
        resource: { agencyId: TEST_AGENCY, assigned: false },
      });

      expect(result.decision).toBe('DENY');
      expect(result.code).toBe('SCOPE_RESOLVER_DENIED');
      expect(scopeReads).toBe(1);
    });

    it('does not manufacture a required dependency from a changing permission row', async () => {
      const dependencyRow = factoryGrant('policy.read', 'ASSIGNED');
      let dependencyCodeReads = 0;
      Object.defineProperty(dependencyRow, 'permission_code', {
        enumerable: true,
        get: () => {
          dependencyCodeReads += 1;
          return dependencyCodeReads === 1 ? 'policy.read' : 'customer.read';
        },
      });
      const evaluator = createAuthorizationEvaluator({
        db: createFactoryDb([factoryGrant('customer.update', 'ASSIGNED'), dependencyRow]),
      });

      const result = await evaluator.authorize({
        context: factoryContext(),
        action: 'customer.update',
        agencyId: TEST_AGENCY,
        resource: { agencyId: TEST_AGENCY, assigned: true },
      });

      expect(result.decision).toBe('DENY');
      expect(result.code).toBe('DEPENDENCY_MISSING');
      expect(dependencyCodeReads).toBe(1);
    });

    it('fails closed when a persisted permission row getter throws', async () => {
      const permissionRow = factoryGrant('audit.read', 'UNSCOPED');
      Object.defineProperty(permissionRow, 'scope', {
        enumerable: true,
        get: () => {
          throw new Error('hostile persisted scope getter');
        },
      });
      const evaluator = createAuthorizationEvaluator({
        db: createFactoryDb([permissionRow]),
      });

      const result = await evaluator.authorize({
        context: factoryContext(),
        action: 'audit.read',
        agencyId: TEST_AGENCY,
      });

      expect(result.decision).toBe('DENY');
      expect(result.code).toBe('DATABASE_ERROR');
    });

    it('fails closed on an alternating Proxy lifecycle status', async () => {
      let identityStatusReads = 0;
      const lifecycleRow = new Proxy(factoryLifecycleRow('OWNER'), {
        get(target, property, receiver) {
          if (property === 'identity_status') {
            identityStatusReads += 1;
            return identityStatusReads === 1 ? 'REVOKED' : 'ACTIVE';
          }
          return Reflect.get(target, property, receiver);
        },
      });
      const evaluator = createAuthorizationEvaluator({
        db: createFactoryDb([], lifecycleRow),
      });

      const result = await evaluator.authorize({
        context: factoryContext('OWNER'),
        action: 'audit.read',
        agencyId: TEST_AGENCY,
      });

      expect(result.decision).toBe('DENY');
      expect(result.code).toBe('INVALID_CONTEXT');
      expect(identityStatusReads).toBe(1);
    });

    it('returns DENY for a revoked Proxy persistence row', async () => {
      const revocable = Proxy.revocable(factoryGrant('audit.read', 'UNSCOPED'), {});
      revocable.revoke();
      const evaluator = createAuthorizationEvaluator({
        db: createFactoryDb([revocable.proxy]),
      });

      const result = await evaluator.authorize({
        context: factoryContext(),
        action: 'audit.read',
        agencyId: TEST_AGENCY,
      });

      expect(result.decision).toBe('DENY');
      expect(result.code).toBe('DATABASE_ERROR');
    });

    it('returns defined DENY results for revoked request, context, resource, and D1 adapters', async () => {
      const revokedRequest = Proxy.revocable(
        {
          context: factoryContext(),
          action: 'audit.read',
          agencyId: TEST_AGENCY,
        },
        {},
      );
      revokedRequest.revoke();
      const requestResult = await evaluateAuthorization(
        createFactoryDb([]),
        revokedRequest.proxy as AuthorizationRequest,
      );
      expect(requestResult).toMatchObject({ decision: 'DENY', code: 'MALFORMED_INPUT' });

      const revokedContext = Proxy.revocable(factoryContext(), {});
      revokedContext.revoke();
      const contextResult = await evaluateAuthorization(createFactoryDb([]), {
        context: revokedContext.proxy,
        action: 'audit.read',
        agencyId: TEST_AGENCY,
      } as unknown as AuthorizationRequest);
      expect(contextResult).toMatchObject({ decision: 'DENY', code: 'INVALID_CONTEXT' });

      const revokedResource = Proxy.revocable({ agencyId: TEST_AGENCY, assigned: true }, {});
      revokedResource.revoke();
      const resourceResult = await evaluateAuthorization(
        createFactoryDb([factoryGrant('customer.read', 'ASSIGNED')]),
        {
          context: factoryContext(),
          action: 'customer.read',
          agencyId: TEST_AGENCY,
          resource: revokedResource.proxy,
        },
      );
      expect(resourceResult).toMatchObject({ decision: 'DENY', code: 'MALFORMED_INPUT' });

      const revokedDb = Proxy.revocable(createFactoryDb([]), {});
      revokedDb.revoke();
      const dbResult = await evaluateAuthorization(revokedDb.proxy, {
        context: factoryContext('OWNER'),
        action: 'audit.read',
        agencyId: TEST_AGENCY,
      });
      expect(dbResult).toMatchObject({ decision: 'DENY', code: 'DATABASE_ERROR' });
    });
  });
});
