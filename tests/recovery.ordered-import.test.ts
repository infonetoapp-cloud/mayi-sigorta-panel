// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { orderedD1Import } from '../scripts/recovery/ordered-d1-import';
import {
  prepareNativeD1Restore,
  withPreparedRestoreFile,
} from '../scripts/recovery/prepare-native-restore';
import { readFileSync, existsSync } from 'node:fs';
import { receiptFor } from './support/native-source-receipt';
import { explicitSyntheticSnapshotRows } from './support/explicit-synthetic-snapshot';

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const native = [
  'PRAGMA defer_foreign_keys=ON;',
  'CREATE TABLE agency_memberships(id TEXT PRIMARY KEY,user_id TEXT REFERENCES users(id));',
  "INSERT INTO agency_memberships VALUES('membership','user');",
  'CREATE TABLE users(id TEXT PRIMARY KEY);',
  "INSERT INTO users VALUES('user');",
].join('\n');

describe('canonical ordered native recovery transport', () => {
  it('reproduces missing referenced table in raw D1-style transaction then restores same source', () => {
    const raw = new DatabaseSync(':memory:');
    try {
      raw.exec('BEGIN;');
      expect(() => raw.exec(native)).toThrow(/no such table.*users/i);
      raw.exec('ROLLBACK;');
      expect(
        raw.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE type='table'").get()!.n,
      ).toBe(0);
      const before = sha(native);
      const derived = orderedD1Import(native);
      raw.exec(`BEGIN;${derived}COMMIT;`);
      expect(raw.prepare('PRAGMA foreign_key_check').all()).toEqual([]);
      expect(raw.prepare('SELECT count(*) AS n FROM agency_memberships').get()!.n).toBe(1);
      expect(sha(native) === before).toBe(true);
      expect(sha(derived) === sha(orderedD1Import(native))).toBe(true);
    } finally {
      raw.close();
    }
  });

  it('rejects source byte amplification before the decoder executes', () => {
    expect(() => orderedD1Import(' '.repeat(8 * 1024 * 1024 + 1))).toThrow(/RESOURCE_LIMIT/);
  });

  it('rejects invalid FK graphs during preparation, not after reporting success', () => {
    expect(() => orderedD1Import(native.replace("VALUES('user');", "VALUES('other');"))).toThrow();
  });

  it('rejects executable non-export operations instead of silently accepting them', () => {
    for (const tail of [
      'DELETE FROM users;',
      "UPDATE users SET id='other';",
      'CREATE VIRTUAL TABLE extra USING fts5(value);',
      'PRAGMA foreign_keys=OFF; SELECT randomblob(1000000);',
      "ATTACH ':memory:' AS extra;",
    ])
      expect(() => orderedD1Import(native + tail)).toThrow();
  });

  it('preserves quotes, Unicode, NULL, empty text/blob, int64, REAL and NUL text exactly', () => {
    const input =
      "CREATE TABLE scalar_values(id INTEGER PRIMARY KEY,t,b,i,r,n,e);INSERT INTO scalar_values VALUES(1,'İı雪 O''Brien',X'00ff',9223372036854775807,1.0,NULL,'');INSERT INTO scalar_values VALUES(2,CAST(X'610062' AS TEXT),X'',-9223372036854775808,0.1,NULL,'');INSERT INTO scalar_values VALUES(3,'\uFEFF雪',X'',7,1.5,NULL,'');";
    const source = new DatabaseSync(':memory:');
    const target = new DatabaseSync(':memory:');
    try {
      source.exec(input);
      target.exec(orderedD1Import(input));
      const query =
        'SELECT *,typeof(i) AS it,typeof(r) AS rt,hex(t) AS th FROM scalar_values ORDER BY id';
      const a = source.prepare(query),
        b = target.prepare(query);
      a.setReadBigInts(true);
      b.setReadBigInts(true);
      const encode = (value: unknown) =>
        JSON.stringify(value, (_, v) =>
          typeof v === 'bigint'
            ? ['INTEGER', String(v)]
            : v instanceof Uint8Array
              ? ['BLOB', Buffer.from(v).toString('hex')]
              : v,
        );
      expect(encode(a.all()) === encode(b.all())).toBe(true);
    } finally {
      source.close();
      target.close();
    }
  });

  it('preserves the native AUTOINCREMENT high-water mark', () => {
    const input =
      "CREATE TABLE counters(id INTEGER PRIMARY KEY AUTOINCREMENT);INSERT INTO counters VALUES(1);DELETE FROM sqlite_sequence;INSERT INTO sqlite_sequence VALUES('counters',100);";
    const target = new DatabaseSync(':memory:');
    try {
      target.exec(orderedD1Import(input));
      target.exec('INSERT INTO counters DEFAULT VALUES;');
      expect(target.prepare('SELECT max(id) AS n FROM counters').get()!.n).toBe(101);
    } finally {
      target.close();
    }
  });

  it('places all triggers/views after data, preserving historical rows without firing triggers', () => {
    const input =
      native +
      "CREATE INDEX membership_user ON agency_memberships(user_id);CREATE TRIGGER membership_guard BEFORE INSERT ON agency_memberships BEGIN SELECT RAISE(ABORT,'DENIED'); END;CREATE VIEW membership_view AS SELECT id FROM agency_memberships;";
    const sql = orderedD1Import(input);
    expect(sql.indexOf('CREATE INDEX') < sql.indexOf('INSERT INTO')).toBe(true);
    expect(sql.lastIndexOf('INSERT INTO') < sql.indexOf('CREATE TRIGGER')).toBe(true);
    const target = new DatabaseSync(':memory:');
    try {
      target.exec(`BEGIN;${sql}COMMIT;`);
      expect(target.prepare('SELECT count(*) AS n FROM membership_view').get()!.n).toBe(1);
      expect(() => target.exec("INSERT INTO agency_memberships VALUES('second','user')")).toThrow(
        'DENIED',
      );
    } finally {
      target.close();
    }
  });

  it('fails closed for truncation, duplicate schema, unsupported objects and expanding defaults', () => {
    for (const sql of [
      native.slice(0, -1),
      native + 'CREATE TABLE IF NOT EXISTS users(id TEXT);',
      'CREATE TABLE x(v TEXT DEFAULT(randomblob(1000000000)));INSERT INTO x VALUES(NULL);',
      'CREATE TABLE x(v INTEGER GENERATED ALWAYS AS (1));',
      native + 'VACUUM;',
      native + 'DETACH extra;',
      native + 'PRAGMA writable_schema=ON;',
      'CREATE TABLE x(id INTEGER);INSERT INTO x VALUES(1); SELECT 1;',
      'CREATE TABLE x(id INTEGER);INSERT INTO x VALUES(1+1);',
      "CREATE TABLE expanding_values(id INTEGER PRIMARY KEY,t TEXT CHECK(length(replace(t,'x','xxxxxxxx'))>0));INSERT INTO expanding_values VALUES(1,'x');",
      'CREATE TABLE excessive_nesting(id INTEGER PRIMARY KEY CHECK(' +
        '('.repeat(65) +
        'id>0' +
        ')'.repeat(65) +
        '));',
    ])
      expect(() => orderedD1Import(sql)).toThrow();
    expect(() =>
      orderedD1Import('CREATE TABLE x(id INTEGER);' + 'INSERT INTO x VALUES(1);'.repeat(10001)),
    ).toThrow(/RESOURCE_LIMIT/);
  });

  it('never silently skips duplicate data through schema conflict suppression', () => {
    const input =
      'CREATE TABLE ignored_values(id INTEGER PRIMARY KEY ON CONFLICT IGNORE);INSERT INTO ignored_values VALUES(1);INSERT INTO ignored_values VALUES(1);';
    expect(() => orderedD1Import(input)).toThrow();
  });

  it('accepts bounded shrinking replacement required by current document UUID constraints', () => {
    const source =
      "CREATE TABLE bounded_values(id INTEGER PRIMARY KEY,t TEXT CHECK(length(replace(substr(t,1),'-',''))=2));INSERT INTO bounded_values VALUES(1,'a-b');";
    const target = new DatabaseSync(':memory:');
    try {
      target.exec(orderedD1Import(source));
      expect(target.prepare('SELECT count(*) AS n FROM bounded_values').get()!.n).toBe(1);
    } finally {
      target.close();
    }
  });

  it('rejects unresolved views, invalid text encoding, incomplete-column inserts and early triggers', () => {
    for (const source of [
      native + 'CREATE VIEW unresolved AS SELECT id FROM absent;',
      "CREATE TABLE encoding_values(id INTEGER PRIMARY KEY,t);INSERT INTO encoding_values VALUES(1,CAST(X'ff' AS TEXT));",
      "CREATE TABLE default_values(id INTEGER PRIMARY KEY,t TEXT DEFAULT 'not-source-data');INSERT INTO default_values(id) VALUES(1);",
      'CREATE TABLE early_values(id INTEGER);CREATE TRIGGER early_trigger AFTER INSERT ON early_values BEGIN SELECT 1; END;INSERT INTO early_values VALUES(1);',
    ])
      expect(() => orderedD1Import(source)).toThrow();
  });

  it('only synthetic fixture builders materialize partial defaults before source identity is computed', () => {
    const input =
      "CREATE TABLE users(id TEXT PRIMARY KEY,status TEXT DEFAULT 'ACTIVE',version INTEGER DEFAULT 1,created_at TEXT DEFAULT CURRENT_TIMESTAMP,updated_at TEXT DEFAULT CURRENT_TIMESTAMP,display_name TEXT);INSERT INTO users(id,status) VALUES('synthetic-new','ACTIVE');";
    expect(() => orderedD1Import(input)).toThrow('SOURCE_DEFAULTS_DENIED');
    const fixed = explicitSyntheticSnapshotRows(input, '2026-10-09T00:00:00.000Z');
    expect(fixed === explicitSyntheticSnapshotRows(input, '2026-10-09T00:00:00.000Z')).toBe(true);
    const target = new DatabaseSync(':memory:');
    try {
      target.exec(orderedD1Import(fixed));
      expect(target.prepare('SELECT created_at FROM users').get()!.created_at).toBe(
        '2026-10-09T00:00:00.000Z',
      );
    } finally {
      target.close();
    }
    expect(explicitSyntheticSnapshotRows(native, '2026-10-09T00:00:00.000Z') === native).toBe(true);
  });

  it('verifies COMPLETE source identity before deriving a separate deterministic transport', async () => {
    const receipt = receiptFor(native);
    const prepared = prepareNativeD1Restore(Buffer.from(native), receipt);
    expect(prepared.sourceExportSha256 === sha(native)).toBe(true);
    expect(prepared.derivedRestoreSha256 === sha(prepared.sql)).toBe(true);
    expect(prepared.sourceExportSha256 !== prepared.derivedRestoreSha256).toBe(true);
    expect(prepared.sql === prepareNativeD1Restore(Buffer.from(native), receipt).sql).toBe(true);
    let path = '';
    await expect(
      withPreparedRestoreFile(prepared, async (p) => {
        path = p;
        expect(readFileSync(p, 'utf8') === prepared.sql).toBe(true);
        throw new Error('SYNTHETIC_IMPORT_FAILURE');
      }),
    ).rejects.toThrow('SYNTHETIC_IMPORT_FAILURE');
    expect(existsSync(path)).toBe(false);
    for (const bad of [
      { ...receipt, sourceExportSha256: '0'.repeat(64) },
      { ...receipt, expectedGeneration: 'different' },
      { ...receipt, complete: { ...receipt.complete, state: 'PARTIAL' } },
      { ...receipt, object: { ...receipt.object, size: 1 } },
      { ...receipt, completeUploadedAt: receipt.sqlUploadedAt },
    ])
      expect(() => prepareNativeD1Restore(Buffer.from(native), bad)).toThrow();
    expect(() => prepareNativeD1Restore(Buffer.from(native.slice(0, -1)), receipt)).toThrow();
  });
});
