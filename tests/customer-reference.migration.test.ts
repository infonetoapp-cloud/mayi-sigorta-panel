// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { expect, it } from 'vitest';
import { authSchemaHash } from '../scripts/recovery/local-auth-restore-proof';
it('adds nullable profile data to populated 0022 without rewriting old rows', () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const file of readdirSync('db/migrations')
      .filter((f) => /^\d{4}_.+\.sql$/.test(f) && f < '0023_')
      .sort())
      db.exec(readFileSync('db/migrations/' + file, 'utf8'));
    db.exec(`INSERT INTO agencies(id,status) VALUES('a','PROVISIONING');
      INSERT INTO users(id,status) VALUES('u','INACTIVE');
      INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at) VALUES('m','a','u','OWNER','INVITED','fixture@example.invalid','2099-01-01T00:00:00.000Z');
      INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES('c','a','INDIVIDUAL','Sentetik Müşteri','Sentetik','Müşteri','m');`);
    const before = db.prepare('SELECT * FROM customers').get();
    db.exec(readFileSync('db/migrations/0023_customer_reference_birth_date.sql', 'utf8'));
    expect(db.prepare('SELECT * FROM customers').get()).toEqual({
      ...before,
      birth_date: null,
      reference_membership_id: null,
      reference_name: null,
      reference_search_key: null,
    });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    const schema = db
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE '_cf_%' AND name<>'sqlite_sequence' ORDER BY type,name",
      )
      .all();
    expect(authSchemaHash(schema as Parameters<typeof authSchemaHash>[0])).toBe(
      'db3adf256dfaaf0dbf4c79ef111eee153b2184fe34c948c1cd2d2623121b83a5',
    );
  } finally {
    db.close();
  }
});
