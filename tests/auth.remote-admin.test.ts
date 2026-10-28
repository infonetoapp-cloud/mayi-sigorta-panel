// @vitest-environment node
import { expect, it, vi } from 'vitest';

// Native CLI module, same import path used by the operator composition.
const remote = await import('../scripts/' + 'remote-auth-admin.mjs');
const keyEnv = {
  CLOUDFLARE_EMAIL: 'synthetic@example.invalid',
  CLOUDFLARE_API_KEY: 'synthetic-key',
};

it('selects Global Key headers without treating the key as Bearer', () => {
  expect(typeof remote.selectAdminAuthentication).toBe('function');
  const headers = remote.selectAdminAuthentication(keyEnv);
  expect(headers).toEqual({
    'X-Auth-Email': keyEnv.CLOUDFLARE_EMAIL,
    'X-Auth-Key': keyEnv.CLOUDFLARE_API_KEY,
  });
  expect(headers).not.toHaveProperty('Authorization');
});

const target = { accountId: 'a'.repeat(32), databaseId: '00000000-0000-4000-8000-000000000027' };
const response = (result: unknown, success = true) => Response.json({ success, result });
const preflight = () => [
  response({ uuid: target.databaseId }),
  response({ two_factor_authentication_enabled: true, two_factor_authentication_locked: true }),
];

it('validates metadata/MFA before issuing one official ordered batch', async () => {
  expect(typeof remote.openRemoteAdminDatabase).toBe('function');
  const replies = preflight();
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method === 'GET') return replies.shift()!;
    return response([
      { success: true, results: [{ n: 1 }] },
      { success: true, results: [{ n: 2 }] },
    ]);
  });
  const db = await remote.openRemoteAdminDatabase(target, keyEnv, fetch);
  const result = await db.batch([
    db.prepare('SELECT ? n').bind(1),
    db.prepare('SELECT ? n').bind(2),
  ]);
  expect(result.map((r: { results: { n: number }[] }) => r.results[0]!.n)).toEqual([1, 2]);
  expect(fetch).toHaveBeenCalledTimes(3);
  const [url, init] = fetch.mock.calls[2]!;
  expect(url).toBe(
    `https://api.cloudflare.com/client/v4/accounts/${target.accountId}/d1/database/${target.databaseId}/query`,
  );
  expect(init.method).toBe('POST');
  expect(init.redirect).toBe('manual');
  expect(JSON.parse(init.body as string)).toEqual({
    batch: [
      { sql: 'SELECT ? n', params: [1] },
      { sql: 'SELECT ? n', params: [2] },
    ],
  });
});

it('selects Token authentication without Global Key headers', () => {
  expect(remote.selectAdminAuthentication({ CLOUDFLARE_API_TOKEN: 'synthetic-token' })).toEqual({
    Authorization: 'Bearer synthetic-token',
  });
});

it.each([
  {},
  { CLOUDFLARE_EMAIL: keyEnv.CLOUDFLARE_EMAIL },
  { CLOUDFLARE_API_KEY: keyEnv.CLOUDFLARE_API_KEY },
  { ...keyEnv, CLOUDFLARE_API_TOKEN: 'synthetic-token' },
  { ...keyEnv, CLOUDFLARE_API_KEY: 'synthetic-key\r\n' },
  { CLOUDFLARE_API_TOKEN: ' synthetic-token' },
])('rejects absent, partial, ambiguous or malformed auth with secret-safe errors (%#)', (env) => {
  let message = '';
  try {
    remote.selectAdminAuthentication(env);
  } catch (error) {
    message = String(error);
  }
  expect(message).toMatch(/ADMIN.*CREDENTIAL/);
  for (const value of ['synthetic-key', 'synthetic-token', keyEnv.CLOUDFLARE_EMAIL])
    expect(message).not.toContain(value);
});

it.each([
  [response({ uuid: crypto.randomUUID() })],
  [response({ uuid: target.databaseId }, false)],
  [
    response({ uuid: target.databaseId }),
    response({ two_factor_authentication_enabled: false, two_factor_authentication_locked: true }),
  ],
  [
    response({ uuid: target.databaseId }),
    response({ two_factor_authentication_enabled: true, two_factor_authentication_locked: false }),
  ],
  [
    new Response(null, {
      status: 302,
      headers: { Location: 'https://invalid.example/credential-sink' },
    }),
  ],
  [new Response(null, { status: 403 })],
])(
  'rejects metadata/MFA/redirect ambiguity before any POST (%#)',
  async (...replies: Response[]) => {
    const fetch = vi.fn(async (_url: string, init: RequestInit) => {
      expect(init.redirect).toBe('manual');
      expect(init.method).toBe('GET');
      return replies.shift()!;
    });
    await expect(remote.openRemoteAdminDatabase(target, keyEnv, fetch)).rejects.toThrow();
    expect(fetch.mock.calls.length).toBeLessThanOrEqual(2);
    expect(fetch.mock.calls.every(([url]) => url.startsWith('https://api.cloudflare.com/'))).toBe(
      true,
    );
  },
);

