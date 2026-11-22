// @vitest-environment node
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { it, expect } from 'vitest';
import { authSchemaHash } from '../scripts/recovery/local-auth-restore-proof';
it('adds vehicle tables to populated0023, preserves unknown legacy data and measures schema', () => {
  const db = new DatabaseSync(':memory:');
  try {
    for (const name of readdirSync('db/migrations')
      .filter((n) => /^\d{4}_.*\.sql$/.test(n) && n < '0024_')
      .sort())
      db.exec(readFileSync('db/migrations/' + name, 'utf8'));
    db.exec(
      "INSERT INTO agencies(id,status) VALUES('a','PROVISIONING'); INSERT INTO users(id,status) VALUES('u','INACTIVE'); INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at) VALUES('m','a','u','OWNER','INVITED','fixture@example.invalid','2099-01-01T00:00:00.000Z'); INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES('c','a','INDIVIDUAL','Örnek Kişi','Örnek','Kişi','m');",
    );
    const before = db.prepare('SELECT * FROM customers').all();
    db.exec(readFileSync('db/migrations/0024_customer_vehicle_snapshots.sql', 'utf8'));
    expect(db.prepare('SELECT * FROM customers').all()).toEqual(before);
    expect(db.prepare('SELECT count(*) n FROM customer_vehicles').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) n FROM policy_vehicle_snapshots').get()).toEqual({ n: 0 });
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    const schema = db
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE '_cf_%' AND name<>'sqlite_sequence' ORDER BY type,name",
      )
      .all();
    expect(authSchemaHash(schema as Parameters<typeof authSchemaHash>[0])).toBe(
      'e7d7293c59b58ef92a2b8e3f34e786df449fd237234d6f8a4c780eac120e142d',
    );
  } finally {
    db.close();
  }
});
it('preserves populated0024 vehicles and historical snapshots with foreign keys enabled while allowing missing plates', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON;');
    for (const name of readdirSync('db/migrations')
      .filter((n) => /^\d{4}_.*\.sql$/.test(n) && n < '0025_')
      .sort())
      db.exec(readFileSync('db/migrations/' + name, 'utf8'));
    db.exec(
      "INSERT INTO agencies(id,status) VALUES('a','PROVISIONING'); INSERT INTO users(id,status) VALUES('u','INACTIVE'); INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at) VALUES('m','a','u','OWNER','INVITED','fixture@example.invalid','2099-01-01T00:00:00.000Z'); INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id) VALUES('c','a','INDIVIDUAL','Örnek Kişi','Örnek','Kişi','m'); INSERT INTO insurers(id,agency_id,code,name) VALUES('i','a','I','Örnek'); INSERT INTO insurance_branches(id,agency_id,code,name) VALUES('b','a','B','Kasko'); INSERT INTO insurance_products(id,agency_id,insurer_id,branch_id,code,name) VALUES('pr','a','i','b','PR','Ürün'); INSERT INTO payment_methods(id,agency_id,code,name) VALUES('pay','a','PAY','Nakit'); INSERT INTO policies(id,agency_id,customer_id,insurer_id,product_id,branch_id,payment_method_id,assignee_membership_id,policy_number,normalized_policy_number,start_date,end_date,gross_premium_minor,currency) VALUES('p','a','c','i','pr','b','pay','m','POL-1','POL1','2026-01-01','2026-12-31',1000,'TRY');",
    );
    const details = {
      plate: '34 ABC 001',
      brand: null,
      model: 'Eski',
      modelYear: null,
      vin: null,
      engineNumber: '000123',
      registrationSerial: null,
    };
    db.prepare(
      "INSERT INTO customer_vehicles(id,agency_id,customer_id,details_json,normalized_plate) VALUES('v','a','c',?,'34ABC001')",
    ).run(JSON.stringify(details));
    db.prepare(
      "INSERT INTO policy_vehicle_snapshots(policy_id,agency_id,customer_id,vehicle_id,vehicle_version,details_json) VALUES('p','a','c','v',1,?)",
    ).run(JSON.stringify(details));
    db.prepare("UPDATE customer_vehicles SET details_json=?,version=2 WHERE id='v'").run(
      JSON.stringify({ ...details, model: 'Yeni' }),
    );
    const before = db.prepare('SELECT * FROM customer_vehicles').all(),
      snapshots = db.prepare('SELECT * FROM policy_vehicle_snapshots').all();
    db.exec(readFileSync('db/migrations/0025_optional_vehicle_fields.sql', 'utf8'));
    expect(db.prepare('SELECT * FROM customer_vehicles').all()).toEqual(before);
    expect(db.prepare('SELECT * FROM policy_vehicle_snapshots').all()).toEqual(snapshots);
    const blank = JSON.stringify({ ...details, plate: null, model: null });
    for (const id of ['blank1', 'blank2'])
      db.prepare(
        "INSERT INTO customer_vehicles(id,agency_id,customer_id,details_json,normalized_plate) VALUES(?,'a','c',?,NULL)",
      ).run(id, blank);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(db.prepare('PRAGMA foreign_keys').get()).toEqual({ foreign_keys: 1 });
    const schema = db
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE '_cf_%' AND name<>'sqlite_sequence' ORDER BY type,name",
      )
      .all();
    expect(authSchemaHash(schema as Parameters<typeof authSchemaHash>[0])).toBe(
      '2b458e5ea42185f1791ab628727a78a28ad7d022336aa146bc44a301460507c4',
    );
  } finally {
    db.close();
  }
});
