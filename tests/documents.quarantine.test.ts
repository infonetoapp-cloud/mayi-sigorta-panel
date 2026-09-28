// @vitest-environment node

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { getPlatformProxy } from 'wrangler';
import { storeQuarantinedDocumentObject } from '../src/server/documents/quarantine';

interface LocalDocumentBindings {
  readonly DOCS_QUARANTINE: R2Bucket;
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

function asciiBytes(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

function blobFromBytes(bytes: Uint8Array, type: string): Blob {
  const arrayBuffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(arrayBuffer).set(bytes);
  return new Blob([arrayBuffer], { type });
}

function makePdfUpload() {
  const bytes = asciiBytes('%PDF-1.7\n1 0 obj\n<<>>\nendobj\n%%EOF\n');
  const file = blobFromBytes(bytes, 'application/pdf');
  return { bytes, file };
}

describe('document quarantine object storage', () => {
  it('writes an exact-checksum, private-shaped R2 quarantine object and never returns AVAILABLE', async () => {
    if (!bucket) throw new Error('DOCS_QUARANTINE binding was not initialized');
    const { bytes, file } = makePdfUpload();
    const stored = await storeQuarantinedDocumentObject(bucket, file, {
      fileName: 'synthetic.pdf',
      declaredContentType: 'application/pdf',
    });
    const keyMatches =
      /^quarantine\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
        stored.objectKey,
      );

    try {
      const object = await bucket.get(stored.objectKey);
      expect(keyMatches).toBe(true);
      expect(stored.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(stored.sizeBytes).toBe(bytes.byteLength);
      expect(object).not.toBeNull();
      expect([...new Uint8Array(await object!.arrayBuffer())]).toEqual([...bytes]);
      expect(object?.httpMetadata?.contentType).toBe('application/pdf');
      expect(object?.customMetadata?.sha256).toBe(stored.sha256);
      expect(stored.fileName).toBe('synthetic.pdf');
      expect(stored.disposition).toBe('QUARANTINE_ONLY');
    } finally {
      await bucket.delete(stored.objectKey);
    }
  });

  it('rejects MIME/signature mismatch before any R2 write', async () => {
    if (!bucket) throw new Error('DOCS_QUARANTINE binding was not initialized');
    await expect(
      storeQuarantinedDocumentObject(
        bucket,
        blobFromBytes(asciiBytes('plain text'), 'text/plain'),
        { fileName: 'synthetic.pdf', declaredContentType: 'application/pdf' },
      ),
    ).rejects.toMatchObject({ code: 'PREFLIGHT_REJECTED' });
    expect(await bucket.list({ prefix: 'quarantine/' })).toMatchObject({ objects: [] });
  });
});
