import { DocumentBackupCapability } from '../../src/server/documents/private-backup-worker';
import type { DocumentBackupIdentity } from '../../src/server/documents/backup-storage';
import { countBucket, metrics, type CanaryMetrics } from './metrics';
/** CANARY ONLY: same reviewed leaf implementation, per-RPC safe measurement envelope.
 * No sample CPU/heap or in-memory aggregate falsely presented as provider evidence. */
export class MeasuredDocumentBackupCapability extends DocumentBackupCapability {
  private meter: CanaryMetrics;
  constructor(ctx: ExecutionContext, env: { DOCUMENT_BACKUP_STORAGE?: R2Bucket }) {
    const m = metrics();
    super(ctx, {
      DOCUMENT_BACKUP_STORAGE: env.DOCUMENT_BACKUP_STORAGE
        ? countBucket(env.DOCUMENT_BACKUP_STORAGE, m)
        : undefined,
    });
    this.meter = m;
  }
  async measuredCopy(id: DocumentBackupIdentity, body: ReadableStream<Uint8Array>) {
    const start = Date.now();
    const reply = await super.createAndVerify(id, body);
    return { reply, metrics: this.meter, wallMs: Date.now() - start };
  }
  async measuredObservation(key: string) {
    const start = Date.now();
    const reply = await super.observeBackup(key);
    return { reply, metrics: this.meter, wallMs: Date.now() - start };
  }
}
export default {
  fetch() {
    return new Response(null, { status: 404 });
  },
};
