import { z } from 'zod';
import { renewalStateLabels } from '../../../shared/renewal-browsing';
import type { RenewalStateCode } from '../../../shared/types';

const text = z.string().min(1);
const version = z.number().int().positive();
const nullableText = z.string().nullable();
const item = z.object({
  id: text,
  state: z.enum(Object.keys(renewalStateLabels) as RenewalStateCode[]),
  version,
  closedAt: nullableText,
  customer: z.object({ id: text, displayName: text }),
  policy: z.object({
    id: text,
    number: text,
    startDate: z.string(),
    endDate: z.string(),
    insurerName: text,
    branchName: text,
    grossPremiumMinor: z.number().int(),
    currency: text,
    status: z.enum(['ACTIVE', 'CANCELLED', 'VOIDED']),
  }),
  isOpen: z.boolean(),
  parentArchived: z.boolean(),
});

export const renewalBrowsePageSchema = z.object({
  items: z.array(item),
  nextCursor: text.nullable(),
});

const detail = item.extend({
  phone: nullableText,
  email: nullableText,
  referenceName: nullableText,
  insurerCustomerNumber: nullableText,
  vehicle: z
    .object({
      vehicleId: text,
      vehicleVersion: version,
      details: z.object({
        plate: nullableText,
        brand: nullableText,
        model: nullableText,
        modelYear: z.number().int().nullable(),
        vin: nullableText,
        engineNumber: nullableText,
        registrationSerial: nullableText,
      }),
    })
    .nullable(),
});

export function renewalDetailFor(id: string) {
  return detail.refine(
    (record) =>
      record.id === id &&
      (!record.isOpen ||
        (!record.parentArchived &&
          record.policy.status === 'ACTIVE' &&
          !['WON', 'LOST', 'VOIDED'].includes(record.state))),
  );
}
