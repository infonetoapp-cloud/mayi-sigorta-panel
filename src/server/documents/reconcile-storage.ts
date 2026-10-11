import { createHash } from 'node:crypto';
import { MAX_DOCUMENT_UPLOAD_BYTES } from './validation';
import {
  backupAbortable,
  documentBackupObjectKey,
  DocumentBackupIntegrityError,
  type DocumentBackupIdentity,
  type DocumentBackupProof,
} from './backup-storage';

export interface ReconcileObjectObservation {
  readonly sha256: string;
  readonly sizeBytes: number;
  readonly agencyId: string | null;
  readonly documentVersionId: string | null;
  readonly generation: string | null;
  readonly declaredSha256: string | null;
}
/** No backup download, write, list, overwrite or delete capability escapes this boundary. */
export interface DocumentReconcileStorage {
  readonly primary: Pick<R2Bucket, 'get'>;
  observe(
    kind: 'PRIMARY' | 'BACKUP',
    key: string,
    signal: AbortSignal,
  ): Promise<ReconcileObjectObservation | null>;
  verifyBackup(
    identity: DocumentBackupIdentity,
    key: string,
    signal: AbortSignal,
  ): Promise<DocumentBackupProof | null>;
}
export async function observeR2DocumentObject(
  kind: 'PRIMARY' | 'BACKUP',
  key: string,
  get: R2Bucket['get'],
  signal: AbortSignal,
): Promise<ReconcileObjectObservation | null> {
  if (
    !new RegExp(
      `^${kind === 'PRIMARY' ? 'quarantine' : 'backup'}/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`,
      'u',
    ).test(key)
  )
    throw new DocumentBackupIntegrityError('RECONCILE_OBJECT_KEY_INVALID');
  const read = get(key);
  let object: R2ObjectBody | null;
  try {
    object = await backupAbortable(read, signal);
  } catch (error) {
    void read.then((object) => object?.body.cancel()).catch(() => undefined);
    throw error;
  }
  if (!object) return null;
  if (
    !Number.isSafeInteger(object.size) ||
    object.size < 1 ||
    object.size > MAX_DOCUMENT_UPLOAD_BYTES
  ) {
    void object.body.cancel().catch(() => undefined);
    throw new DocumentBackupIntegrityError('RECONCILE_OBJECT_SIZE_INVALID');
  }
  const sizeBytes = object.size;
  // Only approved immutable identity fields are copied; never confidential raw metadata.
  const metadata = object.customMetadata;
  const identity = {
    agencyId: metadata?.agencyId ?? null,
    documentVersionId: metadata?.documentVersionId ?? null,
    generation: metadata?.generation ?? null,
    declaredSha256: metadata?.sha256 ?? null,
  };
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
      if (size > sizeBytes)
        throw new DocumentBackupIntegrityError('RECONCILE_OBJECT_LENGTH_MISMATCH');
      hash.update(value);
    }
    if (size !== sizeBytes)
      throw new DocumentBackupIntegrityError('RECONCILE_OBJECT_LENGTH_MISMATCH');
    return Object.freeze({ ...identity, sizeBytes, sha256: hash.digest('hex') });
  } catch (error) {
    cancel();
    throw error;
  } finally {
    signal.removeEventListener('abort', cancel);
    reader.releaseLock();
  }
}

export function verifyDocumentBackupObservation(
  input: DocumentBackupIdentity,
  key: string,
  object: ReconcileObjectObservation | null,
): DocumentBackupProof | null {
  const identity = Object.freeze({ ...input });
  if (key !== documentBackupObjectKey(identity))
    throw new DocumentBackupIntegrityError('RECONCILE_BACKUP_IDENTITY_MISMATCH');
  if (!object) return null;
  if (
    object.agencyId !== identity.agencyId ||
    object.documentVersionId !== identity.documentVersionId ||
    object.generation !== String(identity.generation) ||
    object.declaredSha256 !== identity.sha256
  )
    throw new DocumentBackupIntegrityError('RECONCILE_BACKUP_IDENTITY_MISMATCH');
  if (object.sizeBytes !== identity.sizeBytes || object.sha256 !== identity.sha256)
    throw new DocumentBackupIntegrityError('RECONCILE_BACKUP_CHECKSUM_MISMATCH');
  return Object.freeze({ ...identity, objectKey: key });
}

export function createR2DocumentReconcileStorage(
  primary: Pick<R2Bucket, 'get'>,
  backup: Pick<R2Bucket, 'get'>,
): DocumentReconcileStorage {
  const primaryGet = primary.get.bind(primary),
    backupGet = backup.get.bind(backup);
  const observe = (kind: 'PRIMARY' | 'BACKUP', key: string, signal: AbortSignal) =>
    observeR2DocumentObject(kind, key, kind === 'PRIMARY' ? primaryGet : backupGet, signal);
  return Object.freeze({
    primary: Object.freeze({ get: primaryGet }),
    observe,
    async verifyBackup(
      input: DocumentBackupIdentity,
      key: string,
      signal: AbortSignal,
    ): Promise<DocumentBackupProof | null> {
      const identity = Object.freeze({ ...input });
      if (key !== documentBackupObjectKey(identity))
        throw new DocumentBackupIntegrityError('RECONCILE_BACKUP_IDENTITY_MISMATCH');
      const object = await observe('BACKUP', key, signal);
      return verifyDocumentBackupObservation(identity, key, object);
    },
  });
}
