import { safeFailure } from './provider';
export interface WorkflowCreator {
  create(options: { id: string }): Promise<{ id: string }>;
  get(id: string): Promise<{ id: string }>;
}
export const FUTURE_BACKUP_CRON = '*/30 * * * *';
export async function scheduledBackup(
  scheduledTime: number,
  binding: WorkflowCreator,
): Promise<void> {
  if (!Number.isSafeInteger(scheduledTime) || scheduledTime < 0)
    throw safeFailure('cron-create', 'local-failure');
  const id = 'd1-backup-slot-' + Math.floor(scheduledTime / (30 * 60 * 1000));
  try {
    const instance = await binding.create({ id });
    if (instance.id !== id) throw safeFailure('cron-create', 'provider-error');
  } catch {
    // Cloudflare create rejects existing IDs. Also handle ambiguous transport failure by exact-ID readback.
    // Never manufacture a new ID on retry, and never restart an existing errored generation.
    try {
      const instance = await binding.get(id);
      if (instance.id !== id) throw new Error('IDENTITY_MISMATCH');
    } catch {
      throw safeFailure('cron-create', 'provider-error');
    }
  }
}
