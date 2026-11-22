import { z } from 'zod';
import { utcDate } from './sales';
import { validBirthDate } from './customer-profile';
const id = z.string().min(1).max(128),
  version = z.number().int().positive().safe();
export const salesNextCycleSchema = z.discriminatedUnion('mode', [
  z
    .strictObject({
      mode: z.literal('FOLLOW_UP'),
      cycleDate: z.string().refine(validBirthDate).nullable(),
      dateBasis: z.enum(['KNOWN_END_DATE', 'MANUAL']),
      dueAt: utcDate,
    })
    .refine((v) => v.dateBasis !== 'KNOWN_END_DATE' || v.cycleDate !== null),
  z.strictObject({
    mode: z.literal('NO_FOLLOW_UP'),
    exceptionCode: z.enum(['NO_FURTHER_CONTACT', 'DUPLICATE', 'TECHNICAL_ERROR']),
  }),
]);
export const salesLossCommandSchema = z
  .strictObject({
    expectedCaseVersion: version,
    expectedTaskId: id,
    expectedTaskVersion: version,
    lossReasonId: id,
    notes: z.string().trim().min(1).max(500).nullable(),
    nextCycle: salesNextCycleSchema,
  })
  .refine((v) => v.nextCycle.mode !== 'NO_FOLLOW_UP' || v.notes !== null);
export const salesLossResultSchema = z.strictObject({
  operationId: z.string().uuid(),
  caseId: id,
  caseVersion: version,
  resultRevisionId: id,
  taskId: id,
  taskVersion: version,
  closedAt: utcDate,
  followup: z
    .strictObject({
      caseId: id,
      caseVersion: z.literal(1),
      taskId: id,
      taskVersion: z.literal(1),
      dueAt: utcDate,
      cycleDate: z.string().refine(validBirthDate).nullable(),
      dateBasis: z.enum(['KNOWN_END_DATE', 'MANUAL']),
    })
    .nullable(),
});
export const salesLossReceiptSchema = z.strictObject({
  result: salesLossResultSchema,
  command: salesLossCommandSchema,
  targetId: id,
});
export const salesLossContextSchema = z.strictObject({
  caseId: id,
  caseVersion: version,
  taskId: id,
  taskVersion: version,
  cycleDate: z.string().nullable(),
  renewalWindowDays: z.number().int().min(1).max(120),
  canCreateFollowup: z.boolean(),
  lossReasons: z
    .array(z.strictObject({ id, name: z.string().min(1), code: z.string().min(1) }))
    .max(1000),
});
export type SalesLossResult = z.infer<typeof salesLossResultSchema>;
