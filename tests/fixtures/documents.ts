import { encode as encodeJpeg } from 'jpeg-js';
import { deflateSync } from 'node:zlib';

const encoder = new TextEncoder();
const crcTable = new Uint32Array(256);

for (let index = 0; index < crcTable.length; index += 1) {
  let value = index;
  for (let bit = 0; bit < 8; bit += 1) {
    value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
  }
  crcTable[index] = value >>> 0;
}

function concatBytes(chunks: readonly Uint8Array[]): Uint8Array<ArrayBuffer> {
  const length = chunks.reduce((sum, chunk) => sum + chunk.byteLength, 0);
  const result = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    result.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return result;
}

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = crcTable[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const typeBytes = encoder.encode(type);
  const payload = concatBytes([typeBytes, data]);
  const chunk = new Uint8Array(12 + data.byteLength);
  const view = new DataView(chunk.buffer);
  view.setUint32(0, data.byteLength, false);
  chunk.set(payload, 4);
  view.setUint32(8 + data.byteLength, crc32(payload), false);
  return chunk;
}

export function createSyntheticPng(
  width: number,
  height: number,
  inflatedData?: Uint8Array,
): Uint8Array<ArrayBuffer> {
  const rowBytes = width * 4;
  const raw =
    inflatedData ??
    (() => {
      const rows = new Uint8Array(height * (rowBytes + 1));
      for (let row = 0; row < height; row += 1) {
        const start = row * (rowBytes + 1);
        rows[start] = 0;
        for (let pixel = 0; pixel < width; pixel += 1) rows[start + 1 + pixel * 4 + 3] = 0xff;
      }
      return rows;
    })();
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width, false);
  view.setUint32(4, height, false);
  ihdr.set([8, 6, 0, 0, 0], 8);
  return concatBytes([
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', new Uint8Array(deflateSync(raw))),
    pngChunk('IEND', new Uint8Array()),
  ]);
}

export function createSyntheticPngWithInvalidGrayPalette(): Uint8Array<ArrayBuffer> {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, 1, false);
  view.setUint32(4, 1, false);
  ihdr.set([8, 0, 0, 0, 0], 8);
  return concatBytes([
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk('IHDR', ihdr),
    pngChunk('PLTE', Uint8Array.of(0, 0, 0)),
    pngChunk('IDAT', new Uint8Array(deflateSync(Uint8Array.of(0, 100)))),
    pngChunk('IEND', new Uint8Array()),
  ]);
}

export function createSyntheticPngWithPalette(paletteEntries: number): Uint8Array<ArrayBuffer> {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, 1, false);
  view.setUint32(4, 1, false);
  ihdr.set([1, 3, 0, 0, 0], 8);
  return concatBytes([
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk('IHDR', ihdr),
    pngChunk('PLTE', new Uint8Array(paletteEntries * 3)),
    pngChunk('IDAT', new Uint8Array(deflateSync(Uint8Array.of(0, 0)))),
    pngChunk('IEND', new Uint8Array()),
  ]);
}

export function createSyntheticPngWithExcessiveDecompressedSize(): Uint8Array<ArrayBuffer> {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, 4_000, false);
  view.setUint32(4, 4_000, false);
  ihdr.set([16, 6, 0, 0, 0], 8);
  return concatBytes([
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', new Uint8Array(deflateSync(Uint8Array.of(0)))),
    pngChunk('IEND', new Uint8Array()),
  ]);
}

