import { z } from 'zod';
import { validBirthDate } from './customer-profile';
export const cancellationReasons = {
  VEHICLE_SOLD: 'Araç / sigortalı varlık satıldı',
  PAYMENT_DIFFICULTY: 'Ödeme yapılamadı',
  CUSTOMER_REQUEST: 'Müşteri talebi',
  OTHER: 'Diğer',
} as const;
export const policyLifecycleRequestSchema = z
  .object({
    expectedPolicyVersion: z.number().int().positive(),
    cancellationDate: z.string().refine(validBirthDate, 'Geçerli tarih girin.'),
    reasonCode: z.enum([
      'VEHICLE_SOLD',
      'PAYMENT_DIFFICULTY',
      'CUSTOMER_REQUEST',
      'OTHER',
      'DUPLICATE',
      'TECHNICAL_ERROR',
    ]),
    reasonNotes: z.string().trim().min(1).max(500).nullable(),
    lossReasonId: z.string().min(1).max(128).optional(),
    expectedRenewal: z
      .object({
        id: z.string().min(1).max(128),
        version: z.number().int().positive(),
        primaryTaskId: z.string().min(1).max(128),
        taskVersion: z.number().int().positive(),
      })
      .strict()
      .optional(),
    targetSetFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
export interface PolicyLifecycleContext {
  policyId: string;
  policyVersion: number;
  status: 'ACTIVE' | 'CANCELLED' | 'VOIDED';
  startDate: string;
  endDate: string;
  eligible: boolean;
  targetSetFingerprint: string;
  expectedRenewal?: { id: string; version: number; primaryTaskId: string; taskVersion: number };
  lossReasons: { id: string; code: string; name: string }[];
}
export const policyLifecycleResultSchema = z
  .strictObject({
    operationId: z.string().uuid(),
    eventId: z.string().uuid(),
    policyId: z.string().min(1),
    policyVersion: z.number().int().safe().min(2),
    status: z.enum(['CANCELLED', 'VOIDED']),
    closedRenewalId: z.string().min(1).nullable(),
    completedTaskId: z.string().min(1).nullable(),
  })
  .refine((v) => (v.closedRenewalId === null) === (v.completedTaskId === null));
export const policyLifecycleReceiptSchema = z.strictObject({
  result: policyLifecycleResultSchema,
  command: policyLifecycleRequestSchema,
});
export type PolicyLifecycleResult = z.infer<typeof policyLifecycleResultSchema>;
