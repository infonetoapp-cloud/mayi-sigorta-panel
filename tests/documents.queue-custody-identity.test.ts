// @vitest-environment node
import { expect, it, vi } from 'vitest';
import { consumeWithDocumentCustody } from '../src/server/documents/queue-custody';
it.each([undefined, null, 123])(
  'rejects invalid identity %s before all storage and consumer operations',
  async (id) => {
    const put = vi.fn(),
      get = vi.fn(),
      consume = vi.fn(async () => {}),
      retry = vi.fn(),
      ack = vi.fn();
    await consumeWithDocumentCustody(
      {
        queue: 'mayisigorta-document-jobs-v2',
        messages: [{ id, timestamp: new Date(0), body: { synthetic: true }, retry, ack }],
      } as unknown as MessageBatch,
      { put, get } as unknown as R2Bucket,
      consume,
    );
    expect(put).not.toHaveBeenCalled();
    expect(get).not.toHaveBeenCalled();
    expect(consume).not.toHaveBeenCalled();
    expect(ack).not.toHaveBeenCalled();
    expect(retry).toHaveBeenCalledOnce();
  },
);
