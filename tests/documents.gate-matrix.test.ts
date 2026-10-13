// @vitest-environment node
import { it, expect, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import worker from '../src/server/worker';
import type { DocumentJobQueueMessage } from '../src/server/documents/queue';
function fakeDb() {
  let reads = 0;
  const db = {
    prepare(sql: string) {
      return {
        bind() {
          return this;
        },
        async first() {
          reads++;
          return sql.includes('AS dead')
            ? {
                dead: 0,
                due: 0,
                stalledDue: 0,
                expiredLeases: 0,
                completedInvestigations: 0,
                overdueBackups: 0,
                overdueUploads: 0,
              }
            : null;
        },
        async all() {
          reads++;
          return { success: true, results: [] };
        },
        async run() {
          throw new Error('UNEXPECTED_GATE_WRITE');
        },
      };
    },
    async batch() {
      throw new Error('UNEXPECTED_GATE_WRITE');
    },
  } as unknown as D1Database;
  return { db, count: () => reads };
}
it.each([
  [false, false, false],
  [true, false, false],
  [false, true, false],
  [false, false, true],
  [false, true, true],
  [true, false, true],
  [true, true, false],
  [true, true, true],
])(
  'public%s/jobs%s/cron%s are independent on actual exported handlers',
  async (pub, jobs, cron) => {
    const state = fakeDb(),
      env = {
        DB: state.db,
        APP_ENV: 'test',
        PANEL_ORIGIN: 'https://panel.mayisigorta.com',
        DOCUMENTS_ENABLED: String(pub),
        DOCUMENT_JOBS_ENABLED: String(jobs),
        DOCUMENT_CRON_ENABLED: String(cron),
        DOCS_QUARANTINE: { get: async () => null } as unknown as R2Bucket,
        DOCUMENT_BACKUP_CAPABILITY: {
          createAndVerify: async () => ({ ok: false, kind: 'IO' }),
          observeBackup: async () => ({ ok: true, value: null }),
        },
        DOCUMENT_JOB_QUEUE: {
          send: async () => {
            throw new Error('UNEXPECTED_PUBLICATION');
          },
        } as unknown as Queue,
      };
    const ctx = { waitUntil() {} } as unknown as ExecutionContext;
    for (const path of [
      '/api/documents',
      '/api/documents/synthetic-missing/download',
      '/secure/api/documents/synthetic-missing/download',
      '/secure/api/documents/synthetic-missing/download-grants',
      '/secure/api/documents/synthetic-missing/download-confirmation',
    ]) {
      const r = await worker.fetch(
        new Request('https://panel.mayisigorta.com' + path, {
          method: 'POST',
          headers: {
            Origin: 'https://panel.mayisigorta.com',
            Host: 'panel.mayisigorta.com',
            'content-type': 'application/json',
          },
          body: '{}',
        }),
        env as never,
        ctx,
      );
      expect(r.status).toBe(pub ? 401 : 404);
    }
    let ack = 0;
    await worker.queue(
      {
        messages: [
          {
            body: {
              jobId: 'synthetic-missing',
              jobType: 'DOCUMENT_BACKUP',
              generation: 1,
              documentVersionId: 'synthetic-missing',
              inputSha256: 'a'.repeat(64),
            },
            ack() {
              ack++;
            },
            retry() {
              throw Error('UNEXPECTED_RETRY');
            },
          },
        ],
      } as unknown as MessageBatch<DocumentJobQueueMessage>,
      env as never,
    );
    expect(ack).toBe(1);
    expect(state.count() > 0).toBe(jobs);
    const prior = state.count(),
      work: Promise<unknown>[] = [];
    worker.scheduled(
      { cron: '*/5 * * * *' } as ScheduledController,
      env as never,
      { waitUntil: (p: Promise<unknown>) => work.push(p) } as unknown as ExecutionContext,
    );
    await Promise.all(work);
    expect(state.count() > prior).toBe(cron);
  },
);
it('missing new gates remain false even when public docs true', async () => {
  const s = fakeDb(),
    env = { DB: s.db, DOCUMENTS_ENABLED: 'true' };
  let ack = 0;
  await worker.queue(
    {
      messages: [
        {
          body: {
            jobId: 'synthetic-missing',
            jobType: 'DOCUMENT_BACKUP',
            generation: 1,
            documentVersionId: 'synthetic-missing',
            inputSha256: 'a'.repeat(64),
          },
          ack() {
            ack++;
          },
        },
      ],
    } as unknown as MessageBatch<DocumentJobQueueMessage>,
    env,
  );
  const work: Promise<unknown>[] = [];
  worker.scheduled({ cron: '*/5 * * * *' } as ScheduledController, env, {
    waitUntil: (p: Promise<unknown>) => work.push(p),
  } as unknown as ExecutionContext);
  await Promise.all(work);
  expect(s.count()).toBe(0);
  expect(ack).toBe(1);
});
it.each(['TRUE', '1', ' true', 'true ', true, ''])(
  'non-exact job/cron value %s stays closed',
  async (value) => {
    const s = fakeDb(),
      env = {
        DB: s.db,
        DOCUMENTS_ENABLED: 'true',
        DOCUMENT_JOBS_ENABLED: value,
        DOCUMENT_CRON_ENABLED: value,
      };
    let ack = 0;
    await worker.queue(
      {
        messages: [
          {
            body: {
              jobId: 'synthetic-missing',
              jobType: 'DOCUMENT_BACKUP',
              generation: 1,
              documentVersionId: 'synthetic-missing',
              inputSha256: 'a'.repeat(64),
            },
            ack() {
              ack++;
            },
            retry() {
              throw Error('UNEXPECTED_RETRY');
            },
          },
        ],
      } as unknown as MessageBatch<DocumentJobQueueMessage>,
      env as never,
    );
    const work: Promise<unknown>[] = [];
    worker.scheduled(
      { cron: '*/5 * * * *' } as ScheduledController,
      env as never,
      { waitUntil: (p: Promise<unknown>) => work.push(p) } as unknown as ExecutionContext,
    );
    await Promise.all(work);
    expect(ack).toBe(1);
    expect(work.length).toBe(0);
    expect(s.count()).toBe(0);
  },
);
