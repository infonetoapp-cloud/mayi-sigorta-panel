import { MAX_GZIP_SQL_BYTES, MAX_RAW_SQL_BYTES } from './format';
import type { BackupFailure, Classification } from './provider';

export async function compressBackupSql(
  body: ReadableStream<Uint8Array<ArrayBuffer>>,
  expected: number | null,
  failure: (classification: Classification) => BackupFailure,
) {
  let rawBytes = 0;
  const input = body.pipeThrough(
    new TransformStream<Uint8Array<ArrayBuffer>, BufferSource>({
      transform(chunk, controller) {
        rawBytes += chunk.byteLength;
        if (rawBytes > MAX_RAW_SQL_BYTES) throw failure('sql-size-limit-exceeded');
        if (expected !== null && rawBytes > expected) throw failure('invalid-length');
        controller.enqueue(chunk);
      },
      flush() {
        if (!rawBytes || (expected !== null && rawBytes !== expected))
          throw failure('invalid-length');
      },
    }),
  );
  const reader = input.pipeThrough(new CompressionStream('gzip')).getReader();
  // R2 requires a known PUT length. Only the bounded compressed bytes are buffered.
  const buffer = new Uint8Array(MAX_GZIP_SQL_BYTES);
  let storedBytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      if (chunk.value.byteLength > buffer.byteLength - storedBytes)
        throw failure('gzip-size-limit-exceeded');
      buffer.set(chunk.value, storedBytes);
      storedBytes += chunk.value.byteLength;
    }
  } catch (error) {
    void reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
  const data = buffer.subarray(0, storedBytes);
  const sha256 = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
  return { data, rawSqlSize: rawBytes, storedSha256: sha256 };
}
