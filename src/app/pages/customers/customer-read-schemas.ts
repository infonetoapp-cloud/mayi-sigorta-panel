import { z } from 'zod';

const id = z.string().min(1);
const version = z.number().int().positive();
const nullableText = z.string().nullable();
const cursor = id.nullable();
const timestamps = {
  createdAt: z.string().min(1),
  updatedAt: z.string().min(1),
};

const contactSchema = z.object({
  id,
  agencyId: id,
  customerId: id,
  firstName: z.string(),
  lastName: z.string(),
  role: nullableText,
  email: nullableText,
  phone: nullableText,
  isPrimary: z.boolean(),
  status: z.enum(['ACTIVE', 'INACTIVE']),
  version,
  ...timestamps,
});

const customerDetailSchema = z.object({
  id,
  agencyId: id,
  type: z.enum(['INDIVIDUAL', 'COMPANY']),
  displayName: z.string().min(1),
  firstName: nullableText,
  lastName: nullableText,
  companyTitle: nullableText,
  email: nullableText,
  phone: nullableText,
  address: nullableText,
  assigneeMembershipId: id,
  archivedAt: nullableText,
  archivedByMembershipId: nullableText,
  archiveReasonCode: nullableText,
  hasIdentity: z.boolean(),
  identityMasked: nullableText,
  birthDate: nullableText.optional(),
  referenceMembershipId: nullableText.optional(),
  referenceName: nullableText.optional(),
  contacts: z.array(contactSchema).optional(),
  version,
  ...timestamps,
});

export function customerDetailFor(customerId: string) {
  return customerDetailSchema.refine(
    (customer) =>
      customer.id === customerId &&
      customer.contacts?.every(
        (contact) => contact.customerId === customer.id && contact.agencyId === customer.agencyId,
      ) !== false,
  );
}

export const insurerNumbersSchema = z.array(
  z.object({
    insurerId: id,
    insurerName: z.string().min(1),
    customerNumber: z.string().min(1).max(100),
  }),
);

export const insurerNumberOptionsSchema = z.object({
  items: z.array(z.object({ id, name: z.string().min(1) })),
  nextCursor: cursor,
});

const calendarDate = z.iso.date();
const coveragePolicy = z.object({
  policyId: id,
  policyNumber: id,
  branchName: id,
  productName: id,
  insurerName: id,
  startDate: calendarDate,
  endDate: calendarDate,
});
const count = z.number().int().nonnegative();
export const customerCoverageSchema = z
  .object({
    available: z.boolean(),
    asOfDate: calendarDate,
    timezone: id,
    activePolicyCount: count.nullable(),
    expiredPolicyCount: count.nullable(),
    scheduledPolicyCount: count.nullable(),
    cancelledPolicyCount: count.nullable(),
    voidedPolicyCount: count.nullable(),
    archivedPolicyCount: count.nullable(),
    invalidPeriodPolicyCount: count.nullable(),
    additionalTypeCount: count,
    types: z.array(z.object({ label: id, count })),
    nearestExpiry: coveragePolicy.nullable(),
    policies: z.array(coveragePolicy),
  })
  .refine((summary) => !summary.available || summary.activePolicyCount !== null);

export const customerListReadSchema = z
  .object({
    items: z.array(
      customerDetailSchema
        .pick({ id: true, type: true, displayName: true, archivedAt: true, referenceName: true })
        .extend({
          email: nullableText.optional(),
          phone: nullableText.optional(),
          coverage: customerCoverageSchema.optional(),
        }),
    ),
    hasMore: z.boolean(),
    nextCursor: cursor,
  })
  .refine((page) => page.hasMore === (page.nextCursor !== null));

const relatedPoliciesSchema = z.object({
  items: z.array(
    z.object({
      id,
      customerId: id,
      policyNumber: id,
      // Older stored periods can be invalid calendar dates. The row still links to the record.
      startDate: z.string(),
      endDate: z.string(),
      status: z.enum(['ACTIVE', 'CANCELLED', 'VOIDED']),
      archivedAt: nullableText,
      labels: z.object({ branchName: id, productName: id, insurerName: id }).optional(),
    }),
  ),
  hasMore: z.boolean(),
  nextCursor: cursor,
});

export function relatedPoliciesFor(customerId: string) {
  return relatedPoliciesSchema.refine(
    (page) =>
      page.hasMore === (page.nextCursor !== null) &&
      page.items.every((policy) => policy.customerId === customerId),
  );
}

export const relatedRenewalsSchema = z.object({
  items: z.array(
    z.object({
      id,
      policyNumber: id,
      policyEndDate: z.string(),
      state: z.enum([
        'CONTACT_PENDING',
        'CONTACTED',
        'QUOTE_PREPARING',
        'QUOTE_SENT',
        'AWAITING_RESPONSE',
        'WON',
        'LOST',
        'VOIDED',
      ]),
    }),
  ),
  nextCursor: cursor,
});
