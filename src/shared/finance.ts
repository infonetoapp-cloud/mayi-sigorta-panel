import { z } from 'zod';
const id = z.string().trim().min(1).max(128);
const version = z.number().int().min(1).max(1_000_000_000);
const date = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine(
    (v) =>
      v.slice(0, 4) !== '0000' &&
      Number.isFinite(Date.parse(v + 'T00:00:00Z')) &&
      new Date(v + 'T00:00:00Z').toISOString().slice(0, 10) === v,
  );
const amount = z
  .string()
  .regex(/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/)
  .max(17);
export const financeReasons = {
  DATA_ERROR: 'Bilgi / tutar hatası',
  DUE_DATE_CHANGED: 'Ödeme tarihi değişti',
  DUPLICATE: 'Mükerrer kayıt',
  CUSTOMER_AGREED: 'Müşteriyle mutabakat',
  OTHER: 'Diğer düzeltme',
} as const;
const reason = z.enum(['DATA_ERROR', 'DUE_DATE_CHANGED', 'DUPLICATE', 'CUSTOMER_AGREED', 'OTHER']);
export const financeMethodLabels = {
  DEFERRED: 'Açık vade',
  CASH: 'Nakit',
  BANK: 'Havale / EFT',
  CARD: 'Kart — acentenin aldığı ödeme',
} as const;
const method = z.enum(['DEFERRED', 'CASH', 'BANK', 'CARD']);
export const financeCommandSchema = z.discriminatedUnion('kind', [
  z
    .object({
      kind: z.literal('CREATE'),
      policyId: id,
      expectedPolicyVersion: version,
      amount,
      dueDate: date,
      method,
    })
    .strict(),
  z
    .object({
      kind: z.literal('COLLECT'),
      receivableId: id,
      expectedVersion: version,
      amount,
      receivedDate: date,
      method: z.enum(['CASH', 'BANK', 'CARD']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('REVERSE'),
      receivableId: id,
      expectedVersion: version,
      entryId: id,
      reasonCode: reason,
    })
    .strict(),
  z
    .object({
      kind: z.literal('ADJUST'),
      receivableId: id,
      expectedVersion: version,
      amount,
      dueDate: date,
      reasonCode: reason,
    })
    .strict(),
  z
    .object({
      kind: z.literal('VOID'),
      receivableId: id,
      expectedVersion: version,
      reasonCode: reason,
    })
    .strict(),
]);
export type FinanceCommand = z.infer<typeof financeCommandSchema>;
export const financeQuerySchema = z
  .object({
    view: z.enum(['OPEN', 'COLLECTED', 'ALL']).default('OPEN'),
    q: z.string().trim().max(80).default(''),
    due: z.enum(['ALL', 'OVERDUE', 'TODAY']).default('ALL'),
    branchId: id.optional(),
    policyId: id.optional(),
    cursor: z.string().max(1600).optional(),
    limit: z.coerce.number().int().min(1).max(50).default(20),
  })
  .strict();
export interface FinanceReceivable {
  id: string;
  policyId: string;
  customerId: string;
  customerName: string;
  policyNumber: string;
  branchName: string;
  amountMinor: number;
  collectedMinor: number;
  remainingMinor: number;
  currency: string;
  dueDate: string;
  method: keyof typeof financeMethodLabels;
  status: 'ACTIVE' | 'VOIDED';
  version: number;
  createdAt: string;
  state: 'OPEN' | 'PARTIAL' | 'COLLECTED' | 'OVERDUE' | 'VOIDED';
}
export interface FinanceEntry {
  id: string;
  kind: 'PAYMENT' | 'REVERSAL';
  amountMinor: number;
  receivedDate: string;
  method: 'CASH' | 'BANK' | 'CARD';
  reversesId: string | null;
  reasonCode: keyof typeof financeReasons | null;
  createdAt: string;
  reversed?: boolean;
}
export interface FinanceRevision {
  version: number;
  amountMinor: number;
  dueDate: string;
  status: 'ACTIVE' | 'VOIDED';
  reasonCode: keyof typeof financeReasons | null;
  createdAt: string;
}
export interface FinanceDetail {
  receivable: FinanceReceivable;
  entries: FinanceEntry[];
  revisions: FinanceRevision[];
  canManage: boolean;
  today: string;
  entriesNextCursor?: string | null;
  revisionsNextCursor?: number | null;
  verifiedEntry?: FinanceEntry | null;
  verifiedRevision?: FinanceRevision | null;
}
export interface FinancePage {
  items: FinanceReceivable[];
  nextCursor: string | null;
  totals: {
    currency: string;
    amountMinor: number;
    collectedMinor: number;
    remainingMinor: number;
  }[];
  canManage: boolean;
  today: string;
}
export interface FinanceResult {
  receivableId: string;
  version: number;
  entryId: string | null;
}
