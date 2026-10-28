// @vitest-environment node
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest';
import * as config from '../src/server/config';
import { createWorker } from '../src/server/index';
import { csrfSessionSubject, loadLocalSession } from '../src/server/auth/session';
import { verifyIdentityBoundCsrfToken } from '../src/server/security/csrf';
import { localAuthFixture, testRateLimit } from './support/local-auth-fixture';
import { parseCsrfConfigCandidate } from '../engineering-drafts/m4-csrf-local/config-candidate';
let f: Awaited<ReturnType<typeof localAuthFixture>>;
const origin = 'https://panel.mayisigorta.com';
// The candidate parser is substituted only inside this local test process.
beforeAll(async () => {
  f = await localAuthFixture();
}, 90000);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await f?.mf.dispose();
});
async function actor(role: 'OWNER' | 'MEMBER' = 'OWNER') {
  const id = crypto.randomUUID();
  const owner = await f.seed('owner-' + id, 'OWNER', false, crypto.randomUUID());
  return role === 'OWNER' ? owner : f.seed('member-' + id, 'MEMBER', false, owner.agencyId);
}
function request(
  cookie: string,
  path = '/api/auth/csrf-token',
  method = 'GET',
  headers: Record<string, string> = {},
) {
  return createWorker(f.app).fetch(
    new Request(origin + path, {
      method,
      headers: { Cookie: cookie, Origin: origin, ...headers },
    }),
    f.env,
    {} as ExecutionContext,
  );
}
async function assertResponse(response: Response, status: number) {
  expect(response.status).toBe(status);
  expect(response.headers.get('cache-control')).toContain('no-store');
  expect(response.headers.has('set-cookie')).toBe(false);
  if (status !== 200) {
    const text = await response.text();
    if (text === '') return 'EMPTY_FAIL_CLOSED_BODY';
    const body = JSON.parse(text) as { success: boolean; error: { code: string } };
    expect(body.success).toBe(false);
    return body.error.code;
  }
}

for (const role of ['OWNER', 'MEMBER'] as const)
  for (const change of [
    'revoked',
    'permission-version',
    'credential-version',
    'suspended-membership',
    'expired',
    'idle-expired',
  ] as const) {
    it(`preserves fresh ${role} ${change} denial with no token or authority cache`, async () => {
      const a = await actor(role);
      const session = await f.session(a.id);
      const baseline = await request(session.cookie);
      await assertResponse(baseline, 200);
      const spy = vi.spyOn(config, 'parseCsrfConfig').mockImplementation(parseCsrfConfigCandidate);
      await assertResponse(await request(session.cookie), 200);
      expect(spy).toHaveBeenCalled();
      if (change === 'revoked')
        await f.db
          .prepare('UPDATE local_sessions SET revoked_at=? WHERE token_hash=?')
          .bind(Date.now(), session.hash)
          .run();
      if (change === 'permission-version')
        await f.db
          .prepare(
            'UPDATE agency_memberships SET permission_version=permission_version+1,version=version+1 WHERE id=?',
          )
          .bind(a.membershipId)
          .run();
      if (change === 'credential-version')
        await f.db
          .prepare(
            'UPDATE local_credentials SET credential_version=credential_version+1,updated_at=? WHERE user_id=?',
          )
          .bind(Date.now(), a.id)
          .run();
      if (change === 'suspended-membership') {
        if (role === 'OWNER')
          await f.seed('backup-' + crypto.randomUUID(), 'OWNER', false, a.agencyId);
        await f.db
          .prepare(
            "UPDATE agency_memberships SET status='SUSPENDED',suspended_at=?,version=version+1,permission_version=permission_version+1 WHERE id=?",
          )
          .bind(new Date().toISOString(), a.membershipId)
          .run();
      }
      if (change === 'expired' || change === 'idle-expired') {
        vi.spyOn(Date, 'now').mockReturnValue(
          Date.now() + (change === 'expired' ? 13 : 9) * 60 * 60 * 1000,
        );
      }
      const candidateCode = await assertResponse(await request(session.cookie), 401);
      spy.mockRestore();
      const baselineCode = await assertResponse(await request(session.cookie), 401);
      expect(candidateCode).toBe('UNAUTHORIZED');
      expect(baselineCode).toBe(candidateCode);
      expect(f.env.DOCUMENTS_ENABLED).toBe('false');
    });
  }

