import { z } from 'zod';

const membershipIdSchema = z.string().trim().min(1).max(128);
const versionSchema = z.number().int().min(1).max(1_000_000_000);
const canonicalUtcDateTimeSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
  .refine((value) => {
    const parsed = new Date(value);
    return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
  });

export const todayTasksQuerySchema = z
  .object({
    limit: z
      .string()
      .regex(/^[1-9]\d{0,2}$/)
      .optional()
      .transform((value) => (value === undefined ? 25 : Number(value)))
      .pipe(z.number().int().min(1).max(50)),
    cursor: z.string().trim().min(1).max(1024).optional(),
    unassignedCursor: z.string().trim().min(1).max(1024).optional(),
    needsReassignment: z.literal('true').optional(),
    unified: z.literal('true').optional(),
    q: z.string().trim().min(1).max(80).optional(),
  })
  .strict();

export const renewalTaskAssignSchema = z
  .object({
    expectedRenewalVersion: versionSchema,
    expectedTaskVersion: versionSchema,
    assigneeMembershipId: membershipIdSchema.nullable(),
  })
  .strict();

export const renewalTaskCompleteSchema = z
  .object({
    expectedRenewalVersion: versionSchema,
    expectedTaskVersion: versionSchema,
    replacementDueAt: canonicalUtcDateTimeSchema,
    followupReason: z
      .enum([
        'DOCUMENTS_PENDING',
        'CUSTOMER_RESPONSE_PENDING',
        'PRICE_REVISION_PENDING',
        'CALL_AGAIN',
      ])
      .optional(),
  })
  .strict();

export type TodayTasksQuery = z.infer<typeof todayTasksQuerySchema>;
export type RenewalTaskAssignInput = z.infer<typeof renewalTaskAssignSchema>;
export type RenewalTaskCompleteInput = z.infer<typeof renewalTaskCompleteSchema>;
