// @vitest-environment node
import { beforeAll, afterAll, it, expect } from 'vitest';
import { localAuthFixture } from './support/local-auth-fixture';
let f: Awaited<ReturnType<typeof localAuthFixture>>;
beforeAll(async () => {
  f = await localAuthFixture();
  await f.seed('atomic-owner', 'OWNER');
});
afterAll(async () => {
  await f?.mf.dispose();
});
it('login rechecks temporary expiry after password verification inside D1', async () => {
  const user = await f.seed('atomic-login', 'MEMBER', true);
  const verify = f.hasher.verify;
  f.hasher.verify = async (password, verifier) => {
    const result = await verify(password, verifier);
    await f.db
      .prepare('UPDATE local_credentials SET temporary_expires_at=? WHERE user_id=?')
      .bind(Date.now() - 1, user.id)
      .run();
    return result;
  };
  try {
    const response = await f.request('/api/auth/login', 'POST', undefined, {
      email: user.email,
      password: user.password,
    });
    expect(response.status).toBe(401);
    expect(
      (
        await f.db
          .prepare('SELECT token_hash FROM local_sessions WHERE user_id=?')
          .bind(user.id)
          .all()
      ).results.length,
    ).toBe(0);
  } finally {
    f.hasher.verify = verify;
  }
});
it('activation cannot replace an expired temporary credential after KDF await', async () => {
  const user = await f.seed('atomic-activation', 'MEMBER', true);
  const login = await f.request('/api/auth/login', 'POST', undefined, {
    email: user.email,
    password: user.password,
  });
  const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
  const csrf = await f.csrf(cookie);
  const hash = f.hasher.hash;
  f.hasher.hash = async (password) => {
    const result = await hash(password);
    await f.db
      .prepare('UPDATE local_credentials SET temporary_expires_at=? WHERE user_id=?')
      .bind(Date.now() - 1, user.id)
      .run();
    return result;
  };
  try {
    const response = await f.request(
      '/api/auth/password',
      'POST',
      cookie,
      {
        newPassword: 'synthetic safe replacement phrase',
        confirmation: 'synthetic safe replacement phrase',
      },
      csrf,
    );
    expect(response.status).toBe(401);
    expect(
      (
        await f.db
          .prepare('SELECT must_change_password FROM local_credentials WHERE user_id=?')
          .bind(user.id)
          .first<{ must_change_password: number }>()
      )?.must_change_password,
    ).toBe(1);
    expect(
      (
        await f.db
          .prepare(
            "SELECT id FROM audit_events WHERE target_id=? AND action='auth.password.activated'",
          )
          .bind(user.id)
          .all()
      ).results.length,
    ).toBe(0);
  } finally {
    f.hasher.hash = hash;
  }
});
