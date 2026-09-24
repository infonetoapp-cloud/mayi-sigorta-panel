import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';

const rootDir = resolve(__dirname, '..');
const wranglerCli = resolve(rootDir, 'node_modules/wrangler/bin/wrangler.js');
let persistenceDir = '';

function wrangler(arguments_: string[]) {
  return spawnSync(process.execPath, [wranglerCli, ...arguments_], {
    cwd: rootDir,
    encoding: 'utf8',
  });
}

function executeSql(sql: string) {
  return wrangler([
    'd1',
    'execute',
    'DB',
    '--local',
    '--persist-to',
    persistenceDir,
    '--command',
    sql,
  ]);
}

function expectSqlSuccess(sql: string): void {
  const result = executeSql(sql);
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

function expectSqlFailure(sql: string, reason: string): void {
  const result = executeSql(sql);
  expect(result.status, `${result.stdout}\n${result.stderr}`).not.toBe(0);
  expect(`${result.stdout}\n${result.stderr}`).toContain(reason);
}

function queryRows<T extends Record<string, unknown>>(sql: string): T[] {
  const result = wrangler([
    'd1',
    'execute',
    'DB',
    '--local',
    '--persist-to',
    persistenceDir,
    '--command',
    sql,
    '--json',
  ]);
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  const payload = JSON.parse(result.stdout) as Array<{ results: T[] }>;
  return payload.flatMap((entry) => entry.results);
}

function insertProvisioningAgency(id: string): void {
  expectSqlSuccess(`INSERT INTO agencies (id, status) VALUES ('${id}', 'PROVISIONING')`);
}

function insertUser(id: string, status: 'ACTIVE' | 'INACTIVE' = 'ACTIVE'): void {
  expectSqlSuccess(`INSERT INTO users (id, status) VALUES ('${id}', '${status}')`);
}

function insertIdentity(id: string, userId: string, subject = id): void {
  expectSqlSuccess(`
    INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email)
    VALUES ('${id}', '${userId}', 'https://synthetic.cloudflareaccess.com', '${subject}', '${id}@example.test')
  `);
}

function insertMembership(
  id: string,
  agencyId: string,
  userId: string,
  type: 'OWNER' | 'MEMBER',
  status: 'INVITED' | 'ACTIVE' = 'ACTIVE',
): void {
  const activatedColumn = status === 'ACTIVE' ? ', activated_at' : '';
  const activatedValue = status === 'ACTIVE' ? ", '2026-09-17T00:00:00.000Z'" : '';
  expectSqlSuccess(`
    INSERT INTO agency_memberships (
      id, agency_id, user_id, type, status, invitation_email, invitation_expires_at${activatedColumn}
    ) VALUES (
      '${id}', '${agencyId}', '${userId}', '${type}', '${status}', '${id}@example.test',
      '2099-01-01T00:00:00.000Z'${activatedValue}
    )
  `);
}

function bootstrapActiveAgency(prefix: string): void {
  insertProvisioningAgency(`${prefix}-agency`);
  insertUser(`${prefix}-user`, 'INACTIVE');
  insertMembership(
    `${prefix}-membership`,
    `${prefix}-agency`,
    `${prefix}-user`,
    'OWNER',
    'INVITED',
  );
  insertIdentity(`${prefix}-identity`, `${prefix}-user`);
  expectSqlSuccess(`
    UPDATE users SET status = 'ACTIVE', version = version + 1
    WHERE id = '${prefix}-user' AND version = 1
  `);
  expectSqlSuccess(`
    UPDATE agency_memberships
    SET status = 'ACTIVE', activated_at = '2026-09-17T00:00:00.000Z',
        version = version + 1, permission_version = permission_version + 1
    WHERE id = '${prefix}-membership' AND version = 1
  `);
  expectSqlSuccess(`
    UPDATE agencies
    SET status = 'ACTIVE', bootstrap_completed_at = '2026-09-17T00:00:00.000Z',
        activated_at = '2026-09-17T00:00:00.000Z', version = version + 1
    WHERE id = '${prefix}-agency' AND version = 1
  `);
}

function addActiveOwner(prefix: string, agencyId: string): void {
  insertUser(`${prefix}-user`);
  insertIdentity(`${prefix}-identity`, `${prefix}-user`);
  insertMembership(`${prefix}-membership`, agencyId, `${prefix}-user`, 'OWNER', 'ACTIVE');
}

describe('M1-T03 gerçek yerel D1 identity/agency sözleşmesi', () => {
  beforeAll(() => {
    persistenceDir = mkdtempSync(join(tmpdir(), 'mayi-d1-m1-t03-'));
  });

  afterAll(() => {
    rmSync(persistenceDir, { recursive: true, force: true });
  });

  it('temiz yerel D1 veritabanına migration sıfırdan uygulanmalıdır', () => {
    const result = wrangler([
      'd1',
      'migrations',
      'apply',
      'DB',
      '--local',
      '--persist-to',
      persistenceDir,
    ]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  });

  it('uygulanmış migration tekrar çalıştırıldığında deterministik no-op olmalıdır', () => {
    const result = wrangler([
      'd1',
      'migrations',
      'apply',
      'DB',
      '--local',
      '--persist-to',
      persistenceDir,
    ]);
    expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
    expect(result.stdout).toContain('No migrations to apply');
  });

  it('issuer ve subject çifti tekrar edemez', () => {
    insertUser('identity-u1');
    insertUser('identity-u2');
    insertIdentity('identity-i1', 'identity-u1', 'same-subject');
    expectSqlFailure(
      `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email)
       VALUES ('identity-i2', 'identity-u2', 'https://synthetic.cloudflareaccess.com',
       'same-subject', 'second@example.test')`,
      'AUTH_IDENTITY_ROW_REPLACEMENT_FORBIDDEN',
    );
  });

  it('agency ve user çifti tekrar üyelik üretemez', () => {
    bootstrapActiveAgency('membership-unique');
    expectSqlFailure(
      `INSERT INTO agency_memberships
       (id, agency_id, user_id, type, status, invitation_email, invitation_expires_at, activated_at)
       VALUES ('membership-duplicate', 'membership-unique-agency', 'membership-unique-user',
       'OWNER', 'ACTIVE', 'duplicate@example.test', '2099-01-01T00:00:00.000Z',
       '2026-09-17T00:00:00.000Z')`,
      'MEMBERSHIP_ROW_REPLACEMENT_FORBIDDEN',
    );
  });

  it('geçersiz agency status metni DB CHECK tarafından reddedilir', () => {
    expectSqlFailure(
      `INSERT INTO agencies (id, status) VALUES ('bad-agency-status', 'DISABLED')`,
      'agencies_status_valid',
    );
  });

  it('geçersiz membership type metni DB CHECK tarafından reddedilir', () => {
    bootstrapActiveAgency('bad-type-base');
    insertUser('bad-type-user');
    expectSqlFailure(
      `INSERT INTO agency_memberships
       (id, agency_id, user_id, type, status, invitation_email, invitation_expires_at, activated_at)
       VALUES ('bad-type-membership', 'bad-type-base-agency', 'bad-type-user', 'ADMIN',
       'ACTIVE', 'bad-type@example.test', '2099-01-01T00:00:00.000Z',
       '2026-09-17T00:00:00.000Z')`,
      'agency_memberships_type_valid',
    );
  });

  it('geçersiz membership status metni DB CHECK tarafından reddedilir', () => {
    bootstrapActiveAgency('bad-status-base');
    insertUser('bad-status-user');
    expectSqlFailure(
      `INSERT INTO agency_memberships
       (id, agency_id, user_id, type, status, invitation_email, invitation_expires_at)
       VALUES ('bad-status-membership', 'bad-status-base-agency', 'bad-status-user', 'MEMBER',
       'DISABLED', 'bad-status@example.test', '2099-01-01T00:00:00.000Z')`,
      'agency_memberships_status_valid',
    );
  });

  it('foreign-key ihlalleri yerel D1 tarafından reddedilir', () => {
    expectSqlFailure(
      `INSERT INTO auth_identities (id, user_id, issuer, subject, verified_email)
       VALUES ('orphan-identity', 'missing-user', 'https://synthetic.cloudflareaccess.com',
       'orphan-subject', 'orphan@example.test')`,
      'FOREIGN KEY constraint failed',
    );
  });

  it('version ve permission_version başlangıç değerleri 1 olur', () => {
    insertProvisioningAgency('defaults-agency');
    insertUser('defaults-user', 'INACTIVE');
    insertMembership('defaults-membership', 'defaults-agency', 'defaults-user', 'OWNER', 'INVITED');
    insertIdentity('defaults-identity', 'defaults-user');
    expect(
      queryRows<{
        agency_version: number;
        user_version: number;
        identity_version: number;
        membership_version: number;
        permission_version: number;
      }>(`
        SELECT agency.version AS agency_version, user.version AS user_version,
               identity.version AS identity_version, membership.version AS membership_version,
               membership.permission_version
        FROM agencies AS agency
        JOIN agency_memberships AS membership ON membership.agency_id = agency.id
        JOIN users AS user ON user.id = membership.user_id
        JOIN auth_identities AS identity ON identity.user_id = user.id
        WHERE agency.id = 'defaults-agency'
      `),
    ).toEqual([
      {
        agency_version: 1,
        user_version: 1,
        identity_version: 1,
        membership_version: 1,
        permission_version: 1,
      },
    ]);
  });

  it('bootstrap tek INVITED OWNER üretir ve doğrudan ACTIVE agency oluşturulamaz', () => {
    expectSqlFailure(
      `INSERT INTO agencies (id, status, bootstrap_completed_at, activated_at)
       VALUES ('direct-active-agency', 'ACTIVE', '2026-09-17T00:00:00.000Z',
       '2026-09-17T00:00:00.000Z')`,
      'ACTIVE_AGENCY_REQUIRES_EFFECTIVE_OWNER',
    );
    insertProvisioningAgency('bootstrap-guard-agency');
    insertUser('bootstrap-guard-user-1', 'INACTIVE');
    insertUser('bootstrap-guard-user-2', 'INACTIVE');
    insertMembership(
      'bootstrap-guard-membership-1',
      'bootstrap-guard-agency',
      'bootstrap-guard-user-1',
      'OWNER',
      'INVITED',
    );
    expectSqlFailure(
      `INSERT INTO agency_memberships
       (id, agency_id, user_id, type, status, invitation_email, invitation_expires_at)
       VALUES ('bootstrap-guard-membership-2', 'bootstrap-guard-agency',
       'bootstrap-guard-user-2', 'OWNER', 'INVITED', 'owner2@example.test',
       '2099-01-01T00:00:00.000Z')`,
      'BOOTSTRAP_MEMBERSHIP_ALREADY_EXISTS',
    );
  });

  it('identity binding ve ilk owner aktivasyonundan sonra Agency ACTIVE olabilir', () => {
    bootstrapActiveAgency('bootstrap-success');
    expect(
      queryRows<{ status: string }>(
        `SELECT status FROM agencies WHERE id = 'bootstrap-success-agency'`,
      ),
    ).toEqual([{ status: 'ACTIVE' }]);
  });

  it('son etkin owner membership demotion veya suspension ile düşürülemez', () => {
    bootstrapActiveAgency('last-membership-owner');
    expectSqlFailure(
      `UPDATE agency_memberships
       SET type = 'MEMBER', version = version + 1, permission_version = permission_version + 1
       WHERE id = 'last-membership-owner-membership' AND version = 2`,
      'LAST_EFFECTIVE_OWNER_REQUIRED',
    );
    expectSqlFailure(
      `UPDATE agency_memberships
       SET status = 'SUSPENDED', suspended_at = '2026-09-17T01:00:00.000Z',
           version = version + 1, permission_version = permission_version + 1
       WHERE id = 'last-membership-owner-membership' AND version = 2`,
      'LAST_EFFECTIVE_OWNER_REQUIRED',
    );
  });

  it('son etkin owner User inactivation yoluyla etkisiz bırakılamaz', () => {
    bootstrapActiveAgency('last-user-owner');
    expectSqlFailure(
      `UPDATE users SET status = 'INACTIVE', version = version + 1
       WHERE id = 'last-user-owner-user' AND version = 2`,
      'LAST_EFFECTIVE_OWNER_REQUIRED',
    );
  });

  it('son etkin owner identity revocation yoluyla etkisiz bırakılamaz', () => {
    bootstrapActiveAgency('last-identity-owner');
    expectSqlFailure(
      `UPDATE auth_identities
       SET status = 'REVOKED', revoked_at = '2026-09-17T01:00:00.000Z', version = version + 1
       WHERE id = 'last-identity-owner-identity' AND version = 1`,
      'LAST_EFFECTIVE_OWNER_REQUIRED',
    );
  });

  it('INSERT OR REPLACE son owner membership guardlarını atlayamaz', () => {
    bootstrapActiveAgency('replace-membership-owner');
    expectSqlFailure(
      `INSERT OR REPLACE INTO agency_memberships
       (id, agency_id, user_id, type, status, permission_version, version,
        invitation_email, invitation_expires_at, inactivated_at)
       VALUES ('replace-membership-owner-membership', 'replace-membership-owner-agency',
       'replace-membership-owner-user', 'MEMBER', 'INACTIVE', 3, 3,
       'replace-membership-owner-membership@example.test', '2099-01-01T00:00:00.000Z',
       '2026-09-17T01:00:00.000Z')`,
      'MEMBERSHIP_ROW_REPLACEMENT_FORBIDDEN',
    );
  });

  it('INSERT OR REPLACE son owner identity guardlarını atlayamaz', () => {
    bootstrapActiveAgency('replace-identity-owner');
    expectSqlFailure(
      `INSERT OR REPLACE INTO auth_identities
       (id, user_id, issuer, subject, verified_email, status, bound_at, revoked_at,
        version, created_at, updated_at)
       SELECT id, user_id, issuer, subject, verified_email, 'REVOKED', bound_at,
              '2099-01-01T00:00:00.000Z', version + 1, created_at,
              '2099-01-01T00:00:00.000Z'
       FROM auth_identities WHERE id = 'replace-identity-owner-identity'`,
      'AUTH_IDENTITY_ROW_REPLACEMENT_FORBIDDEN',
    );
  });

  it('iki etkin owner varken biri inactivate edilebilir, son kalan edilemez', () => {
    bootstrapActiveAgency('two-owner');
    addActiveOwner('two-owner-second', 'two-owner-agency');
    expectSqlSuccess(`
      UPDATE users SET status = 'INACTIVE', version = version + 1
      WHERE id = 'two-owner-user' AND version = 2
    `);
    expectSqlFailure(
      `UPDATE users SET status = 'INACTIVE', version = version + 1
       WHERE id = 'two-owner-second-user' AND version = 1`,
      'LAST_EFFECTIVE_OWNER_REQUIRED',
    );
  });

  it('stale expected_version koşulu mutation uygulamaz', () => {
    bootstrapActiveAgency('stale-version');
    expectSqlSuccess(`
      UPDATE agency_memberships
      SET last_operation_id = 'stale-should-not-land', version = version + 1
      WHERE id = 'stale-version-membership' AND version = 1
    `);
    expect(
      queryRows<{ version: number; last_operation_id: string | null }>(`
        SELECT version, last_operation_id FROM agency_memberships
        WHERE id = 'stale-version-membership'
      `),
    ).toEqual([{ version: 2, last_operation_id: null }]);
  });

  it('iki owner azaltma interleaving işlemi sıfır owner üretemez', () => {
    bootstrapActiveAgency('interleave');
    addActiveOwner('interleave-second', 'interleave-agency');
    expectSqlSuccess(`
      UPDATE agency_memberships
      SET type = 'MEMBER', version = version + 1, permission_version = permission_version + 1
      WHERE id = 'interleave-membership' AND version = 2
    `);
    expectSqlFailure(
      `UPDATE agency_memberships
       SET type = 'MEMBER', version = version + 1, permission_version = permission_version + 1
       WHERE id = 'interleave-second-membership' AND version = 1`,
      'LAST_EFFECTIVE_OWNER_REQUIRED',
    );
    expect(
      queryRows<{ owner_count: number }>(`
        SELECT count(*) AS owner_count FROM agency_memberships
        WHERE agency_id = 'interleave-agency' AND type = 'OWNER' AND status = 'ACTIVE'
      `),
    ).toEqual([{ owner_count: 1 }]);
  });

  it('membership agency/user kimliği taşınamaz ve güvenlik geçmişi silinemez', () => {
    bootstrapActiveAgency('immutability');
    expectSqlFailure(
      `UPDATE agency_memberships
       SET agency_id = 'different-agency', version = version + 1
       WHERE id = 'immutability-membership' AND version = 2`,
      'MEMBERSHIP_IDENTITY_IMMUTABLE',
    );
    expectSqlFailure(
      `DELETE FROM agency_memberships WHERE id = 'immutability-membership'`,
      'MEMBERSHIP_HARD_DELETE_FORBIDDEN',
    );
    expectSqlFailure(
      `DELETE FROM auth_identities WHERE id = 'immutability-identity'`,
      'AUTH_IDENTITY_HARD_DELETE_FORBIDDEN',
    );
    expectSqlFailure(
      `DELETE FROM users WHERE id = 'immutability-user'`,
      'USER_HARD_DELETE_FORBIDDEN',
    );
  });

  it('kritik custom trigger envanteri temiz migration içinde eksiksizdir', () => {
    const expectedTriggers = [
      'agencies_no_active_insert',
      'agencies_no_delete',
      'agencies_no_row_replacement',
      'agencies_update_guard',
      'agency_memberships_after_insert_owner_assertion',
      'agency_memberships_no_delete',
      'agency_memberships_no_row_replacement',
      'agency_memberships_provisioning_insert_guard',
      'agency_memberships_update_guard',
      'agency_settings_default_insurer_active_insert_guard',
      'agency_settings_default_insurer_active_update_guard',
      'agency_settings_default_insurer_agency_guard',
      'agency_settings_default_insurer_agency_update_guard',
      'audit_events_no_delete',
      'audit_events_no_update',
      'auth_identities_after_insert_owner_assertion',
      'auth_identities_no_delete',
      'auth_identities_no_row_replacement',
      'auth_identities_update_guard',
      'company_contacts_individual_guard',
      'company_contacts_individual_update_guard',
      'company_contacts_parent_guard',
      'company_contacts_parent_update_guard',
      'company_contacts_primary_guard',
      'company_contacts_primary_update_guard',
      'customers_archive_guard_insert',
      'customers_archive_guard_update',
      'customers_cross_agency_assignee_guard',
      'customers_cross_agency_assignee_update_guard',
      'customers_identity_type_guard',
      'customers_identity_type_update_guard',
      'd1_cas_assertions_cleanup',
      'd1_cas_assertions_guard',
      'ext_cust_refs_parent_guard',
      'ext_cust_refs_parent_update_guard',
      'insurance_products_parent_guard',
      'insurance_products_parent_update_guard',
      'insurers_prevent_deactivating_default_guard',
      'membership_permissions_no_row_replacement',
      'membership_permissions_update_guard',
      'operation_receipts_no_row_replacement',
      'operation_receipts_update_guard',
      'policies_active_catalog_guard_insert',
      'policies_active_catalog_guard_update',
      'policies_archive_open_renewal_guard',
      'policies_archive_reason_code_guard',
      'policies_archive_reason_code_guard_insert',
      'policies_archived_customer_guard_insert',
      'policies_archived_customer_guard_update',
      'policies_installment_guard_insert',
      'policies_installment_guard_update',
      'policies_terminal_status_open_renewal_guard',
      'policy_amendments_archived_parent_guard_insert',
      'policy_amendments_archived_parent_guard_update',
      'policy_external_references_archived_parent_guard_insert',
      'policy_external_references_archived_parent_guard_update',
      'policy_parties_archived_customer_guard_insert',
      'policy_parties_archived_parent_guard_insert',
      'policy_parties_archived_parent_guard_update',
      'renewal_state_history_no_delete',
      'renewal_state_history_no_update',
      'sensitive_action_grants_no_row_replacement',
      'sensitive_action_grants_update_guard',
      'system_audit_events_no_delete',
      'system_audit_events_no_update',
      'tasks_policy_customer_insert',
      'tasks_policy_customer_update',
      'tasks_renewal_customer_insert',
      'tasks_renewal_customer_update',
      'users_after_insert_owner_assertion',
      'users_no_delete',
      'users_no_row_replacement',
      'users_update_guard',
    ];
    const rows = queryRows<{ name: string }>(`
      SELECT name FROM sqlite_master
      WHERE type = 'trigger'
      ORDER BY name
    `);
    expect(rows.map((row) => row.name)).toEqual(expectedTriggers);
  });

  it('tek statement içindeki iki owner demotion tamamen rollback edilir', () => {
    bootstrapActiveAgency('batch-demotion');
    addActiveOwner('batch-demotion-second', 'batch-demotion-agency');
    expectSqlFailure(
      `UPDATE agency_memberships
       SET type = 'MEMBER', version = version + 1, permission_version = permission_version + 1
       WHERE agency_id = 'batch-demotion-agency' AND type = 'OWNER'`,
      'LAST_EFFECTIVE_OWNER_REQUIRED',
    );
    expect(
      queryRows<{ type: string; version: number; permission_version: number }>(`
        SELECT type, version, permission_version FROM agency_memberships
        WHERE agency_id = 'batch-demotion-agency' ORDER BY id
      `),
    ).toEqual([
      { type: 'OWNER', version: 2, permission_version: 2 },
      { type: 'OWNER', version: 1, permission_version: 1 },
    ]);
  }, 180_000);

  it('tek statement içindeki iki owner User inactivation tamamen rollback edilir', () => {
    bootstrapActiveAgency('batch-user');
    addActiveOwner('batch-user-second', 'batch-user-agency');
    expectSqlFailure(
      `UPDATE users SET status = 'INACTIVE', version = version + 1
       WHERE id IN ('batch-user-user', 'batch-user-second-user')`,
      'LAST_EFFECTIVE_OWNER_REQUIRED',
    );
    expect(
      queryRows<{ id: string; status: string; version: number }>(`
        SELECT id, status, version FROM users
        WHERE id IN ('batch-user-user', 'batch-user-second-user') ORDER BY id
      `),
    ).toEqual([
      { id: 'batch-user-second-user', status: 'ACTIVE', version: 1 },
      { id: 'batch-user-user', status: 'ACTIVE', version: 2 },
    ]);
  }, 180_000);

  it('UPSERT protected membership satırını güncelleyemez', () => {
    bootstrapActiveAgency('upsert-membership');
    expectSqlFailure(
      `INSERT INTO agency_memberships
       (id, agency_id, user_id, type, status, permission_version, version,
        invitation_email, invitation_expires_at, inactivated_at)
       VALUES ('upsert-membership-membership', 'upsert-membership-agency',
       'upsert-membership-user', 'MEMBER', 'INACTIVE', 3, 3,
       'upsert-membership-membership@example.test', '2099-01-01T00:00:00.000Z',
       '2099-01-01T00:00:00.000Z')
       ON CONFLICT(id) DO UPDATE SET type = excluded.type, status = excluded.status,
       permission_version = excluded.permission_version, version = excluded.version,
       inactivated_at = excluded.inactivated_at`,
      'MEMBERSHIP_ROW_REPLACEMENT_FORBIDDEN',
    );
  });

  it('cross-agency INSERT OR REPLACE membership taşıması reddedilir', () => {
    bootstrapActiveAgency('cross-replace-a');
    bootstrapActiveAgency('cross-replace-b');
    expectSqlFailure(
      `INSERT OR REPLACE INTO agency_memberships
       (id, agency_id, user_id, type, status, permission_version, version,
        invitation_email, invitation_expires_at, activated_at)
       VALUES ('cross-replace-a-membership', 'cross-replace-b-agency',
       'cross-replace-a-user', 'OWNER', 'ACTIVE', 3, 3,
       'cross-replace-a-membership@example.test', '2099-01-01T00:00:00.000Z',
       '2026-09-17T00:00:00.000Z')`,
      'MEMBERSHIP_ROW_REPLACEMENT_FORBIDDEN',
    );
  });

  it('Agency hard-delete ve Agency/User row replacement reddedilir', () => {
    bootstrapActiveAgency('protected-row');
    expectSqlFailure(
      `DELETE FROM agencies WHERE id = 'protected-row-agency'`,
      'AGENCY_HARD_DELETE_FORBIDDEN',
    );
    expectSqlFailure(
      `INSERT OR REPLACE INTO agencies
       (id, status, bootstrap_completed_at, activated_at, version)
       VALUES ('protected-row-agency', 'ACTIVE', '2026-09-17T00:00:00.000Z',
       '2026-09-17T00:00:00.000Z', 3)`,
      'AGENCY_ROW_REPLACEMENT_FORBIDDEN',
    );
    expectSqlFailure(
      `INSERT OR REPLACE INTO users (id, status, version)
       VALUES ('protected-row-user', 'INACTIVE', 3)`,
      'USER_ROW_REPLACEMENT_FORBIDDEN',
    );
  });
});
