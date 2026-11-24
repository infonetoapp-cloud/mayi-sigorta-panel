// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { readCapacity } from '../src/server/d1-backup/capacity';
import { generationPrefix } from '../src/server/d1-backup/core';
import { BACKUP_CRONS, scheduledBackup } from '../src/server/d1-backup/scheduler';

const midnight = Date.parse('2026-11-24T21:00:00Z');
const id = 'd1-backup-daily-2026-11-25';

function night(status: string) {
  const completed = new Set<string>();
  const started = new Set<string>();
  const get = async (id: string) => ({
    id,
    status: async () => ({ status: started.has(id) ? status : 'unknown' }),
  });
  const create = vi.fn(async ({ id }: { id: string }) => {
    if (started.has(id)) throw Error('duplicate');
    started.add(id);
    return get(id);
  });
  const recovery = {
    head: vi.fn(async (key: string) => (completed.has(key) ? ({} as R2Object) : null)),
  };
  return {
    create,
    started,
    completed,
    recovery,
    tick: (stage: 0 | 1 | 2, delayMs = 0) =>
      scheduledBackup(
        midnight + stage * 3600000 + delayMs,
        BACKUP_CRONS[stage],
        { get, create },
        recovery,
      ),
  };
}

it('uses the canonical slot when Cloudflare supplies a timestamp seconds after the hour', async () => {
  const f = night('errored');
  const scheduledAt = new Date(midnight).toISOString();
  await expect(f.tick(0, 27_066)).resolves.toMatchObject({ id, outcome: 'PRIMARY' });
  await expect(f.tick(0, 42_000)).resolves.toMatchObject({ id, outcome: 'PRIMARY' });
  expect(f.create).toHaveBeenNthCalledWith(1, { id, params: { scheduledAt } });
  expect(f.create).toHaveBeenNthCalledWith(2, { id, params: { scheduledAt } });
  const prefix = generationPrefix(scheduledAt, id);
  f.completed.add(prefix + 'COMPLETE.json');
  await expect(f.tick(1, 17_971)).resolves.toEqual({ id, outcome: 'COMPLETE', sqlPrefix: prefix });
  await expect(f.tick(2, 48_912)).resolves.toEqual({ id, outcome: 'COMPLETE', sqlPrefix: prefix });
  expect([...f.started]).toEqual([id]);
  await expect(f.tick(0, 3_600_000)).rejects.toThrow('cron-create');
});

it('uses the Istanbul date and preserves one successful daily backup even if the workflow errored after publication', async () => {
  const f = night('errored');
  await expect(f.tick(0)).resolves.toMatchObject({ id, outcome: 'PRIMARY' });
  f.completed.add(generationPrefix(new Date(midnight).toISOString(), id) + 'COMPLETE.json');
  await expect(f.tick(1)).resolves.toMatchObject({ outcome: 'COMPLETE' });
  await expect(f.tick(2)).resolves.toMatchObject({ outcome: 'COMPLETE' });
  expect([...f.started]).toEqual([id]);
});

it('retries one failed workflow and signals a missing marker at 02:00 until a retry completes', async () => {
  const f = night('errored');
  await f.tick(0);
  await Promise.all([f.tick(1), f.tick(1)]);
  expect([...f.started]).toEqual([id, id + '-retry']);
  await expect(f.tick(2)).resolves.toMatchObject({ outcome: 'MISSING' });
  f.completed.add(
    generationPrefix(new Date(midnight + 3600000).toISOString(), id + '-retry') + 'COMPLETE.json',
  );
  await expect(f.tick(2)).resolves.toMatchObject({ outcome: 'COMPLETE' });
});

it('does not duplicate a running workflow and recovers a missing midnight invocation', async () => {
  const running = night('running');
  await running.tick(0);
  await expect(running.tick(1)).resolves.toMatchObject({ outcome: 'SKIPPED' });
  expect([...running.started]).toEqual([id]);
  const missing = night('running');
  await missing.tick(1);
  expect([...missing.started]).toEqual([id]);
});

const credentials = { CLOUDFLARE_EMAIL: 'synthetic', CLOUDFLARE_API_KEY: 'synthetic' };
const metrics = (payloadSize: number) => ({
  success: true,
  result: {
    standard: {
      published: { payloadSize, metadataSize: 10 },
      uploaded: { payloadSize: 20, metadataSize: 30 },
    },
  },
});
const reply =
  (data: unknown): typeof fetch =>
  async () =>
    Response.json(data);

it('warns at projected or current 7 GB, using the account-wide bytes and bytes in progress', async () => {
  const below = reply(metrics(6_950_000_000));
  await expect(readCapacity(credentials, 1_200_000, below)).resolves.toMatchObject({
    warning: false,
  });
  await expect(readCapacity(credentials, 1_250_000, below)).resolves.toEqual({
    storedBytes: 6_950_000_060,
    projectedBytes: 7_000_000_060,
    warning: true,
  });
  await expect(
    readCapacity(credentials, null, reply(metrics(6_999_999_940))),
  ).resolves.toMatchObject({ warning: true, projectedBytes: null });
});

it('rejects unknown capacity rather than reporting an empty bucket', async () => {
  await expect(
    readCapacity(credentials, null, reply({ success: true, result: {} })),
  ).rejects.toThrow('R2_CAPACITY_UNAVAILABLE');
});
