import type { DocumentJobQueueMessage } from './queue';
export interface ClosedCanaryEnv {
  DOCUMENTS_ENABLED?: string;
  DOCUMENT_JOBS_ENABLED?: string;
  DOCUMENT_CRON_ENABLED?: string;
  APP_ENV?: string;
  CANARY_QUEUE_COMMISSIONED?: string;
  CANARY_DATABASE_ID?: string;
  CANARY_PRIMARY_BUCKET?: string;
  CANARY_RECOVERY_BUCKET?: string;
  CANARY_RUN_ID?: string;
  CANARY_EXPECTED_SIZE?: string;
  DB: D1Database;
}
const issued = new WeakMap<
  object,
  {
    env: ClosedCanaryEnv;
    jobId: string;
    versionId: string | null;
    type: string;
    generation: number;
    checksum: string | null;
  }
>();
export function assertClosedCanaryEnvironment(env: ClosedCanaryEnv): void {
  if (
    env.DOCUMENTS_ENABLED !== 'false' ||
    (env.DOCUMENT_JOBS_ENABLED ?? 'false') !== 'false' ||
    (env.DOCUMENT_CRON_ENABLED ?? 'false') !== 'false' ||
    env.APP_ENV !== 'test' ||
    env.CANARY_QUEUE_COMMISSIONED !== 'true' ||
    !['1048576', '10485760', '20971520'].includes(env.CANARY_EXPECTED_SIZE ?? '') ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      env.CANARY_RUN_ID ?? '',
    ) ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(
      env.CANARY_DATABASE_ID ?? '',
    ) ||
    env.CANARY_DATABASE_ID === '1dd3b04e-14b8-459c-86d0-5c3c3ed8127d' ||
    !/^mayisigorta-m4-canary-[a-z0-9-]+-primary$/u.test(env.CANARY_PRIMARY_BUCKET ?? '') ||
    !/^mayisigorta-m4-canary-[a-z0-9-]+-recovery$/u.test(env.CANARY_RECOVERY_BUCKET ?? '')
  )
    throw new Error('CANARY_SCOPE_DENIED');
}
/** Only an in-process opaque capability; never a flag/header/Queue payload token.
 * Issuer exists for the separate, public-404 synthetic commissioner, not an API.
 * Declared resource names are additional guards, NOT provider binding readback. */
export async function issueClosedCanaryPermit(
  env: ClosedCanaryEnv,
  message: DocumentJobQueueMessage,
): Promise<object> {
  assertClosedCanaryEnvironment(env);
  const scope = await env.DB.prepare(
    'SELECT backup_job_id,reconcile_job_id,version_id,checksum,size_bytes FROM p0_document_canary_scope WHERE run_id=?',
  )
    .bind(env.CANARY_RUN_ID)
    .first<{
      backup_job_id: string;
      reconcile_job_id: string | null;
      version_id: string;
      checksum: string;
      size_bytes: number;
    }>();
  if (
    !scope ||
    ![1048576, 10485760, 20971520].includes(scope.size_bytes) ||
    scope.size_bytes !== Number(env.CANARY_EXPECTED_SIZE) ||
    message.generation !== 1 ||
    !(
      (message.jobType === 'DOCUMENT_BACKUP' &&
        message.jobId === scope.backup_job_id &&
        message.documentVersionId === scope.version_id &&
        message.inputSha256 === scope.checksum) ||
      (message.jobType === 'DOCUMENT_RECONCILE' &&
        message.jobId === scope.reconcile_job_id &&
        message.documentVersionId === null &&
        message.inputSha256 === null)
    )
  )
    throw new Error('CANARY_SCOPE_DENIED');
  const permit = Object.freeze({});
  issued.set(permit, {
    env,
    jobId: message.jobId,
    versionId: message.documentVersionId,
    type: message.jobType,
    generation: message.generation,
    checksum: message.inputSha256,
  });
  return permit;
}
export function isClosedCanaryPermit(
  permit: unknown,
  env: ClosedCanaryEnv,
  batch: MessageBatch<DocumentJobQueueMessage>,
): boolean {
  if (!permit || typeof permit !== 'object') return false;
  const p = issued.get(permit);
  if (!p || p.env !== env || batch.messages.length !== 1) return false;
  try {
    assertClosedCanaryEnvironment(env);
  } catch {
    return false;
  }
  const m = batch.messages[0]?.body;
  const allowed =
    m?.jobId === p.jobId &&
    m.jobType === p.type &&
    m.generation === p.generation &&
    m.documentVersionId === p.versionId &&
    m.inputSha256 === p.checksum;
  if (allowed) issued.delete(permit);
  return allowed;
}
