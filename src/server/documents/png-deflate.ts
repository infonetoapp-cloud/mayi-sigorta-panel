export const MAX_PNG_DEFLATE_BLOCKS = 65_536;
export const MAX_PNG_DEFLATE_SYMBOLS = 8_000_000;

interface DeflateHuffmanTable {
  readonly symbols: readonly (ReadonlyMap<number, number> | undefined)[];
  readonly maxLength: number;
}

class PngDeflateBitReader {
  private chunkIndex = 0;
  private chunkOffset = 0;
  private bitBuffer = 0;
  private bitCount = 0;
  private position: number;

  constructor(
    private readonly chunks: readonly Uint8Array[],
    start: number,
    readonly limit: number,
  ) {
    this.position = start;
    let remaining = start;
    while (this.chunkIndex < chunks.length) {
      const chunk = chunks[this.chunkIndex]!;
      if (remaining < chunk.byteLength) {
        this.chunkOffset = remaining;
        return;
      }
      remaining -= chunk.byteLength;
      this.chunkIndex += 1;
    }
    this.chunkOffset = 0;
  }

  get bytesConsumed(): number {
    return this.position;
  }

  readBits(count: number): number | null {
    if (count < 0 || count > 16) return null;
    while (this.bitCount < count) {
      const byte = this.readByte();
      if (byte === null) return null;
      this.bitBuffer |= byte << this.bitCount;
      this.bitCount += 8;
    }
    const mask = count === 0 ? 0 : (1 << count) - 1;
    const value = this.bitBuffer & mask;
    this.bitBuffer >>>= count;
    this.bitCount -= count;
    return value;
  }

  alignToByte(): void {
    this.bitBuffer = 0;
    this.bitCount = 0;
  }

  skipBytes(count: number): boolean {
    if (this.bitCount !== 0 || count < 0 || this.position + count > this.limit) return false;
    let remaining = count;
    while (remaining > 0) {
      while (
        this.chunkIndex < this.chunks.length &&
        this.chunkOffset >= this.chunks[this.chunkIndex]!.byteLength
      ) {
        this.chunkIndex += 1;
        this.chunkOffset = 0;
      }
      const chunk = this.chunks[this.chunkIndex];
      if (!chunk) return false;
      const available = chunk.byteLength - this.chunkOffset;
      const skipped = Math.min(remaining, available);
      this.chunkOffset += skipped;
      this.position += skipped;
      remaining -= skipped;
    }
    return true;
  }

  private readByte(): number | null {
    if (this.position >= this.limit) return null;
    while (
      this.chunkIndex < this.chunks.length &&
      this.chunkOffset >= this.chunks[this.chunkIndex]!.byteLength
    ) {
      this.chunkIndex += 1;
      this.chunkOffset = 0;
    }
    const chunk = this.chunks[this.chunkIndex];
    if (!chunk) return null;
    const value = chunk[this.chunkOffset]!;
    this.chunkOffset += 1;
    this.position += 1;
    return value;
  }
}

function byteAt(chunks: readonly Uint8Array[], index: number): number | null {
  let remaining = index;
  for (const chunk of chunks) {
    if (remaining < chunk.byteLength) return chunk[remaining]!;
    remaining -= chunk.byteLength;
  }
  return null;
}

function buildHuffmanTable(lengths: readonly number[]): DeflateHuffmanTable | null {
  const counts = new Array<number>(16).fill(0);
  let maxLength = 0;
  let symbolCount = 0;
  for (const length of lengths) {
    if (!Number.isInteger(length) || length < 0 || length > 15) return null;
    if (length > 0) {
      counts[length] = counts[length]! + 1;
      maxLength = Math.max(maxLength, length);
      symbolCount += 1;
    }
  }
  if (symbolCount === 0) return null;

  let availableCodes = 1;
  for (let length = 1; length <= 15; length += 1) {
    availableCodes = availableCodes * 2 - counts[length]!;
    if (availableCodes < 0) return null;
  }

  const nextCode = new Array<number>(16).fill(0);
  let code = 0;
  for (let length = 1; length <= 15; length += 1) {
    code = (code + counts[length - 1]!) << 1;
    nextCode[length] = code;
  }

  const symbols: Map<number, number>[] = Array.from({ length: 16 }, () => new Map());
  for (let symbol = 0; symbol < lengths.length; symbol += 1) {
    const length = lengths[symbol]!;
    if (length === 0) continue;
    symbols[length]!.set(nextCode[length]!, symbol);
    nextCode[length] = nextCode[length]! + 1;
  }
  return { symbols, maxLength };
}

