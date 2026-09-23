import { z } from 'zod';

const id = z.string().trim().min(1).max(128);
const policyStatus = z.enum(['ACTIVE', 'CANCELLED', 'VOIDED']);
const dateOnly = z.string().refine(isCanonicalDateOnly, 'Geçerli YYYY-MM-DD tarihi gereklidir.');
const ISO_CURRENCIES = new Set(Intl.supportedValuesOf('currency'));
const currency = z
  .string()
  .regex(/^[A-Z]{3}$/, 'ISO para birimi üç büyük harf olmalıdır.')
  .refine((value) => ISO_CURRENCIES.has(value), 'Geçerli bir ISO 4217 para birimi gereklidir.');

export function normalizePolicyNumber(value: string): string {
  if (typeof value !== 'string') throw new Error('POLICY_NUMBER_INVALID');
  const normalized = value
    .normalize('NFKC')
    .trim()
    .toUpperCase()
    .replace(/[^\p{L}\p{N}]/gu, '');
  if (normalized.length < 1 || normalized.length > 100) throw new Error('POLICY_NUMBER_INVALID');
  return normalized;
}

export function parsePremiumMinor(value: string): number {
  if (typeof value !== 'string' || !/^(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) {
    throw new Error('GROSS_PREMIUM_INVALID');
  }
  const [whole, fraction = ''] = value.split('.');
  const minor = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('GROSS_PREMIUM_OVERFLOW');
  return Number(minor);
}

export function parseSignedPremiumMinor(value: string): number {
  if (typeof value !== 'string' || !/^-?(?:0|[1-9]\d*)(?:\.\d{1,2})?$/.test(value)) {
    throw new Error('PREMIUM_DIFFERENCE_INVALID');
  }
  const negative = value.startsWith('-');
  const unsigned = negative ? value.slice(1) : value;
  const [whole, fraction = ''] = unsigned.split('.');
  const minor = BigInt(whole!) * 100n + BigInt(fraction.padEnd(2, '0'));
  const signed = negative ? -minor : minor;
  if (signed > BigInt(Number.MAX_SAFE_INTEGER) || signed < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new Error('PREMIUM_DIFFERENCE_OVERFLOW');
  }
  return Number(signed);
}

export function isCanonicalDateOnly(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (year < 1 || month < 1 || month > 12 || day < 1 || day > 31) return false;
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day
  );
}

const createSchema = z
  .object({
    customerId: id,
    insurerId: id.optional(),
    productId: id,
    branchId: id,
    paymentMethodId: id,
    assigneeMembershipId: id.optional(),
    policyNumber: z.string().min(1).max(200),
    startDate: dateOnly,
    endDate: dateOnly,
    grossPremium: z.string(),
    currency,
    installmentCount: z.number().int().min(2).max(36).nullable(),
    status: policyStatus.default('ACTIVE'),
  })
  .strict();

export type PolicyCreateInput = Omit<z.infer<typeof createSchema>, 'grossPremium'> & {
  grossPremiumMinor: number;
  normalizedPolicyNumber: string;
};

export function parsePolicyCreateInput(value: unknown): PolicyCreateInput {
  const parsed = createSchema.parse(value);
  if (parsed.startDate > parsed.endDate) throw new Error('POLICY_PERIOD_INVALID');
  const { grossPremium, ...rest } = parsed;
  return {
    ...rest,
    grossPremiumMinor: parsePremiumMinor(grossPremium),
    normalizedPolicyNumber: normalizePolicyNumber(parsed.policyNumber),
  };
}

const patchSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    policyNumber: z.string().min(1).max(200).optional(),
    startDate: dateOnly.optional(),
    endDate: dateOnly.optional(),
    grossPremium: z.string().optional(),
    currency: currency.optional(),
    installmentCount: z.number().int().min(2).max(36).nullable().optional(),
    status: policyStatus.optional(),
    insurerId: id.optional(),
    productId: id.optional(),
    branchId: id.optional(),
    paymentMethodId: id.optional(),
  })
  .strict()
  .refine((input) => Object.keys(input).length > 1, 'En az bir değişiklik zorunludur.');

export type PolicyPatchInput = z.infer<typeof patchSchema> & {
  grossPremiumMinor?: number;
  normalizedPolicyNumber?: string;
};

export function parsePolicyPatchInput(value: unknown): PolicyPatchInput {
  const parsed = patchSchema.parse(value);
  const result: PolicyPatchInput = { ...parsed };
  if (parsed.grossPremium !== undefined) {
    result.grossPremiumMinor = parsePremiumMinor(parsed.grossPremium);
    delete result.grossPremium;
  }
  if (parsed.policyNumber !== undefined) {
    result.normalizedPolicyNumber = normalizePolicyNumber(parsed.policyNumber);
  }
  return result;
}

export const policyAssignSchema = z
  .object({ expectedVersion: z.number().int().positive(), assigneeMembershipId: id })
  .strict();

export const policyListQuerySchema = z
  .object({
    customerId: id.optional(),
    insurerId: id.optional(),
    status: policyStatus.optional(),
    endFrom: dateOnly.optional(),
    endTo: dateOnly.optional(),
    sort: z.enum(['end_date_asc', 'end_date_desc', 'created_at_desc']).default('end_date_asc'),
    cursor: z.string().max(512).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).default(50),
  })
  .strict();

export const secureVariantSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    reason: z.string().trim().min(3).max(500),
    grantEvidenceToken: z.string().trim().min(20).max(1024),
  })
  .strict();

export const secureVariantGrantSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    reason: z.string().trim().min(3).max(500),
  })
  .strict();

export const policyPartyCreateSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    customerId: id,
    role: z.enum(['INSURED', 'BENEFICIARY']),
  })
  .strict();

export const policyPartyDeactivateSchema = z
  .object({ expectedVersion: z.number().int().positive() })
  .strict();

const amendmentInputSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    externalReference: z.string().trim().min(1).max(200),
    effectiveDate: dateOnly,
    description: z.string().trim().min(1).max(2000),
    premiumDifference: z.string().optional().nullable(),
    currency: currency.optional().nullable(),
  })
  .strict()
  .superRefine((value, context) => {
    if ((value.premiumDifference == null) !== (value.currency == null)) {
      context.addIssue({
        code: 'custom',
        message: 'Prim farkı ve para birimi birlikte verilmelidir.',
      });
    }
  });

export const policyAmendmentCreateSchema = amendmentInputSchema.transform((value) => ({
  expectedVersion: value.expectedVersion,
  externalReference: value.externalReference,
  effectiveDate: value.effectiveDate,
  description: value.description,
  premiumDifferenceMinor:
    value.premiumDifference == null ? null : parseSignedPremiumMinor(value.premiumDifference),
  currency: value.currency ?? null,
}));

export const policyExternalReferenceCreateSchema = z
  .object({
    expectedVersion: z.number().int().positive(),
    sourceNamespace: z.string().trim().min(1).max(100),
    externalKey: z.string().trim().min(1).max(200),
  })
  .strict();

const archiveReasonCode = z.string().regex(/^[A-Z][A-Z0-9_]{2,63}$/);
export const archivePolicySchema = z
  .object({ expectedVersion: z.number().int().positive(), reasonCode: archiveReasonCode })
  .strict();
