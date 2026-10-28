// @vitest-environment node
import { expect, it } from 'vitest';
import { createRawEnvelopeInspection } from '../src/server/documents/raw-envelope-inspection';
import { createSyntheticPng, createSyntheticPdf } from './fixtures/documents';
async function inspect(
  bytes: Uint8Array,
  split: number,
  fileName = 'test.png',
  declaredContentType = 'image/png',
) {
  const observer = createRawEnvelopeInspection({
    fileName,
    declaredContentType,
    sizeBytes: bytes.length,
  });
  const writer = observer.stream.writable.getWriter();
  const drained = new Response(observer.stream.readable).arrayBuffer();
  void drained.catch(() => undefined);
  for (let offset = 0; offset < bytes.length; offset += split)
    await writer.write(bytes.subarray(offset, offset + split));
  await writer.close();
  return { result: observer.result(), forwarded: new Uint8Array(await drained) };
}
it('forwards exact bytes while retaining only bounded envelope inspection', async () => {
  const bytes = createSyntheticPng(1, 1);
  const actual = await inspect(bytes, 7);
  expect(actual.result).toMatchObject({
    valid: true,
    format: 'PNG',
    disposition: 'QUARANTINE_ONLY',
  });
  expect(actual.forwarded).toEqual(bytes);
});
it('handles prefix and EOF split across single-byte PDF chunks', async () => {
  const bytes = createSyntheticPdf();
  expect((await inspect(bytes, 1, 'test.pdf', 'application/pdf')).result).toMatchObject({
    valid: true,
    format: 'PDF',
  });
});
it('does not publish an inspection result before complete input', () => {
  const observer = createRawEnvelopeInspection({
    fileName: 'test.png',
    declaredContentType: 'image/png',
    sizeBytes: 50,
  });
  expect(observer.result()).toBeNull();
});
it('does not trust the extension or declared MIME without actual signature bytes', async () => {
  expect((await inspect(new Uint8Array(50), 50)).result).toMatchObject({
    valid: false,
    reason: 'SIGNATURE_MISMATCH',
  });
});