function readHuffmanSymbol(reader: PngDeflateBitReader, table: DeflateHuffmanTable): number | null {
  let code = 0;
  for (let length = 1; length <= table.maxLength; length += 1) {
    const bit = reader.readBits(1);
    if (bit === null) return null;
    code = (code << 1) | bit;
    const symbol = table.symbols[length]!.get(code);
    if (symbol !== undefined) return symbol;
  }
  return null;
}

const LENGTH_EXTRA = [
  0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0,
] as const;
const LENGTH_BASE = [
  3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131,
  163, 195, 227, 258,
] as const;
const DISTANCE_BASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049,
  3073, 4097, 6145, 8193, 12289, 16385, 24577,
] as const;
const DISTANCE_EXTRA = [
  0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13,
] as const;
const CODE_LENGTH_ORDER = [
  16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15,
] as const;
const FIXED_LITERAL_LENGTHS = Array.from({ length: 288 }, (_, index) =>
  index <= 143 ? 8 : index <= 255 ? 9 : index <= 279 ? 7 : 8,
);
const FIXED_DISTANCE_LENGTHS = new Array<number>(32).fill(5);
const FIXED_LITERAL_TABLE = buildHuffmanTable(FIXED_LITERAL_LENGTHS)!;
const FIXED_DISTANCE_TABLE = buildHuffmanTable(FIXED_DISTANCE_LENGTHS)!;

function readDynamicTables(
  reader: PngDeflateBitReader,
): { literal: DeflateHuffmanTable; distance: DeflateHuffmanTable | null } | null {
  const literalCountBits = reader.readBits(5);
  const distanceCountBits = reader.readBits(5);
  const codeCountBits = reader.readBits(4);
  if (literalCountBits === null || distanceCountBits === null || codeCountBits === null)
    return null;

  const literalCount = literalCountBits + 257;
  const distanceCount = distanceCountBits + 1;
  const codeCount = codeCountBits + 4;
  const codeLengths = new Array<number>(19).fill(0);
  for (let index = 0; index < codeCount; index += 1) {
    const length = reader.readBits(3);
    if (length === null) return null;
    codeLengths[CODE_LENGTH_ORDER[index]!] = length;
  }
  const codeLengthTable = buildHuffmanTable(codeLengths);
  if (!codeLengthTable) return null;

  const totalCodes = literalCount + distanceCount;
  const codeLengthsCombined: number[] = [];
  while (codeLengthsCombined.length < totalCodes) {
    const symbol = readHuffmanSymbol(reader, codeLengthTable);
    if (symbol === null) return null;
    if (symbol <= 15) {
      codeLengthsCombined.push(symbol);
      continue;
    }
    if (symbol === 16) {
      if (codeLengthsCombined.length === 0) return null;
      const extra = reader.readBits(2);
      if (extra === null) return null;
      const repeatCount = extra + 3;
      if (codeLengthsCombined.length + repeatCount > totalCodes) return null;
      const priorLength = codeLengthsCombined[codeLengthsCombined.length - 1]!;
      for (let repeat = 0; repeat < repeatCount; repeat += 1) codeLengthsCombined.push(priorLength);
      continue;
    }
    if (symbol === 17 || symbol === 18) {
      const extraBits = symbol === 17 ? 3 : 7;
      const extra = reader.readBits(extraBits);
      if (extra === null) return null;
      const repeatCount = extra + (symbol === 17 ? 3 : 11);
      if (codeLengthsCombined.length + repeatCount > totalCodes) return null;
      for (let repeat = 0; repeat < repeatCount; repeat += 1) codeLengthsCombined.push(0);
      continue;
    }
    return null;
  }

  const literalLengths = codeLengthsCombined.slice(0, literalCount);
  const distanceLengths = codeLengthsCombined.slice(literalCount);
  if (literalLengths[256] === 0) return null;
  const literal = buildHuffmanTable(literalLengths);
  const distance = buildHuffmanTable(distanceLengths);
  if (!literal) return null;
  return { literal, distance };
}

