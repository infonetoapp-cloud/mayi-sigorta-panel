// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import miniflare from 'miniflare';
import { executeCatalogDomainCommand } from '../src/server/mutations/internal/catalog-domain-executor';
import { OptimisticConcurrencyError } from '../src/server/db/optimistic';
import { IdempotencyConflictError } from '../src/server/mutations/idempotency';
import { getSelectableCatalogs } from '../src/server/catalogs/service';

const { Miniflare, convertV4MiniflareOptions } = miniflare;
const rootDir = resolve(__dirname, '..');

describe('M2-T03 Catalogs & Agency Settings Domain Mutations on Real D1', () => {
  let mf: miniflare.Miniflare;
  let db: D1Database;

  const AGENCY_A = 'ag-t03-dom-a';
  const AGENCY_B = 'ag-t03-dom-b';

  const OWNER_A_USER = 'usr-t03-owner-a';
  const OWNER_A_MEM = 'mem-t03-owner-a';

  const MEMBER_A_USER = 'usr-t03-mem-a';
  const MEMBER_A_MEM = 'mem-t03-mem-a';

  const OWNER_B_USER = 'usr-t03-owner-b';
  const OWNER_B_MEM = 'mem-t03-owner-b';

  beforeAll(async () => {
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: 'export default { fetch() { return new Response(null); } }',
        d1Databases: {
          DB: '00000000-0000-0000-0000-000000000008',
        },
      }),
    );
    db = await mf.getD1Database('DB');

    // Apply migrations 0000-0007 for the current catalog contract.

    for (const file of [
      '0000_good_hammerhead.sql',
      '0001_chunky_blazing_skull.sql',
      '0002_productive_arclight.sql',
      '0003_lonely_zzzax.sql',
      '0004_thankful_pixie.sql',
      '0005_graceful_northstar.sql',
    ]) {
      const sql = readFileSync(resolve(rootDir, 'db/migrations', file), 'utf8');
      const stmts = sql
        .split('--> statement-breakpoint')
        .map((s) => s.trim())
        .filter(Boolean);
      for (const stmt of stmts) {
        await db.prepare(stmt).run();
      }
    }

    // Apply generated current migrations.
    try {
      const { readdirSync } = await import('node:fs');
      const migDir = resolve(rootDir, 'db/migrations');
      const generated = readdirSync(migDir)
        .filter((file) => /^000[67]_.*\.sql$/.test(file))
        .sort();
      for (const file of generated) {
        const sql = readFileSync(resolve(migDir, file), 'utf8');
        const stmts = sql
          .split('--> statement-breakpoint')
          .map((s) => s.trim())
          .filter(Boolean);
        for (const stmt of stmts) {
          await db.prepare(stmt).run();
        }
      }
    } catch {
      // Generated migration absent: focused tests will fail at the affected contract.
    }

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

    await seedAgency(AGENCY_A, OWNER_A_USER, OWNER_A_MEM, 'owner-a@test.com');
    await seedAgency(AGENCY_B, OWNER_B_USER, OWNER_B_MEM, 'owner-b@test.com');

    // Add member in Agency A with catalog.manage and agency.settings.manage
    await db
      .prepare("INSERT INTO users (id, status, version) VALUES (?, 'ACTIVE', 1)")
      .bind(MEMBER_A_USER)
      .run();
    await db
      .prepare(
        `INSERT INTO agency_memberships (
           id, agency_id, user_id, type, status, invitation_email, invitation_expires_at,
           activated_at, version, permission_version
         ) VALUES (?, ?, ?, 'MEMBER', 'ACTIVE', 'mem-a@test.com', '2099-01-01T00:00:00.000Z',
           '2026-09-17T00:00:00.000Z', 1, 1)`,
      )
      .bind(MEMBER_A_MEM, AGENCY_A, MEMBER_A_USER)
      .run();
    await db
      .prepare(
        `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
         VALUES (?, ?, 'https://test', ?, 'mem-a@test.com', 'ACTIVE')`,
      )
      .bind(`ident-${MEMBER_A_USER}`, MEMBER_A_USER, `sub-${MEMBER_A_USER}`)
      .run();

    await db
      .prepare(
        `INSERT INTO membership_permissions (id, membership_id, permission_code, scope)
         VALUES (?, ?, 'catalog.manage', 'UNSCOPED'), (?, ?, 'agency.settings.manage', 'UNSCOPED')`,
      )
      .bind('perm-cat-manage', MEMBER_A_MEM, 'perm-sett-manage', MEMBER_A_MEM)
      .run();
  });

  afterAll(async () => {
    if (mf) await mf.dispose();
  });

  describe('DATABASE & ISOLATION: Unique code per agency & cross-agency rejection', () => {
    it('creates insurer with semantic code, allows same code in different agency, rejects duplicate in same agency', async () => {
      const insId1 = 'ins-dom-1';
      const res1 = await executeCatalogDomainCommand({
        db,
        agencyId: AGENCY_A,
        actorUserId: OWNER_A_USER,
        actorMembershipId: OWNER_A_MEM,
        expectedPermissionVersion: 2,
        correlationId: 'corr-1',
        idempotencyKey: 'idemp-ins-1',
        payload: { code: 'ANADOLU', name: 'Anadolu Sigorta' },
        command: {
          kind: 'insurer.create',
          insurerId: insId1,
          code: 'ANADOLU',
          name: 'Anadolu Sigorta',
        },
        resultProducer: () => ({ status: 201, body: { id: insId1, code: 'ANADOLU' } }),
      });
      expect(res1.status).toBe(201);
      expect(res1.executed).toBe(true);

      // Same code ANADOLU in AGENCY_B must succeed
      const insIdB = 'ins-dom-b1';
      const resB = await executeCatalogDomainCommand({
        db,
        agencyId: AGENCY_B,
        actorUserId: OWNER_B_USER,
        actorMembershipId: OWNER_B_MEM,
        expectedPermissionVersion: 2,
        correlationId: 'corr-b1',
        idempotencyKey: 'idemp-ins-b1',
        payload: { code: 'ANADOLU', name: 'Anadolu Sigorta B' },
        command: {
          kind: 'insurer.create',
          insurerId: insIdB,
          code: 'ANADOLU',
          name: 'Anadolu Sigorta B',
        },
        resultProducer: () => ({ status: 201, body: { id: insIdB, code: 'ANADOLU' } }),
      });
      expect(resB.status).toBe(201);

      // Duplicate code ANADOLU in AGENCY_A must fail
      const insIdDup = 'ins-dom-dup';
      await expect(
        executeCatalogDomainCommand({
          db,
          agencyId: AGENCY_A,
          actorUserId: OWNER_A_USER,
          actorMembershipId: OWNER_A_MEM,
          expectedPermissionVersion: 2,
          correlationId: 'corr-dup',
          idempotencyKey: 'idemp-ins-dup',
          payload: { code: 'ANADOLU', name: 'Duplicate Anadolu' },
          command: {
            kind: 'insurer.create',
            insurerId: insIdDup,
            code: 'ANADOLU',
            name: 'Duplicate Anadolu',
          },
          resultProducer: () => ({ status: 201, body: { id: insIdDup } }),
        }),
      ).rejects.toThrow();
    });

    it('rejects cross-agency insurer and branch when creating insurance product', async () => {
      // Create branch in Agency A
      const brIdA = 'br-dom-a1';
      await executeCatalogDomainCommand({
        db,
        agencyId: AGENCY_A,
        actorUserId: OWNER_A_USER,
        actorMembershipId: OWNER_A_MEM,
        expectedPermissionVersion: 2,
        correlationId: 'corr-br-1',
        idempotencyKey: 'idemp-br-1',
        payload: { code: 'KASKO', name: 'Kasko Sigortası' },
        command: {
          kind: 'branch.create',
          branchId: brIdA,
          code: 'KASKO',
          name: 'Kasko Sigortası',
        },
        resultProducer: () => ({ status: 201, body: { id: brIdA } }),
      });

      // Try creating product in Agency A with Insurer from Agency B (insIdB) -> MUST FAIL
      const prodIdCrossIns = 'prod-cross-ins';
      await expect(
        executeCatalogDomainCommand({
          db,
          agencyId: AGENCY_A,
          actorUserId: OWNER_A_USER,
          actorMembershipId: OWNER_A_MEM,
          expectedPermissionVersion: 2,
          correlationId: 'corr-prod-cross1',
          idempotencyKey: 'idemp-prod-cross1',
          payload: {
            insurerId: 'ins-dom-b1', // From Agency B!
            branchId: brIdA,
            code: 'KASKO_GENIS',
            name: 'Genişletilmiş Kasko',
          },
          command: {
            kind: 'product.create',
            productId: prodIdCrossIns,
            insurerId: 'ins-dom-b1',
            branchId: brIdA,
            code: 'KASKO_GENIS',
            name: 'Genişletilmiş Kasko',
          },
          resultProducer: () => ({ status: 201, body: { id: prodIdCrossIns } }),
        }),
      ).rejects.toThrow();
    });

    it('rejects cross-agency default insurer when configuring agency settings', async () => {
      // Agency A settings cannot point to Agency B insurer
      const settIdA = 'sett-dom-a';
      await expect(
        executeCatalogDomainCommand({
          db,
          agencyId: AGENCY_A,
          actorUserId: OWNER_A_USER,
          actorMembershipId: OWNER_A_MEM,
          expectedPermissionVersion: 2,
          correlationId: 'corr-sett-cross',
          idempotencyKey: 'idemp-sett-cross',
          payload: { defaultInsurerId: 'ins-dom-b1' }, // Agency B insurer!
          command: {
            kind: 'agency_settings.update_operations',
            settingsId: settIdA,
            expectedVersion: 1,
            defaultInsurerId: 'ins-dom-b1',
            changedFields: ['defaultInsurerId'],
          },
          resultProducer: () => ({ status: 200, body: { success: true } }),
        }),
      ).rejects.toThrow();
    });
  });

  describe('DEFAULT INSURER INVARIANTS: active default, deactivation prevention & atomic switch', () => {
    it('sets active default insurer; prevents deactivating current default; executes atomic switch + old deactivation', async () => {
      // Create two insurers in Agency A: Anadolu (ins-dom-1) and Allianz (ins-dom-allianz)
      const insAllianz = 'ins-dom-allianz';
      await executeCatalogDomainCommand({
        db,
        agencyId: AGENCY_A,
        actorUserId: OWNER_A_USER,
        actorMembershipId: OWNER_A_MEM,
        expectedPermissionVersion: 2,
        correlationId: 'corr-allianz',
        idempotencyKey: 'idemp-allianz',
        payload: { code: 'ALLIANZ', name: 'Allianz Sigorta' },
        command: {
          kind: 'insurer.create',
          insurerId: insAllianz,
          code: 'ALLIANZ',
          name: 'Allianz Sigorta',
        },
        resultProducer: () => ({ status: 201, body: { id: insAllianz } }),
      });

      // Ensure agency settings exists for Agency A
      const settingsId = 'sett-dom-a';
      await executeCatalogDomainCommand({
        db,
        agencyId: AGENCY_A,
        actorUserId: OWNER_A_USER,
        actorMembershipId: OWNER_A_MEM,
        expectedPermissionVersion: 2,
        correlationId: 'corr-seed-sett',
        idempotencyKey: 'idemp-seed-sett',
        payload: { defaultInsurerId: 'ins-dom-1' },
        command: {
          kind: 'agency_settings.update_operations',
          settingsId,
          expectedVersion: 1,
          defaultInsurerId: 'ins-dom-1',
          changedFields: ['defaultInsurerId'],
        },
        resultProducer: () => ({ status: 200, body: { defaultInsurerId: 'ins-dom-1' } }),
      });

      // 1. Current default is ins-dom-1. Trying to deactivate ins-dom-1 directly MUST FAIL!
      await expect(
        executeCatalogDomainCommand({
          db,
          agencyId: AGENCY_A,
          actorUserId: OWNER_A_USER,
          actorMembershipId: OWNER_A_MEM,
          expectedPermissionVersion: 2,
          correlationId: 'corr-deact-fail',
          idempotencyKey: 'idemp-deact-fail',
          payload: { insurerId: 'ins-dom-1', expectedVersion: 1 },
          command: {
            kind: 'insurer.deactivate',
            insurerId: 'ins-dom-1',
            expectedVersion: 1,
          },
          resultProducer: () => ({ status: 200, body: { deactivated: true } }),
        }),
      ).rejects.toThrow(/varsayılan|default/i);

      // Verify ins-dom-1 is still ACTIVE
      const currentIns = await db
        .prepare('SELECT status FROM insurers WHERE id = ?')
        .bind('ins-dom-1')
        .first<{ status: string }>();
      expect(currentIns?.status).toBe('ACTIVE');

      // 2. Cannot set an INACTIVE insurer as default!
      // Create a third insurer and deactivate it
      const insAxa = 'ins-dom-axa';
      await executeCatalogDomainCommand({
        db,
        agencyId: AGENCY_A,
        actorUserId: OWNER_A_USER,
        actorMembershipId: OWNER_A_MEM,
        expectedPermissionVersion: 2,
        correlationId: 'corr-axa-create',
        idempotencyKey: 'idemp-axa-create',
        payload: { code: 'AXA', name: 'Axa Sigorta' },
        command: {
          kind: 'insurer.create',
          insurerId: insAxa,
          code: 'AXA',
          name: 'Axa Sigorta',
        },
        resultProducer: () => ({ status: 201, body: { id: insAxa } }),
      });
      await executeCatalogDomainCommand({
        db,
        agencyId: AGENCY_A,
        actorUserId: OWNER_A_USER,
        actorMembershipId: OWNER_A_MEM,
        expectedPermissionVersion: 2,
        correlationId: 'corr-axa-deact',
        idempotencyKey: 'idemp-axa-deact',
        payload: { insurerId: insAxa, expectedVersion: 1 },
        command: {
          kind: 'insurer.deactivate',
          insurerId: insAxa,
          expectedVersion: 1,
        },
        resultProducer: () => ({ status: 200, body: { deactivated: true } }),
      });

      // Try setting inactive AXA as default insurer -> MUST FAIL
      await expect(
        executeCatalogDomainCommand({
          db,
          agencyId: AGENCY_A,
          actorUserId: OWNER_A_USER,
          actorMembershipId: OWNER_A_MEM,
          expectedPermissionVersion: 2,
          correlationId: 'corr-sett-inactive',
          idempotencyKey: 'idemp-sett-inactive',
          payload: { defaultInsurerId: insAxa },
          command: {
            kind: 'agency_settings.update_operations',
            settingsId,
            expectedVersion: 2,
            defaultInsurerId: insAxa,
            changedFields: ['defaultInsurerId'],
          },
          resultProducer: () => ({ status: 200, body: { defaultInsurerId: insAxa } }),
        }),
      ).rejects.toThrow();

      // 3. Explicit atomic command: change default to Allianz AND deactivate old default (Anadolu)
      const resAtomic = await executeCatalogDomainCommand({
        db,
        agencyId: AGENCY_A,
        actorUserId: OWNER_A_USER,
        actorMembershipId: OWNER_A_MEM,
        expectedPermissionVersion: 2,
        correlationId: 'corr-atomic-switch',
        idempotencyKey: 'idemp-atomic-switch',
        payload: {
          defaultInsurerId: insAllianz,
          deactivateOldDefault: true,
          expectedVersion: 2,
        },
        command: {
          kind: 'agency_settings.update_operations',
          settingsId,
          expectedVersion: 2,
          defaultInsurerId: insAllianz,
          deactivateOldDefault: true,
          oldDefaultInsurerId: 'ins-dom-1',
          changedFields: ['defaultInsurerId', 'deactivateOldDefault'],
        },
        resultProducer: () => ({
          status: 200,
          body: {
            defaultInsurerId: insAllianz,
            oldDefaultDeactivated: true,
          },
        }),
      });
      expect(resAtomic.status).toBe(200);

      // Verify in DB: default is now Allianz, and old Anadolu is INACTIVE
      const settRow = await db
        .prepare('SELECT default_insurer_id FROM agency_settings WHERE agency_id = ?')
        .bind(AGENCY_A)
        .first<{ default_insurer_id: string }>();
      expect(settRow?.default_insurer_id).toBe(insAllianz);

      const oldInsRow = await db
        .prepare('SELECT status FROM insurers WHERE id = ?')
        .bind('ins-dom-1')
        .first<{ status: string }>();
      expect(oldInsRow?.status).toBe('INACTIVE');

      // 4. Inactive historical row is still readable by ID
      const historicalRow = await db
        .prepare('SELECT id, code, name, status FROM insurers WHERE id = ? AND agency_id = ?')
        .bind('ins-dom-1', AGENCY_A)
        .first<{ id: string; code: string; name: string; status: string }>();
      expect(historicalRow).toBeDefined();
      expect(historicalRow?.code).toBe('ANADOLU');
      expect(historicalRow?.status).toBe('INACTIVE');
    });
  });

  describe('MUTATION & IDEMPOTENCY: CAS, replay, conflict, audit rollback', () => {
    it('exact create replay returns cached result with single business row and single audit', async () => {
      const pmId = 'pm-replay-1';
      const key = 'idemp-pm-replay';
      const payload = { code: 'CREDIT_CARD', name: 'Kredi Kartı' };

      const res1 = await executeCatalogDomainCommand({
        db,
        agencyId: AGENCY_A,
        actorUserId: OWNER_A_USER,
        actorMembershipId: OWNER_A_MEM,
        expectedPermissionVersion: 2,
        correlationId: 'corr-pm-1',
        idempotencyKey: key,
        payload,
        command: {
          kind: 'payment_method.create',
          paymentMethodId: pmId,
          code: 'CREDIT_CARD',
          name: 'Kredi Kartı',
        },
        resultProducer: () => ({ status: 201, body: { id: pmId, code: 'CREDIT_CARD' } }),
      });
      expect(res1.status).toBe(201);
      expect(res1.executed).toBe(true);
      expect(res1.replayed).toBe(false);

      // Replay with exact same key and payload
      const res2 = await executeCatalogDomainCommand({
        db,
        agencyId: AGENCY_A,
        actorUserId: OWNER_A_USER,
        actorMembershipId: OWNER_A_MEM,
        expectedPermissionVersion: 2,
        correlationId: 'corr-pm-2',
        idempotencyKey: key,
        payload,
        command: {
          kind: 'payment_method.create',
          paymentMethodId: pmId,
          code: 'CREDIT_CARD',
          name: 'Kredi Kartı',
        },
        resultProducer: () => ({ status: 201, body: { id: pmId, code: 'CREDIT_CARD' } }),
      });
      expect(res2.status).toBe(201);
      expect(res2.executed).toBe(false);
      expect(res2.replayed).toBe(true);

      // Check DB: exactly 1 payment method and 1 audit event
      const countPm = await db
        .prepare('SELECT count(*) as cnt FROM payment_methods WHERE id = ?')
        .bind(pmId)
        .first<{ cnt: number }>();
      expect(countPm?.cnt).toBe(1);

      const countAudit = await db
        .prepare(
          "SELECT count(*) as cnt FROM audit_events WHERE idempotency_key = ? AND action = 'catalog.payment_method.create'",
        )
        .bind(key)
        .first<{ cnt: number }>();
      expect(countAudit?.cnt).toBe(1);
    });

    it('rejects same idempotency key with different payload', async () => {
      const key = 'idemp-pm-replay'; // already used with CREDIT_CARD
      await expect(
        executeCatalogDomainCommand({
          db,
          agencyId: AGENCY_A,
          actorUserId: OWNER_A_USER,
          actorMembershipId: OWNER_A_MEM,
          expectedPermissionVersion: 2,
          correlationId: 'corr-diff',
          idempotencyKey: key,
          payload: { code: 'BANK_TRANSFER', name: 'Havale' }, // DIFFERENT PAYLOAD
          command: {
            kind: 'payment_method.create',
            paymentMethodId: 'pm-different',
            code: 'BANK_TRANSFER',
            name: 'Havale',
          },
          resultProducer: () => ({ status: 201, body: { id: 'pm-different' } }),
        }),
      ).rejects.toThrow(IdempotencyConflictError);
    });

    it('stale expectedVersion triggers OPTIMISTIC_CONCURRENCY_CONFLICT', async () => {
      const lrId = 'lr-dom-cas';
      await executeCatalogDomainCommand({
        db,
        agencyId: AGENCY_A,
        actorUserId: OWNER_A_USER,
        actorMembershipId: OWNER_A_MEM,
        expectedPermissionVersion: 2,
        correlationId: 'corr-lr-1',
        idempotencyKey: 'idemp-lr-1',
        payload: { code: 'PRICE_HIGH', name: 'Fiyat Yüksek' },
        command: {
          kind: 'loss_reason.create',
          lossReasonId: lrId,
          code: 'PRICE_HIGH',
          name: 'Fiyat Yüksek',
        },
        resultProducer: () => ({ status: 201, body: { id: lrId } }),
      });

      // lrId is version 1. Try updating with expectedVersion = 99
      await expect(
        executeCatalogDomainCommand({
          db,
          agencyId: AGENCY_A,
          actorUserId: OWNER_A_USER,
          actorMembershipId: OWNER_A_MEM,
          expectedPermissionVersion: 2,
          correlationId: 'corr-lr-stale',
          idempotencyKey: 'idemp-lr-stale',
          payload: { name: 'Fiyat Aşırı Yüksek', expectedVersion: 99 },
          command: {
            kind: 'loss_reason.update',
            lossReasonId: lrId,
            expectedVersion: 99,
            name: 'Fiyat Aşırı Yüksek',
            changedFields: ['name'],
          },
          resultProducer: () => ({ status: 200, body: { id: lrId } }),
        }),
      ).rejects.toThrow(OptimisticConcurrencyError);
    });

    it('allows at most one business effect and audit for concurrent duplicate semantic-code creates', async () => {
      const attempts = ['lr-concurrent-a', 'lr-concurrent-b'].map((lossReasonId, index) =>
        executeCatalogDomainCommand({
          db,
          agencyId: AGENCY_A,
          actorUserId: OWNER_A_USER,
          actorMembershipId: OWNER_A_MEM,
          expectedPermissionVersion: 2,
          correlationId: `corr-concurrent-${index}`,
          idempotencyKey: `idemp-concurrent-${index}`,
          payload: { code: 'CONCURRENT_DUP', name: `Concurrent ${index}` },
          command: {
            kind: 'loss_reason.create' as const,
            lossReasonId,
            code: 'CONCURRENT_DUP',
            name: `Concurrent ${index}`,
          },
          resultProducer: () => ({ status: 201, body: { id: lossReasonId } }),
        }),
      );

      const settled = await Promise.allSettled(attempts);
      expect(settled.filter((result) => result.status === 'fulfilled')).toHaveLength(1);

      const rows = await db
        .prepare(
          "SELECT count(*) AS count FROM loss_reasons WHERE agency_id = ? AND code = 'CONCURRENT_DUP'",
        )
        .bind(AGENCY_A)
        .first<{ count: number }>();
      expect(rows?.count).toBe(1);

      const audits = await db
        .prepare(
          `SELECT count(*) AS count FROM audit_events
           WHERE agency_id = ? AND action = 'catalog.loss_reason.create'
             AND target_id IN ('lr-concurrent-a', 'lr-concurrent-b')`,
        )
        .bind(AGENCY_A)
        .first<{ count: number }>();
      expect(audits?.count).toBe(1);
    });

    it('rolls back business effect and receipt when audit persistence fails', async () => {
      const idempotencyKey = 'idemp-audit-rollback';
      await db
        .prepare(
          `CREATE TRIGGER t03_force_audit_failure
           BEFORE INSERT ON audit_events
           WHEN NEW.idempotency_key = '${idempotencyKey}'
           BEGIN
             SELECT RAISE(ABORT, 'FORCED_AUDIT_FAILURE');
           END`,
        )
        .run();

      try {
        await expect(
          executeCatalogDomainCommand({
            db,
            agencyId: AGENCY_A,
            actorUserId: OWNER_A_USER,
            actorMembershipId: OWNER_A_MEM,
            expectedPermissionVersion: 2,
            correlationId: 'corr-audit-rollback',
            idempotencyKey,
            payload: { code: 'AUDIT_ROLLBACK', name: 'Audit Rollback' },
            command: {
              kind: 'loss_reason.create',
              lossReasonId: 'lr-audit-rollback',
              code: 'AUDIT_ROLLBACK',
              name: 'Audit Rollback',
            },
            resultProducer: () => ({ status: 201, body: { id: 'lr-audit-rollback' } }),
          }),
        ).rejects.toThrow(/FORCED_AUDIT_FAILURE/);
      } finally {
        await db.prepare('DROP TRIGGER IF EXISTS t03_force_audit_failure').run();
      }

      const business = await db
        .prepare("SELECT count(*) AS count FROM loss_reasons WHERE id = 'lr-audit-rollback'")
        .first<{ count: number }>();
      const receipt = await db
        .prepare('SELECT count(*) AS count FROM operation_receipts WHERE idempotency_key = ?')
        .bind(idempotencyKey)
        .first<{ count: number }>();
      const audit = await db
        .prepare('SELECT count(*) AS count FROM audit_events WHERE idempotency_key = ?')
        .bind(idempotencyKey)
        .first<{ count: number }>();
      expect(business?.count).toBe(0);
      expect(receipt?.count).toBe(0);
      expect(audit?.count).toBe(0);
    });
  });

  describe('DEFAULT INSURER RACE ATOMICITY', () => {
    it('serializes competing default transitions without deactivating the insurer retained as default', async () => {
      const oldId = 'ins-race-old';
      const newAId = 'ins-race-new-a';
      const newBId = 'ins-race-new-b';

      for (const [insurerId, code] of [
        [oldId, 'RACE_OLD'],
        [newAId, 'RACE_NEW_A'],
        [newBId, 'RACE_NEW_B'],
      ] as const) {
        await executeCatalogDomainCommand({
          db,
          agencyId: AGENCY_B,
          actorUserId: OWNER_B_USER,
          actorMembershipId: OWNER_B_MEM,
          expectedPermissionVersion: 2,
          correlationId: `corr-${code}`,
          idempotencyKey: `idemp-${code}`,
          payload: { code, name: code },
          command: { kind: 'insurer.create', insurerId, code, name: code },
          resultProducer: () => ({ status: 201, body: { id: insurerId } }),
        });
      }

      await executeCatalogDomainCommand({
        db,
        agencyId: AGENCY_B,
        actorUserId: OWNER_B_USER,
        actorMembershipId: OWNER_B_MEM,
        expectedPermissionVersion: 2,
        correlationId: 'corr-race-settings-seed',
        idempotencyKey: 'idemp-race-settings-seed',
        payload: { defaultInsurerId: oldId, expectedVersion: 1 },
        command: {
          kind: 'agency_settings.update_operations',
          settingsId: 'settings-race-b',
          expectedVersion: 1,
          defaultInsurerId: oldId,
          changedFields: ['defaultInsurerId'],
        },
        resultProducer: () => ({ status: 200, body: { defaultInsurerId: oldId } }),
      });

      const race = await Promise.allSettled([
        executeCatalogDomainCommand({
          db,
          agencyId: AGENCY_B,
          actorUserId: OWNER_B_USER,
          actorMembershipId: OWNER_B_MEM,
          expectedPermissionVersion: 2,
          correlationId: 'corr-race-atomic',
          idempotencyKey: 'idemp-race-atomic',
          payload: { defaultInsurerId: newAId, deactivateOldDefault: true, expectedVersion: 2 },
          command: {
            kind: 'agency_settings.update_operations',
            settingsId: 'settings-race-b',
            expectedVersion: 2,
            defaultInsurerId: newAId,
            deactivateOldDefault: true,
            oldDefaultInsurerId: oldId,
            changedFields: ['defaultInsurerId', 'deactivateOldDefault'],
          },
          resultProducer: () => ({ status: 200, body: { defaultInsurerId: newAId } }),
        }),
        executeCatalogDomainCommand({
          db,
          agencyId: AGENCY_B,
          actorUserId: OWNER_B_USER,
          actorMembershipId: OWNER_B_MEM,
          expectedPermissionVersion: 2,
          correlationId: 'corr-race-competitor',
          idempotencyKey: 'idemp-race-competitor',
          payload: { defaultInsurerId: newBId, expectedVersion: 2 },
          command: {
            kind: 'agency_settings.update_operations',
            settingsId: 'settings-race-b',
            expectedVersion: 2,
            defaultInsurerId: newBId,
            changedFields: ['defaultInsurerId'],
          },
          resultProducer: () => ({ status: 200, body: { defaultInsurerId: newBId } }),
        }),
      ]);
      expect(race.filter((result) => result.status === 'fulfilled')).toHaveLength(1);

      const settings = await db
        .prepare('SELECT default_insurer_id FROM agency_settings WHERE agency_id = ?')
        .bind(AGENCY_B)
        .first<{ default_insurer_id: string }>();
      const selected = await db
        .prepare('SELECT status FROM insurers WHERE agency_id = ? AND id = ?')
        .bind(AGENCY_B, settings?.default_insurer_id)
        .first<{ status: string }>();
      const old = await db
        .prepare('SELECT status FROM insurers WHERE agency_id = ? AND id = ?')
        .bind(AGENCY_B, oldId)
        .first<{ status: string }>();

      expect(selected?.status).toBe('ACTIVE');
      expect(old?.status).toBe(settings?.default_insurer_id === newAId ? 'INACTIVE' : 'ACTIVE');

      const successAudits = await db
        .prepare(
          `SELECT count(*) AS count FROM audit_events
           WHERE idempotency_key IN ('idemp-race-atomic', 'idemp-race-competitor')`,
        )
        .first<{ count: number }>();
      expect(successAudits?.count).toBe(1);
    });
  });

  describe('SELECTABLE PARENT LIFECYCLE INVARIANTS', () => {
    it('blocks products with inactive parents at the DB boundary and excludes existing products from selectable values', async () => {
      const insurerId = 'ins-parent-guard';
      const branchId = 'branch-parent-guard';
      const productId = 'product-parent-guard';

      await executeCatalogDomainCommand({
        db,
        agencyId: AGENCY_A,
        actorUserId: OWNER_A_USER,
        actorMembershipId: OWNER_A_MEM,
        expectedPermissionVersion: 2,
        correlationId: 'corr-parent-insurer',
        idempotencyKey: 'idemp-parent-insurer',
        payload: { code: 'PARENT_GUARD_INS', name: 'Parent Guard Insurer' },
        command: {
          kind: 'insurer.create',
          insurerId,
          code: 'PARENT_GUARD_INS',
          name: 'Parent Guard Insurer',
        },
        resultProducer: () => ({ status: 201, body: { id: insurerId } }),
      });
      await executeCatalogDomainCommand({
        db,
        agencyId: AGENCY_A,
        actorUserId: OWNER_A_USER,
        actorMembershipId: OWNER_A_MEM,
        expectedPermissionVersion: 2,
        correlationId: 'corr-parent-branch',
        idempotencyKey: 'idemp-parent-branch',
        payload: { code: 'PARENT_GUARD_BRANCH', name: 'Parent Guard Branch' },
        command: {
          kind: 'branch.create',
          branchId,
          code: 'PARENT_GUARD_BRANCH',
          name: 'Parent Guard Branch',
        },
        resultProducer: () => ({ status: 201, body: { id: branchId } }),
      });
      await executeCatalogDomainCommand({
        db,
        agencyId: AGENCY_A,
        actorUserId: OWNER_A_USER,
        actorMembershipId: OWNER_A_MEM,
        expectedPermissionVersion: 2,
        correlationId: 'corr-parent-product',
        idempotencyKey: 'idemp-parent-product',
        payload: {
          insurerId,
          branchId,
          code: 'PARENT_GUARD_PRODUCT',
          name: 'Parent Guard Product',
        },
        command: {
          kind: 'product.create',
          productId,
          insurerId,
          branchId,
          code: 'PARENT_GUARD_PRODUCT',
          name: 'Parent Guard Product',
        },
        resultProducer: () => ({ status: 201, body: { id: productId } }),
      });
      await executeCatalogDomainCommand({
        db,
        agencyId: AGENCY_A,
        actorUserId: OWNER_A_USER,
        actorMembershipId: OWNER_A_MEM,
        expectedPermissionVersion: 2,
        correlationId: 'corr-parent-deactivate',
        idempotencyKey: 'idemp-parent-deactivate',
        payload: { insurerId, expectedVersion: 1 },
        command: { kind: 'insurer.deactivate', insurerId, expectedVersion: 1 },
        resultProducer: () => ({ status: 200, body: { id: insurerId } }),
      });

      await expect(
        db
          .prepare(
            `INSERT INTO insurance_products
               (id, agency_id, insurer_id, branch_id, code, name, status, version)
             VALUES (?, ?, ?, ?, ?, ?, 'ACTIVE', 1)`,
          )
          .bind(
            'product-inactive-parent-rejected',
            AGENCY_A,
            insurerId,
            branchId,
            'INACTIVE_PARENT_REJECTED',
            'Inactive Parent Rejected',
          )
          .run(),
      ).rejects.toThrow();

      const selectable = await getSelectableCatalogs(
        {
          userId: OWNER_A_USER,
          identityId: `ident-${OWNER_A_USER}`,
          assurance: 'NORMAL',
          memberships: [
            {
              id: OWNER_A_MEM,
              agencyId: AGENCY_A,
              type: 'OWNER',
              status: 'ACTIVE',
              permissionVersion: 2,
            },
          ],
        },
        db,
      );
      expect(selectable.products.some((product) => product.id === productId)).toBe(false);
    });
  });
});
