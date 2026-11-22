import { z } from 'zod';
import { utcDate } from './sales';
const id = z.string().min(1).max(128);
const version = z.number().int().positive().safe();
const common = {
  expectedTaskVersion: version,
  notes: z.string().trim().min(1).max(500).nullable(),
};
export const generalRescheduleSchema = z.strictObject({
  ...common,
  dueAt: utcDate,
  reasonCode: z.enum([
    'CALL_AGAIN',
    'CUSTOMER_RESPONSE_PENDING',
    'DOCUMENTS_PENDING',
    'PRICE_REVISION_PENDING',
  ]),
});
export const generalCompleteSchema = z.strictObject({
  ...common,
  reasonCode: z.enum(['COMPLETED', 'DUPLICATE', 'NO_FURTHER_CONTACT']),
});
export const generalAssignSchema = z.strictObject({
  ...common,
  reasonCode: z.literal('REASSIGN'),
  assigneeMembershipId: id,
});
export const generalTaskCommandResultSchema = z.strictObject({
  operationId: z.string().uuid(),
  taskId: id,
  taskVersion: version,
  status: z.enum(['OPEN', 'COMPLETED']),
  dueAt: utcDate,
  assigneeMembershipId: id.nullable(),
});
export const generalTaskReceiptSchema = z.strictObject({
  result: generalTaskCommandResultSchema,
  command: z.union([generalRescheduleSchema, generalCompleteSchema, generalAssignSchema]),
  targetId: id,
});
export const generalTaskContextSchema = z.strictObject({
  kind: z.literal('GENERAL'),
  taskId: id,
  taskVersion: version,
  title: z.string().min(1),
  customerId: id,
  customerName: z.string().min(1),
  policyId: id.nullable(),
  caseId: id.nullable(),
  dueAt: utcDate,
  assigneeMembershipId: id.nullable(),
  status: z.enum(['OPEN', 'COMPLETED']),
  canReschedule: z.boolean(),
  canComplete: z.boolean(),
  canAssign: z.boolean(),
});
export const generalAssignmentOptionsSchema = z.strictObject({
  memberships: z
    .array(z.strictObject({ membershipId: id, displayName: z.string().min(1) }))
    .max(50),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});
export type GeneralTaskContext = z.infer<typeof generalTaskContextSchema>;
export type GeneralTaskCommandResult = z.infer<typeof generalTaskCommandResultSchema>;
