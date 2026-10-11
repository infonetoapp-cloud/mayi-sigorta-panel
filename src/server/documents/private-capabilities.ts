import { z } from 'zod';
import {
  backupAbortable,
  DocumentBackupIntegrityError,
  documentBackupObjectKey,
  type DocumentBackupAdapter,
  type DocumentBackupIdentity,
} from './backup-storage';
import {
  observeR2DocumentObject,
  verifyDocumentBackupObservation,
  type DocumentReconcileStorage,
} from './reconcile-storage';
import {
  backupIdentitySchema,
  backupProofSchema,
  backupObservationSchema,
  backupRpcFailureSchema,
  type DocumentBackupCapability,
} from './backup-capability-contract';
async function rpc<T>(
  invoke: () => Promise<unknown>,
  schema: z.ZodType<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let response: unknown;
  try {
    response = await backupAbortable(invoke(), signal);
  } catch {
    throw new Error('DOCUMENT_BACKUP_CAPABILITY_IO');
  }
  let parsed: ReturnType<ReturnType<typeof z.union>['safeParse']>;
  try {
    parsed = z
      .union([z.strictObject({ ok: z.literal(true), value: schema }), backupRpcFailureSchema])
      .safeParse(response);
  } catch {
    throw new DocumentBackupIntegrityError('BACKUP_PROOF_MISMATCH');
  }
  if (!parsed.success) throw new DocumentBackupIntegrityError('BACKUP_PROOF_MISMATCH');
  const result = parsed.data as { ok: true; value: T } | { ok: false; kind: 'INTEGRITY' | 'IO' };
  if (!result.ok) {
    if (result.kind === 'INTEGRITY')
      throw new DocumentBackupIntegrityError('BACKUP_PROOF_MISMATCH');
    throw new Error('DOCUMENT_BACKUP_CAPABILITY_IO');
  }
  return result.value;
}
/** Explicit provider-native private binding. No raw recovery bucket, default
 * target, HTTP fallback, public fetch or capability selected from a request. */
export function composePrivateDocumentCapabilities(
  primary: Pick<R2Bucket, 'get'> | undefined,
  peer: DocumentBackupCapability | undefined,
):
  | {
      readonly source: Pick<R2Bucket, 'get'>;
      readonly backup: DocumentBackupAdapter;
      readonly reconcile: DocumentReconcileStorage;
    }
  | undefined {
  if (!primary || !peer) return undefined;
  let get: R2Bucket['get'],
    create: DocumentBackupCapability['createAndVerify'],
    observe: DocumentBackupCapability['observeBackup'];
  // Service RPC method stubs are already bound remote callables; invoking .bind
  // on them is another RPC path, not Function.prototype.bind. Capture directly.
  try {
    get = primary.get.bind(primary);
    create = peer.createAndVerify;
    observe = peer.observeBackup;
  } catch {
    return undefined;
  }
  const source = Object.freeze({
    get: (...args: Parameters<R2Bucket['get']>) => {
      if (
        !/^quarantine\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(args[0])
      )
        throw new DocumentBackupIntegrityError('BACKUP_SOURCE_IDENTITY_INVALID');
      return get(...args);
    },
  }) as Pick<R2Bucket, 'get'>;
  const backup: DocumentBackupAdapter = Object.freeze({
    async createAndVerify(
      input: DocumentBackupIdentity,
      bytes: Uint8Array<ArrayBuffer>,
      signal: AbortSignal,
    ) {
      const parsed = backupIdentitySchema.safeParse(input);
      if (!parsed.success || bytes.byteLength !== parsed.data.sizeBytes)
        throw new DocumentBackupIntegrityError('BACKUP_INPUT_MISMATCH');
      const identity = Object.freeze(parsed.data);
      const copy = new Uint8Array(bytes);
      const proof = await rpc(() => create(identity, copy), backupProofSchema, signal);
      if (
        proof.objectKey !== documentBackupObjectKey(identity) ||
        Object.entries(identity).some(
          ([key, value]) => proof[key as keyof typeof identity] !== value,
        )
      )
        throw new DocumentBackupIntegrityError('BACKUP_PROOF_MISMATCH');
      return Object.freeze(proof);
    },
  });
  const reconcile: DocumentReconcileStorage = Object.freeze({
    primary: source,
    async observe(kind: 'PRIMARY' | 'BACKUP', key: string, signal: AbortSignal) {
      if (kind === 'PRIMARY') return observeR2DocumentObject('PRIMARY', key, source.get, signal);
      if (
        kind !== 'BACKUP' ||
        !/^backup\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(key)
      )
        throw new DocumentBackupIntegrityError('RECONCILE_OBJECT_KEY_INVALID');
      return rpc(() => observe(key), backupObservationSchema.nullable(), signal);
    },
    async verifyBackup(input: DocumentBackupIdentity, key: string, signal: AbortSignal) {
      const parsed = backupIdentitySchema.safeParse(input);
      if (!parsed.success || key !== documentBackupObjectKey(parsed.data))
        throw new DocumentBackupIntegrityError('RECONCILE_BACKUP_IDENTITY_MISMATCH');
      const identity = Object.freeze(parsed.data);
      const object = await rpc(() => observe(key), backupObservationSchema.nullable(), signal);
      return verifyDocumentBackupObservation(identity, key, object);
    },
  });
  return Object.freeze({ source, backup, reconcile });
}
