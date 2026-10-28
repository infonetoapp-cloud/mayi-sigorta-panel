// @vitest-environment node
import { expect, it, vi } from 'vitest';
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
import worker from '../src/server/worker';
import type { Env } from '../src/server/index';
const ctx = {} as ExecutionContext;
const env = () =>
  ({
    DOCUMENTS_ENABLED: 'true',
    APP_ENV: 'test',
    PANEL_ORIGIN: 'https://panel.mayisigorta.com',
    DB: undefined as unknown as D1Database,
    AUTH_SOURCE_RATE_LIMITER: { limit: async () => ({ success: true }) },
  }) as Env;
it('routes only exact enabled uploads through a fixed private object without reading the body', async () => {
  const fetch = vi.fn(async (request: Request) => {
    expect(request.bodyUsed).toBe(false);
    expect(request.headers.get('Idempotency-Key')).toBe('synthetic-operation');
    return new Response(null, { status: 202 });
  });
  const getByName = vi.fn(() => ({ fetch }));
  const e = { ...env(), DOCUMENT_UPLOAD_RUNTIME: { getByName } } as unknown as Env;
  const request = new Request('https://panel.mayisigorta.com/api/documents', {
    method: 'POST',
    body: 'synthetic',
    headers: { 'Idempotency-Key': 'synthetic-operation' },
  });
  expect((await worker.fetch(request, e, ctx)).status).toBe(202);
  expect(getByName).toHaveBeenCalledExactlyOnceWith('mayi-document-upload-v1');
  expect(fetch).toHaveBeenCalledExactlyOnceWith(request);
});
it('never falls back to synchronous HTTP upload when the runtime binding is absent or fails', async () => {
  const req = () => new Request('https://panel.mayisigorta.com/api/documents', { method: 'POST' });
  expect((await worker.fetch(req(), env(), ctx)).status).toBe(503);
  const e = {
    ...env(),
    DOCUMENT_UPLOAD_RUNTIME: {
      getByName: () => {
        throw new Error('synthetic dependency fault');
      },
    },
  } as unknown as Env;
  expect((await worker.fetch(req(), e, ctx)).status).toBe(503);
});
it('limits unauthenticated dispatch before contacting the object', async () => {
  const getByName = vi.fn();
  const e = {
    ...env(),
    AUTH_SOURCE_RATE_LIMITER: { limit: async () => ({ success: false }) },
    DOCUMENT_UPLOAD_RUNTIME: { getByName },
  } as unknown as Env;
  const response = await worker.fetch(
    new Request('https://panel.mayisigorta.com/api/documents', { method: 'POST' }),
    e,
    ctx,
  );
  expect(response.status).toBe(429);
  expect(getByName).not.toHaveBeenCalled();
});
it('does not dispatch closed uploads, sibling routes, encoded aliases or incorrect transport', async () => {
  const getByName = vi.fn(() => {
    throw new Error('MUST_NOT_DISPATCH');
  });
  for (const [url, method, enabled, expected] of [
    ['https://panel.mayisigorta.com/api/documents', 'POST', 'false', 404],
    ['https://panel.mayisigorta.com/api/documents/other', 'POST', 'true', 404],
    ['https://panel.mayisigorta.com/api/%64ocuments', 'POST', 'true', 404],
    ['http://panel.mayisigorta.com/api/documents', 'POST', 'true', 403],
    ['https://other.invalid/api/documents', 'POST', 'true', 403],
  ] as const) {
    const e = {
      ...env(),
      DOCUMENTS_ENABLED: enabled,
      DOCUMENT_UPLOAD_RUNTIME: { getByName },
    } as unknown as Env;
    const response = await worker.fetch(
      new Request(url, { method, headers: { Origin: 'https://panel.mayisigorta.com' } }),
      e,
      ctx,
    );
    expect(response.status).toBe(expected);
  }
  expect(getByName).not.toHaveBeenCalled();
});