export function createSyntheticPngWithCompressedAncillaryChunk(
  type: 'iCCP' | 'zTXt' | 'iTXt' | 'acTL' | 'fcTL' | 'fdAT',
): Uint8Array<ArrayBuffer> {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, 1, false);
  view.setUint32(4, 1, false);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const highExpansion = new Uint8Array(deflateSync(new Uint8Array(2 * 1024 * 1024)));
  const name = encoder.encode('profile');
  let data: Uint8Array;
  if (type === 'iCCP' || type === 'zTXt') {
    data = concatBytes([name, Uint8Array.of(0, 0), highExpansion]);
  } else if (type === 'iTXt') {
    data = concatBytes([name, Uint8Array.of(0, 1, 0, 0, 0), highExpansion]);
  } else if (type === 'fdAT') {
    data = concatBytes([Uint8Array.of(0, 0, 0, 0), highExpansion]);
  } else if (type === 'acTL') {
    data = Uint8Array.of(0, 0, 0, 1, 0, 0, 0, 0);
  } else {
    data = new Uint8Array(26);
  }
  const signature = Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a);
  const ihdrChunk = pngChunk('IHDR', ihdr);
  const idatChunk = pngChunk('IDAT', new Uint8Array(deflateSync(Uint8Array.of(0, 0, 0, 0, 0))));
  const ancillaryChunk = pngChunk(type, data);
  const chunks = [signature, ihdrChunk];
  if (type === 'fdAT') chunks.push(idatChunk, ancillaryChunk);
  else chunks.push(ancillaryChunk, idatChunk);
  chunks.push(pngChunk('IEND', new Uint8Array()));
  return concatBytes(chunks);
}

export function createSyntheticPngWithTransparencyAfterIdat(): Uint8Array<ArrayBuffer> {
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 1, false);
  new DataView(ihdr.buffer).setUint32(4, 1, false);
  ihdr[8] = 8;
  ihdr[9] = 0;
  return concatBytes([
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', deflateSync(Uint8Array.of(0, 0))),
    pngChunk('tRNS', Uint8Array.of(0, 1)),
    pngChunk('IEND', new Uint8Array()),
  ]);
}

export function createSyntheticPngWithOutOfRangePaletteIndex(): Uint8Array<ArrayBuffer> {
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 1, false);
  new DataView(ihdr.buffer).setUint32(4, 1, false);
  ihdr.set([1, 3, 0, 0, 0], 8);
  return concatBytes([
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('PLTE', Uint8Array.of(0, 0, 0)),
    pngChunk('IDAT', deflateSync(Uint8Array.of(0, 0x80))),
    pngChunk('IEND', new Uint8Array()),
  ]);
}

export function createSyntheticPngWithOutOfRangeTransparencySample(): Uint8Array<ArrayBuffer> {
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 1, false);
  new DataView(ihdr.buffer).setUint32(4, 1, false);
  ihdr.set([1, 0, 0, 0, 0], 8);
  return concatBytes([
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('tRNS', Uint8Array.of(0, 2)),
    pngChunk('IDAT', deflateSync(Uint8Array.of(0, 0))),
    pngChunk('IEND', new Uint8Array()),
  ]);
}

export function createSyntheticPngWithDuplicateTransparency(): Uint8Array<ArrayBuffer> {
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 1, false);
  new DataView(ihdr.buffer).setUint32(4, 1, false);
  ihdr.set([8, 0, 0, 0, 0], 8);
  const transparency = pngChunk('tRNS', Uint8Array.of(0, 1));
  return concatBytes([
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    transparency,
    transparency,
    pngChunk('IDAT', deflateSync(Uint8Array.of(0, 0))),
    pngChunk('IEND', new Uint8Array()),
  ]);
}

export function createSyntheticPngWithTransparencyBeforePalette(): Uint8Array<ArrayBuffer> {
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 1, false);
  new DataView(ihdr.buffer).setUint32(4, 1, false);
  ihdr.set([8, 2, 0, 0, 0], 8);
  return concatBytes([
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('tRNS', new Uint8Array(6)),
    pngChunk('PLTE', Uint8Array.of(0, 0, 0)),
    pngChunk('IDAT', deflateSync(Uint8Array.of(0, 0, 0, 0))),
    pngChunk('IEND', new Uint8Array()),
  ]);
}

