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
  type DocumentBackupAdapter,
} from '../src/server/documents/backup-storage';
import { dispatchDueDocumentJobs } from '../src/server/documents/queue';
import type { DocumentJobQueueMessage } from '../src/server/documents/queue';
import { createSyntheticPdf } from './fixtures/documents';
import { createWorker } from '../src/server';
import {
  consumeDocumentQueueBatch,
  DOCUMENT_SCAN_DEAD_LETTER_QUEUE,
} from '../src/server/documents/scan';

let db: D1Database;
let legacyDb: D1Database;
let source: R2Bucket;
let destination: R2Bucket;
let dispose: () => Promise<void>;
let directory: string;
const bytes = createSyntheticPdf();
let checksum: string;

beforeAll(async () => {
  directory = mkdtempSync(join(tmpdir(), 'mayi-backup-'));
  const configPath = join(directory, 'wrangler.json');
  writeFileSync(
    configPath,
    JSON.stringify({
      name: 'mayi-backup-local',
      compatibility_date: '2026-09-01',
      compatibility_flags: ['nodejs_compat'],
      d1_databases: [
        {
          binding: 'DB',
          database_name: 'backup-local',
          database_id: '00000000-0000-0000-0000-000000000018',
        },
        {
          binding: 'LEGACY',
          database_name: 'backup-legacy',
          database_id: '00000000-0000-0000-0000-000000000017',
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
    LEGACY: D1Database;
    SOURCE: R2Bucket;
    BACKUP: R2Bucket;
  }>({ configPath, envFiles: [], persist: false, remoteBindings: false });
  db = platform.env.DB;
  legacyDb = platform.env.LEGACY;
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
      if (name.slice(0, 4) < '0017') await legacyDb.prepare(sql).run();
    }
  }
  checksum = Buffer.from(await crypto.subtle.digest('SHA-256', bytes)).toString('hex');
  for (const db of [platform.env.DB, legacyDb]) {
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

async function fixture(database = db, legacy = false, validated = false) {
  const db = database;
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
  if (validated) {
    await db
      .prepare(
        `INSERT INTO background_jobs(id,agency_id,job_type,document_version_id,input_sha256) VALUES(?,'backup-agency','DOCUMENT_BACKUP',?,?)`,
      )
      .bind(jobId, versionId, checksum)
      .run();
    await db
      .prepare(
        `UPDATE document_versions SET status='BACKUP_PENDING',validation_version='m4-content-inspection-v1',validation_result='{"valid":true,"format":"PDF","pageCount":1}' WHERE id=?`,
      )
      .bind(versionId)
      .run();
    await source.put(key, bytes, { customMetadata: { sha256: checksum } });
    return {
      documentId,
      versionId,
      scanId,
      scanRunId,
      jobId,
      key,
      message: {
        jobId,
        jobType: 'DOCUMENT_BACKUP' as const,
        generation: 1,
        documentVersionId: versionId,
        inputSha256: checksum,
      },
    };
  }
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
      `INSERT INTO document_scan_evidence(id,agency_id,document_version_id,job_run_id,sha256,outcome,scanner_engine_version,signature_version,signature_updated_at,scanned_at${legacy ? '' : ',content_inspection_version,content_inspection_result'})
    SELECT ?,'backup-agency',?,?,?,'CLEAN','synthetic-engine','synthetic-signature',strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute'),completed_at${legacy ? '' : `,'m4-content-inspection-v1','{"format":"PDF","pageCount":1,"valid":true}'`} FROM background_job_runs WHERE id=?`,
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

async function unpublished(versionId: string) {
  expect(
    await db
      .prepare('SELECT status FROM document_versions WHERE id=?')
      .bind(versionId)
      .first('status'),
  ).not.toBe('AVAILABLE');
  expect(
    await db
      .prepare('SELECT count(*) AS n FROM document_backup_copies WHERE document_version_id=?')
      .bind(versionId)
      .first('n'),
  ).toBe(0);
}

function batchProxy(
  hook: (statements: D1PreparedStatement[], call: number) => Promise<void>,
): D1Database {
  let calls = 0;
  return new Proxy(db, {
    get(target, property) {
      if (property === 'batch')
        return async (statements: D1PreparedStatement[]) => {
          await hook(statements, ++calls);
          return target.batch(statements);
        };
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function waitUntilDue(jobId: string) {
  const at = await db
    .prepare('SELECT available_at FROM background_jobs WHERE id=?')
    .bind(jobId)
    .first<string>('available_at');
  await new Promise((resolve) =>
    setTimeout(resolve, Math.max(0, Date.parse(at!) - Date.now()) + 25),
  );
}

describe('local synthetic DOCUMENT_BACKUP', () => {
  it('publishes a structurally accepted unscanned document after verified backup without CLEAN evidence', async () => {
    const f = await fixture(db, false, true);
    expect(
      await processDocumentBackupMessage(
        db,
        source,
        createR2DocumentBackupAdapter(destination),
        f.message,
      ),
    ).toBe('COMPLETED');
    expect(
      await db
        .prepare('SELECT status FROM document_versions WHERE id=?')
        .bind(f.versionId)
        .first('status'),
    ).toBe('AVAILABLE');
    expect(
      await db
        .prepare('SELECT count(*) AS count FROM document_scan_evidence WHERE document_version_id=?')
        .bind(f.versionId)
        .first('count'),
    ).toBe(0);
    expect(
      await db
        .prepare(
          "SELECT count(*) AS count FROM background_jobs WHERE document_version_id=? AND job_type='DOCUMENT_SCAN'",
        )
        .bind(f.versionId)
        .first('count'),
    ).toBe(0);
  });
  it('an expired worker cannot finalize after a newer lease holder completes the same job', async () => {
    const f = await fixture();
    const adapter = createR2DocumentBackupAdapter(destination);
    let copied!: () => void;
    let release!: () => void;
    const copiedBarrier = new Promise<void>((resolve) => {
      copied = resolve;
    });
    const releaseBarrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const oldAdapter: DocumentBackupAdapter = {
      async createAndVerify(...args) {
        const proof = await adapter.createAndVerify(...args);
        copied();
        await releaseBarrier;
        return proof;
      },
    };
    const old = processDocumentBackupMessage(db, source, oldAdapter, f.message);
    try {
      await copiedBarrier;
      await db
        .prepare(
          `UPDATE background_jobs SET lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second') WHERE id=?`,
        )
        .bind(f.jobId)
        .run();
      expect(await processDocumentBackupMessage(db, source, adapter, f.message)).toBe('ACKED');
      await waitUntilDue(f.jobId);
      expect(await processDocumentBackupMessage(db, source, adapter, f.message)).toBe('COMPLETED');
      release();
      expect(await old).toBe('ACKED');
      expect(
        await db
          .prepare('SELECT attempt_count FROM background_jobs WHERE id=?')
          .bind(f.jobId)
          .first('attempt_count'),
      ).toBe(2);
      const runs = await db
        .prepare('SELECT status FROM background_job_runs WHERE job_id=? ORDER BY attempt_number')
        .bind(f.jobId)
        .all<{ status: string }>();
      expect(runs.results.map((run) => run.status)).toEqual(['STALE', 'SUCCEEDED']);
      expect(
        await db
          .prepare('SELECT count(*) AS n FROM document_backup_copies WHERE document_version_id=?')
          .bind(f.versionId)
          .first('n'),
      ).toBe(1);
      expect(
        await db
          .prepare('SELECT count(*) AS n FROM system_audit_events WHERE target_id=?')
          .bind(f.versionId)
          .first('n'),
      ).toBe(1);
    } finally {
      release();
      await old;
    }
  }, 180000);
  it('actual D1 audit failure rolls back job/run/copy/AVAILABLE but keeps the successfully written object', async () => {
    const f = await fixture();
    await db
      .prepare(
        `CREATE TRIGGER synthetic_backup_audit_failure BEFORE INSERT ON system_audit_events WHEN NEW.target_id='${f.versionId}' BEGIN SELECT RAISE(ABORT,'SYNTHETIC_BACKUP_AUDIT_FAILURE'); END`,
      )
      .run();
    try {
      expect(
        await processDocumentBackupMessage(
          db,
          source,
          createR2DocumentBackupAdapter(destination),
          f.message,
          { retryDelaySeconds: () => 1 },
        ),
      ).toBe('RETRY_SCHEDULED');
      await unpublished(f.versionId);
      expect(
        await db
          .prepare('SELECT status FROM background_job_runs WHERE job_id=?')
          .bind(f.jobId)
          .first('status'),
      ).toBe('RETRYABLE_ERROR');
      const key = documentBackupObjectKey({
        agencyId: 'backup-agency',
        documentVersionId: f.versionId,
        generation: 1,
        sha256: checksum,
        sizeBytes: bytes.byteLength,
      });
      expect(await destination.head(key)).not.toBeNull();
    } finally {
      await db.prepare('DROP TRIGGER synthetic_backup_audit_failure').run();
    }
    await waitUntilDue(f.jobId);
    expect(
      await processDocumentBackupMessage(
        db,
        source,
        createR2DocumentBackupAdapter(destination),
        f.message,
      ),
    ).toBe('COMPLETED');
  });
  it('legacy CLEAN without accepted inspection is denied after the immutable 0017 upgrade', async () => {
    const f = await fixture(legacyDb, true);
    for (const name of [
      '0017_document_scan_inspection_evidence.sql',
      '0018_document_backup_terminal_failure.sql',
      '0019_m4_internal_document_validation.sql',
    ]) {
      for (const sql of readFileSync(resolve('db/migrations', name), 'utf8')
        .split('--> statement-breakpoint')
        .map((sql) => sql.trim())
        .filter(Boolean))
        await legacyDb.prepare(sql).run();
    }
    expect(
      await processDocumentBackupMessage(
        legacyDb,
        {
          get() {
            throw new Error('legacy must not read');
          },
        },
        createR2DocumentBackupAdapter(destination),
        f.message,
      ),
    ).toBe('FAILED_CLOSED');
    expect(
      await legacyDb
        .prepare('SELECT status FROM document_versions WHERE id=?')
        .bind(f.versionId)
        .first('status'),
    ).toBe('SCAN_FAILED');
    expect(
      await legacyDb
        .prepare('SELECT count(*) AS n FROM document_backup_copies WHERE document_version_id=?')
        .bind(f.versionId)
        .first('n'),
    ).toBe(0);
  });
  it.each(['short', 'long', 'error'] as const)(
    'cannot publish an incompletely consumed %s source stream',
    async (kind) => {
      const f = await fixture();
      const sourceView = {
        async get() {
          const original = await source.get(f.key);
          await original!.body.cancel();
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(
                kind === 'long'
                  ? new Uint8Array(bytes.byteLength + 1)
                  : bytes.subarray(0, bytes.byteLength - 1),
              );
              if (kind === 'error') controller.error(new Error('synthetic temporary read failure'));
              else controller.close();
            },
          });
          return { ...original!, body } as R2ObjectBody;
        },
      };
      expect(
        await processDocumentBackupMessage(
          db,
          sourceView,
          createR2DocumentBackupAdapter(destination),
          f.message,
        ),
      ).toBe(kind === 'error' ? 'RETRY_SCHEDULED' : 'FAILED_CLOSED');
      await unpublished(f.versionId);
    },
  );
  it('a stale generation cannot publish after a newer generation succeeds', async () => {
    const f = await fixture();
    const adapter = createR2DocumentBackupAdapter(destination);
    const stale: DocumentBackupAdapter = {
      async createAndVerify(...args) {
        const proof = await adapter.createAndVerify(...args);
        await db
          .prepare(
            `UPDATE background_job_runs SET status='PERMANENT_ERROR',reason_code='BACKUP_PREREQUISITES_CHANGED',completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE job_id=? AND status='RUNNING'`,
          )
          .bind(f.jobId)
          .run();
        await db
          .prepare(
            `UPDATE background_jobs SET status='DEAD',last_error_code='BACKUP_PREREQUISITES_CHANGED',lease_token_hash=NULL,lease_expires_at=NULL,completed_at=strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id=?`,
          )
          .bind(f.jobId)
          .run();
        const nextId = crypto.randomUUID();
        await db
          .prepare(
            `INSERT INTO background_jobs(id,agency_id,job_type,document_version_id,input_sha256,generation) VALUES(?,'backup-agency','DOCUMENT_BACKUP',?,?,2)`,
          )
          .bind(nextId, f.versionId, checksum)
          .run();
        await db
          .prepare("UPDATE document_versions SET status='BACKUP_PENDING' WHERE id=?")
          .bind(f.versionId)
          .run();
        expect(
          await processDocumentBackupMessage(db, source, adapter, {
            ...f.message,
            jobId: nextId,
            generation: 2,
          }),
        ).toBe('COMPLETED');
        return proof;
      },
    };
    expect(await processDocumentBackupMessage(db, source, stale, f.message)).toBe('ACKED');
    expect(
      await db
        .prepare('SELECT count(*) AS n FROM document_backup_copies WHERE document_version_id=?')
        .bind(f.versionId)
        .first('n'),
    ).toBe(1);
    expect(
      await db
        .prepare(
          `SELECT job.generation FROM document_backup_copies copy JOIN background_job_runs run ON run.id=copy.job_run_id JOIN background_jobs job ON job.id=run.job_id WHERE copy.document_version_id=?`,
        )
        .bind(f.versionId)
        .first('generation'),
    ).toBe(2);
  });
  it('five temporary source failures reach DEAD without an endless retry', async () => {
    const f = await fixture();
    await source.delete(f.key);
    for (let attempt = 1; attempt <= 5; attempt++) {
      expect(
        await processDocumentBackupMessage(
          db,
          source,
          createR2DocumentBackupAdapter(destination),
          f.message,
          { retryDelaySeconds: () => 1 },
        ),
      ).toBe(attempt === 5 ? 'FAILED_CLOSED' : 'RETRY_SCHEDULED');
      if (attempt < 5) await waitUntilDue(f.jobId);
    }
    expect(
      await db
        .prepare('SELECT status FROM background_jobs WHERE id=?')
        .bind(f.jobId)
        .first('status'),
    ).toBe('DEAD');
    expect(
      await db
        .prepare('SELECT attempt_count FROM background_jobs WHERE id=?')
        .bind(f.jobId)
        .first('attempt_count'),
    ).toBe(5);
    await unpublished(f.versionId);
  });
  it('exposes only the durability operation, no delete/read/list or raw bucket', () => {
    const adapter = createR2DocumentBackupAdapter(destination);
    expect(Object.keys(adapter)).toEqual(['createAndVerify']);
    expect('delete' in adapter).toBe(false);
    expect('get' in adapter).toBe(false);
    expect(Object.isFrozen(adapter)).toBe(true);
    // @ts-expect-error The application runtime cannot obtain backup delete capability.
    expect(adapter.delete).toBeUndefined();
  });
  it.each(['version', 'checksum', 'generation'] as const)(
    'rejects a wrong Queue %s identity without any storage operation',
    async (kind) => {
      const f = await fixture();
      const message = {
        ...f.message,
        ...(kind === 'version'
          ? { documentVersionId: crypto.randomUUID() }
          : kind === 'checksum'
            ? { inputSha256: 'f'.repeat(64) }
            : { generation: 2 }),
      };
      const trap: DocumentBackupAdapter = {
        createAndVerify() {
          throw new Error('must not write');
        },
      };
      expect(
        await processDocumentBackupMessage(
          db,
          {
            get() {
              throw new Error('must not read');
            },
          },
          trap,
          message,
        ),
      ).toBe('ACKED');
      await unpublished(f.versionId);
      expect(
        await db
          .prepare('SELECT attempt_count FROM background_jobs WHERE id=?')
          .bind(f.jobId)
          .first('attempt_count'),
      ).toBe(0);
    },
  );
  it('denies superseded CLEAN evidence before reading bytes', async () => {
    const f = await fixture();
    await db
      .prepare(
        `INSERT INTO background_jobs(id,agency_id,job_type,document_version_id,input_sha256,generation) VALUES(?,'backup-agency','DOCUMENT_SCAN',?,?,2)`,
      )
      .bind(crypto.randomUUID(), f.versionId, checksum)
      .run();
    expect(
      await processDocumentBackupMessage(
        db,
        {
          get() {
            throw new Error('must not read');
          },
        },
        createR2DocumentBackupAdapter(destination),
        f.message,
      ),
    ).toBe('FAILED_CLOSED');
    await unpublished(f.versionId);
  });
  it('denies an older DocumentVersion after a newer revision exists', async () => {
    const f = await fixture();
    await db
      .prepare(
        `INSERT INTO document_versions(id,agency_id,document_id,version_number,object_key,sha256,size_bytes,file_name,detected_content_type,created_by_user_id,created_by_membership_id)
      VALUES(?,'backup-agency',?,2,?,?,?,'synthetic.pdf','application/pdf','backup-user','backup-member')`,
      )
      .bind(
        crypto.randomUUID(),
        f.documentId,
        `quarantine/${crypto.randomUUID()}`,
        checksum,
        bytes.byteLength,
      )
      .run();
    expect(
      await processDocumentBackupMessage(
        db,
        source,
        createR2DocumentBackupAdapter(destination),
        f.message,
      ),
    ).toBe('FAILED_CLOSED');
    await unpublished(f.versionId);
  });
  it('retries a missing source without publishing', async () => {
    const f = await fixture();
    await source.delete(f.key);
    expect(
      await processDocumentBackupMessage(
        db,
        source,
        createR2DocumentBackupAdapter(destination),
        f.message,
        { retryDelaySeconds: () => 1 },
      ),
    ).toBe('RETRY_SCHEDULED');
    await unpublished(f.versionId);
  });
  it('converges after an object write succeeds but the D1 completion batch fails', async () => {
    const f = await fixture();
    const database = batchProxy(async (_, call) => {
      if (call === 2) throw new Error('synthetic D1 unavailable');
    });
    const adapter = createR2DocumentBackupAdapter(destination);
    expect(
      await processDocumentBackupMessage(database, source, adapter, f.message, {
        retryDelaySeconds: () => 1,
      }),
    ).toBe('RETRY_SCHEDULED');
    await unpublished(f.versionId);
    const key = documentBackupObjectKey({
      agencyId: 'backup-agency',
      documentVersionId: f.versionId,
      generation: 1,
      sha256: checksum,
      sizeBytes: bytes.byteLength,
    });
    const first = await destination.head(key);
    expect(first).not.toBeNull();
    await waitUntilDue(f.jobId);
    expect(await processDocumentBackupMessage(db, source, adapter, f.message)).toBe('COMPLETED');
    expect((await destination.head(key))?.etag).toBe(first?.etag);
    expect(
      await db
        .prepare('SELECT count(*) AS n FROM document_backup_copies WHERE document_version_id=?')
        .bind(f.versionId)
        .first('n'),
    ).toBe(1);
    expect(
      await db
        .prepare('SELECT count(*) AS n FROM system_audit_events WHERE target_id=?')
        .bind(f.versionId)
        .first('n'),
    ).toBe(1);
  });
  it('an exact duplicate never repeats storage, audit or AVAILABLE transition', async () => {
    const f = await fixture();
    expect(
      await processDocumentBackupMessage(
        db,
        source,
        createR2DocumentBackupAdapter(destination),
        f.message,
      ),
    ).toBe('COMPLETED');
    const before = await db
      .prepare('SELECT version FROM documents WHERE id=?')
      .bind(f.documentId)
      .first('version');
    const trap: DocumentBackupAdapter = {
      createAndVerify() {
        throw new Error('duplicate cannot write');
      },
    };
    expect(
      await processDocumentBackupMessage(
        db,
        {
          get() {
            throw new Error('duplicate cannot read');
          },
        },
        trap,
        f.message,
      ),
    ).toBe('ACKED');
    expect(
      await db
        .prepare('SELECT version FROM documents WHERE id=?')
        .bind(f.documentId)
        .first('version'),
    ).toBe(before);
    expect(
      await db
        .prepare('SELECT count(*) AS n FROM document_backup_copies WHERE document_version_id=?')
        .bind(f.versionId)
        .first('n'),
    ).toBe(1);
    expect(
      await db
        .prepare('SELECT count(*) AS n FROM system_audit_events WHERE target_id=?')
        .bind(f.versionId)
        .first('n'),
    ).toBe(1);
  });
  it('competing claim CAS workers converge on one copy and success audit', async () => {
    const f = await fixture();
    let release!: () => void;
    const barrier = new Promise<void>((r) => {
      release = r;
    });
    const database = batchProxy(async (_, call) => {
      if (call <= 2) {
        if (call === 2) release();
        await barrier;
      }
    });
    const results = await Promise.all(
      [1, 2].map(() =>
        processDocumentBackupMessage(
          database,
          source,
          createR2DocumentBackupAdapter(destination),
          f.message,
        ),
      ),
    );
    expect(results.sort()).toEqual(['ACKED', 'COMPLETED']);
    expect(
      await db
        .prepare('SELECT count(*) AS n FROM document_backup_copies WHERE document_version_id=?')
        .bind(f.versionId)
        .first('n'),
    ).toBe(1);
    expect(
      await db
        .prepare('SELECT count(*) AS n FROM background_job_runs WHERE job_id=?')
        .bind(f.jobId)
        .first('n'),
    ).toBe(1);
    expect(
      await db
        .prepare('SELECT count(*) AS n FROM system_audit_events WHERE target_id=?')
        .bind(f.versionId)
        .first('n'),
    ).toBe(1);
  });
  it('an expired lease after the object write cannot leave false completion evidence', async () => {
    const f = await fixture();
    const adapter = createR2DocumentBackupAdapter(destination);
    const expire: DocumentBackupAdapter = {
      async createAndVerify(...args) {
        const proof = await adapter.createAndVerify(...args);
        await db
          .prepare(
            `UPDATE background_jobs SET lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second') WHERE id=?`,
          )
          .bind(f.jobId)
          .run();
        return proof;
      },
    };
    expect(await processDocumentBackupMessage(db, source, expire, f.message)).toBe('ACKED');
    await unpublished(f.versionId);
    expect(
      await db
        .prepare('SELECT status FROM background_job_runs WHERE job_id=?')
        .bind(f.jobId)
        .first('status'),
    ).toBe('RUNNING');
    expect(
      await db
        .prepare('SELECT count(*) AS n FROM system_audit_events WHERE target_id=?')
        .bind(f.versionId)
        .first('n'),
    ).toBe(0);
  });
  it('a newer scan during copy prevents finalization and keeps the backup object for future reconciliation', async () => {
    const f = await fixture();
    const adapter = createR2DocumentBackupAdapter(destination);
    let key = '';
    const supersede: DocumentBackupAdapter = {
      async createAndVerify(...args) {
        const proof = await adapter.createAndVerify(...args);
        key = proof.objectKey;
        await db
          .prepare(
            `INSERT INTO background_jobs(id,agency_id,job_type,document_version_id,input_sha256,generation) VALUES(?,'backup-agency','DOCUMENT_SCAN',?,?,2)`,
          )
          .bind(crypto.randomUUID(), f.versionId, checksum)
          .run();
        return proof;
      },
    };
    expect(await processDocumentBackupMessage(db, source, supersede, f.message)).toBe(
      'FAILED_CLOSED',
    );
    await unpublished(f.versionId);
    expect(await destination.head(key)).not.toBeNull();
    expect(
      await db
        .prepare('SELECT status FROM background_jobs WHERE id=?')
        .bind(f.jobId)
        .first('status'),
    ).toBe('DEAD');
    // An obsolete active backup must not block the next scan's durable backup job creation.
    await db
      .prepare(
        `INSERT INTO background_jobs(id,agency_id,job_type,document_version_id,input_sha256,generation)
      VALUES(?,'backup-agency','DOCUMENT_BACKUP',?,?,2)`,
      )
      .bind(crypto.randomUUID(), f.versionId, checksum)
      .run();
  });
  it('backup immutable update/delete guards remain active', async () => {
    const f = await fixture();
    expect(
      await processDocumentBackupMessage(
        db,
        source,
        createR2DocumentBackupAdapter(destination),
        f.message,
      ),
    ).toBe('COMPLETED');
    await expect(
      db
        .prepare('UPDATE document_backup_copies SET backup_sha256=? WHERE document_version_id=?')
        .bind('f'.repeat(64), f.versionId)
        .run(),
    ).rejects.toThrow('DOCUMENT_BACKUP_EVIDENCE_IMMUTABLE');
    await expect(
      db
        .prepare('DELETE FROM document_backup_copies WHERE document_version_id=?')
        .bind(f.versionId)
        .run(),
    ).rejects.toThrow('DOCUMENT_BACKUP_EVIDENCE_IMMUTABLE');
  });
  it('tenant/generation/checksum identity produces separate server-owned private keys', async () => {
    const identity = {
      agencyId: 'backup-agency',
      documentVersionId: 'same-version',
      generation: 1,
      sha256: checksum,
      sizeBytes: bytes.byteLength,
    };
    const keys = [
      identity,
      { ...identity, agencyId: 'another-agency' },
      { ...identity, generation: 2 },
      { ...identity, sha256: 'f'.repeat(64) },
    ].map(documentBackupObjectKey);
    expect(new Set(keys).size).toBe(4);
    keys.forEach((key) => expect(key).toMatch(/^backup\/[0-9a-f-]{36}$/u));
    const adapter = createR2DocumentBackupAdapter(destination);
    const proof = await adapter.createAndVerify(identity, bytes, new AbortController().signal);
    await destination.put(proof.objectKey, bytes, {
      customMetadata: {
        agencyId: 'another-agency',
        documentVersionId: identity.documentVersionId,
        generation: '1',
        sha256: checksum,
      },
    });
    await expect(
      adapter.createAndVerify(identity, bytes, new AbortController().signal),
    ).rejects.toThrow('BACKUP_OBJECT_IDENTITY_MISMATCH');
    expect((await destination.head(proof.objectKey))?.customMetadata?.agencyId).toBe(
      'another-agency',
    );
  });
  it('verifies an existing backup body rather than trusting metadata or etag', async () => {
    const f = await fixture();
    const identity = {
      agencyId: 'backup-agency',
      documentVersionId: f.versionId,
      generation: 1,
      sha256: checksum,
      sizeBytes: bytes.byteLength,
    };
    await destination.put(documentBackupObjectKey(identity), new Uint8Array(bytes.byteLength), {
      customMetadata: {
        agencyId: identity.agencyId,
        documentVersionId: f.versionId,
        generation: '1',
        sha256: checksum,
      },
    });
    expect(
      await processDocumentBackupMessage(
        db,
        source,
        createR2DocumentBackupAdapter(destination),
        f.message,
      ),
    ).toBe('FAILED_CLOSED');
    await unpublished(f.versionId);
  });
  it('dispatches a durable backup envelope on the existing Queue path', async () => {
    const f = await fixture();
    const sent: DocumentJobQueueMessage[] = [];
    await dispatchDueDocumentJobs(
      db,
      {
        async send(message) {
          sent.push(message);
          return { metadata: { metrics: { backlogCount: 0, backlogBytes: 0 } } };
        },
      },
      ['DOCUMENT_BACKUP'],
    );
    expect(sent).toContainEqual(f.message);
  });
  it('reclaims an expired backup lease for persistent retry', async () => {
    const f = await fixture();
    const stalled: DocumentBackupAdapter = {
      async createAndVerify() {
        return await new Promise(() => undefined);
      },
    };
    expect(
      await processDocumentBackupMessage(db, source, stalled, f.message, { timeoutMs: 1000 }),
    ).toBe('RETRY_DELIVERY');
    await db
      .prepare(
        `UPDATE background_jobs SET lease_expires_at=strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 second') WHERE id=?`,
      )
      .bind(f.jobId)
      .run();
    expect(
      await processDocumentBackupMessage(
        db,
        source,
        createR2DocumentBackupAdapter(destination),
        f.message,
      ),
    ).toBe('ACKED');
    expect(
      await db
        .prepare('SELECT status FROM background_jobs WHERE id=?')
        .bind(f.jobId)
        .first('status'),
    ).toBe('RETRY_WAIT');
    expect(
      await db
        .prepare('SELECT status FROM background_job_runs WHERE job_id=?')
        .bind(f.jobId)
        .first('status'),
    ).toBe('STALE');
  });
  it('terminates an integrity mismatch without retrying or publishing', async () => {
    const f = await fixture();
    await source.put(f.key, new Uint8Array(bytes.byteLength), {
      customMetadata: { sha256: checksum },
    });
    expect(
      await processDocumentBackupMessage(
        db,
        source,
        createR2DocumentBackupAdapter(destination),
        f.message,
      ),
    ).toBe('FAILED_CLOSED');
    expect(
      await db
        .prepare('SELECT status FROM background_jobs WHERE id=?')
        .bind(f.jobId)
        .first('status'),
    ).toBe('DEAD');
    expect(
      await db
        .prepare('SELECT attempt_count FROM background_jobs WHERE id=?')
        .bind(f.jobId)
        .first('attempt_count'),
    ).toBe(1);
    expect(
      await db
        .prepare('SELECT status FROM document_versions WHERE id=?')
        .bind(f.versionId)
        .first('status'),
    ).toBe('SCAN_FAILED');
    expect(
      await db
        .prepare('SELECT count(*) AS n FROM document_backup_copies WHERE document_version_id=?')
        .bind(f.versionId)
        .first('n'),
    ).toBe(0);
  });
  it('copies exact CLEAN bytes before atomically publishing immutable evidence and AVAILABLE', async () => {
    const f = await fixture();
    expect(
      await processDocumentBackupMessage(
        db,
        source,
        createR2DocumentBackupAdapter(destination),
        f.message,
      ),
    ).toBe('COMPLETED');
    expect(
      await db
        .prepare('SELECT status FROM document_versions WHERE id=?')
        .bind(f.versionId)
        .first('status'),
    ).toBe('AVAILABLE');
    expect(
      await db
        .prepare('SELECT current_version_id FROM documents WHERE id=?')
        .bind(f.documentId)
        .first('current_version_id'),
    ).toBe(f.versionId);
    const copy = await db
      .prepare('SELECT * FROM document_backup_copies WHERE document_version_id=?')
      .bind(f.versionId)
      .first<{ object_key: string; source_sha256: string; backup_sha256: string }>();
    expect(copy?.source_sha256).toBe(checksum);
    expect(copy?.backup_sha256).toBe(checksum);
    const object = await destination.get(copy!.object_key);
    expect(Buffer.from(await object!.arrayBuffer())).toEqual(Buffer.from(bytes));
  });
  it('the Worker Queue path processes backup independently of scanner availability', async () => {
    const f = await fixture();
    const delivery = queueBatch(f.message);
    await createWorker(undefined, createR2DocumentBackupAdapter(destination)).queue(
      delivery.batch,
      { DB: db, DOCS_QUARANTINE: source, DOCUMENT_JOBS_ENABLED: 'true' },
    );
    expect(delivery.acks()).toBe(1);
    expect(delivery.retries()).toBe(0);
    expect(
      await db
        .prepare('SELECT status FROM document_versions WHERE id=?')
        .bind(f.versionId)
        .first('status'),
    ).toBe('AVAILABLE');
  });
  it('missing narrow backup capability retries delivery instead of falsely acknowledging work', async () => {
    const f = await fixture();
    const delivery = queueBatch(f.message);
    await createWorker().queue(delivery.batch, {
      DB: db,
      DOCS_QUARANTINE: source,
      DOCUMENTS_ENABLED: 'true',
      DOCUMENT_JOBS_ENABLED: 'true',
    });
    expect(delivery.acks()).toBe(0);
    expect(delivery.retries()).toBe(1);
    await unpublished(f.versionId);
  });
  it('the disabled module performs no backup object work', async () => {
    const f = await fixture();
    const delivery = queueBatch(f.message);
    const trap: DocumentBackupAdapter = {
      createAndVerify() {
        throw new Error('disabled must not write');
      },
    };
    await createWorker(undefined, trap).queue(delivery.batch, {
      DB: db,
      DOCS_QUARANTINE: source,
      DOCUMENTS_ENABLED: 'false',
    });
    expect(delivery.acks()).toBe(1);
    await unpublished(f.versionId);
  });
  it('backup Queue exhaustion persists exact durable identity and a visible job error', async () => {
    const f = await fixture();
    const delivery = queueBatch(f.message, DOCUMENT_SCAN_DEAD_LETTER_QUEUE);
    await consumeDocumentQueueBatch(delivery.batch, db, source, false);
    expect(delivery.acks()).toBe(1);
    expect(
      await db
        .prepare('SELECT last_error_code FROM background_jobs WHERE id=?')
        .bind(f.jobId)
        .first('last_error_code'),
    ).toBe('QUEUE_DELIVERY_EXHAUSTED');
    expect(
      await db
        .prepare('SELECT document_version_id FROM document_queue_dead_letter_events WHERE job_id=?')
        .bind(f.jobId)
        .first('document_version_id'),
    ).toBe(f.versionId);
  });
});

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
