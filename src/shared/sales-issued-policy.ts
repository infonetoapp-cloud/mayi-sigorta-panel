import { z } from 'zod';

const id = z.string().trim().min(1).max(128);
const version = z.number().int().safe().positive();
export const issuePolicySchema = z.strictObject({
  expectedCaseVersion: version,
  expectedTaskId: id,
  expectedTaskVersion: version,
  source: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('PRICE_REVISION'), revisionId: id, acceptanceEventId: id }),
    z.strictObject({ kind: z.literal('NO_QUOTE'), reason: z.string().trim().min(1).max(500) }),
  ]),
  result: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('CREATE_POLICY'), policy: z.record(z.string(), z.unknown()) }),
    z.strictObject({
      kind: z.literal('LINK_POLICY'),
      policyId: id,
      expectedPolicyVersion: version,
    }),
  ]),
  differenceReasonCode: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{2,63}$/)
    .optional(),
});
export const issuePolicyResultSchema = z.strictObject({
  operationId: z.uuid(),
  caseId: id,
  caseVersion: version,
  taskId: id,
  taskVersion: version,
  policyId: id,
  policyVersion: version,
  createdPolicy: z.boolean(),
  closedAt: z.iso.datetime(),
});
export const issuePolicyContextSchema = z.strictObject({
  caseId: id,
  caseVersion: version,
  taskId: id,
  taskVersion: version,
  customerId: id,
  customerName: z.string().min(1),
  branchId: id,
  branchName: z.string().min(1),
  canCreate: z.boolean(),
});
export type IssuePolicyContext = z.infer<typeof issuePolicyContextSchema>;
export type IssuePolicyCommand = z.infer<typeof issuePolicySchema>;
export type IssuePolicyResult = z.infer<typeof issuePolicyResultSchema>;
