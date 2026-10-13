// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { documentRateDecision } from '../src/server/documents/admission';
it('fails closed on missing or failing production admission and applies per-agency/user keys', async () => {
  const actor = { userId: 'synthetic', memberships: [{ agencyId: 'tenant-a' }] };
  expect(await documentRateDecision({ APP_ENV: 'production' }, actor, 'UPLOAD')).toBe(
    'UNAVAILABLE',
  );
  const limit = vi.fn(async (_input: { key: string }) => ({ success: false }));
  expect(
    await documentRateDecision(
      { APP_ENV: 'production', DOCUMENT_UPLOAD_RATE_LIMITER: { limit } },
      actor,
      'UPLOAD',
    ),
  ).toBe('LIMITED');
  expect(limit.mock.calls[0]?.[0]).toEqual({ key: 'document:UPLOAD:tenant-a:synthetic' });
  expect(
    await documentRateDecision(
      {
        APP_ENV: 'production',
        DOCUMENT_DOWNLOAD_RATE_LIMITER: {
          limit: async () => {
            throw Error('privateprovider');
          },
        },
      },
      actor,
      'DOWNLOAD',
    ),
  ).toBe('UNAVAILABLE');
});
