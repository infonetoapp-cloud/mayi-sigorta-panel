import { WorkerEntrypoint } from 'cloudflare:workers';
import { readBoundedDocumentStream } from './copy-resources';
import { createDocumentAdmission, trackedDocumentBucket } from './resource-admission';
const admission = createDocumentAdmission();
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
    body: ReadableStream<Uint8Array>,
  ): Promise<BackupRpcResult<DocumentBackupProof>> {
    try {
      const parsed = backupIdentitySchema.safeParse(input);
      if (!parsed.success || !(body instanceof ReadableStream))
        throw new DocumentBackupIntegrityError('BACKUP_INPUT_MISMATCH');
      if (!this.env.DOCUMENT_BACKUP_STORAGE) {
        void body.cancel().catch(() => undefined);
        return { ok: false, kind: 'IO' };
      }
      const permit = admission.acquire();
      if (!permit) {
        void body.cancel().catch(() => undefined);
        return { ok: false, kind: 'IO' };
      }
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120000);
      try {
        const bytes = await readBoundedDocumentStream(
          body,
          parsed.data.sizeBytes,
          parsed.data.sha256,
          controller.signal,
          (p) => permit.track(p),
        );
        const storage = this.env.DOCUMENT_BACKUP_STORAGE;
        const tracked = trackedDocumentBucket(storage, permit);
        const proof = await createR2DocumentBackupAdapter({
          get: tracked.get,
          put: (...args: Parameters<R2Bucket['put']>) => permit.run(() => storage.put(...args)),
        } as Pick<R2Bucket, 'get' | 'put'>).createAndVerify(
          Object.freeze(parsed.data),
          bytes,
          controller.signal,
        );
        return { ok: true, value: backupProofSchema.parse(proof) };
      } finally {
        clearTimeout(timer);
        permit.release();
      }
    } catch (error) {
      if (body instanceof ReadableStream && !body.locked) void body.cancel().catch(() => undefined);
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
      const permit = admission.acquire();
      if (!permit) return { ok: false, kind: 'IO' };
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 120000);
      try {
        const object = await observeR2DocumentObject(
          'BACKUP',
          key,
          trackedDocumentBucket(this.env.DOCUMENT_BACKUP_STORAGE, permit).get,
          controller.signal,
        );
        const parsed = backupObservationSchema.nullable().safeParse(object);
        return parsed.success ? { ok: true, value: parsed.data } : { ok: false, kind: 'INTEGRITY' };
      } finally {
        clearTimeout(timer);
        permit.release();
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