it('rejects malformed exact target before network and snapshots the validated target/auth', async () => {
  const fetch = vi.fn(async () => response({ uuid: target.databaseId }));
  await expect(
    remote.openRemoteAdminDatabase({ ...target, accountId: '../other-account' }, keyEnv, fetch),
  ).rejects.toThrow('EXACT_REMOTE_TARGET_REQUIRED');
  expect(fetch).not.toHaveBeenCalled();
  const mutable = { ...target };
  const env = { ...keyEnv };
  const replies = preflight();
  const mock = vi.fn(async (url: string, init: RequestInit) => {
    expect(url).not.toContain('mutated');
    expect(init.headers).toMatchObject({ 'X-Auth-Key': keyEnv.CLOUDFLARE_API_KEY });
    mutable.accountId = 'mutated';
    env.CLOUDFLARE_API_KEY = 'mutated';
    return replies.shift() ?? response([{ success: true, results: [] }]);
  });
  const db = await remote.openRemoteAdminDatabase(mutable, env, mock);
  await db.prepare('SELECT 1').run();
});

it('prepare bind first all run preserve result and parameter order; bind does not overwrite siblings', async () => {
  const replies = preflight();
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method === 'GET') return replies.shift()!;
    const body = JSON.parse(init.body as string);
    return response([
      {
        success: true,
        meta: { changes: 0 },
        results: body.params[0] === 0 ? [] : [{ a: body.params[0], b: body.params[1] }],
      },
    ]);
  });
  const db = await remote.openRemoteAdminDatabase(
    target,
    { CLOUDFLARE_API_TOKEN: 'synthetic-token' },
    fetch,
  );
  const stmt = db.prepare('SELECT ? a, ? b');
  const a = stmt.bind(1, 'one');
  const b = stmt.bind(2, 'two');
  expect(await a.first()).toEqual({ a: 1, b: 'one' });
  expect(await b.first('b')).toBe('two');
  expect(await a.all()).toMatchObject({ success: true, results: [{ a: 1, b: 'one' }] });
  expect(await a.run()).toMatchObject({ success: true, meta: { changes: 0 } });
  expect(await stmt.bind(0, null).first()).toBeNull();
  await expect(a.first('absent')).rejects.toThrow('ADMIN_COLUMN_NOT_FOUND');
  expect(fetch.mock.calls.every(([, init]) => !Object.hasOwn(init.headers!, 'X-Auth-Key'))).toBe(
    true,
  );
});

it.each(
  [
    null,
    [],
    [{ success: true, results: [] }],
    [
      { success: true, results: [] },
      { success: false, results: [], error: 'synthetic-key' },
    ],
    [{ success: true, results: [] }, { success: true }],
    [{ success: true, results: [] }, null],
  ].map((result) => ({ result })),
)(
  'rejects malformed/failed/cardinality-mismatched batch without retry (%#)',
  async ({ result }) => {
    const replies = preflight();
    const fetch = vi.fn(async (_url: string, init: RequestInit) =>
      init.method === 'GET' ? replies.shift()! : response(result),
    );
    const db = await remote.openRemoteAdminDatabase(target, keyEnv, fetch);
    await expect(db.batch([db.prepare('SELECT 1'), db.prepare('SELECT 2')])).rejects.toThrow(
      'REMOTE_D1_OPERATION_FAILED',
    );
    expect(fetch).toHaveBeenCalledTimes(3);
  },
);

it('transport exceptions cannot leak secrets and cannot trigger retry/auth fallback', async () => {
  const replies = preflight();
  const fetch = vi.fn(async (_url: string, init: RequestInit) => {
    if (init.method === 'GET') return replies.shift()!;
    throw new Error(JSON.stringify(keyEnv));
  });
  const db = await remote.openRemoteAdminDatabase(target, keyEnv, fetch);
  await expect(db.prepare('SELECT 1').run()).rejects.toThrow(/^REMOTE_ADMIN_REQUEST_FAILED$/);
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('mutation redirect fails once without reading/following Location', async () => {
  const replies = preflight();
  const fetch = vi.fn(async (_url: string, init: RequestInit) =>
    init.method === 'GET'
      ? replies.shift()!
      : new Response(null, { status: 307, headers: { Location: 'https://invalid.example' } }),
  );
  const db = await remote.openRemoteAdminDatabase(target, keyEnv, fetch);
  await expect(db.batch([db.prepare('SELECT 1')])).rejects.toThrow(
    'REMOTE_ADMIN_REDIRECT_REJECTED',
  );
  expect(fetch).toHaveBeenCalledTimes(3);
});

it('does not accept unowned statements, sparse batches or invalid bind values', async () => {
  const replies = preflight();
  const fetch = vi.fn(async () => replies.shift()!);
  const db = await remote.openRemoteAdminDatabase(target, keyEnv, fetch);
  await expect(db.batch([{ sql: 'SELECT 1', params: [] }])).rejects.toThrow('INVALID_ADMIN_BATCH');
  await expect(db.batch(new Array(2))).rejects.toThrow('INVALID_ADMIN_BATCH');
  expect(() => db.prepare('SELECT ?').bind(Infinity)).toThrow('INVALID_ADMIN_BINDING');
  expect(fetch).toHaveBeenCalledTimes(2);
});
