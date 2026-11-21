import { z } from 'zod';
import { utcDate } from './sales';

const id = z.string().min(1).max(128);
const version = z.number().int().positive().safe();
const successor = z.strictObject({
  caseId: id,
  caseVersion: version,
  taskId: id,
  taskVersion: version,
});
export const salesReopenContextSchema = z.strictObject({
  caseId: id,
  caseVersion: version,
  resultRevisionId: id,
  taskId: id,
  taskVersion: version,
  successor: successor.extend({ dueAt: utcDate }).nullable(),
});
export const salesReopenSchema = z.strictObject({
  expectedCaseVersion: version,
  expectedResultRevisionId: id,
  expectedTaskId: id,
  expectedTaskVersion: version,
  expectedSuccessor: successor.nullable(),
  replacementDueAt: utcDate,
  reasonCode: z.enum(['WRONG_OUTCOME', 'OTHER']),
  notes: z.string().trim().min(3).max(500),
});
export const salesReopenResultSchema = z.strictObject({
  operationId: z.uuid(),
  caseId: id,
  caseVersion: version,
  resultRevisionId: id,
  previousTaskId: id,
  previousTaskVersion: version,
  taskId: id,
  taskVersion: z.literal(1),
  dueAt: utcDate,
  reopenedAt: utcDate,
  successor: successor.nullable(),
});
export const salesReopenReceiptSchema = z.strictObject({
  command: salesReopenSchema,
  result: salesReopenResultSchema,
});
export type SalesReopenCommand = z.infer<typeof salesReopenSchema>;
export type SalesReopenResult = z.infer<typeof salesReopenResultSchema>;
export type SalesReopenContext = z.infer<typeof salesReopenContextSchema>;
