import { createDocumentAdmission } from './resource-admission';

// This is a per-isolate bound, not a distributed capacity guarantee.
const uploadSlots = [createDocumentAdmission(), createDocumentAdmission()];

export interface RawQuarantineInput {
  readonly objectKey: string;
  readonly sizeBytes: number;
  readonly expectedSha256: string;
  readonly fileName: string;
  readonly contentType: 'application/pdf' | 'image/jpeg' | 'image/png';
}
export class RawQuarantineError extends Error {
  constructor(readonly status: 400 | 409 | 413 | 503) {
    super('DOCUMENT_UPLOAD_NOT_ACCEPTED');
  }
}
/** Transport integrity only. Structural validation is a separate mandatory trust gate. */
export async function writeRawQuarantine(
  request: Request,
  bucket: Pick<R2Bucket, 'put'>,
  input: RawQuarantineInput,
): Promise<{ readonly sizeBytes: number; readonly expectedSha256: string }> {
  try {
    input = Object.freeze(structuredClone(input));
  } catch {
    throw new RawQuarantineError(400);
  }
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 1 || input.sizeBytes > 20971520)
    throw new RawQuarantineError(413);
  if (
    !request.body ||
    request.bodyUsed ||
    request.body.locked ||
    !/^quarantine\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u.test(
      input.objectKey,
    ) ||
    !/^[0-9a-f]{64}$/u.test(input.expectedSha256) ||
    !['application/pdf', 'image/jpeg', 'image/png'].includes(input.contentType)
  )
    throw new RawQuarantineError(400);
  let permit = null;
  for (const slot of uploadSlots) {
    permit = slot.acquire();
    if (permit) break;
  }
  if (!permit) throw new RawQuarantineError(503);
  const stream = new FixedLengthStream(input.sizeBytes);
  const cancellation = new AbortController();
  const stop = () => cancellation.abort(new RawQuarantineError(503));
  request.signal.addEventListener('abort', stop, { once: true });
  if (request.signal.aborted) stop();
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      stop();
      reject(new RawQuarantineError(503));
    }, 30000);
  });
  const pipe = permit.track(request.body.pipeTo(stream.writable, { signal: cancellation.signal }));
  // R2 may reject a conditional create before draining the pipe.
  void pipe.catch(() => undefined);
  try {
    const result = await Promise.race([
      deadline,
      permit.run(() =>
        bucket.put(input.objectKey, stream.readable, {
          onlyIf: { etagDoesNotMatch: '*' },
          sha256: input.expectedSha256,
          httpMetadata: {
            contentType: 'application/octet-stream',
            cacheControl: 'private, no-store',
          },
        }),
      ),
    ]);
    if (result === null) {
      void permit.track(stream.readable.cancel()).catch(() => undefined);
      throw new RawQuarantineError(409);
    }
    await pipe;
    const checksum = result.checksums.sha256;
    const verified = checksum
      ? Array.from(new Uint8Array(checksum), (byte) => byte.toString(16).padStart(2, '0')).join('')
      : '';
    if (result.size !== input.sizeBytes || verified !== input.expectedSha256)
      throw new RawQuarantineError(503);
    return { sizeBytes: result.size, expectedSha256: input.expectedSha256 };
  } catch (error) {
    stop();
    if (error instanceof RawQuarantineError) throw error;
    throw new RawQuarantineError(400);
  } finally {
    clearTimeout(timer!);
    request.signal.removeEventListener('abort', stop);
    permit.release();
  }
}
