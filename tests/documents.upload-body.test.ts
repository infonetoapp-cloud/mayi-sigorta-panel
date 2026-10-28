// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { readDocumentMultipartBody } from '../src/server/documents/upload-body';
it('bounds zero-chunk work and idle streams, cancels without revealing transport messages', async () => {
  const endless = new Request('https://example.test', {
    method: 'POST',
    body: new ReadableStream({
      pull(c) {
        c.enqueue(new Uint8Array(0));
      },
    }),
    duplex: 'half',
  } as RequestInit);
  await expect(readDocumentMultipartBody(endless)).rejects.toMatchObject({ status: 413 });
  vi.useFakeTimers();
  try {
    let cancelled = false;
    const req = new Request('https://example.test', {
      method: 'POST',
      body: new ReadableStream({
        cancel() {
          cancelled = true;
        },
      }),
      duplex: 'half',
    } as RequestInit);
    const p = readDocumentMultipartBody(req);
    const rejected = expect(p).rejects.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(5000);
    await rejected;
    expect(cancelled).toBe(true);
  } finally {
    vi.useRealTimers();
  }
});