export function createSyntheticPngWithInvalidTime(): Uint8Array<ArrayBuffer> {
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 1, false);
  new DataView(ihdr.buffer).setUint32(4, 1, false);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const invalidTime = Uint8Array.of(0x07, 0xe8, 13, 1, 0, 0, 0);
  return concatBytes([
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('tIME', invalidTime),
    pngChunk('IDAT', deflateSync(Uint8Array.of(0, 0, 0, 0, 0))),
    pngChunk('IEND', new Uint8Array()),
  ]);
}

export function createSyntheticPngWithDuplicateTime(): Uint8Array<ArrayBuffer> {
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 1, false);
  new DataView(ihdr.buffer).setUint32(4, 1, false);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const time = Uint8Array.of(0x07, 0xe8, 1, 1, 0, 0, 0);
  return concatBytes([
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('tIME', time),
    pngChunk('tIME', time),
    pngChunk('IDAT', deflateSync(Uint8Array.of(0, 0, 0, 0, 0))),
    pngChunk('IEND', new Uint8Array()),
  ]);
}

export function createSyntheticPngWithTrailingDeflateBytes(): Uint8Array<ArrayBuffer> {
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 1, false);
  new DataView(ihdr.buffer).setUint32(4, 1, false);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const compressed = deflateSync(Uint8Array.of(0, 0, 0, 0, 0));
  return concatBytes([
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', concatBytes([compressed, Uint8Array.of(1, 2, 3, 4)])),
    pngChunk('IEND', new Uint8Array()),
  ]);
}

export function createSyntheticPngWithUnknownAncillaryChunk(): Uint8Array<ArrayBuffer> {
  const ihdr = new Uint8Array(13);
  new DataView(ihdr.buffer).setUint32(0, 1, false);
  new DataView(ihdr.buffer).setUint32(4, 1, false);
  ihdr[8] = 8;
  ihdr[9] = 6;
  const payload = deflateSync(new Uint8Array(1024 * 1024));
  const idat = deflateSync(Uint8Array.of(0, 0, 0, 0, 0));
  return concatBytes([
    Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk('IHDR', ihdr),
    pngChunk('vpAg', payload),
    pngChunk('IDAT', idat),
    pngChunk('IEND', new Uint8Array()),
  ]);
}

export function createSyntheticPngWithManyChunks(
  ancillaryChunkCount: number,
): Uint8Array<ArrayBuffer> {
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, 1, false);
  view.setUint32(4, 1, false);
  ihdr.set([8, 6, 0, 0, 0], 8);
  const chunks = [
    Uint8Array.of(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', new Uint8Array(deflateSync(Uint8Array.of(0, 0, 0, 0, 0)))),
  ];
  for (let index = 0; index < ancillaryChunkCount; index += 1) {
    chunks.push(pngChunk('tEXt', Uint8Array.of(0x78, 0)));
  }
  chunks.push(pngChunk('IEND', new Uint8Array()));
  return concatBytes(chunks);
}

export function createSyntheticJpeg(width: number, height: number): Uint8Array<ArrayBuffer> {
  const rgba = new Uint8Array(width * height * 4);
  for (let index = 3; index < rgba.length; index += 4) rgba[index] = 0xff;
  return Uint8Array.from(encodeJpeg({ data: Buffer.from(rgba), width, height }, 80).data);
}

export function createSyntheticJpegWithHiddenScans(
  marker: 0xdd | 0xdc,
  includeHiddenScans = true,
): Uint8Array<ArrayBuffer> {
  const jpeg = createSyntheticJpeg(64, 64);
  let offset = 2;
  while (offset + 4 < jpeg.byteLength) {
    const markerStart = offset;
    if (jpeg[offset++] !== 0xff) throw new Error('Malformed synthetic JPEG marker');
    const currentMarker = jpeg[offset++]!;
    const length = (jpeg[offset]! << 8) | jpeg[offset + 1]!;
    if (currentMarker === 0xda) {
      const scan = jpeg.subarray(markerStart, jpeg.byteLength - 2);
      const hidden = concatBytes([
        Uint8Array.of(0, 0),
        ...(includeHiddenScans ? [scan, scan, scan] : []),
      ]);
      const hiddenLength = hidden.byteLength + 2;
      return concatBytes([
        jpeg.subarray(0, markerStart),
        Uint8Array.of(0xff, marker, hiddenLength >>> 8, hiddenLength & 0xff),
        hidden,
        jpeg.subarray(markerStart),
      ]);
    }
    offset += length;
  }
  throw new Error('Synthetic JPEG scan missing');
}

