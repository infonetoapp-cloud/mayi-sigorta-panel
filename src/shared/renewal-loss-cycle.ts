import { z } from 'zod';
import { salesNextCycleSchema } from './sales-loss';
export const renewalLossCycleSchema = z
  .strictObject({
    caseId: z.string().trim().min(1).max(128),
    expectedCaseVersion: z.number().int().positive().safe(),
    notes: z.string().trim().min(1).max(500).nullable(),
    nextCycle: salesNextCycleSchema,
  })
  .refine((v) => v.nextCycle.mode !== 'NO_FOLLOW_UP' || v.notes !== null);
export type RenewalLossCycleInput = z.infer<typeof renewalLossCycleSchema>;
