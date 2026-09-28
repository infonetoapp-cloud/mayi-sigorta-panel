import {
  MAX_DOCUMENT_UPLOAD_BYTES,
  preflightDocumentBlob,
  type DocumentUploadPreflightInput,
} from './validation';

export type DocumentQuarantineErrorCode =
  | 'PREFLIGHT_REJECTED'
  | 'SIZE_MISMATCH'
  | 'CONTENT_READ_FAILED'
  | 'CHECKSUM_FAILED'
  | 'OBJECT_WRITE_FAILED';

export class DocumentQuarantineError extends Error {
  constructor(readonly code: DocumentQuarantineErrorCode) {
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

function toHex(bytes: Uint8Array): string {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export async function storeQuarantinedDocumentObject(
  bucket: R2Bucket,
  file: Blob,
  metadata: Pick<DocumentUploadPreflightInput, 'fileName' | 'declaredContentType'>,
): Promise<StoredQuarantinedDocumentObject> {
  const preflight = await preflightDocumentBlob(file, metadata);
  if (!preflight.valid) throw new DocumentQuarantineError('PREFLIGHT_REJECTED');

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

  const objectKey = `quarantine/${crypto.randomUUID()}`;
  try {
    await bucket.put(objectKey, content, {
      httpMetadata: {
        cacheControl: 'private, no-store',
        contentType: preflight.detectedContentType,
      },
      customMetadata: {
        format: preflight.format,
        sha256,
      },
    });
  } catch {
    throw new DocumentQuarantineError('OBJECT_WRITE_FAILED');
  }

  return {
    objectKey,
    sha256,
    sizeBytes: content.byteLength,
    contentType: preflight.detectedContentType,
    fileName: preflight.fileName,
    disposition: preflight.disposition,
  };
}
