// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { it, expect } from 'vitest';
import { authSchemaHash } from '../scripts/recovery/local-auth-restore-proof';
it('adds claim tracking while preserving populated policy and finance records', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    for (const n of readdirSync('db/migrations')
      .filter((n) => /^\d{4}_.*\.sql$/.test(n) && n < '0027_')
      .sort())
      db.exec(readFileSync('db/migrations/' + n, 'utf8'));
    db.exec(
      "INSERT INTO agencies(id,status) VALUES('a','PROVISIONING'); INSERT INTO users(id,status) VALUES('u','INACTIVE'); INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at) VALUES('m','a','u','OWNER','INVITED','claims@example.invalid','2099-01-01T00:00:00.000Z'); INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES('c','a','INDIVIDUAL','Örnek Kişi','Örnek','Kişi','m'); INSERT INTO insurers(id,agency_id,code,name) VALUES('i','a','I','Örnek'); INSERT INTO insurance_branches(id,agency_id,code,name) VALUES('b','a','B','Kasko'); INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('pr','a','i','b','PR','Ürün'); INSERT INTO payment_methods(id,agency_id,code,name) VALUES('pay','a','PAY','Nakit'); INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency) VALUES('p','a','c','i','pr','b','pay','m','POL-1','POL1','2026-01-01','2026-12-31',1000,'TRY');",
    );
    const old = db.prepare('SELECT * FROM policies').all();
    db.exec(
      "INSERT INTO finance_receivables(id,agency_id,policy_id,customer_id,amount_minor,currency,due_date,method,created_at,updated_at) VALUES('fr','a','p','c',1000,'TRY','2026-12-31','DEFERRED','2026-11-17T00:00:00.000Z','2026-11-17T00:00:00.000Z')",
    );
    const finance = db.prepare('SELECT * FROM finance_receivables').all();
    db.exec(readFileSync('db/migrations/0027_claim_files.sql', 'utf8'));
    expect(db.prepare('SELECT * FROM finance_receivables').all()).toEqual(finance);
    expect(db.prepare('SELECT * FROM policies').all()).toEqual(old);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('SELECT * FROM claim_files').all()).toEqual([]);
    const schema = db
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE '_cf_%' AND name<>'sqlite_sequence' ORDER BY type,name",
      )
      .all();
    expect(authSchemaHash(schema as Parameters<typeof authSchemaHash>[0])).toBe(
      '1a50d53244c622c191b5c0d22fe7fca9a23739c00a3527dca15ced9606fd5875',
    );
  } finally {
    db.close();
  }
});
