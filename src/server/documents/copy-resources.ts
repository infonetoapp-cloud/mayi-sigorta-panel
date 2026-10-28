import { createHash } from 'node:crypto';
import { MAX_DOCUMENT_UPLOAD_BYTES } from './validation';
import { backupAbortable, DocumentBackupIntegrityError } from './backup-storage';
export const DOCUMENT_COPY_CHUNK_BYTES = 65536;
/** Snapshot ownership is supplied by the caller. No tee or full-body RPC value. */
export function documentByteStream(
  bytes: Uint8Array<ArrayBuffer>,
  signal: AbortSignal,
): ReadableStream<Uint8Array> {
  let at = 0;
  let owner: ReadableStreamDefaultController<Uint8Array>;
  const abort = () => {
    signal.removeEventListener('abort', abort);
    try {
      owner.error(new Error('BACKUP_TIMEOUT'));
    } catch {
      /* Already closed; no free-form exception output. */
    }
  };
  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        owner = controller;
        if (signal.aborted) abort();
        else signal.addEventListener('abort', abort, { once: true });
      },
      cancel() {
        signal.removeEventListener('abort', abort);
      },
      pull(controller) {
        if (signal.aborted) {
          controller.error(new Error('BACKUP_TIMEOUT'));
          return;
        }
        if (at === bytes.byteLength) {
          signal.removeEventListener('abort', abort);
          controller.close();
          return;
        }
        const end = Math.min(bytes.byteLength, at + DOCUMENT_COPY_CHUNK_BYTES);
        // Independent small backing store: never transfer a 20MiB ArrayBuffer
        // behind a seemingly 64KiB subarray across the RPC stream boundary.
        controller.enqueue(bytes.slice(at, end));
        at = end;
      },
    },
    { highWaterMark: 0 },
  );
}
/** One explicit size-bounded buffer; stream transport is not end-to-end zero-copy.
 * Every actual chunk/byte/hash is validated before destination write authority. */
export async function readBoundedDocumentStream(
  stream: ReadableStream<Uint8Array>,
  size: number,
  sha: string,
  signal: AbortSignal,
  track: <T>(p: Promise<T>) => Promise<T> = (p) => p,
): Promise<Uint8Array<ArrayBuffer>> {
  if (
    !Number.isSafeInteger(size) ||
    size < 1 ||
    size > MAX_DOCUMENT_UPLOAD_BYTES ||
    !/^[0-9a-f]{64}$/u.test(sha)
  )
    throw new DocumentBackupIntegrityError('BACKUP_INPUT_MISMATCH');
  signal.throwIfAborted();
  const reader = stream.getReader();
  const bytes = new Uint8Array(size);
  const hash = createHash('sha256');
  let at = 0;
  const cancel = () => {
    void track(reader.cancel()).catch(() => undefined);
  };
  signal.addEventListener('abort', cancel, { once: true });
  try {
    while (true) {
      const { done, value } = await backupAbortable(track(reader.read()), signal);
      if (done) break;
      if (
        !(value instanceof Uint8Array) ||
        value.byteLength < 1 ||
        value.byteLength > MAX_DOCUMENT_UPLOAD_BYTES ||
        at + value.byteLength > size
      )
        throw new DocumentBackupIntegrityError('BACKUP_LENGTH_MISMATCH');
      bytes.set(value, at);
      at += value.byteLength;
      hash.update(value);
    }
    if (at !== size || hash.digest('hex') !== sha)
      throw new DocumentBackupIntegrityError('BACKUP_INPUT_MISMATCH');
    return bytes;
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}
