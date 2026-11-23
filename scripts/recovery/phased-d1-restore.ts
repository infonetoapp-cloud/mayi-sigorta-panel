import { createHash } from 'node:crypto';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareNativeD1Restore } from './prepare-native-restore';
import { iterateDerivedRestoreStatements } from './ordered-d1-import';
const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const digest = /^[a-f0-9]{64}$/u;
// Working packages are regenerated from verified native bytes, never executed
// from caller-supplied/deserialized SQL+hash pairs. Metadata alone is not custody.
const verifiedPackages = new WeakSet<object>();
const fail = (code: string): never => {
  throw new Error(code);
};
export interface RestorePhase {
  readonly ordinal: 1 | 2 | 3;
  readonly sql: string;
  readonly sha256: string;
  readonly bytes: number;
}
export interface PhasedRestorePackage {
  readonly format: 'DERIVED_LOCAL_RESTORE_PHASES_V1';
  readonly sourceExportSha256: string;
  readonly sourceObjectKey: string;
  readonly generation: string;
  readonly singleDerivedSha256: string;
  readonly singleDerivedSql: string;
  readonly phases: ReadonlyArray<RestorePhase>;
}
/** Transport only: verified immutable native source -> the SAME canonical decoder
 * -> deterministic partition. No backup, SQL rewrite algorithm, target or client.
 * All indexes are phase1: unique parent indexes can be required FK authority. */
export function preparePhasedD1Restore(source: Uint8Array, receipt: unknown): PhasedRestorePackage {
  const prepared = prepareNativeD1Restore(source, receipt);
  const schema: string[] = [],
    data: string[] = [],
    post: string[] = [];
  for (const statement of iterateDerivedRestoreStatements(prepared.sql)) {
    const t = statement.tokens.map((v) => v.toUpperCase());
    if (t[0] === 'PRAGMA') continue; // Canonical setup is placed at each relevant transaction boundary.
    if (t[0] === 'CREATE') {
      const kind = t[1] === 'UNIQUE' ? t[2] : t[1];
      if (kind === 'TABLE' || kind === 'INDEX') schema.push(statement.sql);
      else if (kind === 'TRIGGER' || kind === 'VIEW') post.push(statement.sql);
      else return fail('PHASE_SCHEMA_INVALID');
    } else if (t[0] === 'INSERT' || t.join(' ') === 'DELETE FROM SQLITE_SEQUENCE')
      data.push(statement.sql);
    else return fail('PHASE_STATEMENT_INVALID');
  }
  if (!schema.length || !data.length) return fail('PHASE_CONTENT_MISSING');
  // Keep deferral ON until the phase2 transaction commits. Turning it OFF can
  // clear pending violations on SQLite; OFF is NOT a substitute for FK readback.
  const bodies = [
    schema.join('\n'),
    'PRAGMA defer_foreign_keys=ON;\n' + data.join('\n'),
    post.length ? post.join('\n') : 'PRAGMA defer_foreign_keys=OFF;',
  ];
  const phases = bodies.map((body, i) => {
    const sql = `-- DERIVED LOCAL RECOVERY PHASE ${i + 1}; SOURCE_SHA256 ${prepared.sourceExportSha256}\n${body}`;
    return Object.freeze({
      ordinal: (i + 1) as 1 | 2 | 3,
      sql,
      sha256: sha(sql),
      bytes: Buffer.byteLength(sql),
    });
  });
  const package_ = Object.freeze({
    format: 'DERIVED_LOCAL_RESTORE_PHASES_V1' as const,
    sourceExportSha256: prepared.sourceExportSha256,
    sourceObjectKey: prepared.sourceObjectKey,
    generation: prepared.generation,
    singleDerivedSha256: prepared.derivedRestoreSha256,
    singleDerivedSql: prepared.sql,
    phases: Object.freeze(phases),
  });
  verifiedPackages.add(package_);
  return package_;
}
export interface LocalRecoveryTarget {
  readonly mode: string;
  readonly purpose: string;
  readonly accountId: string;
  readonly name: string;
  readonly uuid: string;
}
const targetIdentity = (target: LocalRecoveryTarget) => {
  if (
    target.mode !== 'LOCAL_ONLY' ||
    target.purpose !== 'DISPOSABLE_RECOVERY' ||
    !target.accountId ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(target.accountId) ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(target.name) ||
    !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u.test(target.uuid)
  )
    return fail('LOCAL_DISPOSABLE_TARGET_REQUIRED');
  if (target.name === 'mayisigorta-crm' || target.uuid === '1dd3b04e-14b8-459c-86d0-5c3c3ed8127d')
    return fail('PRODUCTION_TARGET_FORBIDDEN');
  return sha(
    JSON.stringify([target.mode, target.purpose, target.accountId, target.name, target.uuid]),
  );
};
function verifyPackage(p: PhasedRestorePackage, source: string) {
  if (!verifiedPackages.has(p)) return fail('PHASE_PACKAGE_NOT_VERIFIED');
  if (
    !digest.test(source) ||
    p.format !== 'DERIVED_LOCAL_RESTORE_PHASES_V1' ||
    p.sourceExportSha256 !== source ||
    p.phases.length !== 3 ||
    sha(p.singleDerivedSql) !== p.singleDerivedSha256
  )
    return fail('PHASE_PACKAGE_INVALID');
  for (let i = 0; i < 3; i++) {
    const phase = p.phases[i]!;
    if (
      phase.ordinal !== i + 1 ||
      phase.sha256 !== sha(phase.sql) ||
      phase.bytes !== Buffer.byteLength(phase.sql)
    )
      return fail('PHASE_IDENTITY_MISMATCH');
  }
  if (new Set(p.phases.map((p) => p.sha256)).size !== 3) return fail('PHASE_DUPLICATE');
}
export interface FinalLocalRestoreValidation {
  foreignKeyViolations: number;
  schemaExact: boolean;
  rowsExact: boolean;
  domainExact: boolean;
}
export interface PhaseLocalReadback {
  foreignKeyViolations: number;
  phaseStateExact: boolean;
}
/** LOCAL-only transaction sequencing, NOT remote compatibility proof. Callback
 * must finish its actual import/readback before resolving. Failures poison this
 * session: no retry or continuation, partial target stays sealed/disposable. */
