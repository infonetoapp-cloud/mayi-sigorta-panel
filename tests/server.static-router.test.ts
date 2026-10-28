// @vitest-environment node
import { expect, it } from 'vitest';
import { app, createApp, type Env } from '../src/server/index';

it('compiles the static worker router before its first request', () => {
  expect(app.router.name).not.toBe('SmartRouter');
});

it('keeps factory-created applications open for trusted route composition', async () => {
  const composed = createApp();
  let calls = 0;
  composed.get('/static-router-fixture', (c) => {
    calls++;
    return c.json({ fixture: true });
  });
  composed.router.match('GET', '/static-router-fixture');
  expect(calls).toBe(0);
  const response = await composed.request('https://panel.mayisigorta.com/static-router-fixture');
  expect(response.status).toBe(200);
  expect(calls).toBe(1);
});

it('preserves origin and missing-session guards in the compiled static router', async () => {
  const env = {
    APP_ENV: 'test',
    PANEL_ORIGIN: 'https://panel.mayisigorta.com',
    DB: {
      prepare() {
        throw new Error('UNEXPECTED_DATABASE_ACCESS');
      },
    } as unknown as D1Database,
  } satisfies Env;
  for (const [headers, status] of [
    [{ Origin: 'https://foreign.invalid' }, 403],
    [{}, 401],
  ] as const) {
    const response = await app.fetch(
      new Request(env.PANEL_ORIGIN + '/api/auth/csrf-token', { headers }),
      env,
    );
    expect(response.status).toBe(status);
    expect(response.headers.get('cache-control')).toContain('no-store');
    expect(response.headers.has('set-cookie')).toBe(false);
  }
});
