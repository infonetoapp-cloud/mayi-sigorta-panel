import { z } from 'zod';
import { MAX_DOCUMENT_UPLOAD_BYTES } from './validation';

const schema = z
  .object({
    ownerType: z.enum(['CUSTOMER', 'POLICY', 'QUOTE']),
    ownerId: z.string().trim().min(1).max(128),
    classification: z.enum(['GENERAL', 'IDENTITY', 'HEALTH']),
    fileName: z.string().min(1).max(1024),
    declaredContentType: z.enum(['application/pdf', 'image/jpeg', 'image/png']),
    sizeBytes: z.number().int().min(1).max(MAX_DOCUMENT_UPLOAD_BYTES),
    expectedSha256: z.string().regex(/^[0-9a-f]{64}$/u),
  })
  .strict();
export type RawDocumentEnvelope = Readonly<z.infer<typeof schema>>;
export class RawDocumentEnvelopeError extends Error {
  constructor() {
    super('DOCUMENT_UPLOAD_METADATA_INVALID');
  }
}
/** Claims only: authorization, byte checksum and server format inspection remain mandatory. */
export function readRawDocumentEnvelope(request: Request): RawDocumentEnvelope {
  try {
    if (request.headers.get('Content-Type') !== 'application/octet-stream')
      throw new RawDocumentEnvelopeError();
    const header = request.headers.get('X-Document-Metadata');
    if (!header || header.length > 8192) throw new RawDocumentEnvelopeError();
    const result = schema.parse(JSON.parse(decodeURIComponent(header)));
    const length = request.headers.get('Content-Length');
    if (
      length !== null &&
      (!/^[1-9][0-9]{0,7}$/u.test(length) || Number(length) !== result.sizeBytes)
    )
      throw new RawDocumentEnvelopeError();
    return Object.freeze(result);
  } catch {
    throw new RawDocumentEnvelopeError();
  }
}
