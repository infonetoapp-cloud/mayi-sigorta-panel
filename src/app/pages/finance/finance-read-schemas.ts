import { z } from 'zod';
import {
  financeMethodLabels,
  financeReasons,
  type FinanceDetail,
  type FinancePage,
} from '../../../shared/finance';

const id = z.string().min(1);
const minor = z.number().int().nonnegative();
const date = z.iso.date();
const version = z.number().int().positive();
const status = z.enum(['ACTIVE', 'VOIDED']);
const reason = z.enum(Object.keys(financeReasons) as (keyof typeof financeReasons)[]).nullable();
const amounts = {
  currency: z.string().regex(/^[A-Z]{3}$/),
  amountMinor: minor,
  collectedMinor: minor,
  remainingMinor: minor,
};

const receivable = z
  .object({
    ...amounts,
    id,
    policyId: id,
    customerId: id,
    customerName: id,
    policyNumber: id,
    branchName: id,
    dueDate: date,
    method: z.enum(Object.keys(financeMethodLabels) as (keyof typeof financeMethodLabels)[]),
    status,
    version,
    createdAt: id,
    state: z.enum(['OPEN', 'PARTIAL', 'COLLECTED', 'OVERDUE', 'VOIDED']),
  })
  .refine(
    (row) =>
      row.collectedMinor <= row.amountMinor &&
      (row.status === 'VOIDED'
        ? row.state === 'VOIDED' && row.remainingMinor === 0
        : row.state !== 'VOIDED' && row.remainingMinor === row.amountMinor - row.collectedMinor),
  );

const entry = z.object({
  id,
  kind: z.enum(['PAYMENT', 'REVERSAL']),
  amountMinor: minor,
  receivedDate: date,
  method: z.enum(['CASH', 'BANK', 'CARD']),
  reversesId: id.nullable(),
  reasonCode: reason,
  createdAt: id,
  reversed: z.boolean().optional(),
});

const revision = z.object({
  version,
  amountMinor: minor,
  dueDate: date,
  status,
  reasonCode: reason,
  createdAt: id,
});

const summary = {
  canManage: z.boolean(),
  today: date,
};

export const financePageSchema = z.object({
  ...summary,
  items: z.array(receivable),
  nextCursor: id.nullable(),
  totals: z.array(
    z
      .object(amounts)
      .refine((total) => total.remainingMinor === total.amountMinor - total.collectedMinor),
  ),
}) satisfies z.ZodType<FinancePage>;

const detail = z.object({
  ...summary,
  receivable,
  entries: z.array(entry),
  revisions: z.array(revision),
  entriesNextCursor: id.nullish(),
  revisionsNextCursor: version.nullish(),
  verifiedEntry: entry.nullish(),
  verifiedRevision: revision.nullish(),
}) satisfies z.ZodType<FinanceDetail>;

export function financeDetailFor(receivableId: string) {
  return detail.refine((value) => value.receivable.id === receivableId);
}
