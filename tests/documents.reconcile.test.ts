// @vitest-environment node
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { processDocumentBackupMessage } from '../src/server/documents/backup';
import {
  createR2DocumentBackupAdapter,
  documentBackupObjectKey,
  DocumentBackupIntegrityError,
} from '../src/server/documents/backup-storage';
import { dispatchDueDocumentJobs } from '../src/server/documents/queue';
import type { DocumentJobQueueMessage } from '../src/server/documents/queue';
import { createSyntheticPdf } from './fixtures/documents';
import { createWorker } from '../src/server';
import {
  consumeDocumentQueueBatch,
  DOCUMENT_SCAN_DEAD_LETTER_QUEUE,
} from '../src/server/documents/scan';
import {
  enqueueDocumentReconcile,
  processDocumentReconcileMessage,
} from '../src/server/documents/reconcile';
import { createR2DocumentReconcileStorage } from '../src/server/documents/reconcile-storage';

let db: D1Database;
let source: R2Bucket;
let destination: R2Bucket;
let dispose: () => Promise<void>;
let directory: string;
const bytes = createSyntheticPdf();
let checksum: string;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'mayi-reconcile-'));
  const configPath = join(directory, 'wrangler.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      name: 'mayi-reconcile-local',
      compatibility_date: '2026-09-01',
      compatibility_flags: ['nodejs_compat'],
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'backup-local',
          database_id: '00000000-0000-0000-0000-000000000018',
        },
      ],
      r2_buckets: [
        { binding: 'SOURCE', bucket_name: 'synthetic-source' },
        { binding: 'BACKUP', bucket_name: 'synthetic-backup' },
      ],
    }),
  );
  const platform = await getPlatformProxy<{
    DB: D1Database;
    SOURCE: R2Bucket;
    BACKUP: R2Bucket;
  }>({ configPath, envFiles: [], persist: false, remoteBindings: false });
  db = platform.env.DB;
  source = platform.env.SOURCE;
  destination = platform.env.BACKUP;
  dispose = platform.dispose;
  for (const name of readdirSync('db/migrations')
    .filter((name) => /^\d{4}_.+\.sql$/u.test(name))
    .sort()) {
    for (const sql of readFileSync(resolve('db/migrations', name), 'utf8')
      .split('--> statement-breakpoint')
      .map((sql) => sql.trim())
      .filter(Boolean)) {
      await db.prepare(sql).run();
    }
  }
  checksum = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
  for (const db of [platform.env.DB]) {
    await db
      .prepare("INSERT INTO agencies(id,status) VALUES('backup-agency','PROVISIONING')")
      .run();
    await db.prepare("INSERT INTO users(id,status) VALUES('backup-user','INACTIVE')").run();
    await db
      .prepare(
        `INSERT INTO agency_memberships(id,agency_id,user_id,type,status,invitation_email,invitation_expires_at)
    VALUES('backup-member','backup-agency','backup-user','OWNER','INVITED','synthetic@example.test','2099-01-01T00:00:00.000Z')`,
      )
      .run();
    await db
      .prepare(
        `INSERT INTO customers(id,agency_id,type,display_name,first_name,last_name,assignee_membership_id)
    VALUES('backup-customer','backup-agency','INDIVIDUAL','Synthetic','Synthetic','Customer','backup-member')`,
      )
      .run();
  }
}, 180000);
afterAll(async () => {
  await dispose?.();
  if (directory) rmSync(directory, { recursive: true, force: true });
});

async function fixture() {
  const documentId = crypto.randomUUID();
  const versionId = crypto.randomUUID();
  const scanId = crypto.randomUUID();
  const scanRunId = crypto.randomUUID();
  const jobId = crypto.randomUUID();
  const key = `quarantine/${crypto.randomUUID()}`;
  await db
    .prepare(
      `INSERT INTO documents(id,agency_id,owner_type,customer_id,created_by_user_id,created_by_membership_id)
    VALUES(?,'backup-agency','CUSTOMER','backup-customer','backup-user','backup-member')`,
    )
    .bind(documentId)
    .run();
  await db
    .prepare(
      `INSERT INTO document_versions(id,agency_id,document_id,version_number,object_key,sha256,size_bytes,file_name,detected_content_type,created_by_user_id,created_by_membership_id)
    VALUES(?,'backup-agency',?,1,?,?,?,'synthetic.pdf','application/pdf','backup-user','backup-member')`,
    )
    .bind(versionId, documentId, key, checksum, bytes.byteLength)
    .run();
  await db
    .prepare(
      `INSERT INTO background_jobs(id,agency_id,job_type,document_version_id,input_sha256)
    VALUES(?,'backup-agency','DOCUMENT_SCAN',?,?)`,
    )
    .bind(scanId, versionId, checksum)
    .run();
  await db
    .prepare("UPDATE document_versions SET status='QUARANTINED' WHERE id=?")
    .bind(versionId)
    .run();
  await db
    .prepare(
      `UPDATE background_jobs SET status='RUNNING',attempt_count=1,lease_token_hash=?,lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','+150 seconds') WHERE id=?`,
    )
    .bind('a'.repeat(64), scanId)
    .run();
  await db
    .prepare(
      `INSERT INTO background_job_runs(id,agency_id,job_id,attempt_number,lease_token_hash)
    VALUES(?,'backup-agency',?,1,?)`,
    )
    .bind(scanRunId, scanId, 'a'.repeat(64))
    .run();
  await db
    .prepare("UPDATE document_versions SET status='SCANNING' WHERE id=?")
    .bind(versionId)
    .run();
  await db
    .prepare(
      `UPDATE background_job_runs SET status='SUCCEEDED',completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
    )
    .bind(scanRunId)
    .run();
  await db
    .prepare(
      `UPDATE background_jobs SET status='COMPLETED',lease_token_hash=NULL,lease_expires_at=NULL,completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
    )
    .bind(scanId)
    .run();
  await db
    .prepare(
      `INSERT INTO document_scan_evidence(id,agency_id,document_version_id,job_run_id,sha256,outcome,scanner_engine_version,signature_version,signature_updated_at,scanned_at,content_inspection_version,content_inspection_result)
    SELECT ?,'backup-agency',?,?,?,'CLEAN','synthetic-engine','synthetic-signature',strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute'),completed_at,'m4-content-inspection-v1','{"format":"PDF","pageCount":1,"valid":true}' FROM background_job_runs WHERE id=?`,
    )
    .bind(crypto.randomUUID(), versionId, scanRunId, checksum, scanRunId)
    .run();
  await db
    .prepare(
      `INSERT INTO background_jobs(id,agency_id,job_type,document_version_id,input_sha256)
    VALUES(?,'backup-agency','DOCUMENT_BACKUP',?,?)`,
    )
    .bind(jobId, versionId, checksum)
    .run();
  await db
    .prepare("UPDATE document_versions SET status='BACKUP_PENDING' WHERE id=?")
    .bind(versionId)
    .run();
  await source.put(key, bytes, {
    customMetadata: { sha256: checksum },
    httpMetadata: { contentType: 'application/pdf' },
  });
  const message: DocumentJobQueueMessage = {
    jobId,
    jobType: 'DOCUMENT_BACKUP',
    generation: 1,
    documentVersionId: versionId,
    inputSha256: checksum,
  };
  return { documentId, versionId, scanId, scanRunId, jobId, key, message };
}