export interface SyntheticPdfOptions {
  readonly pageCount?: number;
  readonly comment?: string;
  readonly catalogEntries?: string;
  readonly activeJavaScript?: boolean;
  readonly pageOpenJavaScript?: boolean;
  readonly pageOpenLaunch?: boolean;
  readonly pageOpenUri?: boolean;
  readonly pageOpenRichMediaExecute?: boolean;
  readonly linkedRichMediaExecute?: boolean;
  readonly linkedGoToAction?: boolean;
  readonly unclassifiedAction?: boolean;
  readonly encrypted?: boolean;
  readonly highCompressionStream?: boolean;
  readonly extraObjectCount?: number;
  readonly extraTokenCount?: number;
  readonly malformedRoot?: boolean;
  readonly malformedRootGeneration?: boolean;
  readonly invalidTrailerSize?: boolean;
  readonly rootObjectMissingFromXref?: boolean;
  readonly omitTrailerRoot?: boolean;
  readonly rootOutsideTrailerDictionary?: boolean;
  readonly nestedRootOnly?: boolean;
  readonly invalidPageTree?: 'catalog-pages-reference' | 'dangling-kid' | 'wrong-count';
  readonly rootCatalogAsArray?: boolean;
  readonly oversizedPageGeometry?: boolean;
  readonly missingMediaBox?: boolean;
  readonly largeUserUnit?: boolean;
  readonly nestedPageTree?: boolean;
  readonly invalidResourcesReference?: boolean;
  readonly invalidContentReference?: 'missing' | 'non-stream';
}

