import { generationPrefix, type BackupEnv } from './core';
import { safeFailure } from './provider';

export const BACKUP_CRONS = ['0 21 * * *', '0 22 * * *', '0 23 * * *'] as const;
const hour = 3600000;
type Instance = { id: string; status(): Promise<{ status: string }> };
export interface WorkflowCreator {
  create(options: { id: string; params: { scheduledAt: string } }): Promise<Instance>;
  get(id: string): Promise<Instance>;
}

async function createOnce(binding: WorkflowCreator, id: string, scheduledAt: string) {
  try {
    if ((await binding.create({ id, params: { scheduledAt } })).id === id) return;
  } catch {
    // A duplicate or ambiguous create is reconciled through the same ID.
  }
  try {
    const instance = await binding.get(id);
    if (instance.id === id && (await instance.status()).status !== 'unknown') return;
  } catch {
    // Surface a sanitized failure when the provider cannot confirm creation.
  }
  throw safeFailure('cron-create', 'provider-error');
}

export async function scheduledBackup(
  scheduledTime: number,
  cron: string,
  binding: WorkflowCreator,
  recovery: Pick<BackupEnv['RECOVERY'], 'head'>,
) {
  const stage = BACKUP_CRONS.findIndex((entry) => entry === cron);
  if (
    stage < 0 ||
    !Number.isSafeInteger(scheduledTime) ||
    scheduledTime < 0 ||
    new Date(scheduledTime).getUTCHours() !== 21 + stage
  )
    throw safeFailure('cron-create', 'local-failure');
  // Cloudflare can supply a timestamp after the hour. Keep one key for the scheduled slot.
  const slotTime = scheduledTime - (scheduledTime % hour);
  const primarySlot = slotTime - stage * hour;
  const id = 'd1-backup-daily-' + new Date(primarySlot + 3 * hour).toISOString().slice(0, 10);
  const primaryAt = new Date(primarySlot).toISOString();
  const retryAt = new Date(primarySlot + hour).toISOString();
  if (stage === 0) {
    await createOnce(binding, id, primaryAt);
    return { id, outcome: 'PRIMARY' as const };
  }
  const primary = await recovery.head(generationPrefix(primaryAt, id) + 'COMPLETE.json');
  if (primary)
    return { id, outcome: 'COMPLETE' as const, sqlPrefix: generationPrefix(primaryAt, id) };
  const retryId = id + '-retry';
  if (stage === 2) {
    const sqlPrefix = generationPrefix(retryAt, retryId);
    const marker = await recovery.head(sqlPrefix + 'COMPLETE.json');
    return marker
      ? { id, outcome: 'COMPLETE' as const, sqlPrefix }
      : { id, outcome: 'MISSING' as const };
  }
  const instance = await binding.get(id).catch(() => null);
  if (!instance) {
    await createOnce(binding, id, primaryAt);
    return { id, outcome: 'PRIMARY' as const };
  }
  if (instance.id !== id) throw safeFailure('cron-create', 'provider-error');
  const { status } = await instance.status();
  if (status === 'unknown') {
    await createOnce(binding, id, primaryAt);
    return { id, outcome: 'PRIMARY' as const };
  }
  if (status === 'errored' || status === 'terminated') {
    // A completed marker can outlive an error from the final Workflow readback.
    if (!(await recovery.head(generationPrefix(primaryAt, id) + 'COMPLETE.json')))
      await createOnce(binding, retryId, retryAt);
    return { id, outcome: 'RETRY' as const };
  }
  return { id, outcome: 'SKIPPED' as const };
}
