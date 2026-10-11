// @vitest-environment node
import { expect, it } from 'vitest';
import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  preparePhasedD1Restore,
  createLocalPhaseSession,
  withPhasedRestoreFiles,
} from '../scripts/recovery/phased-d1-restore';
import { inspectForeignKeyGraph, describeOrderedImport } from '../scripts/recovery/schema-graph';
import { receiptFor } from './support/native-source-receipt';
import { existsSync, readFileSync } from 'node:fs';
const source =
  "PRAGMA defer_foreign_keys=ON;CREATE TABLE child(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES parent(id) ON DELETE RESTRICT);INSERT INTO child VALUES(1,1);CREATE TABLE parent(id INTEGER PRIMARY KEY);INSERT INTO parent VALUES(1);CREATE UNIQUE INDEX parent_id_unique ON parent(id);CREATE TRIGGER child_guard BEFORE INSERT ON child BEGIN SELECT RAISE(ABORT,'guard');END;CREATE VIEW child_view AS SELECT id FROM child;";
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const target = {
  mode: 'LOCAL_ONLY',
  purpose: 'DISPOSABLE_RECOVERY',
  accountId: 'synthetic-account',
  name: 'synthetic-recovery-target',
  uuid: '00000000-0000-4000-8000-000000000987',
} as const;
function setup() {
  const package_ = preparePhasedD1Restore(Buffer.from(source), receiptFor(source));
  return {
    package_,
    session: createLocalPhaseSession(package_, target, sha(source)),
    db: new DatabaseSync(':memory:'),
  };
}
const validation = {
  foreignKeyViolations: 0,
  schemaExact: true,
  rowsExact: true,
  domainExact: true,
};
const checkpoint = async () => ({ foreignKeyViolations: 0, phaseStateExact: true });
it('generic support reproducer has local raw ordering failure and accepted ordered success, not D1_RESET_DO', () => {
  const native = readFileSync('scripts/recovery/fixtures/provider-import-synthetic.sql', 'utf8');
  const raw = new DatabaseSync(':memory:');
  try {
    expect(() => raw.exec(native)).toThrow('no such table');
  } finally {
    raw.close();
  }
  const pkg = preparePhasedD1Restore(Buffer.from(native), receiptFor(native));
  const db = new DatabaseSync(':memory:');
  try {
    for (const phase of pkg.phases) db.exec(`BEGIN;${phase.sql}COMMIT;`);
    expect(db.prepare('PRAGMA foreign_key_check').all().length).toBe(0);
    expect(db.prepare('SELECT count(*) AS n FROM entry_view').get()!.n).toBe(1);
  } finally {
    db.close();
  }
});

