import { processDocumentBackupMessage } from './backup';
import type { DocumentBackupAdapter } from './backup-storage';
import { processDocumentReconcileMessage } from './reconcile';
import type { DocumentReconcileStorage } from './reconcile-storage';
import type { DocumentJobQueueMessage } from './queue';

/** Queue is an accelerator. D1 lease/state and periodic redispatch survive retention/exhaustion. */
export async function consumeDurableDocumentJobs(
  batch: MessageBatch<DocumentJobQueueMessage>,
  db: D1Database,
  source: Pick<R2Bucket, 'get'> | undefined,
  enabled: boolean,
  backup?: DocumentBackupAdapter,
  reconcile?: DocumentReconcileStorage,
): Promise<void> {
  for (const message of batch.messages) {
    try {
      // Retired scanner deliveries never call an adapter or start another attempt.
      if (message.body?.jobType === 'DOCUMENT_SCAN') {
        message.ack();
        continue;
      }
      if (!enabled) {
        // D1 retains the job; enabling the module resumes periodic redispatch.
        message.ack();
        continue;
      }
      let result;
      if (message.body?.jobType === 'DOCUMENT_BACKUP') {
        if (!source || !backup) {
          message.retry({ delaySeconds: 60 });
          continue;
        }
        result = await processDocumentBackupMessage(db, source, backup, message.body);
      } else if (message.body?.jobType === 'DOCUMENT_RECONCILE') {
        if (!reconcile) {
          message.retry({ delaySeconds: 60 });
          continue;
        }
        result = await processDocumentReconcileMessage(db, reconcile, message.body);
      } else {
        // No business effect can originate from an unsupported/poison delivery.
        message.ack();
        continue;
      }
      if (result === 'RETRY_DELIVERY') message.retry({ delaySeconds: 60 });
      else message.ack();
    } catch {
      message.retry({ delaySeconds: 60 });
    }
  }
}
