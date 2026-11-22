// @vitest-environment node
import { expect, it, vi } from 'vitest';
import {
  executeBackupObservation,
  healthchecksChannels,
} from '../src/server/backup-monitor/notification';
const now = Date.parse('2026-11-21T09:00:00.000Z');
const emptyReader = {
  list: async () => ({ keys: [] }),
  head: async () => null,
  readJSON: async () => null,
};
it('signals a failed freshness check after recording a verified empty window, and still signals an active observer', async () => {
  const record = vi.fn(async () => {}),
    alive = vi.fn(async () => {}),
    freshness = vi.fn(async () => {});
  const result = await executeBackupObservation(
    emptyReader,
    { record, alive, freshness },
    () => now,
  );
  expect(result).toMatchObject({
    status: 'BACKUP_STALE',
    aliveDelivered: true,
    freshnessDelivered: true,
  });
  expect(record.mock.invocationCallOrder[0]).toBeLessThan(alive.mock.invocationCallOrder[0]!);
  expect(freshness).toHaveBeenCalledWith('FAIL');
});
it('uses the failure channel for provider errors and preserves a separate delivery failure', async () => {
  const alive = vi.fn(async () => {});
  const freshness = vi.fn(async () => {
    throw new Error('synthetic transport failure');
  });
  const reader = {
    ...emptyReader,
    list: async () => {
      throw new Error('synthetic provider failure');
    },
  };
  const result = await executeBackupObservation(
    reader,
    { record: async () => {}, alive, freshness },
    () => now,
  );
  expect(result).toMatchObject({
    status: 'QUERY_OR_PROVIDER_FAILURE',
    aliveDelivered: true,
    freshnessDelivered: false,
  });
  expect(freshness).toHaveBeenCalledWith('FAIL');
});
it('does not claim liveness or fresh backups when state cannot be recorded', async () => {
  const alive = vi.fn(async () => {}),
    freshness = vi.fn(async () => {});
  await expect(
    executeBackupObservation(
      emptyReader,
      {
        record: async () => {
          throw new Error('state unavailable');
        },
        alive,
        freshness,
      },
      () => now,
    ),
  ).rejects.toThrow('state unavailable');
  expect(alive).not.toHaveBeenCalled();
  expect(freshness).not.toHaveBeenCalled();
});

it('uses independent Healthchecks signals and rejects an HTTP 200 for an unknown check', async () => {
  const config = {
    aliveUrl: 'https://hc-ping.com/00000000-0000-4000-8000-000000000000',
    freshnessUrl: 'https://hc-ping.com/00000000-0000-4000-8000-000000000001',
  };
  const send = vi.fn<typeof fetch>(
    async (url) => new Response(url === config.aliveUrl ? 'OK' : 'not found'),
  );
  const result = await executeBackupObservation(
    emptyReader,
    healthchecksChannels(config, async () => {}, send),
    () => now,
  );
  expect(result).toMatchObject({ aliveDelivered: true, freshnessDelivered: false });
  expect(send.mock.calls.map(([url]) => url)).toEqual([
    config.aliveUrl,
    config.freshnessUrl + '/fail',
  ]);
  expect(send.mock.calls[0]?.[1]).toMatchObject({ method: 'GET', redirect: 'error' });
  expect(() =>
    healthchecksChannels({ ...config, freshnessUrl: config.aliveUrl }, async () => {}, send),
  ).toThrow('HEALTHCHECKS_CONFIGURATION_INVALID');
});