it('retains per-session subject binding, fresh nonce and live secret rotation', async () => {
  vi.spyOn(config, 'parseCsrfConfig').mockImplementation(parseCsrfConfigCandidate);
  const a = await actor();
  const one = await f.session(a.id);
  const two = await f.session(a.id);
  const req = new Request(origin + '/api/auth/csrf-token', { headers: { Cookie: one.cookie } });
  const row = await loadLocalSession(f.db, req, true);
  const subject = csrfSessionSubject(req, row.subject);
  const req2 = new Request(origin + '/api/auth/csrf-token', { headers: { Cookie: two.cookie } });
  const row2 = await loadLocalSession(f.db, req2, true);
  const other = csrfSessionSubject(req2, row2.subject);
  const token = await f.csrf(one.cookie);
  const another = await f.csrf(one.cookie);
  const secret = parseCsrfConfigCandidate(f.env).CSRF_SECRET;
  expect(token === another).toBe(false);
  expect((await verifyIdentityBoundCsrfToken(token, subject, secret)).valid).toBe(true);
  expect((await verifyIdentityBoundCsrfToken(token, other, secret)).valid).toBe(false);
  const old = f.env.CSRF_SECRET;
  try {
    f.env.CSRF_SECRET = crypto.randomUUID();
    const rotated = parseCsrfConfigCandidate(f.env).CSRF_SECRET;
    expect((await verifyIdentityBoundCsrfToken(token, subject, rotated)).valid).toBe(false);
    const fresh = await f.csrf(one.cookie);
    expect((await verifyIdentityBoundCsrfToken(fresh, subject, rotated)).valid).toBe(true);
    f.env.CSRF_SECRET = null;
    const candidate = await assertResponse(await request(one.cookie), 401);
    vi.restoreAllMocks();
    expect(await assertResponse(await request(one.cookie), 401)).toBe(candidate);
  } finally {
    f.env.CSRF_SECRET = old;
  }
});

it('keeps the actual HTTP origin/method/canonical-path guards and documents-disabled availability', async () => {
  const a = await actor();
  const session = await f.session(a.id);
  for (const candidate of [false, true]) {
    const spy = candidate
      ? vi.spyOn(config, 'parseCsrfConfig').mockImplementation(parseCsrfConfigCandidate)
      : undefined;
    try {
      await assertResponse(await request(session.cookie), 200);
      await assertResponse(
        await request(session.cookie, '/api/auth/csrf-token', 'GET', {
          Origin: 'https://foreign.invalid',
        }),
        403,
      );
      await assertResponse(
        await request(session.cookie, '/api/auth/csrf-token', 'GET', { Host: 'foreign.invalid' }),
        403,
      );
      await assertResponse(await request(session.cookie, '/api/auth/%63srf-token'), 404);
      await assertResponse(await request(session.cookie, '/api/auth/csrf-token', 'POST'), 404);
      const head = await request(session.cookie, '/api/auth/csrf-token', 'HEAD');
      expect(head.status).toBe(200);
      expect(await head.text()).toBe('');
    } finally {
      spy?.mockRestore();
    }
  }
  expect(f.env.DOCUMENTS_ENABLED).toBe('false');
  expect(f.env.DOCUMENT_UPLOAD_RUNTIME).toBeUndefined();
});

it('preserves existing login source/account throttling before password work', async () => {
  const a = await actor();
  const oldAccount = f.env.AUTH_ACCOUNT_RATE_LIMITER;
  const oldSource = f.env.AUTH_SOURCE_RATE_LIMITER;
  vi.spyOn(config, 'parseCsrfConfig').mockImplementation(parseCsrfConfigCandidate);
  const source = testRateLimit(1000);
  f.env.AUTH_ACCOUNT_RATE_LIMITER = testRateLimit(1);
  f.env.AUTH_SOURCE_RATE_LIMITER = source;
  const before = f.hasher.calls;
  try {
    for (const status of [401, 429]) {
      const r = await f.request('/api/auth/login', 'POST', undefined, {
        email: a.email,
        password: 'not-the-local-fixture-password',
      });
      expect(r.status).toBe(status);
    }
    expect(source.calls).toBe(2);
    expect(f.hasher.calls - before).toBe(1);
  } finally {
    f.env.AUTH_ACCOUNT_RATE_LIMITER = oldAccount;
    f.env.AUTH_SOURCE_RATE_LIMITER = oldSource;
  }
});
