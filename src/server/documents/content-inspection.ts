import { decode as decodeJpeg } from 'jpeg-js';
import { validatePngZlibStream } from './png-deflate';
import { MAX_DOCUMENT_UPLOAD_BYTES, type DocumentUploadFormat } from './validation';

export const MAX_DOCUMENT_IMAGE_PIXELS = 16_000_000;
export const MAX_DOCUMENT_JPEG_PIXELS = 4_000_000;
export const MAX_DOCUMENT_JPEG_SIDE = 8_192;
export const MAX_DOCUMENT_PDF_PAGES = 200;
export const MAX_DOCUMENT_PDF_OBJECTS = 4_096;
export const MAX_DOCUMENT_PDF_PAGE_SIDE_POINTS = 4_000;
export const MAX_DOCUMENT_PDF_PAGE_AREA_POINTS = 16_000_000;
export const MAX_DOCUMENT_PNG_DECOMPRESSED_BYTES = 32 * 1024 * 1024;
const MAX_DOCUMENT_PNG_CHUNKS = 65_536;
const PNG_UNSUPPORTED_CHUNKS = new Set(['iCCP', 'zTXt', 'iTXt', 'acTL', 'fcTL', 'fdAT']);
const PNG_SUPPORTED_CHUNKS = new Set(['IHDR', 'PLTE', 'IDAT', 'IEND', 'tRNS', 'tEXt', 'tIME']);
export const REQUIRED_CONTENT_INSPECTION_VERSION = 'm4-content-inspection-v1';

export type DocumentContentInspectionFailure =
  | 'MALFORMED_PDF'
  | 'ENCRYPTED_PDF'
  | 'PDF_ACTIVE_CONTENT'
  | 'PDF_PAGE_LIMIT'
  | 'PDF_PAGE_RESOURCE_LIMIT'
  | 'PDF_PAGE_GEOMETRY_UNAVAILABLE'
  | 'PDF_RESOURCE_LIMIT'
  | 'PDF_UNSUPPORTED_FEATURE'
  | 'IMAGE_DIMENSIONS_UNAVAILABLE'
  | 'MALFORMED_JPEG'
  | 'JPEG_UNSUPPORTED_FEATURE'
  | 'MALFORMED_PNG'
  | 'IMAGE_PIXEL_LIMIT'
  | 'PNG_DECOMPRESSION_LIMIT'
  | 'PNG_RESOURCE_LIMIT'
  | 'PNG_UNSUPPORTED_FEATURE';

export type DocumentContentInspectionResult =
  | {
      readonly valid: true;
      readonly format: 'PDF';
      readonly pageCount: number;
    }
  | {
      readonly valid: true;
      readonly format: 'JPEG' | 'PNG';
      readonly width: number;
      readonly height: number;
      readonly pixelCount: number;
      readonly decompressedBytes?: number;
    }
  | {
      readonly valid: false;
      readonly reason: DocumentContentInspectionFailure;
    };

type PngPass = {
  readonly width: number;
  readonly rowBytes: number;
  readonly rows: number;
};

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] as const;
const JPEG_SOF_MARKERS = new Set([
  0xc0, 0xc1, 0xc2, 0xc3, 0xc5, 0xc6, 0xc7, 0xc9, 0xca, 0xcb, 0xcd, 0xce, 0xcf,
]);
const JPEG_RESTART_MARKERS = new Set([0xd0, 0xd1, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7]);
const MAX_JPEG_HEADER_BYTES = 256 * 1024;
const MAX_JPEG_SEGMENTS = 1_024;
const PNG_CHANNELS: Readonly<Record<number, number>> = {
  0: 1,
  2: 3,
  3: 1,
  4: 2,
  6: 4,
};
const PNG_BIT_DEPTHS: Readonly<Record<number, readonly number[]>> = {
  0: [1, 2, 4, 8, 16],
  2: [8, 16],
  3: [1, 2, 4, 8],
  4: [8, 16],
  6: [8, 16],
};
const ADAM7_PASSES = [
  [0, 0, 8, 8],
  [4, 0, 8, 8],
  [0, 4, 4, 8],
  [2, 0, 4, 4],
  [0, 2, 2, 4],
  [1, 0, 2, 2],
  [0, 1, 1, 2],
] as const;
const CRC_TABLE = createCrcTable();

function invalid(reason: DocumentContentInspectionFailure): DocumentContentInspectionResult {
  return { valid: false, reason };
}

function hasBytesAt(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  return (
    offset >= 0 &&
    bytes.byteLength >= offset + expected.length &&
    expected.every((value, index) => bytes[offset + index] === value)
  );
}

function readUint16(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readUint32(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 +
    bytes[offset + 1]! * 0x10000 +
    bytes[offset + 2]! * 0x100 +
    bytes[offset + 3]!
  );
}

async function inspectJpeg(bytes: Uint8Array): Promise<DocumentContentInspectionResult> {
  if (bytes.byteLength < 4 || !hasBytesAt(bytes, 0, [0xff, 0xd8])) return invalid('MALFORMED_JPEG');
  let offset = 2;
  let frame:
    | {
        readonly width: number;
        readonly height: number;
        readonly componentCount: number;
        readonly componentIds: readonly number[];
        readonly quantizationTableIds: ReadonlyMap<number, number>;
      }
    | undefined;
  const quantizationTables = new Set<number>();
  const dcHuffmanTables = new Set<number>();
  const acHuffmanTables = new Set<number>();
  let sawScan = false;
  let sawEnd = false;
  let entropyBytes = 0;
  let headerBytes = 0;
  let segmentCount = 0;

  while (offset < bytes.byteLength) {
    if (bytes[offset] !== 0xff) return invalid('MALFORMED_JPEG');
    while (bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.byteLength) return invalid('MALFORMED_JPEG');
    const marker = bytes[offset++]!;

    if (marker === 0xd9) {
      sawEnd = true;
      break;
    }
    if (marker === 0xd8) return invalid('MALFORMED_JPEG');
    if (marker === 0x01 || marker === 0xdc) return invalid('JPEG_UNSUPPORTED_FEATURE');
    if (JPEG_RESTART_MARKERS.has(marker)) return invalid('MALFORMED_JPEG');
    if (
      marker !== 0xdb &&
      marker !== 0xc4 &&
      marker !== 0xda &&
      marker !== 0xdd &&
      !JPEG_SOF_MARKERS.has(marker) &&
      !(marker >= 0xe0 && marker <= 0xef) &&
      marker !== 0xfe
    )
      return invalid('JPEG_UNSUPPORTED_FEATURE');
    if (offset + 2 > bytes.byteLength) return invalid('MALFORMED_JPEG');

    const segmentLength = readUint16(bytes, offset);
    if (segmentLength < 2 || offset + segmentLength > bytes.byteLength) {
      return invalid('MALFORMED_JPEG');
    }
    // jpeg-js consumes exactly two DRI data bytes, regardless of its declared length.
    // Enforce the same boundary so hidden SOS segments cannot evade the one-scan preflight.
    if (marker === 0xdd && segmentLength !== 4) return invalid('MALFORMED_JPEG');
    headerBytes += segmentLength + 2;
    segmentCount += 1;
    if (headerBytes > MAX_JPEG_HEADER_BYTES || segmentCount > MAX_JPEG_SEGMENTS) {
      return invalid('JPEG_UNSUPPORTED_FEATURE');
    }
    if (marker === 0xdb) {
      const tableEnd = offset + segmentLength;
      let tableOffset = offset + 2;
      while (tableOffset < tableEnd) {
        const tableInfo = bytes[tableOffset++]!;
        const precision = tableInfo >>> 4;
        const tableId = tableInfo & 0x0f;
        if (precision !== 0 || tableId > 3 || tableOffset + 64 > tableEnd) {
          return invalid('JPEG_UNSUPPORTED_FEATURE');
        }
        for (let valueIndex = 0; valueIndex < 64; valueIndex += 1) {
          if (bytes[tableOffset + valueIndex] === 0) return invalid('MALFORMED_JPEG');
        }
        quantizationTables.add(tableId);
        tableOffset += 64;
      }
      if (tableOffset !== tableEnd) return invalid('MALFORMED_JPEG');
      offset += segmentLength;
      continue;
    }
    if (marker === 0xc4) {
      const tableEnd = offset + segmentLength;
      let tableOffset = offset + 2;
      while (tableOffset < tableEnd) {
        if (tableOffset + 17 > tableEnd) return invalid('MALFORMED_JPEG');
        const tableInfo = bytes[tableOffset++]!;
        const tableClass = tableInfo >>> 4;
        const tableId = tableInfo & 0x0f;
        if (tableClass > 1 || tableId > 3) return invalid('MALFORMED_JPEG');
        let symbolCount = 0;
        let availableCodes = 1;
        for (let codeLength = 0; codeLength < 16; codeLength += 1) {
          const count = bytes[tableOffset++]!;
          symbolCount += count;
          availableCodes = availableCodes * 2 - count;
          if (availableCodes < 0) return invalid('MALFORMED_JPEG');
        }
        if (symbolCount < 1 || symbolCount > 256 || tableOffset + symbolCount > tableEnd) {
          return invalid('MALFORMED_JPEG');
        }
        if (tableClass === 0) dcHuffmanTables.add(tableId);
        else acHuffmanTables.add(tableId);
        tableOffset += symbolCount;
      }
      if (tableOffset !== tableEnd) return invalid('MALFORMED_JPEG');
      offset += segmentLength;
      continue;
    }
    if (JPEG_SOF_MARKERS.has(marker)) {
      if (frame || segmentLength < 8) return invalid('MALFORMED_JPEG');
      if (marker !== 0xc0) return invalid('JPEG_UNSUPPORTED_FEATURE');
      if (bytes[offset + 2] !== 8) return invalid('JPEG_UNSUPPORTED_FEATURE');
      const componentCount = bytes[offset + 7]!;
      if (componentCount < 1 || segmentLength !== 8 + 3 * componentCount) {
        return invalid('MALFORMED_JPEG');
      }
      const componentIds: number[] = [];
      const quantizationTableIds = new Map<number, number>();
      let totalSamplingBlocks = 0;
      for (let index = 0; index < componentCount; index += 1) {
        const componentId = bytes[offset + 8 + index * 3]!;
        const samplingFactor = bytes[offset + 9 + index * 3]!;
        const horizontalSampling = samplingFactor >>> 4;
        const verticalSampling = samplingFactor & 0x0f;
        const quantizationTableId = bytes[offset + 10 + index * 3]!;
        if (
          componentIds.includes(componentId) ||
          horizontalSampling < 1 ||
          horizontalSampling > 4 ||
          verticalSampling < 1 ||
          verticalSampling > 4 ||
          quantizationTableId > 3
        ) {
          return invalid('MALFORMED_JPEG');
        }
        totalSamplingBlocks += horizontalSampling * verticalSampling;
        if (totalSamplingBlocks > 10) return invalid('MALFORMED_JPEG');
        componentIds.push(componentId);
        quantizationTableIds.set(componentId, quantizationTableId);
      }
      const height = readUint16(bytes, offset + 3);
      const width = readUint16(bytes, offset + 5);
      const pixelCount = width * height;
      if (width === 0 || height === 0) return invalid('MALFORMED_JPEG');
      if (
        width > MAX_DOCUMENT_JPEG_SIDE ||
        height > MAX_DOCUMENT_JPEG_SIDE ||
        pixelCount > MAX_DOCUMENT_JPEG_PIXELS
      )
        return invalid('IMAGE_PIXEL_LIMIT');
      frame = { width, height, componentCount, componentIds, quantizationTableIds };
    }
    if (marker === 0xda) {
      if (!frame || sawScan || segmentLength < 6) return invalid('MALFORMED_JPEG');
      const scanComponentCount = bytes[offset + 2]!;
      if (
        scanComponentCount !== frame.componentCount ||
        segmentLength !== 6 + 2 * scanComponentCount
      ) {
        return invalid('MALFORMED_JPEG');
      }
      const scanComponentIds = new Set<number>();
      for (let index = 0; index < scanComponentCount; index += 1) {
        const componentId = bytes[offset + 3 + index * 2]!;
        const tableSelectors = bytes[offset + 4 + index * 2]!;
        const quantizationTableId = frame.quantizationTableIds.get(componentId);
        const dcHuffmanTableId = tableSelectors >>> 4;
        const acHuffmanTableId = tableSelectors & 0x0f;
        if (
          !frame.componentIds.includes(componentId) ||
          scanComponentIds.has(componentId) ||
          quantizationTableId === undefined ||
          !quantizationTables.has(quantizationTableId) ||
          !dcHuffmanTables.has(dcHuffmanTableId) ||
          !acHuffmanTables.has(acHuffmanTableId) ||
          dcHuffmanTableId > 3 ||
          acHuffmanTableId > 3
        ) {
          return invalid('MALFORMED_JPEG');
        }
        scanComponentIds.add(componentId);
      }
      const spectralOffset = offset + 3 + 2 * scanComponentCount;
      if (
        bytes[spectralOffset] !== 0 ||
        bytes[spectralOffset + 1] !== 63 ||
        bytes[spectralOffset + 2] !== 0
      ) {
        return invalid('JPEG_UNSUPPORTED_FEATURE');
      }
      sawScan = true;
      offset += segmentLength;
      let foundNextMarker = false;
      while (offset < bytes.byteLength) {
        if (bytes[offset] !== 0xff) {
          entropyBytes += 1;
          offset += 1;
          continue;
        }
        const markerStart = offset;
        offset += 1;
        while (bytes[offset] === 0xff) offset += 1;
        if (offset >= bytes.byteLength) return invalid('MALFORMED_JPEG');
        const entropyMarker = bytes[offset]!;
        if (entropyMarker === 0x00) {
          entropyBytes += 1;
          offset += 1;
          continue;
        }
        if (JPEG_RESTART_MARKERS.has(entropyMarker)) {
          offset += 1;
          continue;
        }
        offset = markerStart;
        foundNextMarker = true;
        break;
      }
      if (!foundNextMarker) return invalid('MALFORMED_JPEG');
      continue;
    }
    offset += segmentLength;
  }

  if (!frame || !sawScan || !sawEnd || entropyBytes === 0 || offset !== bytes.byteLength) {
    return invalid('MALFORMED_JPEG');
  }
  try {
    // Only one baseline frame/scan reaches this synchronous decoder. Input/header, geometry,
    // sampling and table bounds above plus the decoder's allocation cap bound its work;
    // an async deadline is deliberately NOT treated as a decoder interrupt.
    const decoded = decodeJpeg(bytes, {
      formatAsRGBA: true,
      maxMemoryUsageInMB: 32,
      maxResolutionInMP: MAX_DOCUMENT_JPEG_PIXELS / 1_000_000,
      tolerantDecoding: false,
      useTArray: true,
    });
    const decodedDimensionsMatch = decoded.width === frame.width && decoded.height === frame.height;
    decoded.data.fill(0);
    if (!decodedDimensionsMatch) return invalid('MALFORMED_JPEG');
  } catch {
    return invalid('MALFORMED_JPEG');
  }
  return {
    valid: true,
    format: 'JPEG',
    width: frame.width,
    height: frame.height,
    pixelCount: frame.width * frame.height,
  };
}

function createCrcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let crc = index;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) === 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[index] = crc >>> 0;
  }
  return table;
}

function pngChunkCrc(bytes: Uint8Array, start: number, end: number): number {
  let crc = 0xffffffff;
  for (let offset = start; offset < end; offset += 1) {
    crc = CRC_TABLE[(crc ^ bytes[offset]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function passDimension(size: number, start: number, step: number): number {
  return size <= start ? 0 : Math.ceil((size - start) / step);
}

function pngPasses(
  width: number,
  height: number,
  bitDepth: number,
  channels: number,
  interlace: number,
): PngPass[] {
  const coordinates = interlace === 0 ? ([[0, 0, 1, 1]] as const) : ADAM7_PASSES;
  return coordinates.flatMap(([startX, startY, stepX, stepY]) => {
    const passWidth = passDimension(width, startX, stepX);
    const rows = passDimension(height, startY, stepY);
    if (passWidth === 0 || rows === 0) return [];
    return [{ width: passWidth, rowBytes: Math.ceil((passWidth * channels * bitDepth) / 8), rows }];
  });
}

function pngPaletteRowIsInRange(
  row: Uint8Array,
  width: number,
  bitDepth: number,
  paletteEntries: number,
): boolean {
  for (let pixel = 0; pixel < width; pixel += 1) {
    const bitOffset = pixel * bitDepth;
    const byteOffset = bitOffset >>> 3;
    const shift = 8 - bitDepth - (bitOffset & 7);
    const index = (row[byteOffset]! >>> shift) & ((1 << bitDepth) - 1);
    if (index >= paletteEntries) return false;
  }
  return true;
}

function hasStrictPdfEnvelope(bytes: Uint8Array): boolean {
  if (!hasBytesAt(bytes, 0, [0x25, 0x50, 0x44, 0x46, 0x2d])) return false;
  let eofEnd = bytes.byteLength;
  while (eofEnd > 0 && [0x09, 0x0a, 0x0c, 0x0d, 0x20].includes(bytes[eofEnd - 1]!)) {
    eofEnd -= 1;
  }
  if (eofEnd < 5 || !hasBytesAt(bytes, eofEnd - 5, [0x25, 0x25, 0x45, 0x4f, 0x46])) {
    return false;
  }
  const tailStart = Math.max(0, eofEnd - 256);
  const tail = new TextDecoder().decode(bytes.subarray(tailStart, eofEnd - 5));
  const startXref = /startxref\s+(\d+)\s*$/u.exec(tail);
  if (!startXref) return false;
  const xrefOffset = Number(startXref[1]);
  if (!Number.isSafeInteger(xrefOffset) || xrefOffset < 0 || xrefOffset >= eofEnd - 5) return false;
  const xref = new TextDecoder().decode(
    bytes.subarray(xrefOffset, Math.min(eofEnd - 5, xrefOffset + 1024)),
  );
  return (
    xref.startsWith('xref') && [0x09, 0x0a, 0x0c, 0x0d, 0x20].includes(bytes[xrefOffset + 4] ?? -1)
  );
}

function pdfStartXrefOffset(bytes: Uint8Array): number | null {
  let eofEnd = bytes.byteLength;
  while (eofEnd > 0 && [0x09, 0x0a, 0x0c, 0x0d, 0x20].includes(bytes[eofEnd - 1]!)) {
    eofEnd -= 1;
  }
  if (eofEnd < 5) return null;
  const tailStart = Math.max(0, eofEnd - 5 - 256);
  const tail = new TextDecoder().decode(bytes.subarray(tailStart, eofEnd - 5));
  const marker = tail.lastIndexOf('startxref');
  if (marker < 0) return null;
  let cursor = marker + 'startxref'.length;
  while (cursor < tail.length && isPdfWhitespace(tail.charCodeAt(cursor))) cursor += 1;
  const numberStart = cursor;
  while (
    cursor < tail.length &&
    tail.charCodeAt(cursor) >= 0x30 &&
    tail.charCodeAt(cursor) <= 0x39
  ) {
    cursor += 1;
  }
  if (cursor === numberStart) return null;
  const xrefOffset = Number(tail.slice(numberStart, cursor));
  while (cursor < tail.length && isPdfWhitespace(tail.charCodeAt(cursor))) cursor += 1;
  if (
    cursor !== tail.length ||
    !Number.isSafeInteger(xrefOffset) ||
    xrefOffset < 0 ||
    xrefOffset + 4 >= eofEnd - 5 ||
    !hasBytesAt(bytes, xrefOffset, [0x78, 0x72, 0x65, 0x66]) ||
    ![0x09, 0x0a, 0x0c, 0x0d, 0x20].includes(bytes[xrefOffset + 4] ?? -1)
  ) {
    return null;
  }
  return xrefOffset;
}

function pdfNameHexDigit(value: number): number | null {
  if (value >= 0x30 && value <= 0x39) return value - 0x30;
  if (value >= 0x41 && value <= 0x46) return value - 0x41 + 10;
  if (value >= 0x61 && value <= 0x66) return value - 0x61 + 10;
  return null;
}

function pdfNameCharacter(
  bytes: Uint8Array,
  offset: number,
): { value: number; next: number } | null {
  const value = bytes[offset];
  if (value === undefined) return null;
  if (value !== 0x23) return { value, next: offset + 1 };
  const high = pdfNameHexDigit(bytes[offset + 1] ?? -1);
  const low = pdfNameHexDigit(bytes[offset + 2] ?? -1);
  return high === null || low === null ? null : { value: high * 16 + low, next: offset + 3 };
}

function isPdfDelimiter(value: number | undefined): boolean {
  return (
    value === undefined ||
    value <= 0x20 ||
    value === 0x28 ||
    value === 0x29 ||
    value === 0x3c ||
    value === 0x3e ||
    value === 0x5b ||
    value === 0x5d ||
    value === 0x7b ||
    value === 0x7d ||
    value === 0x2f ||
    value === 0x25
  );
}

type PdfTokenKind =
  | 'name'
  | 'word'
  | 'number'
  | 'dictionary-open'
  | 'dictionary-close'
  | 'array-open'
  | 'array-close'
  | 'other';

interface PdfToken {
  readonly kind: PdfTokenKind;
  readonly value?: string;
  readonly next: number;
  readonly start?: number;
}

class PdfInspectionError extends Error {
  constructor(readonly reason: 'MALFORMED_PDF' | 'PDF_RESOURCE_LIMIT' | 'PDF_UNSUPPORTED_FEATURE') {
    super(reason);
  }
}

const MAX_DOCUMENT_PDF_TOKENS = 65_536;
const MAX_DOCUMENT_PDF_NESTING = 64;
const PDF_ACTIVE_NAMES = new Set([
  'A',
  'S',
  'AA',
  'Next',
  'OpenAction',
  'JavaScript',
  'JS',
  'Launch',
  'URI',
  'GoToR',
  'GoToE',
  'SubmitForm',
  'ImportData',
  'EmbeddedFiles',
  'EmbeddedFile',
  'FileAttachment',
  'Filespec',
  'EF',
  'RichMedia',
  'RichMediaExecute',
  'Rendition',
  '3D',
  'Sound',
  'Movie',
  'Hide',
  'ResetForm',
  'SetOCGState',
  'GoTo3DView',
  'Thread',
  'Named',
  'Trans',
  'AcroForm',
  'XFA',
]);

function isPdfWhitespace(value: number): boolean {
  return value === 0 || value === 9 || value === 10 || value === 12 || value === 13 || value === 32;
}

function pdfTokenAt(bytes: Uint8Array, start: number): PdfToken | null {
  let offset = start;
  while (offset < bytes.byteLength) {
    const value = bytes[offset]!;
    if (isPdfWhitespace(value)) {
      offset += 1;
      continue;
    }
    if (value === 0x25) {
      while (offset < bytes.byteLength && bytes[offset] !== 0x0a && bytes[offset] !== 0x0d) {
        offset += 1;
      }
      continue;
    }
    break;
  }
  if (offset >= bytes.byteLength) return null;
  const tokenStart = offset;
  const first = bytes[offset]!;
  if (first === 0x28) {
    let depth = 1;
    offset += 1;
    while (offset < bytes.byteLength && depth > 0) {
      const value = bytes[offset++]!;
      if (value === 0x5c) {
        if (bytes[offset] === 0x0d && bytes[offset + 1] === 0x0a) offset += 2;
        else if (offset < bytes.byteLength) offset += 1;
      } else if (value === 0x28) {
        depth += 1;
        if (depth > MAX_DOCUMENT_PDF_NESTING) throw new PdfInspectionError('PDF_RESOURCE_LIMIT');
      } else if (value === 0x29) {
        depth -= 1;
      }
    }
    if (depth !== 0) throw new PdfInspectionError('MALFORMED_PDF');
    return { kind: 'other', next: offset, start: tokenStart };
  }
  if (first === 0x3c) {
    if (bytes[offset + 1] === 0x3c)
      return { kind: 'dictionary-open', next: offset + 2, start: tokenStart };
    offset += 1;
    while (offset < bytes.byteLength && bytes[offset] !== 0x3e) {
      const value = bytes[offset++]!;
      if (!isPdfWhitespace(value) && pdfNameHexDigit(value) === null) {
        throw new PdfInspectionError('MALFORMED_PDF');
      }
    }
    if (offset >= bytes.byteLength) throw new PdfInspectionError('MALFORMED_PDF');
    return { kind: 'other', next: offset + 1, start: tokenStart };
  }
  if (first === 0x3e) {
    if (bytes[offset + 1] !== 0x3e) throw new PdfInspectionError('MALFORMED_PDF');
    return { kind: 'dictionary-close', next: offset + 2, start: tokenStart };
  }
  if (first === 0x2f) {
    let name = '';
    offset += 1;
    while (!isPdfDelimiter(bytes[offset])) {
      const parsed = pdfNameCharacter(bytes, offset);
      if (!parsed) throw new PdfInspectionError('MALFORMED_PDF');
      name += String.fromCharCode(parsed.value);
      if (name.length > 256) throw new PdfInspectionError('PDF_RESOURCE_LIMIT');
      offset = parsed.next;
    }
    return { kind: 'name', value: name, next: offset, start: tokenStart };
  }
  if (first === 0x5b) return { kind: 'array-open', next: offset + 1, start: tokenStart };
  if (first === 0x5d) return { kind: 'array-close', next: offset + 1, start: tokenStart };
  let token = '';
  while (!isPdfDelimiter(bytes[offset])) {
    const value = bytes[offset]!;
    if (value > 0x7e) throw new PdfInspectionError('MALFORMED_PDF');
    token += String.fromCharCode(value);
    if (token.length > 256) throw new PdfInspectionError('PDF_RESOURCE_LIMIT');
    offset += 1;
  }
  if (token.length === 0) throw new PdfInspectionError('MALFORMED_PDF');
  return {
    kind: /^[+-]?(?:\d+\.?\d*|\.\d+)$/u.test(token) ? 'number' : 'word',
    value: token,
    next: offset,
    start: tokenStart,
  };
}

function parsePdfInteger(token: PdfToken): number | null {
  if (token.kind !== 'number' || !/^\d+$/u.test(token.value ?? '')) return null;
  const value = Number(token.value);
  return Number.isSafeInteger(value) ? value : null;
}

interface PdfXrefEntry {
  readonly offset: number;
  readonly generation: number;
}

interface PdfXrefTable {
  readonly size: number;
  readonly entries: ReadonlyMap<number, PdfXrefEntry>;
}

type PdfObjectReference = { readonly objectNumber: number; readonly generation: number };
type PdfRectangle = readonly [number, number, number, number];

interface PdfObjectStructure {
  readonly type: string | null;
  readonly pagesReference?: PdfObjectReference;
  readonly parentReference?: PdfObjectReference;
  readonly kids?: readonly PdfObjectReference[];
  readonly pageCount?: number;
  readonly mediaBox?: PdfRectangle;
  readonly cropBox?: PdfRectangle;
  readonly userUnit?: number;
  readonly hasStream: boolean;
  readonly resourcesPresent: boolean;
  readonly resourcesReference?: PdfObjectReference;
  readonly contentsReference?: PdfObjectReference;
}

function pdfPageBoxError(
  box: PdfRectangle,
  userUnit: number,
): 'MALFORMED_PDF' | 'PDF_PAGE_RESOURCE_LIMIT' | null {
  const [x0, y0, x1, y1] = box;
  if (
    !Number.isFinite(userUnit) ||
    userUnit <= 0 ||
    box.some((coordinate) => !Number.isFinite(coordinate)) ||
    x1 <= x0 ||
    y1 <= y0
  ) {
    return 'MALFORMED_PDF';
  }
  const width = (x1 - x0) * userUnit;
  const height = (y1 - y0) * userUnit;
  if (
    box.some((coordinate) => Math.abs(coordinate) > MAX_DOCUMENT_PDF_PAGE_SIDE_POINTS) ||
    width > MAX_DOCUMENT_PDF_PAGE_SIDE_POINTS ||
    height > MAX_DOCUMENT_PDF_PAGE_SIDE_POINTS ||
    width * height > MAX_DOCUMENT_PDF_PAGE_AREA_POINTS
  ) {
    return 'PDF_PAGE_RESOURCE_LIMIT';
  }
  return null;
}

function validatePdfPageTree(
  root: PdfObjectReference,
  objects: ReadonlyMap<number, PdfObjectStructure>,
  xrefs: ReadonlyMap<number, PdfXrefEntry>,
  expectedPages: number,
  totalPages: number,
  totalTrees: number,
): DocumentContentInspectionFailure | null {
  const seen = new Set<string>();
  const pages = new Set<number>();
  const trees = new Set<number>();
  const walk = (
    ref: PdfObjectReference,
    parent: PdfObjectReference | undefined,
    depth: number,
    inheritedMediaBox: PdfRectangle | undefined,
    inheritedCropBox: PdfRectangle | undefined,
    inheritedResources: boolean,
  ): DocumentContentInspectionFailure | null => {
    if (depth > 64) return 'PDF_RESOURCE_LIMIT';
    const key = `${ref.objectNumber}:${ref.generation}`;
    if (seen.has(key)) return 'MALFORMED_PDF';
    seen.add(key);
    const node = objects.get(ref.objectNumber);
    if (!node || xrefs.get(ref.objectNumber)?.generation !== ref.generation) return 'MALFORMED_PDF';
    if (node.type === 'Pages') {
      trees.add(ref.objectNumber);
      if (
        parent === undefined
          ? node.parentReference !== undefined
          : node.parentReference?.objectNumber !== parent.objectNumber ||
            node.parentReference?.generation !== parent.generation
      ) {
        return 'MALFORMED_PDF';
      }
      if (node.kids === undefined || node.pageCount === undefined) return 'MALFORMED_PDF';
      if (node.userUnit !== undefined) return 'PDF_UNSUPPORTED_FEATURE';
      const resourcesAvailable = inheritedResources || node.resourcesPresent;
      if (node.resourcesReference !== undefined) {
        const resources = objects.get(node.resourcesReference.objectNumber);
        if (
          !resources ||
          resources.hasStream ||
          xrefs.get(node.resourcesReference.objectNumber)?.generation !==
            node.resourcesReference.generation
        ) {
          return 'MALFORMED_PDF';
        }
      }
      const media = node.mediaBox ?? inheritedMediaBox;
      const crop = node.cropBox ?? inheritedCropBox;
      if (media !== undefined) {
        const error = pdfPageBoxError(media, 1);
        if (error !== null) return error;
      }
      if (crop !== undefined) {
        if (media === undefined) return 'PDF_PAGE_GEOMETRY_UNAVAILABLE';
        const error = pdfPageBoxError(crop, 1);
        if (error !== null) return error;
        if (crop[0] < media[0] || crop[1] < media[1] || crop[2] > media[2] || crop[3] > media[3])
          return 'MALFORMED_PDF';
      }
      const pagesBefore = pages.size;
      for (const kid of node.kids) {
        const error = walk(kid, ref, depth + 1, media, crop, resourcesAvailable);
        if (error !== null) return error;
        if (pages.size - pagesBefore > MAX_DOCUMENT_PDF_PAGES) return 'PDF_PAGE_LIMIT';
      }
      const count = pages.size - pagesBefore;
      if (node.pageCount !== count) return 'MALFORMED_PDF';
      return null;
    }
    if (node.type !== 'Page' || parent === undefined) return 'MALFORMED_PDF';
    if (
      node.parentReference?.objectNumber !== parent.objectNumber ||
      node.parentReference.generation !== parent.generation
    )
      return 'MALFORMED_PDF';
    const resourcesAvailable = inheritedResources || node.resourcesPresent;
    if (node.resourcesReference !== undefined) {
      const resources = objects.get(node.resourcesReference.objectNumber);
      if (
        !resources ||
        resources.hasStream ||
        xrefs.get(node.resourcesReference.objectNumber)?.generation !==
          node.resourcesReference.generation
      ) {
        return 'MALFORMED_PDF';
      }
    }
    if (node.contentsReference !== undefined) {
      const contents = objects.get(node.contentsReference.objectNumber);
      if (
        !resourcesAvailable ||
        !contents?.hasStream ||
        xrefs.get(node.contentsReference.objectNumber)?.generation !==
          node.contentsReference.generation
      ) {
        return 'MALFORMED_PDF';
      }
    }
    const media = node.mediaBox ?? inheritedMediaBox;
    if (media === undefined) return 'PDF_PAGE_GEOMETRY_UNAVAILABLE';
    const mediaError = pdfPageBoxError(media, node.userUnit ?? 1);
    if (mediaError !== null) return mediaError;
    const crop = node.cropBox ?? inheritedCropBox ?? media;
    const cropError = pdfPageBoxError(crop, node.userUnit ?? 1);
    if (cropError !== null) return cropError;
    if (crop[0] < media[0] || crop[1] < media[1] || crop[2] > media[2] || crop[3] > media[3])
      return 'MALFORMED_PDF';
    pages.add(ref.objectNumber);
    return null;
  };
  const error = walk(root, undefined, 0, undefined, undefined, false);
  if (error !== null) return error;
  if (pages.size !== expectedPages || pages.size !== totalPages || trees.size !== totalTrees)
    return 'MALFORMED_PDF';
  return null;
}

function readPdfXrefTable(bytes: Uint8Array, start: number, end: number): PdfXrefTable | null {
  try {
    const marker = pdfTokenAt(bytes, start);
    if (marker?.kind !== 'word' || marker.value !== 'xref') return null;
    const firstObjectToken = pdfTokenAt(bytes, marker.next);
    const countToken = firstObjectToken ? pdfTokenAt(bytes, firstObjectToken.next) : null;
    const firstObject = firstObjectToken ? parsePdfInteger(firstObjectToken) : null;
    const count = countToken ? parsePdfInteger(countToken) : null;
    if (
      firstObject !== 0 ||
      count === null ||
      count < 2 ||
      count > MAX_DOCUMENT_PDF_OBJECTS * 8 ||
      !firstObjectToken ||
      !countToken
    ) {
      return null;
    }

    let offset = countToken.next;
    const entries = new Map<number, PdfXrefEntry>();
    for (let objectId = 0; objectId < count; objectId += 1) {
      if (offset >= end) return null;
      const objectOffsetToken = pdfTokenAt(bytes, offset);
      const generationToken = objectOffsetToken ? pdfTokenAt(bytes, objectOffsetToken.next) : null;
      const inUseToken = generationToken ? pdfTokenAt(bytes, generationToken.next) : null;
      const objectOffset = objectOffsetToken ? parsePdfInteger(objectOffsetToken) : null;
      const generation = generationToken ? parsePdfInteger(generationToken) : null;
      if (objectOffset === null || generation === null || generation > 65_535) return null;
      if (objectId === 0) {
        if (objectOffset !== 0 || generation !== 65_535 || inUseToken?.value !== 'f') return null;
      } else {
        if (
          inUseToken?.kind !== 'word' ||
          inUseToken.value !== 'n' ||
          objectOffset >= start ||
          !Number.isInteger(bytes[objectOffset]) ||
          bytes[objectOffset]! < 0x30 ||
          bytes[objectOffset]! > 0x39
        ) {
          return null;
        }
        // Do not tokenize at attacker-selected offsets. The single forward object parse
        // below proves the exact object-number/generation/offset match for every entry.
        // Random header reads can repeatedly traverse a shared long comment (quadratic work).
        entries.set(objectId, { offset: objectOffset, generation });
      }
      offset = inUseToken.next;
    }
    const trailer = offset < end ? pdfTokenAt(bytes, offset) : null;
    const trailerDictionary = trailer ? pdfTokenAt(bytes, trailer.next) : null;
    if (
      trailer?.kind !== 'word' ||
      trailer.value !== 'trailer' ||
      trailerDictionary?.kind !== 'dictionary-open'
    ) {
      return null;
    }
    return { size: count, entries };
  } catch {
    return null;
  }
}

function hasPdfInlineImageOperator(bytes: Uint8Array, start: number, end: number): boolean {
  for (let offset = start; offset + 2 < end; offset += 1) {
    if (
      bytes[offset] === 0x42 &&
      bytes[offset + 1] === 0x49 &&
      isPdfDelimiter(bytes[offset - 1]) &&
      isPdfDelimiter(bytes[offset + 2])
    ) {
      return true;
    }
  }
  return false;
}

function inspectPdf(bytes: Uint8Array<ArrayBuffer>): DocumentContentInspectionResult {
  if (!hasStrictPdfEnvelope(bytes)) return invalid('MALFORMED_PDF');
  const xrefOffset = pdfStartXrefOffset(bytes);
  const xrefTable =
    xrefOffset === null ? null : readPdfXrefTable(bytes, xrefOffset, bytes.byteLength);
  if (xrefOffset === null || xrefTable === null) return invalid('MALFORMED_PDF');
  let offset = 0;
  let tokenCount = 0;
  let objectCount = 0;
  let pageCount = 0;
  let nesting = 0;
  const delimiters: Array<'dictionary-open' | 'array-open'> = [];
  let previousToken: PdfToken | null = null;
  let previousPreviousToken: PdfToken | null = null;
  let previousTokenStart: number | null = null;
  let previousPreviousTokenStart: number | null = null;
  const catalogObjects = new Set<string>();
  const parsedObjects = new Map<number, PdfXrefEntry>();
  const referencedObjectRefs = new Map<string, PdfObjectReference>();
  const objectStructures = new Map<number, PdfObjectStructure>();
  let currentObjectId: number | null = null;
  let currentObjectGeneration: number | null = null;
  let currentObjectIsCatalog = false;
  let currentObjectType: string | null = null;
  let currentObjectTypeKeySeen = false;
  let currentObjectSubtypeKeySeen = false;
  let currentObjectPagesReference: PdfObjectReference | undefined;
  let currentObjectParentReference: PdfObjectReference | undefined;
  let currentObjectPagesKeySeen = false;
  let currentObjectParentKeySeen = false;
  let currentObjectResourcesPresent = false;
  let currentObjectResourcesKeySeen = false;
  let currentObjectResourcesReference: PdfObjectReference | undefined;
  let currentObjectContentsKeySeen = false;
  let currentObjectContentsReference: PdfObjectReference | undefined;
  let pendingResourcesValue = false;
  let pendingContentsArray = false;
  let currentObjectKids: readonly PdfObjectReference[] | undefined;
  let currentObjectKidsBuffer: PdfObjectReference[] = [];
  let currentObjectKidsKeySeen = false;
  let currentObjectPageCount: number | undefined;
  let currentObjectCountKeySeen = false;
  let objectReferenceTarget: 'Pages' | 'Parent' | 'Resources' | 'Contents' | null = null;
  let objectReferenceStep = 0;
  let objectReferenceNumber: number | null = null;
  let objectReferenceGeneration: number | null = null;
  let pendingKidsArray = false;
  let readingKidsArray = false;
  let kidsReferenceStep = 0;
  let kidsReferenceNumber: number | null = null;
  let kidsReferenceGeneration: number | null = null;
  let pendingPageBox: 'MediaBox' | 'CropBox' | null = null;
  let pendingPageBoxArray = false;
  let readingPageBoxArray = false;
  let pageBoxValues: number[] = [];
  let currentObjectMediaBox: PdfRectangle | undefined;
  let currentObjectCropBox: PdfRectangle | undefined;
  let currentObjectUserUnit = 1;
  let mediaBoxKeySeen = false;
  let cropBoxKeySeen = false;
  let userUnitKeySeen = false;
  let objectValueExpected = false;
  let insideObject = false;
  let inTrailer = false;
  let trailerAwaitingDictionary = false;
  let trailerClosed = false;
  let xrefCount = 0;
  let trailerCount = 0;
  let startXrefStep = 0;
  let hasRoot = false;
  let hasSize = false;
  let encrypted = false;
  let unsupportedFeature = false;
  let trailerSize: number | null = null;
  let rootReferenceStep = 0;
  let rootObjectNumber: number | null = null;
  let rootObjectGeneration: number | null = null;
  let currentTrailerRootSeen = false;
  let currentTrailerSizeSeen = false;
  let imageObject = false;
  let currentObjectHasStream = false;
  let imageStreamSeen = false;
  let imageWidth: number | null = null;
  let imageHeight: number | null = null;
  let imageComponents: number | null = null;
  let imageBitsPerComponent: number | null = null;
  let imageMask = false;
  let imageColorSpaceSeen = false;
  let imageBitsPerComponentSeen = false;
  let imageMaskSeen = false;
  let objectHasFilter = false;
  let topLevelWidthSeen = false;
  let topLevelHeightSeen = false;
  let streamLengthSeen = false;
  let pendingKey:
    | 'Type'
    | 'Subtype'
    | 'Width'
    | 'Height'
    | 'Length'
    | 'Size'
    | 'Count'
    | 'ColorSpace'
    | 'BitsPerComponent'
    | 'ImageMask'
    | 'UserUnit'
    | null = null;
  let streamLength: number | null = null;
  let checkLengthReference = false;

  try {
    while (offset < bytes.byteLength) {
      const token = pdfTokenAt(bytes, offset);
      if (!token) break;
      const tokenStart = token.start ?? offset;
      offset = token.next;
      tokenCount += 1;
      if (tokenCount > MAX_DOCUMENT_PDF_TOKENS) return invalid('PDF_RESOURCE_LIMIT');
      // Apply type matching before any specialized value parser can consume a delimiter.
      if (token.kind === 'dictionary-open' || token.kind === 'array-open') {
        delimiters.push(token.kind);
        if (delimiters.length > MAX_DOCUMENT_PDF_NESTING) return invalid('PDF_RESOURCE_LIMIT');
      } else if (token.kind === 'dictionary-close' || token.kind === 'array-close') {
        const expected = token.kind === 'dictionary-close' ? 'dictionary-open' : 'array-open';
        if (delimiters.pop() !== expected) return invalid('MALFORMED_PDF');
      }
      if (trailerAwaitingDictionary) {
        if (token.kind !== 'dictionary-open') return invalid('MALFORMED_PDF');
        trailerAwaitingDictionary = false;
      }
      if (
        trailerClosed &&
        startXrefStep === 0 &&
        !(token.kind === 'word' && token.value === 'startxref')
      ) {
        return invalid('MALFORMED_PDF');
      }
      if (startXrefStep === 1) {
        if (parsePdfInteger(token) !== xrefOffset) return invalid('MALFORMED_PDF');
        startXrefStep = 2;
        continue;
      }
      if (startXrefStep === 2) return invalid('MALFORMED_PDF');
      const precedingToken = previousToken;
      const tokenBeforePreceding = previousPreviousToken;
      const tokenBeforePrecedingStart = previousPreviousTokenStart;
      previousPreviousToken = previousToken;
      previousToken = token;
      previousPreviousTokenStart = previousTokenStart;
      previousTokenStart = tokenStart;

      if (checkLengthReference) {
        if (token.kind === 'number' || (token.kind === 'word' && token.value === 'R')) {
          return invalid('PDF_UNSUPPORTED_FEATURE');
        }
        checkLengthReference = false;
      }

      if (rootReferenceStep !== 0) {
        if (rootReferenceStep === 1) {
          rootObjectNumber = parsePdfInteger(token);
          if (rootObjectNumber === null || rootObjectNumber < 1) return invalid('MALFORMED_PDF');
          rootReferenceStep = 2;
        } else if (rootReferenceStep === 2) {
          const generation = parsePdfInteger(token);
          if (generation === null || generation > 65_535) return invalid('MALFORMED_PDF');
          rootObjectGeneration = generation;
          rootReferenceStep = 3;
        } else if (token.kind === 'word' && token.value === 'R') {
          hasRoot = true;
          rootReferenceStep = 0;
        } else {
          return invalid('MALFORMED_PDF');
        }
        continue;
      }

      if (objectValueExpected) {
        if (token.kind !== 'dictionary-open') return invalid('MALFORMED_PDF');
        objectValueExpected = false;
      }
      if (pendingResourcesValue) {
        pendingResourcesValue = false;
        if (token.kind === 'dictionary-open') {
          currentObjectResourcesPresent = true;
        } else if (token.kind === 'number') {
          const objectNumber = parsePdfInteger(token);
          if (objectNumber === null || objectNumber < 1) return invalid('MALFORMED_PDF');
          currentObjectResourcesPresent = true;
          objectReferenceTarget = 'Resources';
          objectReferenceNumber = objectNumber;
          objectReferenceStep = 2;
          continue;
        } else {
          return invalid('MALFORMED_PDF');
        }
      }
      if (pendingContentsArray) {
        pendingContentsArray = false;
        if (token.kind === 'array-open') return invalid('PDF_UNSUPPORTED_FEATURE');
        if (token.kind !== 'number') return invalid('MALFORMED_PDF');
        const objectNumber = parsePdfInteger(token);
        if (objectNumber === null || objectNumber < 1) return invalid('MALFORMED_PDF');
        objectReferenceTarget = 'Contents';
        objectReferenceNumber = objectNumber;
        objectReferenceStep = 2;
        continue;
      }
      if (objectReferenceStep !== 0) {
        if (objectReferenceStep === 1) {
          objectReferenceNumber = parsePdfInteger(token);
          if (objectReferenceNumber === null || objectReferenceNumber < 1) {
            return invalid('MALFORMED_PDF');
          }
          objectReferenceStep = 2;
        } else if (objectReferenceStep === 2) {
          objectReferenceGeneration = parsePdfInteger(token);
          if (objectReferenceGeneration === null || objectReferenceGeneration > 65_535) {
            return invalid('MALFORMED_PDF');
          }
          objectReferenceStep = 3;
        } else if (token.kind === 'word' && token.value === 'R') {
          const reference = {
            objectNumber: objectReferenceNumber!,
            generation: objectReferenceGeneration!,
          };
          if (objectReferenceTarget === 'Pages') currentObjectPagesReference = reference;
          else if (objectReferenceTarget === 'Parent') currentObjectParentReference = reference;
          else if (objectReferenceTarget === 'Resources')
            currentObjectResourcesReference = reference;
          else if (objectReferenceTarget === 'Contents') currentObjectContentsReference = reference;
          else return invalid('MALFORMED_PDF');
          objectReferenceTarget = null;
          objectReferenceNumber = null;
          objectReferenceGeneration = null;
          objectReferenceStep = 0;
        } else {
          return invalid('MALFORMED_PDF');
        }
        continue;
      }
      if (pendingKidsArray) {
        if (token.kind !== 'array-open') return invalid('MALFORMED_PDF');
        pendingKidsArray = false;
        readingKidsArray = true;
        currentObjectKidsBuffer = [];
        kidsReferenceStep = 0;
        nesting += 1;
        if (nesting > MAX_DOCUMENT_PDF_NESTING) return invalid('PDF_RESOURCE_LIMIT');
        continue;
      }
      if (readingKidsArray) {
        if (token.kind === 'array-close') {
          if (kidsReferenceStep !== 0) return invalid('MALFORMED_PDF');
          readingKidsArray = false;
          currentObjectKids = currentObjectKidsBuffer;
          nesting -= 1;
          if (nesting < 0) return invalid('MALFORMED_PDF');
          continue;
        }
        if (kidsReferenceStep === 0) {
          kidsReferenceNumber = parsePdfInteger(token);
          if (kidsReferenceNumber === null || kidsReferenceNumber < 1) {
            return invalid('MALFORMED_PDF');
          }
          kidsReferenceStep = 1;
        } else if (kidsReferenceStep === 1) {
          kidsReferenceGeneration = parsePdfInteger(token);
          if (kidsReferenceGeneration === null || kidsReferenceGeneration > 65_535) {
            return invalid('MALFORMED_PDF');
          }
          kidsReferenceStep = 2;
        } else if (token.kind === 'word' && token.value === 'R') {
          currentObjectKidsBuffer.push({
            objectNumber: kidsReferenceNumber!,
            generation: kidsReferenceGeneration!,
          });
          kidsReferenceNumber = null;
          kidsReferenceGeneration = null;
          kidsReferenceStep = 0;
        } else {
          return invalid('MALFORMED_PDF');
        }
        continue;
      }

      if (pendingPageBoxArray) {
        if (token.kind !== 'array-open') return invalid('MALFORMED_PDF');
        pendingPageBoxArray = false;
        readingPageBoxArray = true;
        pageBoxValues = [];
        nesting += 1;
        if (nesting > MAX_DOCUMENT_PDF_NESTING) return invalid('PDF_RESOURCE_LIMIT');
        continue;
      }
      if (readingPageBoxArray) {
        if (token.kind === 'array-close') {
          if (pageBoxValues.length !== 4) return invalid('MALFORMED_PDF');
          const rectangle = pageBoxValues as [number, number, number, number];
          if (pendingPageBox === 'MediaBox') currentObjectMediaBox = rectangle;
          else if (pendingPageBox === 'CropBox') currentObjectCropBox = rectangle;
          else return invalid('MALFORMED_PDF');
          pendingPageBox = null;
          readingPageBoxArray = false;
          nesting -= 1;
          continue;
        }
        if (token.kind !== 'number' || pageBoxValues.length >= 4) return invalid('MALFORMED_PDF');
        const coordinate = Number(token.value);
        if (!Number.isFinite(coordinate)) return invalid('MALFORMED_PDF');
        pageBoxValues.push(coordinate);
        continue;
      }
      if (token.kind === 'dictionary-open' || token.kind === 'array-open') {
        if (pendingKey === 'ColorSpace') return invalid('PDF_UNSUPPORTED_FEATURE');
        if (pendingKey !== null) return invalid('MALFORMED_PDF');
        nesting += 1;
        if (nesting > MAX_DOCUMENT_PDF_NESTING) return invalid('PDF_RESOURCE_LIMIT');
        continue;
      }
      if (token.kind === 'dictionary-close' || token.kind === 'array-close') {
        if (token.kind === 'dictionary-close' && inTrailer && nesting === 1) {
          inTrailer = false;
          trailerClosed = true;
        }
        nesting -= 1;
        if (nesting < 0) return invalid('MALFORMED_PDF');
        continue;
      }

      if (token.kind === 'name') {
        const name = token.value ?? '';
        if (name === 'Encrypt') encrypted = true;
        if (PDF_ACTIVE_NAMES.has(name)) return invalid('PDF_ACTIVE_CONTENT');
        if (
          name === 'Filter' ||
          name === 'DecodeParms' ||
          name === 'ObjStm' ||
          name === 'XRef' ||
          name === 'XRefStm'
        ) {
          unsupportedFeature = true;
          if (insideObject) objectHasFilter = true;
        }

        if (pendingKey === 'ColorSpace') {
          const componentsByColorSpace: Readonly<Record<string, number>> = {
            DeviceGray: 1,
            DeviceRGB: 3,
            DeviceCMYK: 4,
          };
          const components = componentsByColorSpace[name];
          if (components === undefined) return invalid('PDF_UNSUPPORTED_FEATURE');
          imageComponents = components;
          imageColorSpaceSeen = true;
          pendingKey = null;
          continue;
        }
        if (pendingKey === 'Type' || pendingKey === 'Subtype') {
          if (pendingKey === 'Type' && nesting === 1) {
            currentObjectType = name;
            if (name === 'Page') {
              pageCount += 1;
              if (pageCount > MAX_DOCUMENT_PDF_PAGES) return invalid('PDF_PAGE_LIMIT');
            }
            if (name === 'Catalog') currentObjectIsCatalog = true;
            if (name === 'ObjStm' || name === 'XRef') unsupportedFeature = true;
          }
          if (pendingKey === 'Subtype' && name === 'Image' && nesting === 1) imageObject = true;
          pendingKey = null;
          continue;
        } else if (pendingKey !== null) {
          return invalid('MALFORMED_PDF');
        }

        if (inTrailer && name === 'Prev') return invalid('PDF_UNSUPPORTED_FEATURE');
        if (inTrailer && nesting === 1 && name === 'Root') {
          if (currentTrailerRootSeen || rootReferenceStep !== 0) return invalid('MALFORMED_PDF');
          currentTrailerRootSeen = true;
          rootObjectNumber = null;
          rootObjectGeneration = null;
          hasRoot = false;
          rootReferenceStep = 1;
          continue;
        }
        if (inTrailer && nesting === 1 && name === 'Size') {
          if (currentTrailerSizeSeen || pendingKey !== null) return invalid('MALFORMED_PDF');
          currentTrailerSizeSeen = true;
          pendingKey = 'Size';
          continue;
        }
        if (insideObject && nesting === 1 && name === 'Type') {
          if (currentObjectTypeKeySeen) return invalid('MALFORMED_PDF');
          currentObjectTypeKeySeen = true;
          pendingKey = 'Type';
        } else if (insideObject && nesting === 1 && name === 'Subtype') {
          if (currentObjectSubtypeKeySeen) return invalid('MALFORMED_PDF');
          currentObjectSubtypeKeySeen = true;
          pendingKey = 'Subtype';
        } else if (insideObject && nesting === 1 && name === 'Pages') {
          if (currentObjectPagesKeySeen) return invalid('MALFORMED_PDF');
          currentObjectPagesKeySeen = true;
          objectReferenceTarget = 'Pages';
          objectReferenceStep = 1;
        } else if (insideObject && nesting === 1 && name === 'Parent') {
          if (currentObjectParentKeySeen) return invalid('MALFORMED_PDF');
          currentObjectParentKeySeen = true;
          objectReferenceTarget = 'Parent';
          objectReferenceStep = 1;
        } else if (insideObject && nesting === 1 && name === 'Resources') {
          if (currentObjectResourcesKeySeen) return invalid('MALFORMED_PDF');
          currentObjectResourcesKeySeen = true;
          pendingResourcesValue = true;
        } else if (insideObject && nesting === 1 && name === 'Contents') {
          if (currentObjectContentsKeySeen) return invalid('MALFORMED_PDF');
          currentObjectContentsKeySeen = true;
          pendingContentsArray = true;
        } else if (insideObject && nesting === 1 && name === 'Kids') {
          if (currentObjectKidsKeySeen) return invalid('MALFORMED_PDF');
          currentObjectKidsKeySeen = true;
          pendingKidsArray = true;
        } else if (insideObject && nesting === 1 && name === 'Count') {
          if (currentObjectCountKeySeen) return invalid('MALFORMED_PDF');
          currentObjectCountKeySeen = true;
          pendingKey = 'Count';
        } else if (insideObject && nesting === 1 && name === 'Width') {
          if (topLevelWidthSeen) return invalid('MALFORMED_PDF');
          topLevelWidthSeen = true;
          pendingKey = 'Width';
        } else if (insideObject && nesting === 1 && name === 'Height') {
          if (topLevelHeightSeen) return invalid('MALFORMED_PDF');
          topLevelHeightSeen = true;
          pendingKey = 'Height';
        } else if (insideObject && nesting === 1 && name === 'ColorSpace') {
          if (imageColorSpaceSeen) return invalid('MALFORMED_PDF');
          pendingKey = 'ColorSpace';
        } else if (insideObject && nesting === 1 && name === 'BitsPerComponent') {
          if (imageBitsPerComponentSeen) return invalid('MALFORMED_PDF');
          imageBitsPerComponentSeen = true;
          pendingKey = 'BitsPerComponent';
        } else if (insideObject && nesting === 1 && name === 'ImageMask') {
          if (imageMaskSeen) return invalid('MALFORMED_PDF');
          imageMaskSeen = true;
          pendingKey = 'ImageMask';
        } else if (insideObject && nesting === 1 && name === 'MediaBox') {
          if (mediaBoxKeySeen) return invalid('MALFORMED_PDF');
          mediaBoxKeySeen = true;
          pendingPageBox = 'MediaBox';
          pendingPageBoxArray = true;
        } else if (insideObject && nesting === 1 && name === 'CropBox') {
          if (cropBoxKeySeen) return invalid('MALFORMED_PDF');
          cropBoxKeySeen = true;
          pendingPageBox = 'CropBox';
          pendingPageBoxArray = true;
        } else if (insideObject && nesting === 1 && name === 'UserUnit') {
          if (userUnitKeySeen) return invalid('MALFORMED_PDF');
          userUnitKeySeen = true;
          pendingKey = 'UserUnit';
        } else if (insideObject && nesting === 1 && name === 'Length') {
          if (streamLengthSeen) return invalid('MALFORMED_PDF');
          streamLengthSeen = true;
          pendingKey = 'Length';
        }
        continue;
      }

      if (token.kind === 'number' && pendingKey === 'UserUnit') {
        const userUnit = Number(token.value);
        if (!Number.isFinite(userUnit) || userUnit <= 0 || userUnit > 75_000) {
          return invalid('MALFORMED_PDF');
        }
        currentObjectUserUnit = userUnit;
        pendingKey = null;
        continue;
      }
      if (token.kind === 'number' && pendingKey !== null) {
        const number = parsePdfInteger(token);
        if (number === null) return invalid('MALFORMED_PDF');
        if (pendingKey === 'Length') {
          streamLength = number;
          checkLengthReference = true;
        } else if (pendingKey === 'Width') {
          if (nesting === 1) imageWidth = number;
        } else if (pendingKey === 'Height') {
          if (nesting === 1) imageHeight = number;
        } else if (pendingKey === 'BitsPerComponent') {
          if (![1, 2, 4, 8, 16].includes(number)) return invalid('PDF_UNSUPPORTED_FEATURE');
          imageBitsPerComponent = number;
        } else if (pendingKey === 'Size') {
          if (!inTrailer || number < 1) return invalid('MALFORMED_PDF');
          trailerSize = number;
          hasSize = true;
        } else if (pendingKey === 'Count') {
          if (number < 0) return invalid('MALFORMED_PDF');
          if (number > MAX_DOCUMENT_PDF_PAGES) return invalid('PDF_PAGE_LIMIT');
          currentObjectPageCount = number;
        } else {
          return invalid('MALFORMED_PDF');
        }
        pendingKey = null;
        continue;
      }
      if (pendingKey === 'ImageMask' && token.kind === 'word') {
        if (token.value === 'true') imageMask = true;
        else if (token.value !== 'false') return invalid('MALFORMED_PDF');
        pendingKey = null;
        continue;
      }
      if (pendingKey !== null) return invalid('MALFORMED_PDF');

      if (token.kind !== 'word') continue;
      const word = token.value;
      if (word === 'xref') {
        xrefCount += 1;
        if (xrefCount !== 1 || insideObject || delimiters.length !== 0)
          return invalid('MALFORMED_PDF');
      } else if (word === 'obj') {
        if (insideObject || delimiters.length !== 0) return invalid('MALFORMED_PDF');
        const objectId = parsePdfInteger(tokenBeforePreceding ?? { kind: 'other', next: 0 });
        const objectGeneration = parsePdfInteger(precedingToken ?? { kind: 'other', next: 0 });
        if (
          objectId === null ||
          objectId < 1 ||
          objectGeneration === null ||
          objectGeneration > 65_535 ||
          tokenBeforePrecedingStart === null ||
          parsedObjects.has(objectId)
        ) {
          return invalid('MALFORMED_PDF');
        }
        parsedObjects.set(objectId, {
          offset: tokenBeforePrecedingStart,
          generation: objectGeneration,
        });
        objectCount += 1;
        if (objectCount > MAX_DOCUMENT_PDF_OBJECTS) return invalid('PDF_RESOURCE_LIMIT');
        insideObject = true;
        currentObjectId = objectId;
        currentObjectGeneration = objectGeneration;
        objectValueExpected = true;
        currentObjectIsCatalog = false;
        currentObjectHasStream = false;
        currentObjectType = null;
        currentObjectTypeKeySeen = false;
        currentObjectSubtypeKeySeen = false;
        currentObjectPagesReference = undefined;
        currentObjectParentReference = undefined;
        currentObjectPagesKeySeen = false;
        currentObjectParentKeySeen = false;
        currentObjectResourcesPresent = false;
        currentObjectResourcesKeySeen = false;
        currentObjectResourcesReference = undefined;
        currentObjectContentsKeySeen = false;
        currentObjectContentsReference = undefined;
        pendingResourcesValue = false;
        pendingContentsArray = false;
        currentObjectKids = undefined;
        currentObjectKidsBuffer = [];
        currentObjectKidsKeySeen = false;
        currentObjectPageCount = undefined;
        currentObjectCountKeySeen = false;
        currentObjectMediaBox = undefined;
        currentObjectCropBox = undefined;
        currentObjectUserUnit = 1;
        mediaBoxKeySeen = false;
        cropBoxKeySeen = false;
        userUnitKeySeen = false;
        objectReferenceTarget = null;
        objectReferenceStep = 0;
        objectReferenceNumber = null;
        objectReferenceGeneration = null;
        pendingKidsArray = false;
        readingKidsArray = false;
        kidsReferenceStep = 0;
        kidsReferenceNumber = null;
        kidsReferenceGeneration = null;
        pendingPageBox = null;
        pendingPageBoxArray = false;
        readingPageBoxArray = false;
        pageBoxValues = [];
        objectValueExpected = false;
        imageObject = false;
        imageStreamSeen = false;
        imageWidth = null;
        imageHeight = null;
        imageComponents = null;
        imageBitsPerComponent = null;
        imageMask = false;
        imageColorSpaceSeen = false;
        imageBitsPerComponentSeen = false;
        imageMaskSeen = false;
        objectHasFilter = false;
        topLevelWidthSeen = false;
        topLevelHeightSeen = false;
        streamLengthSeen = false;
        streamLength = null;
        objectValueExpected = true;
      } else if (word === 'endobj') {
        if (!insideObject || delimiters.length !== 0) return invalid('MALFORMED_PDF');
        if (imageObject) {
          if (!imageStreamSeen) return invalid('MALFORMED_PDF');
          if (imageWidth === null || imageHeight === null || imageWidth < 1 || imageHeight < 1) {
            return invalid('IMAGE_DIMENSIONS_UNAVAILABLE');
          }
          if (imageWidth * imageHeight > MAX_DOCUMENT_IMAGE_PIXELS)
            return invalid('IMAGE_PIXEL_LIMIT');
        }
        if (currentObjectId !== null && currentObjectGeneration !== null) {
          objectStructures.set(currentObjectId, {
            type: currentObjectType,
            ...(currentObjectPagesReference ? { pagesReference: currentObjectPagesReference } : {}),
            ...(currentObjectParentReference
              ? { parentReference: currentObjectParentReference }
              : {}),
            ...(currentObjectKids ? { kids: currentObjectKids } : {}),
            ...(currentObjectPageCount === undefined ? {} : { pageCount: currentObjectPageCount }),
            ...(currentObjectMediaBox === undefined ? {} : { mediaBox: currentObjectMediaBox }),
            ...(currentObjectCropBox === undefined ? {} : { cropBox: currentObjectCropBox }),
            ...(userUnitKeySeen ? { userUnit: currentObjectUserUnit } : {}),
            hasStream: currentObjectHasStream,
            resourcesPresent: currentObjectResourcesPresent,
            ...(currentObjectResourcesReference
              ? { resourcesReference: currentObjectResourcesReference }
              : {}),
            ...(currentObjectContentsReference
              ? { contentsReference: currentObjectContentsReference }
              : {}),
          });
        }
        if (
          currentObjectIsCatalog &&
          currentObjectId !== null &&
          currentObjectGeneration !== null
        ) {
          catalogObjects.add(`${currentObjectId}:${currentObjectGeneration}`);
        }
        insideObject = false;
        currentObjectId = null;
        currentObjectGeneration = null;
        currentObjectIsCatalog = false;
        currentObjectHasStream = false;
        currentObjectType = null;
        currentObjectTypeKeySeen = false;
        currentObjectSubtypeKeySeen = false;
        currentObjectPagesReference = undefined;
        currentObjectParentReference = undefined;
        currentObjectPagesKeySeen = false;
        currentObjectParentKeySeen = false;
        currentObjectResourcesPresent = false;
        currentObjectResourcesKeySeen = false;
        currentObjectResourcesReference = undefined;
        currentObjectContentsKeySeen = false;
        currentObjectContentsReference = undefined;
        pendingResourcesValue = false;
        pendingContentsArray = false;
        currentObjectKids = undefined;
        currentObjectKidsBuffer = [];
        currentObjectKidsKeySeen = false;
        currentObjectPageCount = undefined;
        currentObjectCountKeySeen = false;
        currentObjectMediaBox = undefined;
        currentObjectCropBox = undefined;
        currentObjectUserUnit = 1;
        mediaBoxKeySeen = false;
        cropBoxKeySeen = false;
        userUnitKeySeen = false;
        objectReferenceTarget = null;
        objectReferenceStep = 0;
        objectReferenceNumber = null;
        objectReferenceGeneration = null;
        pendingKidsArray = false;
        readingKidsArray = false;
        kidsReferenceStep = 0;
        kidsReferenceNumber = null;
        kidsReferenceGeneration = null;
        pendingPageBox = null;
        pendingPageBoxArray = false;
        readingPageBoxArray = false;
        pageBoxValues = [];
        objectValueExpected = false;
        imageObject = false;
        imageStreamSeen = false;
        imageWidth = null;
        imageHeight = null;
        imageComponents = null;
        imageBitsPerComponent = null;
        imageMask = false;
        imageColorSpaceSeen = false;
        imageBitsPerComponentSeen = false;
        imageMaskSeen = false;
        objectHasFilter = false;
        topLevelWidthSeen = false;
        topLevelHeightSeen = false;
        streamLengthSeen = false;
        streamLength = null;
      } else if (word === 'trailer') {
        if (xrefCount !== 1 || trailerCount !== 0 || insideObject) return invalid('MALFORMED_PDF');
        trailerCount += 1;
        inTrailer = true;
        trailerAwaitingDictionary = true;
        currentTrailerRootSeen = false;
        currentTrailerSizeSeen = false;
      } else if (word === 'startxref') {
        if (
          !trailerClosed ||
          trailerCount !== 1 ||
          xrefCount !== 1 ||
          insideObject ||
          startXrefStep !== 0
        ) {
          return invalid('MALFORMED_PDF');
        }
        startXrefStep = 1;
      } else if (word === 'stream') {
        if (!insideObject || streamLength === null || delimiters.length !== 0)
          return invalid('MALFORMED_PDF');
        if (currentObjectHasStream) return invalid('MALFORMED_PDF');
        currentObjectHasStream = true;
        if (imageObject) {
          if (imageStreamSeen) return invalid('MALFORMED_PDF');
          imageStreamSeen = true;
        }
        let dataStart = token.next;
        if (bytes[dataStart] === 0x0d && bytes[dataStart + 1] === 0x0a) dataStart += 2;
        else if (bytes[dataStart] === 0x0a || bytes[dataStart] === 0x0d) dataStart += 1;
        else return invalid('MALFORMED_PDF');
        const dataEnd = dataStart + streamLength;
        if (!Number.isSafeInteger(dataEnd) || dataEnd > bytes.byteLength)
          return invalid('MALFORMED_PDF');
        if (imageObject && !objectHasFilter) {
          if (imageWidth === null || imageHeight === null || imageWidth < 1 || imageHeight < 1) {
            return invalid('IMAGE_DIMENSIONS_UNAVAILABLE');
          }
          const pixelCount = imageWidth * imageHeight;
          if (pixelCount > MAX_DOCUMENT_IMAGE_PIXELS) return invalid('IMAGE_PIXEL_LIMIT');
          if (imageMask) return invalid('PDF_UNSUPPORTED_FEATURE');
          if (
            imageComponents === null ||
            imageBitsPerComponent === null ||
            !imageColorSpaceSeen ||
            !imageBitsPerComponentSeen
          ) {
            return invalid('PDF_UNSUPPORTED_FEATURE');
          }
          const rowBytes = Math.ceil((imageWidth * imageComponents * imageBitsPerComponent) / 8);
          const expectedImageStreamLength = rowBytes * imageHeight;
          if (expectedImageStreamLength > MAX_DOCUMENT_UPLOAD_BYTES) {
            return invalid('PDF_RESOURCE_LIMIT');
          }
          if (streamLength !== expectedImageStreamLength) return invalid('MALFORMED_PDF');
        }
        if (hasPdfInlineImageOperator(bytes, dataStart, dataEnd)) {
          return invalid('PDF_UNSUPPORTED_FEATURE');
        }
        let endstreamStart = dataEnd;
        if (bytes[endstreamStart] === 0x0d && bytes[endstreamStart + 1] === 0x0a)
          endstreamStart += 2;
        else if (bytes[endstreamStart] === 0x0a || bytes[endstreamStart] === 0x0d)
          endstreamStart += 1;
        const endstream = pdfTokenAt(bytes, endstreamStart);
        if (endstream?.kind !== 'word' || endstream.value !== 'endstream')
          return invalid('MALFORMED_PDF');
        offset = endstream.next;
        streamLength = null;
      } else if (word === 'endstream') {
        return invalid('MALFORMED_PDF');
      } else if (word === 'R') {
        const objectNumber = parsePdfInteger(tokenBeforePreceding ?? { kind: 'other', next: 0 });
        const generation = parsePdfInteger(precedingToken ?? { kind: 'other', next: 0 });
        if (
          objectNumber === null ||
          objectNumber < 1 ||
          generation === null ||
          generation > 65_535
        ) {
          return invalid('MALFORMED_PDF');
        }
        referencedObjectRefs.set(`${objectNumber}:${generation}`, { objectNumber, generation });
      }
    }
  } catch (error) {
    if (error instanceof PdfInspectionError) return invalid(error.reason);
    return invalid('MALFORMED_PDF');
  }

  if (encrypted) return invalid('ENCRYPTED_PDF');
  if (unsupportedFeature) return invalid('PDF_UNSUPPORTED_FEATURE');
  if (
    trailerSize !== xrefTable.size ||
    objectCount !== xrefTable.size - 1 ||
    parsedObjects.size !== objectCount
  ) {
    return invalid('MALFORMED_PDF');
  }
  for (const [objectId, xrefEntry] of xrefTable.entries) {
    const parsedObject = parsedObjects.get(objectId);
    if (
      !parsedObject ||
      parsedObject.offset !== xrefEntry.offset ||
      parsedObject.generation !== xrefEntry.generation
    ) {
      return invalid('MALFORMED_PDF');
    }
  }
  for (const reference of referencedObjectRefs.values()) {
    if (parsedObjects.get(reference.objectNumber)?.generation !== reference.generation) {
      return invalid('MALFORMED_PDF');
    }
  }
  const rootStructure =
    rootObjectNumber === null ? undefined : objectStructures.get(rootObjectNumber);
  const rootPagesReference = rootStructure?.pagesReference;
  const pageObjectCount = [...objectStructures.values()].filter(
    (structure) => structure.type === 'Page',
  ).length;
  const pageTreeObjectCount = [...objectStructures.values()].filter(
    (structure) => structure.type === 'Pages',
  ).length;
  if (rootStructure?.type !== 'Catalog' || rootPagesReference === undefined) {
    return invalid('MALFORMED_PDF');
  }
  const pageTreeError = validatePdfPageTree(
    rootPagesReference,
    objectStructures,
    xrefTable.entries,
    pageCount,
    pageObjectCount,
    pageTreeObjectCount,
  );
  if (pageTreeError !== null) return invalid(pageTreeError);
  const rootXrefEntry = xrefTable.entries.get(rootObjectNumber!);
  if (rootXrefEntry?.generation !== rootObjectGeneration) return invalid('MALFORMED_PDF');
  if (
    insideObject ||
    nesting !== 0 ||
    delimiters.length !== 0 ||
    objectCount === 0 ||
    pageCount === 0 ||
    xrefCount !== 1 ||
    trailerCount !== 1 ||
    !trailerClosed ||
    trailerAwaitingDictionary ||
    startXrefStep !== 2 ||
    !hasRoot ||
    rootReferenceStep !== 0 ||
    rootObjectNumber === null ||
    rootObjectGeneration === null ||
    trailerSize === null ||
    rootObjectNumber >= trailerSize ||
    !catalogObjects.has(`${rootObjectNumber}:${rootObjectGeneration}`) ||
    !hasSize
  ) {
    return invalid('MALFORMED_PDF');
  }
  return { valid: true, format: 'PDF', pageCount };
}

async function inspectPng(
  bytes: Uint8Array<ArrayBuffer>,
  signal?: AbortSignal,
): Promise<DocumentContentInspectionResult> {
  if (!hasBytesAt(bytes, 0, PNG_SIGNATURE)) return invalid('MALFORMED_PNG');
  let offset: number = PNG_SIGNATURE.length;
  let seenHeader = false;
  let seenPalette = false;
  let paletteEntries = 0;
  let seenTransparency = false;
  let seenTime = false;
  let seenIdat = false;
  let idatEnded = false;
  let seenEnd = false;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatChunks: Uint8Array[] = [];
  let idatCompressedBytes = 0;
  let chunkCount = 0;

  while (offset < bytes.byteLength) {
    if (signal?.aborted) throw new Error('CONTENT_INSPECTION_ABORTED');
    if (offset + 12 > bytes.byteLength) return invalid('MALFORMED_PNG');
    const chunkLength = readUint32(bytes, offset);
    const typeStart = offset + 4;
    const dataStart = offset + 8;
    const dataEnd = dataStart + chunkLength;
    const crcEnd = dataEnd + 4;
    if (chunkLength > MAX_DOCUMENT_UPLOAD_BYTES || crcEnd > bytes.byteLength) {
      return invalid('MALFORMED_PNG');
    }
    chunkCount += 1;
    if (chunkCount > MAX_DOCUMENT_PNG_CHUNKS) return invalid('PNG_RESOURCE_LIMIT');
    const type = String.fromCharCode(...bytes.subarray(typeStart, typeStart + 4));
    for (const value of bytes.subarray(typeStart, typeStart + 4)) {
      if (!((value >= 65 && value <= 90) || (value >= 97 && value <= 122))) {
        return invalid('MALFORMED_PNG');
      }
    }
    if ((bytes[typeStart + 2]! & 0x20) !== 0) return invalid('MALFORMED_PNG');
    const storedCrc = readUint32(bytes, dataEnd);
    if (pngChunkCrc(bytes, typeStart, dataEnd) !== storedCrc) return invalid('MALFORMED_PNG');
    if (PNG_UNSUPPORTED_CHUNKS.has(type)) return invalid('PNG_UNSUPPORTED_FEATURE');
    if (!PNG_SUPPORTED_CHUNKS.has(type)) return invalid('PNG_UNSUPPORTED_FEATURE');
    if (!seenHeader && type !== 'IHDR') return invalid('MALFORMED_PNG');
    if (seenEnd) return invalid('MALFORMED_PNG');
    if (type === 'tRNS') {
      const validTransparency =
        (colorType === 0 && chunkLength === 2) ||
        (colorType === 2 && chunkLength === 6) ||
        (colorType === 3 && seenPalette && chunkLength >= 1 && chunkLength <= paletteEntries);
      if (seenTransparency || seenIdat || !validTransparency) return invalid('MALFORMED_PNG');
      if (colorType === 0 || colorType === 2) {
        const sampleCount = colorType === 0 ? 1 : 3;
        const maximumSample = 2 ** bitDepth - 1;
        for (let sample = 0; sample < sampleCount; sample += 1) {
          if (readUint16(bytes, dataStart + sample * 2) > maximumSample) {
            return invalid('MALFORMED_PNG');
          }
        }
      }
      seenTransparency = true;
    } else if (type === 'tEXt') {
      const keywordLength = bytes.subarray(dataStart, dataEnd).indexOf(0);
      if (keywordLength < 1 || keywordLength > 79) return invalid('MALFORMED_PNG');
    } else if (type === 'tIME') {
      if (seenTime || chunkLength !== 7) return invalid('MALFORMED_PNG');
      const year = readUint16(bytes, dataStart);
      const month = bytes[dataStart + 2]!;
      const day = bytes[dataStart + 3]!;
      const hour = bytes[dataStart + 4]!;
      const minute = bytes[dataStart + 5]!;
      const second = bytes[dataStart + 6]!;
      const leapYear = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
      const daysInMonth =
        month === 2 ? (leapYear ? 29 : 28) : [4, 6, 9, 11].includes(month) ? 30 : 31;
      if (
        month < 1 ||
        month > 12 ||
        day < 1 ||
        day > daysInMonth ||
        hour > 23 ||
        minute > 59 ||
        second > 60
      ) {
        return invalid('MALFORMED_PNG');
      }
      seenTime = true;
    }

    if (type === 'IHDR') {
      if (seenHeader || chunkLength !== 13) return invalid('MALFORMED_PNG');
      width = readUint32(bytes, dataStart);
      height = readUint32(bytes, dataStart + 4);
      bitDepth = bytes[dataStart + 8]!;
      colorType = bytes[dataStart + 9]!;
      const compression = bytes[dataStart + 10]!;
      const filter = bytes[dataStart + 11]!;
      interlace = bytes[dataStart + 12]!;
      const validBitDepths = PNG_BIT_DEPTHS[colorType];
      if (
        width === 0 ||
        height === 0 ||
        !validBitDepths?.includes(bitDepth) ||
        compression !== 0 ||
        filter !== 0 ||
        (interlace !== 0 && interlace !== 1)
      ) {
        return invalid('MALFORMED_PNG');
      }
      if (width * height > MAX_DOCUMENT_IMAGE_PIXELS) return invalid('IMAGE_PIXEL_LIMIT');
      seenHeader = true;
    } else if (type === 'PLTE') {
      if (
        seenPalette ||
        seenIdat ||
        seenTransparency ||
        chunkLength === 0 ||
        chunkLength > 768 ||
        chunkLength % 3 !== 0 ||
        colorType === 0 ||
        colorType === 4 ||
        (colorType === 3 && chunkLength / 3 > 2 ** bitDepth)
      ) {
        return invalid('MALFORMED_PNG');
      }
      seenPalette = true;
      paletteEntries = chunkLength / 3;
    } else if (type === 'IDAT') {
      if (idatEnded) return invalid('MALFORMED_PNG');
      seenIdat = true;
      idatCompressedBytes += chunkLength;
      if (idatCompressedBytes > MAX_DOCUMENT_UPLOAD_BYTES) return invalid('MALFORMED_PNG');
      idatChunks.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      if (chunkLength !== 0 || !seenIdat || crcEnd !== bytes.byteLength) {
        return invalid('MALFORMED_PNG');
      }
      seenEnd = true;
    } else {
      if (seenIdat) idatEnded = true;
      const critical = (bytes[typeStart]! & 0x20) === 0;
      if (critical) return invalid('MALFORMED_PNG');
      if (type === 'acTL' || type === 'fcTL' || type === 'fdAT') return invalid('MALFORMED_PNG');
    }
    if (type !== 'IDAT' && seenIdat && type !== 'IEND') idatEnded = true;
    offset = crcEnd;
    if (type === 'IEND') break;
  }

  if (!seenHeader || !seenIdat || !seenEnd || (colorType === 3 && !seenPalette)) {
    return invalid('MALFORMED_PNG');
  }
  const channels = PNG_CHANNELS[colorType]!;
  const passes = pngPasses(width, height, bitDepth, channels, interlace);
  const expectedBytes = passes.reduce((sum, pass) => sum + (pass.rowBytes + 1) * pass.rows, 0);
  if (expectedBytes > MAX_DOCUMENT_PNG_DECOMPRESSED_BYTES) {
    return invalid('PNG_DECOMPRESSION_LIMIT');
  }
  const deflateInspection = await validatePngZlibStream(
    idatChunks,
    idatCompressedBytes,
    expectedBytes,
    signal,
  );
  if (deflateInspection === 'OUTPUT_LIMIT') return invalid('PNG_DECOMPRESSION_LIMIT');
  if (!deflateInspection) {
    return invalid('MALFORMED_PNG');
  }
  if (typeof DecompressionStream === 'undefined') return invalid('MALFORMED_PNG');

  let compressedChunkIndex = 0;
  let compressedChunkOffset = 0;
  const compressedStream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        while (compressedChunkIndex < idatChunks.length) {
          const chunk = idatChunks[compressedChunkIndex]!;
          if (compressedChunkOffset >= chunk.byteLength) {
            compressedChunkIndex += 1;
            compressedChunkOffset = 0;
            continue;
          }
          const end = Math.min(compressedChunkOffset + 64 * 1024, chunk.byteLength);
          controller.enqueue(chunk.subarray(compressedChunkOffset, end));
          compressedChunkOffset = end;
          return;
        }
        controller.close();
      },
    },
    { highWaterMark: 0 },
  );
  const decompressor = new DecompressionStream('deflate') as unknown as TransformStream<
    Uint8Array,
    Uint8Array
  >;
  const reader = compressedStream.pipeThrough(decompressor).getReader();
  const cancelOnAbort = () => {
    void reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener('abort', cancelOnAbort, { once: true });
  let outputBytes = 0;
  let filterBytesChecked = 0;
  let passIndex = 0;
  let rowIndex = 0;
  let rowFilterRead = false;
  let rowBytesRead = 0;
  const paletteRow =
    colorType === 3 ? new Uint8Array(Math.max(...passes.map((pass) => pass.rowBytes))) : null;
  let decompressionCompleted = false;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (signal?.aborted) throw new Error('CONTENT_INSPECTION_ABORTED');
      if (done) {
        decompressionCompleted = true;
        break;
      }
      if (outputBytes + value.byteLength > expectedBytes) return invalid('PNG_DECOMPRESSION_LIMIT');
      let valueOffset = 0;
      while (valueOffset < value.byteLength) {
        const pass = passes[passIndex];
        if (!pass) return invalid('MALFORMED_PNG');
        if (!rowFilterRead) {
          const filterType = value[valueOffset++]!;
          filterBytesChecked += 1;
          if (filterType > 4) return invalid('MALFORMED_PNG');
          if (colorType === 3 && filterType !== 0) return invalid('PNG_UNSUPPORTED_FEATURE');
          rowFilterRead = true;
        }
        const bytesToRead = Math.min(pass.rowBytes - rowBytesRead, value.byteLength - valueOffset);
        if (colorType === 3 && paletteRow) {
          paletteRow.set(value.subarray(valueOffset, valueOffset + bytesToRead), rowBytesRead);
        }
        valueOffset += bytesToRead;
        rowBytesRead += bytesToRead;
        if (rowBytesRead === pass.rowBytes) {
          if (
            colorType === 3 &&
            paletteRow &&
            !pngPaletteRowIsInRange(paletteRow, pass.width, bitDepth, paletteEntries)
          ) {
            return invalid('MALFORMED_PNG');
          }
          rowFilterRead = false;
          rowBytesRead = 0;
          rowIndex += 1;
          if (rowIndex === pass.rows) {
            passIndex += 1;
            rowIndex = 0;
          }
        }
      }
      outputBytes += value.byteLength;
    }
  } catch (error) {
    if (signal?.aborted) throw error;
    return invalid('MALFORMED_PNG');
  } finally {
    signal?.removeEventListener('abort', cancelOnAbort);
    if (!decompressionCompleted) {
      try {
        await reader.cancel();
      } catch {
        // The decompression stream may already be errored or canceled.
      }
    }
    reader.releaseLock();
  }
  const expectedFilterBytes = passes.reduce((sum, pass) => sum + pass.rows, 0);
  if (
    outputBytes !== expectedBytes ||
    filterBytesChecked !== expectedFilterBytes ||
    passIndex !== passes.length ||
    rowFilterRead ||
    rowBytesRead !== 0
  ) {
    return invalid('MALFORMED_PNG');
  }
  return {
    valid: true,
    format: 'PNG',
    width,
    height,
    pixelCount: width * height,
    decompressedBytes: outputBytes,
  };
}

export async function inspectDocumentContent(
  format: DocumentUploadFormat,
  bytes: Uint8Array<ArrayBuffer>,
  signal?: AbortSignal,
): Promise<DocumentContentInspectionResult> {
  if (signal?.aborted) throw new Error('CONTENT_INSPECTION_ABORTED');
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_DOCUMENT_UPLOAD_BYTES) {
    return format === 'PDF'
      ? invalid('MALFORMED_PDF')
      : invalid(format === 'JPEG' ? 'MALFORMED_JPEG' : 'MALFORMED_PNG');
  }
  if (format === 'JPEG') return inspectJpeg(bytes);
  if (format === 'PNG') return await inspectPng(bytes, signal);
  return inspectPdf(bytes);
}
