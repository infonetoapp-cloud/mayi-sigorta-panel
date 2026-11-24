import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { runBackup, type BackupEnv } from './core';
import { BackupFailure, safeFailure } from './provider';
import { scheduledBackup } from './scheduler';
import { readCapacity } from './capacity';
import { validateBackupEvidence } from '../backup-monitor/evidence';
import { GZIP_SQL_FILE } from './format';

export class D1BackupWorkflow extends WorkflowEntrypoint<BackupEnv> {
  async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    if (
      event.payload &&
      typeof event.payload === 'object' &&
      'mode' in event.payload &&
      event.payload.mode === 'transport-diagnostic'
    ) {
      throw new Error('BACKUP_DIAGNOSTIC_DISABLED');
    }
    return runBackup(
      this.env,
      {
        do: (name, callback) =>
          step.do(
            name,
            {
              retries: {
                limit: name === 'start-export-once' || name === 'poll-download-store-sql' ? 0 : 1,
                delay: '1 second',
                backoff: 'constant',
              },
              timeout: '5 minutes',
            },
            async () => {
              try {
                const value = await callback();
                if (name === 'write-verify-COMPLETE-last') {
                  const result = value as Awaited<ReturnType<typeof runBackup>>;
                  console.info({
                    event: 'MAYI_D1_BACKUP_COMPLETE',
                    generationId: result.generation,
                    instanceId: event.instanceId,
                    completedAt: new Date().toISOString(),
                    sqlBytes: result.sqlSize,
                    capacityWarning: result.capacityWarning,
                    utilizationPct: result.utilizationPct,
                    totalMs: result.totalMs,
                  });
                }
                return value;
              } catch (error) {
                if (error instanceof BackupFailure) throw error;
                throw safeFailure('workflow-step', 'local-failure');
              }
            },
          ),
      },
      event.payload &&
        typeof event.payload === 'object' &&
        'scheduledAt' in event.payload &&
        typeof event.payload.scheduledAt === 'string'
        ? event.payload.scheduledAt
        : new Date(event.timestamp).toISOString(),
      event.instanceId,
      undefined,
      'gzip',
    );
  }
}
// No fetch handler. No route/workers.dev/previews; only private Workflow management and schedule.
export default {
  async scheduled(controller: ScheduledController, env: BackupEnv & { BACKUP_WORKFLOW: Workflow }) {
    const check = controller.cron === '0 23 * * *';
    let size: number | null = null;
    try {
      const result = await scheduledBackup(
        controller.scheduledTime,
        controller.cron,
        env.BACKUP_WORKFLOW,
        env.RECOVERY,
      );
      if (check && result.outcome === 'COMPLETE') {
        const prefix = result.sqlPrefix!;
        const [sql, manifest, complete] = await Promise.all([
          env.RECOVERY.head(prefix + GZIP_SQL_FILE),
          env.RECOVERY.get(prefix + 'manifest.json'),
          env.RECOVERY.get(prefix + 'COMPLETE.json'),
        ]);
        if (!sql || !manifest || !complete || manifest.size > 8192 || complete.size > 8192)
          throw safeFailure('storage-verify', 'verification-failed');
        const evidence = validateBackupEvidence(
          {
            sql,
            manifestHead: manifest,
            completeHead: complete,
            manifest: await manifest.json(),
            complete: await complete.json(),
          },
          Date.now(),
        );
        if (evidence.status === 'QUERY_OR_PROVIDER_FAILURE')
          throw safeFailure('storage-verify', 'verification-failed');
        size = sql.size;
      }
      if (check && result.outcome === 'MISSING')
        console.warn({ event: 'MAYI_D1_DAILY_BACKUP_MISSING', generationId: result.id });
    } catch (error) {
      console.warn({ event: 'MAYI_D1_DAILY_BACKUP_CHECK_FAILED', cron: controller.cron });
      if (!check) throw error;
    }
    if (check) {
      try {
        const capacity = await readCapacity(env, size);
        const signal = { event: 'MAYI_R2_CAPACITY', ...capacity };
        if (capacity.warning) console.warn({ ...signal, event: 'MAYI_R2_CAPACITY_WARNING' });
        else console.info(signal);
      } catch {
        console.warn({ event: 'MAYI_R2_CAPACITY_UNAVAILABLE' });
      }
    }
  },
};