export function createLocalPhaseSession(
  pkg: PhasedRestorePackage,
  target: LocalRecoveryTarget,
  expectedSourceSha: string,
) {
  verifyPackage(pkg, expectedSourceSha);
  const boundTarget = targetIdentity(target);
  const snapshot = pkg.phases.map((p) => Object.freeze({ ...p }));
  let next = 1,
    state: 'READY' | 'IN_FLIGHT' | 'FAILED' | 'AWAITING_VALIDATION' | 'VERIFIED_SEALED' = 'READY';
  const poison = (code: string): never => {
    state = 'FAILED';
    return fail(code);
  };
  const bind = (actual: LocalRecoveryTarget) => {
    if (targetIdentity(actual) !== boundTarget) return poison('PHASE_TARGET_CHANGED');
  };
  return Object.freeze({
    status: () => state,
    async runPhase(
      ordinal: number,
      actualTarget: LocalRecoveryTarget,
      phaseSha: string,
      sourceSha: string,
      execute: (sql: string) => Promise<void>,
      readback: () => Promise<PhaseLocalReadback>,
    ) {
      try {
        if (state !== 'READY') return poison('PHASE_NOT_READY');
        bind(actualTarget);
        if (
          ordinal !== next ||
          sourceSha !== expectedSourceSha ||
          phaseSha !== snapshot[next - 1]!.sha256
        )
          return poison('PHASE_ORDER_OR_IDENTITY_INVALID');
        state = 'IN_FLIGHT';
        await execute(snapshot[next - 1]!.sql);
        const checkpoint = await readback();
        if (checkpoint.foreignKeyViolations !== 0 || checkpoint.phaseStateExact !== true)
          return poison('PHASE_READBACK_FAILED');
        if ((state as string) !== 'IN_FLIGHT') return poison('PHASE_INTERRUPTED');
        next++;
        state = next === 4 ? 'AWAITING_VALIDATION' : 'READY';
      } catch (error) {
        state = 'FAILED';
        throw error;
      }
    },
    async validate(
      actualTarget: LocalRecoveryTarget,
      validate: () => Promise<FinalLocalRestoreValidation>,
    ) {
      try {
        if (state !== 'AWAITING_VALIDATION') return poison('FINAL_VALIDATION_NOT_READY');
        bind(actualTarget);
        state = 'IN_FLIGHT';
        const r = await validate();
        if (
          (state as string) !== 'IN_FLIGHT' ||
          r.foreignKeyViolations !== 0 ||
          r.schemaExact !== true ||
          r.rowsExact !== true ||
          r.domainExact !== true
        )
          return poison('FINAL_VALIDATION_FAILED');
        state = 'VERIFIED_SEALED';
        return Object.freeze({ ...r, publication: 'SEALED_NOT_REMOTE_PROVEN' as const });
      } catch (error) {
        state = 'FAILED';
        throw error;
      }
    },
  });
}
export async function withPhasedRestoreFiles<T>(
  pkg: PhasedRestorePackage,
  use: (paths: ReadonlyArray<string>) => Promise<T>,
) {
  verifyPackage(pkg, pkg.sourceExportSha256);
  const directory = mkdtempSync(join(tmpdir(), 'mayi-local-phased-restore-'));
  try {
    const paths = pkg.phases.map((p) => {
      const path = join(directory, `phase-${p.ordinal}.sql`);
      writeFileSync(path, p.sql, { flag: 'wx', mode: 0o600 });
      return path;
    });
    return await use(Object.freeze(paths));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}
