import { z } from 'zod';
import { validBirthDate } from './customer-profile';
import { utcDate } from './sales';
const id = z.string().min(1).max(128),
  version = z.number().int().positive().safe();
const supportedCurrencies = new Set(Intl.supportedValuesOf('currency'));
export const salesPriceCurrencySchema = z
  .string()
  .regex(/^[A-Z]{3}$/)
  .refine((value) => supportedCurrencies.has(value));
const periodSchema = z
  .strictObject({
    startDate: z.string().refine(validBirthDate),
    endDate: z.string().refine(validBirthDate),
  })
  .refine((value) => value.startDate <= value.endDate);
const fields = {
  amountMinor: z.number().int().nonnegative().safe(),
  currency: salesPriceCurrencySchema,
  termsNote: z.string().trim().min(1).max(1000).nullable(),
  offeredPeriod: periodSchema.nullable(),
};
export const salesPriceCreateSchema = z.strictObject({
  expectedCaseVersion: version,
  insurerId: id,
  ...fields,
});
export const salesPriceReviseSchema = z.strictObject({
  expectedCaseVersion: version,
  expectedPriceVersion: version,
  ...fields,
});
export const salesPriceResultSchema = z.strictObject({
  operationId: z.string().uuid(),
  caseId: id,
  caseVersion: version,
  priceId: id,
  priceVersion: version,
  revisionId: id,
  revisionNumber: version,
});
export const salesPriceReceiptSchema = z.strictObject({
  result: salesPriceResultSchema,
  command: z.union([salesPriceCreateSchema, salesPriceReviseSchema]),
  targetId: id,
  priceId: id.nullable(),
});
const common = {
  insurerId: id,
  insurerName: z.string().min(1),
  amountMinor: fields.amountMinor,
  currency: fields.currency,
  createdAt: utcDate,
};
export const salesPriceRevisionSchema = z.strictObject({
  source: z.literal('PRICE_REVISION'),
  ...common,
  priceId: id,
  priceVersion: version,
  revisionId: id,
  revisionNumber: version,
  termsNote: fields.termsNote,
  offeredPeriod: fields.offeredPeriod,
  eventState: z
    .enum(['NOT_SHARED', 'SHARED', 'CUSTOMER_ACCEPTED', 'ACCEPTANCE_REVOKED'])
    .optional(),
});
export const salesLegacyQuoteSchema = z.strictObject({
  source: z.literal('QUOTE_VERSION'),
  ...common,
  quoteId: id,
  quoteVersionId: id,
  quoteVersionNumber: version,
  quoteStatus: z.enum(['DRAFT', 'READY', 'SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED']),
  validUntil: utcDate,
  startDate: z.string().refine(validBirthDate),
  endDate: z.string().refine(validBirthDate),
  termsNote: z.string().nullable(),
});
export const salesPriceRowSchema = z.discriminatedUnion('source', [
  salesPriceRevisionSchema,
  salesLegacyQuoteSchema,
]);
export const salesPricePageSchema = z.strictObject({
  canManage: z.boolean(),
  items: z.array(salesPriceRowSchema).max(50),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});
export const salesPriceHistorySchema = z.strictObject({
  revisions: z.array(salesPriceRevisionSchema).max(50),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});
export type SalesPriceRow = z.infer<typeof salesPriceRowSchema>;
export type SalesPriceRevision = z.infer<typeof salesPriceRevisionSchema>;
export type SalesPriceCommandResult = z.infer<typeof salesPriceResultSchema>;