it('derives deterministic three-phase transport from one verified immutable source', () => {
  const a = preparePhasedD1Restore(Buffer.from(source), receiptFor(source)),
    b = preparePhasedD1Restore(Buffer.from(source), receiptFor(source));
  expect(a.sourceExportSha256 === sha(source)).toBe(true);
  expect(a.phases.map((p) => p.sha256)).toEqual(b.phases.map((p) => p.sha256));
  expect(new Set(a.phases.map((p) => p.sha256)).size).toBe(3);
  expect(a.phases[0]!.sql.includes('CREATE UNIQUE INDEX')).toBe(true);
  expect(a.phases[0]!.sql.includes('INSERT INTO')).toBe(false);
  expect(a.phases[1]!.sql.includes('CREATE TRIGGER')).toBe(false);
  expect(a.phases[2]!.sql.includes('CREATE VIEW')).toBe(true);
  expect(() =>
    preparePhasedD1Restore(Buffer.from(source), {
      ...receiptFor(source),
      sourceExportSha256: '0'.repeat(64),
    }),
  ).toThrow();
});
it('restores child-parent graph with post-load triggers/views and final mandatory validation', async () => {
  const { package_, session, db } = setup();
  try {
    for (const phase of package_.phases)
      await session.runPhase(
        phase.ordinal,
        target,
        phase.sha256,
        sha(source),
        async (sql) => {
          db.exec(`BEGIN;${sql}COMMIT;`);
        },
        async () => ({
          foreignKeyViolations: db.prepare('PRAGMA foreign_key_check').all().length,
          phaseStateExact: true,
        }),
      );
    expect(session.status()).toBe('AWAITING_VALIDATION');
    await session.validate(target, async () => ({
      ...validation,
      foreignKeyViolations: db.prepare('PRAGMA foreign_key_check').all().length,
    }));
    expect(session.status()).toBe('VERIFIED_SEALED');
    expect(db.prepare('SELECT count(*) AS n FROM child_view').get()!.n).toBe(1);
    expect(() => db.exec('INSERT INTO child VALUES(2,1)')).toThrow('guard');
  } finally {
    db.close();
  }
});
it.each(['wrong-order', 'wrong-target', 'wrong-source', 'wrong-phase-hash'] as const)(
  'blocks %s before any executor and permanently seals failure',
  async (kind) => {
    const { package_, session, db } = setup();
    let calls = 0;
    try {
      const phase = package_.phases[0]!;
      await expect(
        session.runPhase(
          kind === 'wrong-order' ? 2 : 1,
          kind === 'wrong-target'
            ? { ...target, uuid: '00000000-0000-4000-8000-000000000988' }
            : target,
          kind === 'wrong-phase-hash' ? '0'.repeat(64) : phase.sha256,
          kind === 'wrong-source' ? '0'.repeat(64) : sha(source),
          async () => {
            calls++;
          },
          checkpoint,
        ),
      ).rejects.toThrow();
      expect(calls).toBe(0);
      expect(session.status()).toBe('FAILED');
      await expect(
        session.runPhase(
          1,
          target,
          phase.sha256,
          sha(source),
          async () => {
            calls++;
          },
          checkpoint,
        ),
      ).rejects.toThrow();
      expect(calls).toBe(0);
    } finally {
      db.close();
    }
  },
);
it('failed or duplicate phase prevents all continuation and validation', async () => {
  const { package_, session, db } = setup();
  try {
    await expect(
      session.runPhase(
        1,
        target,
        package_.phases[0]!.sha256,
        sha(source),
        async () => {
          throw new Error('SYNTHETIC_IMPORT_FAILED');
        },
        checkpoint,
      ),
    ).rejects.toThrow();
    await expect(
      session.runPhase(
        2,
        target,
        package_.phases[1]!.sha256,
        sha(source),
        async () => undefined,
        checkpoint,
      ),
    ).rejects.toThrow();
    await expect(session.validate(target, async () => validation)).rejects.toThrow();
    const second = createLocalPhaseSession(package_, target, sha(source));
    await second.runPhase(
      1,
      target,
      package_.phases[0]!.sha256,
      sha(source),
      async () => undefined,
      checkpoint,
    );
    await expect(
      second.runPhase(
        1,
        target,
        package_.phases[0]!.sha256,
        sha(source),
        async () => undefined,
        checkpoint,
      ),
    ).rejects.toThrow();
    expect(second.status()).toBe('FAILED');
  } finally {
    db.close();
  }
});
it('rejects missing/malformed phases, non-local or production target and incomplete final validation', async () => {
  const { package_, session, db } = setup();
  try {
    expect(() =>
      createLocalPhaseSession(
        { ...package_, phases: package_.phases.slice(0, 2) },
        target,
        sha(source),
      ),
    ).toThrow();
    expect(() =>
      createLocalPhaseSession(
        {
          ...package_,
          phases: [{ ...package_.phases[0]!, sql: 'SELECT 1;' }, ...package_.phases.slice(1)],
        },
        target,
        sha(source),
      ),
    ).toThrow();
    for (const t of [
      { ...target, mode: 'REMOTE' },
      { ...target, name: 'mayisigorta-crm' },
      { ...target, uuid: '1dd3b04e-14b8-459c-86d0-5c3c3ed8127d' },
    ])
      expect(() => createLocalPhaseSession(package_, t, sha(source))).toThrow();
    await expect(session.validate(target, async () => validation)).rejects.toThrow();
    const fresh = createLocalPhaseSession(package_, target, sha(source));
    for (const phase of package_.phases)
      await fresh.runPhase(
        phase.ordinal,
        target,
        phase.sha256,
        sha(source),
        async () => undefined,
        checkpoint,
      );
    await expect(
      fresh.validate(target, async () => ({ ...validation, foreignKeyViolations: 1 })),
    ).rejects.toThrow();
    expect(fresh.status()).toBe('FAILED');
  } finally {
    db.close();
  }
});
it('rejects rehashed forged phase content before any execution', () => {
  const { package_, db } = setup();
  try {
    const sql = 'SELECT 1;';
    const forged = {
      ...package_,
      phases: package_.phases.map((p, i) =>
        i === 1 ? { ...p, sql, sha256: sha(sql), bytes: Buffer.byteLength(sql) } : p,
      ),
    };
    expect(() => createLocalPhaseSession(forged, target, sha(source))).toThrow();
  } finally {
    db.close();
  }
});

