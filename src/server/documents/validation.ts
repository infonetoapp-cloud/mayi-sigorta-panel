export const MAX_DOCUMENT_UPLOAD_BYTES = 20 * 1024 * 1024;

export type DocumentUploadFormat = 'PDF' | 'JPEG' | 'PNG';
export type DocumentUploadContentType = 'application/pdf' | 'image/jpeg' | 'image/png';

export interface DocumentUploadPreflightInput {
  readonly fileName: unknown;
  readonly declaredContentType: unknown;
  readonly sizeBytes: unknown;
  readonly prefixBytes: unknown;
  readonly suffixBytes: unknown;
}

export type DocumentUploadPreflightResult =
  | {
      readonly valid: true;
      readonly fileName: string;
      readonly format: DocumentUploadFormat;
      readonly detectedContentType: DocumentUploadContentType;
      readonly sizeBytes: number;
      readonly disposition: 'QUARANTINE_ONLY';
    }
  | {
      readonly valid: false;
      readonly reason:
        | 'INVALID_INPUT'
        | 'SIZE_LIMIT'
        | 'UNSUPPORTED_TYPE'
        | 'CONTENT_TYPE_MISMATCH'
        | 'SIGNATURE_MISMATCH';
    };

interface SupportedDocumentType {
  readonly format: DocumentUploadFormat;
  readonly contentType: DocumentUploadContentType;
}

const SUPPORTED_EXTENSIONS: Readonly<Record<string, SupportedDocumentType>> = Object.freeze({
  '.pdf': { format: 'PDF', contentType: 'application/pdf' },
  '.jpg': { format: 'JPEG', contentType: 'image/jpeg' },
  '.jpeg': { format: 'JPEG', contentType: 'image/jpeg' },
  '.png': { format: 'PNG', contentType: 'image/png' },
});

function hasBytesAt(bytes: Uint8Array, offset: number, expected: readonly number[]): boolean {
  if (offset < 0 || bytes.length < offset + expected.length) return false;
  return expected.every((value, index) => bytes[offset + index] === value);
}

function hasPdfHeader(bytes: Uint8Array): boolean {
  return hasBytesAt(bytes, 0, [0x25, 0x50, 0x44, 0x46, 0x2d]);
}

function hasPdfEof(bytes: Uint8Array): boolean {
  let end = bytes.length;
  while (
    end > 0 &&
    (bytes[end - 1] === 0x09 ||
      bytes[end - 1] === 0x0a ||
      bytes[end - 1] === 0x0c ||
      bytes[end - 1] === 0x0d ||
      bytes[end - 1] === 0x20)
  ) {
    end -= 1;
  }
  return end >= 5 && hasBytesAt(bytes, end - 5, [0x25, 0x25, 0x45, 0x4f, 0x46]);
}

function hasJpegMarkers(prefix: Uint8Array, suffix: Uint8Array): boolean {
  return (
    hasBytesAt(prefix, 0, [0xff, 0xd8, 0xff]) && hasBytesAt(suffix, suffix.length - 2, [0xff, 0xd9])
  );
}

function isPngHeader(bytes: Uint8Array): boolean {
  if (
    !hasBytesAt(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]) ||
    bytes.length < 24 ||
    !hasBytesAt(bytes, 8, [0x00, 0x00, 0x00, 0x0d]) ||
    !hasBytesAt(bytes, 12, [0x49, 0x48, 0x44, 0x52])
  ) {
    return false;
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16, false);
  const height = view.getUint32(20, false);
  return width > 0 && height > 0;
}

