import { WorkerEntrypoint } from 'cloudflare:workers';
import {
  createR2DocumentBackupAdapter,
  DocumentBackupIntegrityError,
  type DocumentBackupIdentity,
  type DocumentBackupProof,
} from './backup-storage';
import { observeR2DocumentObject, type ReconcileObjectObservation } from './reconcile-storage';
import {
  backupIdentitySchema,
  backupObservationSchema,
  backupProofSchema,
  type BackupRpcResult,
} from './backup-capability-contract';
export interface PrivateDocumentBackupEnv {
  readonly DOCUMENT_BACKUP_STORAGE?: R2Bucket;
}
/** Separate storage authority, not a business Worker or D1 backup runner.
 * No DB/primary bucket/admin credential, no delete/list/overwrite/download RPC.
 * Not bound/deployed by production CRM config in this LOCAL-only slice. */
export class DocumentBackupCapability extends WorkerEntrypoint<PrivateDocumentBackupEnv> {
  async createAndVerify(
    input: DocumentBackupIdentity,
    bytes: Uint8Array<ArrayBuffer>,
  ): Promise<BackupRpcResult<DocumentBackupProof>> {
    try {
      const parsed = backupIdentitySchema.safeParse(input);
      if (
        !parsed.success ||
        !(bytes instanceof Uint8Array) ||
        bytes.byteLength !== parsed.data.sizeBytes
      )
        throw new DocumentBackupIntegrityError('BACKUP_INPUT_MISMATCH');
      if (!this.env.DOCUMENT_BACKUP_STORAGE) return { ok: false, kind: 'IO' };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120000);
      try {
        const proof = await createR2DocumentBackupAdapter(
          this.env.DOCUMENT_BACKUP_STORAGE,
        ).createAndVerify(Object.freeze(parsed.data), bytes, controller.signal);
        return { ok: true, value: backupProofSchema.parse(proof) };
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      return {
        ok: false,
        kind: error instanceof DocumentBackupIntegrityError ? 'INTEGRITY' : 'IO',
      };
    }
  }
  async observeBackup(key: string): Promise<BackupRpcResult<ReconcileObjectObservation | null>> {
    try {
      if (
        typeof key !== 'string' ||
        !/^backup\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(key)
      )
        return { ok: false, kind: 'INTEGRITY' };
      if (!this.env.DOCUMENT_BACKUP_STORAGE) return { ok: false, kind: 'IO' };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120000);
      try {
        const object = await observeR2DocumentObject(
          'BACKUP',
          key,
          this.env.DOCUMENT_BACKUP_STORAGE.get.bind(this.env.DOCUMENT_BACKUP_STORAGE),
          controller.signal,
        );
        const parsed = backupObservationSchema.nullable().safeParse(object);
        return parsed.success ? { ok: true, value: parsed.data } : { ok: false, kind: 'INTEGRITY' };
      } finally {
        clearTimeout(timer);
      }
    } catch (error) {
      return {
        ok: false,
        kind: error instanceof DocumentBackupIntegrityError ? 'INTEGRITY' : 'IO',
      };
    }
  }
  // Service RPC only; a guessed/exposed URL cannot read/write document content.
  fetch(): Response {
    return new Response(null, { status: 404 });
  }
}
export default {
  fetch(): Response {
    return new Response(null, { status: 404 });
  },
};
