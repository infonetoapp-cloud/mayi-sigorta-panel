// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import miniflare from 'miniflare';
import {
  resolveAuthenticatedUserContext,
  createApplicationIdentityResolver,
  IdentityResolutionError,
  toUserMeDto,
  type AuthenticatedUserContext,
} from '../src/server/auth/identity';
import type { AuthenticatedPrincipal } from '../src/server/auth/types';

const { Miniflare, convertV4MiniflareOptions } = miniflare;
const rootDir = resolve(__dirname, '..');

describe('M1-T06 Gerçek Yerel Miniflare D1 Identity Resolver Testleri', () => {
  let mf: miniflare.Miniflare;
  let db: D1Database;

  const TEST_ISSUER = 'https://mayi-test.cloudflareaccess.com';
  const OTHER_ISSUER = 'https://other-team.cloudflareaccess.com';

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

    // 0000 ve 0001 D1 migrasyonlarını çalıştır
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
  });

  afterAll(async () => {
    if (mf) {
      await mf.dispose();
    }
  });

  // M1-T03 Invariant Uyumlu Bootstrap Yardımcısı
  async function bootstrapActiveAgency(
    prefix: string,
    issuer = TEST_ISSUER,
    subject = `${prefix}-owner-sub`,
  ) {
    // 1. PROVISIONING agency
    await db
      .prepare("INSERT INTO agencies (id, status, version) VALUES (?, 'PROVISIONING', 1)")
      .bind(`${prefix}-agency`)
      .run();
    // 2. INACTIVE user
    await db
      .prepare("INSERT INTO users (id, status, version) VALUES (?, 'INACTIVE', 1)")
      .bind(`${prefix}-owner-user`)
      .run();
    // 3. INVITED OWNER membership
    await db
      .prepare(
        `INSERT INTO agency_memberships (
           id, agency_id, user_id, type, status, invitation_email, invitation_expires_at, version, permission_version
         ) VALUES (
           ?, ?, ?, 'OWNER', 'INVITED', ?, '2099-01-01T00:00:00.000Z', 1, 1
         )`,
      )
      .bind(
        `${prefix}-owner-mem`,
        `${prefix}-agency`,
        `${prefix}-owner-user`,
        `${prefix}-owner@example.test`,
      )
      .run();
    // 4. auth identity
    await db
      .prepare(
        `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
         VALUES (?, ?, ?, ?, ?, 'ACTIVE')`,
      )
      .bind(
        `${prefix}-owner-id`,
        `${prefix}-owner-user`,
        issuer,
        subject,
        `${prefix}-owner@example.test`,
      )
      .run();
    // 5. Activate user
    await db
      .prepare("UPDATE users SET status = 'ACTIVE', version = version + 1 WHERE id = ?")
      .bind(`${prefix}-owner-user`)
      .run();
    // 6. Activate membership
    await db
      .prepare(
        `UPDATE agency_memberships
         SET status = 'ACTIVE', activated_at = '2026-09-17T00:00:00.000Z',
             version = version + 1, permission_version = permission_version + 1
         WHERE id = ?`,
      )
      .bind(`${prefix}-owner-mem`)
      .run();
    // 7. Activate agency
    await db
      .prepare(
        `UPDATE agencies
         SET status = 'ACTIVE', bootstrap_completed_at = '2026-09-17T00:00:00.000Z',
             activated_at = '2026-09-17T00:00:00.000Z', version = version + 1
         WHERE id = ?`,
      )
      .bind(`${prefix}-agency`)
      .run();
  }

  async function addActiveMember(
    prefix: string,
    agencyId: string,
    issuer = TEST_ISSUER,
    subject = `${prefix}-member-sub`,
  ) {
    await db
      .prepare("INSERT INTO users (id, status, version) VALUES (?, 'ACTIVE', 1)")
      .bind(`${prefix}-member-user`)
      .run();
    await db
      .prepare(
        `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
         VALUES (?, ?, ?, ?, ?, 'ACTIVE')`,
      )
      .bind(
        `${prefix}-member-id`,
        `${prefix}-member-user`,
        issuer,
        subject,
        `${prefix}-member@example.test`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO agency_memberships (
           id, agency_id, user_id, type, status, invitation_email, invitation_expires_at,
           activated_at, version, permission_version
         ) VALUES (
           ?, ?, ?, 'MEMBER', 'ACTIVE', ?, '2099-01-01T00:00:00.000Z',
           '2026-09-17T00:00:00.000Z', 1, 1
         )`,
      )
      .bind(
        `${prefix}-member-mem`,
        agencyId,
        `${prefix}-member-user`,
        `${prefix}-member@example.test`,
      )
      .run();
  }

  it('valid principal exact issuer+subject -> active user/context', async () => {
    const p = 't06-valid';
    await bootstrapActiveAgency(p, TEST_ISSUER, `${p}-sub`);

    const principal: AuthenticatedPrincipal = {
      issuer: TEST_ISSUER,
      subject: `${p}-sub`,
      assurance: 'NORMAL',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      email: `${p}-owner@example.test`,
    };

    const context = await resolveAuthenticatedUserContext(db, principal);

    expect(context.userId).toBe(`${p}-owner-user`);
    expect(context.identityId).toBe(`${p}-owner-id`);
    expect(context.email).toBe(`${p}-owner@example.test`);
    expect(context.assurance).toBe('NORMAL');
    expect(context.memberships).toHaveLength(1);
    expect(context.memberships[0]).toEqual({
      id: `${p}-owner-mem`,
      agencyId: `${p}-agency`,
      type: 'OWNER',
      status: 'ACTIVE',
      permissionVersion: 2,
    });
    expect(Object.isFrozen(context)).toBe(true);
    expect(Object.isFrozen(context.memberships)).toBe(true);
    expect(Object.isFrozen(context.memberships[0]!)).toBe(true);
  });

  it('unknown subject deny (IDENTITY_NOT_FOUND)', async () => {
    const p = 't06-unknown-sub';
    await bootstrapActiveAgency(p, TEST_ISSUER, `${p}-sub`);

    const principal: AuthenticatedPrincipal = {
      issuer: TEST_ISSUER,
      subject: 'completely-unknown-sub',
      assurance: 'NORMAL',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };

    await expect(resolveAuthenticatedUserContext(db, principal)).rejects.toThrow(
      IdentityResolutionError,
    );
    await expect(resolveAuthenticatedUserContext(db, principal)).rejects.toMatchObject({
      code: 'IDENTITY_NOT_FOUND',
    });
  });

  it('same email/different subject no confusion (lookup strictly by issuer+subject)', async () => {
    const p = 't06-email-diff';
    await bootstrapActiveAgency(p, TEST_ISSUER, `${p}-sub-real`);

    // Attacker token has the same email, but a different subject
    const principal: AuthenticatedPrincipal = {
      issuer: TEST_ISSUER,
      subject: `${p}-sub-attacker`,
      assurance: 'NORMAL',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      email: `${p}-owner@example.test`,
    };

    await expect(resolveAuthenticatedUserContext(db, principal)).rejects.toMatchObject({
      code: 'IDENTITY_NOT_FOUND',
    });
  });

  it('same subject/wrong issuer no match', async () => {
    const p = 't06-wrong-iss';
    await bootstrapActiveAgency(p, TEST_ISSUER, `${p}-sub`);

    const principal: AuthenticatedPrincipal = {
      issuer: OTHER_ISSUER,
      subject: `${p}-sub`,
      assurance: 'NORMAL',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };

    await expect(resolveAuthenticatedUserContext(db, principal)).rejects.toMatchObject({
      code: 'IDENTITY_NOT_FOUND',
    });
  });

  it('revoked AuthIdentity deny (IDENTITY_REVOKED)', async () => {
    const p = 't06-revoked';
    await bootstrapActiveAgency(p, TEST_ISSUER, `${p}-sub`);
    await addActiveMember(p, `${p}-agency`, TEST_ISSUER, `${p}-member-sub`);

    // Revoke the member's auth identity (does not violate last-owner trigger)
    await db
      .prepare(
        `UPDATE auth_identities
         SET status = 'REVOKED', revoked_at = '2026-09-17T00:00:00.000Z', version = version + 1
         WHERE id = ?`,
      )
      .bind(`${p}-member-id`)
      .run();

    const principal: AuthenticatedPrincipal = {
      issuer: TEST_ISSUER,
      subject: `${p}-member-sub`,
      assurance: 'NORMAL',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };

    await expect(resolveAuthenticatedUserContext(db, principal)).rejects.toMatchObject({
      code: 'IDENTITY_REVOKED',
    });
  });

  it('inactive User deny (USER_INACTIVE)', async () => {
    const p = 't06-inactive-user';
    // Bootstrap active agency first, then add a member whose user we set to INACTIVE
    await bootstrapActiveAgency(p, TEST_ISSUER, `${p}-sub`);
    await addActiveMember(p, `${p}-agency`, TEST_ISSUER, `${p}-member-sub`);

    // Inactivate the member user
    await db
      .prepare("UPDATE users SET status = 'INACTIVE', version = version + 1 WHERE id = ?")
      .bind(`${p}-member-user`)
      .run();

    const principal: AuthenticatedPrincipal = {
      issuer: TEST_ISSUER,
      subject: `${p}-member-sub`,
      assurance: 'NORMAL',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };

    await expect(resolveAuthenticatedUserContext(db, principal)).rejects.toMatchObject({
      code: 'USER_INACTIVE',
    });
  });

  it('invited, suspended, inactive memberships not accepted', async () => {
    const p = 't06-lifecycle-mem';
    await bootstrapActiveAgency(p, TEST_ISSUER, `${p}-owner-sub`);

    // 1. User with only INVITED membership
    await db
      .prepare("INSERT INTO users (id, status, version) VALUES (?, 'ACTIVE', 1)")
      .bind(`${p}-invited-user`)
      .run();
    await db
      .prepare(
        `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
         VALUES (?, ?, ?, ?, ?, 'ACTIVE')`,
      )
      .bind(
        `${p}-invited-id`,
        `${p}-invited-user`,
        TEST_ISSUER,
        `${p}-invited-sub`,
        `${p}-inv@test.com`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO agency_memberships (
           id, agency_id, user_id, type, status, invitation_email, invitation_expires_at, version, permission_version
         ) VALUES (?, ?, ?, 'MEMBER', 'INVITED', ?, '2099-01-01T00:00:00.000Z', 1, 1)`,
      )
      .bind(`${p}-mem-invited`, `${p}-agency`, `${p}-invited-user`, `${p}-inv@test.com`)
      .run();

    const principalInvited: AuthenticatedPrincipal = {
      issuer: TEST_ISSUER,
      subject: `${p}-invited-sub`,
      assurance: 'NORMAL',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };

    await expect(resolveAuthenticatedUserContext(db, principalInvited)).rejects.toMatchObject({
      code: 'NO_ACTIVE_MEMBERSHIPS',
    });

    // 2. User with only SUSPENDED membership
    await db
      .prepare("INSERT INTO users (id, status, version) VALUES (?, 'ACTIVE', 1)")
      .bind(`${p}-suspended-user`)
      .run();
    await db
      .prepare(
        `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
         VALUES (?, ?, ?, ?, ?, 'ACTIVE')`,
      )
      .bind(
        `${p}-suspended-id`,
        `${p}-suspended-user`,
        TEST_ISSUER,
        `${p}-suspended-sub`,
        `${p}-susp@test.com`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO agency_memberships (
           id, agency_id, user_id, type, status, invitation_email, invitation_expires_at,
           activated_at, suspended_at, version, permission_version
         ) VALUES (?, ?, ?, 'MEMBER', 'SUSPENDED', ?, '2099-01-01T00:00:00.000Z',
           '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z', 1, 1)`,
      )
      .bind(`${p}-mem-suspended`, `${p}-agency`, `${p}-suspended-user`, `${p}-susp@test.com`)
      .run();

    const principalSuspended: AuthenticatedPrincipal = {
      issuer: TEST_ISSUER,
      subject: `${p}-suspended-sub`,
      assurance: 'NORMAL',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };

    await expect(resolveAuthenticatedUserContext(db, principalSuspended)).rejects.toMatchObject({
      code: 'NO_ACTIVE_MEMBERSHIPS',
    });

    // 3. User with only INACTIVE membership
    await db
      .prepare("INSERT INTO users (id, status, version) VALUES (?, 'ACTIVE', 1)")
      .bind(`${p}-inactive-user`)
      .run();
    await db
      .prepare(
        `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
         VALUES (?, ?, ?, ?, ?, 'ACTIVE')`,
      )
      .bind(
        `${p}-inactive-id`,
        `${p}-inactive-user`,
        TEST_ISSUER,
        `${p}-inactive-sub`,
        `${p}-inact@test.com`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO agency_memberships (
           id, agency_id, user_id, type, status, invitation_email, invitation_expires_at,
           inactivated_at, version, permission_version
         ) VALUES (?, ?, ?, 'MEMBER', 'INACTIVE', ?, '2099-01-01T00:00:00.000Z',
           '2026-09-17T00:00:00.000Z', 1, 1)`,
      )
      .bind(`${p}-mem-inactive`, `${p}-agency`, `${p}-inactive-user`, `${p}-inact@test.com`)
      .run();

    const principalInactive: AuthenticatedPrincipal = {
      issuer: TEST_ISSUER,
      subject: `${p}-inactive-sub`,
      assurance: 'NORMAL',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };

    await expect(resolveAuthenticatedUserContext(db, principalInactive)).rejects.toMatchObject({
      code: 'NO_ACTIVE_MEMBERSHIPS',
    });
  });

  it('inactive/provisioning Agency not accepted', async () => {
    const p = 't06-prov-agency';
    // Create PROVISIONING agency with an INVITED owner
    await db
      .prepare("INSERT INTO agencies (id, status, version) VALUES (?, 'PROVISIONING', 1)")
      .bind(`${p}-agency`)
      .run();
    await db
      .prepare("INSERT INTO users (id, status, version) VALUES (?, 'ACTIVE', 1)")
      .bind(`${p}-user`)
      .run();
    await db
      .prepare(
        `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
         VALUES (?, ?, ?, ?, ?, 'ACTIVE')`,
      )
      .bind(`${p}-id`, `${p}-user`, TEST_ISSUER, `${p}-sub`, `${p}@test.com`)
      .run();
    await db
      .prepare(
        `INSERT INTO agency_memberships (
           id, agency_id, user_id, type, status, invitation_email, invitation_expires_at, version, permission_version
         ) VALUES (?, ?, ?, 'OWNER', 'INVITED', ?, '2099-01-01T00:00:00.000Z', 1, 1)`,
      )
      .bind(`${p}-mem`, `${p}-agency`, `${p}-user`, `${p}@test.com`)
      .run();

    const principal: AuthenticatedPrincipal = {
      issuer: TEST_ISSUER,
      subject: `${p}-sub`,
      assurance: 'NORMAL',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };

    // PROVISIONING agency has no ACTIVE context
    await expect(resolveAuthenticatedUserContext(db, principal)).rejects.toMatchObject({
      code: 'NO_ACTIVE_MEMBERSHIPS',
    });
  });

  it('multiple active memberships represented deterministically, no invented current agency', async () => {
    const p = 't06-multi';
    // Bootstrap 3 distinct active agencies
    await bootstrapActiveAgency(`${p}-a`, TEST_ISSUER, `${p}-owner-a`);
    await bootstrapActiveAgency(`${p}-b`, TEST_ISSUER, `${p}-owner-b`);
    await bootstrapActiveAgency(`${p}-c`, TEST_ISSUER, `${p}-owner-c`);

    // Create a multi-agency user
    const multiUserId = `${p}-multi-user`;
    const multiSub = `${p}-multi-sub`;
    await db
      .prepare("INSERT INTO users (id, status, version) VALUES (?, 'ACTIVE', 1)")
      .bind(multiUserId)
      .run();
    await db
      .prepare(
        `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
         VALUES (?, ?, ?, ?, ?, 'ACTIVE')`,
      )
      .bind(`${p}-multi-id`, multiUserId, TEST_ISSUER, multiSub, `${p}-multi@test.com`)
      .run();

    // Add active memberships to agencies C, A, B
    await db
      .prepare(
        `INSERT INTO agency_memberships (
           id, agency_id, user_id, type, status, invitation_email, invitation_expires_at,
           activated_at, version, permission_version
         ) VALUES (?, ?, ?, 'MEMBER', 'ACTIVE', ?, '2099-01-01T00:00:00.000Z', '2026-09-17T00:00:00.000Z', 1, 3)`,
      )
      .bind(`${p}-mem-c`, `${p}-c-agency`, multiUserId, `${p}-multi@test.com`)
      .run();

    await db
      .prepare(
        `INSERT INTO agency_memberships (
           id, agency_id, user_id, type, status, invitation_email, invitation_expires_at,
           activated_at, version, permission_version
         ) VALUES (?, ?, ?, 'MEMBER', 'ACTIVE', ?, '2099-01-01T00:00:00.000Z', '2026-09-17T00:00:00.000Z', 1, 1)`,
      )
      .bind(`${p}-mem-a`, `${p}-a-agency`, multiUserId, `${p}-multi@test.com`)
      .run();

    await db
      .prepare(
        `INSERT INTO agency_memberships (
           id, agency_id, user_id, type, status, invitation_email, invitation_expires_at,
           activated_at, version, permission_version
         ) VALUES (?, ?, ?, 'OWNER', 'ACTIVE', ?, '2099-01-01T00:00:00.000Z', '2026-09-17T00:00:00.000Z', 1, 2)`,
      )
      .bind(`${p}-mem-b`, `${p}-b-agency`, multiUserId, `${p}-multi@test.com`)
      .run();

    const principal: AuthenticatedPrincipal = {
      issuer: TEST_ISSUER,
      subject: multiSub,
      assurance: 'SECURE',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };

    const context = await resolveAuthenticatedUserContext(db, principal);

    expect(context.memberships).toHaveLength(3);
    const [mem0, mem1, mem2] = context.memberships;
    expect(mem0).toBeDefined();
    expect(mem1).toBeDefined();
    expect(mem2).toBeDefined();

    // Must be deterministically ordered by agencyId ASC, id ASC
    expect(mem0!.agencyId).toBe(`${p}-a-agency`);
    expect(mem0!.id).toBe(`${p}-mem-a`);
    expect(mem0!.type).toBe('MEMBER');
    expect(mem0!.permissionVersion).toBe(1);

    expect(mem1!.agencyId).toBe(`${p}-b-agency`);
    expect(mem1!.id).toBe(`${p}-mem-b`);
    expect(mem1!.type).toBe('OWNER');
    expect(mem1!.permissionVersion).toBe(2);

    expect(mem2!.agencyId).toBe(`${p}-c-agency`);
    expect(mem2!.id).toBe(`${p}-mem-c`);
    expect(mem2!.type).toBe('MEMBER');
    expect(mem2!.permissionVersion).toBe(3);

    // No invented current agency on context
    expect('currentAgency' in context).toBe(false);
    expect('currentAgencyId' in context).toBe(false);
  });

  it('token OWNER/agency/permission claims cannot replace DB truth', async () => {
    const p = 't06-token-spoof';
    await bootstrapActiveAgency(p, TEST_ISSUER, `${p}-sub`);
    await addActiveMember(p, `${p}-agency`, TEST_ISSUER, `${p}-member-sub`);

    // In DB, this user is MEMBER
    const principal: AuthenticatedPrincipal & Record<string, unknown> = {
      issuer: TEST_ISSUER,
      subject: `${p}-member-sub`,
      assurance: 'NORMAL',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      type: 'OWNER', // ignored
      role: 'OWNER', // ignored
      permissions: ['*'], // ignored
      agencyId: 'attacker-agency', // ignored
    };

    const context = await resolveAuthenticatedUserContext(db, principal);

    const [spoofMem] = context.memberships;
    expect(spoofMem).toBeDefined();
    expect(spoofMem!.type).toBe('MEMBER');
    expect(spoofMem!.agencyId).toBe(`${p}-agency`);
  });

  it('DB query error fails closed with DATABASE_ERROR', async () => {
    const brokenDb = {
      prepare() {
        throw new Error('Synthetic D1 failure');
      },
    } as unknown as D1Database;

    const principal: AuthenticatedPrincipal = {
      issuer: TEST_ISSUER,
      subject: 'sub-anything',
      assurance: 'NORMAL',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };

    await expect(resolveAuthenticatedUserContext(brokenDb, principal)).rejects.toMatchObject({
      code: 'DATABASE_ERROR',
    });
  });

  it('factory createApplicationIdentityResolver works', async () => {
    const p = 't06-factory';
    await bootstrapActiveAgency(p, TEST_ISSUER, `${p}-sub`);

    const resolver = createApplicationIdentityResolver(db);
    const principal: AuthenticatedPrincipal = {
      issuer: TEST_ISSUER,
      subject: `${p}-sub`,
      assurance: 'NORMAL',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };

    const context = await resolver.resolve(principal);
    expect(context.userId).toBe(`${p}-owner-user`);
  });

  it('toUserMeDto transforms context into safe immutable DTO without internals', () => {
    const context: AuthenticatedUserContext = Object.freeze({
      userId: 'usr-123',
      identityId: 'id-secret-456',
      email: 'test@example.com',
      assurance: 'NORMAL' as const,
      memberships: Object.freeze([
        Object.freeze({
          id: 'mem-1',
          agencyId: 'agency-1',
          type: 'OWNER' as const,
          status: 'ACTIVE' as const,
          permissionVersion: 1,
        }),
      ]),
    });

    const dto = toUserMeDto(context);

    expect(dto).toEqual({
      userId: 'usr-123',
      email: 'test@example.com',
      assurance: 'NORMAL',
      memberships: [
        {
          id: 'mem-1',
          agencyId: 'agency-1',
          type: 'OWNER',
          status: 'ACTIVE',
        },
      ],
    });

    // identityId and permissionVersion must not leak into public DTO
    expect('identityId' in dto).toBe(false);
    const [mem] = dto.memberships;
    expect(mem).toBeDefined();
    expect('permissionVersion' in mem!).toBe(false);
    expect('version' in mem!).toBe(false);
    expect(Object.isFrozen(dto)).toBe(true);
    expect(Object.isFrozen(dto.memberships)).toBe(true);
  });

  it('principal with invalid assurance fails closed with CORRUPT_IDENTITY_DATA', async () => {
    const p = 't06-bad-assurance';
    await bootstrapActiveAgency(p, TEST_ISSUER, `${p}-sub`);

    const principal = {
      issuer: TEST_ISSUER,
      subject: `${p}-sub`,
      assurance: 'SUPER_ADMIN' as unknown as 'NORMAL',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };

    await expect(resolveAuthenticatedUserContext(db, principal)).rejects.toMatchObject({
      code: 'CORRUPT_IDENTITY_DATA',
    });
  });

  it('malformed stored verified_email in AuthIdentity fails closed as CORRUPT_IDENTITY_DATA', async () => {
    const p = 't06-bad-email';
    await bootstrapActiveAgency(p, TEST_ISSUER, `${p}-sub`);

    // Mock DB where auth_identities returns an invalid verified_email
    const badEmailDb = {
      prepare(query: string) {
        return {
          bind(..._args: unknown[]) {
            return {
              async all() {
                if (query.includes('FROM auth_identities')) {
                  return {
                    success: true,
                    results: [
                      {
                        id: 'id-1',
                        user_id: 'usr-1',
                        issuer: TEST_ISSUER,
                        subject: `${p}-sub`,
                        verified_email: 'not-an-email', // invalid email shape
                        status: 'ACTIVE',
                      },
                    ],
                  };
                }
                return { success: true, results: [] };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const principal: AuthenticatedPrincipal = {
      issuer: TEST_ISSUER,
      subject: `${p}-sub`,
      assurance: 'NORMAL',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
      email: 'valid-principal-email@mayisigorta.com', // token email must NOT mask corrupt DB row
    };

    await expect(resolveAuthenticatedUserContext(badEmailDb, principal)).rejects.toMatchObject({
      code: 'CORRUPT_IDENTITY_DATA',
    });
  });

  it('missing user record fails closed with USER_NOT_FOUND', async () => {
    // Identity exists, but user record is missing in users table (e.g. foreign key anomaly or mock)
    const mockDb = {
      prepare(query: string) {
        return {
          bind(..._args: unknown[]) {
            return {
              async all() {
                if (query.includes('FROM auth_identities')) {
                  return {
                    success: true,
                    results: [
                      {
                        id: 'ident-1',
                        user_id: 'user-missing',
                        issuer: TEST_ISSUER,
                        subject: 'sub-missing-user',
                        verified_email: 'test@example.com',
                        status: 'ACTIVE',
                      },
                    ],
                  };
                }
                if (query.includes('FROM users')) {
                  return { success: true, results: [] };
                }
                return { success: true, results: [] };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const principal: AuthenticatedPrincipal = {
      issuer: TEST_ISSUER,
      subject: 'sub-missing-user',
      assurance: 'NORMAL',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };

    await expect(resolveAuthenticatedUserContext(mockDb, principal)).rejects.toMatchObject({
      code: 'USER_NOT_FOUND',
    });
  });

  it('corrupt identity rows (multiple or invalid shape) fail closed with CORRUPT_IDENTITY_DATA', async () => {
    // 1. Multiple rows for unique issuer + subject
    const multiRowDb = {
      prepare() {
        return {
          bind() {
            return {
              async all() {
                return {
                  success: true,
                  results: [
                    {
                      id: 'i1',
                      user_id: 'u1',
                      issuer: TEST_ISSUER,
                      subject: 'sub-1',
                      status: 'ACTIVE',
                    },
                    {
                      id: 'i2',
                      user_id: 'u1',
                      issuer: TEST_ISSUER,
                      subject: 'sub-1',
                      status: 'ACTIVE',
                    },
                  ],
                };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const principal: AuthenticatedPrincipal = {
      issuer: TEST_ISSUER,
      subject: 'sub-1',
      assurance: 'NORMAL',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };

    await expect(resolveAuthenticatedUserContext(multiRowDb, principal)).rejects.toMatchObject({
      code: 'CORRUPT_IDENTITY_DATA',
    });

    // 2. Invalid shape / missing user_id
    const badShapeDb = {
      prepare() {
        return {
          bind() {
            return {
              async all() {
                return {
                  success: true,
                  results: [
                    {
                      id: 'i1',
                      user_id: '',
                      issuer: TEST_ISSUER,
                      subject: 'sub-1',
                      status: 'ACTIVE',
                    },
                  ],
                };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    await expect(resolveAuthenticatedUserContext(badShapeDb, principal)).rejects.toMatchObject({
      code: 'CORRUPT_IDENTITY_DATA',
    });
  });

  it('corrupt membership data (duplicate agency for same user or bad version) fails closed', async () => {
    const corruptMembershipDb = {
      prepare(query: string) {
        return {
          bind() {
            return {
              async all() {
                if (query.includes('FROM auth_identities')) {
                  return {
                    success: true,
                    results: [
                      {
                        id: 'i1',
                        user_id: 'u1',
                        issuer: TEST_ISSUER,
                        subject: 'sub-1',
                        verified_email: 'u1@example.test',
                        status: 'ACTIVE',
                      },
                    ],
                  };
                }
                if (query.includes('FROM users')) {
                  return {
                    success: true,
                    results: [{ id: 'u1', status: 'ACTIVE' }],
                  };
                }
                if (query.includes('FROM agency_memberships')) {
                  return {
                    success: true,
                    results: [
                      // Two active memberships for the same agency_1!
                      {
                        id: 'm1',
                        agency_id: 'agency-1',
                        user_id: 'u1',
                        type: 'MEMBER',
                        status: 'ACTIVE',
                        permission_version: 1,
                        joined_agency_id: 'agency-1',
                        agency_status: 'ACTIVE',
                      },
                      {
                        id: 'm2',
                        agency_id: 'agency-1',
                        user_id: 'u1',
                        type: 'OWNER',
                        status: 'ACTIVE',
                        permission_version: 1,
                        joined_agency_id: 'agency-1',
                        agency_status: 'ACTIVE',
                      },
                    ],
                  };
                }
                return { success: true, results: [] };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    const principal: AuthenticatedPrincipal = {
      issuer: TEST_ISSUER,
      subject: 'sub-1',
      assurance: 'NORMAL',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };

    await expect(
      resolveAuthenticatedUserContext(corruptMembershipDb, principal),
    ).rejects.toMatchObject({
      code: 'CORRUPT_MEMBERSHIP_DATA',
    });
  });

  // =========================================================================
  // Malformed / Unsuccessful D1Result Boundary Unit Tests (I-01)
  // =========================================================================

  it('unsuccessful or malformed D1 results fail closed as DATABASE_ERROR or CORRUPT_*_DATA', async () => {
    const principal: AuthenticatedPrincipal = {
      issuer: TEST_ISSUER,
      subject: 'sub-adv',
      assurance: 'NORMAL',
      expiresAt: Math.floor(Date.now() / 1000) + 3600,
    };

    // 1. Identity query unsuccessful: { success: false, results: [] } -> DATABASE_ERROR
    const unsuccessIdentityDb = {
      prepare() {
        return {
          bind() {
            return {
              async all() {
                return { success: false, results: [] };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    await expect(
      resolveAuthenticatedUserContext(unsuccessIdentityDb, principal),
    ).rejects.toMatchObject({
      code: 'DATABASE_ERROR',
    });

    // 2. Identity query malformed row: { success: true, results: [null] } -> CORRUPT_IDENTITY_DATA
    const nullRowIdentityDb = {
      prepare() {
        return {
          bind() {
            return {
              async all() {
                return { success: true, results: [null] };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    await expect(
      resolveAuthenticatedUserContext(nullRowIdentityDb, principal),
    ).rejects.toMatchObject({
      code: 'CORRUPT_IDENTITY_DATA',
    });

    // 3. User query unsuccessful: { success: false, results: [] } -> DATABASE_ERROR
    const unsuccessUserDb = {
      prepare(query: string) {
        return {
          bind() {
            return {
              async all() {
                if (query.includes('FROM auth_identities')) {
                  return {
                    success: true,
                    results: [
                      {
                        id: 'i1',
                        user_id: 'u1',
                        issuer: TEST_ISSUER,
                        subject: 'sub-adv',
                        verified_email: 'u1@example.test',
                        status: 'ACTIVE',
                      },
                    ],
                  };
                }
                if (query.includes('FROM users')) {
                  return { success: false, results: [] };
                }
                return { success: true, results: [] };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    await expect(resolveAuthenticatedUserContext(unsuccessUserDb, principal)).rejects.toMatchObject(
      {
        code: 'DATABASE_ERROR',
      },
    );

    // 4. User query malformed row: { success: true, results: [null] } -> CORRUPT_IDENTITY_DATA
    const nullRowUserDb = {
      prepare(query: string) {
        return {
          bind() {
            return {
              async all() {
                if (query.includes('FROM auth_identities')) {
                  return {
                    success: true,
                    results: [
                      {
                        id: 'i1',
                        user_id: 'u1',
                        issuer: TEST_ISSUER,
                        subject: 'sub-adv',
                        verified_email: 'u1@example.test',
                        status: 'ACTIVE',
                      },
                    ],
                  };
                }
                if (query.includes('FROM users')) {
                  return { success: true, results: [null] };
                }
                return { success: true, results: [] };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    await expect(resolveAuthenticatedUserContext(nullRowUserDb, principal)).rejects.toMatchObject({
      code: 'CORRUPT_IDENTITY_DATA',
    });

    // 5. Membership query unsuccessful: { success: false, results: [] } -> DATABASE_ERROR
    const unsuccessMemDb = {
      prepare(query: string) {
        return {
          bind() {
            return {
              async all() {
                if (query.includes('FROM auth_identities')) {
                  return {
                    success: true,
                    results: [
                      {
                        id: 'i1',
                        user_id: 'u1',
                        issuer: TEST_ISSUER,
                        subject: 'sub-adv',
                        verified_email: 'u1@example.test',
                        status: 'ACTIVE',
                      },
                    ],
                  };
                }
                if (query.includes('FROM users')) {
                  return {
                    success: true,
                    results: [{ id: 'u1', status: 'ACTIVE' }],
                  };
                }
                if (query.includes('FROM agency_memberships')) {
                  return { success: false, results: [] };
                }
                return { success: true, results: [] };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    await expect(resolveAuthenticatedUserContext(unsuccessMemDb, principal)).rejects.toMatchObject({
      code: 'DATABASE_ERROR',
    });

    // 6. Membership query malformed row: { success: true, results: [null] } -> CORRUPT_MEMBERSHIP_DATA
    const nullRowMemDb = {
      prepare(query: string) {
        return {
          bind() {
            return {
              async all() {
                if (query.includes('FROM auth_identities')) {
                  return {
                    success: true,
                    results: [
                      {
                        id: 'i1',
                        user_id: 'u1',
                        issuer: TEST_ISSUER,
                        subject: 'sub-adv',
                        verified_email: 'u1@example.test',
                        status: 'ACTIVE',
                      },
                    ],
                  };
                }
                if (query.includes('FROM users')) {
                  return {
                    success: true,
                    results: [{ id: 'u1', status: 'ACTIVE' }],
                  };
                }
                if (query.includes('FROM agency_memberships')) {
                  return { success: true, results: [null] };
                }
                return { success: true, results: [] };
              },
            };
          },
        };
      },
    } as unknown as D1Database;

    await expect(resolveAuthenticatedUserContext(nullRowMemDb, principal)).rejects.toMatchObject({
      code: 'CORRUPT_MEMBERSHIP_DATA',
    });
  });
});
