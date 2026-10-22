import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync } from 'node:fs';
import { join } from 'node:path';
import { lockRun } from './executor';
import { queryRestorePlan } from './query-restore-plan';
import { canonical, requireProof, sha256, type RecoveryQuery } from './executor-bundle';

const schemaSql =
  "SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT GLOB '_cf_*' AND name<>'sqlite_sequence' ORDER BY type,name";
async function fingerprint(query: RecoveryQuery) {
  const schema = await query(schemaSql);
  requireProof(schema.length <= 1000, 'QUERY_CHECKPOINT_LIMIT');
  const data: Array<{ table: string; rows: string[] }> = [];
  let total = 0;
  for (const row of schema.filter((r) => r.type === 'table')) {
    requireProof(
      typeof row.name === 'string' && /^[a-z][a-z0-9_]*$/.test(row.name),
      'QUERY_CHECKPOINT_TABLE_DENIED',
    );
    const rows = await query(`SELECT * FROM "${row.name}"`);
    total += rows.length;
    requireProof(total <= 10000, 'QUERY_CHECKPOINT_LIMIT');
    data.push({ table: row.name, rows: rows.map((r) => canonical(r)).sort() });
  }
  const serialized = JSON.stringify({ schema: schema.map((r) => canonical(r)), data });
  requireProof(Buffer.byteLength(serialized) <= 16 * 1024 * 1024, 'QUERY_CHECKPOINT_LIMIT');
  return sha256(serialized);
}

// This executor has no network client, credentials, create/delete or publication
// capability. A separately authorized owned-target adapter supplies atomic batches.
export async function runQueryRecovery(input: {
  directory: string;
  targetBinding: string;
  derived: string;
  authoritySql: string;
  recoverDeadLock?: boolean;
  verifyOnly?: boolean;
  query: RecoveryQuery;
  write: (name: string, batch: readonly { sql: string }[]) => Promise<void>;
}) {
  requireProof(
    input.targetBinding.length > 0 && input.targetBinding.length <= 512,
    'QUERY_TARGET_BINDING_REQUIRED',
  );
  const phases = queryRestorePlan(input.derived, input.authoritySql);
  // Revoke all restored sessions at the pinned authority timestamp before
  // membership triggers can stamp wall-clock time. This remains one atomic
  // authority batch, preserves prior forensic revocations, and makes exact
  // post-crash checkpoint verification deterministic.
  const authorityPhase = phases[3]!;
  const revokers = authorityPhase.batch.filter((row) =>
    /^UPDATE local_sessions SET revoked_at=COALESCE\(revoked_at,[0-9]+\);$/i.test(row.sql),
  );
  requireProof(revokers.length === 1, 'QUERY_SESSION_REVOCATION_REQUIRED');
  const epoch = Number(/,([0-9]+)\);$/.exec(revokers[0]!.sql)?.[1]);
  requireProof(Number.isSafeInteger(epoch) && epoch > 0, 'QUERY_AUTHORITY_TIME_REQUIRED');
  const issuedAt = new Date(epoch).toISOString();
  authorityPhase.batch = [
    ...revokers,
    ...authorityPhase.batch.filter((row) => row !== revokers[0]),
  ];
  // Grant defaults also use wall-clock time. Pin only the recreated grant's
  // metadata to the same authority instant; historical business rows stay exact.
  authorityPhase.batch = authorityPhase.batch.map((row) =>
    row.sql.startsWith(
      'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(',
    )
      ? {
          sql: row.sql
            .replace('scope) VALUES(', 'scope,created_at,updated_at) VALUES(')
            .replace(/\);$/, `,'${issuedAt}','${issuedAt}');`),
        }
      : row,
  );
  authorityPhase.sha256 = sha256(JSON.stringify({ batch: authorityPhase.batch }));
  const binding = sha256(
    JSON.stringify({ target: input.targetBinding, phases: phases.map((p) => p.sha256) }),
  );
  const expected: string[] = [];
  const reference = new DatabaseSync(':memory:', { allowExtension: false });
  try {
    expected.push(await fingerprint((sql) => reference.prepare(sql).all()));
    for (const phase of phases) {
      reference.exec('BEGIN;');
      for (const row of phase.batch) reference.exec(row.sql);
      reference.exec('COMMIT;');
      expected.push(await fingerprint((sql) => reference.prepare(sql).all()));
    }
  } finally {
    reference.close();
  }
  const unlock = lockRun(input.directory, input.recoverDeadLock === true);
  let journal: DatabaseSync | undefined;
  try {
    const path = join(input.directory, 'query-phases.sqlite');
    requireProof(
      !existsSync(path) || (lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink()),
      'QUERY_JOURNAL_DENIED',
    );
    journal = new DatabaseSync(path, { allowExtension: false });
    journal.exec(
      "PRAGMA synchronous=FULL;CREATE TABLE IF NOT EXISTS binding(id INTEGER PRIMARY KEY CHECK(id=1),value TEXT NOT NULL);CREATE TABLE IF NOT EXISTS phases(ordinal INTEGER PRIMARY KEY,state TEXT NOT NULL CHECK(state IN ('INTENT','CONFIRMED')),hash TEXT NOT NULL);",
    );
    const before = journal.prepare('SELECT value FROM binding WHERE id=1').get();
    if (before) requireProof(before.value === binding, 'QUERY_RUN_BINDING_MISMATCH');
    else journal.prepare('INSERT INTO binding VALUES(1,?)').run(binding);
    const rows = journal.prepare('SELECT ordinal,state,hash FROM phases ORDER BY ordinal').all();
    requireProof(
      rows.length <= phases.length &&
        rows.every(
          (row, i) =>
            row.ordinal === i &&
            row.hash === phases[i]!.sha256 &&
            (row.state === 'CONFIRMED' || i === rows.length - 1),
        ),
      'QUERY_JOURNAL_INVALID',
    );
    let completed = rows.length;
    const actual = await fingerprint(input.query);
    if (rows.at(-1)?.state === 'INTENT') {
      requireProof(actual === expected[completed], 'QUERY_PHASE_RESULT_UNKNOWN');
      journal
        .prepare("UPDATE phases SET state='CONFIRMED' WHERE ordinal=? AND state='INTENT'")
        .run(completed - 1);
    } else requireProof(actual === expected[completed], 'QUERY_CHECKPOINT_MISMATCH');
    if (input.verifyOnly)
      return {
        publication: 'SEALED' as const,
        phasesConfirmed: completed,
        targetBinding: input.targetBinding,
      };
    for (; completed < phases.length; completed++) {
      const phase = phases[completed]!;
      journal.prepare("INSERT INTO phases VALUES(?,'INTENT',?)").run(completed, phase.sha256);
      try {
        await input.write(phase.name, phase.batch);
        requireProof(
          (await fingerprint(input.query)) === expected[completed + 1],
          'QUERY_CHECKPOINT_MISMATCH',
        );
      } catch {
        // The durable INTENT identifies the phase. Never attach raw adapter
        // errors here: SQLite/provider messages may contain SQL and secrets.
        throw new Error('QUERY_PHASE_RESULT_UNKNOWN');
      }
      journal
        .prepare("UPDATE phases SET state='CONFIRMED' WHERE ordinal=? AND state='INTENT'")
        .run(completed);
    }
    return {
      publication: 'SEALED' as const,
      phasesConfirmed: completed,
      targetBinding: input.targetBinding,
    };
  } finally {
    journal?.close();
    unlock();
  }
}
