import { emitDocumentUploadDiagnostic } from './upload-diagnostics';
import {
  MAX_DOCUMENT_UPLOAD_BYTES,
  preflightDocumentBlob,
  type DocumentUploadFormat,
  type DocumentUploadPreflightInput,
  type DocumentUploadPreflightResult,
} from './validation';

export type DocumentQuarantineErrorCode =
  | 'PREFLIGHT_REJECTED'
  | 'SIZE_MISMATCH'
  | 'CONTENT_READ_FAILED'
  | 'CHECKSUM_FAILED'
  | 'OBJECT_WRITE_FAILED';

export class DocumentQuarantineError extends Error {
  constructor(
    readonly code: DocumentQuarantineErrorCode,
    readonly preflightReason?: Extract<DocumentUploadPreflightResult, { valid: false }>['reason'],
  ) {
    super(code);
    this.name = 'DocumentQuarantineError';
  }
}

export interface StoredQuarantinedDocumentObject {
  readonly objectKey: string;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly contentType: 'application/pdf' | 'image/jpeg' | 'image/png';
  readonly fileName: string;
  readonly disposition: 'QUARANTINE_ONLY';
}

export interface PreparedQuarantinedDocumentObject {
  readonly content: ArrayBuffer;
  readonly format: DocumentUploadFormat;
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly contentType: 'application/pdf' | 'image/jpeg' | 'image/png';
  readonly fileName: string;
  readonly disposition: 'QUARANTINE_ONLY';
}

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function createQuarantineObjectKey(): string {
  return `quarantine/${crypto.randomUUID()}`;
}

export async function prepareQuarantinedDocumentObject(
  file: Blob,
  metadata: Pick<DocumentUploadPreflightInput, 'fileName' | 'declaredContentType'>,
): Promise<PreparedQuarantinedDocumentObject> {
  const preflight = await preflightDocumentBlob(file, metadata);
  if (!preflight.valid) {
    throw new DocumentQuarantineError('PREFLIGHT_REJECTED', preflight.reason);
  }

  if (file.size !== preflight.sizeBytes || file.size < 1 || file.size > MAX_DOCUMENT_UPLOAD_BYTES) {
    throw new DocumentQuarantineError('SIZE_MISMATCH');
  }

  let content: ArrayBuffer;
  try {
    content = await file.arrayBuffer();
  } catch {
    throw new DocumentQuarantineError('CONTENT_READ_FAILED');
  }
  if (content.byteLength !== file.size) throw new DocumentQuarantineError('SIZE_MISMATCH');

  let sha256: string;
  try {
    sha256 = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', content)));
  } catch {
    throw new DocumentQuarantineError('CHECKSUM_FAILED');
  }

  return {
    content,
    format: preflight.format,
    sha256,
    sizeBytes: content.byteLength,
    contentType: preflight.detectedContentType,
    fileName: preflight.fileName,
    disposition: preflight.disposition,
  };
}

export async function writePreparedQuarantinedDocumentObject(
  bucket: R2Bucket,
  objectKey: string,
  prepared: PreparedQuarantinedDocumentObject,
): Promise<void> {
  if (
    !/^quarantine\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      objectKey,
    )
  ) {
    throw new DocumentQuarantineError('OBJECT_WRITE_FAILED');
  }
  if (
    prepared.content.byteLength !== prepared.sizeBytes ||
    prepared.sizeBytes < 1 ||
    prepared.sizeBytes > MAX_DOCUMENT_UPLOAD_BYTES
  ) {
    throw new DocumentQuarantineError('SIZE_MISMATCH');
  }

  let actualSha256: string;
  emitDocumentUploadDiagnostic('R2_CHECKSUM', 'START');
  try {
    actualSha256 = toHex(new Uint8Array(await crypto.subtle.digest('SHA-256', prepared.content)));
    emitDocumentUploadDiagnostic('R2_CHECKSUM', 'OK');
  } catch (error) {
    emitDocumentUploadDiagnostic('R2_CHECKSUM', 'FAIL', error);
    throw new DocumentQuarantineError('CHECKSUM_FAILED');
  }
  if (actualSha256 !== prepared.sha256) throw new DocumentQuarantineError('CHECKSUM_FAILED');

  emitDocumentUploadDiagnostic('R2_PUT', 'START');
  try {
    await bucket.put(objectKey, prepared.content, {
      httpMetadata: {
        cacheControl: 'private, no-store',
        contentType: prepared.contentType,
      },
      customMetadata: {
        format: prepared.format,
        sha256: prepared.sha256,
      },
    });
    emitDocumentUploadDiagnostic('R2_PUT', 'OK');
  } catch (error) {
    emitDocumentUploadDiagnostic('R2_PUT', 'FAIL', error);
    throw new DocumentQuarantineError('OBJECT_WRITE_FAILED');
  }
}

export async function storeQuarantinedDocumentObject(
  bucket: R2Bucket,
  file: Blob,
  metadata: Pick<DocumentUploadPreflightInput, 'fileName' | 'declaredContentType'>,
): Promise<StoredQuarantinedDocumentObject> {
  const prepared = await prepareQuarantinedDocumentObject(file, metadata);
  const objectKey = createQuarantineObjectKey();
  await writePreparedQuarantinedDocumentObject(bucket, objectKey, prepared);

  return {
    objectKey,
    sha256: prepared.sha256,
    sizeBytes: prepared.sizeBytes,
    contentType: prepared.contentType,
    fileName: prepared.fileName,
    disposition: prepared.disposition,
  };
}
