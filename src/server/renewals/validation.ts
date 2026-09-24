import { z } from 'zod';

const version = z.number().int().min(1).max(1_000_000_000);
const membershipOrEntityId = z.string().trim().min(1).max(128);
const note = z.string().trim().min(1).max(500).nullable();

export const closeRenewalLostSchema = z
  .object({
    expectedRenewalVersion: version,
    expectedTaskVersion: version,
    lossReasonId: membershipOrEntityId,
    lossReasonNotes: note,
  })
  .strict();

export type CloseRenewalLostInput = z.infer<typeof closeRenewalLostSchema>;

export const voidRenewalSchema = z
  .object({
    expectedRenewalVersion: version,
    expectedTaskVersion: version,
    voidReasonCode: z.enum([
      'TECHNICAL_ERROR',
      'DUPLICATE',
      'NOT_ELIGIBLE_AFTER_CANCELLATION_OR_RESTRUCTURE',
    ]),
  })
  .strict();

export type VoidRenewalInput = z.infer<typeof voidRenewalSchema>;

export const reopenRenewalSchema = z
  .object({
    expectedRenewalVersion: version,
    expectedTaskVersion: version,
    replacementDueAt: z.string().datetime({ offset: true }),
    reopenReasonCode: z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/),
  })
  .strict();

export type ReopenRenewalInput = z.infer<typeof reopenRenewalSchema>;
