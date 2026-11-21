// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { authSchemaHash } from '../scripts/recovery/local-auth-restore-proof';
it('adds renewal loss guards without rebuilding any existing table or deferred pointer', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    for (const f of readdirSync('db/migrations')
      .filter((f) => /^\d{4}_.*\.sql$/.test(f) && f < '0034_')
      .sort())
      db.exec(readFileSync('db/migrations/' + f, 'utf8'));
    const tables = db
      .prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name")
      .all();
    db.exec(readFileSync('db/migrations/0034_renewal_loss_cycles.sql', 'utf8'));
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
    expect(counts).toEqual({ table: 62, index: 240, trigger: 237, view: 3 });
    writeFileSync(
      'audit-evidence/ux-review-2026-11-17/p03c-renewal-schema.json',
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
