import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  existsSync,
  lstatSync,
  readFileSync,
  writeFileSync,
  unlinkSync,
  openSync,
  closeSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import {
  canonical,
  sha256,
  requireProof,
  readRecoveryBundle,
  readCurrentAuthority,
  verifyRecoverySnapshot,
  verifyCurrentAuthority,
  type RecoveryBundle,
  type CurrentAuthority,
} from './executor-bundle';

import { sanitizeImportDiagnostic } from './d1-import-diagnostics';
export { retainSyntheticBundle } from './executor-bundle';

// Intentionally NO fetch, Cloudflare client, credential loader, Wrangler/config
// reader or remote transport in this local facade. Use the separate provider CLI
// and its in-process interactive capability for a separately authorized drill.
export const RECOVERY_TARGET_NAME = 'mayisigorta-ops001-restore-gatec-44c314b-01';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const targetSchema = z.strictObject({
  accountId: z.literal('af9fc98cb8d5f5508d58057bc794d863'),
  name: z.literal(RECOVERY_TARGET_NAME),
  uuid: z
    .string()
    .uuid()
    .refine((id) => id !== '1dd3b04e-14b8-459c-86d0-5c3c3ed8127d' && !id.startsWith('00000000-')),
  jurisdiction: z.literal('eu'),
  createdAt: z.iso.datetime(),
});
export type RecoveryTarget = z.infer<typeof targetSchema>;
const approvalSchema = z.strictObject({
  kind: z.literal('OWNER_REMOTE_RECOVERY_APPROVAL_V1'),
  owner: z.string().trim().min(1).max(100),
  target: targetSchema,
  manifestSha256: hash,
  authoritySha256: hash,
  notBefore: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  allowImport: z.literal(true),
  allowOwnedCleanup: z.literal(true),
  allowProviderManagedStaging: z.literal(true),
  allowProduction: z.literal(false),
  allowDeploy: z.literal(false),
});
const faults = [
  'none',
  'importTimeout',
  'partialImport',
  'afterImportEffect',
  'corruptMoney',
  'reconcileFailure',
  'afterReconcileEffect',
  'deleteUnknown',
  'afterDeleteEffect',
  'wrongIdentity',
] as const;
const optionsSchema = z.strictObject({
  mode: z.enum(['OFFLINE_DRY_RUN', 'SIMULATE_LOCAL', 'EXECUTE_REMOTE']).default('OFFLINE_DRY_RUN'),
  bundleDirectory: z.string().optional(),
  manifestSha256: hash.optional(),
  authorityPath: z.string().optional(),
  authoritySha256: hash.optional(),
  runDirectory: z.string().optional(),
  target: targetSchema.optional(),
  action: z.enum(['restore', 'cleanup']).default('restore'),
  simulationFault: z.enum(faults).default('none'),
  recoverDeadLock: z.boolean().default(false),
  authorization: approvalSchema.optional(),
});
type State =
  | 'READY'
  | 'IMPORT_INTENT'
  | 'IMPORTED'
  | 'VERIFIED'
  | 'AUTHORITY_INTENT'
  | 'RECONCILED'
  | 'DELETE_INTENT'
  | 'CLEANED';