it('readback failure and in-flight duplicate permanently stop later phases', async () => {
  const { package_, db } = setup();
  try {
    const s = createLocalPhaseSession(package_, target, sha(source));
    await expect(
      s.runPhase(
        1,
        target,
        package_.phases[0]!.sha256,
        sha(source),
        async () => undefined,
        async () => ({ foreignKeyViolations: 1, phaseStateExact: true }),
      ),
    ).rejects.toThrow();
    expect(s.status()).toBe('FAILED');
    const concurrent = createLocalPhaseSession(package_, target, sha(source));
    let release!: () => void;
    const blocked = new Promise<void>((r) => {
      release = r;
    });
    const first = concurrent.runPhase(
      1,
      target,
      package_.phases[0]!.sha256,
      sha(source),
      async () => blocked,
      checkpoint,
    );
    await expect(
      concurrent.runPhase(
        1,
        target,
        package_.phases[0]!.sha256,
        sha(source),
        async () => undefined,
        checkpoint,
      ),
    ).rejects.toThrow();
    release();
    await expect(first).rejects.toThrow();
    expect(concurrent.status()).toBe('FAILED');
  } finally {
    db.close();
  }
});

it('cyclic populated FK graph restores under phase2 transaction deferral', () => {
  const native =
    'CREATE TABLE first_node(id INTEGER PRIMARY KEY,other INTEGER REFERENCES second_node(id));INSERT INTO first_node VALUES(1,2);CREATE TABLE second_node(id INTEGER PRIMARY KEY,other INTEGER REFERENCES first_node(id));INSERT INTO second_node VALUES(2,1);';
  const p = preparePhasedD1Restore(Buffer.from(native), receiptFor(native));
  const db = new DatabaseSync(':memory:');
  try {
    for (const phase of p.phases) db.exec(`BEGIN;${phase.sql}COMMIT;`);
    expect(db.prepare('PRAGMA foreign_key_check').all().length).toBe(0);
    expect(inspectForeignKeyGraph(db, true).cycles).toEqual([['first_node', 'second_node']]);
  } finally {
    db.close();
  }
});

it('cleans temporary phase files on failed handoff', async () => {
  const package_ = preparePhasedD1Restore(Buffer.from(source), receiptFor(source));
  let paths: string[] = [];
  await expect(
    withPhasedRestoreFiles(package_, async (p) => {
      paths = [...p];
      expect(p.length).toBe(3);
      throw new Error('HANDOFF_FAILED');
    }),
  ).rejects.toThrow('HANDOFF_FAILED');
  expect(paths.every((p) => !existsSync(p))).toBe(true);
});
it('reports safe FK graph, RESTRICT edges and cycles without row values', () => {
  const db = new DatabaseSync(':memory:');
  try {
    db.exec(
      'CREATE TABLE parent(id INTEGER PRIMARY KEY);CREATE TABLE child(id INTEGER PRIMARY KEY,parent_id INTEGER REFERENCES parent(id) ON DELETE RESTRICT);',
    );
    const g = inspectForeignKeyGraph(db);
    expect(g.cycles).toEqual([]);
    expect(
      g.parentFirstOrder !== null &&
        g.parentFirstOrder.indexOf('parent') < g.parentFirstOrder.indexOf('child'),
    ).toBe(true);
    expect(g.restrictConstraints).toBe(1);
    db.exec(
      'CREATE TABLE first_node(id INTEGER PRIMARY KEY,other INTEGER REFERENCES second_node(id));CREATE TABLE second_node(id INTEGER PRIMARY KEY,other INTEGER REFERENCES first_node(id));',
    );
    const cycles = inspectForeignKeyGraph(db);
    expect(cycles.cycles.some((c) => c.join(',') === 'first_node,second_node')).toBe(true);
    expect(cycles.parentFirstOrder).toBe(null);
  } finally {
    db.close();
  }
});
it('describes only safe ordered structure and preserves phase data int64/blob/text values', () => {
  const native =
    "CREATE TABLE scalar_values(id INTEGER PRIMARY KEY,t,b,i,n);INSERT INTO scalar_values VALUES(1,'İ雪 O''Brien',X'00ff',9223372036854775807,NULL);CREATE VIEW scalar_view AS SELECT id FROM scalar_values;";
  const package_ = preparePhasedD1Restore(Buffer.from(native), receiptFor(native));
  const info = describeOrderedImport(package_.singleDerivedSql);
  expect(info.createTables).toBe(1);
  expect(info.insertStatements).toBe(1);
  expect(info.views).toBe(1);
  expect(info.triggerDuringDataLoad).toBe(false);
  const db = new DatabaseSync(':memory:');
  try {
    for (const phase of package_.phases) db.exec(`BEGIN;${phase.sql}COMMIT;`);
    expect(
      db.prepare('SELECT CAST(i AS TEXT) AS i,hex(b) AS b,n FROM scalar_values').get(),
    ).toEqual({ i: '9223372036854775807', b: '00FF', n: null });
  } finally {
    db.close();
  }
});
