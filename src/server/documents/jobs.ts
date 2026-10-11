import { processDocumentBackupMessage } from './backup';
import type { DocumentBackupAdapter } from './backup-storage';
import { processDocumentReconcileMessage } from './reconcile';
import type { DocumentReconcileStorage } from './reconcile-storage';
import type { DocumentJobQueueMessage } from './queue';
import { parseDocumentQueueControl } from './queue-message';
import {
  createDocumentAdmission,
  trackedDocumentDatabase,
  trackedDocumentBucket,
  type DocumentPermit,
} from './resource-admission';
const admission = createDocumentAdmission();

/** Queue is an accelerator. D1 lease/state and periodic redispatch survive retention/exhaustion. */
export async function consumeDurableDocumentJobs(
  batch: MessageBatch<DocumentJobQueueMessage>,
  db: D1Database,
  source: Pick<R2Bucket, 'get'> | undefined,
  enabled: boolean,
  backup?: DocumentBackupAdapter,
  reconcile?: DocumentReconcileStorage,
  resources?: (permit: DocumentPermit) =>
    | {
        source: Pick<R2Bucket, 'get'>;
        backup: DocumentBackupAdapter;
        reconcile: DocumentReconcileStorage;
      }
    | undefined,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      const control = parseDocumentQueueControl(message.body);
      if (!control) {
        message.ack();
        continue;
      }
      // Retired scanner deliveries never call an adapter or start another attempt.
      if (control.jobType === 'DOCUMENT_SCAN') {
        message.ack();
        continue;
      }
      if (!enabled) {
        // D1 retains the job; enabling the module resumes periodic redispatch.
        message.ack();
        continue;
      }
      let result;
      const permit = admission.acquire();
      if (!permit) {
        message.retry({ delaySeconds: 60 });
        continue;
      }
      try {
        const scopedDb = trackedDocumentDatabase(db, permit);
        const composed = resources?.(permit);
        const effectiveSource =
            composed?.source ?? (source ? trackedDocumentBucket(source, permit) : undefined),
          effectiveBackup = backup ?? composed?.backup,
          effectiveReconcile = reconcile ?? composed?.reconcile;
        if (control.jobType === 'DOCUMENT_BACKUP') {
          if (!effectiveSource || !effectiveBackup) {
            message.retry({ delaySeconds: 60 });
            continue;
          }
          result = await processDocumentBackupMessage(
            scopedDb,
            effectiveSource,
            effectiveBackup,
            control,
          );
        } else if (control.jobType === 'DOCUMENT_RECONCILE') {
          if (!effectiveReconcile) {
            message.retry({ delaySeconds: 60 });
            continue;
          }
          result = await processDocumentReconcileMessage(scopedDb, effectiveReconcile, control);
        } else {
          // No business effect can originate from an unsupported/poison delivery.
          message.ack();
          continue;
        }
        if (result === 'RETRY_DELIVERY') message.retry({ delaySeconds: 60 });
        else message.ack();
      } finally {
        permit.release();
      }
    } catch {
      message.retry({ delaySeconds: 60 });
    }
  }
}
