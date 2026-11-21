import { z } from 'zod';
import { validBirthDate } from './customer-profile';
import type { RenewalStateCode } from './types';
const id = z.string().min(1).max(128),
  version = z.number().int().positive().safe();
export const utcDate = z
  .string()
  .refine((v) => Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v);
export const salesCreateSchema = z
  .strictObject({
    context: z.literal('NEW_BUSINESS'),
    branchId: id,
    cycleDate: z.string().refine(validBirthDate).nullable(),
    dateBasis: z.enum(['KNOWN_END_DATE', 'MANUAL']),
    followup: z.strictObject({ dueAt: utcDate }),
    confirmSimilar: z.boolean().default(false),
  })
  .refine((v) => v.dateBasis !== 'KNOWN_END_DATE' || !!v.cycleDate);
export const salesFollowupSchema = z.strictObject({
  expectedCaseVersion: version,
  expectedTaskId: id,
  expectedTaskVersion: version,
  dueAt: utcDate,
  reasonCode: z.enum([
    'CALL_AGAIN',
    'CUSTOMER_RESPONSE_PENDING',
    'DOCUMENTS_PENDING',
    'PRICE_REVISION_PENDING',
  ]),
  notes: z.string().trim().min(1).max(500).nullable(),
});
export const salesAdoptSchema = z.strictObject({
  context: z.literal('RENEWAL'),
  renewalId: id,
  expectedVersion: version,
  expectedPrimaryTaskId: id,
  expectedPrimaryTaskVersion: version,
});
export const salesResultSchema = z.strictObject({
  operationId: z.string().uuid(),
  caseId: id,
  caseVersion: version,
  taskId: id,
  taskVersion: version,
  dueAt: utcDate,
});
export type SalesCommandResult = z.infer<typeof salesResultSchema>;
export const salesReceiptSchema = z.strictObject({
  result: salesResultSchema,
  command: z.union([salesCreateSchema, salesFollowupSchema, salesAdoptSchema]),
  targetId: id,
});
export interface SalesCaseDto {
  id: string;
  customerId: string;
  customerName: string;
  branchId: string;
  branchName: string;
  dataClassification: 'GENERAL' | 'HEALTH';
  context: 'NEW_BUSINESS' | 'RENEWAL';
  result: 'OPEN' | RenewalStateCode | null;
  renewalId?: string | null;
  sourcePolicyId?: string | null;
  cycleDate: string | null;
  dateBasis: 'KNOWN_END_DATE' | 'MANUAL';
  version: number;
  createdAt: string;
  predecessorCaseId?: string | null;
}
export interface SalesTaskDto {
  kind: 'GENERAL';
  taskId: string;
  caseId: string | null;
  customerId: string;
  customerDisplayName: string;
  branchName: string | null;
  title: string;
  dueAt: string;
  taskVersion: number;
  assigneeMembershipId: string | null;
  bucket: 'OVERDUE' | 'TODAY' | 'UPCOMING';
  isUnassigned: boolean;
  needsReassignment?: boolean;
  renewalId?: never;
  renewalState?: never;
  renewalVersion?: never;
  renewalAssigneeMembershipId?: never;
  policyId?: never;
  policyNumber?: never;
  policyEndDate?: never;
  policyBranchName?: never;
  policyInsurerName?: never;
  policyInsurerCustomerNumber?: never;
  customerEmail?: never;
  customerPhone?: never;
}
