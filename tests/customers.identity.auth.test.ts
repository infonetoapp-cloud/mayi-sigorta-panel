// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import miniflare from 'miniflare';
import { DEFAULT_ACTION_REGISTRY, evaluateAuthorization } from '../src/server/auth/authorization';
import type { AuthenticatedUserContext } from '../src/server/auth/identity';

const { Miniflare, convertV4MiniflareOptions } = miniflare;
const rootDir = resolve(__dirname, '..');

describe('M2-T02 Canonical Compound Actions & Authorization Evaluator', () => {
  let mf: miniflare.Miniflare;
  let db: D1Database;

  beforeAll(async () => {
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: 'export default { fetch() { return new Response(null); } }',
        d1Databases: {
          DB: '00000000-0000-0000-0000-000000000006',
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
  });

  afterAll(async () => {
    if (mf) await mf.dispose();
  });

  describe('Central Action Registry Definitions', () => {
    it('registers customer.identity.read requiring customer.read + sensitive.identity.read', () => {
      const action = DEFAULT_ACTION_REGISTRY.get('customer.identity.read');
      expect(action).toBeDefined();
      expect(action?.authority).toBe('MEMBERSHIP_AUTHORIZED');
      expect(action?.requiredNormalPermissions).toEqual(['customer.read']);
      expect(action?.requiredSensitivePermissions).toEqual(['sensitive.identity.read']);
      expect(action?.assurance).toBe('NORMAL_SESSION');
    });

    it('registers customer.identity.update requiring customer.update + sensitive.identity.read + sensitive.identity.write', () => {
      const action = DEFAULT_ACTION_REGISTRY.get('customer.identity.update');
      expect(action).toBeDefined();
      expect(action?.authority).toBe('MEMBERSHIP_AUTHORIZED');
      expect(action?.requiredNormalPermissions).toEqual(['customer.update']);
      expect(action?.requiredSensitivePermissions).toEqual([
        'sensitive.identity.read',
        'sensitive.identity.write',
      ]);
      expect(action?.assurance).toBe('NORMAL_SESSION');
    });

    it('registers customer.identity.search requiring customer.read + sensitive.identity.read', () => {
      const action = DEFAULT_ACTION_REGISTRY.get('customer.identity.search');
      expect(action).toBeDefined();
      expect(action?.authority).toBe('MEMBERSHIP_AUTHORIZED');
      expect(action?.requiredNormalPermissions).toEqual(['customer.read']);
      expect(action?.requiredSensitivePermissions).toEqual(['sensitive.identity.read']);
      expect(action?.assurance).toBe('NORMAL_SESSION');
    });

    it('registers customer.external_reference.create requiring customer.update', () => {
      const action = DEFAULT_ACTION_REGISTRY.get('customer.external_reference.create');
      expect(action).toBeDefined();
      expect(action?.authority).toBe('MEMBERSHIP_AUTHORIZED');
      expect(action?.requiredNormalPermissions).toEqual(['customer.update']);
      expect(action?.requiredSensitivePermissions).toEqual([]);
      expect(action?.assurance).toBe('NORMAL_SESSION');
    });

    it('confirms customer.assign uses existing normal customer.assign action', () => {
      const action = DEFAULT_ACTION_REGISTRY.get('customer.assign');
      expect(action).toBeDefined();
      expect(action?.authority).toBe('MEMBERSHIP_AUTHORIZED');
      expect(action?.requiredNormalPermissions).toEqual(['customer.assign']);
      expect(action?.requiredSensitivePermissions).toEqual([]);
      expect(action?.assurance).toBe('NORMAL_SESSION');
    });
  });

  describe('Runtime Evaluator Enforcement', () => {
    const agencyId = 'ag-auth-t02';
    const ownerUserId = 'usr-owner-t02';
    const ownerMembershipId = 'mem-owner-t02';
    const memberUserId = 'usr-member-t02';
    const memberMembershipId = 'mem-member-t02';
    const customerId = 'cust-auth-t02';

    beforeAll(async () => {
      // Seed agency
      await db
        .prepare("INSERT INTO agencies (id, status, version) VALUES (?, 'PROVISIONING', 1)")
        .bind(agencyId)
        .run();

      // Seed owner user & membership
      await db
        .prepare("INSERT INTO users (id, status, version) VALUES (?, 'INACTIVE', 1)")
        .bind(ownerUserId)
        .run();
      await db
        .prepare(
          `INSERT INTO agency_memberships (
             id, agency_id, user_id, type, status, invitation_email, invitation_expires_at, version, permission_version
           ) VALUES (?, ?, ?, 'OWNER', 'INVITED', 'owner@test.com', '2099-01-01T00:00:00.000Z', 1, 1)`,
        )
        .bind(ownerMembershipId, agencyId, ownerUserId)
        .run();
      await db
        .prepare(
          `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
           VALUES ('ident-owner-t02', ?, 'https://test', 'sub-owner-t02', 'owner@test.com', 'ACTIVE')`,
        )
        .bind(ownerUserId)
        .run();
      await db
        .prepare("UPDATE users SET status = 'ACTIVE', version = 2 WHERE id = ?")
        .bind(ownerUserId)
        .run();
      await db
        .prepare(
          "UPDATE agency_memberships SET status = 'ACTIVE', activated_at = '2026-09-17T00:00:00.000Z', version = 2, permission_version = 2 WHERE id = ?",
        )
        .bind(ownerMembershipId)
        .run();
      await db
        .prepare(
          "UPDATE agencies SET status = 'ACTIVE', bootstrap_completed_at = '2026-09-17T00:00:00.000Z', activated_at = '2026-09-17T00:00:00.000Z', version = 2 WHERE id = ?",
        )
        .bind(agencyId)
        .run();

      // Seed normal member
      await db
        .prepare("INSERT INTO users (id, status, version) VALUES (?, 'ACTIVE', 1)")
        .bind(memberUserId)
        .run();
      await db
        .prepare(
          `INSERT INTO agency_memberships (
             id, agency_id, user_id, type, status, invitation_email, invitation_expires_at, version, permission_version, activated_at
           ) VALUES (?, ?, ?, 'MEMBER', 'ACTIVE', 'member@test.com', '2099-01-01T00:00:00.000Z', 1, 1, '2026-09-17T00:00:00.000Z')`,
        )
        .bind(memberMembershipId, agencyId, memberUserId)
        .run();
      await db
        .prepare(
          `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
           VALUES ('ident-member-t02', ?, 'https://test', 'sub-member-t02', 'member@test.com', 'ACTIVE')`,
        )
        .bind(memberUserId)
        .run();

      // Seed customer assigned to member
      await db
        .prepare(
          `INSERT INTO customers (
             id, agency_id, type, display_name, assignee_membership_id, version
           ) VALUES (?, ?, 'INDIVIDUAL', 'Test Customer', ?, 1)`,
        )
        .bind(customerId, agencyId, memberMembershipId)
        .run();
    });

    it('denies OWNER customer.identity.read when OWNER lacks explicit sensitive.identity.read grant', async () => {
      const ownerContext: AuthenticatedUserContext = {
        userId: ownerUserId,
        identityId: 'ident-owner-t02',
        assurance: 'NORMAL',
        memberships: [
          {
            id: ownerMembershipId,
            agencyId,
            type: 'OWNER',
            status: 'ACTIVE',
            permissionVersion: 2,
          },
        ],
      };

      const result = await evaluateAuthorization(db, {
        context: ownerContext,
        action: 'customer.identity.read',
        agencyId,
        resource: { agencyId, id: customerId, assigneeMembershipId: memberMembershipId },
      });

      expect(result.decision).toBe('DENY');
      expect(result.code).toBe('OWNER_SENSITIVE_GRANT_REQUIRED');
    });

    it('allows OWNER customer.identity.read when OWNER has explicit sensitive.identity.read grant', async () => {
      // Grant sensitive.identity.read to owner
      await db
        .prepare(
          `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
           VALUES ('perm-owner-sens-1', ?, 'sensitive.identity.read', 'UNSCOPED')`,
        )
        .bind(ownerMembershipId)
        .run();

      const ownerContext: AuthenticatedUserContext = {
        userId: ownerUserId,
        identityId: 'ident-owner-t02',
        assurance: 'NORMAL',
        memberships: [
          {
            id: ownerMembershipId,
            agencyId,
            type: 'OWNER',
            status: 'ACTIVE',
            permissionVersion: 2,
          },
        ],
      };

      const result = await evaluateAuthorization(db, {
        context: ownerContext,
        action: 'customer.identity.read',
        agencyId,
        resource: { agencyId, id: customerId, assigneeMembershipId: memberMembershipId },
      });

      expect(result.decision).toBe('ALLOW');
    });

    it('does not let sensitive.identity.read create Customer record scope by itself', async () => {
      const sensitiveOnlyUserId = 'usr-sensitive-only-t02';
      const sensitiveOnlyMembershipId = 'mem-sensitive-only-t02';
      await db
        .prepare("INSERT INTO users (id, status, version) VALUES (?, 'ACTIVE', 1)")
        .bind(sensitiveOnlyUserId)
        .run();
      await db
        .prepare(
          `INSERT INTO agency_memberships (
             id, agency_id, user_id, type, status, invitation_email,
             invitation_expires_at, version, permission_version, activated_at
           ) VALUES (?, ?, ?, 'MEMBER', 'ACTIVE', 'sensitive-only@test.com',
             '2099-01-01T00:00:00.000Z', 1, 1, '2026-09-17T00:00:00.000Z')`,
        )
        .bind(sensitiveOnlyMembershipId, agencyId, sensitiveOnlyUserId)
        .run();
      await db
        .prepare(
          `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
           VALUES ('identity-sensitive-only-t02', ?, 'https://test', 'sub-sensitive-only-t02',
             'sensitive-only@test.com', 'ACTIVE')`,
        )
        .bind(sensitiveOnlyUserId)
        .run();
      await db
        .prepare(
          `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
           VALUES ('perm-sensitive-only-t02', ?, 'sensitive.identity.read', 'UNSCOPED')`,
        )
        .bind(sensitiveOnlyMembershipId)
        .run();

      const result = await evaluateAuthorization(db, {
        context: {
          userId: sensitiveOnlyUserId,
          identityId: 'identity-sensitive-only-t02',
          assurance: 'NORMAL',
          memberships: [
            {
              id: sensitiveOnlyMembershipId,
              agencyId,
              type: 'MEMBER',
              status: 'ACTIVE',
              permissionVersion: 1,
            },
          ],
        },
        action: 'customer.identity.read',
        agencyId,
        resource: { agencyId, id: customerId, assigneeMembershipId: sensitiveOnlyMembershipId },
      });

      expect(result.decision).toBe('DENY');
      expect(result.code).toBe('PERMISSION_NOT_GRANTED');
    });

    it('denies MEMBER customer.identity.read when member has customer.read but no sensitive.identity.read', async () => {
      // Grant customer.read with ASSIGNED scope to member
      await db
        .prepare(
          `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
           VALUES ('perm-mem-1', ?, 'customer.read', 'ASSIGNED')`,
        )
        .bind(memberMembershipId)
        .run();

      const memberContext: AuthenticatedUserContext = {
        userId: memberUserId,
        identityId: 'ident-member-t02',
        assurance: 'NORMAL',
        memberships: [
          {
            id: memberMembershipId,
            agencyId,
            type: 'MEMBER',
            status: 'ACTIVE',
            permissionVersion: 1,
          },
        ],
      };

      const result = await evaluateAuthorization(db, {
        context: memberContext,
        action: 'customer.identity.read',
        agencyId,
        resource: { agencyId, id: customerId, assigneeMembershipId: memberMembershipId },
      });

      expect(result.decision).toBe('DENY');
      expect(result.code).toBe('PERMISSION_NOT_GRANTED');
    });

    it('allows MEMBER customer.identity.read when member has customer.read + sensitive.identity.read', async () => {
      // Grant sensitive.identity.read to member
      await db
        .prepare(
          `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
           VALUES ('perm-mem-2', ?, 'sensitive.identity.read', 'UNSCOPED')`,
        )
        .bind(memberMembershipId)
        .run();

      const memberContext: AuthenticatedUserContext = {
        userId: memberUserId,
        identityId: 'ident-member-t02',
        assurance: 'NORMAL',
        memberships: [
          {
            id: memberMembershipId,
            agencyId,
            type: 'MEMBER',
            status: 'ACTIVE',
            permissionVersion: 1,
          },
        ],
      };

      const result = await evaluateAuthorization(db, {
        context: memberContext,
        action: 'customer.identity.read',
        agencyId,
        resource: { agencyId, id: customerId, assigneeMembershipId: memberMembershipId },
      });

      expect(result.decision).toBe('ALLOW');
    });

    it('denies MEMBER customer.identity.update when missing sensitive.identity.write', async () => {
      // Member currently has customer.read, sensitive.identity.read.
      // Grant customer.update
      await db
        .prepare(
          `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
           VALUES ('perm-mem-3', ?, 'customer.update', 'ASSIGNED')`,
        )
        .bind(memberMembershipId)
        .run();

      const memberContext: AuthenticatedUserContext = {
        userId: memberUserId,
        identityId: 'ident-member-t02',
        assurance: 'NORMAL',
        memberships: [
          {
            id: memberMembershipId,
            agencyId,
            type: 'MEMBER',
            status: 'ACTIVE',
            permissionVersion: 1,
          },
        ],
      };

      // Missing sensitive.identity.write
      const result = await evaluateAuthorization(db, {
        context: memberContext,
        action: 'customer.identity.update',
        agencyId,
        resource: { agencyId, id: customerId, assigneeMembershipId: memberMembershipId },
      });

      expect(result.decision).toBe('DENY');
      expect(result.code).toBe('PERMISSION_NOT_GRANTED');

      // Now grant sensitive.identity.write
      await db
        .prepare(
          `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
           VALUES ('perm-mem-4', ?, 'sensitive.identity.write', 'UNSCOPED')`,
        )
        .bind(memberMembershipId)
        .run();

      const successResult = await evaluateAuthorization(db, {
        context: memberContext,
        action: 'customer.identity.update',
        agencyId,
        resource: { agencyId, id: customerId, assigneeMembershipId: memberMembershipId },
      });

      expect(successResult.decision).toBe('ALLOW');
    });
  });
});
