// @vitest-environment node
import { expect, it } from 'vitest';
import { createApp } from '../src/server/index';
import { localAuthFixture } from './support/local-auth-fixture';
import { isSupportedPasswordVerifier } from '../src/server/auth/password-envelope';
it('fails closed as infrastructure when default password binding is missing', async () => {
  const f = await localAuthFixture();
  try {
    const response = await createApp().fetch(
      new Request('https://panel.mayisigorta.com/api/auth/login', {
        method: 'POST',
        headers: { origin: 'https://panel.mayisigorta.com', 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'absent@example.invalid', password: crypto.randomUUID() }),
      }),
      f.env,
    );
    expect(response.status).toBe(503);
  } finally {
    await f.mf.dispose();
  }
});
it('unknown login uses the private DO verification and a canonical v2 dummy', async () => {
  const f = await localAuthFixture();
  let calls = 0;
  let canonical = false;
  try {
    f.env.PASSWORD_KDF = {
      getByName() {
        return {
          async hash() {
            throw Error('UNEXPECTED');
          },
          async verify(_password: string, verifier: string) {
            calls++;
            canonical = isSupportedPasswordVerifier(verifier);
            return { matches: false, needsRehash: false };
          },
        };
      },
    } as never;
    const response = await createApp().fetch(
      new Request('https://panel.mayisigorta.com/api/auth/login', {
        method: 'POST',
        headers: { origin: 'https://panel.mayisigorta.com', 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'absent@example.invalid', password: crypto.randomUUID() }),
      }),
      f.env,
    );
    expect(response.status).toBe(401);
    expect(calls).toBe(1);
    expect(canonical).toBe(true);
  } finally {
    await f.mf.dispose();
  }
});
