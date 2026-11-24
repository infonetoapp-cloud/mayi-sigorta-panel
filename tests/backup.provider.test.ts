// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { parseExportResponse } from '../src/server/d1-backup/provider';
it.each([
  { errors: [{ code: '1000', message: 'secret' }] },
  { errors: 'secret' },
  { errors: {} },
  { result: { success: 'false', at_bookmark: 'b' } },
  { result: { success: 1, at_bookmark: 'b' } },
])('malformed success/errors rejected %j', (patch) => {
  expect(() =>
    parseExportResponse(
      { success: true, result: { at_bookmark: 'b' }, ...patch },
      200,
      'export-start',
      1,
      0,
    ),
  ).toThrow('BACKUP_FAILED');
});
import { scheduledBackup } from '../src/server/d1-backup/scheduler';
vi.mock('cloudflare:workers', () => ({
  WorkerEntrypoint: class {},
  WorkflowEntrypoint: class {},
}));
import worker from '../src/server/d1-backup/worker';
it('initial already-completed response needs no invented bookmark', () => {
  expect(
    parseExportResponse(
      {
        success: true,
        result: {
          status: 'complete',
          result: { signed_url: 'https://example.r2.cloudflarestorage.com/export' },
        },
      },
      200,
      'export-start',
      1,
      0,
    ),
  ).toMatchObject({ kind: 'complete', bookmark: undefined });
});
it('active from official Wrangler type remains accepted', () => {
  expect(parse({ status: 'active', at_bookmark: 'active' }).kind).toBe('progress');
});
it('successful HTTP explicit API failure classified', () => {
  expect(() =>
    parseExportResponse(
      { success: false, errors: [{ code: 1000, message: 'secret' }] },
      200,
      'export-poll',
      1,
      10,
    ),
  ).toThrow('api-error');
});
it('actual scheduled handler only dispatches deterministic Workflow creation', async () => {
  const create = vi.fn(async ({ id }: { id: string }) => ({ id }));
  const get = vi.fn();
  await worker.scheduled(
    {
      scheduledTime: Date.parse('2026-11-24T21:00:00Z'),
      cron: '0 21 * * *',
    } as ScheduledController,
    { BACKUP_WORKFLOW: { create, get } } as never,
  );
  expect(create).toHaveBeenCalledWith({
    id: 'd1-backup-daily-2026-11-25',
    params: { scheduledAt: '2026-11-24T21:00:00.000Z' },
  });
  expect(get).not.toHaveBeenCalled();
  expect('fetch' in worker).toBe(false);
});
it.each([200, 503] as const)(
  '02:00 check emits a missing-backup signal and a separate capacity signal with metrics HTTP %i',
  async (status) => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const create = vi.fn();
    vi.stubGlobal('fetch', async () =>
      Response.json(
        {
          success: status === 200,
          result: {
            standard: {
              published: { payloadSize: 7_000_000_000, metadataSize: 0 },
              uploaded: { payloadSize: 0, metadataSize: 0 },
            },
          },
        },
        { status },
      ),
    );
    try {
      await worker.scheduled(
        {
          scheduledTime: Date.parse('2026-11-24T23:00:00Z'),
          cron: '0 23 * * *',
        } as ScheduledController,
        { BACKUP_WORKFLOW: { create }, RECOVERY: { head: async () => null } } as never,
      );
      expect(warnings.mock.calls.map(([record]) => record.event)).toEqual([
        'MAYI_D1_DAILY_BACKUP_MISSING',
        status === 200 ? 'MAYI_R2_CAPACITY_WARNING' : 'MAYI_R2_CAPACITY_UNAVAILABLE',
      ]);
      expect(create).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
      warnings.mockRestore();
    }
  },
);
const parse = (result: unknown) =>
  parseExportResponse({ success: true, result }, 200, 'export-poll', 2, 40, 'previous');
it.each([
  { at_bookmark: 'initial' },
  { success: true, at_bookmark: 'progress', messages: ['Uploaded part 1'] },
  { current_bookmark: 'current' },
])('accepts initial/progress without status %j', (r) => {
  expect(parse(r).kind).toBe('progress');
});
it('completion with signed URL and optional bookmark', () => {
  expect(
    parse({
      status: 'complete',
      result: { signed_url: 'https://test.r2.cloudflarestorage.com/sql?secret=signed' },
    }),
  ).toMatchObject({ kind: 'complete', bookmark: 'previous' });
});
it.each([null, [], {}, { status: 'complete' }, { status: 'mystery', at_bookmark: 'x' }])(
  'malformed or insufficient %j fails closed',
  (r) => {
    expect(() => parse(r)).toThrow('BACKUP_FAILED');
  },
);
it('numeric errors/status safe; arbitrary provider message completely omitted', () => {
  const leak =
    'key=synthetic-secret https://example.invalid/sql?secret=signed email@example.invalid';
  try {
    parseExportResponse(
      {
        success: false,
        errors: [{ code: 10000, message: leak }, { code: leak }],
        result: { error: leak },
      },
      403,
      'export-start',
      1,
      12,
    );
  } catch (e) {
    const text = String(e);
    expect(text).toContain('403');
    expect(text).toContain('10000');
    expect(text).toContain('http-error');
    expect(text).not.toContain(leak);
    expect(text).not.toContain('signed');
    return;
  }
  throw new Error('expected failure');
});
it('provider explicit error classified without raw error text', () => {
  expect(() => parse({ status: 'error', error: 'https://signed.invalid/?token=secret' })).toThrow(
    'provider-error',
  );
});
it('scheduled event duplicate uses same deterministic create ID then get; no second create generation', async () => {
  const ids = new Set<string>();
  const create = vi.fn(async ({ id }: { id: string }) => {
    if (ids.has(id)) throw new Error('provider secret duplicate');
    ids.add(id);
    return { id, status: async () => ({ status: 'queued' }) };
  });
  const get = vi.fn(async (id: string) => {
    if (!ids.has(id)) throw new Error('not found');
    return { id, status: async () => ({ status: 'queued' }) };
  });
  const binding = { create, get };
  const time = Date.parse('2026-10-08T21:00:00Z');
  await scheduledBackup(time, '0 21 * * *', binding, { head: async () => null });
  await scheduledBackup(time, '0 21 * * *', binding, { head: async () => null });
  expect(ids.size).toBe(1);
  expect(create.mock.calls[0]![0].id).toBe(create.mock.calls[1]![0].id);
  expect(get).toHaveBeenCalledOnce();
});
it('Cron create error never treated as successful duplicate without get confirmation', async () => {
  await expect(
    scheduledBackup(
      Date.parse('2026-10-08T21:00:00Z'),
      '0 21 * * *',
      {
        create: async () => {
          throw new Error('secret signed URL');
        },
        get: async () => {
          throw new Error('secret');
        },
      },
      { head: async () => null },
    ),
  ).rejects.toThrow('cron-create');
});
