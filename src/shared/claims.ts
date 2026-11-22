import { z } from 'zod';
export const claimId = z.string().regex(/^[A-Za-z0-9_.:-]{1,128}$/);
export const claimDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      v.slice(0, 4) !== '0000' &&
      Number.isFinite(Date.parse(v + 'T00:00:00Z')) &&
      new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v,
  );
const text = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .refine((v) => ![...v].some((c) => c.charCodeAt(0) < 32 && c !== '\n' && c !== '\t'))
    .transform((v) => v || null)
    .nullable();
export const claimStatuses = {
  WAITING: 'Beklemede',
  IN_PROGRESS: 'Süreçte',
  COMPLETED: 'Sonuçlandı',
} as const;
export const claimFieldsSchema = z
  .object({
    lossDate: claimDate,
    fileNumber: text(80),
    expertName: text(120),
    expertContact: text(160),
    status: z.enum(['WAITING', 'IN_PROGRESS', 'COMPLETED']),
    note: text(1000),
  })
  .strict();
const version = z.number().int().min(1).max(999999999);
export const claimCommandSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('CREATE'),
      policyId: claimId,
      customerId: claimId,
      expectedPolicyVersion: version,
      fields: claimFieldsSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal('UPDATE'),
      claimId,
      expectedVersion: version,
      fields: claimFieldsSchema.refine((f) => f.note !== null, {
        message: 'Durum veya düzeltme notu gerekli',
      }),
    })
    .strict(),
]);
export const normalizeClaimNumber = (v: string | null) =>
  v === null ? null : v.normalize('NFKC').replace(/\s/g, '').toLocaleUpperCase('tr-TR');
export type ClaimFields = z.infer<typeof claimFieldsSchema>;
export type ClaimCommand = z.infer<typeof claimCommandSchema>;
export const claimResultSchema = z
  .object({ claimId, version: z.number().int().positive() })
  .strict();
export type ClaimResult = z.infer<typeof claimResultSchema>;
export interface ClaimRecord extends ClaimFields {
  id: string;
  policyId: string;
  customerId: string;
  insurerId: string;
  branchId: string;
  customerName: string;
  policyNumber: string;
  insurerName: string;
  branchName: string;
  referenceName: string | null;
  version: number;
  createdAt: string;
  updatedAt: string;
  parentArchived: boolean;
}
export interface ClaimHistory {
  version: number;
  fields: ClaimFields;
  createdAt: string;
}
export interface ClaimDetail {
  claim: ClaimRecord;
  history: ClaimHistory[];
  nextHistoryVersion: number | null;
  verifiedHistory: ClaimHistory | null;
  canManage: boolean;
  today: string;
  policyStartDate: string;
  policyEndDate: string;
}
export interface ClaimPage {
  items: ClaimRecord[];
  nextCursor: string | null;
  canManage: boolean;
  today: string;
}
export const claimQuerySchema = z
  .object({
    q: z.string().trim().max(80).default(''),
    status: z.enum(['ALL', 'WAITING', 'IN_PROGRESS', 'COMPLETED']).default('ALL'),
    from: claimDate.optional(),
    to: claimDate.optional(),
    policyId: claimId.optional(),
    customerId: claimId.optional(),
    branchId: claimId.optional(),
    cursor: z.string().max(1800).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict()
  .refine((q) => !q.from || !q.to || q.from <= q.to);
