import { DatabaseSync } from 'node:sqlite';
import { existsSync, lstatSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';
import { lockRun } from './executor';
import {
  canonical,
  sha256,
  requireProof,
  readRecoveryBundle,
  readCurrentAuthority,
  verifyRecoverySnapshot,
  verifyCurrentAuthority,
  type CurrentAuthority,
} from './executor-bundle';
import {
  CloudflareD1Provider,
  PROVIDER_ACCOUNT,
  PROVIDER_NAME,
  importEtag,
  type OwnedDatabase,
  type ImportStatus,
} from './cloudflare-d1-provider';
import {
  fakeProcessWire,
  assertWire,
  ProviderTransportError,
  type ProviderWire,
} from './provider-wire';
import type { SafeImportResponse } from './d1-import-diagnostics';
import { splitNativeExportStatements } from './ordered-d1-import';
import { runQueryRecovery } from './query-phase-executor';
export { confirmLiveProvider, liveProviderWire } from './provider-wire';
const hash = z.string().regex(/^[a-f0-9]{64}$/);
const approvalSchema = z.strictObject({
  kind: z.literal('OWNER_OPS001_PROVIDER_V1'),
  owner: z.string().trim().min(1).max(100),
  planSha256: hash,
  capacityReceiptSha256: hash,
  notBefore: z.iso.datetime(),
  expiresAt: z.iso.datetime(),
  allowCreate: z.literal(true),
  allowImport: z.literal(true),
  allowReconcile: z.literal(true),
  allowOwnedCleanup: z.literal(true),
  allowProviderManagedStaging: z.literal(true),
  allowProduction: z.literal(false),
  allowDeploy: z.literal(false),
});
const optionsSchema = z.strictObject({
  mode: z
    .enum(['OFFLINE_DRY_RUN', 'SIMULATE_PROVIDER', 'EXECUTE_REMOTE'])
    .default('OFFLINE_DRY_RUN'),
  bundleDirectory: z.string().optional(),
  manifestSha256: hash.optional(),
  authorityPath: z.string().optional(),
  authoritySha256: hash.optional(),
  runDirectory: z.string().optional(),
  runId: z.string().uuid().optional(),
  fakeDirectory: z.string().optional(),
  action: z.enum(['restore', 'cleanup']).default('restore'),
  restoreTransport: z.enum(['FILE_IMPORT', 'QUERY_BATCH']).default('FILE_IMPORT'),
  recoverDeadLock: z.boolean().default(false),
  simulateInterruption: z
    .enum(['none', 'created', 'ingested', 'reconciled', 'deleted'])
    .default('none'),
  approval: approvalSchema.optional(),
});
export type ProviderOptions = z.input<typeof optionsSchema>;
const codeFiles = [
  'scripts/recovery/provider-runner.ts',
  'scripts/recovery/provider-wire.ts',
  'scripts/recovery/node-https-upload.ts',
  'scripts/recovery/query-restore-plan.ts',
  'scripts/recovery/query-phase-executor.ts',
  'scripts/recovery/cloudflare-d1-provider.ts',
  'scripts/recovery/provider-cli.mjs',
  'scripts/recovery/executor.ts',
  'scripts/recovery/executor-bundle.ts',
  'scripts/recovery/local-auth-restore-proof.ts',
  'scripts/recovery/ordered-d1-import.ts',
  'scripts/recovery/operational-data-proof.ts',
  'scripts/recovery/renewal-history-proof.ts',
  'scripts/recovery/d1-import-diagnostics.ts',
  'src/server/mutations/canonical.ts',
  'package.json',
];
export function providerCodeSha256() {
  return sha256(canonical(codeFiles.map((path) => ({ path, sha256: sha256(readFileSync(path)) }))));
}
const literal = (value: string | number | null) =>
  value === null
    ? 'NULL'
    : typeof value === 'number'
      ? String(value)
      : `'${value.replaceAll("'", "''")}'`;
export function currentAuthorityImportSql(authority: CurrentAuthority) {
  return [
    ...authority.memberships.map(
      (r) =>
        `UPDATE agency_memberships SET status=${literal(r.status)},suspended_at=${literal(r.suspended_at)},permission_version=${r.permission_version},version=${r.version} WHERE id=${literal(r.id)} AND version<>${r.version};`,
    ),
    "DELETE FROM membership_permissions WHERE membership_id='synthetic-membership-permanent';",
    ...authority.grants.map(
      (r) =>
        `INSERT INTO membership_permissions(id,membership_id,permission_code,scope) VALUES(${[r.id, r.membership_id, r.permission_code, r.scope].map(literal).join(',')});`,
    ),
    `UPDATE local_sessions SET revoked_at=COALESCE(revoked_at,${Date.parse(authority.issuedAt)});`,
  ].join('\n');
}
export function providerPlan(input: unknown) {
  const options = optionsSchema.parse(input);
  requireProof(
    options.bundleDirectory &&
      options.manifestSha256 &&
      options.authorityPath &&
      options.authoritySha256 &&
      options.runId,
    'PROVIDER_INPUT_REQUIRED',
  );
  requireProof(
    JSON.parse(readFileSync('node_modules/wrangler/package.json', 'utf8')).version === '4.133.0',
    'WRANGLER_VERSION_MISMATCH',
  );
  const bundle = readRecoveryBundle(options.bundleDirectory, options.manifestSha256),
    authority = readCurrentAuthority(options.authorityPath, options.authoritySha256, bundle);
  const sql = currentAuthorityImportSql(authority),
    codeSha256 = providerCodeSha256();
  for (const body of [bundle.derived, sql])
    requireProof(
      splitNativeExportStatements(body).every(
        (statement) => Buffer.byteLength(statement.sql) <= 100000,
      ),
      'PROVIDER_STATEMENT_LIMIT',
    );
  const descriptor = {
    format: 'OPS001_PROVIDER_PLAN_V1',
    runId: options.runId,
    accountId: PROVIDER_ACCOUNT,
    name: PROVIDER_NAME,
    jurisdiction: 'eu',
    manifestSha256: options.manifestSha256,
    authoritySha256: options.authoritySha256,
    codeSha256,
    sourceSha256: bundle.manifest.files['native.sql'].sha256,
    derivedSha256: bundle.manifest.files['derived.sql'].sha256,
    reconciliationSha256: sha256(sql),
    publication: 'SEALED',
    restoreTransport: options.restoreTransport,
    fileImports: options.restoreTransport === 'FILE_IMPORT' ? 2 : 0,
    queryBatches: options.restoreTransport === 'QUERY_BATCH' ? 4 : 0,
    uploadTransport: 'NODE_HTTPS',
  };
  return {
    options,
    bundle,
    authority,
    reconciliationSql: sql,
    descriptor,
    planSha256: sha256(canonical(descriptor)),
  };
}
interface Job {
  etag: string;
  sqlSha256: string;
  uploadAttempted: boolean;
  uploaded: boolean;
  ingestAttempted: boolean;
  terminal?: 'complete' | 'error';
  filename?: string;
  bookmark?: string;
  polls: number;
  providerStatus?: string | null;
  finalBookmark?: string | null;
  errorCategory?: string;
  diagnosticHash?: string;
}
interface Session {
  binding: string;
  startedAt: number;
  requests: number;
  rowsRead: number;
  rowsWritten: number;
  createAttempted: boolean;
  owned?: OwnedDatabase;
  jobs: Partial<Record<'restore' | 'reconcile', Job>>;
  deleteAttempted: boolean;
  cleaned: boolean;
}
class ProviderJournal {
  readonly db: DatabaseSync;
  data: Session;
  constructor(directory: string, binding: string) {
    const path = join(directory, 'provider-journal.sqlite');
    requireProof(
      !existsSync(path) || (lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink()),
      'JOURNAL_FILE_DENIED',
    );
    this.db = new DatabaseSync(path, { allowExtension: false });
    try {
      this.db.exec(
        'PRAGMA synchronous=FULL;CREATE TABLE IF NOT EXISTS session(id INTEGER PRIMARY KEY CHECK(id=1),body TEXT NOT NULL);CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY,kind TEXT NOT NULL,status INTEGER NOT NULL,at TEXT NOT NULL,elapsed_ms REAL,diagnostic_hash TEXT);CREATE TABLE IF NOT EXISTS transport_failures(id INTEGER PRIMARY KEY,at TEXT NOT NULL,diagnostic TEXT NOT NULL);',
      );
      const old = this.db.prepare('SELECT body FROM session WHERE id=1').get();
      this.data = old
        ? JSON.parse(String(old.body))
        : {
            binding,
            startedAt: Date.now(),
            requests: 0,
            rowsRead: 0,
            rowsWritten: 0,
            createAttempted: false,
            jobs: {},
            deleteAttempted: false,
            cleaned: false,
          };
      requireProof(this.data.binding === binding, 'PROVIDER_RUN_BINDING_MISMATCH');
      this.save();
    } catch (e) {
      this.db.close();
      throw e;
    }
  }
  save() {
    this.db
      .prepare('INSERT INTO session VALUES(1,?) ON CONFLICT(id) DO UPDATE SET body=excluded.body')
      .run(canonical(this.data));
  }
  log(kind: string, status = 0, meta?: Record<string, number | boolean>) {
    if (typeof meta?.size_after === 'number')
      requireProof(meta.size_after <= 16 * 1024 * 1024, 'PROVIDER_STORAGE_BUDGET');
    if (status === 0) {
      requireProof(this.data.requests < 320, 'PROVIDER_REQUEST_BUDGET');
      this.data.requests++;
    }
    if (meta) {
      for (const [key, field] of [
        ['rows_read', 'rowsRead'],
        ['rows_written', 'rowsWritten'],
      ] as const) {
        if (typeof meta[key] === 'number') this.data[field] += meta[key] as number;
      }
    }
    this.save();
    this.db
      .prepare('INSERT INTO events(kind,status,at,elapsed_ms) VALUES(?,?,?,?)')
      .run(
        kind,
        status,
        new Date().toISOString(),
        typeof meta?.adapter_elapsed_ms === 'number' ? meta.adapter_elapsed_ms : null,
      );
    requireProof(
      this.data.rowsRead <= 50000 && this.data.rowsWritten <= 10000,
      'PROVIDER_ROW_BUDGET',
    );
  }
  failure(error: unknown) {
    if (error instanceof ProviderTransportError)
      this.db
        .prepare('INSERT INTO transport_failures(at,diagnostic) VALUES(?,?)')
        .run(new Date().toISOString(), canonical(error.diagnostic));
    const raw = error instanceof Error ? error.message : 'UNKNOWN';
    this.db
      .prepare('INSERT INTO events(kind,status,at,diagnostic_hash) VALUES(?,0,?,?)')
      .run('failure', new Date().toISOString(), sha256(raw));
  }
}
const safeCode = (e: unknown) =>
  e instanceof Error && /^[A-Z_]{1,80}$/.test(e.message) ? e.message : 'PROVIDER_VALIDATION_FAILED';
export async function runProviderRecovery(input: unknown = {}, transport?: ProviderWire) {
  let journal: ProviderJournal | undefined,
    unlock: (() => void) | undefined,
    mode = 'OFFLINE_DRY_RUN';
  const response = (code: string, extra: Record<string, unknown> = {}) => ({
    code,
    mode,
    publication: 'SEALED',
    apiAuthorization: 'NOT_EXECUTED',
    remoteOperations: mode === 'EXECUTE_REMOTE' ? (journal?.data.requests ?? 0) : 0,
    providerRequests: journal?.data.requests ?? 0,
    ...extra,
  });
  try {
    const parsed = optionsSchema.parse(input);
    mode = parsed.mode;
    if (!parsed.bundleDirectory && mode === 'OFFLINE_DRY_RUN') return response('OFFLINE_DRY_RUN');
    const plan = providerPlan(input),
      { options, bundle, authority } = plan;
    const source = new DatabaseSync(':memory:', {
      enableForeignKeyConstraints: false,
      allowExtension: false,
    });
    try {
      source.exec(bundle.derived);
      await verifyRecoverySnapshot((sql) => source.prepare(sql).all(), bundle);
    } finally {
      source.close();
    }
    if (mode === 'OFFLINE_DRY_RUN')
      return response('OFFLINE_DRY_RUN', { plan: plan.descriptor, planSha256: plan.planSha256 });
    requireProof(options.approval, 'OWNER_APPROVAL_REQUIRED');
    const approval = options.approval;
    requireProof(
      approval.planSha256 === plan.planSha256 &&
        Date.parse(approval.notBefore) <= Date.now() &&
        Date.parse(approval.expiresAt) > Date.now() &&
        Date.parse(approval.expiresAt) - Date.parse(approval.notBefore) <= 15 * 60 * 1000,
      'OWNER_APPROVAL_BINDING_INVALID',
    );
    if (mode === 'EXECUTE_REMOTE')
      requireProof(transport && transport.mode === 'LIVE', 'LIVE_CONFIRMATION_REQUIRED');
    else {
      requireProof(options.fakeDirectory, 'FAKE_PROVIDER_REQUIRED');
      transport = fakeProcessWire(options.fakeDirectory);
    }
    assertWire(transport!, plan.planSha256);
    requireProof(
      mode !== 'EXECUTE_REMOTE' || options.simulateInterruption === 'none',
      'SIMULATION_ONLY_OPTION',
    );
    requireProof(options.runDirectory, 'PROVIDER_RUN_DIRECTORY_REQUIRED');
    const directory = options.runDirectory;
    if (!existsSync(directory)) mkdirSync(directory, { mode: 0o700 });
    requireProof(
      lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(),
      'JOURNAL_FILE_DENIED',
    );
    unlock = lockRun(directory, options.recoverDeadLock);
    journal = new ProviderJournal(directory, plan.planSha256);
    const state = journal.data;
    const provider = new CloudflareD1Provider(transport!, (kind, status, meta) => {
      if (kind !== 'import-meta' && kind !== 'query-meta') {
        requireProof(Date.now() < Date.parse(approval.expiresAt), 'OWNER_APPROVAL_EXPIRED');
        if (options.action === 'restore')
          requireProof(
            Date.now() - state.startedAt < 15 * 60 * 1000 && state.requests < 300,
            'PROVIDER_EXECUTION_BUDGET',
          );
      }
      journal!.log(kind, status, meta);
    });
    await provider.account();
    if (!state.owned) {
      const rows = await provider.list();
      if (state.createAttempted)
        throw new Error(
          rows.some((r) => r.name === PROVIDER_NAME)
            ? 'CREATE_OWNERSHIP_AMBIGUOUS'
            : 'CREATE_RESULT_UNKNOWN',
        );
      requireProof(options.action === 'restore', 'CLEANUP_OWNERSHIP_REQUIRED');
      requireProof(!rows.some((r) => r.name === PROVIDER_NAME), 'RESOURCE_NAME_COLLISION');
      requireProof(rows.length < 10, 'FREE_DATABASE_LIMIT');
      state.createAttempted = true;
      journal.save();
      journal.log('CREATE_INTENT', 200);
      try {
        const created = await provider.create();
        requireProof(
          Date.parse(created.created_at) >= Date.parse(approval.notBefore) - 120000 &&
            Date.parse(created.created_at) <= Date.now() + 120000,
          'CREATED_TIMESTAMP_MISMATCH',
        );
        state.owned = created;
        journal.save();
      } catch (error) {
        await provider.list();
        throw error;
      }
      if (options.simulateInterruption === 'created' && mode === 'SIMULATE_PROVIDER')
        throw new Error('SIMULATED_PROCESS_INTERRUPTION');
    }
    provider.bindOwned(state.owned, state.deleteAttempted);
    const activeJournal = journal;
    const settle = async (kind: 'restore' | 'reconcile', sql: string): Promise<void> => {
      let job = state.jobs[kind];
      const fresh = !job;
      if (!job) {
        job = {
          etag: importEtag(sql),
          sqlSha256: sha256(sql),
          uploadAttempted: false,
          uploaded: false,
          ingestAttempted: false,
          polls: 0,
        };
        state.jobs[kind] = job;
        activeJournal.save();
      }
      requireProof(job.sqlSha256 === sha256(sql), 'OPERATION_FINGERPRINT_MISMATCH');
      if (job.terminal === 'error') throw new Error('IMPORT_PROVIDER_FAILED');
      if (job.terminal === 'complete') return;
      await provider.requireOwned();
      let status: ImportStatus = await provider.init(sql);
      let record = status.record;
      if (!record.terminal && status.uploadUrl) {
        // Re-init is a passive same-etag status check, never permission to replay.
        requireProof(
          fresh || (!job.uploadAttempted && !job.ingestAttempted),
          'IMPORT_RESULT_UNKNOWN',
        );
        job.uploadAttempted = true;
        job.filename = status.filename;
        activeJournal.save();
        await provider.upload(status.uploadUrl, sql);
        job.uploaded = true;
        activeJournal.save();
        requireProof(job.filename && !job.ingestAttempted, 'IMPORT_ATTEMPT_ALREADY_USED');
        job.ingestAttempted = true;
        activeJournal.save();
        try {
          record = await provider.ingest(sql, job.filename);
        } catch {
          status = await provider.init(sql);
          record = status.record;
          requireProof(!status.uploadUrl, 'IMPORT_RESULT_UNKNOWN');
        }
        if (
          options.simulateInterruption === (kind === 'restore' ? 'ingested' : 'reconciled') &&
          mode === 'SIMULATE_PROVIDER'
        )
          throw new Error('SIMULATED_PROCESS_INTERRUPTION');
      }
      const capture = (value: SafeImportResponse) => {
        if (value.atBookmark) job!.bookmark = value.atBookmark;
        if (value.terminal) job!.terminal = value.terminal;
        job!.providerStatus = value.providerStatus;
        job!.finalBookmark = value.finalBookmark;
        if (value.error) {
          job!.errorCategory = value.error.category;
          job!.diagnosticHash = value.error.rawDiagnosticSha256;
        }
        activeJournal.save();
      };
      capture(record);
      while (!job.terminal) {
        requireProof(job.polls < 30 && job.bookmark, 'IMPORT_RESULT_UNKNOWN');
        job.polls++;
        activeJournal.save();
        record = await provider.poll(job.bookmark);
        capture(record);
      }
      requireProof(job.terminal === 'complete', 'IMPORT_PROVIDER_FAILED');
    };
    const queryDirectory = join(directory, 'query-state');
    const queryRecovery = async (verifyOnly = false) => {
      if (!existsSync(queryDirectory)) mkdirSync(queryDirectory, { mode: 0o700 });
      requireProof(
        lstatSync(queryDirectory).isDirectory() && !lstatSync(queryDirectory).isSymbolicLink(),
        'JOURNAL_FILE_DENIED',
      );
      return runQueryRecovery({
        directory: queryDirectory,
        targetBinding: sha256(
          canonical({ account: PROVIDER_ACCOUNT, owned: state.owned, plan: plan.planSha256 }),
        ),
        derived: bundle.derived,
        authoritySql: plan.reconciliationSql,
        recoverDeadLock: options.recoverDeadLock,
        verifyOnly,
        query: (sql) => provider.query(sql),
        write: (_name, batch) => provider.queryBatch(batch),
      });
    };
    if (options.action === 'cleanup') {
      if (state.cleaned) {
        await provider.verifyAbsent();
        return response('PROVIDER_CLEANED', {
          simulated: mode === 'SIMULATE_PROVIDER',
          uuid: state.owned.uuid,
        });
      }
      if (!state.deleteAttempted) {
        if (options.restoreTransport === 'QUERY_BATCH' && existsSync(queryDirectory))
          await queryRecovery(true);
        for (const [kind, job] of Object.entries(state.jobs))
          if (!job.terminal) {
            // A staging-only upload cannot mutate D1 without an ingest call.
            // Cleanup never claims deletion of provider-managed staging objects.
            if (job.ingestAttempted)
              await settle(
                kind as 'restore' | 'reconcile',
                kind === 'restore' ? bundle.derived : plan.reconciliationSql,
              );
          }
        await provider.requireOwned();
        state.deleteAttempted = true;
        journal.save();
        journal.log('DELETE_INTENT', 200);
        try {
          await provider.deleteOwned();
        } catch {
          /* A lost response is not a failed delete; exact readback below is mandatory. */
        }
        if (options.simulateInterruption === 'deleted' && mode === 'SIMULATE_PROVIDER')
          throw new Error('SIMULATED_PROCESS_INTERRUPTION');
      }
      await provider.verifyAbsent();
      state.cleaned = true;
      journal.save();
      return response('PROVIDER_CLEANED', {
        simulated: mode === 'SIMULATE_PROVIDER',
        uuid: state.owned.uuid,
      });
    }
    requireProof(!state.deleteAttempted && !state.cleaned, 'DELETION_ALREADY_STARTED');
    await provider.requireOwned();
    if (options.restoreTransport === 'QUERY_BATCH') {
      await queryRecovery();
    } else if (!state.jobs.reconcile) {
      const existing = await provider.query(
        "SELECT count(*) AS n FROM sqlite_schema WHERE type='table' AND name NOT GLOB '_cf_*' AND name NOT GLOB 'sqlite_*'",
      );
      if (!state.jobs.restore) requireProof(existing[0]?.n === 0, 'NONEMPTY_TARGET_DENIED');
      await settle('restore', bundle.derived);
      await provider.requireOwned();
      await verifyRecoverySnapshot((sql) => provider.query(sql), bundle);
      await settle('reconcile', plan.reconciliationSql);
    } else await settle('reconcile', plan.reconciliationSql);
    await provider.requireOwned();
    await verifyCurrentAuthority((sql) => provider.query(sql), authority, bundle);
    return response(
      mode === 'SIMULATE_PROVIDER'
        ? 'SIMULATED_PROVIDER_VERIFIED_SEALED'
        : 'REMOTE_PROVIDER_VERIFIED_SEALED',
      {
        uuid: state.owned.uuid,
        planSha256: plan.planSha256,
        sqlVerification: 'PASS',
        simulated: mode === 'SIMULATE_PROVIDER',
      },
    );
  } catch (error) {
    journal?.failure(error);
    return response(safeCode(error), {
      ...(error instanceof ProviderTransportError ? { transportFailure: error.diagnostic } : {}),
      diagnosticSha256: sha256(error instanceof Error ? error.message : 'unknown'),
    });
  } finally {
    journal?.db.close();
    unlock?.();
  }
}
