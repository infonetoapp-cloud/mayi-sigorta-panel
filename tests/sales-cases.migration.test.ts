// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync } from 'node:fs';
import { writeMigrationEvidence } from './support/migration-evidence';
import { it, expect } from 'vitest';
import { authSchemaHash } from '../scripts/recovery/local-auth-restore-proof';
it('adds sales cases without rewriting the existing schema and measures the deferred FK schema', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    for (const file of readdirSync('db/migrations')
      .filter((n) => /^\d{4}_.*\.sql$/.test(n) && n < '0029_')
      .sort())
      db.exec(readFileSync('db/migrations/' + file, 'utf8'));
    const before = db
      .prepare(
        "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name",
      )
      .all();
    db.exec(readFileSync('db/migrations/0029_sales_case_tasks.sql', 'utf8'));
    for (const old of before)
      expect(
        db
          .prepare('SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name=?')
          .get(String(old.name)),
      ).toEqual(old);
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
    writeMigrationEvidence('p03a-schema.json', {
      hash: authSchemaHash(schema as Parameters<typeof authSchemaHash>[0]),
      counts,
    });
  } finally {
    db.close();
  }
});
