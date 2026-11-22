// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { writeMigrationEvidence } from './support/migration-evidence';
import { it, expect } from 'vitest';
import { authSchemaHash } from '../scripts/recovery/local-auth-restore-proof';
it('adds immutable price events and preserves all existing tables and deferred pointers', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    for (const f of readdirSync('db/migrations')
      .filter((n) => /^\d{4}_.*\.sql$/.test(n) && n < '0032_')
      .sort())
      db.exec(readFileSync('db/migrations/' + f, 'utf8'));
    const existing = db
      .prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name")
      .all();
    db.exec(readFileSync('db/migrations/0032_sales_price_events.sql', 'utf8'));
    for (const row of existing)
      expect(
        db
          .prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' AND name=?")
          .get(String(row.name)),
      ).toEqual(row);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
    expect(
      String(db.prepare("SELECT sql FROM sqlite_schema WHERE name='sales_prices'").get()!.sql),
    ).toContain('DEFERRABLE INITIALLY DEFERRED');
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
    expect(counts).toEqual({ table: 61, index: 234, trigger: 231, view: 3 });
    writeMigrationEvidence('p03b2a-schema.json', {
      hash: authSchemaHash(schema as Parameters<typeof authSchemaHash>[0]),
      counts,
    });
  } finally {
    db.close();
  }
});
