import { createHash } from 'node:crypto';
import { MAX_DOCUMENT_UPLOAD_BYTES } from './validation';

export interface DocumentBackupIdentity {
  readonly agencyId: string;
  readonly documentVersionId: string;
  readonly generation: number;
  readonly sha256: string;
  readonly sizeBytes: number;
}

export interface DocumentBackupProof extends DocumentBackupIdentity {
  readonly objectKey: string;
}

/** Durability-only capability: no download, list, overwrite or delete operation. */
export interface DocumentBackupAdapter {
  createAndVerify(
    identity: DocumentBackupIdentity,
    bytes: Uint8Array<ArrayBuffer>,
    signal: AbortSignal,
  ): Promise<DocumentBackupProof>;
}

export class DocumentBackupIntegrityError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

export function backupAbortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new Error('BACKUP_TIMEOUT'));
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}

export function assertBackupIdentity(identity: DocumentBackupIdentity): void {
  if (
    !identity.agencyId ||
    !identity.documentVersionId ||
    !Number.isSafeInteger(identity.generation) ||
    identity.generation < 1 ||
    !/^[0-9a-f]{64}$/u.test(identity.sha256) ||
    !Number.isSafeInteger(identity.sizeBytes) ||
    identity.sizeBytes < 1 ||
    identity.sizeBytes > MAX_DOCUMENT_UPLOAD_BYTES
  ) {
    throw new DocumentBackupIntegrityError('BACKUP_IDENTITY_INVALID');
  }
}

export function documentBackupObjectKey(identity: DocumentBackupIdentity): string {
  assertBackupIdentity(identity);
  // Preserve the accepted backup/UUID-shaped key convention; no user-controlled path.
  // Metadata and actual byte proof reject even a hypothetical truncated-hash collision.
  const hex = createHash('sha256')
    .update(
      JSON.stringify([
        'document-backup-v1',
        identity.agencyId,
        identity.documentVersionId,
        identity.generation,
        identity.sha256,
      ]),
    )
    .digest('hex')
    .slice(0, 32);
  return `backup/${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Expose only create/read-for-verification behavior, never the raw bucket capability. */
export function createR2DocumentBackupAdapter(
  storage: Pick<R2Bucket, 'put' | 'get'>,
): DocumentBackupAdapter {
  const put = storage.put.bind(storage);
  const get = storage.get.bind(storage);
  return Object.freeze({
    async createAndVerify(
      input: DocumentBackupIdentity,
      bytes: Uint8Array<ArrayBuffer>,
      signal: AbortSignal,
    ): Promise<DocumentBackupProof> {
      const identity = Object.freeze({ ...input });
      signal.throwIfAborted();
      assertBackupIdentity(identity);
      if (
        bytes.byteLength !== identity.sizeBytes ||
        createHash('sha256').update(bytes).digest('hex') !== identity.sha256
      ) {
        throw new DocumentBackupIntegrityError('BACKUP_INPUT_MISMATCH');
      }
      const objectKey = documentBackupObjectKey(identity);
      const metadata = {
        agencyId: identity.agencyId,
        documentVersionId: identity.documentVersionId,
        generation: String(identity.generation),
        sha256: identity.sha256,
      };
      // Conditional create + storage-side digest validation. A failed condition is NOT success:
      // always read back and hash the entire stored body, including after an earlier partial outcome.
      await backupAbortable(
        put(objectKey, bytes, {
          onlyIf: { etagDoesNotMatch: '*' },
          sha256: identity.sha256,
          customMetadata: metadata,
          httpMetadata: { cacheControl: 'private, no-store' },
        }),
        signal,
      );
      signal.throwIfAborted();
      const read = get(objectKey);
      let object: R2ObjectBody | null;
      try {
        object = await backupAbortable(read, signal);
      } catch (error) {
        void read.then((object) => object?.body.cancel()).catch(() => undefined);
        throw error;
      }
      if (!object) throw new Error('BACKUP_OBJECT_MISSING');
      if (
        object.size !== identity.sizeBytes ||
        Object.entries(metadata).some(([key, value]) => object.customMetadata?.[key] !== value)
      ) {
        void object.body.cancel().catch(() => undefined);
        throw new DocumentBackupIntegrityError('BACKUP_OBJECT_IDENTITY_MISMATCH');
      }
      const reader = object.body.getReader();
      const hash = createHash('sha256');
      let size = 0;
      const cancel = () => {
        void reader.cancel().catch(() => undefined);
      };
      signal.addEventListener('abort', cancel, { once: true });
      try {
        while (true) {
          const { done, value } = await backupAbortable(reader.read(), signal);
          if (done) break;
          size += value.byteLength;
          if (size > identity.sizeBytes)
            throw new DocumentBackupIntegrityError('BACKUP_LENGTH_MISMATCH');
          hash.update(value);
        }
        if (size !== identity.sizeBytes || hash.digest('hex') !== identity.sha256) {
          throw new DocumentBackupIntegrityError('BACKUP_CHECKSUM_MISMATCH');
        }
      } catch (error) {
        cancel();
        throw error;
      } finally {
        signal.removeEventListener('abort', cancel);
        reader.releaseLock();
      }
      return Object.freeze({ ...identity, objectKey });
    },
  });
}
