// @vitest-environment node
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
import { createApp } from '../src/server/index';
import { productionPasswordHasher } from '../src/server/auth/password';
import { randomSessionToken, hashSessionToken, sessionInsert } from '../src/server/auth/session';
import { sessionBoundDatabase } from '../src/server/auth/session-database';
let f: Awaited<ReturnType<typeof localAuthFixture>>;
beforeAll(async () => {
  f = await localAuthFixture();
  await f.seed('matrix-owner', 'OWNER');
});
afterAll(async () => {
  await f?.mf.dispose();
});
describe('F-27 adversarial session/login matrix', () => {
  it.each(['inactive-user', 'suspended-member', 'expired-temporary'] as const)(
    'uses generic login failure and dummy hasher for %s',
    async (state) => {
      const member = await f.seed(`matrix-${state}`, 'MEMBER', state === 'expired-temporary');
      const now = Date.now();
      if (state === 'inactive-user')
        await f.db
          .prepare("UPDATE users SET status='INACTIVE',version=version+1 WHERE id=?")
          .bind(member.id)
          .run();
      if (state === 'suspended-member')
        await f.db
          .prepare(
            "UPDATE agency_memberships SET status='SUSPENDED',suspended_at=?,version=version+1,permission_version=permission_version+1 WHERE id=?",
          )
          .bind(new Date(now).toISOString(), member.membershipId)
          .run();
      if (state === 'expired-temporary')
        await f.db
          .prepare('UPDATE local_credentials SET temporary_expires_at=? WHERE user_id=?')
          .bind(now - 1, member.id)
          .run();
      const before = f.hasher.calls;
      const response = await f.request('/api/auth/login', 'POST', undefined, {
        email: member.email,
        password: member.password,
      });
      expect(response.status).toBe(401);
      expect(((await response.json()) as { error: { message: string } }).error.message).toBe(
        'E-posta veya şifre hatalı.',
      );
      expect(f.hasher.calls - before).toBe(1);
    },
  );
  it.each(['absolute', 'idle'] as const)(
    'server-enforces %s expiry without sliding revival',
    async (kind) => {
      const member = await f.seed(`matrix-expired-${kind}`);
      const now = Date.now();
      const token = randomSessionToken();
      const hash = await hashSessionToken(token);
      const created = now - (kind === 'absolute' ? 13 : 9) * 3600000;
      await sessionInsert(
        f.db,
        hash,
        {
          user_id: member.id,
          identity_id: member.identityId,
          membership_id: member.membershipId,
          credential_version: 1,
          permission_version: 1,
        },
        'NORMAL',
        created,
        created + 43200000,
      ).run();
      expect((await f.request('/api/me', 'GET', `__Host-mayi-session=${token}`)).status).toBe(401);
    },
  );
  it('rejects HTTP/alternate host/cross-origin and oversized streams before KDF', async () => {
    const calls = f.hasher.calls;
    for (const url of [
      'http://panel.mayisigorta.com/api/auth/login',
      'https://alternate.invalid/api/auth/login',
    ]) {
      const response = await f.app.fetch(
        new Request(url, {
          method: 'POST',
          headers: { origin: 'https://panel.mayisigorta.com', 'content-type': 'application/json' },
          body: '{}',
        }),
        f.env,
      );
      expect(response.status).toBe(403);
    }
    expect(
      (
        await f.request('/api/auth/login', 'POST', undefined, {
          email: 'matrix-owner@example.invalid',
          password: 'x'.repeat(100000),
        })
      ).status,
    ).toBe(413);
    const response = await f.request(
      '/api/auth/login',
      'POST',
      undefined,
      { email: 'matrix-owner@example.invalid', password: 'synthetic fixture permanent passphrase' },
      undefined,
      { origin: 'https://mayisigorta.com' },
    );
    expect(response.status).toBe(403);
    expect(f.hasher.calls).toBe(calls);
  });
  it('fails closed missing rate protection before costly work', async () => {
    const original = f.env.AUTH_ACCOUNT_RATE_LIMITER;
    delete f.env.AUTH_ACCOUNT_RATE_LIMITER;
    const before = f.hasher.calls;
    try {
      expect(
        (
          await f.request('/api/auth/login', 'POST', undefined, {
            email: 'matrix-owner@example.invalid',
            password: 'synthetic fixture permanent passphrase',
          })
        ).status,
      ).toBe(503);
      expect(f.hasher.calls).toBe(before);
    } finally {
      f.env.AUTH_ACCOUNT_RATE_LIMITER = original;
    }
  });
  it('native production dummy path executes the same KDF for unknown and malformed stored verifiers', async () => {
    const member = await f.seed('matrix-real-dummy');
    const app = createApp();
    const derive = vi.spyOn(crypto.subtle, 'deriveBits');
    try {
      const request = (email: string) =>
        app.fetch(
          new Request('https://panel.mayisigorta.com/api/auth/login', {
            method: 'POST',
            headers: {
              origin: 'https://panel.mayisigorta.com',
              'content-type': 'application/json',
            },
            body: JSON.stringify({ email, password: member.password }),
          }),
          f.env,
        );
      expect((await request('unknown-real-dummy@example.invalid')).status).toBe(401);
      expect(derive.mock.calls.length).toBe(1);
      expect((await request(member.email)).status).toBe(401);
      expect(derive.mock.calls.length).toBe(2);
      const native = await productionPasswordHasher.hash(member.password);
      await f.db
        .prepare('UPDATE local_credentials SET verifier=? WHERE user_id=?')
        .bind(native, member.id)
        .run();
      expect((await request(member.email)).status).toBe(200);
    } finally {
      derive.mockRestore();
    }
  });
  it('cannot upgrade a restricted session or un-revoke a session in place', async () => {
    const session = await f.session('matrix-owner');
    expect(
      await f.db
        .prepare("UPDATE local_sessions SET kind='ACTIVATION' WHERE token_hash=?")
        .bind(session.hash)
        .run()
        .then(
          () => false,
          () => true,
        ),
    ).toBe(true);
    await f.db
      .prepare('UPDATE local_sessions SET revoked_at=? WHERE token_hash=?')
      .bind(Date.now(), session.hash)
      .run();
    expect(
      await f.db
        .prepare('UPDATE local_sessions SET revoked_at=NULL WHERE token_hash=?')
        .bind(session.hash)
        .run()
        .then(
          () => false,
          () => true,
        ),
    ).toBe(true);
  });
  it('request-bound atomic mutation rolls back after concurrent session revoke', async () => {
    const member = await f.seed('matrix-race');
    const session = await f.session(member.id);
    const response = await f.request('/api/me', 'GET', session.cookie);
    expect(response.status).toBe(200);
    const row = await f.db
      .prepare(
        'SELECT s.*,m.agency_id FROM local_sessions s JOIN agency_memberships m ON m.id=s.membership_id WHERE token_hash=?',
      )
      .bind(session.hash)
      .first();
    const scoped = sessionBoundDatabase(
      f.db,
      row as unknown as Parameters<typeof sessionBoundDatabase>[1],
    );
    await f.db
      .prepare('UPDATE local_sessions SET revoked_at=? WHERE token_hash=?')
      .bind(Date.now(), session.hash)
      .run();
    expect(
      await scoped
        .batch([
          f.db
            .prepare('UPDATE users SET display_name=?,version=version+1 WHERE id=?')
            .bind('Should not commit', member.id),
        ])
        .then(
          () => false,
          () => true,
        ),
    ).toBe(true);
    expect(
      (
        await f.db
          .prepare('SELECT display_name FROM users WHERE id=?')
          .bind(member.id)
          .first<{ display_name: string }>()
      )?.display_name === 'Should not commit',
    ).toBe(false);
  });
  it('last owner user/identity revocation remains protected by immutable historical guards', async () => {
    expect(
      await f.db
        .prepare("UPDATE users SET status='INACTIVE',version=version+1 WHERE id='matrix-owner'")
        .run()
        .then(
          () => false,
          () => true,
        ),
    ).toBe(true);
    expect(
      await f.db
        .prepare(
          "UPDATE auth_identities SET status='REVOKED',revoked_at=?,version=version+1 WHERE user_id='matrix-owner'",
        )
        .bind(new Date().toISOString())
        .run()
        .then(
          () => false,
          () => true,
        ),
    ).toBe(true);
  });
});