export interface RecoveryResult {
  code: string;
  remoteOperations: 0;
  mode: string;
  state?: State;
  sqlVerification?: unknown;
  apiAuthorization: 'NOT_EXECUTED';
  publication: 'SEALED';
  importAttempts?: number;
  deleteAttempts?: number;
  backupAgeMs?: { min: number; max: number };
  diagnostic?: { category: string; rawDiagnosticSha256: string };
}
function result(code: string, mode: string, extra: Partial<RecoveryResult> = {}): RecoveryResult {
  return {
    code,
    mode,
    remoteOperations: 0,
    apiAuthorization: 'NOT_EXECUTED',
    publication: 'SEALED',
    ...extra,
  };
}
function safeFailure(error: unknown) {
  const raw = error instanceof Error ? error.message : 'UNKNOWN_FAILURE';
  const known = new Set([
    'BUNDLE_MANIFEST_HASH_MISMATCH',
    'BUNDLE_FILE_HASH_MISMATCH',
    'DERIVED_SQL_MISMATCH',
    'SYNTHETIC_SOURCE_REQUIRED',
    'SNAPSHOT_TIME_INVALID',
    'AUTHORITY_HASH_MISMATCH',
    'CURRENT_AUTHORITY_REQUIRED',
    'AUTHORITY_VERSION_INVALID',
    'TARGET_IDENTITY_MISMATCH',
    'RUN_BINDING_MISMATCH',
    'RUN_LOCKED',
    'LOCK_RECOVERY_DENIED',
    'IMPORT_RESULT_UNKNOWN',
    'RESTORE_ROWS_MISMATCH',
    'SCHEMA_MISMATCH',
    'ROW_TOTAL_MISMATCH',
    'FOREIGN_KEY_INVALID',
    'CONSISTENCY_FAILED',
    'MIGRATION_HISTORY_MISMATCH',
    'MONETARY_INTEGRITY_FAILED',
    'RECEIPT_AUDIT_INCONSISTENT',
    'REVOCATION_RECONCILIATION_FAILED',
    'SESSION_RECONCILIATION_FAILED',
    'CREDENTIAL_RECONCILIATION_FAILED',
    'GRANT_RECONCILIATION_FAILED',
    'CLEANUP_NOT_AUTHORIZED',
    'DELETE_RESULT_UNKNOWN',
    'DELETE_ALREADY_ATTEMPTED',
    'IMPORT_ALREADY_ATTEMPTED',
    'OPERATION_BUDGET_EXCEEDED',
    'LOCAL_TARGET_FILE_DENIED',
    'RUN_STATE_INVALID',
    'SIMULATED_INTERRUPTION',
    'RUN_DIRECTORY_REQUIRED',
  ]);
  return {
    code: known.has(raw) ? raw : 'RECOVERY_VALIDATION_FAILED',
    diagnostic: {
      category: sanitizeImportDiagnostic(raw).category,
      rawDiagnosticSha256: sha256(raw),
    },
  };
}
function regular(path: string) {
  requireProof(
    !existsSync(path) || (lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink()),
    'LOCAL_TARGET_FILE_DENIED',
  );
}
export function lockRun(directory: string, recover: boolean) {
  const path = join(directory, 'executor.lock');
  if (existsSync(path) && recover) {
    regular(path);
    requireProof(lstatSync(path).size < 1024, 'LOCK_RECOVERY_DENIED');
    const old = readFileSync(path, 'utf8'),
      row = JSON.parse(old) as { pid: number };
    requireProof(Number.isSafeInteger(row.pid) && row.pid > 0, 'LOCK_RECOVERY_DENIED');
    let dead = false;
    try {
      process.kill(row.pid, 0);
    } catch (error) {
      dead = (error as NodeJS.ErrnoException).code === 'ESRCH';
    }
    requireProof(dead && readFileSync(path, 'utf8') === old, 'LOCK_RECOVERY_DENIED');
    unlinkSync(path);
  }
  let fd: number;
  try {
    fd = openSync(path, 'wx', 0o600);
  } catch {
    throw new Error('RUN_LOCKED');
  }
  const body = JSON.stringify({ pid: process.pid, nonce: randomUUID() });
  writeFileSync(fd, body);
  closeSync(fd);
  return () => {
    if (existsSync(path) && readFileSync(path, 'utf8') === body) unlinkSync(path);
  };
}
class Journal {
  readonly db: DatabaseSync;
  constructor(
    directory: string,
    binding: string,
    readonly maxOperations: number,
  ) {
    const path = join(directory, 'journal.sqlite');
    regular(path);
    this.db = new DatabaseSync(path, { allowExtension: false });
    try {
      this.db.exec(
        'PRAGMA synchronous=FULL;CREATE TABLE IF NOT EXISTS control(id INTEGER PRIMARY KEY CHECK(id=1),binding TEXT NOT NULL,state TEXT NOT NULL,import_attempts INTEGER NOT NULL,delete_attempts INTEGER NOT NULL,operations INTEGER NOT NULL,started_at INTEGER NOT NULL);CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY,operation TEXT NOT NULL,outcome TEXT NOT NULL,at TEXT NOT NULL,elapsed_ms REAL,error_code TEXT,diagnostic_sha256 TEXT);',
      );
      this.db
        .prepare("INSERT OR IGNORE INTO control VALUES(1,?,'READY',0,0,0,?)")
        .run(binding, Date.now());
      requireProof(this.row().binding === binding, 'RUN_BINDING_MISMATCH');
    } catch (error) {
      this.db.close();
      throw error;
    }
  }
  row() {
    return this.db.prepare('SELECT * FROM control WHERE id=1').get() as {
      binding: string;
      state: State;
      import_attempts: number;
      delete_attempts: number;
      operations: number;
      started_at: number;
    };
  }
  event(
    operation: 'identity' | 'import' | 'verify' | 'reconcile' | 'cleanup',
    outcome: 'INTENT' | 'COMPLETE' | 'UNKNOWN' | 'FAILED' | 'READBACK',
    elapsed: number | null = null,
    errorCode: string | null = null,
    diagnosticSha256: string | null = null,
  ) {
    requireProof(this.row().operations < this.maxOperations, 'OPERATION_BUDGET_EXCEEDED');
    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db
        .prepare(
          'INSERT INTO events(operation,outcome,at,elapsed_ms,error_code,diagnostic_sha256) VALUES(?,?,?,?,?,?)',
        )
        .run(operation, outcome, new Date().toISOString(), elapsed, errorCode, diagnosticSha256);
      this.db.exec('UPDATE control SET operations=operations+1 WHERE id=1;COMMIT;');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }
  state(state: State) {
    this.db.prepare('UPDATE control SET state=? WHERE id=1').run(state);
  }
  intent(kind: 'import' | 'delete') {
    const column = kind === 'import' ? 'import_attempts' : 'delete_attempts';
    requireProof(
      this.row()[column] === 0,
      kind === 'import' ? 'IMPORT_ALREADY_ATTEMPTED' : 'DELETE_ALREADY_ATTEMPTED',
    );
    this.db
      .prepare(`UPDATE control SET ${column}=1,state=? WHERE id=1`)
      .run(kind === 'import' ? 'IMPORT_INTENT' : 'DELETE_INTENT');
  }
}
function checkIdentity(directory: string, target: RecoveryTarget) {
  const path = join(directory, 'owned-identity.json');
  regular(path);
  requireProof(existsSync(path) && lstatSync(path).size <= 2048, 'TARGET_IDENTITY_MISMATCH');
  const metadata = JSON.parse(readFileSync(path, 'utf8'));
  requireProof(
    canonical(targetSchema.parse(metadata)) === canonical(target),
    'TARGET_IDENTITY_MISMATCH',
  );
}
function openTarget(directory: string) {
  const path = join(directory, 'target.sqlite');
  regular(path);
  requireProof(existsSync(path), 'IMPORT_RESULT_UNKNOWN');
  return new DatabaseSync(path, { allowExtension: false });
}
function applyAuthority(db: DatabaseSync, authority: CurrentAuthority, fault: boolean) {
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const row of authority.memberships)
      db.prepare(
        'UPDATE agency_memberships SET status=?,suspended_at=?,permission_version=?,version=? WHERE id=? AND version<>?',
      ).run(row.status, row.suspended_at, row.permission_version, row.version, row.id, row.version);
    db.exec(
      "DELETE FROM membership_permissions WHERE membership_id='synthetic-membership-permanent'",
    );
    for (const row of authority.grants)
      db.prepare(
        'INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(?,?,?,?)',
      ).run(row.id, row.membership_id, row.permission_code, row.scope);
    db.prepare('UPDATE local_sessions SET revoked_at=COALESCE(revoked_at,?)').run(Date.now());
    // This fixture has no live sensitive grants or tombstones. Nonempty inputs deny.
    requireProof(
      db.prepare('SELECT count(*) AS n FROM sensitive_action_grants').get()?.n === 0,
      'GRANT_RECONCILIATION_FAILED',
    );
    if (fault) throw new Error('REVOCATION_RECONCILIATION_FAILED');
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
async function inspectSnapshot(directory: string, bundle: RecoveryBundle) {
  const db = openTarget(directory);
  try {
    return await verifyRecoverySnapshot((sql) => db.prepare(sql).all(), bundle);
  } finally {
    db.close();
  }
}
async function inspectAuthority(
  directory: string,
  authority: CurrentAuthority,
  bundle: RecoveryBundle,
) {
  const db = openTarget(directory);
  try {
    return await verifyCurrentAuthority((sql) => db.prepare(sql).all(), authority, bundle);
  } finally {
    db.close();
  }
}
export async function runRecovery(input: unknown = {}): Promise<RecoveryResult> {
  let mode = 'OFFLINE_DRY_RUN';
  let journal: Journal | undefined;
  let unlock: (() => void) | undefined;
  try {
    // No input object can supply a client/callback or downgrade the offline boundary.
    const options = optionsSchema.parse(input);
    mode = options.mode;
    if (mode === 'EXECUTE_REMOTE') {
      if (!options.authorization) return result('REMOTE_AUTHORIZATION_REQUIRED', mode);
      const approval = options.authorization;
      requireProof(
        options.target &&
          canonical(approval.target) === canonical(options.target) &&
          approval.manifestSha256 === options.manifestSha256 &&
          approval.authoritySha256 === options.authoritySha256 &&
          Date.parse(approval.notBefore) <= Date.now() &&
          Date.parse(approval.expiresAt) > Date.now() &&
          Date.parse(approval.expiresAt) - Date.parse(approval.notBefore) <= 15 * 60 * 1000,
        'REMOTE_APPROVAL_BINDING_INVALID',
      );
      return result('REMOTE_PROVIDER_CLI_REQUIRED', mode);
    }
    if (!options.bundleDirectory) return result('OFFLINE_DRY_RUN', mode);
    requireProof(
      options.manifestSha256 && options.authorityPath && options.authoritySha256,
      'CURRENT_AUTHORITY_REQUIRED',
    );
    const bundle = readRecoveryBundle(options.bundleDirectory, options.manifestSha256);
    const authority = readCurrentAuthority(options.authorityPath, options.authoritySha256, bundle);
    const age = {
      min: Date.now() - Date.parse(bundle.manifest.snapshotCompletedAt),
      max: Date.now() - Date.parse(bundle.manifest.snapshotStartedAt),
    };
    requireProof(age.min >= 0, 'SNAPSHOT_TIME_INVALID');
    const sourceDb = new DatabaseSync(':memory:', {
      enableForeignKeyConstraints: false,
      allowExtension: false,
    });
    let sourceVerification;
    try {
      sourceDb.exec(bundle.derived);
      sourceVerification = await verifyRecoverySnapshot(
        (sql) => sourceDb.prepare(sql).all(),
        bundle,
      );
    } finally {
      sourceDb.close();
    }
    if (mode === 'OFFLINE_DRY_RUN')
      return result('OFFLINE_DRY_RUN', mode, {
        sqlVerification: sourceVerification,
        backupAgeMs: age,
      });
    requireProof(options.runDirectory && options.target, 'RUN_DIRECTORY_REQUIRED');
    requireProof(Date.parse(options.target.createdAt) <= Date.now(), 'TARGET_IDENTITY_MISMATCH');
    const directory = resolve(options.runDirectory),
      target = structuredClone(options.target);
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
    requireProof(
      lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(),
      'LOCAL_TARGET_FILE_DENIED',
    );
    unlock = lockRun(directory, options.recoverDeadLock);
    const fresh = !existsSync(join(directory, 'journal.sqlite'));
    requireProof(
      !fresh ||
        (!existsSync(join(directory, 'target.sqlite')) &&
          !existsSync(join(directory, 'owned-identity.json'))),
      'TARGET_IDENTITY_MISMATCH',
    );
    journal = new Journal(
      directory,
      sha256(
        canonical({ target, manifest: options.manifestSha256, authority: options.authoritySha256 }),
      ),
      options.action === 'cleanup' ? 320 : 300,
    );
    if (options.action === 'restore')
      requireProof(
        Date.now() >= journal.row().started_at &&
          Date.now() - journal.row().started_at < 15 * 60 * 1000,
        'OPERATION_BUDGET_EXCEEDED',
      );
    if (fresh)
      writeFileSync(join(directory, 'owned-identity.json'), canonical(target), {
        flag: 'wx',
        mode: 0o600,
      });
    if (options.simulationFault === 'wrongIdentity') throw new Error('TARGET_IDENTITY_MISMATCH');
    checkIdentity(directory, target);
    journal.event('identity', 'READBACK');
    let state = journal.row().state;
    if (options.action === 'cleanup') {
      const cleanupStarted = performance.now();
      requireProof(
        [
          'IMPORT_INTENT',
          'IMPORTED',
          'VERIFIED',
          'AUTHORITY_INTENT',
          'RECONCILED',
          'DELETE_INTENT',
          'CLEANED',
        ].includes(state),
        'CLEANUP_NOT_AUTHORIZED',
      );
      if (state === 'CLEANED') {
        requireProof(!existsSync(join(directory, 'target.sqlite')), 'DELETE_RESULT_UNKNOWN');
        return result('LOCAL_SIMULATION_CLEANED', mode, {
          state,
          importAttempts: journal.row().import_attempts,
          deleteAttempts: journal.row().delete_attempts,
        });
      }
      if (state === 'DELETE_INTENT') {
        if (!existsSync(join(directory, 'target.sqlite'))) {
          journal.state('CLEANED');
          journal.event('cleanup', 'READBACK');
          state = 'CLEANED';
        } else throw new Error('DELETE_RESULT_UNKNOWN');
      } else {
        // Explicit local cleanup action; never automatic after unknown import.
        checkIdentity(directory, target);
        journal.intent('delete');
        journal.event('cleanup', 'INTENT');
        if (options.simulationFault === 'deleteUnknown') throw new Error('DELETE_RESULT_UNKNOWN');
        regular(join(directory, 'target.sqlite'));
        if (existsSync(join(directory, 'target.sqlite')))
          unlinkSync(join(directory, 'target.sqlite'));
        if (options.simulationFault === 'afterDeleteEffect')
          throw new Error('SIMULATED_INTERRUPTION');
        requireProof(!existsSync(join(directory, 'target.sqlite')), 'DELETE_RESULT_UNKNOWN');
        journal.state('CLEANED');
        journal.event('cleanup', 'COMPLETE', performance.now() - cleanupStarted);
        state = 'CLEANED';
      }
      return result('LOCAL_SIMULATION_CLEANED', mode, {
        state,
        importAttempts: journal.row().import_attempts,
        deleteAttempts: journal.row().delete_attempts,
      });
    }
    requireProof(!['DELETE_INTENT', 'CLEANED'].includes(state), 'RUN_STATE_INVALID');
    if (state === 'READY') {
      checkIdentity(directory, target);
      journal.intent('import');
      journal.event('import', 'INTENT');
      const started = performance.now();
      const path = join(directory, 'target.sqlite');
      requireProof(!existsSync(path), 'TARGET_IDENTITY_MISMATCH');
      const fault = ['importTimeout', 'partialImport', 'corruptMoney'].includes(
        options.simulationFault,
      )
        ? options.simulationFault
        : 'none';
      const imported = spawnSync(
        process.execPath,
        [
          '--no-warnings',
          '--max-old-space-size=128',
          resolve('scripts/recovery/executor-import-local.mjs'),
          path,
        ],
        {
          input: JSON.stringify({ sql: bundle.derived, fault }),
          encoding: 'utf8',
          timeout: fault === 'importTimeout' ? 50 : 15000,
          maxBuffer: 4096,
          env: Object.fromEntries(
            Object.entries(process.env).filter(
              ([key]) => !/^(?:CLOUDFLARE_|NODE_OPTIONS$)/.test(key),
            ),
          ),
        },
      );
      requireProof(
        !imported.error &&
          imported.status === 0 &&
          imported.stdout === JSON.stringify({ code: 'LOCAL_IMPORT_COMPLETE' }),
        'IMPORT_RESULT_UNKNOWN',
      );
      if (options.simulationFault === 'afterImportEffect')
        throw new Error('SIMULATED_INTERRUPTION');
      journal.state('IMPORTED');
      journal.event('import', 'COMPLETE', performance.now() - started);
      state = 'IMPORTED';
    }
    let sqlVerification: unknown;
    if (['IMPORT_INTENT', 'IMPORTED', 'VERIFIED'].includes(state)) {
      const verificationStarted = performance.now();
      sqlVerification = await inspectSnapshot(directory, bundle);
      if (state === 'IMPORT_INTENT') journal.event('import', 'READBACK');
      journal.state('VERIFIED');
      journal.event('verify', 'COMPLETE', performance.now() - verificationStarted);
      state = 'VERIFIED';
    }
    if (state === 'VERIFIED') {
      journal.state('AUTHORITY_INTENT');
      journal.event('reconcile', 'INTENT');
      const started = performance.now(),
        db = openTarget(directory);
      try {
        applyAuthority(db, authority, options.simulationFault === 'reconcileFailure');
      } finally {
        db.close();
      }
      if (options.simulationFault === 'afterReconcileEffect')
        throw new Error('SIMULATED_INTERRUPTION');
      await inspectAuthority(directory, authority, bundle);
      journal.state('RECONCILED');
      journal.event('reconcile', 'COMPLETE', performance.now() - started);
      state = 'RECONCILED';
    } else if (state === 'AUTHORITY_INTENT') {
      // Resume only by independent readback: never re-run an uncertain mutation.
      await inspectAuthority(directory, authority, bundle);
      journal.state('RECONCILED');
      journal.event('reconcile', 'READBACK');
      state = 'RECONCILED';
    } else if (state === 'RECONCILED') await inspectAuthority(directory, authority, bundle);
    requireProof(state === 'RECONCILED', 'RUN_STATE_INVALID');
    return result('LOCAL_SIMULATION_VERIFIED_SEALED', mode, {
      state,
      sqlVerification,
      importAttempts: journal.row().import_attempts,
      deleteAttempts: journal.row().delete_attempts,
      backupAgeMs: age,
    });
  } catch (error) {
    const failure = safeFailure(error);
    if (journal) {
      const state = journal.row().state;
      const operation =
        state === 'DELETE_INTENT'
          ? 'cleanup'
          : state === 'AUTHORITY_INTENT'
            ? 'reconcile'
            : state === 'IMPORT_INTENT'
              ? 'import'
              : 'verify';
      try {
        journal.event(
          operation,
          state.endsWith('INTENT') ? 'UNKNOWN' : 'FAILED',
          null,
          failure.code,
          failure.diagnostic.rawDiagnosticSha256,
        );
      } catch {
        /* Budget exhausted: durable INTENT remains authoritative. */
      }
      return result(failure.code, mode, {
        state,
        importAttempts: journal.row().import_attempts,
        deleteAttempts: journal.row().delete_attempts,
        diagnostic: failure.diagnostic,
      });
    }
    return result(failure.code, mode, { diagnostic: failure.diagnostic });
  } finally {
    journal?.db.close();
    unlock?.();
  }
}
