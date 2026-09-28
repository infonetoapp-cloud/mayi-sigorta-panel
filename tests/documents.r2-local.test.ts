// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';

interface LocalDocumentBindings {
  readonly DOCS_QUARANTINE: R2Bucket;
  readonly DOCUMENT_SCAN_QUEUE: Queue<unknown>;
}

let bucket: R2Bucket | undefined;
let disposePlatform: (() => Promise<void>) | undefined;

beforeAll(async () => {
  const platform = await getPlatformProxy<LocalDocumentBindings>({
    configPath: 'wrangler.jsonc',
    envFiles: [],
    persist: false,
    remoteBindings: false,
  });
  bucket = platform.env.DOCS_QUARANTINE;
  disposePlatform = platform.dispose;
});

afterAll(async () => {
  await disposePlatform?.();
});

describe('local private document R2 binding', () => {
  it('round-trips a quarantined synthetic object through the local emulator', async () => {
    if (!bucket) throw new Error('DOCS_QUARANTINE binding was not initialized');

    const key = 'quarantine/00000000-0000-4000-8000-000000000001';
    const content = Uint8Array.of(0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37);

    try {
      await bucket.put(key, content, {
        httpMetadata: { contentType: 'application/pdf' },
        customMetadata: { sha256: 'synthetic-checksum' },
      });

      const stored = await bucket.get(key);
      expect(stored).not.toBeNull();
      expect([...new Uint8Array(await stored!.arrayBuffer())]).toEqual([...content]);
      expect(stored?.httpMetadata?.contentType).toBe('application/pdf');
      expect(stored?.customMetadata?.sha256).toBe('synthetic-checksum');
    } finally {
      await bucket.delete(key);
    }
  });

  it('accepts a synthetic identifier/checksum envelope through the local queue producer', async () => {
    const platform = await getPlatformProxy<LocalDocumentBindings>({
      configPath: 'wrangler.jsonc',
      envFiles: [],
      persist: false,
      remoteBindings: false,
    });
    try {
      await platform.env.DOCUMENT_SCAN_QUEUE.send({
        jobId: 'job-synthetic-a',
        generation: 1,
        documentVersionId: 'version-synthetic-a',
        sha256: 'a'.repeat(64),
      });
    } finally {
      await platform.dispose();
    }
  });
});
