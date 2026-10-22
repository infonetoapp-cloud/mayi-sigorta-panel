// @vitest-environment node
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';

it('keeps the disposable Edge preparation offline, unrouted and detached from existing resources', () => {
  const config = JSON.parse(
    readFileSync('scripts/recovery/edge-authorization/wrangler.json', 'utf8'),
  );
  expect(config.name).toBe('mayisigorta-ops001-auth-edge-01');
  expect(config.main).toBe('../../../src/server/worker.ts');
  expect(config.workers_dev).toBe(false);
  expect(config.preview_urls).toBe(false);
  expect(config.routes).toEqual([]);
  expect(config.triggers.crons).toEqual([]);
  for (const field of ['account_id', 'env', 'services', 'r2_buckets', 'queues', 'assets'])
    expect(config[field]).toBeUndefined();
  expect(config.vars).toEqual({
    APP_ENV: 'production',
    PANEL_ORIGIN: 'https://owner-approval-required.invalid',
    DOCUMENTS_ENABLED: 'false',
    DOCUMENT_JOBS_ENABLED: 'false',
    DOCUMENT_CRON_ENABLED: 'false',
    RENEWAL_CONTINUATION_ENABLED: 'false',
  });
  expect(config.d1_databases).toEqual([
    {
      binding: 'DB',
      database_name: 'mayisigorta-ops001-auth-edge-db-01',
      database_id: '00000000-0000-4000-8000-000000000906',
      migrations_dir: '../../../db/migrations',
    },
  ]);
  expect(config.durable_objects.bindings).toEqual([
    { name: 'PASSWORD_KDF', class_name: 'PasswordKdfDurableObject' },
  ]);
  expect(config.migrations).toEqual([
    { tag: 'ops001-auth-edge-kdf-v1', new_sqlite_classes: ['PasswordKdfDurableObject'] },
  ]);
  expect(config.ratelimits.map((r: { name: string }) => r.name)).toEqual([
    'AUTH_ACCOUNT_RATE_LIMITER',
    'AUTH_SOURCE_RATE_LIMITER',
  ]);
  expect(config.ratelimits.map((r: { namespace_id: string }) => r.namespace_id)).toEqual([
    '48001',
    '48002',
  ]);
  expect(
    config.ratelimits.map((r: { simple: { limit: number; period: number } }) => r.simple),
  ).toEqual([
    { limit: 10, period: 60 },
    { limit: 1000, period: 60 },
  ]);
  expect(config.secrets).toEqual({ required: ['CSRF_SECRET'] });
});
