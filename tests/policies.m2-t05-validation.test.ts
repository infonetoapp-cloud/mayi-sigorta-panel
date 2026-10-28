import { describe, expect, it } from 'vitest';
import {
  policyPartyCreateSchema,
  policyPartyDeactivateSchema,
  policyAmendmentCreateSchema,
  policyExternalReferenceCreateSchema,
  archivePolicySchema,
} from '../src/server/policies/validation';
import { ArchiveCustomerSchema } from '../src/server/customers/service';

describe('M2-T05 lifecycle validation', () => {
  it('accepts only INSURED and BENEFICIARY party roles', () => {
    expect(
      policyPartyCreateSchema.parse({ expectedVersion: 1, customerId: 'c', role: 'INSURED' }).role,
    ).toBe('INSURED');
    expect(
      policyPartyCreateSchema.parse({ expectedVersion: 1, customerId: 'c', role: 'BENEFICIARY' })
        .role,
    ).toBe('BENEFICIARY');
    expect(() =>
      policyPartyCreateSchema.parse({ expectedVersion: 1, customerId: 'c', role: 'OWNER' }),
    ).toThrow();
  });

  it('requires versions for every relationship and lifecycle mutation', () => {
    expect(() => policyPartyDeactivateSchema.parse({})).toThrow();
    expect(() => policyPartyCreateSchema.parse({ customerId: 'c', role: 'INSURED' })).toThrow();
    expect(() =>
      policyAmendmentCreateSchema.parse({
        externalReference: 'Z',
        effectiveDate: '2026-01-01',
        description: 'x',
      }),
    ).toThrow();
    expect(() =>
      policyExternalReferenceCreateSchema.parse({ sourceNamespace: 'legacy', externalKey: 'p-1' }),
    ).toThrow();
    expect(() => archivePolicySchema.parse({ reasonCode: 'DUPLICATE' })).toThrow();
    expect(() => ArchiveCustomerSchema.parse({ expectedVersion: 1 })).toThrow();
  });

  it('validates amendment date, signed minor-unit difference and currency pairing', () => {
    const value = policyAmendmentCreateSchema.parse({
      expectedVersion: 1,
      externalReference: 'ZY-1',
      effectiveDate: '2026-02-28',
      description: 'Teminat değişikliği',
      premiumDifference: '-12.34',
      currency: 'TRY',
    });
    expect(value.premiumDifferenceMinor).toBe(-1234);
    expect(() =>
      policyAmendmentCreateSchema.parse({
        expectedVersion: 1,
        externalReference: 'ZY-2',
        effectiveDate: '2026-02-30',
        description: 'x',
        premiumDifference: '1.001',
        currency: 'TRY',
      }),
    ).toThrow();
    expect(() =>
      policyAmendmentCreateSchema.parse({
        expectedVersion: 1,
        externalReference: 'ZY-3',
        effectiveDate: '2026-02-28',
        description: 'x',
        premiumDifference: '1.00',
      }),
    ).toThrow();
  });

  it('strictly validates external references and bounded archive reason codes', () => {
    expect(
      policyExternalReferenceCreateSchema.parse({
        expectedVersion: 1,
        sourceNamespace: 'legacy',
        externalKey: 'p-1',
      }),
    ).toEqual({ expectedVersion: 1, sourceNamespace: 'legacy', externalKey: 'p-1' });
    expect(() =>
      policyExternalReferenceCreateSchema.parse({
        expectedVersion: 1,
        sourceNamespace: 'legacy',
        externalKey: 'p-1',
        agencyId: 'forged',
      }),
    ).toThrow();
    expect(
      archivePolicySchema.parse({ expectedVersion: 1, reasonCode: 'DUPLICATE_RECORD' }),
    ).toEqual({
      expectedVersion: 1,
      reasonCode: 'DUPLICATE_RECORD',
    });
    expect(() =>
      archivePolicySchema.parse({ expectedVersion: 1, reasonCode: 'serbest metin' }),
    ).toThrow();
  });
});
