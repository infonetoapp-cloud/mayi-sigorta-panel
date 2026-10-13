// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { observeBackup } from '../src/server/backup-monitor/observer';
it('times out a stuck provider read as diagnostic failure, never healthy', async () => {
  vi.useFakeTimers();
  try {
    const p = observeBackup(
      { list: () => new Promise(() => {}), head: async () => null, readJSON: async () => null },
      Date.parse('2026-10-13T15:40:00.000Z'),
    );
    await vi.advanceTimersByTimeAsync(20000);
    expect((await p).status).toBe('QUERY_OR_PROVIDER_FAILURE');
  } finally {
    vi.useRealTimers();
  }
});
