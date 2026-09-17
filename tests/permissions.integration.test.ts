// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import miniflare from 'miniflare';
import {
  grantPermission,
  revokePermission,
  changePermissionScope,
  UnknownPermissionError,
  InvalidPermissionScopeError,
  OwnerNormalPermissionProhibitedError,
  DuplicatePermissionGrantError,
  MembershipPermissionNotFoundError,
  MembershipNotFoundError,
  MissingPermissionDependencyError,
  IncompatibleDependencyScopeError,
  ActivePermissionDependencyError,
} from '../src/server/db/permissions';
import { OptimisticConcurrencyError } from '../src/server/db/optimistic';
import { isPermissionCode, getPermissionDefinition } from '../src/shared/permissions';

const { Miniflare, convertV4MiniflareOptions } = miniflare;

const rootDir = resolve(__dirname, '..');

describe('M1-T04 Gerçek Yerel D1 İzin ve Kalıcılık Entegrasyon Testleri (Miniflare D1)', () => {
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
        },
      }),
    );
    db = await mf.getD1Database('DB');

    // 0000 ve 0001 migrasyonlarını sırayla gerçek Miniflare D1 üzerinde çalıştır
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

  // Test Verisi Hazırlama Yardımcıları
  async function bootstrapActiveAgency(prefix: string) {
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
         VALUES (?, ?, 'https://synthetic.cloudflareaccess.com', ?, ?, 'ACTIVE')`,
      )
      .bind(
        `${prefix}-owner-id`,
        `${prefix}-owner-user`,
        `${prefix}-owner-user`,
        `${prefix}-owner@example.test`,
      )
      .run();
    // 5. Activate user
    await db
      .prepare("UPDATE users SET status = 'ACTIVE', version = version + 1 WHERE id = ?")
      .bind(`${prefix}-owner-user`)
      .run();
    // 6. Activate membership (permission_version artırımı zorunludur)
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

  async function addActiveMember(prefix: string, agencyId: string) {
    await db
      .prepare("INSERT INTO users (id, status, version) VALUES (?, 'ACTIVE', 1)")
      .bind(`${prefix}-member-user`)
      .run();
    await db
      .prepare(
        `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
         VALUES (?, ?, 'https://synthetic.cloudflareaccess.com', ?, ?, 'ACTIVE')`,
      )
      .bind(
        `${prefix}-member-id`,
        `${prefix}-member-user`,
        `${prefix}-member-user`,
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

  async function getPermissionVersion(membershipId: string): Promise<number> {
    const row = await db
      .prepare('SELECT permission_version FROM agency_memberships WHERE id = ?')
      .bind(membershipId)
      .first<{ permission_version: number }>();
    return row!.permission_version;
  }

  // 1. Miniflare D1 Migrasyon Yaşam Döngüsü
  describe('Miniflare D1 Migrasyon Yaşam Döngüsü', () => {
    it('0000 ve 0001 migrasyonları Miniflare D1 üzerinde eksiksiz ve temiz uygulanır', async () => {
      const tables = await db
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all<{ name: string }>();
      const names = tables.results.map((r) => r.name);
      expect(names).toContain('agencies');
      expect(names).toContain('agency_memberships');
      expect(names).toContain('auth_identities');
      expect(names).toContain('users');
      expect(names).toContain('membership_permissions');
      expect(names).toContain('d1_cas_assertions');
    });

    it('0000 şemasına sahip mevcut veritabanına 0001 sorunsuz yükseltilmelidir', async () => {
      const upgradeDb = await mf.getD1Database('UPGRADE_DB');
      const m0 = readFileSync(resolve(rootDir, 'db/migrations/0000_good_hammerhead.sql'), 'utf8');
      for (const s of m0
        .split('--> statement-breakpoint')
        .map((x) => x.trim())
        .filter(Boolean)) {
        await upgradeDb.prepare(s).run();
      }
      const m1 = readFileSync(
        resolve(rootDir, 'db/migrations/0001_chunky_blazing_skull.sql'),
        'utf8',
      );
      for (const s of m1
        .split('--> statement-breakpoint')
        .map((x) => x.trim())
        .filter(Boolean)) {
        await upgradeDb.prepare(s).run();
      }
      const tables = await upgradeDb
        .prepare("SELECT name FROM sqlite_master WHERE type='table'")
        .all<{ name: string }>();
      const names = tables.results.map((r) => r.name);
      expect(names).toContain('membership_permissions');
      expect(names).toContain('d1_cas_assertions');
    });
  });

  // 2. Doğrudan SQL Yapısal Güvenceleri ve Sınırların Dürüst Karakterizasyonu
  describe('Doğrudan SQL Sınırları ve Dürüst Karakterizasyon', () => {
    const agencyId = 'sql-agency';
    const ownerMemId = 'sql-owner-mem';
    const memberMemId = 'sql-member-mem';

    beforeAll(async () => {
      await bootstrapActiveAgency('sql');
      await addActiveMember('sql', agencyId);
    });

    it('DB Seviyesi: FK kısıtı (RESTRICT) geçersiz membership_id kaydını engeller', async () => {
      await expect(
        db
          .prepare(
            `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
             VALUES ('p-fk-fail', 'non-existent-mem', 'customer.read', 'ASSIGNED')`,
          )
          .run(),
      ).rejects.toThrow(/FOREIGN KEY/);
    });

    it('DB Seviyesi: Unique kısıtı (membership_id, permission_code) çift kaydı engeller', async () => {
      await db
        .prepare(
          `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
           VALUES ('p-uq-1', ?, 'policy.read', 'ASSIGNED')`,
        )
        .bind(memberMemId)
        .run();

      await expect(
        db
          .prepare(
            `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
             VALUES ('p-uq-2', ?, 'policy.read', 'AGENCY')`,
          )
          .bind(memberMemId)
          .run(),
      ).rejects.toThrow(/MEMBERSHIP_PERMISSION_ROW_REPLACEMENT_FORBIDDEN/);
    });

    it('DB Seviyesi: CHECK kısıtı geçersiz kapsam değerlerini (NONE, DENY, vb.) engeller', async () => {
      const invalidScopes = ['NONE', 'DENY', 'FALSE', 'ADMIN', ''];
      for (const badScope of invalidScopes) {
        await expect(
          db
            .prepare(
              `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
               VALUES (?, ?, 'customer.read', ?)`,
            )
            .bind(`bad-${badScope}`, memberMemId, badScope)
            .run(),
        ).rejects.toThrow(/membership_permissions_scope_valid/);
      }
    });

    it('DB Seviyesi: Update Guard tetikleyicisi kimlik ve izin kodunu dondurur', async () => {
      await expect(
        db
          .prepare(
            `UPDATE membership_permissions SET permission_code = 'customer.create' WHERE id = 'p-uq-1'`,
          )
          .run(),
      ).rejects.toThrow(/MEMBERSHIP_PERMISSION_IDENTITY_IMMUTABLE/);

      await expect(
        db
          .prepare(`UPDATE membership_permissions SET membership_id = 'other' WHERE id = 'p-uq-1'`)
          .run(),
      ).rejects.toThrow(/MEMBERSHIP_PERMISSION_IDENTITY_IMMUTABLE/);
    });

    it('Sınır Karakterizasyonu: Doğrudan SQL kod kataloğunu bilmez; bilinmeyen kod ve OWNER NORMAL satırı ancak yardımcı ve evaluatör tarafından engellenir', async () => {
      // Doğrudan SQL ile katalog dışı kod eklenebilir çünkü katalog TypeScript kodundadır
      await db
        .prepare(
          `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
           VALUES ('p-raw-unknown', ?, 'invented.unsupported.action', 'UNSCOPED')`,
        )
        .bind(memberMemId)
        .run();

      // Doğrudan SQL ile OWNER üzerine NORMAL izin eklenebilir
      await db
        .prepare(
          `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
           VALUES ('p-raw-owner-norm', ?, 'customer.read', 'AGENCY')`,
        )
        .bind(ownerMemId)
        .run();

      // Kanıt: Evaluatör / Katalog seviyesinde bu satırlar fail-closed olarak reddedilir
      const unknownRow = await db
        .prepare('SELECT permission_code FROM membership_permissions WHERE id = ?')
        .bind('p-raw-unknown')
        .first<{ permission_code: string }>();
      expect(isPermissionCode(unknownRow!.permission_code)).toBe(false);
      expect(getPermissionDefinition(unknownRow!.permission_code)).toBeUndefined();

      // Temizlik
      await db
        .prepare(
          `DELETE FROM membership_permissions WHERE id IN ('p-raw-unknown', 'p-raw-owner-norm')`,
        )
        .run();
    });
  });

  // 3. MembershipPermission Kabul Maddeleri 13-31 (Eksiksiz ve Doğrudan Kanıtlar)
  describe('MembershipPermission Kabul Maddeleri 13-31', () => {
    const agencyId = 'spec-agency';
    const memberMemId = 'spec-member-mem';
    const ownerMemId = 'spec-owner-mem';

    beforeAll(async () => {
      await bootstrapActiveAgency('spec');
      await addActiveMember('spec', agencyId);
    });

    it('13: MEMBER açık NORMAL izin tanımlaması başarıyla kabul edilir', async () => {
      const currentVersion = await getPermissionVersion(memberMemId);

      const result = await grantPermission(db, {
        agencyId,
        membershipId: memberMemId,
        permissionCode: 'customer.read',
        scope: 'ASSIGNED',
        expectedPermissionVersion: currentVersion,
      });

      expect(result.permissionCode).toBe('customer.read');
      expect(result.scope).toBe('ASSIGNED');
      expect(result.newPermissionVersion).toBe(currentVersion + 1);

      // Doğrudan veritabanı okuması ile teyit
      const row = await db
        .prepare(
          'SELECT permission_code, scope FROM membership_permissions WHERE membership_id = ? AND permission_code = ?',
        )
        .bind(memberMemId, 'customer.read')
        .first<{ permission_code: string; scope: string }>();
      expect(row).not.toBeNull();
      expect(row!.permission_code).toBe('customer.read');
      expect(row!.scope).toBe('ASSIGNED');
    });

    it('14: MEMBER açık SENSITIVE izin tanımlaması başarıyla kabul edilir', async () => {
      const currentVersion = await getPermissionVersion(memberMemId);

      const result = await grantPermission(db, {
        agencyId,
        membershipId: memberMemId,
        permissionCode: 'sensitive.identity.read',
        scope: 'UNSCOPED',
        expectedPermissionVersion: currentVersion,
      });

      expect(result.permissionCode).toBe('sensitive.identity.read');
      expect(result.scope).toBe('UNSCOPED');
      expect(result.newPermissionVersion).toBe(currentVersion + 1);

      // Doğrudan veritabanı okuması ile teyit
      const row = await db
        .prepare(
          'SELECT permission_code, scope FROM membership_permissions WHERE membership_id = ? AND permission_code = ?',
        )
        .bind(memberMemId, 'sensitive.identity.read')
        .first<{ permission_code: string; scope: string }>();
      expect(row).not.toBeNull();
      expect(row!.permission_code).toBe('sensitive.identity.read');
      expect(row!.scope).toBe('UNSCOPED');
    });

    it('15: yinelenen izin tanımlama (duplicate grant) reddedilir', async () => {
      const currentVersion = await getPermissionVersion(memberMemId);

      // customer.read zaten tanımlı
      await expect(
        grantPermission(db, {
          agencyId,
          membershipId: memberMemId,
          permissionCode: 'customer.read',
          scope: 'ASSIGNED',
          expectedPermissionVersion: currentVersion,
        }),
      ).rejects.toBeInstanceOf(DuplicatePermissionGrantError);
    });

    it('16: bilinmeyen izin kodu desteklenen yoldan (helper) reddedilir', async () => {
      const currentVersion = await getPermissionVersion(memberMemId);

      await expect(
        grantPermission(db, {
          agencyId,
          membershipId: memberMemId,
          permissionCode: 'invented.module.action',
          scope: 'ASSIGNED',
          expectedPermissionVersion: currentVersion,
        }),
      ).rejects.toBeInstanceOf(UnknownPermissionError);
    });

    it("17: açık DENY temsili ('NONE', 'DENY', 'FALSE') DB CHECK tarafından imkansız kılınır", async () => {
      const invalidScopes = ['NONE', 'DENY', 'FALSE', 'ADMIN', '0'];
      for (const badScope of invalidScopes) {
        await expect(
          db
            .prepare(
              `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
               VALUES (?, ?, 'policy.read', ?)`,
            )
            .bind(`item17-${badScope}`, memberMemId, badScope)
            .run(),
        ).rejects.toThrow(/membership_permissions_scope_valid/);
      }
    });

    it('18: RECORD_SCOPED izin ASSIGNED kapsamını kabul eder', async () => {
      const currentVersion = await getPermissionVersion(memberMemId);

      const result = await grantPermission(db, {
        agencyId,
        membershipId: memberMemId,
        permissionCode: 'policy.read',
        scope: 'ASSIGNED',
        expectedPermissionVersion: currentVersion,
      });

      expect(result.scope).toBe('ASSIGNED');
      const row = await db
        .prepare(
          'SELECT scope FROM membership_permissions WHERE membership_id = ? AND permission_code = ?',
        )
        .bind(memberMemId, 'policy.read')
        .first<{ scope: string }>();
      expect(row!.scope).toBe('ASSIGNED');
    });

    it('19: RECORD_SCOPED izin AGENCY kapsamını kabul eder', async () => {
      const currentVersion = await getPermissionVersion(memberMemId);

      const result = await grantPermission(db, {
        agencyId,
        membershipId: memberMemId,
        permissionCode: 'renewal.read',
        scope: 'AGENCY',
        expectedPermissionVersion: currentVersion,
      });

      expect(result.scope).toBe('AGENCY');
      const row = await db
        .prepare(
          'SELECT scope FROM membership_permissions WHERE membership_id = ? AND permission_code = ?',
        )
        .bind(memberMemId, 'renewal.read')
        .first<{ scope: string }>();
      expect(row!.scope).toBe('AGENCY');
    });

    it('20: RECORD_SCOPED izne UNSCOPED verilmesi reddedilir', async () => {
      const currentVersion = await getPermissionVersion(memberMemId);

      await expect(
        grantPermission(db, {
          agencyId,
          membershipId: memberMemId,
          permissionCode: 'document.read',
          scope: 'UNSCOPED',
          expectedPermissionVersion: currentVersion,
        }),
      ).rejects.toBeInstanceOf(InvalidPermissionScopeError);
    });

    it('21: UNSCOPED izne ASSIGNED veya AGENCY verilmesi reddedilir', async () => {
      const currentVersion = await getPermissionVersion(memberMemId);

      // customer.create UNSCOPED bir izindir (önkoşulu customer.read zaten üyede var)
      await expect(
        grantPermission(db, {
          agencyId,
          membershipId: memberMemId,
          permissionCode: 'customer.create',
          scope: 'ASSIGNED',
          expectedPermissionVersion: currentVersion,
        }),
      ).rejects.toBeInstanceOf(InvalidPermissionScopeError);

      await expect(
        grantPermission(db, {
          agencyId,
          membershipId: memberMemId,
          permissionCode: 'customer.create',
          scope: 'AGENCY',
          expectedPermissionVersion: currentVersion,
        }),
      ).rejects.toBeInstanceOf(InvalidPermissionScopeError);
    });

    it('22: OWNER için NORMAL izin verilmesi helper tarafından reddedilir', async () => {
      const currentVersion = await getPermissionVersion(ownerMemId);

      await expect(
        grantPermission(db, {
          agencyId,
          membershipId: ownerMemId,
          permissionCode: 'customer.read',
          scope: 'AGENCY',
          expectedPermissionVersion: currentVersion,
        }),
      ).rejects.toBeInstanceOf(OwnerNormalPermissionProhibitedError);
    });

    it('23: OWNER için SENSITIVE izin tanımlaması başarıyla kabul edilir', async () => {
      const currentVersion = await getPermissionVersion(ownerMemId);

      const result = await grantPermission(db, {
        agencyId,
        membershipId: ownerMemId,
        permissionCode: 'sensitive.health.read',
        scope: 'UNSCOPED',
        expectedPermissionVersion: currentVersion,
      });

      expect(result.permissionCode).toBe('sensitive.health.read');
      expect(result.newPermissionVersion).toBe(currentVersion + 1);

      // Doğrudan veritabanında satırın varlığı kanıtlanır
      const row = await db
        .prepare(
          'SELECT id FROM membership_permissions WHERE membership_id = ? AND permission_code = ?',
        )
        .bind(ownerMemId, 'sensitive.health.read')
        .first<{ id: string }>();
      expect(row).not.toBeNull();
    });

    it('24: geçersiz membership_id (FK) veritabanı tarafından RESTRICT ile reddedilir', async () => {
      await expect(
        db
          .prepare(
            `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
             VALUES ('item24-fail', 'non-existent-membership', 'customer.read', 'ASSIGNED')`,
          )
          .run(),
      ).rejects.toThrow(/FOREIGN KEY/);
    });

    it('25: unique (membership_id, permission_code) kısıtı doğrudan SQL ile korunur', async () => {
      await expect(
        db
          .prepare(
            `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
             VALUES ('item25-dup', ?, 'policy.read', 'AGENCY')`,
          )
          .bind(memberMemId)
          .run(),
      ).rejects.toThrow(/MEMBERSHIP_PERMISSION_ROW_REPLACEMENT_FORBIDDEN/);
    });

    it('26: revoke mevcut izni atomik olarak siler ve veritabanında satır bırakmaz', async () => {
      const currentVersion = await getPermissionVersion(memberMemId);

      // policy.read iznini kaldıralım (bağımlısı henüz eklenmedi)
      const result = await revokePermission(db, {
        agencyId,
        membershipId: memberMemId,
        permissionCode: 'policy.read',
        expectedPermissionVersion: currentVersion,
      });

      expect(result.permissionCode).toBe('policy.read');
      expect(result.newPermissionVersion).toBe(currentVersion + 1);

      // Doğrudan veritabanı okuması ile satırın kalmadığı kanıtlanır
      const row = await db
        .prepare(
          'SELECT id FROM membership_permissions WHERE membership_id = ? AND permission_code = ?',
        )
        .bind(memberMemId, 'policy.read')
        .first();
      expect(row).toBeNull();
    });

    it('27: kapsam değişikliği (changePermissionScope) doğrudan veritabanı okumasıyla kalıcı olarak doğrulanır', async () => {
      const currentVersion = await getPermissionVersion(memberMemId);

      // customer.read ASSIGNED -> AGENCY olarak güncellenir
      const result = await changePermissionScope(db, {
        agencyId,
        membershipId: memberMemId,
        permissionCode: 'customer.read',
        newScope: 'AGENCY',
        expectedPermissionVersion: currentVersion,
      });

      expect(result.scope).toBe('AGENCY');
      expect(result.newPermissionVersion).toBe(currentVersion + 1);

      // Doğrudan DB okuması ile kapsamın AGENCY olduğu kanıtlanır
      const row = await db
        .prepare(
          'SELECT scope FROM membership_permissions WHERE membership_id = ? AND permission_code = ?',
        )
        .bind(memberMemId, 'customer.read')
        .first<{ scope: string }>();
      expect(row!.scope).toBe('AGENCY');
    });

    it('tanımlı olmayan iznin kaldırılması veya kapsamının değiştirilmesi MembershipPermissionNotFoundError verir', async () => {
      const currentVersion = await getPermissionVersion(memberMemId);

      await expect(
        revokePermission(db, {
          agencyId,
          membershipId: memberMemId,
          permissionCode: 'audit.read', // Hiç verilmemişti
          expectedPermissionVersion: currentVersion,
        }),
      ).rejects.toBeInstanceOf(MembershipPermissionNotFoundError);

      await expect(
        changePermissionScope(db, {
          agencyId,
          membershipId: memberMemId,
          permissionCode: 'document.read', // RECORD_SCOPED ancak üyede tanımlı değil
          newScope: 'AGENCY',
          expectedPermissionVersion: currentVersion,
        }),
      ).rejects.toBeInstanceOf(MembershipPermissionNotFoundError);
    });

    it('28: grant işlemi permission_version değerini tam olarak 1 artırır', async () => {
      const versionBefore = await getPermissionVersion(memberMemId);

      const result = await grantPermission(db, {
        agencyId,
        membershipId: memberMemId,
        permissionCode: 'task.read',
        scope: 'ASSIGNED',
        expectedPermissionVersion: versionBefore,
      });

      const versionAfter = await getPermissionVersion(memberMemId);
      expect(result.newPermissionVersion).toBe(versionBefore + 1);
      expect(versionAfter).toBe(versionBefore + 1);
    });

    it('29: revoke işlemi permission_version değerini tam olarak 1 artırır', async () => {
      const versionBefore = await getPermissionVersion(memberMemId);

      const result = await revokePermission(db, {
        agencyId,
        membershipId: memberMemId,
        permissionCode: 'task.read',
        expectedPermissionVersion: versionBefore,
      });

      const versionAfter = await getPermissionVersion(memberMemId);
      expect(result.newPermissionVersion).toBe(versionBefore + 1);
      expect(versionAfter).toBe(versionBefore + 1);
    });

    it('30: bayat (stale) version işlemi veritabanı assertion yoluyla başarısız olur ve hiçbir mutasyon gerçekleşmez', async () => {
      const currentVersion = await getPermissionVersion(memberMemId);
      const staleVersion = currentVersion - 1;

      // Bayat versiyon ile çağıralım: Ön JS kontrolü kaldırılmıştır; çağrı doğrudan D1 db.batch'e girer,
      // UPDATE 0 satır günceller, d1_cas_assertions trigger'ı ABORT fırlatır ve rollback tetiklenir.
      await expect(
        grantPermission(db, {
          agencyId,
          membershipId: memberMemId,
          permissionCode: 'quote.read',
          scope: 'ASSIGNED',
          expectedPermissionVersion: staleVersion,
        }),
      ).rejects.toBeInstanceOf(OptimisticConcurrencyError);

      // Doğrudan veritabanı durumu kanıtı:
      // 1. Versiyon ASLA değişmemiştir
      const afterVersion = await getPermissionVersion(memberMemId);
      expect(afterVersion).toBe(currentVersion);

      // 2. İzin satırı eklenmemiştir
      const checkRow = await db
        .prepare(
          'SELECT id FROM membership_permissions WHERE membership_id = ? AND permission_code = ?',
        )
        .bind(memberMemId, 'quote.read')
        .first();
      expect(checkRow).toBeNull();

      // 3. d1_cas_assertions tablosu temizdir (rollback edildiği için satır kalmaz)
      const assertions = await db.prepare('SELECT id FROM d1_cas_assertions').all();
      expect(assertions.results).toHaveLength(0);
    });

    it('31: atomiklik kanıtı — başarısız mutasyon ne versiyon artışı ne de yetim izin satırı bırakır (batch rollback)', async () => {
      const currentVersion = await getPermissionVersion(memberMemId);
      const staleVersion = currentVersion - 1;

      // sensitive.identity.read iznini bayat versiyon ile revoke etmeyi deneyelim
      await expect(
        revokePermission(db, {
          agencyId,
          membershipId: memberMemId,
          permissionCode: 'sensitive.identity.read',
          expectedPermissionVersion: staleVersion,
        }),
      ).rejects.toBeInstanceOf(OptimisticConcurrencyError);

      // Atomiklik kanıtı:
      // 1. sensitive.identity.read silinmemiştir (hala veritabanında mevcuttur)
      const stillExisting = await db
        .prepare(
          'SELECT id FROM membership_permissions WHERE membership_id = ? AND permission_code = ?',
        )
        .bind(memberMemId, 'sensitive.identity.read')
        .first();
      expect(stillExisting).not.toBeNull();

      // 2. permission_version artmamıştır
      const afterVersion = await getPermissionVersion(memberMemId);
      expect(afterVersion).toBe(currentVersion);

      // 3. Assertion tablosu temizdir
      const assertions = await db.prepare('SELECT id FROM d1_cas_assertions').all();
      expect(assertions.results).toHaveLength(0);
    });
  });

  // 4. Acente Sınır İzolasyonu (Agency Boundary Protection)
  describe('Acente Sınır İzolasyonu', () => {
    const agencyId = 'boundary-agency';
    const otherAgencyId = 'other-boundary-agency';
    const memberMemId = 'boundary-member-mem';

    beforeAll(async () => {
      await bootstrapActiveAgency('boundary');
      await bootstrapActiveAgency('other-boundary');
      await addActiveMember('boundary', agencyId);
    });

    it('Yanlış agencyId ile grantPermission çağrısı fail-closed olarak MembershipNotFoundError verir', async () => {
      const currentVersion = await getPermissionVersion(memberMemId);
      await expect(
        grantPermission(db, {
          agencyId: otherAgencyId, // Çapraz acente hedefleme
          membershipId: memberMemId,
          permissionCode: 'customer.read',
          scope: 'ASSIGNED',
          expectedPermissionVersion: currentVersion,
        }),
      ).rejects.toBeInstanceOf(MembershipNotFoundError);
    });

    it('Yanlış agencyId ile revokePermission çağrısı fail-closed olarak MembershipNotFoundError verir', async () => {
      const currentVersion = await getPermissionVersion(memberMemId);
      await expect(
        revokePermission(db, {
          agencyId: otherAgencyId,
          membershipId: memberMemId,
          permissionCode: 'customer.read',
          expectedPermissionVersion: currentVersion,
        }),
      ).rejects.toBeInstanceOf(MembershipNotFoundError);
    });

    it('Yanlış agencyId ile changePermissionScope çağrısı fail-closed olarak MembershipNotFoundError verir', async () => {
      const currentVersion = await getPermissionVersion(memberMemId);
      await expect(
        changePermissionScope(db, {
          agencyId: otherAgencyId,
          membershipId: memberMemId,
          permissionCode: 'customer.read',
          newScope: 'AGENCY',
          expectedPermissionVersion: currentVersion,
        }),
      ).rejects.toBeInstanceOf(MembershipNotFoundError);
    });
  });

  // 5. Katalog Bağımlılıkları ve Kapsam Hiyerarşisi Sözleşmesi
  describe('Katalog Bağımlılıkları ve Kapsam Hiyerarşisi', () => {
    const agencyId = 'dep-agency';
    const memberMemId = 'dep-member-mem';
    const ownerMemId = 'dep-owner-mem';

    beforeAll(async () => {
      await bootstrapActiveAgency('dep');
      await addActiveMember('dep', agencyId);
    });

    it('Önkoşul bağımlılığı olmayan izin (customer.update -> customer.read) reddedilir', async () => {
      const currentVersion = await getPermissionVersion(memberMemId);
      await expect(
        grantPermission(db, {
          agencyId,
          membershipId: memberMemId,
          permissionCode: 'customer.update',
          scope: 'ASSIGNED',
          expectedPermissionVersion: currentVersion,
        }),
      ).rejects.toBeInstanceOf(MissingPermissionDependencyError);
    });

    it('Önkoşul bağımlılığı verildikten sonra bağımlı izin verilebilir', async () => {
      let currentVersion = await getPermissionVersion(memberMemId);

      const grantRead = await grantPermission(db, {
        agencyId,
        membershipId: memberMemId,
        permissionCode: 'customer.read',
        scope: 'ASSIGNED',
        expectedPermissionVersion: currentVersion,
      });
      currentVersion = grantRead.newPermissionVersion;

      const grantUpdate = await grantPermission(db, {
        agencyId,
        membershipId: memberMemId,
        permissionCode: 'customer.update',
        scope: 'ASSIGNED',
        expectedPermissionVersion: currentVersion,
      });
      expect(grantUpdate.newPermissionVersion).toBe(currentVersion + 1);
    });

    it('Bağımlı izin önkoşulundan daha geniş kapsama sahip olamaz (scope hierarchy violation)', async () => {
      let currentVersion = await getPermissionVersion(memberMemId);

      const grantPolicyRead = await grantPermission(db, {
        agencyId,
        membershipId: memberMemId,
        permissionCode: 'policy.read',
        scope: 'ASSIGNED',
        expectedPermissionVersion: currentVersion,
      });
      currentVersion = grantPolicyRead.newPermissionVersion;

      // policy.read ASSIGNED iken policy.update AGENCY olamaz!
      await expect(
        grantPermission(db, {
          agencyId,
          membershipId: memberMemId,
          permissionCode: 'policy.update',
          scope: 'AGENCY',
          expectedPermissionVersion: currentVersion,
        }),
      ).rejects.toBeInstanceOf(IncompatibleDependencyScopeError);
    });

    it('Bağımlı izin varken önkoşul izni kaldırılamaz (active dependent blocks revoke)', async () => {
      const currentVersion = await getPermissionVersion(memberMemId);

      // customer.update varken customer.read kaldırılamaz
      await expect(
        revokePermission(db, {
          agencyId,
          membershipId: memberMemId,
          permissionCode: 'customer.read',
          expectedPermissionVersion: currentVersion,
        }),
      ).rejects.toBeInstanceOf(ActivePermissionDependencyError);
    });

    it('Kapsam daraltma bağımlı izin varken engellenir, kapsam genişletme önkoşul dar iken engellenir', async () => {
      let currentVersion = await getPermissionVersion(memberMemId);

      const gRead = await grantPermission(db, {
        agencyId,
        membershipId: memberMemId,
        permissionCode: 'renewal.read',
        scope: 'AGENCY',
        expectedPermissionVersion: currentVersion,
      });
      currentVersion = gRead.newPermissionVersion;

      const gUpdate = await grantPermission(db, {
        agencyId,
        membershipId: memberMemId,
        permissionCode: 'renewal.update',
        scope: 'AGENCY',
        expectedPermissionVersion: currentVersion,
      });
      currentVersion = gUpdate.newPermissionVersion;

      // 1. renewal.read AGENCY -> ASSIGNED daraltılamaz çünkü renewal.update AGENCY
      await expect(
        changePermissionScope(db, {
          agencyId,
          membershipId: memberMemId,
          permissionCode: 'renewal.read',
          newScope: 'ASSIGNED',
          expectedPermissionVersion: currentVersion,
        }),
      ).rejects.toBeInstanceOf(ActivePermissionDependencyError);

      // Önce update daraltılırsa read daraltılabilir
      const cUpdate = await changePermissionScope(db, {
        agencyId,
        membershipId: memberMemId,
        permissionCode: 'renewal.update',
        newScope: 'ASSIGNED',
        expectedPermissionVersion: currentVersion,
      });
      currentVersion = cUpdate.newPermissionVersion;

      const cRead = await changePermissionScope(db, {
        agencyId,
        membershipId: memberMemId,
        permissionCode: 'renewal.read',
        newScope: 'ASSIGNED',
        expectedPermissionVersion: currentVersion,
      });
      currentVersion = cRead.newPermissionVersion;

      // 2. renewal.read ASSIGNED iken update AGENCY genişletilemez
      await expect(
        changePermissionScope(db, {
          agencyId,
          membershipId: memberMemId,
          permissionCode: 'renewal.update',
          newScope: 'AGENCY',
          expectedPermissionVersion: currentVersion,
        }),
      ).rejects.toBeInstanceOf(IncompatibleDependencyScopeError);
    });

    it('OWNER bağımlılık semantiği: Normal bağımlılıklar örtük karşılanır, ancak SENSITIVE write için açık SENSITIVE read zorunludur', async () => {
      let ownerVersion = await getPermissionVersion(ownerMemId);

      // SENSITIVE read olmadan SENSITIVE write verilemez
      await expect(
        grantPermission(db, {
          agencyId,
          membershipId: ownerMemId,
          permissionCode: 'sensitive.identity.write',
          scope: 'UNSCOPED',
          expectedPermissionVersion: ownerVersion,
        }),
      ).rejects.toBeInstanceOf(MissingPermissionDependencyError);

      // SENSITIVE read verildikten sonra SENSITIVE write verilebilir
      const grantRead = await grantPermission(db, {
        agencyId,
        membershipId: ownerMemId,
        permissionCode: 'sensitive.identity.read',
        scope: 'UNSCOPED',
        expectedPermissionVersion: ownerVersion,
      });
      ownerVersion = grantRead.newPermissionVersion;

      const grantWrite = await grantPermission(db, {
        agencyId,
        membershipId: ownerMemId,
        permissionCode: 'sensitive.identity.write',
        scope: 'UNSCOPED',
        expectedPermissionVersion: ownerVersion,
      });
      expect(grantWrite.newPermissionVersion).toBe(ownerVersion + 1);
    });
  });

  // 6. Gerçek Eşzamanlı Yarış (Race-Time CAS) ve d1_cas_assertions Atomiklik Kanıtı
  describe('Gerçek Miniflare D1 Eşzamanlı Yarış (Race-Time CAS) ve Batch Rollback', () => {
    const agencyId = 'race-agency';
    const memberMemId = 'race-member-mem';

    beforeAll(async () => {
      await bootstrapActiveAgency('race');
      await addActiveMember('race', agencyId);
    });

    it('Aynı anda başlatılan iki yarışan grantPermission çağrısından tam olarak biri commit eder, diğeri OptimisticConcurrencyError alır', async () => {
      const startVersion = await getPermissionVersion(memberMemId);

      const call1 = grantPermission(db, {
        agencyId,
        membershipId: memberMemId,
        permissionCode: 'customer.read',
        scope: 'ASSIGNED',
        expectedPermissionVersion: startVersion,
      });

      const call2 = grantPermission(db, {
        agencyId,
        membershipId: memberMemId,
        permissionCode: 'quote.read',
        scope: 'ASSIGNED',
        expectedPermissionVersion: startVersion,
      });

      const results = await Promise.allSettled([call1, call2]);

      const fulfilled = results.filter((r) => r.status === 'fulfilled');
      const rejected = results.filter((r) => r.status === 'rejected');

      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);

      const failureReason = (rejected[0] as PromiseRejectedResult).reason;
      expect(failureReason).toBeInstanceOf(OptimisticConcurrencyError);

      // Veritabanı durumu denetimi:
      // 1. Versiyon tam olarak 1 artmış olmalı (startVersion + 1)
      const finalVersion = await getPermissionVersion(memberMemId);
      expect(finalVersion).toBe(startVersion + 1);

      // 2. membership_permissions tablosuna tam olarak 1 kayıt girmiş olmalı
      const grants = await db
        .prepare('SELECT permission_code FROM membership_permissions WHERE membership_id = ?')
        .bind(memberMemId)
        .all<{ permission_code: string }>();
      expect(grants.results).toHaveLength(1);

      // 3. d1_cas_assertions tablosunda artık kayıt kalmamış olmalı (temizlik tetikleyicisi veya rollback teyidi)
      const assertions = await db.prepare('SELECT id FROM d1_cas_assertions').all();
      expect(assertions.results).toHaveLength(0);
    });
  });

  // 7. M1-T04 Döngü 3 Kabul Testleri: renewal.void Kapsamı ve Bozuk Satır Fail-Closed Denetimi
  describe('M1-T04 Döngü 3: renewal.void Kapsamı ve Bozuk Satır Fail-Closed Denetimi', () => {
    const agencyId = 'cycle3-agency';
    const memberMemId = 'cycle3-member-mem';

    beforeAll(async () => {
      await bootstrapActiveAgency('cycle3');
      await addActiveMember('cycle3', agencyId);
    });

    it('renewal.void: UNSCOPED kapsam reddedilir (InvalidPermissionScopeError), ASSIGNED ve AGENCY kabul edilir, renewal.read kapsam hiyerarşisi zorunludur', async () => {
      let version = await getPermissionVersion(memberMemId);

      // 1. renewal.read olmadan renewal.void verilemez
      await expect(
        grantPermission(db, {
          agencyId,
          membershipId: memberMemId,
          permissionCode: 'renewal.void',
          scope: 'ASSIGNED',
          expectedPermissionVersion: version,
        }),
      ).rejects.toBeInstanceOf(MissingPermissionDependencyError);

      // renewal.read ASSIGNED olarak verilir
      const gRead = await grantPermission(db, {
        agencyId,
        membershipId: memberMemId,
        permissionCode: 'renewal.read',
        scope: 'ASSIGNED',
        expectedPermissionVersion: version,
      });
      version = gRead.newPermissionVersion;

      // 2. renewal.void UNSCOPED verilemez (tahripkar işlemin un-scoped yetki alması fail-closed engellenir)
      await expect(
        grantPermission(db, {
          agencyId,
          membershipId: memberMemId,
          permissionCode: 'renewal.void',
          scope: 'UNSCOPED',
          expectedPermissionVersion: version,
        }),
      ).rejects.toBeInstanceOf(InvalidPermissionScopeError);

      // 3. renewal.read ASSIGNED iken renewal.void AGENCY verilemez (kapsam hiyerarşisi ihlali)
      await expect(
        grantPermission(db, {
          agencyId,
          membershipId: memberMemId,
          permissionCode: 'renewal.void',
          scope: 'AGENCY',
          expectedPermissionVersion: version,
        }),
      ).rejects.toBeInstanceOf(IncompatibleDependencyScopeError);

      // 4. renewal.read ASSIGNED iken renewal.void ASSIGNED olarak başarıyla verilir
      const gVoidAssigned = await grantPermission(db, {
        agencyId,
        membershipId: memberMemId,
        permissionCode: 'renewal.void',
        scope: 'ASSIGNED',
        expectedPermissionVersion: version,
      });
      version = gVoidAssigned.newPermissionVersion;
      expect(gVoidAssigned.scope).toBe('ASSIGNED');

      // 5. renewal.read ASSIGNED iken renewal.void AGENCY'ye genişletilemez
      await expect(
        changePermissionScope(db, {
          agencyId,
          membershipId: memberMemId,
          permissionCode: 'renewal.void',
          newScope: 'AGENCY',
          expectedPermissionVersion: version,
        }),
      ).rejects.toBeInstanceOf(IncompatibleDependencyScopeError);

      // 6. renewal.read AGENCY'ye genişletildikten sonra renewal.void de AGENCY'ye genişletilebilir
      const cReadAgency = await changePermissionScope(db, {
        agencyId,
        membershipId: memberMemId,
        permissionCode: 'renewal.read',
        newScope: 'AGENCY',
        expectedPermissionVersion: version,
      });
      version = cReadAgency.newPermissionVersion;

      const cVoidAgency = await changePermissionScope(db, {
        agencyId,
        membershipId: memberMemId,
        permissionCode: 'renewal.void',
        newScope: 'AGENCY',
        expectedPermissionVersion: version,
      });
      expect(cVoidAgency.newPermissionVersion).toBe(version + 1);

      // Doğrudan veritabanı okuması ile AGENCY doğrulanır
      const row = await db
        .prepare(
          'SELECT scope FROM membership_permissions WHERE membership_id = ? AND permission_code = ?',
        )
        .bind(memberMemId, 'renewal.void')
        .first<{ scope: string }>();
      expect(row?.scope).toBe('AGENCY');
    });

    it('Doğrudan SQL ile eklenmiş bozuk/bağımlılıksız satırda changePermissionScope fail-closed davranır (MissingPermissionDependencyError)', async () => {
      const corruptMemId = 'corrupt-member-mem';
      await addActiveMember('corrupt', agencyId);

      const versionBefore = await getPermissionVersion(corruptMemId);

      // Doğrudan SQL enjeksiyonu: customer.read olmadan doğrudan customer.update (ASSIGNED) eklenir
      const corruptGrantId = crypto.randomUUID();
      await db
        .prepare(
          `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
           VALUES (?, ?, 'customer.update', 'ASSIGNED')`,
        )
        .bind(corruptGrantId, corruptMemId)
        .run();

      // changePermissionScope çağrısı bozuk satırı normalize edemez veya koruyamaz;
      // doğrudan katalog bağımlılığı (customer.read) eksik olduğu için fail-closed olarak MissingPermissionDependencyError fırlatır!
      await expect(
        changePermissionScope(db, {
          agencyId,
          membershipId: corruptMemId,
          permissionCode: 'customer.update',
          newScope: 'AGENCY',
          expectedPermissionVersion: versionBefore,
        }),
      ).rejects.toBeInstanceOf(MissingPermissionDependencyError);

      // Veritabanı durumu kanıtı: satır AGENCY'ye normalize edilmemiştir ve permission_version değişmemiştir
      const row = await db
        .prepare('SELECT scope FROM membership_permissions WHERE id = ?')
        .bind(corruptGrantId)
        .first<{ scope: string }>();
      expect(row?.scope).toBe('ASSIGNED');

      const versionAfter = await getPermissionVersion(corruptMemId);
      expect(versionAfter).toBe(versionBefore);
    });

    it('Doğrudan SQL ile bozuk kapsamlı (ASSIGNED) eklenmiş sensitive.identity.read bağımlılığı grantPermission(write) tarafından yetki sayılamaz ve reddedilir', async () => {
      const depMemberMemId = 'corrupt-dep-member-mem';
      await addActiveMember('corrupt-dep', agencyId);

      const versionBefore = await getPermissionVersion(depMemberMemId);

      // Doğrudan SQL enjeksiyonu: sensitive.identity.read (katalogda UNSCOPED) hatalı biçimde ASSIGNED kapsamıyla eklenir
      const corruptGrantId = crypto.randomUUID();
      await db
        .prepare(
          `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
           VALUES (?, ?, 'sensitive.identity.read', 'ASSIGNED')`,
        )
        .bind(corruptGrantId, depMemberMemId)
        .run();

      // sensitive.identity.write izni, önkoşulu olan sensitive.identity.read satırı yapısal olarak bozuk (ASSIGNED) olduğu için reddedilmelidir!
      await expect(
        grantPermission(db, {
          agencyId,
          membershipId: depMemberMemId,
          permissionCode: 'sensitive.identity.write',
          scope: 'UNSCOPED',
          expectedPermissionVersion: versionBefore,
        }),
      ).rejects.toBeInstanceOf(InvalidPermissionScopeError);

      // Veritabanı durumu kanıtı: write izni eklenmedi, versiyon değişmedi
      const writeRow = await db
        .prepare(
          'SELECT id FROM membership_permissions WHERE membership_id = ? AND permission_code = ?',
        )
        .bind(depMemberMemId, 'sensitive.identity.write')
        .first();
      expect(writeRow).toBeNull();

      const versionAfter = await getPermissionVersion(depMemberMemId);
      expect(versionAfter).toBe(versionBefore);
    });

    it('OWNER üzerinde doğrudan SQL ile eklenmiş NORMAL izin (customer.read) için changePermissionScope reddedilir, revoke ile güvenli temizlik yapılabilir', async () => {
      const ownerMemId = 'cycle3-owner-mem';
      const versionBefore = await getPermissionVersion(ownerMemId);

      // Doğrudan SQL enjeksiyonu: OWNER üyeliğine NORMAL izin (customer.read/ASSIGNED) eklenir
      const corruptGrantId = crypto.randomUUID();
      await db
        .prepare(
          `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
           VALUES (?, ?, 'customer.read', 'ASSIGNED')`,
        )
        .bind(corruptGrantId, ownerMemId)
        .run();

      // 1. changePermissionScope OWNER ve NORMAL izni tespit edip reddetmelidir (OwnerNormalPermissionProhibitedError)
      await expect(
        changePermissionScope(db, {
          agencyId,
          membershipId: ownerMemId,
          permissionCode: 'customer.read',
          newScope: 'AGENCY',
          expectedPermissionVersion: versionBefore,
        }),
      ).rejects.toBeInstanceOf(OwnerNormalPermissionProhibitedError);

      // Veritabanı durumu kanıtı: satır kapsamı değişmedi (hala ASSIGNED), versiyon artmadı
      const corruptRow = await db
        .prepare('SELECT scope FROM membership_permissions WHERE id = ?')
        .bind(corruptGrantId)
        .first<{ scope: string }>();
      expect(corruptRow?.scope).toBe('ASSIGNED');

      const versionAfterFailedScope = await getPermissionVersion(ownerMemId);
      expect(versionAfterFailedScope).toBe(versionBefore);

      // 2. grantPermission da aynı şekilde NORMAL izni reddetmelidir
      await expect(
        grantPermission(db, {
          agencyId,
          membershipId: ownerMemId,
          permissionCode: 'customer.update',
          scope: 'ASSIGNED',
          expectedPermissionVersion: versionBefore,
        }),
      ).rejects.toBeInstanceOf(OwnerNormalPermissionProhibitedError);

      // 3. Güvenli revoke temizliği: RG-00 ile uyumlu olarak bozuk NORMAL satırı revokePermission ile kaldırılabilir
      const revokeResult = await revokePermission(db, {
        agencyId,
        membershipId: ownerMemId,
        permissionCode: 'customer.read',
        expectedPermissionVersion: versionBefore,
      });
      expect(revokeResult.newPermissionVersion).toBe(versionBefore + 1);

      // Satır tamamen silinmiş ve versiyon tam olarak 1 artmış olmalıdır
      const deletedRow = await db
        .prepare('SELECT id FROM membership_permissions WHERE id = ?')
        .bind(corruptGrantId)
        .first();
      expect(deletedRow).toBeNull();

      const versionAfterRevoke = await getPermissionVersion(ownerMemId);
      expect(versionAfterRevoke).toBe(versionBefore + 1);
    });

    it('changePermissionScope ters bağımlılık taramasında bozuk satırı (customer.update/UNSCOPED) yetki saymaz ve fail-closed reddeder', async () => {
      const revMemberMemId = 'corrupt-rev-member-mem';
      await addActiveMember('corrupt-rev', agencyId);

      const currentVersion = await getPermissionVersion(revMemberMemId);

      // 1. customer.read AGENCY olarak verilir
      const gRead = await grantPermission(db, {
        agencyId,
        membershipId: revMemberMemId,
        permissionCode: 'customer.read',
        scope: 'AGENCY',
        expectedPermissionVersion: currentVersion,
      });
      expect(gRead.newPermissionVersion).toBe(currentVersion + 1);

      // 2. Doğrudan SQL ile bağımlı customer.update izni bozuk/hatalı kapsamla (UNSCOPED) eklenir
      const corruptUpdateId = crypto.randomUUID();
      await db
        .prepare(
          `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
           VALUES (?, ?, 'customer.update', 'UNSCOPED')`,
        )
        .bind(corruptUpdateId, revMemberMemId)
        .run();

      const versionBeforeChange = await getPermissionVersion(revMemberMemId);

      // 3. Desteklenen changePermissionScope(customer.read -> ASSIGNED) çağrısı:
      // customer.update katalogda RECORD_SCOPED olduğu için UNSCOPED kapsamı bozuktur.
      // Mevcut açıkta scopeWeight(UNSCOPED)=0 olduğu için daraltma yanlışlıkla başarılı oluyordu.
      // Bu çağrı fail-closed olarak InvalidPermissionScopeError fırlatmalıdır!
      await expect(
        changePermissionScope(db, {
          agencyId,
          membershipId: revMemberMemId,
          permissionCode: 'customer.read',
          newScope: 'ASSIGNED',
          expectedPermissionVersion: versionBeforeChange,
        }),
      ).rejects.toBeInstanceOf(InvalidPermissionScopeError);

      // 4. Veritabanı durumu kanıtı: customer.read kapsamı AGENCY olarak kaldı, versiyon değişmedi
      const readRow = await db
        .prepare(
          'SELECT scope FROM membership_permissions WHERE membership_id = ? AND permission_code = ?',
        )
        .bind(revMemberMemId, 'customer.read')
        .first<{ scope: string }>();
      expect(readRow?.scope).toBe('AGENCY');

      const versionAfterFailedScope = await getPermissionVersion(revMemberMemId);
      expect(versionAfterFailedScope).toBe(versionBeforeChange);

      // 5. Kontrollü revoke temizliği: Bozuk customer.update satırı revokePermission ile güvenle kaldırılabilir
      const revokeUpdateResult = await revokePermission(db, {
        agencyId,
        membershipId: revMemberMemId,
        permissionCode: 'customer.update',
        expectedPermissionVersion: versionBeforeChange,
      });
      expect(revokeUpdateResult.newPermissionVersion).toBe(versionBeforeChange + 1);

      // 6. Bozuk bağımlı kaldırıldıktan sonra customer.read meşru olarak ASSIGNED'a daraltılabilir
      const cleanScopeResult = await changePermissionScope(db, {
        agencyId,
        membershipId: revMemberMemId,
        permissionCode: 'customer.read',
        newScope: 'ASSIGNED',
        expectedPermissionVersion: revokeUpdateResult.newPermissionVersion,
      });
      expect(cleanScopeResult.scope).toBe('ASSIGNED');
    });
  });
});
