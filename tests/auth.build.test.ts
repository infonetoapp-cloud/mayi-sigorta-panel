// @vitest-environment node
import { it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { createWorker, type Env } from '../src/server/index';
it('actual built login assets load under the real Worker CSP/HTML header contract', async () => {
  const html = readFileSync('dist/client/index.html', 'utf8');
  const scripts = [...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]!);
  const styles = [...html.matchAll(/<link[^>]+href="([^"]+\.css)"/g)].map((m) => m[1]!);
  expect(scripts.length).toBeGreaterThan(0);
  expect(styles.length).toBeGreaterThan(0);
  for (const asset of [...scripts, ...styles]) {
    expect(asset.startsWith('/assets/')).toBe(true);
    expect(existsSync(resolve('dist/client', asset.slice(1)))).toBe(true);
  }
  expect(html).not.toMatch(/<script[^>]*>\s*[^<\s]/);
  const env = {
    DB: {} as D1Database,
    APP_ENV: 'production',
    PANEL_ORIGIN: 'https://panel.mayisigorta.com',
    ASSETS: { fetch: async () => new Response(html, { headers: { 'Content-Type': 'text/html' } }) },
  } as unknown as Env;
  const response = await createWorker().fetch(new Request('https://panel.mayisigorta.com/'), env, {
    waitUntil() {},
  } as unknown as ExecutionContext);
  expect(response.headers.get('content-security-policy')).toContain("script-src 'self'");
  expect(response.headers.get('content-security-policy')).toContain("connect-src 'self'");
  expect(response.headers.get('content-security-policy')).toContain("font-src 'self'");
  expect(response.headers.get('content-security-policy')).toContain("object-src 'none'");
  expect(response.headers.get('content-security-policy')).not.toContain('unsafe-eval');
  expect(response.headers.get('content-security-policy')).toContain("style-src 'self'");
  expect(response.headers.get('cache-control')).toContain('no-store');
  expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow, noarchive');
  expect(response.headers.get('x-frame-options')).toBe('DENY');
  expect(response.headers.get('x-content-type-options')).toBe('nosniff');
  expect(response.headers.get('referrer-policy')).toBe('no-referrer');
  expect(response.headers.get('strict-transport-security')).toBe('max-age=86400');
});
