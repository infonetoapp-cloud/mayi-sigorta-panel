// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { classifyTransport, runTransportDiagnostic } from '../src/server/d1-backup/diagnostic';
vi.mock('cloudflare:workers', () => ({ WorkflowEntrypoint: class {} }));
import { D1BackupWorkflow } from '../src/server/d1-backup/worker';
it('explicit diagnostic Workflow mode cannot read R2 or run backup', async () => {
  const workflow = new D1BackupWorkflow(null as never, {} as never);
  Object.assign(workflow, {
    env: {
      CLOUDFLARE_EMAIL: 'synthetic@example.invalid',
      CLOUDFLARE_API_KEY: 'synthetic',
      get RECOVERY() {
        throw new Error('R2 forbidden');
      },
    },
  });
  const network = vi.fn(async () => {
    throw new TypeError('Illegal invocation');
  });
  vi.stubGlobal('fetch', network);
  try {
    const result = await workflow.run(
      { payload: { mode: 'transport-diagnostic' } } as never,
      {
        do: async (_name: string, _options: unknown, callback: () => Promise<unknown>) =>
          callback(),
      } as never,
    );
    expect(result).toHaveProperty('A');
    expect(network).toHaveBeenCalledOnce();
  } finally {
    vi.unstubAllGlobals();
  }
});
it.each([' synthetic', 'synthetic\r', 'synthetic\n', 'synthetic\x00'])(
  'invalid secret shape stops all fetch %j',
  async (key) => {
    const fetcher = vi.fn();
    const r = await runTransportDiagnostic(
      { CLOUDFLARE_EMAIL: 'synthetic@example.invalid', CLOUDFLARE_API_KEY: key },
      fetcher as typeof fetch,
    );
    expect(r.A.shapeValid).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    expect(JSON.stringify(r)).not.toContain('synthetic');
  },
);
it('B public/no auth, C GET legacy auth, nonexistent fake verified before only fake export POST', async () => {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  const fetcher = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    return Response.json(
      {
        success: !url.includes('00000000'),
        errors: url.includes('00000000') ? [{ code: 7500, message: 'secret URL' }] : [],
      },
      { status: url.includes('00000000') ? 404 : 200 },
    );
  };
  const r = await runTransportDiagnostic(
    { CLOUDFLARE_EMAIL: 'synthetic@example.invalid', CLOUDFLARE_API_KEY: 'synthetic' },
    fetcher as typeof fetch,
  );
  expect(calls).toHaveLength(4);
  expect(new Headers(calls[0]!.init?.headers).has('X-Auth-Key')).toBe(false);
  expect(calls[1]!.init?.method).toBe('GET');
  expect(new Headers(calls[1]!.init?.headers).get('X-Auth-Key')).toBe('synthetic');
  expect(new Headers(calls[1]!.init?.headers).has('Authorization')).toBe(false);
  expect(calls[2]!.url).toContain('00000000-0000-0000-0000-000000000000');
  expect(calls[3]!.url).toContain('00000000-0000-0000-0000-000000000000/export');
  expect(calls[3]!.init?.method).toBe('POST');
  expect(calls.every((c) => c.init?.redirect === 'manual')).toBe(true);
  expect(JSON.stringify(r)).not.toContain('secret URL');
  expect(r.D?.errorCodes).toEqual([7500]);
});
it('fake ID unproven existence never POSTs', async () => {
  const network = vi.fn(async () => Response.json({ success: true }));
  const r = await runTransportDiagnostic(
    { CLOUDFLARE_EMAIL: 'synthetic@example.invalid', CLOUDFLARE_API_KEY: 'synthetic' },
    network as typeof fetch,
  );
  expect(network).toHaveBeenCalledTimes(3);
  expect(r.D).toBeUndefined();
});
it.each([
  'Invalid header',
  'connection lost',
  'fetch failed',
  'TLS certificate',
  'redirect runtime',
  'random secret https://signed.invalid',
])('exception allowlist safe %s', (message) => {
  expect(JSON.stringify(classifyTransport(new Error(message)))).not.toContain(message);
});
it('safe exception name/class only, no raw URL/key', () => {
  const r = classifyTransport(new TypeError('Illegal invocation secret https://signed.invalid'));
  expect(r).toEqual({ errorName: 'TypeError', transportClass: 'request-context' });
  expect(JSON.stringify(r)).not.toContain('secret');
});
it('diagnostic B failure stops C/D and never touches R2', async () => {
  const network = vi.fn(async () => {
    throw new TypeError('Illegal invocation secret');
  });
  const result = await runTransportDiagnostic(
    { CLOUDFLARE_EMAIL: 'synthetic@example.invalid', CLOUDFLARE_API_KEY: 'synthetic' },
    network as typeof fetch,
  );
  expect(network).toHaveBeenCalledOnce();
  expect(network.mock.calls[0]).toBeDefined();
  expect(result.B?.responseObtained).toBe(false);
  expect(result.C).toBeUndefined();
});
