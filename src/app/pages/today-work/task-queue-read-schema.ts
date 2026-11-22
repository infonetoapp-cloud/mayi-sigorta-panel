import { z } from 'zod';
import { renewalStateLabels } from '../../../shared/renewal-browsing';
import type { RenewalStateCode, UnifiedTodayTasksResponseData } from '../../../shared/types';

const id = z.string().min(1);
const nullableText = z.string().nullable();
const timestamp = z.iso.datetime({ offset: true });
const version = z.number().int().positive();
const common = {
  taskId: id,
  customerId: id,
  customerDisplayName: id,
  title: id,
  dueAt: timestamp,
  taskVersion: version,
  assigneeMembershipId: id.nullable(),
  bucket: z.enum(['OVERDUE', 'TODAY', 'UPCOMING']),
  isUnassigned: z.boolean(),
  needsReassignment: z.boolean().optional(),
};
const row = z.union([
  z.object({
    ...common,
    kind: z.literal('GENERAL'),
    caseId: id.nullable(),
    branchName: nullableText,
  }),
  z.object({
    ...common,
    kind: z.literal('RENEWAL_FOLLOWUP').optional(),
    renewalId: id,
    customerEmail: nullableText,
    customerPhone: nullableText,
    policyId: id.nullable(),
    policyNumber: nullableText,
    policyEndDate: nullableText,
    policyBranchName: nullableText.optional(),
    policyInsurerName: nullableText.optional(),
    policyInsurerCustomerNumber: nullableText.optional(),
    renewalAssigneeMembershipId: id.nullable(),
    renewalState: z.enum(Object.keys(renewalStateLabels) as RenewalStateCode[]),
    renewalVersion: version,
  }),
]);

const timezone = z
  .string()
  .min(1)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('tr-TR', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  });
export const taskQueueReadSchema = z
  .object({
    items: z.array(row),
    unassignedItems: z.array(row),
    nextCursor: id.nullable(),
    hasMore: z.boolean(),
    unassignedNextCursor: id.nullable(),
    unassignedHasMore: z.boolean(),
    canSeeUnassigned: z.boolean(),
    canSeeReassignment: z.boolean().optional(),
    canAssign: z.boolean(),
    timezone,
    todayLocalDate: z.iso.date(),
    now: timestamp,
  })
  .refine(
    (page) =>
      page.hasMore === (page.nextCursor !== null) &&
      page.unassignedHasMore === (page.unassignedNextCursor !== null),
  ) satisfies z.ZodType<UnifiedTodayTasksResponseData>;

export function taskQueueContextFor(taskId: string, unassigned: boolean) {
  return taskQueueReadSchema.refine((page) =>
    (unassigned ? page.unassignedItems : page.items).some((row) => row.taskId === taskId),
  );
}
