// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { writeMigrationEvidence } from './support/migration-evidence';
import { expect, it } from 'vitest';
import { authSchemaHash } from '../scripts/recovery/local-auth-restore-proof';

it('expands renewal admission without rewriting existing sales tables and measures current 0030 schema', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    for (const file of readdirSync('db/migrations')
      .filter((n) => /^\d{4}_.*\.sql$/.test(n) && n < '0030_')
      .sort())
      db.exec(readFileSync('db/migrations/' + file, 'utf8'));
    const tables = db
      .prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name")
      .all();
    db.exec(readFileSync('db/migrations/0030_sales_renewal_adoption.sql', 'utf8'));
    expect(
      db.prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name").all(),
    ).toEqual(tables);
    expect(db.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
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
    expect(counts).toEqual({ table: 58, index: 221, trigger: 222, view: 3 });
    writeMigrationEvidence('p03a-renewal-schema.json', {
      hash: authSchemaHash(schema as Parameters<typeof authSchemaHash>[0]),
      counts,
    });
  } finally {
    db.close();
  }
});