export function createSyntheticPdf(options: SyntheticPdfOptions = {}): Uint8Array<ArrayBuffer> {
  if (options.highCompressionStream) {
    return createSyntheticPdfWithHighCompressionStream({
      ...options,
      highCompressionStream: false,
    });
  }
  const pageCount = options.pageCount ?? 1;
  const hasJavaScript = options.activeJavaScript === true || options.pageOpenJavaScript === true;
  const hasPageOpenAction =
    options.pageOpenJavaScript === true ||
    options.pageOpenLaunch === true ||
    options.pageOpenUri === true ||
    options.pageOpenRichMediaExecute === true;
  const hasAction =
    hasJavaScript ||
    options.pageOpenLaunch === true ||
    options.pageOpenUri === true ||
    options.pageOpenRichMediaExecute === true ||
    options.linkedRichMediaExecute === true ||
    options.linkedGoToAction === true;
  const nestedPagesObjectId = pageCount + 3;
  const actionObjectId = 3 + pageCount + (options.nestedPageTree ? 1 : 0);
  const pageMediaBox =
    options.nestedPageTree || options.missingMediaBox
      ? ''
      : options.oversizedPageGeometry
        ? '/MediaBox [0 0 4001 4000]'
        : '/MediaBox [0 0 612 792]';
  const pageUserUnit = options.largeUserUnit ? '/UserUnit 100' : '';
  const pageParentReference = options.nestedPageTree ? `${nestedPagesObjectId} 0 R` : '2 0 R';
  const pageResourcesReference = options.invalidResourcesReference
    ? '/Resources 999 0 R'
    : '/Resources << >>';
  const pageContentsReference =
    options.invalidContentReference === 'missing'
      ? '/Contents 999 0 R'
      : options.invalidContentReference === 'non-stream'
        ? `/Contents ${actionObjectId} 0 R`
        : '';
  const pageObjects: string[] = [];
  const kids: string[] = [];
  for (let page = 0; page < pageCount; page += 1) {
    const pageObjectId = 3 + page;
    kids.push(`${pageObjectId} 0 R`);
    const pageAction = hasPageOpenAction ? ` /AA << /O ${actionObjectId} 0 R >>` : '';
    const linkedAction =
      options.linkedRichMediaExecute || options.linkedGoToAction
        ? ` /Annots [<< /A ${actionObjectId} 0 R >>]`
        : '';
    pageObjects.push(
      `<< /Type /Page /Parent ${pageParentReference} ${pageMediaBox} ${pageUserUnit} ${pageResourcesReference} ${pageContentsReference}${pageAction}${linkedAction} >>`,
    );
  }
  const encryptObjectId = hasAction ? actionObjectId + 1 : actionObjectId;
  const catalogAction = options.activeJavaScript ? ` /OpenAction ${actionObjectId} 0 R` : '';
  const pagesReference = options.invalidPageTree === 'catalog-pages-reference' ? '99 0 R' : '2 0 R';
  const pageKids = options.invalidPageTree === 'dangling-kid' ? '999 0 R' : kids.join(' ');
  const pagesCount = options.invalidPageTree === 'wrong-count' ? pageCount + 1 : pageCount;
  const rootPageTreeKids = options.nestedPageTree ? `${nestedPagesObjectId} 0 R` : pageKids;
  const rootPageTreeMediaBox = options.nestedPageTree ? ' /MediaBox [0 0 612 792]' : '';
  const catalogBody = options.rootCatalogAsArray
    ? `[/Type /Catalog /Pages ${pagesReference}]`
    : `<< /Type /Catalog /Pages ${pagesReference}${catalogAction} ${options.catalogEntries ?? ''} >>`;
  const objects = [
    catalogBody,
    `<< /Type /Pages /Kids [${rootPageTreeKids}] /Count ${pagesCount}${rootPageTreeMediaBox} >>`,
    ...pageObjects,
  ];
  if (options.nestedPageTree) {
    objects.push(`<< /Type /Pages /Parent 2 0 R /Kids [${pageKids}] /Count ${pagesCount} >>`);
  }
  if (hasJavaScript) {
    objects.push('<< /S /JavaScript /JS (app.alert\\(1\\)) >>');
  } else if (options.pageOpenLaunch) {
    objects.push('<< /S /Launch /F (synthetic.exe) >>');
  } else if (options.pageOpenUri) {
    objects.push('<< /S /URI /URI (https://example.invalid/) >>');
  } else if (options.linkedGoToAction) {
    objects.push('<< /S /GoTo /D [3 0 R /Fit] >>');
  } else if (options.pageOpenRichMediaExecute || options.linkedRichMediaExecute) {
    objects.push('<< /S /RichMediaExecute /Instance 4 0 R >>');
  }
  if (options.unclassifiedAction) objects.push('<< /S /VendorSpecificAction >>');
  if (options.encrypted) {
    objects.push(
      '<< /Filter /Standard /V 1 /R 2 /O <' +
        '11'.repeat(32) +
        '> /U <' +
        '22'.repeat(32) +
        '> /P -4 >>',
    );
  }

  for (let index = 0; index < (options.extraObjectCount ?? 0); index += 1) {
    objects.push('<< /Type /Synthetic >>');
  }
  if (options.extraTokenCount) {
    objects.push(
      `<< /Values [${new Array<string>(options.extraTokenCount).fill('0').join(' ')}] >>`,
    );
  }

  const header = `%PDF-1.7\n% ${options.comment ?? 'synthetic fixture'}\n`;
  const parts = [header];
  const offsets = [0];
  let byteLength = encoder.encode(header).byteLength;
  for (const [index, body] of objects.entries()) {
    offsets.push(byteLength);
    const object = `${index + 1} 0 obj\n${body}\nendobj\n`;
    parts.push(object);
    byteLength += encoder.encode(object).byteLength;
  }
  const xrefOffset = byteLength;
  const trailerRoot = options.omitTrailerRoot
    ? options.nestedRootOnly
      ? '/Info << /Root 1 0 R >>'
      : ''
    : options.malformedRoot
      ? '/Root null'
      : options.malformedRootGeneration
        ? '/Root 1 9 R'
        : '/Root 1 0 R';
  const rootOutsideTrailer = options.rootOutsideTrailerDictionary
    ? `<< /Root 1 0 R >>${String.fromCharCode(10)}`
    : '';
  const lineFeed = String.fromCharCode(10);
  const xref = [
    `xref${lineFeed}0 ${objects.length + 1}${lineFeed}`,
    `0000000000 65535 f ${lineFeed}`,
    ...offsets
      .slice(1)
      .map((offset, index) =>
        index === 0 && options.rootObjectMissingFromXref
          ? `0000000000 00000 f ${lineFeed}`
          : `${String(offset).padStart(10, '0')} 00000 n ${lineFeed}`,
      ),
    `trailer${lineFeed}<< /Size ${options.invalidTrailerSize ? 0 : objects.length + 1} ${trailerRoot}${options.encrypted ? ` /Encrypt ${encryptObjectId} 0 R /ID [<${'33'.repeat(16)}> <${'44'.repeat(16)}>]` : ''} >>${lineFeed}`,
    rootOutsideTrailer,
    `startxref${lineFeed}${xrefOffset}${lineFeed}%%EOF${lineFeed}`,
  ].join('');
  parts.push(xref);
  return encoder.encode(parts.join(''));
}

