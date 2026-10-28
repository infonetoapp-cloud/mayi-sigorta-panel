import type { DocumentJobQueueMessage } from './queue';
export const MAX_DOCUMENT_QUEUE_CONTROL_BYTES = 4096;
/** Closed control-plane shape. Never stringify arbitrary bodies just to size them. */
export function parseDocumentQueueControl(value: unknown): DocumentJobQueueMessage | null {
  try {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const keys = Object.keys(value),
      allowed = [
        'jobId',
        'jobType',
        'generation',
        'documentVersionId',
        'inputSha256',
        'deadLetterReplayId',
      ];
    if (keys.length < 5 || keys.length > 6 || keys.some((k) => !allowed.includes(k))) return null;
    const m = value as Record<string, unknown>;
    const jobId = m.jobId,
      jobType = m.jobType,
      generation = m.generation,
      documentVersionId = m.documentVersionId,
      inputSha256 = m.inputSha256,
      replay = m.deadLetterReplayId;
    const id = (s: unknown): s is string =>
      typeof s === 'string' && s.trim().length > 0 && s.length <= 255;
    if (
      !id(jobId) ||
      typeof jobType !== 'string' ||
      !['DOCUMENT_BACKUP', 'DOCUMENT_RECONCILE', 'DOCUMENT_SCAN', 'DOCUMENT_RESTORE'].includes(
        jobType,
      ) ||
      !Number.isSafeInteger(generation) ||
      (generation as number) < 1 ||
      (replay !== undefined && !id(replay))
    )
      return null;
    if (jobType === 'DOCUMENT_BACKUP' || jobType === 'DOCUMENT_SCAN') {
      if (
        !id(documentVersionId) ||
        typeof inputSha256 !== 'string' ||
        !/^[0-9a-f]{64}$/u.test(inputSha256)
      )
        return null;
    } else if (documentVersionId !== null || inputSha256 !== null) return null;
    const result = {
      jobId,
      jobType,
      generation,
      documentVersionId,
      inputSha256,
      ...(replay === undefined ? {} : { deadLetterReplayId: replay }),
    } as DocumentJobQueueMessage;
    if (
      new TextEncoder().encode(JSON.stringify(result)).byteLength > MAX_DOCUMENT_QUEUE_CONTROL_BYTES
    )
      return null;
    return Object.freeze(result);
  } catch {
    return null;
  }
}
