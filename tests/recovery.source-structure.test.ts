// @vitest-environment node
import { it, expect } from 'vitest';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { preparePhasedD1Restore } from '../scripts/recovery/phased-d1-restore';
import { inspectForeignKeyGraph, describeOrderedImport } from '../scripts/recovery/schema-graph';
// Explicit operator opt-in. No network, no private SQL written or logged.
it.skipIf(process.env.MAYI_INSPECT_ACCEPTED_SOURCE !== 'YES')(
  'captures SAFE structural995313 metadata only from fresh operator-custodied source',
  () => {
    const dir = join(tmpdir(), 'mayi-compatibility-private');
    const bytes = readFileSync(join(dir, 'source.sql'));
    const receipt: unknown = JSON.parse(readFileSync(join(dir, 'receipt.json'), 'utf8'));
    const pkg = preparePhasedD1Restore(bytes, receipt);
    expect(
      pkg.sourceExportSha256 ===
        '8eea4b138b27c8fd50926b17bec23231a8c80b2af66ba0cbb522ec05949823ea' &&
        pkg.singleDerivedSha256 ===
          '05ad52aa8cfcc5eaba21d0cfc9cb9e701bdbe51fa738f92e4bcd71d2eafb2768',
    ).toBe(true);
    const db = new DatabaseSync(':memory:', {
      enableForeignKeyConstraints: false,
      allowExtension: false,
    });
    try {
      db.exec(pkg.singleDerivedSql);
      expect(db.prepare('PRAGMA foreign_key_check').all().length === 0).toBe(true);
      const summary = {
        scope: '995313 SAFE STRUCTURE/AGGREGATES ONLY; RAM DECODE NOT REMOTE RESTORE',
        sourceBytes: bytes.length,
        sourceSha256: pkg.sourceExportSha256,
        derivedSha256: pkg.singleDerivedSha256,
        structure: describeOrderedImport(pkg.singleDerivedSql),
        canonicalGraph: inspectForeignKeyGraph(db),
        snapshotGraph: inspectForeignKeyGraph(db, true),
        phases: pkg.phases.map((p) => ({ ordinal: p.ordinal, sha256: p.sha256, bytes: p.bytes })),
        sourceArtifactChanged: false,
        backupWriterChanged: false,
        remoteCreated: 0,
        remoteIngest: 0,
      };
      writeFileSync(
        join(tmpdir(), 'mayi-995313-safe-structure.json'),
        JSON.stringify(summary, null, 2),
      );
    } finally {
      db.close();
    }
  },
);
