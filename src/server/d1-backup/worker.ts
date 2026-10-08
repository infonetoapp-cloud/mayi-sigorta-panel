import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from 'cloudflare:workers';
import { runBackup, type BackupEnv } from './core';
import { BackupFailure, safeFailure } from './provider';
import { scheduledBackup } from './scheduler';
import { runTransportDiagnostic } from './diagnostic';
export class D1BackupWorkflow extends WorkflowEntrypoint<BackupEnv> {
  async run(event: WorkflowEvent<unknown>, step: WorkflowStep) {
    if (
      event.payload &&
      typeof event.payload === 'object' &&
      'mode' in event.payload &&
      event.payload.mode === 'transport-diagnostic'
    ) {
      return step.do(
        'transport-diagnostic-once',
        { retries: { limit: 0, delay: '1 second' }, timeout: '1 minute' },
        () => runTransportDiagnostic(this.env),
      );
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
                return await callback();
              } catch (error) {
                if (error instanceof BackupFailure) throw error;
                throw safeFailure('workflow-step', 'local-failure');
              }
            },
          ),
      },
      new Date(event.timestamp).toISOString(),
      event.instanceId,
    );
  }
}
// No fetch handler. No route/workers.dev/previews; only private Workflow management and schedule.
export default {
  async scheduled(controller: ScheduledController, env: BackupEnv & { BACKUP_WORKFLOW: Workflow }) {
    await scheduledBackup(controller.scheduledTime, env.BACKUP_WORKFLOW);
  },
};
