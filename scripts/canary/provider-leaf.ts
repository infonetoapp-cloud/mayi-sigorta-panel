import { MeasuredDocumentBackupCapability } from './document-leaf';
import { readProviderInventory } from './provider-inventory';
import { emitCanaryMarker } from './attribution';
import type { DocumentBackupIdentity } from '../../src/server/documents/backup-storage';
/** Temporary canary only; accepted copy implementation and meter stay unchanged. */
export class ProviderCanaryLeaf extends MeasuredDocumentBackupCapability {
  #inventoryStorage: R2Bucket;
  #logging: { CANARY_LOGS_ENABLED?: string; CANARY_RUN_ID?: string; CANARY_EXPECTED_SIZE?: string };
  constructor(
    ctx: ExecutionContext,
    env: {
      DOCUMENT_BACKUP_STORAGE?: R2Bucket;
      CANARY_RECOVERY_BUCKET?: string;
      CANARY_LOGS_ENABLED?: string;
      CANARY_RUN_ID?: string;
      CANARY_EXPECTED_SIZE?: string;
    },
  ) {
    if (
      !env.DOCUMENT_BACKUP_STORAGE ||
      !/^mayisigorta-m4-canary-[a-z0-9-]+-recovery$/u.test(env.CANARY_RECOVERY_BUCKET ?? '')
    )
      throw new Error('CANARY_INVENTORY_SCOPE');
    super(ctx, env);
    this.#inventoryStorage = env.DOCUMENT_BACKUP_STORAGE;
    this.#logging = {
      CANARY_LOGS_ENABLED: env.CANARY_LOGS_ENABLED,
      CANARY_RUN_ID: env.CANARY_RUN_ID,
      CANARY_EXPECTED_SIZE: env.CANARY_EXPECTED_SIZE,
    };
  }
  #correlate(c?: { runId: string; size: number; jobId: string }) {
    if (
      this.#logging.CANARY_LOGS_ENABLED === 'true' &&
      (!c ||
        c.runId !== this.#logging.CANARY_RUN_ID ||
        String(c.size) !== this.#logging.CANARY_EXPECTED_SIZE)
    )
      throw new Error('CANARY_RPC_CORRELATION_DENIED');
    return c?.jobId ?? null;
  }
  async measuredCopy(
    id: DocumentBackupIdentity,
    body: ReadableStream<Uint8Array>,
    c?: { runId: string; size: number; jobId: string },
  ) {
    const job = this.#correlate(c);
    emitCanaryMarker(this.#logging, 'rpc_leaf_start', job, 'start');
    const result = await super.measuredCopy(id, body);
    emitCanaryMarker(this.#logging, 'rpc_leaf_complete', job, result.reply.ok ? 'ok' : 'fail');
    return result;
  }
  async measuredObservation(key: string, c?: { runId: string; size: number; jobId: string }) {
    const job = this.#correlate(c);
    emitCanaryMarker(this.#logging, 'rpc_leaf_start', job, 'start');
    const result = await super.measuredObservation(key);
    emitCanaryMarker(this.#logging, 'rpc_leaf_complete', job, result.reply.ok ? 'ok' : 'fail');
    return result;
  }
  async inventory() {
    return readProviderInventory(this.#inventoryStorage, 'recovery');
  }
}
export default {
  fetch() {
    return new Response(null, { status: 404 });
  },
};
