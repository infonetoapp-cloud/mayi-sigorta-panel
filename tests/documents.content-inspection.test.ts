import { describe, expect, it, vi } from 'vitest';
import { decode as decodeJpeg } from 'jpeg-js';
import { preflightDocumentBlob } from '../src/server/documents/validation';
import {
  inspectDocumentContent,
  MAX_DOCUMENT_IMAGE_PIXELS,
  MAX_DOCUMENT_PDF_OBJECTS,
  MAX_DOCUMENT_PDF_PAGES,
} from '../src/server/documents/content-inspection';
import {
  createSyntheticJpeg,
  createSyntheticJpegWithHiddenScans,
  createSyntheticPdf,
  createSyntheticPng,
  createSyntheticPngWithInvalidGrayPalette,
  createSyntheticPngWithPalette,
  createSyntheticPngWithExcessiveDecompressedSize,
  createSyntheticPngWithCompressedAncillaryChunk,
  createSyntheticPngWithManyChunks,
  createSyntheticPngWithUnknownAncillaryChunk,
  createSyntheticPngWithInvalidTime,
  createSyntheticPngWithDuplicateTime,
  createSyntheticPngWithTrailingDeflateBytes,
  createSyntheticPngWithTransparencyAfterIdat,
  createSyntheticPngWithDuplicateTransparency,
  createSyntheticPngWithOutOfRangeTransparencySample,
  createSyntheticPngWithTransparencyBeforePalette,
  createSyntheticPngWithOutOfRangePaletteIndex,
  createSyntheticPdfWithImage,
  createSyntheticPdfWithXrefCommentAmplification,
} from './fixtures/documents';

vi.mock('jpeg-js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('jpeg-js')>();
  return { ...actual, decode: vi.fn(actual.decode) };
});

function withJpegDimensions(
  bytes: Uint8Array,
  width: number,
  height: number,
  frameIndex = 0,
): Uint8Array<ArrayBuffer> {
  const result = Uint8Array.from(bytes);
  let currentFrame = 0;
  for (let offset = 2; offset + 9 < result.length;) {
    if (result[offset] !== 0xff) break;
    while (result[offset] === 0xff) offset += 1;
    const marker = result[offset++]!;
    if (
      [0xd8, 0xd9, 0x01, ...Array.from({ length: 8 }, (_, index) => 0xd0 + index)].includes(marker)
    ) {
      continue;
    }
    const length = (result[offset]! << 8) | result[offset + 1]!;
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
        marker,
      )
    ) {
      if (currentFrame === frameIndex) {
        result[offset + 3] = height >>> 8;
        result[offset + 4] = height & 0xff;
        result[offset + 5] = width >>> 8;
        result[offset + 6] = width & 0xff;
        return result;
      }
      currentFrame += 1;
    }
    if (marker === 0xda || length < 2) break;
    offset += length;
  }
  throw new Error('Synthetic JPEG fixture has no selected frame header');
}

function duplicateJpegSof(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  for (let offset = 2; offset + 9 < bytes.length;) {
    if (bytes[offset] !== 0xff) break;
    while (bytes[offset] === 0xff) offset += 1;
    const markerOffset = offset;
    const marker = bytes[offset++]!;
    if (
      [0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf].includes(
        marker,
      )
    ) {
      const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
      const markerStart = markerOffset - 1;
      const segmentEnd = offset + length;
      const segment = bytes.subarray(markerStart, segmentEnd);
      const result = new Uint8Array(bytes.byteLength + segment.byteLength);
      result.set(bytes.subarray(0, segmentEnd));
      result.set(segment, segmentEnd);
      result.set(bytes.subarray(segmentEnd), segmentEnd + segment.byteLength);
      return result;
    }
    const length = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (marker === 0xda || length < 2) break;
    offset += length;
  }
  throw new Error('Synthetic JPEG fixture has no frame to duplicate');
}

function removeJpegEntropy(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  for (let offset = 2; offset + 3 < bytes.length;) {
    if (bytes[offset] !== 0xff) break;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++]!;
    const segmentLength = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (marker === 0xda) {
      const scanHeaderEnd = offset + segmentLength;
      const malformed = new Uint8Array(scanHeaderEnd + 2);
      malformed.set(bytes.subarray(0, scanHeaderEnd));
      malformed.set([0xff, 0xd9], scanHeaderEnd);
      return malformed;
    }
    if (
      [0xd8, 0xd9, 0x01, ...Array.from({ length: 8 }, (_, index) => 0xd0 + index)].includes(marker)
    ) {
      continue;
    }
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
    offset += segmentLength;
  }
  throw new Error('Synthetic JPEG fixture has no scan header');
}