export async function validatePngZlibStream(
  chunks: readonly Uint8Array[],
  totalBytes: number,
  maximumOutputBytes: number,
  signal?: AbortSignal,
): Promise<boolean | 'OUTPUT_LIMIT'> {
  if (totalBytes < 6) return false;
  const cmf = byteAt(chunks, 0);
  const flg = byteAt(chunks, 1);
  if (
    cmf === null ||
    flg === null ||
    (cmf & 0x0f) !== 8 ||
    cmf >>> 4 > 7 ||
    ((cmf << 8) | flg) % 31 !== 0 ||
    (flg & 0x20) !== 0
  ) {
    return false;
  }

  const reader = new PngDeflateBitReader(chunks, 2, totalBytes - 4);
  let finalBlock = false;
  let blockCount = 0;
  let symbolCount = 0;
  // Count output without allocating it. Native inflation requires this bound to pass.
  let outputBytes = 0;
  while (!finalBlock) {
    if (signal?.aborted) throw new Error('CONTENT_INSPECTION_ABORTED');
    blockCount += 1;
    if (blockCount > MAX_PNG_DEFLATE_BLOCKS) return false;
    const finalBit = reader.readBits(1);
    const blockType = reader.readBits(2);
    if (finalBit === null || blockType === null) return false;
    finalBlock = finalBit === 1;

    if (blockType === 0) {
      reader.alignToByte();
      const length = reader.readBits(16);
      const complement = reader.readBits(16);
      if (length === null || complement === null || ((length ^ complement) & 0xffff) !== 0xffff) {
        return false;
      }
      if (!reader.skipBytes(length)) return false;
      outputBytes += length;
      if (outputBytes > maximumOutputBytes) return 'OUTPUT_LIMIT';
      continue;
    }
    if (blockType === 3) return false;

    const tables =
      blockType === 1
        ? { literal: FIXED_LITERAL_TABLE, distance: FIXED_DISTANCE_TABLE }
        : readDynamicTables(reader);
    if (!tables) return false;

    let endOfBlock = false;
    while (!endOfBlock) {
      const symbol = readHuffmanSymbol(reader, tables.literal);
      if (symbol === null) return false;
      symbolCount += 1;
      if (symbolCount > MAX_PNG_DEFLATE_SYMBOLS) return false;
      if (symbol === 256) {
        endOfBlock = true;
      } else if (symbol < 256) {
        outputBytes += 1;
      } else if (symbol >= 257 && symbol <= 285) {
        const lengthExtraBits = LENGTH_EXTRA[symbol - 257]!;
        const lengthExtra = reader.readBits(lengthExtraBits);
        if (lengthExtra === null) return false;
        const length = LENGTH_BASE[symbol - 257]! + lengthExtra;
        if (!tables.distance) return false;
        const distanceSymbol = readHuffmanSymbol(reader, tables.distance);
        if (distanceSymbol === null || distanceSymbol > 29) return false;
        const distanceExtraBits = DISTANCE_EXTRA[distanceSymbol]!;
        const distanceExtra = reader.readBits(distanceExtraBits);
        if (distanceExtra === null) return false;
        const distance = DISTANCE_BASE[distanceSymbol]! + distanceExtra;
        if (distance > outputBytes || distance > 2 ** ((cmf >>> 4) + 8)) return false;
        outputBytes += length;
      } else {
        return false;
      }
      if (outputBytes > maximumOutputBytes) return 'OUTPUT_LIMIT';
      if ((symbolCount & 0xffff) === 0) {
        if (signal?.aborted) throw new Error('CONTENT_INSPECTION_ABORTED');
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
      }
    }
  }

  reader.alignToByte();
  return reader.bytesConsumed === totalBytes - 4;
}
