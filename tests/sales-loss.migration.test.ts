// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { authSchemaHash } from '../scripts/recovery/local-auth-restore-proof';
it('adds loss/successor pointers without rebuilding existing data or losing deferred case/Task foreign keys', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    for (const file of readdirSync('db/migrations')
      .filter((n) => /^\d{4}_.*\.sql$/.test(n) && n < '0033_')
      .sort())
      db.exec(readFileSync('db/migrations/' + file, 'utf8'));
    db.exec(`INSERT INTO agencies(id,status) VALUES('old-a','PROVISIONING');
      INSERT INTO users(id,status,display_name) VALUES('old-u','ACTIVE','Eski Çalışan');
      INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at) VALUES('old-m','old-a','old-u','OWNER','INVITED','old@example.invalid','2099-01-01T00:00:00.000Z');
      UPDATE agency_memberships SET status='ACTIVE',activated_at='2026-11-19T06:00:00.000Z',version=version+1,permission_version=permission_version+1 WHERE id='old-m';
      INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES('old-c','old-a','INDIVIDUAL','Eski Müşteri','Eski','Müşteri','old-m');
      INSERT INTO insurance_branches(id,agency_id,code,name) VALUES('old-b','old-a','OLD','Kasko');
      BEGIN;
      INSERT INTO tasks(id,agency_id,customer_id,kind,title,due_at,assignee_membership_id,actor_kind,created_by_user_id,created_by_membership_id) VALUES('old-t','old-a','old-c','GENERAL','Teklif takibi','2027-01-01T06:00:00.000Z','old-m','USER','old-u','old-m');
      INSERT INTO sales_cases(id,agency_id,customer_id,branch_id,data_classification,context_kind,date_basis,result,active_task_id,created_by_user_id,created_by_membership_id) VALUES('old-s','old-a','old-c','old-b','GENERAL','NEW_BUSINESS','MANUAL','OPEN','old-t','old-u','old-m');
      INSERT INTO sales_case_tasks(id,agency_id,case_id,task_id,purpose) VALUES('old-l','old-a','old-s','old-t','ACTIVE_CONTACT');
      COMMIT;`);
    const originalCase = db.prepare('SELECT * FROM sales_cases').get()!;
    const oldData = Object.fromEntries(
      ['customers', 'tasks', 'sales_case_tasks'].map((table) => [
        table,
        db.prepare(`SELECT * FROM ${table}`).all(),
      ]),
    );
    const before = db
      .prepare(
        "SELECT name,sql FROM sqlite_schema WHERE type='table' AND name<>'sales_cases' ORDER BY name",
      )
      .all();
    db.exec(readFileSync('db/migrations/0033_sales_loss_cycles.sql', 'utf8'));
    const migratedCase = db.prepare('SELECT * FROM sales_cases').get()!;
    expect(migratedCase).toEqual({
      ...originalCase,
      current_result_id: null,
      predecessor_case_id: null,
      origin_result_revision_id: null,
    });
    for (const [table, rows] of Object.entries(oldData))
      expect(db.prepare(`SELECT * FROM ${table}`).all()).toEqual(rows);
    for (const table of before)
      expect(
        db
          .prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name=?")
          .get(String(table.name)),
      ).toEqual(table);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    const caseSql = String(
      db.prepare("SELECT sql FROM sqlite_schema WHERE name='sales_cases'").get()!.sql,
    );
    expect(caseSql.match(/DEFERRABLE INITIALLY DEFERRED/g)?.length).toBe(4);
    expect(caseSql).toContain('origin_result_revision_id');
    const schema = db
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE '_cf_%' AND name<>'sqlite_sequence' ORDER BY type,name",
      )
      .all();
    const counts = Object.fromEntries(
      ['table', 'index', 'trigger', 'view'].map((type) => [
        type,
        schema.filter((s) => s.type === type).length,
      ]),
    );
    const evidence = {
      hash: authSchemaHash(schema as Parameters<typeof authSchemaHash>[0]),
      counts,
    };
    writeFileSync(
      'audit-evidence/ux-review-2026-11-17/p03c-schema.json',
      JSON.stringify(evidence, null, 2),
    );
    expect(schema.filter(({ type }) => type === 'table').map(({ name }) => name)).toEqual(
      [
        ...before.map(({ name }) => name).filter((name) => name !== 'sqlite_sequence'),
        'sales_cases',
        'sales_case_result_revisions',
      ].sort(),
    );
    const snapshot = JSON.parse(readFileSync('db/migrations/meta/0033_snapshot.json', 'utf8'));
    expect(
      snapshot.tables.sales_case_result_revisions.checkConstraints.sales_case_results_followup
        .value,
    ).toContain('"exception_code" IS NOT NULL');
  } finally {
    db.close();
  }
});
