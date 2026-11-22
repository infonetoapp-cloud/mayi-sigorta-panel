import { z } from 'zod';
import { utcDate } from './sales';

const id = z.string().trim().min(1).max(128);
const version = z.number().int().positive().safe();

const versionedTarget = {
  expectedCaseVersion: version,
  expectedIssueReceiptId: id,
  expectedTaskId: id,
  expectedTaskVersion: version,
  expectedPolicyId: id,
  expectedPolicyVersion: version,
};
export const salesWonCorrectionContextSchema = z.strictObject({
  ...versionedTarget,
  policyNumber: z.string().min(1),
});
export const salesWonCorrectionSchema = z.strictObject({
  ...versionedTarget,
  replacementDueAt: utcDate,
  notes: z.string().trim().min(3).max(500),
});
const grant = {
  grantId: z.uuid(),
  grantEvidenceToken: z.string().regex(/^[a-f0-9]{64}$/),
};
export const salesWonCorrectionGrantSchema = z.strictObject({ ...grant, expiresAt: utcDate });
export const salesWonCorrectionMutationSchema = z.strictObject({
  command: salesWonCorrectionSchema,
  ...grant,
});
export const salesWonCorrectionResultSchema = z.strictObject({
  operationId: z.uuid(),
  caseId: id,
  caseVersion: version,
  taskId: id,
  taskVersion: z.literal(1),
  dueAt: utcDate,
  correctedAt: utcDate,
});
export const salesWonCorrectionReceiptSchema = z.strictObject({
  command: salesWonCorrectionSchema,
  grantId: z.uuid(),
  result: salesWonCorrectionResultSchema,
});
export type SalesWonCorrection = z.infer<typeof salesWonCorrectionSchema>;
export type SalesWonCorrectionResult = z.infer<typeof salesWonCorrectionResultSchema>;
