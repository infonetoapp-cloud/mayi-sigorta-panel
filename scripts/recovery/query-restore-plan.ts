import { splitNativeExportStatements } from './ordered-d1-import';
import { requireProof, sha256 } from './executor-bundle';

// Recovery-only deterministic plan; not a network executor or live capability.
export function queryRestorePlan(derived: string, authority: string) {
  const phases = [
    { name: 'schema', batch: [] as Array<{ sql: string }> },
    { name: 'data', batch: [{ sql: 'PRAGMA defer_foreign_keys=ON;' }] },
    { name: 'guards', batch: [] as Array<{ sql: string }> },
    { name: 'authority', batch: [] as Array<{ sql: string }> },
  ];
  for (const statement of splitNativeExportStatements(derived)) {
    const head = statement.tokens.slice(0, 2).map((t) => t.toUpperCase());
    if (head[0] === 'PRAGMA') {
      requireProof(
        /^PRAGMA defer_foreign_keys=(?:ON|OFF);$/i.test(statement.sql),
        'QUERY_PLAN_PRAGMA_DENIED',
      );
      continue;
    }
    const ordinal =
      head[0] === 'CREATE'
        ? ['TABLE', 'INDEX'].includes(head[1]!) ||
          (head[1] === 'UNIQUE' && statement.tokens[2]?.toUpperCase() === 'INDEX')
          ? 0
          : ['TRIGGER', 'VIEW'].includes(head[1]!)
            ? 2
            : -1
        : head[0] === 'INSERT' || /^DELETE FROM sqlite_sequence;$/i.test(statement.sql)
          ? 1
          : -1;
    requireProof(
      ordinal >= 0 && Buffer.byteLength(statement.sql) <= 100000,
      'QUERY_PLAN_STATEMENT_DENIED',
    );
    phases[ordinal]!.batch.push({ sql: statement.sql });
  }
  phases[1]!.batch.push({ sql: 'PRAGMA defer_foreign_keys=OFF;' });
  for (const statement of splitNativeExportStatements(authority)) {
    requireProof(
      ['UPDATE', 'DELETE', 'INSERT'].includes(statement.tokens[0]!.toUpperCase()),
      'QUERY_PLAN_AUTHORITY_DENIED',
    );
    phases[3]!.batch.push({ sql: statement.sql });
  }
  return phases.map((phase) => {
    requireProof(phase.batch.length > 0 && phase.batch.length <= 256, 'QUERY_PLAN_BATCH_LIMIT');
    const payload = JSON.stringify({ batch: phase.batch });
    requireProof(Buffer.byteLength(payload) <= 2 * 1024 * 1024, 'QUERY_PLAN_BYTE_LIMIT');
    return { ...phase, sha256: sha256(payload), bytes: Buffer.byteLength(payload) };
  });
}
