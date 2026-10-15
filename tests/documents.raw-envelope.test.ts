import { expect, it } from 'vitest';
import { readRawDocumentEnvelope } from '../src/server/documents/raw-envelope';
const metadata = {
  ownerType: 'CUSTOMER',
  ownerId: 'synthetic-parent',
  classification: 'GENERAL',
  fileName: 'belge.png',
  declaredContentType: 'image/png',
  sizeBytes: 20971520,
  expectedSha256: 'a'.repeat(64),
};
function request(value: unknown = metadata, headers: Record<string, string> = {}) {
  return new Request('https://synthetic.invalid', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/octet-stream',
      'X-Document-Metadata': encodeURIComponent(JSON.stringify(value)),
      ...headers,
    },
  });
}
it('accepts an exact-limit strict envelope as claims, not validation', () => {
  const envelope = readRawDocumentEnvelope(request());
  expect(envelope.ownerId).toBe(metadata.ownerId);
  expect(envelope.sizeBytes).toBe(20971520);
  expect(Object.isFrozen(envelope)).toBe(true);
});
it('preserves Unicode filenames without trusting client identity or detected MIME', () => {
  expect(
    readRawDocumentEnvelope(request({ ...metadata, fileName: 'Özel sağlık.png' })).fileName,
  ).toBe('Özel sağlık.png');
  expect(() => readRawDocumentEnvelope(request({ ...metadata, agencyId: 'foreign' }))).toThrow();
  expect(() =>
    readRawDocumentEnvelope(request({ ...metadata, detectedContentType: 'image/png' })),
  ).toThrow();
});
it('rejects oversized claims and noncanonical checksum values before body reading', () => {
  expect(() => readRawDocumentEnvelope(request({ ...metadata, sizeBytes: 20971521 }))).toThrow();
  expect(() =>
    readRawDocumentEnvelope(request({ ...metadata, expectedSha256: 'A'.repeat(64) })),
  ).toThrow();
  expect(() => readRawDocumentEnvelope(request({ ...metadata, sizeBytes: 3.5 }))).toThrow();
});
it('rejects malformed encodings and inconsistent transport length', () => {
  expect(() =>
    readRawDocumentEnvelope(request(metadata, { 'X-Document-Metadata': '%XX' })),
  ).toThrow();
  expect(() => readRawDocumentEnvelope(request(metadata, { 'Content-Length': '1' }))).toThrow();
  expect(() =>
    readRawDocumentEnvelope(request(metadata, { 'X-Document-Metadata': 'x'.repeat(8193) })),
  ).toThrow();
});
it('requires the binary transport and allowlisted declared format', () => {
  expect(() =>
    readRawDocumentEnvelope(request(metadata, { 'Content-Type': 'multipart/form-data' })),
  ).toThrow();
  expect(() =>
    readRawDocumentEnvelope(request({ ...metadata, declaredContentType: 'application/zip' })),
  ).toThrow();
});
