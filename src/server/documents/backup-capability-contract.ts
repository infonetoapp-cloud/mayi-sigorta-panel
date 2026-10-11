import { z } from 'zod';
import { MAX_DOCUMENT_UPLOAD_BYTES } from './validation';
import type { DocumentBackupIdentity, DocumentBackupProof } from './backup-storage';
import type { ReconcileObjectObservation } from './reconcile-storage';
const id = z
  .string()
  .min(1)
  .max(255)
  .refine((s) => s.trim() === s);
export const backupIdentitySchema = z.strictObject({
  agencyId: id,
  documentVersionId: id,
  generation: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  sizeBytes: z.number().int().min(1).max(MAX_DOCUMENT_UPLOAD_BYTES),
});
export const backupProofSchema = backupIdentitySchema.extend({
  objectKey: z
    .string()
    .regex(/^backup\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u),
});
export const backupObservationSchema = z.strictObject({
  sha256: z.string().regex(/^[0-9a-f]{64}$/u),
  sizeBytes: z.number().int().min(1).max(MAX_DOCUMENT_UPLOAD_BYTES),
  agencyId: z.string().max(255).nullable(),
  documentVersionId: z.string().max(255).nullable(),
  generation: z.string().max(32).nullable(),
  declaredSha256: z.string().max(255).nullable(),
});
export type BackupRpcResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly kind: 'INTEGRITY' | 'IO' };
/** Provider service RPC, NOT an Env callback, raw R2 bucket or HTTP Fetcher.
 * A separately bound storage leaf supplies exactly these two methods. */
export interface DocumentBackupCapability {
  createAndVerify(
    identity: DocumentBackupIdentity,
    bytes: Uint8Array<ArrayBuffer>,
  ): Promise<BackupRpcResult<DocumentBackupProof>>;
  observeBackup(key: string): Promise<BackupRpcResult<ReconcileObjectObservation | null>>;
}
export const backupRpcFailureSchema = z.strictObject({
  ok: z.literal(false),
  kind: z.enum(['INTEGRITY', 'IO']),
});
