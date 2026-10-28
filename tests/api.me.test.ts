// @vitest-environment node
// F-27 supersedes the historical JWT/Access HTTP composition; identity resolver regressions remain separate.
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import { createWorker } from '../src/server/index';
let f: Awaited<ReturnType<typeof localAuthFixture>>;
beforeAll(async () => {
  f = await localAuthFixture();
  await f.seed('me-owner', 'OWNER');
});
afterAll(async () => {
  await f?.mf.dispose();
});
describe('GET /api/me with native local opaque sessions', () => {
  it('rejects missing and attacker-created cookies without provisioning', async () => {
    const before = (await f.db.prepare('SELECT id FROM users').all()).results.length;
    for (const cookie of [
      undefined,
      '__Host-mayi-session=unknown',
      '__Host-mayi-session=' + 'a'.repeat(64),
    ])
      expect((await f.request('/api/me', 'GET', cookie)).status).toBe(401);
    expect((await f.db.prepare('SELECT id FROM users').all()).results.length).toBe(before);
  });
  it('returns the live bound user and membership, without credential or session secret DTO fields', async () => {
    const session = await f.session('me-owner');
    const res = await f.request('/api/me', 'GET', session.cookie);
    expect(res.status).toBe(200);
    const json = (await res.json()) as { data: Record<string, unknown> };
    expect(json.data.userId).toBe('me-owner');
    expect(Object.keys(json.data).sort()).toEqual(['assurance', 'email', 'memberships', 'userId']);
    expect(res.headers.get('cache-control')).toContain('no-store');
  });
  it('credential version and membership permission version changes immediately invalidate old sessions', async () => {
    const member = await f.seed('me-member');
    const session = await f.session(member.id);
    await f.db
      .prepare(
        'UPDATE agency_memberships SET permission_version=permission_version+1,version=version+1 WHERE id=?',
      )
      .bind(member.membershipId)
      .run();
    expect((await f.request('/api/me', 'GET', session.cookie)).status).toBe(401);
    const newSession = await f.session(member.id);
    await f.db
      .prepare(
        'UPDATE local_credentials SET credential_version=credential_version+1 WHERE user_id=?',
      )
      .bind(member.id)
      .run();
    expect((await f.request('/api/me', 'GET', newSession.cookie)).status).toBe(401);
  });
  it('suspension and reactivation never restore an old password/session', async () => {
    const member = await f.seed('me-suspend');
    const session = await f.session(member.id);
    const iso = new Date().toISOString();
    await f.db
      .prepare(
        "UPDATE agency_memberships SET status='SUSPENDED',suspended_at=?,version=version+1,permission_version=permission_version+1 WHERE id=?",
      )
      .bind(iso, member.membershipId)
      .run();
    expect((await f.request('/api/me', 'GET', session.cookie)).status).toBe(401);
    await f.db
      .prepare(
        "UPDATE agency_memberships SET status='ACTIVE',version=version+1,permission_version=permission_version+1 WHERE id=?",
      )
      .bind(member.membershipId)
      .run();
    expect((await f.request('/api/me', 'GET', session.cookie)).status).toBe(401);
    expect(
      (
        await f.request('/api/auth/login', 'POST', undefined, {
          email: member.email,
          password: member.password,
        })
      ).status,
    ).toBe(401);
  });
  it('API and secure aliases never fall through to static assets', async () => {
    let assetsCalled = false;
    const worker = createWorker(f.app);
    const env = {
      ...f.env,
      ASSETS: {
        async fetch() {
          assetsCalled = true;
          return new Response('unsafe static fallback');
        },
      } as unknown as Fetcher,
    };
    for (const path of [
      '/api/unknown',
      '/api%2Fme',
      '/secure%2Fapi/personnel',
      '/secure//api/personnel',
    ]) {
      const response = await worker.fetch(
        new Request('https://panel.mayisigorta.com' + path),
        env,
        {} as ExecutionContext,
      );
      expect(response.status).toBe(404);
    }
    expect(assetsCalled).toBe(false);
  });
});
