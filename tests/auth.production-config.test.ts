// @vitest-environment node
import { expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
function configuration(text: string) {
  return JSON.parse(text.replace(/^\s*\/\/.*$/gm, '').replace(/,\s*([}\]])/g, '$1'));
}
it('preserves only the accepted panel custom domain without enabling alternate exposure or jobs', () => {
  const current = configuration(readFileSync('wrangler.jsonc', 'utf8'));
  const p = current.env.production;
  expect(Boolean(p)).toBe(true);
  if (!p) return;
  expect(p.name).toBe('mayisigorta-crm');
  expect(p.vars).toEqual({
    APP_ENV: 'production',
    PANEL_ORIGIN: 'https://panel.mayisigorta.com',
    DOCUMENTS_ENABLED: 'false',
    DOCUMENT_JOBS_ENABLED: 'false',
    DOCUMENT_CRON_ENABLED: 'false',
  });
  expect(p.secrets.required).toEqual(['CSRF_SECRET']);
  expect(p.observability.logs.invocation_logs).toBe(true);
  expect(p.observability.traces.enabled).toBe(false);
  expect(Object.hasOwn(p.vars, 'CSRF_SECRET')).toBe(false);
  expect(p.workers_dev).toBe(false);
  expect(p.preview_urls).toBe(false);
  expect(p.routes).toEqual([{ pattern: 'panel.mayisigorta.com', custom_domain: true }]);
  expect(p.triggers.crons).toEqual([]);
  expect(p.queues.consumers).toEqual([]);
  expect(p.ratelimits).toEqual(current.ratelimits);
  expect(p.durable_objects).toEqual(current.durable_objects);
  expect(p.migrations).toEqual(current.migrations);
  expect(p.assets).toEqual(current.assets);
  expect(p.d1_databases).toEqual(current.env.foundation.d1_databases);
  expect(p.r2_buckets).toEqual(current.env.foundation.r2_buckets);
  expect(p.queues.producers).toEqual(current.env.foundation.queues.producers);
  const base = configuration(
    execFileSync('git', ['show', 'fdf367393a90810d8c8aaa1ed45aaa3ed37d5e00:wrangler.jsonc'], {
      encoding: 'utf8',
    }),
  );
  const without = { ...current, env: { foundation: current.env.foundation } };
  expect(without).toEqual(base);
});
