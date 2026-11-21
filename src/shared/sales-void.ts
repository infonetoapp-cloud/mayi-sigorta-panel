import { z } from 'zod';

const id = z.string().min(1).max(128);
const version = z.number().int().positive().safe();
export const salesVoidReasons = {
  DUPLICATE: 'Mükerrer çalışma',
  WRONG_RECORD: 'Yanlış açılan çalışma',
  TECHNICAL_ERROR: 'Kayıt hatası',
} as const;
export const salesVoidCommandSchema = z.strictObject({
  expectedCaseVersion: version,
  expectedTaskId: id,
  expectedTaskVersion: version,
  reasonCode: z.enum(['DUPLICATE', 'WRONG_RECORD', 'TECHNICAL_ERROR']),
  notes: z.string().trim().min(3).max(500),
});
export const salesVoidResultSchema = z.strictObject({
  operationId: z.uuid(),
  caseId: id,
  caseVersion: version,
  taskId: id,
  taskVersion: version,
  closedAt: z.iso.datetime(),
});
export const salesVoidReceiptSchema = z.strictObject({
  command: salesVoidCommandSchema,
  result: salesVoidResultSchema,
});
export const salesVoidContextSchema = salesVoidResultSchema.pick({
  caseId: true,
  caseVersion: true,
  taskId: true,
  taskVersion: true,
});
export type SalesVoidResult = z.infer<typeof salesVoidResultSchema>;
export type SalesVoidContext = z.infer<typeof salesVoidContextSchema>;
