import { z } from 'zod';
import {
  claimDate,
  claimFieldsSchema,
  claimId,
  type ClaimDetail,
  type ClaimPage,
} from '../../../shared/claims';

export interface ClaimScope {
  customerId?: string;
  policyId?: string;
}

const name = z.string().min(1);
const version = z.number().int().positive();
const timestamp = z.string().refine((value) => Number.isFinite(Date.parse(value)));
const claim = claimFieldsSchema
  .extend({
    id: claimId,
    policyId: claimId,
    customerId: claimId,
    insurerId: claimId,
    branchId: claimId,
    customerName: name,
    policyNumber: name,
    insurerName: name,
    branchName: name,
    referenceName: z.string().nullable(),
    version,
    createdAt: timestamp,
    updatedAt: timestamp,
    parentArchived: z.boolean(),
  })
  .strip();
const history = z.object({ version, fields: claimFieldsSchema, createdAt: timestamp });
const summary = { canManage: z.boolean(), today: claimDate };
const page = z.object({
  ...summary,
  items: z.array(claim),
  nextCursor: name.nullable(),
}) satisfies z.ZodType<ClaimPage>;
const detail = z.object({
  ...summary,
  claim,
  history: z.array(history),
  nextHistoryVersion: version.nullable(),
  verifiedHistory: history.nullable(),
  policyStartDate: claimDate,
  policyEndDate: claimDate,
}) satisfies z.ZodType<ClaimDetail>;

function matchesScope(row: Required<ClaimScope>, scope: ClaimScope) {
  return (
    (!scope.customerId || row.customerId === scope.customerId) &&
    (!scope.policyId || row.policyId === scope.policyId)
  );
}

export function claimPageFor(scope: ClaimScope) {
  return page.refine((data) => data.items.every((row) => matchesScope(row, scope)));
}

export function claimDetailFor(id: string, scope: ClaimScope) {
  return detail.refine((data) => data.claim.id === id && matchesScope(data.claim, scope));
}
