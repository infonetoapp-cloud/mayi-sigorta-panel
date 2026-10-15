// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { setTimeout as realDelay } from 'node:timers/promises';
import { createUploadRuntime } from '../src/server/documents/upload-runtime';
import type { Env } from '../src/server/index';
import { app } from '../src/server/index';
const request = () =>
  new Request('https://panel.mayisigorta.com/api/documents', {
    method: 'POST',
    headers: {
      Origin: 'https://panel.mayisigorta.com',
      'Content-Type': 'multipart/form-data; boundary=synthetic',
    },
    body: 'synthetic',
  });
const environment = () =>
  ({
    DOCUMENTS_ENABLED: 'true',
    APP_ENV: 'test',
    PANEL_ORIGIN: 'https://panel.mayisigorta.com',
    DB: undefined as unknown as D1Database,
  }) as Env;
describe('private canonical upload runtime', () => {
  it('does not start canonical or provider work for an already aborted request', async () => {
    const controller = new AbortController();
    controller.abort();
    const canonical = vi.fn(async () => new Response(null, { status: 202 }));
    const runtime = createUploadRuntime(canonical);
    expect(
      (await runtime.fetch(new Request(request(), { signal: controller.signal }), environment()))
        .status,
    ).toBe(503);
    expect(canonical).not.toHaveBeenCalled();
  });
  it('retains a raw R2 put through observed abort and blocks its late finalization', async () => {
    let release!: () => void;
    const late = new Promise<R2Object>((resolve) => {
      release = () => resolve({} as R2Object);
    });
    const put = vi.fn(() => late),
      batch = vi.fn(async () => []);
    const controller = new AbortController();
    let settled!: () => void;
    const completed = new Promise<void>((resolve) => {
      settled = resolve;
    });
    const canonical = vi.fn(async (_: Request, env: Env) => {
      try {
        await env.DOCS_QUARANTINE!.put('synthetic-key', new Uint8Array(1));
        await env.DB.batch([]);
        return new Response(null, { status: 202 });
      } finally {
        settled();
      }
    });
    const runtime = createUploadRuntime(canonical);
    const e = {
      ...environment(),
      DB: { batch } as unknown as D1Database,
      DOCS_QUARANTINE: { put } as unknown as R2Bucket,
    };
    const pending = runtime.fetch(new Request(request(), { signal: controller.signal }), e);
    try {
      expect(put).toHaveBeenCalledTimes(1);
      controller.abort();
      expect((await pending).status).toBe(503);
      expect((await runtime.fetch(request(), e)).status).toBe(503);
      expect(canonical).toHaveBeenCalledTimes(1);
    } finally {
      release();
      await completed;
    }
    await Promise.resolve();
    await Promise.resolve();
    expect(batch).not.toHaveBeenCalled();
    const next = createUploadRuntime(async () => new Response(null, { status: 202 }));
    expect((await next.fetch(request(), environment())).status).toBe(202);
  });
  it('rejects an unauthenticated open JSON stream before the global JSON reader can occupy admission', async () => {
    let close!: () => void;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        close = () => controller.close();
      },
    });
    const req = new Request('https://panel.mayisigorta.com/api/documents', {
      method: 'POST',
      headers: { Origin: 'https://panel.mayisigorta.com', 'Content-Type': 'application/json' },
      body: stream,
      duplex: 'half',
    } as RequestInit);
    const runtime = createUploadRuntime((r, e) => Promise.resolve(app.fetch(r, e)));
    const pending = runtime.fetch(req, { ...environment(), DB: {} as D1Database });
    try {
      expect((await Promise.race([pending, realDelay(30, null)]))?.status).toBe(415);
      expect(req.bodyUsed).toBe(false);
    } finally {
      close();
      await pending;
    }
    const normal = createUploadRuntime(async () => new Response(null, { status: 202 }));
    expect((await normal.fetch(request(), environment())).status).toBe(202);
  });
  it('closes future provider work after a bounded whole-handler timeout without replenishing a late permit', async () => {
    vi.useFakeTimers();
    let resume!: () => void;
    const barrier = new Promise<void>((resolve) => {
      resume = resolve;
    });
    let batches = 0;
    const db = {
      batch: async () => {
        batches++;
        return [];
      },
      prepare: vi.fn(),
    } as unknown as D1Database;
    const canonical = vi.fn(async (_: Request, env: Env) => {
      await barrier;
      await env.DB.batch([]);
      return new Response(null, { status: 202 });
    });
    const runtime = createUploadRuntime(canonical);
    try {
      const pending = runtime.fetch(request(), { ...environment(), DB: db });
      await vi.advanceTimersByTimeAsync(60000);
      const result = await Promise.race([pending, realDelay(20, null)]);
      expect(result?.status).toBe(503);
      expect((await runtime.fetch(request(), environment())).status).toBe(503);
      expect(canonical).toHaveBeenCalledTimes(1);
      resume();
      await vi.runAllTimersAsync();
      expect(batches).toBe(0);
    } finally {
      resume();
      vi.useRealTimers();
    }
  });
  it('does not read the body before canonical processing and preserves the exact request', async () => {
    const req = request();
    const env = environment();
    const canonical = vi.fn(async (received: Request, actual: Env) => {
      expect(received).toBe(req);
      expect(actual).not.toBe(env);
      expect(received.bodyUsed).toBe(false);
      expect(await received.text()).toBe('synthetic');
      return Response.json({ ok: true }, { status: 202 });
    });
    const runtime = createUploadRuntime(canonical);
    expect((await runtime.fetch(req, env)).status).toBe(202);
    expect(canonical).toHaveBeenCalledTimes(1);
  });
  it('rejects overlapping work without waiting or reading the rejected body', async () => {
    let release!: () => void;
    const barrier = new Promise<void>((resolve) => {
      release = resolve;
    });
    const canonical = vi.fn(async () => {
      await barrier;
      return new Response(null, { status: 202 });
    });
    const runtime = createUploadRuntime(canonical);
    const first = runtime.fetch(request(), environment());
    await Promise.resolve();
    try {
      const rejected = request();
      const busy = await runtime.fetch(rejected, environment());
      expect(busy.status).toBe(503);
      expect(busy.headers.get('cache-control')).toContain('private, no-store');
      expect(busy.headers.get('retry-after')).toBe('1');
      expect(rejected.bodyUsed).toBe(false);
      expect(canonical).toHaveBeenCalledTimes(1);
    } finally {
      release();
    }
    expect((await first).status).toBe(202);
    expect((await runtime.fetch(request(), environment())).status).toBe(202);
  });
  it('fails closed before canonical processing for closed flags, siblings, and bad transport', async () => {
    const canonical = vi.fn(async () => new Response(null, { status: 202 }));
    const runtime = createUploadRuntime(canonical);
    for (const [url, method, enabled, expected] of [
      ['https://panel.mayisigorta.com/api/documents', 'POST', 'false', 404],
      ['https://panel.mayisigorta.com/api/documents', 'GET', 'true', 404],
      ['https://panel.mayisigorta.com/api/documents/other', 'POST', 'true', 404],
      ['https://panel.mayisigorta.com/api/%64ocuments', 'POST', 'true', 404],
      ['http://panel.mayisigorta.com/api/documents', 'POST', 'true', 403],
      ['https://other.invalid/api/documents', 'POST', 'true', 403],
    ] as const) {
      const response = await runtime.fetch(new Request(url, { method }), {
        ...environment(),
        DOCUMENTS_ENABLED: enabled,
      });
      expect(response.status).toBe(expected);
      expect(response.headers.get('cache-control')).toContain('private, no-store');
      expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    }
    expect(canonical).not.toHaveBeenCalled();
  });
  it('does not reopen admission while raw late D1 work survives a completed handler', async () => {
    let release!: () => void;
    const late = new Promise<D1Result>((resolve) => {
      release = () => resolve({ success: true } as D1Result);
    });
    const db = { prepare: () => ({ run: () => late }) } as unknown as D1Database;
    const canonical = vi.fn(async (_: Request, env: Env) => {
      void env.DB.prepare('SELECT 1').run();
      return new Response(null, { status: 503 });
    });
    const runtime = createUploadRuntime(canonical);
    await runtime.fetch(request(), { ...environment(), DB: db });
    expect((await runtime.fetch(request(), { ...environment(), DB: db })).status).toBe(503);
    expect(canonical).toHaveBeenCalledTimes(1);
    release();
    await Promise.resolve();
    await Promise.resolve();
    await runtime.fetch(request(), { ...environment(), DB: db });
    expect(canonical).toHaveBeenCalledTimes(2);
  });
});
