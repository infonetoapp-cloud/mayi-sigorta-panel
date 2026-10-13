// @vitest-environment node
import { expect, it } from 'vitest';
import { hourPrefixes, observeBackup } from '../src/server/backup-monitor/observer';
it('enumerates three rollover-safe UTC hour prefixes when required', () => {
  expect(hourPrefixes(Date.parse('2027-01-01T00:10:00.000Z'))).toEqual([
    'd1/mayisigorta-crm/2026/12/31/22/',
    'd1/mayisigorta-crm/2026/12/31/23/',
    'd1/mayisigorta-crm/2027/01/01/00/',
  ]);
});
it.each(['cursor-cycle', 'outside-key', 'objects-budget', 'missing-markers', 'provider-rejection'])(
  'bounds discovery %s and never makes failure healthy',
  async (kind) => {
    const now = Date.parse('2026-10-13T15:40:00.000Z');
    let lists = 0;
    const r = {
      list: async (prefix: string) => {
        lists++;
        if (kind === 'provider-rejection') throw Error('private error');
        if (kind === 'cursor-cycle') return { keys: [], cursor: 'repeat' };
        if (kind === 'outside-key') return { keys: ['other/COMPLETE.json'] };
        if (kind === 'objects-budget')
          return { keys: Array(501).fill(prefix + 'unused') as string[] };
        return { keys: [prefix + 'partial/database.sql'] };
      },
      head: async () => {
        throw Error('NO_BODY');
      },
      readJSON: async () => {
        throw Error('NO_BODY');
      },
    };
    const value = await observeBackup(r, now);
    expect(value.status).toBe(
      kind === 'missing-markers' ? 'BACKUP_STALE' : 'QUERY_OR_PROVIDER_FAILURE',
    );
    expect(lists).toBeLessThanOrEqual(4);
  },
);
