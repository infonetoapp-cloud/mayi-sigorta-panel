import { z } from 'zod';
import { readCustomerResource } from '../customers/customer-resource';

const id = z.string().min(1).max(128);
const version = z.number().int().positive().safe();
const base = z.object({ renewalId: id, renewalVersion: version, taskId: id, taskVersion: version });
const cycle = z.object({ caseId: id, expectedCaseVersion: version });
export const closeContextSchema = base.extend({
  salesCycle: cycle.extend({ canCreateFollowup: z.boolean() }).nullable(),
});
export const reopenContextSchema = base.extend({
  salesCycle: cycle
    .extend({
      resultRevisionId: id,
      successorCaseId: id.nullable(),
      successorDueAt: z.string().datetime().nullable(),
      canRecall: z.boolean(),
    })
    .nullable(),
});
export async function readCloseCycle(id: string, signal: AbortSignal) {
  return closeContextSchema.parse(
    await readCustomerResource(
      `/api/renewals/${encodeURIComponent(id)}/cycle-context?mode=close`,
      signal,
    ),
  );
}
export const renewalReopenResultSchema = z.object({
  renewalId: id,
  renewalVersion: version,
  primaryTaskId: id,
  taskVersion: z.literal(1),
  closedTaskId: id,
  closedTaskVersion: version,
  salesCycle: cycle
    .extend({
      resultRevisionId: id,
      successorCaseId: id.nullable(),
      successorTaskId: id.nullable(),
    })
    .optional(),
});
