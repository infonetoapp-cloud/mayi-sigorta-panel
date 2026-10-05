// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { createWorker, type Env } from '../src/server';
import type { DocumentJobQueueMessage } from '../src/server/documents/queue';

describe('internal document runtime retirement', () => {
  it('ACKs obsolete scanner deliveries without touching D1, R2 or a scanner', async () => {
    const ack = vi.fn();
    const retry = vi.fn();
    const prepare = vi.fn(() => {
      throw new Error('retired scanner must not read');
    });
    const batch = {
      queue: 'mayisigorta-document-scan',
      messages: [
        {
          body: {
            jobType: 'DOCUMENT_SCAN',
            jobId: 'legacy',
            generation: 1,
            documentVersionId: 'legacy',
            inputSha256: 'a'.repeat(64),
          },
          ack,
          retry,
        },
      ],
    } as unknown as MessageBatch<DocumentJobQueueMessage>;
    await createWorker().queue(batch, {
      DB: { prepare },
      DOCUMENTS_ENABLED: 'true',
    } as unknown as Env);
    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(prepare).not.toHaveBeenCalled();
  });
});
