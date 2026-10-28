// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { consumeWithDocumentCustody } from '../src/server/documents/queue-custody';
it('rejects array accessors without invoking them', async () => {
  const getter = vi.fn(() => 'synthetic');
  const body: unknown[] = [];
  Object.defineProperty(body, '0', { get: getter, enumerable: true });
  const retry = vi.fn(),
    consume = vi.fn(async () => {}),
    put = vi.fn();
  await consumeWithDocumentCustody(
    {
      queue: 'mayisigorta-document-jobs-v2',
      messages: [{ id: 'synthetic', timestamp: new Date(0), body, retry }],
    } as unknown as MessageBatch,
    { put, get: vi.fn() } as unknown as R2Bucket,
    consume,
  );
  expect(getter).not.toHaveBeenCalled();
  expect(put).not.toHaveBeenCalled();
  expect(consume).not.toHaveBeenCalled();
  expect(retry).toHaveBeenCalledOnce();
});
it('archives full JSON before ACK and rejects conflicting replay', async () => {
  const saved = new Map<string, Uint8Array>();
  const storage = {
    put: vi.fn(async (key: string, body: Uint8Array, options: R2PutOptions) => {
      expect(options.onlyIf).toEqual({ etagDoesNotMatch: '*' });
      if (!saved.has(key)) saved.set(key, body.slice());
      return null;
    }),
    get: vi.fn(async (key: string) => {
      const bytes = saved.get(key);
      return bytes
        ? { size: bytes.byteLength, text: async () => new TextDecoder().decode(bytes) }
        : null;
    }),
  } as unknown as Pick<R2Bucket, 'put' | 'get'>;
  const body = { unexpected: { all: ['values', null, 1, false] }, opaque: 'synthetic only' };
  const ack = vi.fn(),
    retry = vi.fn(),
    message = { id: 'synthetic-message', timestamp: new Date(0), body, ack, retry };
  const batch = {
    queue: 'mayisigorta-document-jobs-v2',
    messages: [message],
  } as unknown as MessageBatch;
  const consume = vi.fn(async () => {
    expect(saved.size).toBe(1);
    ack();
  });
  await consumeWithDocumentCustody(batch, storage, consume);
  expect(ack).toHaveBeenCalledOnce();
  expect(retry).not.toHaveBeenCalled();
  expect(JSON.parse(new TextDecoder().decode([...saved.values()][0]!)).body).toEqual(body);
  await consumeWithDocumentCustody(batch, storage, consume);
  expect(ack).toHaveBeenCalledTimes(2);
  expect(saved.size).toBe(1);
  message.body = { ...body, opaque: 'changed' };
  await consumeWithDocumentCustody(batch, storage, consume);
  expect(ack).toHaveBeenCalledTimes(2);
  expect(retry).toHaveBeenCalledOnce();
});
it.each([undefined, NaN, Infinity, -0, 1n, new Date(0), new Map(), new Uint8Array(1)])(
  'rejects unsupported body without lossy custody (%s)',
  async (body) => {
    const consume = vi.fn(async () => {}),
      put = vi.fn(),
      retry = vi.fn();
    await consumeWithDocumentCustody(
      {
        queue: 'mayisigorta-document-jobs-v2',
        messages: [{ id: 'synthetic', timestamp: new Date(0), body, retry }],
      } as unknown as MessageBatch,
      { put, get: vi.fn() } as unknown as R2Bucket,
      consume,
    );
    expect(consume).not.toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledOnce();
  },
);
