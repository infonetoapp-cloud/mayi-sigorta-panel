import { z } from 'zod';
import { readCustomerResource } from '../customers/customer-resource';

const id = z.string().min(1);
const version = z.number().int().positive();
const nullableText = z.string().nullable();
const catalog = z.object({ id, name: id, status: z.enum(['ACTIVE', 'INACTIVE']) });
const row = z.object({
  id,
  customerId: id,
  policyNumber: id,
  startDate: z.string(),
  endDate: z.string(),
  grossPremiumMinor: z.number().int(),
  currency: id,
  status: z.enum(['ACTIVE', 'CANCELLED', 'VOIDED']),
  archivedAt: nullableText,
  labels: z
    .object({
      customerDisplayName: nullableText.optional(),
      plate: nullableText.optional(),
      branchName: id,
      productName: id,
      insurerName: id,
    })
    .optional(),
});

export const policyListReadSchema = z
  .object({ items: z.array(row), hasMore: z.boolean(), nextCursor: id.nullable() })
  .refine((page) => page.hasMore === (page.nextCursor !== null));

const detail = row.extend({
  agencyId: id,
  insurerId: id,
  productId: id,
  branchId: id,
  paymentMethodId: id,
  assigneeMembershipId: id,
  normalizedPolicyNumber: id,
  installmentCount: z.number().int().nullable(),
  identityVariant: z.number().int(),
  archivedByMembershipId: nullableText,
  archiveReason: nullableText,
  version,
  createdAt: id,
  updatedAt: id,
  customer: z.object({ id, displayName: id }),
  insurer: catalog,
  product: catalog,
  branch: catalog.extend({
    dataClassification: z.enum(['GENERAL', 'HEALTH']),
    supportsVehicleDetails: z.boolean(),
  }),
  paymentMethod: catalog,
  vehicle: z
    .object({
      vehicleId: id,
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
    .nullable()
    .optional(),
});

export function policyDetailFor(id: string) {
  return detail.refine(
    (policy) =>
      policy.id === id &&
      policy.customer.id === policy.customerId &&
      policy.insurer.id === policy.insurerId &&
      policy.product.id === policy.productId &&
      policy.branch.id === policy.branchId &&
      policy.paymentMethod.id === policy.paymentMethodId,
  );
}

export function readPolicyDetail(id: string, signal?: AbortSignal) {
  return readCustomerResource(
    `/api/policies/${encodeURIComponent(id)}`,
    signal,
    policyDetailFor(id),
  );
}

const formCustomer = z.object({ id, displayName: id, archivedAt: nullableText });
export function policyFormCustomerFor(customerId: string) {
  return formCustomer.refine((customer) => customer.id === customerId);
}

export const policyFormCustomersSchema = z.object({
  items: z.array(formCustomer),
  hasMore: z.boolean(),
  nextCursor: id.nullable(),
});

export const policyFormCatalogsSchema = z.object({
  insurers: z.array(catalog.extend({ isDefault: z.boolean().optional() })),
  defaultInsurerId: id.nullish(),
  branches: z.array(catalog),
  products: z.array(catalog.extend({ insurerId: id, branchId: id })),
  paymentMethods: z.array(
    catalog.extend({
      supportsInstallments: z.boolean(),
      maxInstallments: z.number().int().positive(),
    }),
  ),
});
type FormCatalogsData = z.infer<typeof policyFormCatalogsSchema>;
export type PolicyFormCatalogs = {
  readonly [K in keyof FormCatalogsData]: Readonly<FormCatalogsData[K]>;
};

export const policyFormReceiptSchema = z.object({ id, customerId: id, version });
