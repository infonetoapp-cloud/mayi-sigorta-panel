import { z } from 'zod';
import { utcDate } from './sales';
const id = z.string().min(1).max(128),
  version = z.number().int().positive().safe();
export const salesPriceEventCodeSchema = z.enum([
  'SHARED',
  'CUSTOMER_ACCEPTED',
  'ACCEPTANCE_REVOKED',
]);
export const salesPriceEventCommandSchema = z.strictObject({
  expectedCaseVersion: version,
  revisionId: id,
  event: salesPriceEventCodeSchema,
  occurredAt: utcDate,
  expectedTaskId: id,
  expectedTaskVersion: version,
});
export const salesPriceEventResultSchema = z.strictObject({
  operationId: z.string().uuid(),
  caseId: id,
  caseVersion: version,
  eventId: id,
  revisionId: id,
  event: salesPriceEventCodeSchema,
  occurredAt: utcDate,
});
export const salesPriceEventReceiptSchema = z.strictObject({
  result: salesPriceEventResultSchema,
  command: salesPriceEventCommandSchema,
  targetId: id,
});
export const salesPriceEventSchema = z.strictObject({
  eventId: id,
  revisionId: id,
  event: salesPriceEventCodeSchema,
  occurredAt: utcDate,
  createdAt: utcDate,
  caseVersion: version,
});
export const salesPriceEventPageSchema = z.strictObject({
  events: z.array(salesPriceEventSchema).max(50),
  hasMore: z.boolean(),
  nextCursor: z.string().nullable(),
});
export const salesPriceEventContextSchema = z.strictObject({
  taskId: id,
  taskVersion: version,
  caseVersion: version,
  revisionId: id,
  allowedEvents: z.array(salesPriceEventCodeSchema).max(3),
});
export type SalesPriceEventCode = z.infer<typeof salesPriceEventCodeSchema>;
export type SalesPriceEventResult = z.infer<typeof salesPriceEventResultSchema>;
export const salesPriceEventLabels: Record<SalesPriceEventCode, string> = {
  SHARED: 'Müşteriye iletildi',
  CUSTOMER_ACCEPTED: 'Müşteri kabul etti',
  ACCEPTANCE_REVOKED: 'Onay geri alındı',
};