const storage = () => createR2DocumentReconcileStorage(source, destination);
function queueBatch(body: DocumentJobQueueMessage, queue = 'mayisigorta-document-scan') {
  let acks = 0;
  let retries = 0;
  const batch = {
    queue,
    metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } },
    messages: [
      {
        id: crypto.randomUUID(),
        timestamp: new Date(),
        body,
        attempts: 1,
        ack() {
          acks++;
        },
        retry() {
          retries++;
        },
      },
    ],
    ackAll() {
      acks++;
    },
    retryAll() {
      retries++;
    },
  } as MessageBatch<DocumentJobQueueMessage>;
  return { batch, acks: () => acks, retries: () => retries };
}
async function reconcile(versionId: string, operationId = 'synthetic-check') {
  const message = await enqueueDocumentReconcile(db, 'backup-agency', { versionId }, operationId);
  return processDocumentReconcileMessage(db, storage(), message);
}
async function available() {
  const f = await fixture();
  expect(
    await processDocumentBackupMessage(
      db,
      source,
      createR2DocumentBackupAdapter(destination),
      f.message,
    ),
  ).toBe('COMPLETED');
  return f;
}
describe('local synthetic DOCUMENT_RECONCILE', () => {
  it.each(['verify', 'source'] as const)(
    'nested %s error classification cannot forward a throwing error Proxy',
    async (kind) => {
      const f = await fixture();
      const real = storage();
      await createR2DocumentBackupAdapter(destination).createAndVerify(
        {
          agencyId: 'backup-agency',
          documentVersionId: f.versionId,
          generation: 1,
          sha256: checksum,
          sizeBytes: bytes.byteLength,
        },
        bytes,
        new AbortController().signal,
      );
      for (let a = 1; a <= 4; a++) {
        expect(
          await processDocumentBackupMessage(
            db,
            {
              get() {
                throw new Error('synthetic transient');
              },
            },
            createR2DocumentBackupAdapter(destination),
            f.message,
            { retryDelaySeconds: () => 1 },
          ),
        ).toBe('RETRY_SCHEDULED');
        const at = await db
          .prepare('SELECT available_at FROM background_jobs WHERE id=?')
          .bind(f.jobId)
          .first<string>('available_at');
        await new Promise((r) => setTimeout(r, Math.max(0, Date.parse(at!) - Date.now()) + 25));
      }
      const hostile = new Proxy(new Error('synthetic'), {
        getPrototypeOf() {
          throw new DocumentBackupIntegrityError('SYNTHETIC_CONFIDENTIAL_PROXY_TEXT');
        },
      });
      let calls = 0;
      const adapter = {
        ...real,
        primary:
          kind === 'source'
            ? {
                get() {
                  throw hostile;
                },
              }
            : real.primary,
        async verifyBackup(...args: Parameters<typeof real.verifyBackup>) {
          if (kind === 'verify' && ++calls === 2) throw hostile;
          return real.verifyBackup(...args);
        },
      };
      const message = await enqueueDocumentReconcile(
        db,
        'backup-agency',
        { versionId: f.versionId },
        `error-proxy-${kind}`,
      );
      expect(await processDocumentReconcileMessage(db, adapter, message)).toBe('RETRY_SCHEDULED');
      expect(
        await db
          .prepare('SELECT last_error_code FROM background_jobs WHERE id=?')
          .bind(f.jobId)
          .first('last_error_code'),
      ).toBe('BACKUP_IO_OR_FINALIZE_FAILED');
      expect(
        await db
          .prepare(
            'SELECT reason_code FROM background_job_runs WHERE job_id=? AND attempt_number=5',
          )
          .bind(f.jobId)
          .first('reason_code'),
      ).toBe('BACKUP_IO_OR_FINALIZE_FAILED');
    },
  );
  it.each(['proof', 'chunk'] as const)(
    'nested %s getters cannot carry confidential codes across the durable boundary',
    async (kind) => {
      const f = await fixture();
      const real = storage();
      await createR2DocumentBackupAdapter(destination).createAndVerify(
        {
          agencyId: 'backup-agency',
          documentVersionId: f.versionId,
          generation: 1,
          sha256: checksum,
          sizeBytes: bytes.byteLength,
        },
        bytes,
        new AbortController().signal,
      );
      for (let attempt = 1; attempt <= 4; attempt++) {
        expect(
          await processDocumentBackupMessage(
            db,
            {
              get() {
                throw new Error('synthetic transient');
              },
            },
            createR2DocumentBackupAdapter(destination),
            f.message,
            { retryDelaySeconds: () => 1 },
          ),
        ).toBe('RETRY_SCHEDULED');
        const at = await db
          .prepare('SELECT available_at FROM background_jobs WHERE id=?')
          .bind(f.jobId)
          .first<string>('available_at');
        await new Promise((r) => setTimeout(r, Math.max(0, Date.parse(at!) - Date.now()) + 25));
      }
      let verifyCalls = 0;
      let getterCalls = 0;
      class HostileChunk extends Uint8Array {
        override get byteLength(): number {
          getterCalls++;
          throw new DocumentBackupIntegrityError('SYNTHETIC_CONFIDENTIAL_SIBLING_TEXT');
        }
      }
      const adapter = {
        ...real,
        primary:
          kind === 'proof'
            ? real.primary
            : {
                async get(key: string) {
                  const object = await source.get(key);
                  await object!.body.cancel();
                  return {
                    ...object!,
                    body: new ReadableStream<Uint8Array>({
                      start(c) {
                        c.enqueue(new HostileChunk(bytes));
                        c.close();
                      },
                    }),
                  } as R2ObjectBody;
                },
              },
        async verifyBackup(...args: Parameters<typeof real.verifyBackup>) {
          const proof = await real.verifyBackup(...args);
          if (kind === 'proof' && ++verifyCalls === 2)
            return Object.defineProperty({ ...proof! }, 'objectKey', {
              get() {
                getterCalls++;
                throw new DocumentBackupIntegrityError('SYNTHETIC_CONFIDENTIAL_SIBLING_TEXT');
              },
            });
          return proof;
        },
      };
      const message = await enqueueDocumentReconcile(
        db,
        'backup-agency',
        { versionId: f.versionId },
        `nested-getter-${kind}`,
      );
      expect(await processDocumentReconcileMessage(db, adapter, message)).toBe(
        kind === 'proof' ? 'RETRY_SCHEDULED' : 'SAFE_REPAIR',
      );
      const rows = await db
        .prepare('SELECT reason_code FROM background_job_runs WHERE job_id=?')
        .bind(f.jobId)
        .all<{ reason_code: string | null }>();
      expect(rows.results.some((r) => r.reason_code?.includes('CONFIDENTIAL'))).toBe(false);
      expect(
        await db
          .prepare('SELECT attempt_count FROM background_jobs WHERE id=?')
          .bind(f.jobId)
          .first('attempt_count'),
      ).toBe(5);
      expect(
        await db
          .prepare('SELECT last_error_code FROM background_jobs WHERE id=?')
          .bind(f.jobId)
          .first('last_error_code'),
      ).toBe(kind === 'proof' ? 'BACKUP_PROOF_MISMATCH' : null);
      expect(getterCalls).toBe(kind === 'proof' ? 1 : 0);
      expect(
        await db
          .prepare('SELECT count(*) AS n FROM document_backup_copies WHERE document_version_id=?')
          .bind(f.versionId)
          .first('n'),
      ).toBe(kind === 'proof' ? 0 : 1);
    },
  );
  it.each(['get', 'body'] as const)(
    'nested primary %s cannot persist confidential error text on the fifth real attempt',
    async (kind) => {
      const f = await fixture();
      const real = storage();
      await createR2DocumentBackupAdapter(destination).createAndVerify(
        {
          agencyId: 'backup-agency',
          documentVersionId: f.versionId,
          generation: 1,
          sha256: checksum,
          sizeBytes: bytes.byteLength,
        },
        bytes,
        new AbortController().signal,
      );
      for (let attempt = 1; attempt <= 4; attempt++) {
        expect(
          await processDocumentBackupMessage(
            db,
            {
              get() {
                throw new Error('synthetic temporary outage');
              },
            },
            createR2DocumentBackupAdapter(destination),
            f.message,
            { retryDelaySeconds: () => 1 },
          ),
        ).toBe('RETRY_SCHEDULED');
        const at = await db
          .prepare('SELECT available_at FROM background_jobs WHERE id=?')
          .bind(f.jobId)
          .first<string>('available_at');
        await new Promise((r) => setTimeout(r, Math.max(0, Date.parse(at!) - Date.now()) + 25));
      }
      const adapter = {
        ...real,
        primary: {
          async get(key: string) {
            if (kind === 'get')
              throw new DocumentBackupIntegrityError('SYNTHETIC_CONFIDENTIAL_PRIMARY_TEXT');
            const object = await source.get(key);
            await object!.body.cancel();
            return {
              ...object!,
              body: new ReadableStream<Uint8Array>({
                pull(controller) {
                  controller.error(
                    new DocumentBackupIntegrityError('SYNTHETIC_CONFIDENTIAL_PRIMARY_TEXT'),
                  );
                },
              }),
            } as R2ObjectBody;
          },
        },
      };
      const message = await enqueueDocumentReconcile(
        db,
        'backup-agency',
        { versionId: f.versionId },
        `nested-primary-${kind}`,
      );
      expect(await processDocumentReconcileMessage(db, adapter, message)).toBe('RETRY_SCHEDULED');
      expect(
        await db
          .prepare('SELECT attempt_count FROM background_jobs WHERE id=?')
          .bind(f.jobId)
          .first('attempt_count'),
      ).toBe(5);
      expect(
        await db
          .prepare('SELECT last_error_code FROM background_jobs WHERE id=?')
          .bind(f.jobId)
          .first('last_error_code'),
      ).toBe('BACKUP_SOURCE_IDENTITY_INVALID');
      expect(
        await db
          .prepare(
            'SELECT reason_code FROM background_job_runs WHERE job_id=? AND attempt_number=5',
          )
          .bind(f.jobId)
          .first('reason_code'),
      ).toBe('BACKUP_SOURCE_IDENTITY_INVALID');
      expect(
        await db
          .prepare('SELECT count(*) AS n FROM document_backup_copies WHERE document_version_id=?')
          .bind(f.versionId)
          .first('n'),
      ).toBe(0);
    },
  );
  it('nested backup verification cannot persist arbitrary adapter text on the fifth real attempt', async () => {
    const f = await fixture();
    const real = storage();
    await createR2DocumentBackupAdapter(destination).createAndVerify(
      {
        agencyId: 'backup-agency',
        documentVersionId: f.versionId,
        generation: 1,
        sha256: checksum,
        sizeBytes: bytes.byteLength,
      },
      bytes,
      new AbortController().signal,
    );
    for (let attempt = 1; attempt <= 4; attempt++) {
      expect(
        await processDocumentBackupMessage(
          db,
          {
            get() {
              throw new Error('synthetic transient source outage');
            },
          },
          createR2DocumentBackupAdapter(destination),
          f.message,
          { retryDelaySeconds: () => 1 },
        ),
      ).toBe('RETRY_SCHEDULED');
      const at = await db
        .prepare('SELECT available_at FROM background_jobs WHERE id=?')
        .bind(f.jobId)
        .first<string>('available_at');
      await new Promise((resolve) =>
        setTimeout(resolve, Math.max(0, Date.parse(at!) - Date.now()) + 25),
      );
    }
    let calls = 0;
    const adapter = {
      ...real,
      async verifyBackup(...args: Parameters<typeof real.verifyBackup>) {
        if (++calls === 2) throw new DocumentBackupIntegrityError('SYNTHETIC_CONFIDENTIAL_TEXT');
        return real.verifyBackup(...args);
      },
    };
    const message = await enqueueDocumentReconcile(
      db,
      'backup-agency',
      { versionId: f.versionId },
      'nested-error-fifth-attempt',
    );
    expect(await processDocumentReconcileMessage(db, adapter, message)).toBe('RETRY_SCHEDULED');
    expect(calls).toBe(2);
    expect(
      await db
        .prepare('SELECT attempt_count FROM background_jobs WHERE id=?')
        .bind(f.jobId)
        .first('attempt_count'),
    ).toBe(5);
    expect(
      await db
        .prepare('SELECT last_error_code FROM background_jobs WHERE id=?')
        .bind(f.jobId)
        .first('last_error_code'),
    ).toBe('BACKUP_PROOF_MISMATCH');
    expect(
      await db
        .prepare('SELECT reason_code FROM background_job_runs WHERE job_id=? AND attempt_number=5')
        .bind(f.jobId)
        .first('reason_code'),
    ).toBe('BACKUP_PROOF_MISMATCH');
    expect(
      await db
        .prepare('SELECT count(*) AS n FROM background_job_runs WHERE job_id=?')
        .bind(f.jobId)
        .first('n'),
    ).toBe(5);
    expect(
      await db
        .prepare('SELECT count(*) AS n FROM document_backup_copies WHERE document_version_id=?')
        .bind(f.versionId)
        .first('n'),
    ).toBe(0);
  });
  it.each(['PRIMARY', 'BACKUP'] as const)(
    'an explicit historical %s object target is verified even after a newer DocumentVersion exists',
    async (kind) => {
      const f = await available();
      const next = crypto.randomUUID();
      await db
        .prepare(
          "INSERT INTO document_versions(id,agency_id,document_id,version_number,object_key,sha256,size_bytes,file_name,detected_content_type,created_by_user_id,created_by_membership_id) VALUES(?,'backup-agency',?,2,?,?,?,'synthetic.pdf','application/pdf','backup-user','backup-member')",
        )
        .bind(next, f.documentId, `quarantine/${crypto.randomUUID()}`, checksum, bytes.byteLength)
        .run();
      const key =
        kind === 'PRIMARY'
          ? f.key
          : (await db
              .prepare('SELECT object_key FROM document_backup_copies WHERE document_version_id=?')
              .bind(f.versionId)
              .first<string>('object_key'))!;
      await (kind === 'PRIMARY' ? source : destination).delete(key);
      const message = await enqueueDocumentReconcile(
        db,
        'backup-agency',
        { kind, objectKey: key },
        'historical-revision-key',
      );
      expect(await processDocumentReconcileMessage(db, storage(), message)).toBe('INVESTIGATE');
      expect(
        await db
          .prepare('SELECT status FROM document_versions WHERE id=?')
          .bind(next)
          .first('status'),
      ).toBe('PENDING_UPLOAD');
      expect(
        await db
          .prepare('SELECT current_version_id FROM documents WHERE id=?')
          .bind(f.documentId)
          .first('current_version_id'),
      ).toBeNull();
      expect(
        await db
          .prepare('SELECT count(*) AS n FROM document_backup_copies WHERE document_version_id=?')
          .bind(f.versionId)
          .first('n'),
      ).toBe(1);
    },
  );
  it('an older immutable backup copy does not block proven interrupted finalization of a newer generation', async () => {
    const f = await available();
    const nextId = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO background_jobs(id,agency_id,job_type,document_version_id,input_sha256,generation) VALUES(?,'backup-agency','DOCUMENT_BACKUP',?,?,2)",
      )
      .bind(nextId, f.versionId, checksum)
      .run();
    const identity = {
      agencyId: 'backup-agency',
      documentVersionId: f.versionId,
      generation: 2,
      sha256: checksum,
      sizeBytes: bytes.byteLength,
    };
    await createR2DocumentBackupAdapter(destination).createAndVerify(
      identity,
      bytes,
      new AbortController().signal,
    );
    expect(await reconcile(f.versionId, 'generation-two')).toBe('SAFE_REPAIR');
    expect(
      await db
        .prepare('SELECT count(*) AS n FROM document_backup_copies WHERE document_version_id=?')
        .bind(f.versionId)
        .first('n'),
    ).toBe(2);
    expect(
      await db
        .prepare('SELECT current_version_id FROM documents WHERE id=?')
        .bind(f.documentId)
        .first('current_version_id'),
    ).toBe(f.versionId);
    expect(
      await db
        .prepare('SELECT status FROM background_jobs WHERE id=?')
        .bind(nextId)
        .first('status'),
    ).toBe('COMPLETED');
    expect(
      await db
        .prepare('SELECT status FROM background_jobs WHERE id=?')
        .bind(f.jobId)
        .first('status'),
    ).toBe('COMPLETED');
  });
  it.each(['PRIMARY', 'BACKUP'] as const)(
    'bounds %s body consumption and verifies full EOF instead of metadata',
    async (kind) => {
      const f = await available();
      const originalStorage = storage();
      const maliciousGet = {
        async get(key: string) {
          const object = await (kind === 'PRIMARY' ? source : destination).get(key);
          if (!object) return null;
          await object.body.cancel();
          return {
            ...object,
            body: new ReadableStream<Uint8Array>({
              start(controller) {
                controller.enqueue(new Uint8Array(object.size + 1));
                controller.close();
              },
            }),
          } as R2ObjectBody;
        },
      };
      const bounded =
        kind === 'PRIMARY'
          ? createR2DocumentReconcileStorage(maliciousGet, destination)
          : createR2DocumentReconcileStorage(source, maliciousGet);
      const message = await enqueueDocumentReconcile(
        db,
        'backup-agency',
        { versionId: f.versionId },
        'bounded-body',
      );
      expect(await processDocumentReconcileMessage(db, bounded, message)).toBe('INVESTIGATE');
      expect(
        await db
          .prepare('SELECT last_error_code FROM background_jobs WHERE id=?')
          .bind(message.jobId)
          .first('last_error_code'),
      ).toBe('RECONCILE_OBJECT_LENGTH_MISMATCH');
      expect(
        await originalStorage.observe('PRIMARY', f.key, new AbortController().signal),
      ).not.toBeNull();
    },
  );
  it('a newer scan between inspection and final D1 batch rejects stale reconciliation evidence', async () => {
    const f = await available();
    const adapter = storage();
    const message = await enqueueDocumentReconcile(
      db,
      'backup-agency',
      { versionId: f.versionId },
      'newer-scan-race',
    );
    const racing = {
      ...adapter,
      async verifyBackup(...args: Parameters<typeof adapter.verifyBackup>) {
        const proof = await adapter.verifyBackup(...args);
        await db
          .prepare(
            "INSERT INTO background_jobs(id,agency_id,job_type,document_version_id,input_sha256,generation) VALUES(?,'backup-agency','DOCUMENT_SCAN',?,?,2)",
          )
          .bind(crypto.randomUUID(), f.versionId, checksum)
          .run();
        return proof;
      },
    };
    expect(await processDocumentReconcileMessage(db, racing, message)).toBe('RETRY_SCHEDULED');
    expect(
      await db
        .prepare('SELECT status FROM document_versions WHERE id=?')
        .bind(f.versionId)
        .first('status'),
    ).toBe('QUARANTINED');
    expect(
      await db
        .prepare(
          "SELECT count(*) AS n FROM system_audit_events WHERE action='document.reconcile.discrepancy' AND target_id=?",
        )
        .bind(message.jobId)
        .first('n'),
    ).toBe(0);
  });
  it('arbitrary adapter error text cannot enter durable investigation codes or audit', async () => {
    const f = await available();
    const message = await enqueueDocumentReconcile(
      db,
      'backup-agency',
      { versionId: f.versionId },
      'safe-code',
    );
    const adapter = {
      ...storage(),
      async observe() {
        throw new DocumentBackupIntegrityError('SYNTHETIC_CONFIDENTIAL_TEXT');
      },
    };
    expect(await processDocumentReconcileMessage(db, adapter, message)).toBe('INVESTIGATE');
    expect(
      await db
        .prepare('SELECT last_error_code FROM background_jobs WHERE id=?')
        .bind(message.jobId)
        .first('last_error_code'),
    ).toBe('RECONCILE_OBJECT_INTEGRITY_INVALID');
  });
  it('a wrong Queue reconcile generation performs no read or mutation', async () => {
    const f = await available();
    const message = await enqueueDocumentReconcile(
      db,
      'backup-agency',
      { versionId: f.versionId },
      'wrong-generation',
    );
    expect(
      await processDocumentReconcileMessage(
        db,
        {
          ...storage(),
          async observe() {
            throw new Error('must not read');
          },
        },
        { ...message, generation: 2 },
      ),
    ).toBe('ACKED');
    expect(
      await db
        .prepare('SELECT attempt_count FROM background_jobs WHERE id=?')
        .bind(message.jobId)
        .first('attempt_count'),
    ).toBe(0);
  });
  it('checks the exact historical backup key rather than silently checking a newer copy', async () => {
    const f = await available();
    const oldKey = await db
      .prepare('SELECT object_key FROM document_backup_copies WHERE document_version_id=?')
      .bind(f.versionId)
      .first<string>('object_key');
    const nextId = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO background_jobs(id,agency_id,job_type,document_version_id,input_sha256,generation) VALUES(?,'backup-agency','DOCUMENT_BACKUP',?,?,2)",
      )
      .bind(nextId, f.versionId, checksum)
      .run();
    expect(
      await processDocumentBackupMessage(db, source, createR2DocumentBackupAdapter(destination), {
        ...f.message,
        jobId: nextId,
        generation: 2,
      }),
    ).toBe('COMPLETED');
    await destination.delete(oldKey!);
    const message = await enqueueDocumentReconcile(
      db,
      'backup-agency',
      { kind: 'BACKUP', objectKey: oldKey! },
      'historical-key',
    );
    expect(await processDocumentReconcileMessage(db, storage(), message)).toBe('INVESTIGATE');
    expect(
      await db
        .prepare('SELECT current_version_id FROM documents WHERE id=?')
        .bind(f.documentId)
        .first('current_version_id'),
    ).toBe(f.versionId);
    expect(
      await db
        .prepare('SELECT count(*) AS n FROM document_backup_copies WHERE document_version_id=?')
        .bind(f.versionId)
        .first('n'),
    ).toBe(2);
    expect(
      await db
        .prepare('SELECT status FROM background_jobs WHERE id=?')
        .bind(f.jobId)
        .first('status'),
    ).toBe('COMPLETED');
    expect(
      await db
        .prepare('SELECT status FROM background_jobs WHERE id=?')
        .bind(f.scanId)
        .first('status'),
    ).toBe('COMPLETED');
    expect(await reconcile(f.versionId, 'latest-stable')).toBe('SAFE_NOOP');
  });
  it('a primary object after interrupted upload is recorded without creating CLEAN, jobs or a receipt', async () => {
    const f = await available();
    const next = crypto.randomUUID();
    const key = `quarantine/${crypto.randomUUID()}`;
    await db
      .prepare(
        "INSERT INTO document_versions(id,agency_id,document_id,version_number,object_key,sha256,size_bytes,file_name,detected_content_type,created_by_user_id,created_by_membership_id) VALUES(?,'backup-agency',?,2,?,?,?,'synthetic.pdf','application/pdf','backup-user','backup-member')",
      )
      .bind(next, f.documentId, key, checksum, bytes.byteLength)
      .run();
    await source.put(key, bytes, { customMetadata: { sha256: checksum } });
    expect(await reconcile(next)).toBe('INVESTIGATE');
    expect(
      await db
        .prepare('SELECT status FROM document_versions WHERE id=?')
        .bind(next)
        .first('status'),
    ).toBe('PENDING_UPLOAD');
    expect(
      await db
        .prepare('SELECT count(*) AS n FROM document_scan_evidence WHERE document_version_id=?')
        .bind(next)
        .first('n'),
    ).toBe(0);
    expect(
      await db
        .prepare('SELECT count(*) AS n FROM background_jobs WHERE document_version_id=?')
        .bind(next)
        .first('n'),
    ).toBe(0);
    expect(await source.head(key)).not.toBeNull();
  });
  it('republication requires fresh primary and backup byte proof and preserves the discrepancy history', async () => {
    const f = await available();
    await source.delete(f.key);
    expect(await reconcile(f.versionId, 'broken')).toBe('INVESTIGATE');
    await source.put(f.key, bytes, { customMetadata: { sha256: checksum } });
    expect(await reconcile(f.versionId, 'repaired')).toBe('SAFE_REPAIR');
    expect(
      await db
        .prepare('SELECT current_version_id FROM documents WHERE id=?')
        .bind(f.documentId)
        .first('current_version_id'),
    ).toBe(f.versionId);
    expect(
      await db
        .prepare(
          "SELECT count(*) AS n FROM system_audit_events WHERE action='document.reconcile.discrepancy' AND json_extract(metadata_json,'$.versionId')=?",
        )
        .bind(f.versionId)
        .first('n'),
    ).toBe(1);
    expect(await reconcile(f.versionId, 'again')).toBe('SAFE_NOOP');
    expect(
      await db
        .prepare(
          "SELECT count(*) AS n FROM system_audit_events WHERE action='document.reconcile.repaired' AND target_id=?",
        )
        .bind(f.versionId)
        .first('n'),
    ).toBe(1);
  });
  it('a D1 discrepancy-audit failure rolls back unpublication and completion atomically', async () => {
    const f = await available();
    await source.delete(f.key);
    const message = await enqueueDocumentReconcile(
      db,
      'backup-agency',
      { versionId: f.versionId },
      'audit-fails',
    );
    await db
      .prepare(
        `CREATE TRIGGER synthetic_reconcile_audit_failure BEFORE INSERT ON system_audit_events WHEN NEW.action='document.reconcile.discrepancy' AND NEW.target_id='${message.jobId}' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_AUDIT_FAILURE'); END`,
      )
      .run();
    try {
      expect(await processDocumentReconcileMessage(db, storage(), message)).toBe('RETRY_SCHEDULED');
      expect(
        await db
          .prepare('SELECT current_version_id FROM documents WHERE id=?')
          .bind(f.documentId)
          .first('current_version_id'),
      ).toBe(f.versionId);
      expect(
        await db
          .prepare('SELECT status FROM background_job_runs WHERE job_id=?')
          .bind(message.jobId)
          .first('status'),
      ).toBe('RETRYABLE_ERROR');
    } finally {
      await db.prepare('DROP TRIGGER synthetic_reconcile_audit_failure').run();
    }
  });
  it('competing real-D1 claim CAS deliveries create exactly one run', async () => {
    const f = await available();
    const message = await enqueueDocumentReconcile(
      db,
      'backup-agency',
      { versionId: f.versionId },
      'claim-race',
    );
    let arrivals = 0;
    let release!: () => void;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    const database = new Proxy(db, {
      get(target, property) {
        if (property === 'batch')
          return async (statements: D1PreparedStatement[]) => {
            if (++arrivals <= 2) {
              if (arrivals === 2) release();
              await barrier;
            }
            return target.batch(statements);
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const results = await Promise.all(
      [1, 2].map(() => processDocumentReconcileMessage(database, storage(), message)),
    );
    expect(results.sort()).toEqual(['ACKED', 'SAFE_NOOP']);
    expect(
      await db
        .prepare('SELECT count(*) AS n FROM background_job_runs WHERE job_id=?')
        .bind(message.jobId)
        .first('n'),
    ).toBe(1);
  });
  it('five transient failures become DEAD without synthetic attempts or publication mutations', async () => {
    const f = await available();
    const message = await enqueueDocumentReconcile(
      db,
      'backup-agency',
      { versionId: f.versionId },
      'exhausted',
    );
    const failing = {
      ...storage(),
      async observe() {
        throw new Error('synthetic temporary storage failure');
      },
    };
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(
        await processDocumentReconcileMessage(db, failing, message, { retryDelaySeconds: () => 1 }),
      ).toBe(attempt < 5 ? 'RETRY_SCHEDULED' : 'INVESTIGATE');
      if (attempt < 5) {
        const at = await db
          .prepare('SELECT available_at FROM background_jobs WHERE id=?')
          .bind(message.jobId)
          .first<string>('available_at');
        await new Promise((r) => setTimeout(r, Math.max(0, Date.parse(at!) - Date.now()) + 25));
      }
    }
    expect(
      await db
        .prepare('SELECT status FROM background_jobs WHERE id=?')
        .bind(message.jobId)
        .first('status'),
    ).toBe('DEAD');
    expect(
      await db
        .prepare('SELECT count(*) AS n FROM background_job_runs WHERE job_id=?')
        .bind(message.jobId)
        .first('n'),
    ).toBe(5);
    expect(
      await db
        .prepare('SELECT current_version_id FROM documents WHERE id=?')
        .bind(f.documentId)
        .first('current_version_id'),
    ).toBe(f.versionId);
  });
  it('disabled documents perform no reconciliation storage reads', async () => {
    const f = await available();
    const message = await enqueueDocumentReconcile(
      db,
      'backup-agency',
      { versionId: f.versionId },
      'disabled',
    );
    const trap = {
      ...storage(),
      async observe() {
        throw new Error('must not read');
      },
    };
    const delivery = queueBatch(message);
    await createWorker(undefined, undefined, trap).queue(delivery.batch, {
      DB: db,
      DOCS_QUARANTINE: source,
      DOCUMENTS_ENABLED: 'false',
    });
    expect(delivery.acks()).toBe(1);
    expect(
      await db
        .prepare('SELECT attempt_count FROM background_jobs WHERE id=?')
        .bind(message.jobId)
        .first('attempt_count'),
    ).toBe(0);
  });
  it('the persistent dispatcher and Worker Queue process targeted reconciliation', async () => {
    const f = await available();
    const message = await enqueueDocumentReconcile(
      db,
      'backup-agency',
      { versionId: f.versionId },
      'queue',
    );
    const sent: DocumentJobQueueMessage[] = [];
    await dispatchDueDocumentJobs(
      db,
      {
        async send(body) {
          sent.push(body);
          return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
        },
      },
      ['DOCUMENT_RECONCILE'],
    );
    expect(sent).toContainEqual(message);
    const delivery = queueBatch(message);
    await createWorker(undefined, undefined, storage()).queue(delivery.batch, {
      DB: db,
      DOCS_QUARANTINE: source,
      DOCUMENTS_ENABLED: 'true',
    });
    expect(delivery.acks()).toBe(1);
    expect(
      await db
        .prepare('SELECT status FROM background_jobs WHERE id=?')
        .bind(message.jobId)
        .first('status'),
    ).toBe('COMPLETED');
  });
  it('missing reconciliation capability retries instead of falsely acknowledging work', async () => {
    const f = await available();
    const message = await enqueueDocumentReconcile(
      db,
      'backup-agency',
      { versionId: f.versionId },
      'no-capability',
    );
    const delivery = queueBatch(message);
    await createWorker().queue(delivery.batch, {
      DB: db,
      DOCS_QUARANTINE: source,
      DOCUMENTS_ENABLED: 'true',
    });
    expect(delivery.acks()).toBe(0);
    expect(delivery.retries()).toBe(1);
  });
  it('reclaims an expired reconcile lease using the existing job retry path', async () => {
    const f = await available();
    const message = await enqueueDocumentReconcile(
      db,
      'backup-agency',
      { versionId: f.versionId },
      'expired',
    );
    const adapter = {
      ...storage(),
      async observe() {
        return await new Promise<never>(() => undefined);
      },
    };
    expect(await processDocumentReconcileMessage(db, adapter, message, { timeoutMs: 1500 })).toBe(
      'RETRY_DELIVERY',
    );
    await db
      .prepare(
        "UPDATE background_jobs SET lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second') WHERE id=?",
      )
      .bind(message.jobId)
      .run();
    await dispatchDueDocumentJobs(
      db,
      {
        async send() {
          return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
        },
      },
      ['DOCUMENT_RECONCILE'],
    );
    expect(
      await db
        .prepare('SELECT status FROM background_jobs WHERE id=?')
        .bind(message.jobId)
        .first('status'),
    ).toBe('RETRY_WAIT');
    expect(
      await db
        .prepare('SELECT status FROM background_job_runs WHERE job_id=?')
        .bind(message.jobId)
        .first('status'),
    ).toBe('STALE');
  });
  it('reconcile Queue exhaustion records an exact immutable deduplicated audit without schema changes', async () => {
    const f = await available();
    const message = await enqueueDocumentReconcile(
      db,
      'backup-agency',
      { versionId: f.versionId },
      'dlq',
    );
    const delivery = queueBatch(message, DOCUMENT_SCAN_DEAD_LETTER_QUEUE);
    await consumeDocumentQueueBatch(delivery.batch, db, source, false);
    await consumeDocumentQueueBatch(delivery.batch, db, source, false);
    expect(
      await db
        .prepare('SELECT last_error_code FROM background_jobs WHERE id=?')
        .bind(message.jobId)
        .first('last_error_code'),
    ).toBe('QUEUE_DELIVERY_EXHAUSTED');
    expect(
      await db
        .prepare(
          "SELECT count(*) AS n FROM system_audit_events WHERE action='document.reconcile.queue_exhausted' AND target_id=?",
        )
        .bind(message.jobId)
        .first('n'),
    ).toBe(1);
  });
  it.each(['PRIMARY', 'BACKUP'] as const)(
    'detects an orphan %s object without exposing, adopting or deleting it',
    async (kind) => {
      const key = `${kind === 'PRIMARY' ? 'quarantine' : 'backup'}/${crypto.randomUUID()}`;
      const bucket = kind === 'PRIMARY' ? source : destination;
      await bucket.put(key, bytes, {
        customMetadata: { sha256: checksum, privateText: 'DO-NOT-LOG-SYNTHETIC' },
      });
      const message = await enqueueDocumentReconcile(
        db,
        'backup-agency',
        { kind, objectKey: key },
        'orphan',
      );
      expect(await processDocumentReconcileMessage(db, storage(), message)).toBe('INVESTIGATE');
      expect(await bucket.head(key)).not.toBeNull();
      expect(
        await db
          .prepare(
            "SELECT reason_code FROM system_audit_events WHERE action='document.reconcile.discrepancy' AND target_id=?",
          )
          .bind(message.jobId)
          .first('reason_code'),
      ).toBe(`RECONCILE_ORPHAN_${kind}`);
      const metadata = await db
        .prepare(
          "SELECT metadata_json FROM system_audit_events WHERE action='document.reconcile.discrepancy' AND target_id=?",
        )
        .bind(message.jobId)
        .first<string>('metadata_json');
      expect(metadata).not.toContain('DO-NOT-LOG');
      expect(await processDocumentReconcileMessage(db, storage(), message)).toBe('ACKED');
    },
  );
  it('only exposes verification and primary-read capabilities, never backup delete/list/download/write', () => {
    const adapter = storage();
    expect(Object.keys(adapter).sort()).toEqual(['observe', 'primary', 'verifyBackup']);
    expect(Object.keys(adapter.primary)).toEqual(['get']);
    expect(Object.isFrozen(adapter)).toBe(true);
    for (const name of ['delete', 'put', 'get', 'list', 'bucket', 'backup'])
      expect(name in adapter).toBe(false);
  });
  it('never repairs stale scan evidence into CLEAN or creates another scan job', async () => {
    const f = await available();
    const newScan = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO background_jobs(id,agency_id,job_type,document_version_id,input_sha256,generation) VALUES(?,'backup-agency','DOCUMENT_SCAN',?,?,2)",
      )
      .bind(newScan, f.versionId, checksum)
      .run();
    expect(await reconcile(f.versionId)).toBe('INVESTIGATE');
    expect(
      await db
        .prepare('SELECT status FROM document_versions WHERE id=?')
        .bind(f.versionId)
        .first('status'),
    ).toBe('QUARANTINED');
    expect(
      await db
        .prepare('SELECT status FROM background_jobs WHERE id=?')
        .bind(newScan)
        .first('status'),
    ).toBe('QUEUED');
    expect(
      await db
        .prepare('SELECT count(*) AS n FROM document_scan_evidence WHERE document_version_id=?')
        .bind(f.versionId)
        .first('n'),
    ).toBe(1);
    expect(
      await db
        .prepare(
          "SELECT count(*) AS n FROM background_jobs WHERE document_version_id=? AND job_type='DOCUMENT_SCAN'",
        )
        .bind(f.versionId)
        .first('n'),
    ).toBe(2);
  });
  it('an old reconcile target cannot change a newer DocumentVersion', async () => {
    const f = await available();
    const next = crypto.randomUUID();
    await db
      .prepare(
        "INSERT INTO document_versions(id,agency_id,document_id,version_number,object_key,sha256,size_bytes,file_name,detected_content_type,created_by_user_id,created_by_membership_id) VALUES(?,'backup-agency',?,2,?,?,?,'synthetic.pdf','application/pdf','backup-user','backup-member')",
      )
      .bind(next, f.documentId, `quarantine/${crypto.randomUUID()}`, checksum, bytes.byteLength)
      .run();
    expect(await reconcile(f.versionId)).toBe('SAFE_NOOP');
    expect(
      await db
        .prepare('SELECT status FROM document_versions WHERE id=?')
        .bind(next)
        .first('status'),
    ).toBe('PENDING_UPLOAD');
    expect(
      await db
        .prepare('SELECT current_version_id FROM documents WHERE id=?')
        .bind(f.documentId)
        .first('current_version_id'),
    ).toBeNull();
  });
  it('a stale reconciler cannot report or unpublish after a newer successful backup', async () => {
    const f = await fixture();
    await source.delete(f.key);
    const message = await enqueueDocumentReconcile(
      db,
      'backup-agency',
      { versionId: f.versionId },
      'stale-race',
    );
    const adapter = storage();
    let inspected!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((r) => {
      inspected = r;
    });
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    const stale = processDocumentReconcileMessage(
      db,
      {
        ...adapter,
        async observe(...args) {
          const result = await adapter.observe(...args);
          inspected();
          await barrier;
          return result;
        },
      },
      message,
    );
    try {
      await entered;
      await source.put(f.key, bytes, { customMetadata: { sha256: checksum } });
      expect(
        await processDocumentBackupMessage(
          db,
          source,
          createR2DocumentBackupAdapter(destination),
          f.message,
        ),
      ).toBe('COMPLETED');
      release();
      expect(await stale).toBe('RETRY_SCHEDULED');
      expect(
        await db
          .prepare('SELECT current_version_id FROM documents WHERE id=?')
          .bind(f.documentId)
          .first('current_version_id'),
      ).toBe(f.versionId);
      expect(
        await db
          .prepare('SELECT status FROM document_versions WHERE id=?')
          .bind(f.versionId)
          .first('status'),
      ).toBe('AVAILABLE');
      expect(
        await db
          .prepare(
            "SELECT count(*) AS n FROM system_audit_events WHERE action='document.reconcile.discrepancy' AND target_id=?",
          )
          .bind(message.jobId)
          .first('n'),
      ).toBe(0);
    } finally {
      release();
      await stale;
    }
  });
  it.each(['missing', 'checksum'] as const)(
    'existing backup evidence with %s bytes is investigated, not repaired',
    async (kind) => {
      const f = await available();
      const key = await db
        .prepare('SELECT object_key FROM document_backup_copies WHERE document_version_id=?')
        .bind(f.versionId)
        .first<string>('object_key');
      if (kind === 'missing') await destination.delete(key!);
      else {
        const metadata = (await destination.head(key!))!.customMetadata;
        await destination.put(key!, new Uint8Array(bytes.byteLength), { customMetadata: metadata });
      }
      expect(await reconcile(f.versionId)).toBe('INVESTIGATE');
      expect(
        await db
          .prepare('SELECT current_version_id FROM documents WHERE id=?')
          .bind(f.documentId)
          .first('current_version_id'),
      ).toBeNull();
      expect(
        await db
          .prepare('SELECT count(*) AS n FROM document_backup_copies WHERE document_version_id=?')
          .bind(f.versionId)
          .first('n'),
      ).toBe(1);
    },
  );
  it('converges an exact existing backup through the accepted durable backup executor', async () => {
    const f = await fixture();
    const identity = {
      agencyId: 'backup-agency',
      documentVersionId: f.versionId,
      generation: 1,
      sha256: checksum,
      sizeBytes: bytes.byteLength,
    };
    const proof = await createR2DocumentBackupAdapter(destination).createAndVerify(
      identity,
      bytes,
      new AbortController().signal,
    );
    const before = (await destination.head(proof.objectKey))!.etag;
    expect(await reconcile(f.versionId)).toBe('SAFE_REPAIR');
    expect(
      await db
        .prepare('SELECT status FROM document_versions WHERE id=?')
        .bind(f.versionId)
        .first('status'),
    ).toBe('AVAILABLE');
    expect(
      await db
        .prepare('SELECT count(*) AS n FROM document_backup_copies WHERE document_version_id=?')
        .bind(f.versionId)
        .first('n'),
    ).toBe(1);
    expect(
      await db
        .prepare(
          "SELECT count(*) AS n FROM system_audit_events WHERE action='document.backup.completed' AND target_id=?",
        )
        .bind(f.versionId)
        .first('n'),
    ).toBe(1);
    expect((await destination.head(proof.objectKey))!.etag).toBe(before);
    expect(await reconcile(f.versionId, 'verify-after')).toBe('SAFE_NOOP');
  });
  it('does not create a missing backup object or manufacture backup evidence', async () => {
    const f = await fixture();
    expect(await reconcile(f.versionId)).toBe('INVESTIGATE');
    expect(
      await db
        .prepare('SELECT status FROM document_versions WHERE id=?')
        .bind(f.versionId)
        .first('status'),
    ).toBe('BACKUP_PENDING');
    expect(
      await db
        .prepare('SELECT count(*) AS n FROM document_backup_copies WHERE document_version_id=?')
        .bind(f.versionId)
        .first('n'),
    ).toBe(0);
    expect(
      await destination.head(
        documentBackupObjectKey({
          agencyId: 'backup-agency',
          documentVersionId: f.versionId,
          generation: 1,
          sha256: checksum,
          sizeBytes: bytes.byteLength,
        }),
      ),
    ).toBeNull();
  });
  it('wrong existing backup bytes cannot finalize a pending version', async () => {
    const f = await fixture();
    const identity = {
      agencyId: 'backup-agency',
      documentVersionId: f.versionId,
      generation: 1,
      sha256: checksum,
      sizeBytes: bytes.byteLength,
    };
    const key = documentBackupObjectKey(identity);
    await destination.put(key, new Uint8Array(bytes.byteLength), {
      customMetadata: {
        agencyId: identity.agencyId,
        documentVersionId: f.versionId,
        generation: '1',
        sha256: checksum,
      },
    });
    expect(await reconcile(f.versionId)).toBe('INVESTIGATE');
    expect(
      await db
        .prepare('SELECT status FROM document_versions WHERE id=?')
        .bind(f.versionId)
        .first('status'),
    ).toBe('BACKUP_PENDING');
    expect(
      await db
        .prepare('SELECT count(*) AS n FROM document_backup_copies WHERE document_version_id=?')
        .bind(f.versionId)
        .first('n'),
    ).toBe(0);
    expect(await destination.head(key)).not.toBeNull();
  });
  it('a transient object read schedules a real durable retry', async () => {
    const f = await available();
    const message = await enqueueDocumentReconcile(
      db,
      'backup-agency',
      { versionId: f.versionId },
      'temporary',
    );
    const failing = {
      ...storage(),
      async observe() {
        throw new Error('synthetic dependency unavailable');
      },
    };
    expect(
      await processDocumentReconcileMessage(db, failing, message, { retryDelaySeconds: () => 1 }),
    ).toBe('RETRY_SCHEDULED');
    expect(
      await db
        .prepare('SELECT status FROM background_jobs WHERE id=?')
        .bind(message.jobId)
        .first('status'),
    ).toBe('RETRY_WAIT');
    expect(
      await db
        .prepare('SELECT status FROM background_job_runs WHERE job_id=?')
        .bind(message.jobId)
        .first('status'),
    ).toBe('RETRYABLE_ERROR');
    const at = await db
      .prepare('SELECT available_at FROM background_jobs WHERE id=?')
      .bind(message.jobId)
      .first<string>('available_at');
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, Date.parse(at!) - Date.now()) + 25),
    );
    expect(await processDocumentReconcileMessage(db, storage(), message)).toBe('SAFE_NOOP');
    expect(
      await db
        .prepare('SELECT attempt_count FROM background_jobs WHERE id=?')
        .bind(message.jobId)
        .first('attempt_count'),
    ).toBe(2);
  });
  it.each(['missing', 'checksum'] as const)(
    'records a primary %s discrepancy and unpublishes without changing evidence',
    async (kind) => {
      const f = await available();
      if (kind === 'missing') await source.delete(f.key);
      else
        await source.put(f.key, new Uint8Array(bytes.byteLength), {
          customMetadata: { sha256: checksum },
        });
      expect(await reconcile(f.versionId)).toBe('INVESTIGATE');
      expect(
        await db
          .prepare('SELECT current_version_id FROM documents WHERE id=?')
          .bind(f.documentId)
          .first('current_version_id'),
      ).toBeNull();
      expect(
        await db
          .prepare('SELECT count(*) AS n FROM document_backup_copies WHERE document_version_id=?')
          .bind(f.versionId)
          .first('n'),
      ).toBe(1);
      expect(
        await db
          .prepare(
            "SELECT reason_code FROM system_audit_events WHERE action='document.reconcile.discrepancy' AND json_extract(metadata_json,'$.versionId')=?",
          )
          .bind(f.versionId)
          .first('reason_code'),
      ).toBe(
        kind === 'missing' ? 'RECONCILE_PRIMARY_MISSING' : 'RECONCILE_PRIMARY_CHECKSUM_MISMATCH',
      );
    },
  );
  it('exact duplicate delivery and repeated discrepancy cycles do not duplicate evidence', async () => {
    const f = await available();
    await source.delete(f.key);
    const a = await enqueueDocumentReconcile(
      db,
      'backup-agency',
      { versionId: f.versionId },
      'cycle-a',
    );
    expect(
      await enqueueDocumentReconcile(db, 'backup-agency', { versionId: f.versionId }, 'cycle-a'),
    ).toEqual(a);
    expect(await processDocumentReconcileMessage(db, storage(), a)).toBe('INVESTIGATE');
    expect(await processDocumentReconcileMessage(db, storage(), a)).toBe('ACKED');
    expect(await reconcile(f.versionId, 'cycle-b')).toBe('INVESTIGATE');
    expect(
      await db
        .prepare(
          "SELECT count(*) AS n FROM system_audit_events WHERE action='document.reconcile.discrepancy' AND json_extract(metadata_json,'$.versionId')=?",
        )
        .bind(f.versionId)
        .first('n'),
    ).toBe(1);
    expect(
      await db
        .prepare('SELECT count(*) AS n FROM background_job_runs WHERE job_id=?')
        .bind(a.jobId)
        .first('n'),
    ).toBe(1);
  });
  it('verifies both actual object bodies and leaves a consistent AVAILABLE version unchanged', async () => {
    const f = await available();
    const before = await db
      .prepare('SELECT version FROM documents WHERE id=?')
      .bind(f.documentId)
      .first('version');
    expect(await reconcile(f.versionId)).toBe('SAFE_NOOP');
    expect(
      await db
        .prepare('SELECT version FROM documents WHERE id=?')
        .bind(f.documentId)
        .first('version'),
    ).toBe(before);
    expect(
      await db
        .prepare(
          "SELECT count(*) AS n FROM system_audit_events WHERE action='document.reconcile.discrepancy' AND json_extract(metadata_json,'$.versionId')=?",
        )
        .bind(f.versionId)
        .first('n'),
    ).toBe(0);
  });
});