function withJpegScanComponentCount(bytes: Uint8Array, count: number): Uint8Array<ArrayBuffer> {
  const result = Uint8Array.from(bytes);
  for (let offset = 2; offset + 3 < result.length;) {
    if (result[offset] !== 0xff) break;
    while (result[offset] === 0xff) offset += 1;
    const marker = result[offset++]!;
    const segmentLength = (result[offset]! << 8) | result[offset + 1]!;
    if (marker === 0xda) {
      result[offset + 2] = count;
      return result;
    }
    if (segmentLength < 2 || offset + segmentLength > result.length) break;
    offset += segmentLength;
  }
  throw new Error('Synthetic JPEG fixture has no scan header');
}

function withSecondJpegSoi(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  const result = new Uint8Array(bytes.byteLength + 2);
  result.set(bytes.subarray(0, 2));
  result.set([0xff, 0xd8], 2);
  result.set(bytes.subarray(2), 4);
  return result;
}

function duplicateJpegScan(bytes: Uint8Array): Uint8Array<ArrayBuffer> {
  for (let offset = 2; offset + 3 < bytes.length;) {
    if (bytes[offset] !== 0xff) break;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++]!;
    const segmentLength = (bytes[offset]! << 8) | bytes[offset + 1]!;
    if (marker === 0xda) {
      const segmentEnd = offset + segmentLength;
      const scanHeader = bytes.slice(offset - 2, segmentEnd);
      const insertion = bytes.length - 2;
      const result = new Uint8Array(bytes.length + scanHeader.length);
      result.set(bytes.subarray(0, insertion));
      result.set(scanHeader, insertion);
      result.set(bytes.subarray(insertion), insertion + scanHeader.length);
      return result;
    }
    if (segmentLength < 2 || offset + segmentLength > bytes.length) break;
    offset += segmentLength;
  }
  throw new Error('Synthetic JPEG fixture has no scan header');
}

function withJpegSamplingFactor(
  bytes: Uint8Array,
  componentIndex: number,
  factor: number,
): Uint8Array<ArrayBuffer> {
  const result = Uint8Array.from(bytes);
  const sofMarkers = new Set([
    0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
  ]);
  let offset = 2;
  while (offset + 9 < result.byteLength) {
    if (result[offset] !== 0xff) throw new Error('Synthetic JPEG marker stream is malformed');
    while (result[offset] === 0xff) offset += 1;
    const marker = result[offset++]!;
    if (marker === 0xda || marker === 0xd9) break;
    const length = (result[offset]! << 8) | result[offset + 1]!;
    if (sofMarkers.has(marker)) {
      result[offset + 9 + componentIndex * 3] = factor;
      return result;
    }
    offset += length;
  }
  throw new Error('Synthetic JPEG fixture has no frame segment');
}

function corruptJpegEntropy(bytes: Uint8Array, fill = 0): Uint8Array<ArrayBuffer> {
  const result = Uint8Array.from(bytes);
  let offset = 2;
  while (offset + 9 < result.byteLength) {
    const markerOffset = offset;
    while (result[offset] === 0xff) offset += 1;
    const marker = result[offset++]!;
    if (marker === 0xda) {
      const segmentLength = (result[offset]! << 8) | result[offset + 1]!;
      const entropyStart = offset + segmentLength;
      result.fill(fill, entropyStart, result.byteLength - 2);
      return result;
    }
    if (
      marker === 0xd9 ||
      marker === 0xd8 ||
      marker === 0x01 ||
      (marker >= 0xd0 && marker <= 0xd7)
    ) {
      offset = markerOffset + 2;
      continue;
    }
    const segmentLength = (result[offset]! << 8) | result[offset + 1]!;
    offset += segmentLength;
  }
  throw new Error('Synthetic JPEG fixture has no SOS segment');
}

