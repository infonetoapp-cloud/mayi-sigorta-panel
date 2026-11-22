// @vitest-environment node
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
function configuration(text: string) {
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1'));
}
it('preserves public closure while constraining the internal custody-backed Queue and document Cron', () => {
  const current = configuration(readFileSync('wrangler.jsonc', 'utf8'));
  const p = current.env.production;
  expect(Boolean(p)).toBe(true);
  if (!p) return;
  expect(p.name).toBe('mayisigorta-crm');
  expect(p.vars).toEqual({
    APP_ENV: 'production',
    PANEL_ORIGIN: 'https://panel.mayisigorta.com',
    DOCUMENTS_ENABLED: 'false',
    DOCUMENT_JOBS_ENABLED: 'true',
    DOCUMENT_CRON_ENABLED: 'true',
  });
  expect(p.secrets.required).toEqual(['CSRF_SECRET', 'TURNSTILE_SITE_KEY', 'TURNSTILE_SECRET']);
  expect(p.observability.logs.invocation_logs).toBe(true);
  expect(p.observability.traces.enabled).toBe(false);
  for (const name of p.secrets.required) expect(Object.hasOwn(p.vars, name)).toBe(false);
  expect(p.workers_dev).toBe(false);
  expect(p.preview_urls).toBe(false);
  expect(p.routes).toEqual([{ pattern: 'panel.mayisigorta.com', custom_domain: true }]);
  expect(p.triggers.crons).toEqual(['0 0 * * *', '*/5 * * * *']);
  expect(p.queues.consumers).toEqual([
    {
      queue: 'mayisigorta-document-jobs-v2',
      max_batch_size: 1,
      max_batch_timeout: 1,
      max_concurrency: 1,
      max_retries: 5,
      dead_letter_queue: 'mayisigorta-document-jobs-v2-dlq',
    },
  ]);
  expect(p.ratelimits).toEqual([
    ...current.ratelimits,
    {
      name: 'DOCUMENT_UPLOAD_RATE_LIMITER',
      namespace_id: '2703',
      simple: { limit: 10, period: 60 },
    },
    {
      name: 'DOCUMENT_DOWNLOAD_RATE_LIMITER',
      namespace_id: '2704',
      simple: { limit: 30, period: 60 },
    },
  ]);
  expect(p.durable_objects.bindings).toEqual([
    ...current.durable_objects.bindings,
    { name: 'DOCUMENT_UPLOAD_RUNTIME', class_name: 'DocumentUploadDurableObject' },
  ]);
  expect(p.migrations).toEqual([
    ...current.migrations,
    { tag: 'document-upload-v1', new_sqlite_classes: ['DocumentUploadDurableObject'] },
  ]);
  expect(p.assets).toEqual(current.assets);
  expect(p.d1_databases).toEqual(current.env.foundation.d1_databases);
  expect(p.r2_buckets).toEqual([
    ...current.env.foundation.r2_buckets,
    {
      binding: 'DOCUMENT_QUEUE_CUSTODY',
      bucket_name: 'mayisigorta-document-queue-custody',
      jurisdiction: 'eu',
    },
  ]);
  expect(p.queues.producers).toEqual([
    { binding: 'DOCUMENT_JOB_QUEUE', queue: 'mayisigorta-document-jobs-v2' },
  ]);
  const base = configuration(
    execFileSync('git', ['show', 'fdf367393a90810d8c8aaa1ed45aaa3ed37d5e00:wrangler.jsonc'], {
      encoding: 'utf8',
    }),
  );
  const without = { ...current, env: { foundation: current.env.foundation } };
  expect(without).toEqual(base);
});

it('adds only the production daily renewal Cron and required Turnstile bindings to the accepted release configuration', () => {
  const current = configuration(readFileSync('wrangler.jsonc', 'utf8'));
  const previous = configuration(
    execFileSync('git', ['show', '37a42375ea161d3d1f00a3eced9da6ac2a25931b:wrangler.jsonc'], {
      encoding: 'utf8',
    }),
  );
  expect(current.env.production.triggers.crons).toEqual(current.triggers.crons);
  expect(current.env.production.secrets.required).toEqual([
    ...previous.env.production.secrets.required,
    'TURNSTILE_SITE_KEY',
    'TURNSTILE_SECRET',
  ]);
  current.env.production.secrets.required = previous.env.production.secrets.required;
  current.env.production.triggers.crons = ['*/5 * * * *'];
  expect(current).toEqual(previous);
});
