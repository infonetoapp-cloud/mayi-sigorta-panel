// @vitest-environment node

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { createWorker, type Env } from '../src/server';
import {
  DOCUMENT_SCAN_DEAD_LETTER_QUEUE,
  DOCUMENT_SCAN_OVERFLOW_QUEUE,
  DOCUMENT_SCAN_TERMINAL_QUEUE,
} from '../src/server/documents/scan';
import {
  dispatchDueDocumentJobs,
  type DocumentJobQueueMessage,
} from '../src/server/documents/queue';

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
    agency_id TEXT,
    job_type TEXT NOT NULL,
    document_version_id TEXT,
    input_sha256 TEXT,
    generation INTEGER NOT NULL,
    status TEXT NOT NULL,
    attempt_count INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 5,
    last_error_code TEXT,
    available_at TEXT NOT NULL,
    lease_token_hash TEXT,
    lease_expires_at TEXT,
    queue_dispatched_at TEXT,
      updated_at TEXT NOT NULL
    )
  `,
    )
    .run();
  await db
    .prepare(
      `CREATE TABLE document_queue_dead_letter_events (
        id TEXT PRIMARY KEY NOT NULL,
        message_id TEXT NOT NULL,
        queue_name TEXT NOT NULL,
        job_id TEXT,
        job_generation INTEGER,
        document_version_id TEXT,
        input_sha256 TEXT,
        reason_code TEXT NOT NULL,
        received_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        UNIQUE(queue_name,message_id)
      )`,
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
        ('job-stale','DOCUMENT_BACKUP','version-d','${'d'.repeat(64)}',2,'QUEUED',strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 minute'),NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
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

    expect(result).toEqual({ sent: 1, failed: 0 });
    expect(sentMessages).toEqual([
      {
        jobId: 'job-due',
        jobType: 'DOCUMENT_SCAN',
        documentVersionId: 'version-a',
        inputSha256: 'a'.repeat(64),
        generation: 1,
      },
    ]);

    const stamps = await db
      .prepare('SELECT id, queue_dispatched_at FROM background_jobs ORDER BY id')
      .all<{ id: string; queue_dispatched_at: string | null }>();
    expect(stamps.results.find((row) => row.id === 'job-due')?.queue_dispatched_at).not.toBeNull();
    expect(stamps.results.find((row) => row.id === 'job-stale')?.queue_dispatched_at).toBeNull();
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
    await db
      .prepare(
        `INSERT INTO background_jobs
          (id,job_type,document_version_id,input_sha256,generation,status,available_at,updated_at)
         VALUES('job-scheduled-backup','DOCUMENT_BACKUP','version-scheduled-backup','${'6'.repeat(64)}',
           1,'QUEUED',strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      )
      .run();

    const pendingWork: Promise<unknown>[] = [];
    const worker = createWorker();
    worker.scheduled(
      { cron: '*/5 * * * *' } as ScheduledController,
      { DB: db, DOCUMENT_SCAN_QUEUE: localQueue, DOCUMENTS_ENABLED: 'true' } as Env,
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
    const backupRow = await db
      .prepare("SELECT queue_dispatched_at FROM background_jobs WHERE id='job-scheduled-backup'")
      .first<{ queue_dispatched_at: string | null }>();
    expect(backupRow?.queue_dispatched_at).toBeNull();

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

  it('acks Queue delivery without processing when the document module is disabled', async () => {
    if (!db) throw new Error('Local D1 binding was not initialized');
    await db
      .prepare(
        `INSERT INTO background_jobs
          (id,job_type,document_version_id,input_sha256,generation,status,available_at,updated_at)
         VALUES('job-disabled','DOCUMENT_SCAN','version-disabled','${'8'.repeat(64)}',1,'QUEUED',
           strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      )
      .run();
    let acknowledged = 0;
    let retried = 0;
    const queueMessage = {
      id: 'message-disabled',
      timestamp: new Date(),
      body: {
        jobId: 'job-disabled',
        jobType: 'DOCUMENT_SCAN',
        generation: 1,
        documentVersionId: 'version-disabled',
        inputSha256: '8'.repeat(64),
      },
      ack: () => {
        acknowledged += 1;
      },
      retry: () => {
        retried += 1;
      },
    };
    await createWorker().queue(
      {
        queue: 'mayisigorta-document-scan',
        messages: [queueMessage],
      } as unknown as MessageBatch<DocumentJobQueueMessage>,
      { DB: db, DOCUMENTS_ENABLED: 'false' } as Env,
    );

    expect(acknowledged).toBe(1);
    expect(retried).toBe(0);
    const durableJob = await db
      .prepare("SELECT status,attempt_count FROM background_jobs WHERE id='job-disabled'")
      .first<{ status: string; attempt_count: number }>();
    expect(durableJob).toEqual({ status: 'QUEUED', attempt_count: 0 });
  });

  it('persists an exhausted scan delivery marker from the dead-letter queue', async () => {
    if (!db) throw new Error('Local D1 binding was not initialized');
    await db
      .prepare(
        `INSERT INTO background_jobs
          (id,job_type,document_version_id,input_sha256,generation,status,available_at,updated_at)
         VALUES('job-dead-letter','DOCUMENT_SCAN','version-dead-letter','${'9'.repeat(64)}',1,'QUEUED',
           strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      )
      .run();
    let acknowledged = 0;
    let retried = 0;
    const queueMessage = {
      id: 'message-dead-letter',
      timestamp: new Date(),
      body: {
        jobId: 'job-dead-letter',
        jobType: 'DOCUMENT_SCAN',
        generation: 1,
        documentVersionId: 'version-dead-letter',
        inputSha256: '9'.repeat(64),
      },
      ack: () => {
        acknowledged += 1;
      },
      retry: () => {
        retried += 1;
      },
    };

    await createWorker().queue(
      {
        queue: DOCUMENT_SCAN_DEAD_LETTER_QUEUE,
        messages: [queueMessage],
      } as unknown as MessageBatch<DocumentJobQueueMessage>,
      { DB: db, DOCUMENTS_ENABLED: 'false' } as Env,
    );

    expect(acknowledged).toBe(1);
    expect(retried).toBe(0);
    const job = await db
      .prepare("SELECT status,last_error_code FROM background_jobs WHERE id='job-dead-letter'")
      .first<{ status: string; last_error_code: string | null }>();
    expect(job).toEqual({ status: 'QUEUED', last_error_code: 'QUEUE_DELIVERY_EXHAUSTED' });
    const event = await db
      .prepare(
        "SELECT queue_name,message_id,reason_code,job_id FROM document_queue_dead_letter_events WHERE message_id='message-dead-letter'",
      )
      .first();
    expect(event).toEqual({
      queue_name: DOCUMENT_SCAN_DEAD_LETTER_QUEUE,
      message_id: 'message-dead-letter',
      reason_code: 'QUEUE_DELIVERY_EXHAUSTED',
      job_id: 'job-dead-letter',
    });
  });

  it('retries malformed primary deliveries until durable dead-letter evidence is recorded', async () => {
    if (!db) throw new Error('Local D1 binding was not initialized');
    let acknowledged = 0;
    let retries = 0;
    let retryDelay: number | undefined;
    const queueMessage = {
      id: 'message-poison-primary',
      timestamp: new Date(),
      body: { customerName: 'synthetic payload must not be persisted' },
      ack: () => {
        acknowledged += 1;
      },
      retry: (options: { delaySeconds: number }) => {
        retries += 1;
        retryDelay = options.delaySeconds;
      },
    };

    const worker = createWorker();
    await worker.queue(
      {
        queue: 'mayisigorta-document-scan',
        messages: [queueMessage],
      } as unknown as MessageBatch<DocumentJobQueueMessage>,
      { DB: db, DOCUMENTS_ENABLED: 'false' } as Env,
    );
    expect(acknowledged).toBe(0);
    expect(retries).toBe(1);
    expect(retryDelay).toBe(30);

    await worker.queue(
      {
        queue: DOCUMENT_SCAN_DEAD_LETTER_QUEUE,
        messages: [queueMessage],
      } as unknown as MessageBatch<DocumentJobQueueMessage>,
      { DB: db, DOCUMENTS_ENABLED: 'false' } as Env,
    );
    expect(acknowledged).toBe(1);
    const event = await db
      .prepare(
        `SELECT queue_name,message_id,reason_code,job_id,document_version_id,input_sha256
         FROM document_queue_dead_letter_events WHERE message_id=?`,
      )
      .bind(queueMessage.id)
      .first();
    expect(event).toEqual({
      queue_name: DOCUMENT_SCAN_DEAD_LETTER_QUEUE,
      message_id: queueMessage.id,
      reason_code: 'INVALID_QUEUE_MESSAGE',
      job_id: null,
      document_version_id: null,
      input_sha256: null,
    });
    expect(JSON.stringify(event)).not.toContain('synthetic payload');
  });

  it('records distinct conflicting deliveries without cross-marking unrelated jobs', async () => {
    if (!db) throw new Error('Local D1 binding was not initialized');
    const database = db;
    await new Promise((resolve) => setTimeout(resolve, 10));
    const testStartedAt = new Date().toISOString();
    const jobs = [
      { id: 'job-conflict-a', version: 'version-conflict-a', sha256: 'c'.repeat(64) },
      { id: 'job-conflict-a2', version: 'version-conflict-a2', sha256: 'f'.repeat(64) },
      { id: 'job-conflict-b', version: 'version-conflict-b', sha256: 'd'.repeat(64) },
    ];
    await database.batch(
      jobs.map(({ id, version, sha256 }) =>
        database
          .prepare(
            `INSERT INTO background_jobs
              (id,job_type,document_version_id,input_sha256,generation,status,available_at,updated_at)
             VALUES(?, 'DOCUMENT_SCAN', ?, ?, 1, 'QUEUED',
               strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
          )
          .bind(id, version, sha256),
      ),
    );
    const makeMessage = (
      id: string,
      jobId: string,
      documentVersionId: string,
      inputSha256: string,
    ) => ({
      id,
      timestamp: new Date(),
      body: { jobId, jobType: 'DOCUMENT_SCAN', generation: 1, documentVersionId, inputSha256 },
      ack: () => undefined,
      retry: () => undefined,
    });
    await createWorker().queue(
      {
        queue: DOCUMENT_SCAN_DEAD_LETTER_QUEUE,
        messages: [
          makeMessage('message-conflict-1', 'job-conflict-a', 'version-conflict-a', 'c'.repeat(64)),
          makeMessage(
            'message-conflict-2',
            'job-conflict-a2',
            'version-conflict-a2',
            'f'.repeat(64),
          ),
          makeMessage('message-conflict-1', 'job-conflict-b', 'version-conflict-b', 'd'.repeat(64)),
          makeMessage('message-conflict-1', 'job-conflict-b', 'version-conflict-b', 'd'.repeat(64)),
          makeMessage('message-conflict-2', 'job-conflict-b', 'version-conflict-b', 'd'.repeat(64)),
          makeMessage('message-conflict-2', 'job-conflict-b', 'version-conflict-b', 'd'.repeat(64)),
        ],
      } as unknown as MessageBatch<DocumentJobQueueMessage>,
      { DB: db, DOCUMENTS_ENABLED: 'false' } as Env,
    );

    const updatedJobs = await db
      .prepare(
        `SELECT id,last_error_code FROM background_jobs
         WHERE id IN ('job-conflict-a','job-conflict-a2','job-conflict-b') ORDER BY id`,
      )
      .all();
    expect(updatedJobs.results).toEqual([
      { id: 'job-conflict-a', last_error_code: 'QUEUE_DELIVERY_EXHAUSTED' },
      { id: 'job-conflict-a2', last_error_code: 'QUEUE_DELIVERY_EXHAUSTED' },
      { id: 'job-conflict-b', last_error_code: null },
    ]);
    const events = await db
      .prepare(
        `SELECT message_id,reason_code,job_id FROM document_queue_dead_letter_events
         WHERE queue_name=? AND received_at>=? ORDER BY message_id`,
      )
      .bind(DOCUMENT_SCAN_DEAD_LETTER_QUEUE, testStartedAt)
      .all();
    expect(events.results).toHaveLength(4);
    expect(events.results).toContainEqual({
      message_id: 'message-conflict-1',
      reason_code: 'QUEUE_DELIVERY_EXHAUSTED',
      job_id: 'job-conflict-a',
    });
    expect(events.results).toContainEqual({
      message_id: 'message-conflict-2',
      reason_code: 'QUEUE_DELIVERY_EXHAUSTED',
      job_id: 'job-conflict-a2',
    });
    const conflictEvents = events.results.filter(
      (event) => event.reason_code === 'INVALID_QUEUE_MESSAGE',
    );
    expect(conflictEvents).toHaveLength(2);
    expect(new Set(conflictEvents.map((event) => event.message_id)).size).toBe(2);
    expect(
      conflictEvents.every(
        (event) =>
          event.job_id === null && /^invalid-[0-9a-f]{64}$/u.test(String(event.message_id)),
      ),
    ).toBe(true);
  });

  it('persists an overflow queue event and deduplicates malformed message IDs', async () => {
    if (!db) throw new Error('Local D1 binding was not initialized');
    let acknowledged = 0;
    const body: DocumentJobQueueMessage = {
      jobId: 'job-overflow',
      jobType: 'DOCUMENT_SCAN',
      generation: 1,
      documentVersionId: 'version-overflow',
      inputSha256: 'b'.repeat(64),
    };
    const repeatedMessages = ['bad\r\nid', 'bad\r\nid'].map((id) => ({
      id,
      timestamp: new Date(),
      body,
      ack: () => {
        acknowledged += 1;
      },
      retry: () => undefined,
    }));

    await createWorker().queue(
      {
        queue: DOCUMENT_SCAN_OVERFLOW_QUEUE,
        messages: repeatedMessages,
      } as unknown as MessageBatch<DocumentJobQueueMessage>,
      { DB: db, DOCUMENTS_ENABLED: 'false' } as Env,
    );

    expect(acknowledged).toBe(2);
    const events = await db
      .prepare(
        `SELECT queue_name,message_id,reason_code,job_id
         FROM document_queue_dead_letter_events
         WHERE queue_name=? AND reason_code='INVALID_QUEUE_MESSAGE'`,
      )
      .bind(DOCUMENT_SCAN_OVERFLOW_QUEUE)
      .all();
    expect(events.results).toHaveLength(1);
    expect(events.results[0]).toMatchObject({
      queue_name: DOCUMENT_SCAN_OVERFLOW_QUEUE,
      reason_code: 'INVALID_QUEUE_MESSAGE',
      job_id: 'job-overflow',
    });
    expect(String(events.results[0]?.message_id)).toMatch(/^invalid-[0-9a-f]{64}$/u);
  });

  it('keeps distinct malformed payloads separate without storing their contents', async () => {
    if (!db) throw new Error('Local D1 binding was not initialized');
    await new Promise((resolve) => setTimeout(resolve, 10));
    const testStartedAt = new Date().toISOString();
    let acknowledged = 0;
    const timestamp = new Date('2026-09-29T12:00:00.000Z');
    const makePoison = (customerName: string) => ({
      id: 'bad\r\nmessage-id',
      timestamp,
      body: { customerName, malformed: true },
      ack: () => {
        acknowledged += 1;
      },
      retry: () => undefined,
    });
    const messages = [
      makePoison('synthetic-A'),
      makePoison('synthetic-B'),
      makePoison('synthetic-A'),
    ];

    await createWorker().queue(
      {
        queue: DOCUMENT_SCAN_OVERFLOW_QUEUE,
        messages,
      } as unknown as MessageBatch<DocumentJobQueueMessage>,
      { DB: db, DOCUMENTS_ENABLED: 'false' } as Env,
    );

    expect(acknowledged).toBe(3);
    const events = await db
      .prepare(
        `SELECT message_id,reason_code,job_id FROM document_queue_dead_letter_events
         WHERE queue_name=? AND reason_code='INVALID_QUEUE_MESSAGE' AND received_at>=?`,
      )
      .bind(DOCUMENT_SCAN_OVERFLOW_QUEUE, testStartedAt)
      .all();
    expect(events.results).toHaveLength(2);
    expect(events.results.every((event) => event.job_id === null)).toBe(true);
    expect(
      events.results.every((event) => /^invalid-[0-9a-f]{64}$/u.test(String(event.message_id))),
    ).toBe(true);
    expect(JSON.stringify(events.results)).not.toContain('synthetic-A');
    expect(JSON.stringify(events.results)).not.toContain('synthetic-B');
  });

  it('retries overflow and terminal deliveries when D1 cannot persist their durable event', async () => {
    const failingDb = {
      prepare: () => ({
        bind: () => ({ run: async () => Promise.reject(new Error('D1 unavailable')) }),
      }),
    } as unknown as D1Database;
    const worker = createWorker();

    for (const queue of [DOCUMENT_SCAN_OVERFLOW_QUEUE, DOCUMENT_SCAN_TERMINAL_QUEUE]) {
      let acknowledged = 0;
      let retryDelay: number | undefined;
      const queueMessage = {
        id: `message-d1-outage-${queue}`,
        timestamp: new Date(),
        body: {
          jobId: `job-d1-outage-${queue}`,
          jobType: 'DOCUMENT_SCAN',
          generation: 1,
          documentVersionId: `version-d1-outage-${queue}`,
          inputSha256: 'a'.repeat(64),
        },
        ack: () => {
          acknowledged += 1;
        },
        retry: (options: { delaySeconds: number }) => {
          retryDelay = options.delaySeconds;
        },
      };

      await worker.queue(
        {
          queue,
          messages: [queueMessage],
        } as unknown as MessageBatch<DocumentJobQueueMessage>,
        { DB: failingDb, DOCUMENTS_ENABLED: 'false' } as Env,
      );

      expect(acknowledged).toBe(0);
      expect(retryDelay).toBe(60);
    }
  });

  it('consumes the terminal Queue and persists its event when D1 is available', async () => {
    if (!db) throw new Error('Local D1 binding was not initialized');
    let acknowledged = 0;
    let retried = 0;
    const queueMessage = {
      id: 'message-terminal-dead-letter',
      timestamp: new Date(),
      body: {
        jobId: 'job-terminal-dead-letter',
        jobType: 'DOCUMENT_SCAN',
        generation: 2,
        documentVersionId: 'version-terminal-dead-letter',
        inputSha256: 'e'.repeat(64),
      },
      ack: () => {
        acknowledged += 1;
      },
      retry: () => {
        retried += 1;
      },
    };

    await createWorker().queue(
      {
        queue: DOCUMENT_SCAN_TERMINAL_QUEUE,
        messages: [queueMessage],
      } as unknown as MessageBatch<DocumentJobQueueMessage>,
      { DB: db, DOCUMENTS_ENABLED: 'false' } as Env,
    );

    expect(acknowledged).toBe(1);
    expect(retried).toBe(0);
    const event = await db
      .prepare(
        `SELECT queue_name,message_id,reason_code,job_id,job_generation
         FROM document_queue_dead_letter_events WHERE message_id=?`,
      )
      .bind(queueMessage.id)
      .first();
    expect(event).toEqual({
      queue_name: DOCUMENT_SCAN_TERMINAL_QUEUE,
      message_id: queueMessage.id,
      reason_code: 'QUEUE_DELIVERY_EXHAUSTED',
      job_id: 'job-terminal-dead-letter',
      job_generation: 2,
    });
  });

  it('deduplicates a replayed hold message by its original stable delivery ID', async () => {
    if (!db) throw new Error('Local D1 binding was not initialized');
    await db
      .prepare(
        `INSERT INTO background_jobs
          (id,job_type,document_version_id,input_sha256,generation,status,available_at,updated_at)
         VALUES('job-hold-replay','DOCUMENT_SCAN','version-hold-replay','${'9'.repeat(64)}',1,'QUEUED',
           strftime('%Y-%m-%dT%H:%M:%fZ','now'),strftime('%Y-%m-%dT%H:%M:%fZ','now'))`,
      )
      .run();
    const replayedMessages = ['platform-retry-1', 'platform-retry-2'].map((id) => ({
      id,
      timestamp: new Date(),
      body: {
        jobId: 'job-hold-replay',
        jobType: 'DOCUMENT_SCAN',
        generation: 1,
        documentVersionId: 'version-hold-replay',
        inputSha256: '9'.repeat(64),
        deadLetterReplayId: 'held-delivery-original-id',
      },
      ack: () => undefined,
      retry: () => undefined,
    }));

    await createWorker().queue(
      {
        queue: DOCUMENT_SCAN_TERMINAL_QUEUE,
        messages: replayedMessages,
      } as unknown as MessageBatch<DocumentJobQueueMessage>,
      { DB: db, DOCUMENTS_ENABLED: 'false' } as Env,
    );

    const events = await db
      .prepare(
        `SELECT queue_name,message_id,reason_code,job_id FROM document_queue_dead_letter_events
         WHERE queue_name=? AND message_id='held-delivery-original-id'`,
      )
      .bind(DOCUMENT_SCAN_TERMINAL_QUEUE)
      .all();
    expect(events.results).toEqual([
      {
        queue_name: DOCUMENT_SCAN_TERMINAL_QUEUE,
        message_id: 'held-delivery-original-id',
        reason_code: 'QUEUE_DELIVERY_EXHAUSTED',
        job_id: 'job-hold-replay',
      },
    ]);
    const job = await db
      .prepare("SELECT last_error_code FROM background_jobs WHERE id='job-hold-replay'")
      .first();
    expect(job).toEqual({ last_error_code: 'QUEUE_DELIVERY_EXHAUSTED' });
  });
});
