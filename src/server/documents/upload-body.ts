import { MAX_DOCUMENT_UPLOAD_BYTES } from './validation';
import { DocumentUploadError } from './service';
/** Fixed block count (not one retained JS object per attacker chunk), capped
 * streaming work/idle/total await. Timers do NOT preempt synchronous parsers. */
export async function readDocumentMultipartBody(request: Request): Promise<ArrayBuffer> {
  if (!request.body) return new ArrayBuffer(0);
  const reader = request.body.getReader();
  const blocks: Uint8Array[] = [],
    cap = MAX_DOCUMENT_UPLOAD_BYTES + 65536,
    blockSize = 65536;
  let total = 0,
    chunks = 0,
    position = 0,
    block: Uint8Array | undefined;
  const started = Date.now();
  try {
    while (true) {
      if (++chunks > 65536) throw new DocumentUploadError('VALIDATION_ERROR', 413);
      const remaining = 30000 - (Date.now() - started);
      if (remaining <= 0 || request.signal.aborted)
        throw new DocumentUploadError('SERVICE_UNAVAILABLE', 503);
      let timer: ReturnType<typeof setTimeout> | undefined;
      let onAbort: () => void = () => {};
      const ended = new Promise<never>((_, reject) => {
        onAbort = () => reject(new DocumentUploadError('SERVICE_UNAVAILABLE', 503));
        request.signal.addEventListener('abort', onAbort, { once: true });
        timer = setTimeout(onAbort, Math.min(5000, remaining));
      });
      let result: ReadableStreamReadResult<Uint8Array>;
      try {
        result = await Promise.race([reader.read(), ended]);
      } finally {
        clearTimeout(timer);
        request.signal.removeEventListener('abort', onAbort);
      }
      if (result.done) break;
      const value = result.value;
      if (total + value.byteLength > cap) throw new DocumentUploadError('VALIDATION_ERROR', 413);
      let offset = 0;
      while (offset < value.byteLength) {
        if (!block || position === block.length) {
          block = new Uint8Array(Math.min(blockSize, cap - total));
          blocks.push(block);
          position = 0;
        }
        const length = Math.min(block.length - position, value.length - offset);
        block.set(value.subarray(offset, offset + length), position);
        offset += length;
        position += length;
        total += length;
      }
    }
    const body = new ArrayBuffer(total),
      view = new Uint8Array(body);
    let copied = 0;
    for (const item of blocks) {
      const count = Math.min(item.length, total - copied);
      view.set(item.subarray(0, count), copied);
      copied += count;
    }
    return body;
  } catch (error) {
    if (error instanceof DocumentUploadError) throw error;
    throw new DocumentUploadError('SERVICE_UNAVAILABLE', 503);
  } finally {
    void reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}
