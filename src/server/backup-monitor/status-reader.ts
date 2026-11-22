import { z } from 'zod';
import { readBoundedJson } from '../auth/routes';
import type { Decision } from './evidence';

const timestamp = z.number().int().nonnegative();
const storedObservation = z
  .object({
    status: z.enum(['HEALTHY', 'BACKUP_STALE', 'QUERY_OR_PROVIDER_FAILURE']),
    checkedAt: timestamp,
    reason: z.string().regex(/^[A-Z0-9_]{1,64}$/),
    exportAt: timestamp.optional(),
    completeAt: timestamp.optional(),
  })
  .superRefine((value, context) => {
    const { status, checkedAt, exportAt, completeAt } = value;
    if (
      (status === 'HEALTHY' && (exportAt === undefined || completeAt === undefined)) ||
      (exportAt !== undefined &&
        (completeAt === undefined || exportAt > completeAt || completeAt > checkedAt)) ||
      (completeAt !== undefined && exportAt === undefined)
    )
      context.addIssue({ code: 'custom', message: 'INVALID_OBSERVATION_TIMESTAMPS' });
  });

/** This endpoint is reachable only through the dedicated service binding. */
export async function readPublishedBackupObservation(
  service: Fetcher | undefined,
  signal: AbortSignal,
): Promise<Decision | null> {
  if (!service) return null;
  const response = await service.fetch('https://backup-observer.invalid/internal/latest', {
    method: 'GET',
    redirect: 'error',
    signal,
  });
  if (!response.ok) {
    void response.body?.cancel();
    return null;
  }
  return storedObservation.parse(await readBoundedJson(response, 1024));
}
