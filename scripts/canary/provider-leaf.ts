import { MeasuredDocumentBackupCapability } from './document-leaf';
import { readProviderInventory } from './provider-inventory';
/** Temporary canary only; accepted copy implementation and meter stay unchanged. */
export class ProviderCanaryLeaf extends MeasuredDocumentBackupCapability {
  #inventoryStorage: R2Bucket;
  constructor(
    ctx: ExecutionContext,
    env: { DOCUMENT_BACKUP_STORAGE?: R2Bucket; CANARY_RECOVERY_BUCKET?: string },
  ) {
    if (
      !env.DOCUMENT_BACKUP_STORAGE ||
      !/^mayisigorta-m4-canary-[a-z0-9-]+-recovery$/u.test(env.CANARY_RECOVERY_BUCKET ?? '')
    )
      throw new Error('CANARY_INVENTORY_SCOPE');
    super(ctx, env);
    this.#inventoryStorage = env.DOCUMENT_BACKUP_STORAGE;
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
