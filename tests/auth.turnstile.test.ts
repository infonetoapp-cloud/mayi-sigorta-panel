import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp, createWorker, type Env } from '../src/server/index';

const origin = 'https://panel.mayisigorta.com';
const siteKey = 'synthetic-widget-site-key';
const secret = 'synthetic-widget-private-secret';
const providerSuccess = { success: true, hostname: 'panel.mayisigorta.com', action: 'crm_login' };

function fixture() {
  const verify = vi.fn(async () => ({ matches: false, needsRehash: false }));
  const prepare = vi.fn(() => ({ bind: () => ({ all: async () => ({ results: [] }) }) }));
  const limiter = vi.fn(async () => ({ success: true }));
  const env: Env = {
    APP_ENV: 'production',
    DB: { prepare } as unknown as D1Database,
    TURNSTILE_SITE_KEY: siteKey,
    TURNSTILE_SECRET: secret,
    AUTH_ACCOUNT_RATE_LIMITER: { limit: limiter },
    AUTH_SOURCE_RATE_LIMITER: { limit: limiter },
  };
  const app = createApp({ passwordHasher: { hash: vi.fn(), verify } });
  return {
    app,
    env,
    prepare,
    verify,
    limiter,
    login: (turnstileToken?: string) =>
      app.request(
        origin + '/api/auth/login',
        {
          method: 'POST',
          headers: {
            Origin: origin,
            'Content-Type': 'application/json',
            'CF-Connecting-IP': '192.0.2.1',
          },
          body: JSON.stringify({
            email: 'synthetic@example.invalid',
            password: 'synthetic passphrase',
            turnstileToken,
          }),
        },
        env,
      ),
  };
}

afterEach(() => vi.unstubAllGlobals());

describe('production login Turnstile', () => {
  it.each([undefined, 'x'.repeat(2049)])(
    'rejects missing or oversized input before D1',
    async (token) => {
      const f = fixture();
      const siteverify = vi.fn();
      vi.stubGlobal('fetch', siteverify);
      expect((await f.login(token)).status).toBe(token ? 400 : 403);
      expect(siteverify).not.toHaveBeenCalled();
      expect(f.prepare).not.toHaveBeenCalled();
      expect(f.verify).not.toHaveBeenCalled();
    },
  );

  it.each([
    { success: false, 'error-codes': ['timeout-or-duplicate'] },
    { ...providerSuccess, hostname: 'another.example' },
    { ...providerSuccess, action: 'other_action' },
  ])('rejects a reused or mismatched result before KDF', async (result) => {
    const f = fixture();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json(result)),
    );
    expect((await f.login('synthetic-token')).status).toBe(403);
    expect(f.prepare).not.toHaveBeenCalled();
    expect(f.verify).not.toHaveBeenCalled();
  });

  it('uses the rate limit before Siteverify and the accepted result before password checking', async () => {
    const f = fixture();
    const siteverify = vi.fn(async (url: string, options: RequestInit) => {
      expect(f.limiter).toHaveBeenCalledTimes(2);
      expect(url).toBe('https://challenges.cloudflare.com/turnstile/v0/siteverify');
      expect(options.redirect).toBe('manual');
      expect(Object.fromEntries(options.body as URLSearchParams)).toEqual({
        secret,
        response: 'synthetic-token',
      });
      return Response.json(providerSuccess);
    });
    vi.stubGlobal('fetch', siteverify);
    expect((await f.login('synthetic-token')).status).toBe(401);
    expect(siteverify).toHaveBeenCalledOnce();
    expect(f.prepare).toHaveBeenCalledOnce();
    expect(f.verify).toHaveBeenCalledOnce();
  });

  it('fails closed on missing secret or provider failure and does not call D1', async () => {
    const f = fixture();
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('synthetic outage')));
    expect((await f.login('synthetic-token')).status).toBe(503);
    delete f.env.TURNSTILE_SECRET;
    expect((await f.login('synthetic-token')).status).toBe(503);
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it('does not follow a Siteverify redirect', async () => {
    const f = fixture();
    const siteverify = vi.fn(async () => Response.redirect('https://another.example/'));
    vi.stubGlobal('fetch', siteverify);
    expect((await f.login('synthetic-token')).status).toBe(503);
    expect(siteverify).toHaveBeenCalledOnce();
    expect(f.prepare).not.toHaveBeenCalled();
  });

  it('serves only the public key and restricts the CSP exception to the SPA HTML', async () => {
    const { app, env } = fixture();
    const anonymous = await app.request(origin + '/api/auth/session', {}, env);
    expect(anonymous.status).toBe(401);
    expect(anonymous.headers.get('X-Turnstile-Site-Key')).toBe(siteKey);
    expect(anonymous.headers.get('cache-control')).toContain('no-store');
    expect(anonymous.headers.get('content-security-policy')).not.toContain(
      'challenges.cloudflare.com',
    );
    expect(await anonymous.text()).not.toContain(secret);
    const assets = {
      fetch: async () =>
        new Response('<html></html>', { headers: { 'Content-Type': 'text/html' } }),
    } as unknown as Fetcher;
    const response = await createWorker(app).fetch(
      new Request(origin),
      { ...env, ASSETS: assets },
      {} as ExecutionContext,
    );
    const csp = response.headers.get('content-security-policy');
    expect(csp).toContain("script-src 'self' https://challenges.cloudflare.com");
    expect(csp).toContain('frame-src https://challenges.cloudflare.com');
    expect(csp).toContain("frame-ancestors 'none'");
  });
});
