// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { createWorker, type Env } from '../src/server';
import { dispatchDueDocumentJobs } from '../src/server/documents/queue';

interface LocalDocumentBindings {
  readonly DB: D1Database;
  readonly DOCUMENT_SCAN_QUEUE: Queue<unknown>;
}

let db: D1Database | undefined;
let localQueue: Queue<unknown> | undefined;
let disposePlatform: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const platform = await getPlatformProxy<LocalDocumentBindings>({
    configPath: 'wrangler.jsonc',
    envFiles: [],
    persist: false,
    remoteBindings: false,
  });
  db = platform.env.DB;
  localQueue = platform.env.DOCUMENT_SCAN_QUEUE;
  disposePlatform = platform.dispose;
  await db
    .prepare(
      `
    CREATE TABLE background_jobs (
      id TEXT PRIMARY KEY,
      job_type TEXT NOT NULL,
      document_version_id TEXT,
      input_sha256 TEXT,
      generation INTEGER NOT NULL,
      status TEXT NOT NULL,
      available_at TEXT NOT NULL,
      queue_dispatched_at TEXT,
      updated_at TEXT NOT NULL
    )
  `,
    )
    .run();
});

afterAll(async () => {
  await disposePlatform?.();
});

beforeEach(async () => {
  if (!db) throw new Error('Local D1 binding was not initialized');
  await db.prepare('DELETE FROM background_jobs').run();
});

describe('document background job dispatcher', () => {
  it('publishes only due jobs and marks them for the five-minute duplicate-safe window', async () => {
    if (!db || !localQueue) throw new Error('Local D1/Queue bindings were not initialized');
    await db
      .prepare(
        `
      INSERT INTO background_jobs
        (id,job_type,document_version_id,input_sha256,generation,status,available_at,queue_dispatched_at,updated_at)
      VALUES
        ('job-due','DOCUMENT_SCAN','version-a','${'a'.repeat(64)}',1,'QUEUED',strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute'),NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        ('job-future','DOCUMENT_SCAN','version-b','${'b'.repeat(64)}',1,'QUEUED',strftime('%Y-%m-%dT%H:%M:%fZ','now','+1 hour'),NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        ('job-recent','DOCUMENT_SCAN','version-c','${'c'.repeat(64)}',1,'RETRY_WAIT',strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute'),strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        ('job-stale','DOCUMENT_BACKUP','version-d','${'d'.repeat(64)}',2,'QUEUED',strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute'),strftime('%Y-%m-%dT%H:%M:%fZ','now','-6 minutes'),strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        ('job-completed','DOCUMENT_SCAN','version-e','${'e'.repeat(64)}',1,'COMPLETED',strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute'),NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `,
      )
      .run();

    const sentMessages: unknown[] = [];
    const queue = {
      send: async (message: unknown) => {
        sentMessages.push(message);
        return await localQueue!.send(message);
      },
    };
    const result = await dispatchDueDocumentJobs(db, queue);

    expect(result).toEqual({ sent: 2, failed: 0 });
    expect(sentMessages).toEqual([
      {
        jobId: 'job-due',
        jobType: 'DOCUMENT_SCAN',
        documentVersionId: 'version-a',
        inputSha256: 'a'.repeat(64),
        generation: 1,
      },
      {
        jobId: 'job-stale',
        jobType: 'DOCUMENT_BACKUP',
        documentVersionId: 'version-d',
        inputSha256: 'd'.repeat(64),
        generation: 2,
      },
    ]);

    const stamps = await db
      .prepare('SELECT id, queue_dispatched_at FROM background_jobs ORDER BY id')
      .all<{ id: string; queue_dispatched_at: string | null }>();
    expect(stamps.results.find((row) => row.id === 'job-due')?.queue_dispatched_at).not.toBeNull();
    expect(
      stamps.results.find((row) => row.id === 'job-stale')?.queue_dispatched_at,
    ).not.toBeNull();
    expect(stamps.results.find((row) => row.id === 'job-future')?.queue_dispatched_at).toBeNull();
    expect(stamps.results.find((row) => row.id === 'job-recent')?.queue_dispatched_at).toContain(
      'T',
    );
    expect(
      stamps.results.find((row) => row.id === 'job-completed')?.queue_dispatched_at,
    ).toBeNull();

    await expect(dispatchDueDocumentJobs(db, queue)).resolves.toEqual({ sent: 0, failed: 0 });
  });

  it('leaves dispatch evidence unset when the local Queue publish fails', async () => {
    if (!db) throw new Error('Local D1 binding was not initialized');
    await db
      .prepare(
        `
      INSERT INTO background_jobs
        (id,job_type,document_version_id,input_sha256,generation,status,available_at,updated_at)
      VALUES('job-failed-send','DOCUMENT_SCAN','version-f','${'f'.repeat(64)}',1,'QUEUED',
        strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `,
      )
      .run();

    const result = await dispatchDueDocumentJobs(db, {
      send: async () => {
        throw new Error('synthetic queue unavailable');
      },
    });

    expect(result).toEqual({ sent: 0, failed: 1 });
    const row = await db
      .prepare("SELECT queue_dispatched_at FROM background_jobs WHERE id='job-failed-send'")
      .first<{ queue_dispatched_at: string | null }>();
    expect(row?.queue_dispatched_at).toBeNull();
  });

  it('dispatches due jobs from the five-minute Worker cron only when Queue is bound', async () => {
    if (!db || !localQueue) throw new Error('Local D1/Queue bindings were not initialized');
    await db
      .prepare(
        `
      INSERT INTO background_jobs
        (id,job_type,document_version_id,input_sha256,generation,status,available_at,updated_at)
      VALUES('job-scheduled','DOCUMENT_SCAN','version-scheduled','${'7'.repeat(64)}',1,'QUEUED',
        strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    `,
      )
      .run();

    const pendingWork: Promise<unknown>[] = [];
    const worker = createWorker();
    worker.scheduled(
      { cron: '*/5 * * * *' } as ScheduledController,
      { DB: db, DOCUMENT_SCAN_QUEUE: localQueue } as Env,
      {
        waitUntil: (promise: Promise<unknown>) => {
          pendingWork.push(promise);
        },
      } as unknown as ExecutionContext,
    );
    await Promise.all(pendingWork);

    const row = await db
      .prepare("SELECT queue_dispatched_at FROM background_jobs WHERE id='job-scheduled'")
      .first<{ queue_dispatched_at: string | null }>();
    expect(row?.queue_dispatched_at).not.toBeNull();

    const noQueueWork: Promise<unknown>[] = [];
    worker.scheduled(
      { cron: '*/5 * * * *' } as ScheduledController,
      { DB: db } as Env,
      {
        waitUntil: (promise: Promise<unknown>) => {
          noQueueWork.push(promise);
        },
      } as unknown as ExecutionContext,
    );
    expect(noQueueWork).toHaveLength(0);
  });
});
