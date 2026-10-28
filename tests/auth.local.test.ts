// @vitest-environment node
import { beforeAll, afterAll, describe, it, expect } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import { testRateLimit } from './support/local-auth-fixture';
import { hashSessionToken } from '../src/server/auth/session';
let f: Awaited<ReturnType<typeof localAuthFixture>>;
let owner: Awaited<ReturnType<typeof f.seed>>;
beforeAll(async () => {
  f = await localAuthFixture();
  owner = await f.seed('owner', 'OWNER');
});
afterAll(async () => {
  await f?.mf.dispose();
});
function cookieOf(res: Response) {
  return res.headers.get('set-cookie')!.split(';')[0]!;
}
async function json(res: Response) {
  return res.json() as Promise<{
    success: boolean;
    error?: { code: string; message: string };
    data: Record<string, unknown>;
  }>;
}
describe('F-27 real local middleware/storage', () => {
  it('unknown random session never creates a row and login never adopts a supplied cookie', async () => {
    const cookie = '__Host-mayi-session=' + 'f'.repeat(64);
    const before = (await f.db.prepare('SELECT token_hash FROM local_sessions').all()).results
      .length;
    expect((await f.request('/api/auth/session', 'GET', cookie)).status).toBe(401);
    expect((await f.db.prepare('SELECT token_hash FROM local_sessions').all()).results.length).toBe(
      before,
    );
    const login = await f.request('/api/auth/login', 'POST', cookie, {
      email: owner.email,
      password: owner.password,
    });
    expect(login.status).toBe(200);
    expect(cookieOf(login) === cookie).toBe(false);
  });
  it('repeated account attempts throttle before KDF and recover after the short limiter window', async () => {
    const original = f.env.AUTH_ACCOUNT_RATE_LIMITER;
    const limiter = testRateLimit(2);
    f.env.AUTH_ACCOUNT_RATE_LIMITER = limiter;
    const before = f.hasher.calls;
    try {
      for (const status of [401, 401, 429])
        expect(
          (
            await f.request('/api/auth/login', 'POST', undefined, {
              email: owner.email,
              password: owner.password + 'wrong',
            })
          ).status,
        ).toBe(status);
      expect(f.hasher.calls - before).toBe(2);
      limiter.reset();
      expect(
        (
          await f.request('/api/auth/login', 'POST', undefined, {
            email: owner.email,
            password: owner.password,
          })
        ).status,
      ).toBe(200);
    } finally {
      f.env.AUTH_ACCOUNT_RATE_LIMITER = original;
    }
  });
  it('secure HTML navigation offers own-password reauth without disclosing domain data', async () => {
    const session = await f.session(owner.id);
    const response = await f.request(
      '/secure/confirm/policies/synthetic-hidden/identity-variant',
      'GET',
      session.cookie,
      undefined,
      undefined,
      { accept: 'text/html' },
    );
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(html).toContain('Devam etmek için şifrenizi tekrar girin');
    expect(html).not.toContain('synthetic-hidden');
    expect(html).toContain('autocomplete="current-password"');
    expect(response.headers.get('cache-control')).toContain('no-store');
  });
  it('denies Access/Bearer alone and exposes no registration/recovery/bootstrap HTTP', async () => {
    for (const headers of [
      { 'Cf-Access-Jwt-Assertion': 'synthetic-untrusted' },
      { Authorization: 'Bearer synthetic-untrusted' },
    ] as Record<string, string>[])
      expect(
        (await f.request('/api/me', 'GET', undefined, undefined, undefined, headers)).status,
      ).toBe(401);
    for (const path of [
      '/api/auth/register',
      '/api/auth/forgot-password',
      '/api/auth/reset',
      '/api/auth/bootstrap',
    ])
      expect((await f.request(path, 'POST', undefined, {})).status).toBe(404);
  });
  it('generic unknown/wrong and case-normalized successful login; hash-only cookie session', async () => {
    const unknown = await f.request('/api/auth/login', 'POST', undefined, {
      email: 'unknown@example.invalid',
      password: owner.password,
    });
    const wrong = await f.request('/api/auth/login', 'POST', undefined, {
      email: owner.email,
      password: owner.password + 'wrong',
    });
    expect(unknown.status).toBe(401);
    expect(wrong.status).toBe(401);
    expect((await json(unknown)).error).toEqual((await json(wrong)).error);
    const success = await f.request('/api/auth/login', 'POST', undefined, {
      email: `  ${owner.email.toUpperCase()}  `,
      password: owner.password,
    });
    expect(success.status).toBe(200);
    const cookie = cookieOf(success);
    expect(success.headers.get('set-cookie')).toContain(
      'Secure; HttpOnly; SameSite=Strict; Path=/',
    );
    expect(success.headers.get('set-cookie')).not.toContain('Domain=');
    const hash = await hashSessionToken(cookie.split('=')[1]!);
    expect(
      !!(await f.db
        .prepare('SELECT token_hash FROM local_sessions WHERE token_hash=?')
        .bind(hash)
        .first()),
    ).toBe(true);
    expect((await f.request('/api/me', 'GET', cookie)).status).toBe(200);
  });
  it('rate limits before hasher and permits recovery without persistent lockout', async () => {
    const rate = f.env.AUTH_ACCOUNT_RATE_LIMITER!;
    f.env.AUTH_ACCOUNT_RATE_LIMITER = {
      async limit() {
        return { success: false };
      },
    };
    const calls = f.hasher.calls;
    expect(
      (
        await f.request('/api/auth/login', 'POST', undefined, {
          email: owner.email,
          password: owner.password,
        })
      ).status,
    ).toBe(429);
    expect(f.hasher.calls).toBe(calls);
    f.env.AUTH_ACCOUNT_RATE_LIMITER = rate;
    expect(
      (
        await f.request('/api/auth/login', 'POST', undefined, {
          email: owner.email,
          password: owner.password,
        })
      ).status,
    ).toBe(200);
  });
  it('temporary login is restricted on all domain namespaces; activation rotates and retires temporary secret', async () => {
    const temporary = await f.seed('temporary', 'MEMBER', true);
    const login = await f.request('/api/auth/login', 'POST', undefined, {
      email: temporary.email,
      password: temporary.password,
    });
    expect(login.status).toBe(200);
    const cookie = cookieOf(login);
    for (const path of [
      '/api/me',
      '/api/customers',
      '/api/policies',
      '/api/documents',
      '/api/reports',
      '/api/tasks',
      '/api/renewals',
      '/secure/api/personnel',
      '/secure/api/csrf-token',
    ])
      expect((await f.request(path, 'GET', cookie)).status).not.toBe(200);
    const csrf = await f.csrf(cookie);
    const changed = await f.request(
      '/api/auth/password',
      'POST',
      cookie,
      {
        newPassword: 'a peaceful synthetic winter phrase',
        confirmation: 'a peaceful synthetic winter phrase',
      },
      csrf,
    );
    expect(changed.status).toBe(200);
    const normal = cookieOf(changed);
    expect(normal === cookie).toBe(false);
    expect((await f.request('/api/auth/session', 'GET', cookie)).status).toBe(401);
    expect((await f.request('/api/me', 'GET', normal)).status).toBe(200);
    expect(
      (
        await f.request('/api/auth/login', 'POST', undefined, {
          email: temporary.email,
          password: temporary.password,
        })
      ).status,
    ).toBe(401);
    const state = await f.db
      .prepare(
        'SELECT must_change_password,temporary_expires_at,credential_version FROM local_credentials WHERE user_id=?',
      )
      .bind(temporary.id)
      .first();
    expect(state).toEqual({
      must_change_password: 0,
      temporary_expires_at: null,
      credential_version: 2,
    });
  });
  it('CSRF binds the session, not just the identity; own-password reauth rotates current token', async () => {
    const first = await f.session(owner.id);
    const second = await f.session(owner.id);
    const csrf = await f.csrf(first.cookie);
    expect(
      (
        await f.request(
          '/api/auth/reauth',
          'POST',
          second.cookie,
          { password: owner.password },
          csrf,
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await f.request(
          '/api/auth/reauth',
          'POST',
          first.cookie,
          { password: owner.password + 'wrong' },
          csrf,
        )
      ).status,
    ).toBe(403);
    const res = await f.request(
      '/api/auth/reauth',
      'POST',
      first.cookie,
      { password: owner.password },
      csrf,
    );
    expect(res.status).toBe(200);
    expect(cookieOf(res) === first.cookie).toBe(false);
    expect((await f.request('/api/me', 'GET', first.cookie)).status).toBe(401);
  });
  it('self-change revokes every session and logout requires CSRF and expires cookie', async () => {
    const a = await f.session(owner.id),
      b = await f.session(owner.id);
    const csrf = await f.csrf(a.cookie);
    const result = await f.request(
      '/api/auth/password',
      'POST',
      a.cookie,
      {
        currentPassword: owner.password,
        newPassword: 'synthetic replacement long phrase',
        confirmation: 'synthetic replacement long phrase',
      },
      csrf,
    );
    expect(result.status).toBe(200);
    const cookie = cookieOf(result);
    expect((await f.request('/api/me', 'GET', a.cookie)).status).toBe(401);
    expect((await f.request('/api/me', 'GET', b.cookie)).status).toBe(401);
    expect((await f.request('/api/auth/logout', 'POST', cookie, {})).status).toBe(403);
    const out = await f.request('/api/auth/logout', 'POST', cookie, {}, await f.csrf(cookie));
    expect(out.status).toBe(200);
    expect(out.headers.get('set-cookie')).toContain('Max-Age=0');
    expect((await f.request('/api/me', 'GET', cookie)).status).toBe(401);
  });
});