function sanitizeFileName(rawName: string, extension: string): string {
  const normalized = rawName.normalize('NFKC');
  const leafName = normalized.split(/[\\/]/u).at(-1) ?? '';
  let stem = leafName.slice(0, -extension.length);
  stem = stem
    .replace(/[\p{C}\p{Zl}\p{Zp}"';]/gu, '_')
    .replace(/\.\./gu, '_')
    .replace(/\s+/gu, ' ')
    .trim()
    .replace(/^[. ]+/u, '')
    .replace(/[. ]+$/u, '');

  if (!stem) stem = 'belge';

  const maximumStemLength = 255 - [...extension].length;
  stem = [...stem]
    .slice(0, maximumStemLength)
    .join('')
    .replace(/[. ]+$/u, '');
  if (!stem) stem = 'belge';
  return `${stem}${extension}`;
}

function invalid(reason: Extract<DocumentUploadPreflightResult, { valid: false }>['reason']) {
  return { valid: false, reason } as const;
}

/**
 * Cheap streaming-envelope preflight only. A successful result remains quarantine-only;
 * PDF/image parsing, decompression/pixel limits, malware scanning, and availability are separate gates.
 */
export function preflightDocumentUpload(
  input: DocumentUploadPreflightInput,
): DocumentUploadPreflightResult {
  try {
    if (!input || typeof input !== 'object' || Array.isArray(input))
      return invalid('INVALID_INPUT');

    const rawFileName = input.fileName;
    const declaredContentType = input.declaredContentType;
    const sizeBytes = input.sizeBytes;
    const prefixBytes = input.prefixBytes;
    const suffixBytes = input.suffixBytes;

    if (
      typeof rawFileName !== 'string' ||
      rawFileName.length === 0 ||
      rawFileName.length > 1024 ||
      typeof declaredContentType !== 'string' ||
      typeof sizeBytes !== 'number' ||
      !(prefixBytes instanceof Uint8Array) ||
      !(suffixBytes instanceof Uint8Array) ||
      prefixBytes.byteLength > 1024 ||
      suffixBytes.byteLength > 1024
    ) {
      return invalid('INVALID_INPUT');
    }

    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) return invalid('INVALID_INPUT');
    if (sizeBytes > MAX_DOCUMENT_UPLOAD_BYTES) return invalid('SIZE_LIMIT');

    const normalizedName = rawFileName.normalize('NFKC');
    const leafName = normalizedName.split(/[\\/]/u).at(-1) ?? '';
    const dot = leafName.lastIndexOf('.');
    if (dot < 0) return invalid('UNSUPPORTED_TYPE');

    const extension = leafName.slice(dot).toLowerCase();
    const supportedType = SUPPORTED_EXTENSIONS[extension];
    if (!supportedType) return invalid('UNSUPPORTED_TYPE');
    if (declaredContentType !== supportedType.contentType) {
      return invalid('CONTENT_TYPE_MISMATCH');
    }

    let signatureMatches = false;
    switch (supportedType.format) {
      case 'PDF':
        signatureMatches = hasPdfHeader(prefixBytes) && hasPdfEof(suffixBytes);
        break;
      case 'JPEG':
        signatureMatches = hasJpegMarkers(prefixBytes, suffixBytes);
        break;
      case 'PNG':
        signatureMatches = sizeBytes >= 33 && isPngHeader(prefixBytes);
        break;
    }
    if (!signatureMatches) return invalid('SIGNATURE_MISMATCH');

    return {
      valid: true,
      fileName: sanitizeFileName(rawFileName, extension),
      format: supportedType.format,
      detectedContentType: supportedType.contentType,
      sizeBytes,
      disposition: 'QUARANTINE_ONLY',
    };
  } catch {
    return invalid('INVALID_INPUT');
  }
}

export async function preflightDocumentBlob(
  file: Blob,
  metadata: Pick<DocumentUploadPreflightInput, 'fileName' | 'declaredContentType'>,
): Promise<DocumentUploadPreflightResult> {
  try {
    const sizeBytes = file.size;
    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 1) return invalid('INVALID_INPUT');
    if (sizeBytes > MAX_DOCUMENT_UPLOAD_BYTES) return invalid('SIZE_LIMIT');

    const prefixEnd = Math.min(sizeBytes, 1024);
    const suffixStart = Math.max(0, sizeBytes - 1024);
    const [prefixBuffer, suffixBuffer] = await Promise.all([
      file.slice(0, prefixEnd).arrayBuffer(),
      file.slice(suffixStart, sizeBytes).arrayBuffer(),
    ]);

    return preflightDocumentUpload({
      fileName: metadata.fileName,
      declaredContentType: metadata.declaredContentType,
      sizeBytes,
      prefixBytes: new Uint8Array(prefixBuffer),
      suffixBytes: new Uint8Array(suffixBuffer),
    });
  } catch {
    return invalid('INVALID_INPUT');
  }
}
