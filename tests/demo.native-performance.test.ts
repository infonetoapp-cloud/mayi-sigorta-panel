// @vitest-environment node
import { it, expect } from 'vitest';
import { openDemo, DEMO_ORIGIN } from '../scripts/demo/application';
it('runs the complete authenticated demo beside native D1 without the Node statement proxy', async () => {
  const passwords = Array.from({ length: 3 }, () => crypto.randomUUID());
  const demo = await openDemo(passwords);
  try {
    expect('runtime' in demo ? demo.runtime : null).toBe('workerd');
    const login = await demo.fetch(
      new Request(DEMO_ORIGIN + '/api/auth/login', {
        method: 'POST',
        headers: { origin: DEMO_ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'sahip@demo.invalid', password: passwords[0] }),
      }),
    );
    expect(login.status, login.status === 200 ? '' : await login.text()).toBe(200);
    const cookie = login.headers.get('set-cookie')!.split(';')[0]!;
    for (const path of [
      '/api/customers',
      '/api/policies',
      '/api/tasks/today',
      '/api/catalogs/insurers',
      '/api/personnel',
      '/api/agency/settings',
    ]) {
      const response = await demo.fetch(new Request(DEMO_ORIGIN + path, { headers: { cookie } }));
      expect(response.status, path).toBe(200);
    }
    for (const request of [
      new Request('https://foreign.invalid/api/customers', { headers: { cookie } }),
      new Request(DEMO_ORIGIN + '/api/customers', { headers: { cookie, host: 'foreign.invalid' } }),
      new Request('http://localhost:8443/api/customers', { headers: { cookie } }),
    ])
      expect((await demo.fetch(request)).status).toBe(403);
    const memberLogin = await demo.fetch(
      new Request(DEMO_ORIGIN + '/api/auth/login', {
        method: 'POST',
        headers: { origin: DEMO_ORIGIN, 'content-type': 'application/json' },
        body: JSON.stringify({ email: 'ahmet@demo.invalid', password: passwords[1] }),
      }),
    );
    expect(memberLogin.status).toBe(200);
    const memberCookie = memberLogin.headers.get('set-cookie')!.split(';')[0]!;
    expect(
      (
        await demo.fetch(
          new Request(DEMO_ORIGIN + '/api/personnel', { headers: { cookie: memberCookie } }),
        )
      ).status,
    ).toBe(403);
    const csrf = await demo.fetch(
      new Request(DEMO_ORIGIN + '/api/csrf-token', { headers: { cookie } }),
    );
    const token = ((await csrf.json()) as { data: { token: string } }).data.token;
    const key = crypto.randomUUID();
    const note = () =>
      demo.fetch(
        new Request(DEMO_ORIGIN + '/api/customers/demo-customer-0/notes', {
          method: 'POST',
          headers: {
            cookie,
            origin: DEMO_ORIGIN,
            'content-type': 'application/json',
            'x-csrf-token': token,
            'idempotency-key': key,
          },
          body: JSON.stringify({ content: 'Sentetik native yazım görünürlük kontrolü' }),
        }),
      );
    expect((await note()).status).toBe(201);
    expect([200, 201]).toContain((await note()).status);
    expect(
      await demo.db
        .prepare(
          "SELECT count(*) AS n FROM customer_notes WHERE content='Sentetik native yazım görünürlük kontrolü'",
        )
        .first('n'),
    ).toBe(1);
    const notes = await demo.fetch(
      new Request(DEMO_ORIGIN + '/api/customers/demo-customer-0/notes', { headers: { cookie } }),
    );
    expect(await notes.text()).toContain('Sentetik native yazım görünürlük kontrolü');
    await demo.db
      .prepare(
        "DELETE FROM membership_permissions WHERE membership_id='demo-member-ahmet' AND permission_code='customer.read'",
      )
      .run();
    expect(
      (
        await demo.fetch(
          new Request(DEMO_ORIGIN + '/api/customers', { headers: { cookie: memberCookie } }),
        )
      ).status,
    ).toBe(403);
    expect(
      (await demo.fetch(new Request(DEMO_ORIGIN + '/api/customers', { headers: { cookie } })))
        .status,
    ).toBe(200);
    await demo.db
      .prepare('UPDATE local_sessions SET revoked_at=? WHERE revoked_at IS NULL')
      .bind(Date.now())
      .run();
    const revoked = await demo.fetch(
      new Request(DEMO_ORIGIN + '/api/customers', { headers: { cookie } }),
    );
    expect(revoked.status).toBe(401);
  } finally {
    await demo.dispose();
  }
}, 180000);
