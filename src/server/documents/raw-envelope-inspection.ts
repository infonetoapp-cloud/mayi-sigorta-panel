import {
  preflightDocumentUpload,
  MAX_DOCUMENT_UPLOAD_BYTES,
  type DocumentUploadPreflightResult,
} from './validation';

/** Cheap envelope only; successful preflight is not structural acceptance. */
export function createRawEnvelopeInspection(metadata: {
  readonly fileName: string;
  readonly declaredContentType: string;
  readonly sizeBytes: number;
}) {
  const claims = Object.freeze({ ...metadata });
  if (
    !Number.isSafeInteger(claims.sizeBytes) ||
    claims.sizeBytes < 1 ||
    claims.sizeBytes > MAX_DOCUMENT_UPLOAD_BYTES
  )
    throw new Error('DOCUMENT_UPLOAD_ENVELOPE_INVALID');
  const prefix = new Uint8Array(1024),
    suffix = new Uint8Array(1024);
  let prefixSize = 0,
    suffixSize = 0,
    size = 0,
    chunks = 0;
  let result: DocumentUploadPreflightResult | null = null;
  const stream = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      chunks++;
      if (
        !(chunk instanceof Uint8Array) ||
        chunks > 8192 ||
        chunk.byteLength > claims.sizeBytes - size
      )
        throw new Error('DOCUMENT_UPLOAD_STREAM_BOUNDS');
      size += chunk.byteLength;
      const take = Math.min(1024 - prefixSize, chunk.byteLength);
      prefix.set(chunk.subarray(0, take), prefixSize);
      prefixSize += take;
      if (chunk.byteLength >= 1024) {
        suffix.set(chunk.subarray(chunk.byteLength - 1024));
        suffixSize = 1024;
      } else {
        const retained = Math.min(suffixSize, 1024 - chunk.byteLength);
        suffix.copyWithin(0, suffixSize - retained, suffixSize);
        suffix.set(chunk, retained);
        suffixSize = retained + chunk.byteLength;
      }
      controller.enqueue(chunk);
    },
    flush() {
      if (size !== claims.sizeBytes) throw new Error('DOCUMENT_UPLOAD_STREAM_BOUNDS');
      result = preflightDocumentUpload({
        fileName: claims.fileName,
        declaredContentType: claims.declaredContentType,
        sizeBytes: size,
        prefixBytes: prefix.subarray(0, prefixSize),
        suffixBytes: suffix.subarray(0, suffixSize),
      });
    },
  });
  return Object.freeze({ stream, result: () => result });
}
