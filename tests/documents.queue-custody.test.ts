// @vitest-environment node
import { expect, it, vi } from 'vitest';
import type { DocumentJobQueueMessage } from '../src/server/documents/queue';
vi.mock('cloudflare:workers', () => ({ DurableObject: class {} }));
it('requires verified permanent custody before invoking any ACK-capable consumer', async () => {
  const { consumeWithDocumentCustody } = await import('../src/server/documents/queue-custody');
  const consume = vi.fn(async () => {}),
    retry = vi.fn(),
    ack = vi.fn();
  const batch = {
    queue: 'mayisigorta-document-jobs-v2',
    messages: [
      {
        id: 'synthetic-message',
        timestamp: new Date(0),
        body: { unexpected: 'synthetic control only' },
        retry,
        ack,
      },
    ],
  } as unknown as MessageBatch;
  await consumeWithDocumentCustody(batch, undefined, consume);
  expect(consume).not.toHaveBeenCalled();
  expect(ack).not.toHaveBeenCalled();
  expect(retry).toHaveBeenCalledOnce();
});
it('production exported queue cannot ACK a malformed body without custody', async () => {
  const { createWorker } = await import('../src/server');
  const ack = vi.fn(),
    retry = vi.fn();
  await createWorker().queue(
    {
      queue: 'mayisigorta-document-jobs-v2',
      messages: [{ id: 'synthetic', timestamp: new Date(0), body: { unknown: true }, ack, retry }],
    } as unknown as MessageBatch<DocumentJobQueueMessage>,
    {
      APP_ENV: 'production',
      DB: {} as D1Database,
      DOCUMENT_JOBS_ENABLED: 'true',
      DOCUMENTS_ENABLED: 'false',
    },
  );
  expect(ack).not.toHaveBeenCalled();
  expect(retry).toHaveBeenCalledOnce();
});
