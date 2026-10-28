// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { execSync } from 'node:child_process';
import miniflare from 'miniflare';

const { Miniflare, convertV4MiniflareOptions } = miniflare;
const rootDir = resolve(__dirname, '..');

describe('M2-T01 Migration 0004 & Database Invariant Verification', () => {
  let mf: miniflare.Miniflare;
  let db: D1Database;

  const HISTORICAL_HASHES: Record<string, string> = {
    '0000_good_hammerhead.sql': 'de803e199abed34fa71fde797260d7545367b979f9d09cac886826e4e3f95a5d',
    '0001_chunky_blazing_skull.sql':
      'd79c8922324764f154315f9888d7bd0765f3475d7b39f02b363f60f59366b48b',
    '0002_productive_arclight.sql':
      '3eb6b49de885c929cb2eb5d289241bd34956827f7d9d2d354d428a934df57a5f',
    '0003_lonely_zzzax.sql': '1a5f075b522724aedf0c51d19aed090ca9727c53bd43ef64e4517b69ad1de8a3',
  };

  beforeAll(async () => {
    mf = new Miniflare(
      convertV4MiniflareOptions({
        modules: true,
        script: 'export default { fetch() { return new Response(null); } }',
        d1Databases: {
          DB: '00000000-0000-0000-0000-000000000003',
        },
      }),
    );
    db = await mf.getD1Database('DB');
  });

  afterAll(async () => {
    if (mf) {
      await mf.dispose();
    }
  });

  // 1. Historical migrations 0000-0003 are strictly unchanged
  it('verifies historical 0000-0003 migrations are unchanged (exact SHA-256 hash preservation)', () => {
    for (const [filename, expectedHash] of Object.entries(HISTORICAL_HASHES)) {
      const filePath = resolve(rootDir, 'db/migrations', filename);
      const content = readFileSync(filePath);
      const actualHash = createHash('sha256').update(content).digest('hex');
      expect(actualHash).toBe(expectedHash);
    }
  });

  // 2. 0003 -> 0004 upgrade preserves seed, clean apply, rerun/no-op
  it('applies 0000-0003, seeds data, cleanly upgrades to 0004 preserving seed, and verifies rerun/no-op', async () => {
    // A. Apply 0000-0003
    for (const file of [
      'db/migrations/0000_good_hammerhead.sql',
      'db/migrations/0001_chunky_blazing_skull.sql',
      'db/migrations/0002_productive_arclight.sql',
      'db/migrations/0003_lonely_zzzax.sql',
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

    // B. Seed Agency and Membership in 0003 state
    await db
      .prepare("INSERT INTO agencies (id, status, version) VALUES ('ag-mig-1', 'PROVISIONING', 1)")
      .run();
    await db
      .prepare("INSERT INTO users (id, status, version) VALUES ('usr-mig-1', 'INACTIVE', 1)")
      .run();
    await db
      .prepare(
        `
      INSERT INTO agency_memberships (
        id, agency_id, user_id, type, status, invitation_email, invitation_expires_at, version, permission_version
      ) VALUES ('mem-mig-1', 'ag-mig-1', 'usr-mig-1', 'OWNER', 'INVITED', 'mig@test.com', '2099-01-01T00:00:00.000Z', 1, 1)
    `,
      )
      .run();
    await db
      .prepare(
        `
      INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email, status)
      VALUES ('ident-mig-1', 'usr-mig-1', 'https://test', 'sub-mig', 'mig@test.com', 'ACTIVE')
    `,
      )
      .run();
    await db
      .prepare("UPDATE users SET status = 'ACTIVE', version = 2 WHERE id = 'usr-mig-1'")
      .run();
    await db
      .prepare(
        `
      UPDATE agency_memberships
      SET status = 'ACTIVE', activated_at = '2026-09-17T00:00:00.000Z', version = 2, permission_version = 2
      WHERE id = 'mem-mig-1'
    `,
      )
      .run();
    await db
      .prepare(
        `
      UPDATE agencies
      SET status = 'ACTIVE', bootstrap_completed_at = '2026-09-17T00:00:00.000Z',
          activated_at = '2026-09-17T00:00:00.000Z', version = 2
      WHERE id = 'ag-mig-1'
    `,
      )
      .run();

    // C. Clean apply 0004_thankful_pixie.sql
    const sql0004 = readFileSync(resolve(rootDir, 'db/migrations/0004_thankful_pixie.sql'), 'utf8');
    const stmts0004 = sql0004
      .split('--> statement-breakpoint')
      .map((s) => s.trim())
      .filter(Boolean);
    for (const stmt of stmts0004) {
      await db.prepare(stmt).run();
    }

    // D. Verify seed was preserved
    const agencyRow = await db
      .prepare("SELECT id, status FROM agencies WHERE id = 'ag-mig-1'")
      .first<{ id: string; status: string }>();
    expect(agencyRow?.status).toBe('ACTIVE');

    const memRow = await db
      .prepare("SELECT id, status FROM agency_memberships WHERE id = 'mem-mig-1'")
      .first<{ id: string; status: string }>();
    expect(memRow?.status).toBe('ACTIVE');

    // E. Verify Rerun / No-Op (idempotent migration apply does not crash)
    for (const stmt of stmts0004) {
      await expect(db.prepare(stmt).run()).resolves.toBeDefined();
    }
  });

  // 3. Actual composite FK / CHECK / partial unique / trigger inventory
  it('verifies actual composite FK, triggers, and partial unique index inventory in SQLite', async () => {
    // Composite FK inventory for customers: (agency_id, assignee_membership_id) -> agency_memberships(agency_id, id)
    const custFkList = await db.prepare("PRAGMA foreign_key_list('customers')").all<{
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string;
    }>();

    const compositeCustFk = custFkList.results.filter((fk) => fk.table === 'agency_memberships');
    expect(compositeCustFk.length).toBe(2);
    const custFromCols = compositeCustFk.map((fk) => fk.from).sort();
    const custToCols = compositeCustFk.map((fk) => fk.to).sort();
    expect(custFromCols).toEqual(['agency_id', 'assignee_membership_id']);
    expect(custToCols).toEqual(['agency_id', 'id']);

    // Composite FK inventory for company_contacts: (agency_id, customer_id) -> customers(agency_id, id)
    const contactFkList = await db.prepare("PRAGMA foreign_key_list('company_contacts')").all<{
      id: number;
      seq: number;
      table: string;
      from: string;
      to: string;
    }>();

    const compositeContactFk = contactFkList.results.filter((fk) => fk.table === 'customers');
    expect(compositeContactFk.length).toBe(2);
    const contactFromCols = compositeContactFk.map((fk) => fk.from).sort();
    const contactToCols = compositeContactFk.map((fk) => fk.to).sort();
    expect(contactFromCols).toEqual(['agency_id', 'customer_id']);
    expect(contactToCols).toEqual(['agency_id', 'id']);

    // Trigger inventory
    const triggers = await db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'trigger'")
      .all<{ name: string }>();
    const triggerNames = triggers.results.map((t) => t.name);

    expect(triggerNames).toContain('customers_cross_agency_assignee_guard');
    expect(triggerNames).toContain('customers_cross_agency_assignee_update_guard');
    expect(triggerNames).toContain('company_contacts_parent_guard');
    expect(triggerNames).toContain('company_contacts_parent_update_guard');
    expect(triggerNames).toContain('company_contacts_individual_guard');
    expect(triggerNames).toContain('company_contacts_individual_update_guard');
    expect(triggerNames).toContain('company_contacts_primary_guard');
    expect(triggerNames).toContain('company_contacts_primary_update_guard');
    expect(triggerNames).toContain('d1_cas_assertions_guard');

    // Partial unique index inventory
    const indexes = await db
      .prepare(
        "SELECT name, sql FROM sqlite_master WHERE type = 'index' AND name = 'company_contacts_active_primary_uq'",
      )
      .first<{
        name: string;
        sql: string;
      }>();
    expect(indexes).toBeDefined();
    expect(indexes?.sql).toContain('is_primary');
    expect(indexes?.sql).toContain('ACTIVE');
  });

  // 4. Drizzle no-drift verification
  it('verifies Drizzle schema has zero drift against migration snapshot', () => {
    const output = execSync('npx drizzle-kit generate', {
      cwd: rootDir,
      encoding: 'utf8',
    });
    expect(output).toContain('No schema changes, nothing to migrate');
  });
});