export function createSyntheticPdfWithXrefCommentAmplification(): Uint8Array<ArrayBuffer> {
  // Each forged offset points into one comment. An unbounded header tokenizer would
  // reread its entire tail for every entry before rejecting the malformed object list.
  const count = 64;
  const header = `%PDF-1.7\n% ${Array.from({ length: count }, (_, index) => `${index + 1} %`).join(' ')}${'x'.repeat(8 * 1024)}\n0 obj\n<< >>\nendobj\n`;
  const offsets = Array.from({ length: count }, (_, index) => header.indexOf(`${index + 1} %`));
  const xrefOffset = encoder.encode(header).byteLength;
  return encoder.encode(
    [
      header,
      `xref\n0 ${count + 1}\n0000000000 65535 f \n`,
      ...offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`),
      `trailer\n<< /Size ${count + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`,
    ].join(''),
  );
}

function createSyntheticPdfWithHighCompressionStream(
  baseOptions: SyntheticPdfOptions,
): Uint8Array<ArrayBuffer> {
  const lineFeed = String.fromCharCode(10);
  const compressed = deflateSync(new Uint8Array(16 * 1024 * 1024).fill(0x20));
  const header = encoder.encode(
    `%PDF-1.7${lineFeed}% ${baseOptions.comment ?? 'high-ratio fixture'}${lineFeed}`,
  );
  const chunks: Uint8Array[] = [header];
  const objectOffsets = [0];
  let offset = header.byteLength;
  const objectBodies = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << >> /Contents 4 0 R >>',
  ];
  for (const [index, body] of objectBodies.entries()) {
    objectOffsets.push(offset);
    const object = encoder.encode(
      `${index + 1} 0 obj${lineFeed}${body}${lineFeed}endobj${lineFeed}`,
    );
    chunks.push(object);
    offset += object.byteLength;
  }
  objectOffsets.push(offset);
  const streamPrefix = encoder.encode(
    `4 0 obj${lineFeed}<< /Length ${compressed.byteLength} /Filter /FlateDecode >>${lineFeed}stream${lineFeed}`,
  );
  const streamSuffix = encoder.encode(`${lineFeed}endstream${lineFeed}endobj${lineFeed}`);
  chunks.push(streamPrefix, compressed, streamSuffix);
  offset += streamPrefix.byteLength + compressed.byteLength + streamSuffix.byteLength;
  const xrefOffset = offset;
  const xref = [
    `xref${lineFeed}0 5${lineFeed}`,
    '0000000000 65535 f \n',
    ...objectOffsets
      .slice(1)
      .map((objectOffset) => `${String(objectOffset).padStart(10, '0')} 00000 n \n`),
    `trailer${lineFeed}<< /Size 5 /Root 1 0 R >>${lineFeed}`,
    `startxref${lineFeed}${xrefOffset}${lineFeed}%%EOF${lineFeed}`,
  ].join('');
  chunks.push(encoder.encode(xref));
  return concatBytes(chunks);
}

export function createSyntheticPdfWithImage(
  width: number,
  height: number,
  nestedDimensions?: { readonly width: number; readonly height: number },
  duplicateDimensions?: { readonly width: number; readonly height: number },
  duplicateStreamLength = false,
  xrefObjectIntoStream = false,
  wrongImageStreamLength = false,
): Uint8Array<ArrayBuffer> {
  const nestedImageDimensions = nestedDimensions
    ? ` /Extra << /Width ${nestedDimensions.width} /Height ${nestedDimensions.height} >>`
    : '';
  const duplicateImageDimensions = duplicateDimensions
    ? ` /Width ${duplicateDimensions.width} /Height ${duplicateDimensions.height}`
    : '';
  const imageColorSpace = xrefObjectIntoStream ? '/DeviceGray' : '/DeviceRGB';
  const imageComponents = xrefObjectIntoStream ? 1 : 3;
  const expectedImageLength = width * height * imageComponents;
  const imageDataLength = xrefObjectIntoStream
    ? 7
    : expectedImageLength <= 20 * 1024 * 1024
      ? expectedImageLength + (wrongImageStreamLength ? 1 : 0)
      : 3;
  const imageLength = duplicateStreamLength
    ? `/Length 1 /Length ${imageDataLength}`
    : `/Length ${imageDataLength}`;
  const imageData = xrefObjectIntoStream
    ? '4 0 obj'
    : String.fromCharCode(0).repeat(Math.max(3, imageDataLength));
  const content = 'q 100 0 0 100 0 0 cm /Im1 Do Q\n';
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>',
    `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height}${nestedImageDimensions}${duplicateImageDimensions} /ColorSpace ${imageColorSpace} /BitsPerComponent 8 ${imageLength} >>\nstream\n${imageData}\nendstream`,
    `<< /Length ${encoder.encode(content).byteLength} >>\nstream\n${content}endstream`,
  ];
  const header = '%PDF-1.7\n% synthetic image fixture\n';
  const parts = [header];
  const offsets = [0];
  let byteLength = encoder.encode(header).byteLength;
  for (const [index, body] of objects.entries()) {
    offsets.push(byteLength);
    const object = `${index + 1} 0 obj\n${body}\nendobj\n`;
    parts.push(object);
    byteLength += encoder.encode(object).byteLength;
  }
  const lineFeed = String.fromCharCode(10);
  const imageStreamMarkerEnd =
    objects[3]!.indexOf(`stream${lineFeed}`) + `stream${lineFeed}`.length;
  const imageStreamPayloadOffset =
    offsets[4]! +
    encoder.encode(`4 0 obj${lineFeed}`).byteLength +
    encoder.encode(objects[3]!.slice(0, imageStreamMarkerEnd)).byteLength;
  const xrefOffset = byteLength;
  parts.push(
    [
      `xref\n0 ${objects.length + 1}\n`,
      '0000000000 65535 f \n',
      ...offsets.slice(1).map((offset, index) => {
        const entryOffset = xrefObjectIntoStream && index === 3 ? imageStreamPayloadOffset : offset;
        return `${String(entryOffset).padStart(10, '0')} 00000 n \n`;
      }),
      `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\n`,
      `startxref\n${xrefOffset}\n%%EOF\n`,
    ].join(''),
  );
  return encoder.encode(parts.join(''));
}
