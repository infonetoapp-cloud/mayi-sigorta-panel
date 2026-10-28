// @vitest-environment node
import { expect, it } from 'vitest';
import { randomBytes } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { openDemo, DEMO_ORIGIN, DEMO_USERS } from '../scripts/demo/application';
it('supports the real identity search crypto boundary in the isolated demo without giving normal members sensitive authority', async () => {
  const passwords = DEMO_USERS.map(() => Buffer.from(randomBytes(24)).toString('hex'));
  const demo = await openDemo(passwords);
  try {
    const login = await demo.fetch(
      new Request(DEMO_ORIGIN + '/api/auth/login', {
        method: 'POST',
        headers: { origin: DEMO_ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ email: DEMO_USERS[2].email, password: passwords[2] }),
      }),
    );
    expect(login.status).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    const csrf = await demo.fetch(
      new Request(DEMO_ORIGIN + '/api/csrf-token', { headers: { cookie } }),
    );
    const token = ((await csrf.json()) as { data: { token: string } }).data.token;
    const search = await demo.fetch(
      new Request(DEMO_ORIGIN + '/api/customers/search-sensitive', {
        method: 'POST',
        headers: {
          cookie,
          origin: DEMO_ORIGIN,
          'content-type': 'application/json',
          'x-csrf-token': token,
        },
        body: JSON.stringify({ identityType: 'TCKN', identityValue: '10000000146' }),
      }),
    );
    expect(search.status).toBe(403);
  } finally {
    await demo.dispose();
  }
}, 120000);