function withoutJpegTableSegment(
  bytes: Uint8Array,
  markerToRemove: number,
): Uint8Array<ArrayBuffer> {
  const segments: Uint8Array[] = [bytes.slice(0, 2)];
  let offset = 2;
  while (offset + 3 < bytes.length) {
    if (bytes[offset] !== 0xff) break;
    const markerStart = offset;
    while (bytes[offset] === 0xff) offset += 1;
    const marker = bytes[offset++]!;
    if (marker === 0xda || marker === 0xd9) {
      segments.push(bytes.slice(markerStart));
      break;
    }
    const segmentLength = (bytes[offset]! << 8) | bytes[offset + 1]!;
    const segmentEnd = offset + segmentLength;
    if (segmentLength < 2 || segmentEnd > bytes.length) break;
    if (marker !== markerToRemove) segments.push(bytes.slice(markerStart, segmentEnd));
    offset = segmentEnd;
  }
  const size = segments.reduce((total, segment) => total + segment.byteLength, 0);
  const result = new Uint8Array(size);
  let resultOffset = 0;
  for (const segment of segments) {
    result.set(segment, resultOffset);
    resultOffset += segment.byteLength;
  }
  return result;
}

describe('bounded document content inspection', () => {
  it('rejects MIME and extension deception with real PDF, JPEG, and PNG payloads', async () => {
    for (const fixture of [
      { bytes: createSyntheticPdf(), name: 'fixture.pdf', mime: 'application/pdf' },
      { bytes: createSyntheticJpeg(1, 1), name: 'fixture.jpg', mime: 'image/jpeg' },
      { bytes: createSyntheticPng(1, 1), name: 'fixture.png', mime: 'image/png' },
    ]) {
      await expect(
        preflightDocumentBlob(new Blob([fixture.bytes]), {
          fileName: fixture.name,
          declaredContentType: 'application/octet-stream',
        }),
      ).resolves.toMatchObject({ valid: false, reason: 'CONTENT_TYPE_MISMATCH' });
      const wrongName = fixture.mime === 'application/pdf' ? 'fixture.png' : 'fixture.pdf';
      const wrongMime = fixture.mime === 'application/pdf' ? 'image/png' : 'application/pdf';
      await expect(
        preflightDocumentBlob(new Blob([fixture.bytes]), {
          fileName: wrongName,
          declaredContentType: wrongMime,
        }),
      ).resolves.toMatchObject({ valid: false, reason: 'SIGNATURE_MISMATCH' });
    }
  });

  it('parses a real synthetic PDF and reports its page count', async () => {
    await expect(inspectDocumentContent('PDF', createSyntheticPdf())).resolves.toMatchObject({
      valid: true,
      format: 'PDF',
      pageCount: 1,
    });
  });

  it('supports bounded nested PDF page trees and inherited MediaBox values', async () => {
    await expect(
      inspectDocumentContent('PDF', createSyntheticPdf({ nestedPageTree: true })),
    ).resolves.toMatchObject({ valid: true, format: 'PDF', pageCount: 1 });
  });

  it('rejects malformed and password-protected PDFs without accepting them', async () => {
    const malformed = createSyntheticPdf().slice(0, -8);
    await expect(inspectDocumentContent('PDF', malformed)).resolves.toMatchObject({
      valid: false,
      reason: 'MALFORMED_PDF',
    });
    await expect(
      inspectDocumentContent('PDF', createSyntheticPdf({ malformedRoot: true })),
    ).resolves.toMatchObject({ valid: false, reason: 'MALFORMED_PDF' });
    await expect(
      inspectDocumentContent('PDF', createSyntheticPdf({ rootCatalogAsArray: true })),
    ).resolves.toMatchObject({ valid: false, reason: 'MALFORMED_PDF' });
    await expect(
      inspectDocumentContent('PDF', createSyntheticPdf({ malformedRootGeneration: true })),
    ).resolves.toMatchObject({ valid: false, reason: 'MALFORMED_PDF' });
    for (const invalidPageTree of [
      'catalog-pages-reference',
      'dangling-kid',
      'wrong-count',
    ] as const) {
      await expect(
        inspectDocumentContent('PDF', createSyntheticPdf({ invalidPageTree })),
      ).resolves.toMatchObject({ valid: false, reason: 'MALFORMED_PDF' });
    }
    for (const invalidContents of [
      createSyntheticPdf({ invalidResourcesReference: true }),
      createSyntheticPdf({ invalidContentReference: 'missing' }),
      createSyntheticPdf({ invalidContentReference: 'non-stream', extraObjectCount: 1 }),
    ]) {
      await expect(inspectDocumentContent('PDF', invalidContents)).resolves.toMatchObject({
        valid: false,
        reason: 'MALFORMED_PDF',
      });
    }
    await expect(
      inspectDocumentContent('PDF', createSyntheticPdf({ oversizedPageGeometry: true })),
    ).resolves.toMatchObject({ valid: false, reason: 'PDF_PAGE_RESOURCE_LIMIT' });
    await expect(
      inspectDocumentContent('PDF', createSyntheticPdf({ missingMediaBox: true })),
    ).resolves.toMatchObject({ valid: false, reason: 'PDF_PAGE_GEOMETRY_UNAVAILABLE' });
    await expect(
      inspectDocumentContent('PDF', createSyntheticPdf({ largeUserUnit: true })),
    ).resolves.toMatchObject({ valid: false, reason: 'PDF_PAGE_RESOURCE_LIMIT' });
    await expect(
      inspectDocumentContent('PDF', createSyntheticPdf({ invalidTrailerSize: true })),
    ).resolves.toMatchObject({ valid: false, reason: 'MALFORMED_PDF' });
    await expect(
      inspectDocumentContent('PDF', createSyntheticPdf({ rootObjectMissingFromXref: true })),
    ).resolves.toMatchObject({ valid: false, reason: 'MALFORMED_PDF' });
    await expect(
      inspectDocumentContent(
        'PDF',
        createSyntheticPdf({ omitTrailerRoot: true, rootOutsideTrailerDictionary: true }),
      ),
    ).resolves.toMatchObject({ valid: false, reason: 'MALFORMED_PDF' });
    await expect(
      inspectDocumentContent(
        'PDF',
        createSyntheticPdf({ omitTrailerRoot: true, nestedRootOnly: true }),
      ),
    ).resolves.toMatchObject({ valid: false, reason: 'MALFORMED_PDF' });
    await expect(
      inspectDocumentContent('PDF', createSyntheticPdf({ encrypted: true })),
    ).resolves.toMatchObject({
      valid: false,
      reason: 'ENCRYPTED_PDF',
    });
  });

  it('rejects JavaScript actions and page counts above the parser bound', async () => {
    await expect(
      inspectDocumentContent('PDF', createSyntheticPdf({ activeJavaScript: true })),
    ).resolves.toMatchObject({ valid: false, reason: 'PDF_ACTIVE_CONTENT' });
    await expect(
      inspectDocumentContent('PDF', createSyntheticPdf({ pageOpenJavaScript: true })),
    ).resolves.toMatchObject({ valid: false, reason: 'PDF_ACTIVE_CONTENT' });
    await expect(
      inspectDocumentContent('PDF', createSyntheticPdf({ pageOpenLaunch: true })),
    ).resolves.toMatchObject({ valid: false, reason: 'PDF_ACTIVE_CONTENT' });
    await expect(
      inspectDocumentContent('PDF', createSyntheticPdf({ pageCount: MAX_DOCUMENT_PDF_PAGES + 1 })),
    ).resolves.toMatchObject({ valid: false, reason: 'PDF_PAGE_LIMIT' });
  });

  it('rejects external page actions, filtered streams, and excessive PDF objects before decoding', async () => {
    await expect(
      inspectDocumentContent('PDF', createSyntheticPdf({ pageOpenUri: true })),
    ).resolves.toMatchObject({ valid: false, reason: 'PDF_ACTIVE_CONTENT' });
    await expect(
      inspectDocumentContent('PDF', createSyntheticPdf({ pageOpenRichMediaExecute: true })),
    ).resolves.toMatchObject({ valid: false, reason: 'PDF_ACTIVE_CONTENT' });
    await expect(
      inspectDocumentContent('PDF', createSyntheticPdf({ linkedRichMediaExecute: true })),
    ).resolves.toMatchObject({ valid: false, reason: 'PDF_ACTIVE_CONTENT' });
    await expect(
      inspectDocumentContent('PDF', createSyntheticPdf({ linkedGoToAction: true })),
    ).resolves.toMatchObject({ valid: false, reason: 'PDF_ACTIVE_CONTENT' });
    await expect(
      inspectDocumentContent('PDF', createSyntheticPdf({ unclassifiedAction: true })),
    ).resolves.toMatchObject({ valid: false, reason: 'PDF_ACTIVE_CONTENT' });
    await expect(
      inspectDocumentContent('PDF', createSyntheticPdf({ highCompressionStream: true })),
    ).resolves.toMatchObject({ valid: false, reason: 'PDF_UNSUPPORTED_FEATURE' });
    await expect(
      inspectDocumentContent(
        'PDF',
        createSyntheticPdf({ extraObjectCount: MAX_DOCUMENT_PDF_OBJECTS }),
      ),
    ).resolves.toMatchObject({ valid: false, reason: 'PDF_RESOURCE_LIMIT' });
  });

  it('accepts bounded unfiltered page/image streams and rejects excessive embedded image pixels', async () => {
    await expect(
      inspectDocumentContent('PDF', createSyntheticPdfWithImage(4, 3)),
    ).resolves.toMatchObject({
      valid: true,
      format: 'PDF',
      pageCount: 1,
    });
    const oversizedWidth = 4_001;
    const oversizedHeight = Math.floor(MAX_DOCUMENT_IMAGE_PIXELS / oversizedWidth) + 1;
    await expect(
      inspectDocumentContent('PDF', createSyntheticPdfWithImage(oversizedWidth, oversizedHeight)),
    ).resolves.toMatchObject({ valid: false, reason: 'IMAGE_PIXEL_LIMIT' });
    await expect(
      inspectDocumentContent(
        'PDF',
        createSyntheticPdfWithImage(5_000, 4_000, { width: 1, height: 1 }),
      ),
    ).resolves.toMatchObject({ valid: false, reason: 'IMAGE_PIXEL_LIMIT' });
    await expect(
      inspectDocumentContent(
        'PDF',
        createSyntheticPdfWithImage(5_000, 4_000, undefined, { width: 1, height: 1 }),
      ),
    ).resolves.toMatchObject({ valid: false, reason: 'MALFORMED_PDF' });
    await expect(
      inspectDocumentContent('PDF', createSyntheticPdfWithImage(4, 3, undefined, undefined, true)),
    ).resolves.toMatchObject({ valid: false, reason: 'MALFORMED_PDF' });
    await expect(
      inspectDocumentContent(
        'PDF',
        createSyntheticPdfWithImage(2, 1, undefined, undefined, false, false, true),
      ),
    ).resolves.toMatchObject({ valid: false, reason: 'MALFORMED_PDF' });
    await expect(
      inspectDocumentContent(
        'PDF',
        createSyntheticPdfWithImage(7, 1, undefined, undefined, false, true),
      ),
    ).resolves.toMatchObject({ valid: false, reason: 'MALFORMED_PDF' });
  });

  it('rejects xref comment amplification without repeatedly visiting attacker-selected bytes', async () => {
    const bytes = createSyntheticPdfWithXrefCommentAmplification();
    const watchedOffset = 4 * 1024;
    let visits = 0;
    const observed = new Proxy(bytes, {
      get(target, property) {
        if (property === String(watchedOffset)) visits += 1;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await expect(inspectDocumentContent('PDF', observed)).resolves.toMatchObject({
      valid: false,
      reason: 'MALFORMED_PDF',
    });
    expect(visits).toBeLessThanOrEqual(4);
  });

  it('rejects mismatched PDF delimiters and invalid hex strings', async () => {
    for (const catalogEntries of ['/Metadata [ >>', '/Metadata << ]', '/Metadata <zz>']) {
      await expect(
        inspectDocumentContent('PDF', createSyntheticPdf({ catalogEntries })),
      ).resolves.toMatchObject({ valid: false, reason: 'MALFORMED_PDF' });
    }
    await expect(
      inspectDocumentContent('PDF', createSyntheticPdf({ catalogEntries: '/Metadata <aB 3>' })),
    ).resolves.toMatchObject({ valid: true, format: 'PDF', pageCount: 1 });
  });

  it('rejects PDF token floods within the input-byte cap', async () => {
    await expect(
      inspectDocumentContent('PDF', createSyntheticPdf({ extraTokenCount: 65_536 })),
    ).resolves.toMatchObject({ valid: false, reason: 'PDF_RESOURCE_LIMIT' });
  });

  it('parses a synthetic JPEG and enforces its pixel budget from the frame header', async () => {
    await expect(inspectDocumentContent('JPEG', createSyntheticJpeg(2, 1))).resolves.toMatchObject({
      valid: true,
      format: 'JPEG',
      width: 2,
      height: 1,
      pixelCount: 2,
    });
    await expect(
      inspectDocumentContent('JPEG', corruptJpegEntropy(createSyntheticJpeg(2, 1))),
    ).resolves.toMatchObject({ valid: false, reason: 'MALFORMED_JPEG' });
    for (const tableMarker of [0xdb, 0xc4]) {
      await expect(
        inspectDocumentContent(
          'JPEG',
          withoutJpegTableSegment(createSyntheticJpeg(2, 1), tableMarker),
        ),
      ).resolves.toMatchObject({ valid: false, reason: 'MALFORMED_JPEG' });
    }
    const oversizedWidth = 4_001;
    const oversizedHeight = Math.floor(MAX_DOCUMENT_IMAGE_PIXELS / oversizedWidth) + 1;
    const oversized = withJpegDimensions(
      createSyntheticJpeg(1, 1),
      oversizedWidth,
      oversizedHeight,
    );
    await expect(inspectDocumentContent('JPEG', oversized)).resolves.toMatchObject({
      valid: false,
      reason: 'IMAGE_PIXEL_LIMIT',
    });
    await expect(
      inspectDocumentContent('JPEG', withJpegDimensions(createSyntheticJpeg(1, 1), 2_500, 2_000)),
    ).resolves.toMatchObject({ valid: false, reason: 'IMAGE_PIXEL_LIMIT' });
    await expect(
      inspectDocumentContent('JPEG', withJpegSamplingFactor(createSyntheticJpeg(1, 1), 0, 0x01)),
    ).resolves.toMatchObject({ valid: false, reason: 'MALFORMED_JPEG' });
    const excessiveSampling = [0, 1, 2].reduce(
      (jpeg, component) => withJpegSamplingFactor(jpeg, component, 0x44),
      createSyntheticJpeg(1, 1),
    );
    await expect(inspectDocumentContent('JPEG', excessiveSampling)).resolves.toMatchObject({
      valid: false,
      reason: 'MALFORMED_JPEG',
    });
    const conflictingFrames = duplicateJpegSof(createSyntheticJpeg(1, 1));
    await expect(inspectDocumentContent('JPEG', conflictingFrames)).resolves.toMatchObject({
      valid: false,
      reason: 'MALFORMED_JPEG',
    });
    await expect(
      inspectDocumentContent('JPEG', removeJpegEntropy(createSyntheticJpeg(1, 1))),
    ).resolves.toMatchObject({ valid: false, reason: 'MALFORMED_JPEG' });
    await expect(
      inspectDocumentContent('JPEG', withJpegScanComponentCount(createSyntheticJpeg(1, 1), 1)),
    ).resolves.toMatchObject({ valid: false, reason: 'MALFORMED_JPEG' });
    await expect(
      inspectDocumentContent('JPEG', withSecondJpegSoi(createSyntheticJpeg(1, 1))),
    ).resolves.toMatchObject({ valid: false, reason: 'MALFORMED_JPEG' });
    await expect(
      inspectDocumentContent('JPEG', duplicateJpegScan(createSyntheticJpeg(1, 1))),
    ).resolves.toMatchObject({ valid: false, reason: 'MALFORMED_JPEG' });
    await expect(
      inspectDocumentContent('JPEG', createSyntheticJpeg(1, 1).slice(0, -2)),
    ).resolves.toMatchObject({ valid: false, reason: 'MALFORMED_JPEG' });
  });

  it('rejects excessive JPEG dimensions before invoking the synchronous decoder', async () => {
    vi.mocked(decodeJpeg).mockClear();
    await expect(
      inspectDocumentContent('JPEG', withJpegDimensions(createSyntheticJpeg(1, 1), 65_535, 1)),
    ).resolves.toMatchObject({ valid: false, reason: 'IMAGE_PIXEL_LIMIT' });
    expect(decodeJpeg).not.toHaveBeenCalled();
    await expect(
      inspectDocumentContent('JPEG', withJpegDimensions(createSyntheticJpeg(1, 1), 2_500, 2_000)),
    ).resolves.toMatchObject({ valid: false, reason: 'IMAGE_PIXEL_LIMIT' });
    expect(decodeJpeg).not.toHaveBeenCalled();
  });

  it('rejects hidden scans in DRI and DNL segments before invoking the decoder', async () => {
    for (const marker of [0xdd, 0xdc] as const) {
      vi.mocked(decodeJpeg).mockClear();
      await expect(
        inspectDocumentContent('JPEG', createSyntheticJpegWithHiddenScans(marker)),
      ).resolves.toMatchObject({ valid: false });
      expect(decodeJpeg).not.toHaveBeenCalled();
    }
    await expect(
      inspectDocumentContent('JPEG', createSyntheticJpegWithHiddenScans(0xdd, false)),
    ).resolves.toMatchObject({ valid: true, format: 'JPEG', width: 64, height: 64 });
  });

  it('rejects excessive JPEG metadata before invoking the decoder', async () => {
    const jpeg = createSyntheticJpeg(1, 1);
    const comment = new Uint8Array(65_537);
    comment.set([0xff, 0xfe, 0xff, 0xff]);
    const payload = new Uint8Array(jpeg.byteLength + comment.byteLength * 5);
    payload.set(jpeg.subarray(0, 2));
    for (let index = 0; index < 5; index += 1) payload.set(comment, 2 + index * comment.byteLength);
    payload.set(jpeg.subarray(2), 2 + comment.byteLength * 5);
    vi.mocked(decodeJpeg).mockClear();
    await expect(inspectDocumentContent('JPEG', payload)).resolves.toMatchObject({
      valid: false,
      reason: 'JPEG_UNSUPPORTED_FEATURE',
    });
    expect(decodeJpeg).not.toHaveBeenCalled();
  });

  it('validates PNG chunks, CRCs, dimensions, and bounded IDAT inflation', async () => {
    await expect(inspectDocumentContent('PNG', createSyntheticPng(1, 1))).resolves.toMatchObject({
      valid: true,
      format: 'PNG',
      width: 1,
      height: 1,
      pixelCount: 1,
      decompressedBytes: 5,
    });

    await expect(
      inspectDocumentContent(
        'PNG',
        createSyntheticPng(MAX_DOCUMENT_IMAGE_PIXELS + 1, 1, new Uint8Array()),
      ),
    ).resolves.toMatchObject({ valid: false, reason: 'IMAGE_PIXEL_LIMIT' });
    await expect(
      inspectDocumentContent('PNG', createSyntheticPng(1, 1, new Uint8Array(100))),
    ).resolves.toMatchObject({ valid: false, reason: 'PNG_DECOMPRESSION_LIMIT' });
    await expect(
      inspectDocumentContent('PNG', createSyntheticPngWithExcessiveDecompressedSize()),
    ).resolves.toMatchObject({ valid: false, reason: 'PNG_DECOMPRESSION_LIMIT' });
    await expect(
      inspectDocumentContent('PNG', createSyntheticPngWithManyChunks(65_535)),
    ).resolves.toMatchObject({ valid: false, reason: 'PNG_RESOURCE_LIMIT' });
    await expect(
      inspectDocumentContent('PNG', createSyntheticPngWithUnknownAncillaryChunk()),
    ).resolves.toMatchObject({ valid: false, reason: 'PNG_UNSUPPORTED_FEATURE' });
    await expect(
      inspectDocumentContent('PNG', createSyntheticPngWithTrailingDeflateBytes()),
    ).resolves.toMatchObject({ valid: false, reason: 'MALFORMED_PNG' });
    await expect(
      inspectDocumentContent('PNG', createSyntheticPngWithTransparencyAfterIdat()),
    ).resolves.toMatchObject({ valid: false, reason: 'MALFORMED_PNG' });
    await expect(
      inspectDocumentContent('PNG', createSyntheticPngWithDuplicateTransparency()),
    ).resolves.toMatchObject({ valid: false, reason: 'MALFORMED_PNG' });
    await expect(
      inspectDocumentContent('PNG', createSyntheticPngWithInvalidTime()),
    ).resolves.toMatchObject({ valid: false, reason: 'MALFORMED_PNG' });
    await expect(
      inspectDocumentContent('PNG', createSyntheticPngWithDuplicateTime()),
    ).resolves.toMatchObject({ valid: false, reason: 'MALFORMED_PNG' });
    await expect(
      inspectDocumentContent('PNG', createSyntheticPngWithOutOfRangeTransparencySample()),
    ).resolves.toMatchObject({ valid: false, reason: 'MALFORMED_PNG' });
    await expect(
      inspectDocumentContent('PNG', createSyntheticPngWithTransparencyBeforePalette()),
    ).resolves.toMatchObject({ valid: false, reason: 'MALFORMED_PNG' });
    await expect(
      inspectDocumentContent('PNG', createSyntheticPngWithOutOfRangePaletteIndex()),
    ).resolves.toMatchObject({ valid: false, reason: 'MALFORMED_PNG' });
    await expect(
      inspectDocumentContent('PNG', createSyntheticPngWithInvalidGrayPalette()),
    ).resolves.toMatchObject({ valid: false, reason: 'MALFORMED_PNG' });
    await expect(
      inspectDocumentContent('PNG', createSyntheticPngWithPalette(2)),
    ).resolves.toMatchObject({
      valid: true,
      format: 'PNG',
      width: 1,
      height: 1,
    });
    await expect(
      inspectDocumentContent('PNG', createSyntheticPngWithPalette(3)),
    ).resolves.toMatchObject({
      valid: false,
      reason: 'MALFORMED_PNG',
    });

    const badCrc = Uint8Array.from(createSyntheticPng(1, 1));
    badCrc[badCrc.length - 5] = badCrc[badCrc.length - 5]! ^ 0xff;
    await expect(inspectDocumentContent('PNG', badCrc)).resolves.toMatchObject({
      valid: false,
      reason: 'MALFORMED_PNG',
    });
  });

  it('rejects high-expansion PNG data before opening a decompressor', async () => {
    let decompressorStarted = false;
    class TrackingDecompressionStream {
      constructor() {
        decompressorStarted = true;
        throw new Error('Unbounded compressed input must not reach native inflation');
      }
    }
    vi.stubGlobal('DecompressionStream', TrackingDecompressionStream);
    try {
      await expect(
        inspectDocumentContent('PNG', createSyntheticPng(1, 1, new Uint8Array(2 * 1024 * 1024))),
      ).resolves.toMatchObject({ valid: false, reason: 'PNG_DECOMPRESSION_LIMIT' });
      expect(decompressorStarted).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects trailing PNG deflate bytes before opening a decompressor', async () => {
    let decompressorStarted = false;
    class TrackingDecompressionStream {
      readonly readable = new ReadableStream<Uint8Array>();
      readonly writable = new WritableStream<Uint8Array>();

      constructor() {
        decompressorStarted = true;
      }
    }
    vi.stubGlobal('DecompressionStream', TrackingDecompressionStream);
    try {
      await expect(
        inspectDocumentContent('PNG', createSyntheticPngWithTrailingDeflateBytes()),
      ).resolves.toMatchObject({ valid: false, reason: 'MALFORMED_PNG' });
      expect(decompressorStarted).toBe(false);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('cancels PNG decompression after a fail-closed palette error', async () => {
    let readerCanceled = false;
    class ObservedDecompressionStream {
      readonly readable = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(Uint8Array.of(0, 0x80));
        },
        cancel() {
          readerCanceled = true;
        },
      });
      readonly writable = new WritableStream<Uint8Array>();
    }
    vi.stubGlobal('DecompressionStream', ObservedDecompressionStream);
    try {
      await expect(
        inspectDocumentContent('PNG', createSyntheticPngWithPalette(1)),
      ).resolves.toMatchObject({ valid: false, reason: 'MALFORMED_PNG' });
      expect(readerCanceled).toBe(true);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('rejects PNG compressed ancillary and animation streams outside bounded IDAT inspection', async () => {
    for (const type of ['iCCP', 'zTXt', 'iTXt', 'acTL', 'fcTL', 'fdAT'] as const) {
      await expect(
        inspectDocumentContent('PNG', createSyntheticPngWithCompressedAncillaryChunk(type)),
      ).resolves.toMatchObject({ valid: false });
    }
  });
});
