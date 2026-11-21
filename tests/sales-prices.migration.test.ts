// @vitest-environment node
import { DatabaseSync } from 'node:sqlite';
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { it, expect } from 'vitest';
import { authSchemaHash } from '../scripts/recovery/local-auth-restore-proof';
it('adds price/revision tables and preserves existing deferred case link SQL', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec('PRAGMA foreign_keys=ON');
    for (const f of readdirSync('db/migrations')
      .filter((n) => /^\d{4}_.*\.sql$/.test(n) && n < '0031_')
      .sort())
      db.exec(readFileSync('db/migrations/' + f, 'utf8'));
    const existing = db
      .prepare("SELECT name,sql FROM sqlite_schema WHERE type='table' ORDER BY name")
      .all();
    db.exec(readFileSync('db/migrations/0031_sales_price_revisions.sql', 'utf8'));
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
    expect(counts).toEqual({ table: 60, index: 229, trigger: 228, view: 3 });
    writeFileSync(
      'audit-evidence/ux-review-2026-11-17/p03b1-schema.json',
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
