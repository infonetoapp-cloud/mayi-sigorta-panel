import { createHash } from 'node:crypto';
/** Private write/readback custody for JSON control bodies, never a document data path.
 * No lossy serialization: unsupported values retry and emit a payload-free failure.
 * No expiry/delete authority. Queue/DLQ retention remains a separate provider limit. */
function jsonBody(input: unknown): unknown {
  let nodes = 0;
  const seen = new Set<object>();
  function visit(value: unknown, depth: number): unknown {
    if (++nodes > 10000 || depth > 20) throw new Error('CUSTODY_BODY_BOUND');
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number' && Number.isFinite(value) && !Object.is(value, -0)) return value;
    if (!value || typeof value !== 'object' || seen.has(value))
      throw new Error('CUSTODY_BODY_TYPE');
    seen.add(value);
    try {
      if (Array.isArray(value)) {
        if (Reflect.ownKeys(value).length !== value.length + 1)
          throw new Error('CUSTODY_ARRAY_SHAPE');
        const result: unknown[] = [];
        for (let i = 0; i < value.length; i++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(i));
          if (!descriptor?.enumerable || !('value' in descriptor))
            throw new Error('CUSTODY_ARRAY_SHAPE');
          result.push(visit(descriptor.value, depth + 1));
        }
        return result;
      }
      if (
        Object.getPrototypeOf(value) !== Object.prototype &&
        Object.getPrototypeOf(value) !== null
      )
        throw new Error('CUSTODY_BODY_TYPE');
      const result: Record<string, unknown> = Object.create(null);
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== 'string') throw new Error('CUSTODY_BODY_TYPE');
        const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
        if (!descriptor.enumerable || !('value' in descriptor))
          throw new Error('CUSTODY_BODY_TYPE');
        result[key] = visit(descriptor.value, depth + 1);
      }
      return result;
    } finally {
      seen.delete(value);
    }
  }
  return visit(input, 0);
}
export async function consumeWithDocumentCustody<T>(
  batch: MessageBatch<T>,
  storage: Pick<R2Bucket, 'put' | 'get'> | undefined,
  consume: (batch: MessageBatch<T>) => Promise<void>,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      if (
        !storage ||
        batch.queue !== 'mayisigorta-document-jobs-v2' ||
        typeof message.id !== 'string' ||
        !/^[a-zA-Z0-9_-]{1,128}$/u.test(message.id) ||
        !(message.timestamp instanceof Date) ||
        !Number.isFinite(message.timestamp.getTime())
      )
        throw new Error('CUSTODY_SCOPE');
      const text = JSON.stringify({
        version: 1,
        queue: batch.queue,
        id: message.id,
        timestamp: message.timestamp.toISOString(),
        body: jsonBody(message.body),
      });
      const bytes = new TextEncoder().encode(text);
      if (bytes.byteLength > 131072 + 1024) throw new Error('CUSTODY_BODY_BOUND');
      const key =
        'queue-custody/' +
        createHash('sha256')
          .update(batch.queue + ':' + message.id)
          .digest('hex');
      await storage.put(key, bytes, { onlyIf: { etagDoesNotMatch: '*' } });
      const stored = await storage.get(key);
      if (!stored || stored.size !== bytes.byteLength || (await stored.text()) !== text)
        throw new Error('CUSTODY_READBACK');
      await consume({ ...batch, messages: [message] });
    } catch {
      console.error(JSON.stringify({ event: 'MAYI_DOCUMENT_QUEUE_CUSTODY_FAILED', version: 1 }));
      message.retry({ delaySeconds: 60 });
    }
  }
}
