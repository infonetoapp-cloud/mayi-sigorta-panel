// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { it, expect } from 'vitest';
import { authSchemaHash } from '../scripts/recovery/local-auth-restore-proof';
it('preserves populated legacy cancelled/voided policies under FK checks and measures the current schema', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    for (const f of readdirSync('db/migrations')
      .filter((n) => /^\d{4}_.*\.sql$/.test(n) && n < '0028_')
      .sort())
      db.exec(readFileSync('db/migrations/' + f, 'utf8'));
    db.exec(
      "INSERT INTO agencies(id,status) VALUES('a','PROVISIONING'); INSERT INTO users(id,status) VALUES('u','INACTIVE'); INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at) VALUES('m','a','u','OWNER','INVITED','cancel@example.invalid','2099-01-01T00:00:00.000Z'); INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES('c','a','INDIVIDUAL','Eski Kayıt','Eski','Kayıt','m'); INSERT INTO insurers(id,agency_id,code,name) VALUES('i','a','I','Şirket'); INSERT INTO insurance_branches(id,agency_id,code,name) VALUES('b','a','B','Kasko'); INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('pr','a','i','b','PR','Ürün'); INSERT INTO payment_methods(id,agency_id,code,name) VALUES('pay','a','PAY','Nakit'); INSERT INTO loss_reasons(id,agency_id,code,name,status) VALUES('other','a','OTHER','Eski açıklama','INACTIVE');",
    );
    for (const status of ['ACTIVE', 'CANCELLED', 'VOIDED'])
      db.prepare(
        "INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency,status) VALUES(?,'a','c','i','pr','b','pay','m',?,?,'2026-01-01','2026-12-31',1000,'TRY',?)",
      ).run(status, status, status, status);
    const before = db.prepare('SELECT * FROM policies ORDER BY id').all();
    db.exec(readFileSync('db/migrations/0028_policy_lifecycle.sql', 'utf8'));
    expect(db.prepare('SELECT * FROM policies ORDER BY id').all()).toEqual(before);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(
      db.prepare("SELECT name,status FROM loss_reasons WHERE code='OTHER'").get(),
    ).toMatchObject({ name: 'Eski açıklama', status: 'INACTIVE' });
    expect(db.prepare('SELECT count(*) n FROM loss_reasons').get()).toMatchObject({ n: 4 });
    expect(() =>
      db.exec("UPDATE policies SET status='CANCELLED',version=version+1 WHERE id='ACTIVE'"),
    ).toThrow('POLICY_LIFECYCLE_COMMAND_REQUIRED');
    expect(() =>
      db.exec("UPDATE policies SET end_date='2027-12-31',version=version+1 WHERE id='CANCELLED'"),
    ).toThrow('POLICY_TERMINAL_READONLY');
    const schema = db
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE '_cf_%' AND name<>'sqlite_sequence' ORDER BY type,name",
      )
      .all();
    const counts = Object.fromEntries(
      ['table', 'index', 'trigger', 'view'].map((type) => [
        type,
        schema.filter((r) => r.type === type).length,
      ]),
    );
    writeFileSync(
      'audit-evidence/ux-review-2026-11-17/p02-schema.json',
      JSON.stringify(
        { hash: authSchemaHash(schema as Parameters<typeof authSchemaHash>[0]), counts },
        null,
        2,
      ),
    );
  } finally {
    db.close();
  }
});
