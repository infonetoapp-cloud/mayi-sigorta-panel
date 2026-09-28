import { describe, expect, it } from 'vitest';
import { preflightDocumentUpload } from '../src/server/documents/validation';

function asciiBytes(value: string): Uint8Array {
  return Uint8Array.from(value, (character) => character.charCodeAt(0));
}

const pdfPrefix = asciiBytes('%PDF-1.7\n');
const pdfSuffix = asciiBytes('xref\n%%EOF\n');
const jpegPrefix = Uint8Array.of(0xff, 0xd8, 0xff, 0xe0);
const jpegSuffix = Uint8Array.of(0xff, 0xd9);
const pngPrefix = Uint8Array.of(
  0x89,
  0x50,
  0x4e,
  0x47,
  0x0d,
  0x0a,
  0x1a,
  0x0a,
  0x00,
  0x00,
  0x00,
  0x0d,
  0x49,
  0x48,
  0x44,
  0x52,
  0x00,
  0x00,
  0x00,
  0x01,
  0x00,
  0x00,
  0x00,
  0x01,
  0x08,
  0x06,
  0x00,
  0x00,
  0x00,
);
const pngSuffix = Uint8Array.of(0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44);

const supportedFixtures = [
  {
    fileName: 'sample.pdf',
    declaredContentType: 'application/pdf',
    sizeBytes: 32,
    prefixBytes: pdfPrefix,
    suffixBytes: pdfSuffix,
    format: 'PDF',
    detectedContentType: 'application/pdf',
  },
  {
    fileName: 'sample.jpg',
    declaredContentType: 'image/jpeg',
    sizeBytes: 6,
    prefixBytes: jpegPrefix,
    suffixBytes: jpegSuffix,
    format: 'JPEG',
    detectedContentType: 'image/jpeg',
  },
  {
    fileName: 'sample.png',
    declaredContentType: 'image/png',
    sizeBytes: 41,
    prefixBytes: pngPrefix,
    suffixBytes: pngSuffix,
    format: 'PNG',
    detectedContentType: 'image/png',
  },
] as const;

describe('document upload preflight', () => {
  it.each(supportedFixtures)(
    'recognizes matching $format input but keeps it quarantine-only',
    (fixture) => {
      const result = preflightDocumentUpload(fixture);
      if (!result.valid) throw new Error(`Preflight rejected: ${result.reason}`);

      expect(result).toMatchObject({
        valid: true,
        fileName: fixture.fileName,
        format: fixture.format,
        detectedContentType: fixture.detectedContentType,
        sizeBytes: fixture.sizeBytes,
        disposition: 'QUARANTINE_ONLY',
      });
    },
  );

  it('rejects extension and declared MIME deception against the detected signature', () => {
    expect(
      preflightDocumentUpload({
        ...supportedFixtures[1],
        fileName: 'disguised.pdf',
        declaredContentType: 'application/pdf',
      }),
    ).toMatchObject({ valid: false });
    expect(
      preflightDocumentUpload({
        ...supportedFixtures[1],
        fileName: 'disguised.png',
      }),
    ).toMatchObject({ valid: false });
  });

  it('enforces the exact 20 MiB upload boundary', () => {
    const atLimit = preflightDocumentUpload({
      ...supportedFixtures[0],
      sizeBytes: 20 * 1024 * 1024,
    });
    const overLimit = preflightDocumentUpload({
      ...supportedFixtures[0],
      sizeBytes: 20 * 1024 * 1024 + 1,
    });

    if (!atLimit.valid) throw new Error(`Preflight rejected: ${atLimit.reason}`);
    expect(atLimit).toMatchObject({ valid: true, sizeBytes: 20 * 1024 * 1024 });
    expect(overLimit).toMatchObject({ valid: false, reason: 'SIZE_LIMIT' });
  });

  it('sanitizes a client filename to the D1-safe leaf name', () => {
    const result = preflightDocumentUpload({
      ...supportedFixtures[0],
      fileName: `..\\secret\t'".PDF`,
    });

    if (!result.valid) throw new Error(`Preflight rejected: ${result.reason}`);
    expect(result).toMatchObject({ valid: true, fileName: 'secret___.pdf' });
    if (result.valid) {
      for (const forbidden of [
        '/',
        '\\',
        '\u0000',
        '\u001f',
        '\u007f',
        '\u009f',
        '"',
        "'",
        ';',
        '..',
      ]) {
        expect(result.fileName).not.toContain(forbidden);
      }
    }
  });
});
