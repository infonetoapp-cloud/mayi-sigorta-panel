// @vitest-environment node
import { expect, it } from 'vitest';
import { createApp } from '../src/server/index';
import { localAuthFixture } from './support/local-auth-fixture';
import { PASSWORD_KDF_INSTANCE } from '../src/server/auth/password-do-adapter';
async function scenario(activation: boolean) {
  const f = await localAuthFixture();
  const subject = await f.seed(crypto.randomUUID(), 'OWNER', activation);
  const order: string[] = [];
  f.env.PASSWORD_KDF = {
    getByName(name: string) {
      expect(name).toBe(PASSWORD_KDF_INSTANCE);
      return {
        async hash(password: string) {
          order.push('hash');
          return f.hasher.hash(password);
        },
        async verify(password: string, verifier: string) {
          order.push('verify');
          return f.hasher.verify(password, verifier);
        },
      };
    },
  } as never;
  const app = createApp();
  const request = (path: string, body?: unknown, cookie?: string, csrf?: string) =>
    app.fetch(
      new Request('https://panel.mayisigorta.com' + path, {
        method: body ? 'POST' : 'GET',
        headers: {
          origin: 'https://panel.mayisigorta.com',
          ...(body ? { 'content-type': 'application/json' } : {}),
          ...(cookie ? { cookie } : {}),
          ...(csrf ? { 'x-csrf-token': csrf } : {}),
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
      }),
      f.env,
    );
  const response = await request('/api/auth/login', {
    email: subject.email,
    password: subject.password,
  });
  expect(response.status).toBe(200);
  expect(order).toEqual(['verify']);
  const cookie = response.headers.get('set-cookie')!.split(';')[0]!;
  const csrfResponse = await request('/api/auth/csrf-token', undefined, cookie);
  const csrf = ((await csrfResponse.json()) as { data: { token: string } }).data.token;
  return { f, order, request, cookie, csrf, subject };
}
it('default DO composition preserves activation two-step sequential change', async () => {
  const s = await scenario(true);
  try {
    s.order.length = 0;
    const next = crypto.randomUUID();
    const r = await s.request(
      '/api/auth/password',
      { newPassword: next, confirmation: next },
      s.cookie,
      s.csrf,
    );
    expect(r.status).toBe(200);
    expect(s.order).toEqual(['verify', 'hash']);
  } finally {
    await s.f.mf.dispose();
  }
});
it('default DO composition preserves normal three-step change and one-step reauth', async () => {
  const s = await scenario(false);
  try {
    s.order.length = 0;
    const reauth = await s.request(
      '/api/auth/reauth',
      { password: s.subject.password },
      s.cookie,
      s.csrf,
    );
    expect(reauth.status).toBe(200);
    expect(s.order).toEqual(['verify']);
    const cookie = reauth.headers.get('set-cookie')!.split(';')[0]!;
    const response = await s.request('/api/auth/csrf-token', undefined, cookie);
    const csrf = ((await response.json()) as { data: { token: string } }).data.token;
    s.order.length = 0;
    const next = crypto.randomUUID();
    const r = await s.request(
      '/api/auth/password',
      { currentPassword: s.subject.password, newPassword: next, confirmation: next },
      cookie,
      csrf,
    );
    expect(r.status).toBe(200);
    expect(s.order).toEqual(['verify', 'verify', 'hash']);
  } finally {
    await s.f.mf.dispose();
  }
});
