// @vitest-environment node
import { describe, expect, it } from 'vitest';
import {
  normalizePolicyNumber,
  parsePremiumMinor,
  parsePolicyCreateInput,
  parsePolicyPatchInput,
  secureVariantSchema,
} from '../src/server/policies/validation';
import {
  CreateBranchSchema,
  CreatePaymentMethodSchema,
  UpdatePaymentMethodSchema,
} from '../src/server/catalogs/service';

describe('M2-T04 policy validation', () => {
  it('normalizes policy numbers deterministically', () => {
    expect(normalizePolicyNumber('  AB-12 / 34  ')).toBe('AB1234');
    expect(normalizePolicyNumber(' ş-12-ğ ')).toBe('Ş12Ğ');
    const turkishForms = ['İLK-2026/001', 'ilk-2026/001', 'ILK-2026/001', 'ılk-2026/001'];
    expect(new Set(turkishForms.map(normalizePolicyNumber)).size).toBe(1);
    expect(normalizePolicyNumber('ＡＢ-１２')).toBe(normalizePolicyNumber('ab12'));
    expect(() => normalizePolicyNumber('---')).toThrow();
  });

  it('parses decimal money without float semantics', () => {
    expect(parsePremiumMinor('0')).toBe(0);
    expect(parsePremiumMinor('12.3')).toBe(1230);
    expect(parsePremiumMinor('90071992547409.91')).toBe(Number.MAX_SAFE_INTEGER);
    for (const invalid of [
      '1.001',
      '1e2',
      'NaN',
      'Infinity',
      '-1',
      '+1',
      '.5',
      '90071992547409.92',
    ]) {
      expect(() => parsePremiumMinor(invalid)).toThrow();
    }
  });

  it('requires real date-only values, ordered periods, ISO currency, and installment semantics', () => {
    const base = {
      customerId: 'customer-1',
      productId: 'product-1',
      branchId: 'branch-1',
      paymentMethodId: 'payment-1',
      policyNumber: 'AB-123',
      startDate: '2024-02-29',
      endDate: '2025-02-28',
      grossPremium: '123.45',
      currency: 'TRY',
      installmentCount: null,
      status: 'ACTIVE' as const,
    };
    expect(parsePolicyCreateInput(base).grossPremiumMinor).toBe(12345);
    expect(() => parsePolicyCreateInput({ ...base, startDate: '2023-02-29' })).toThrow();
    expect(() => parsePolicyCreateInput({ ...base, startDate: '2026-01-01' })).toThrow();
    expect(() => parsePolicyCreateInput({ ...base, currency: 'try' })).toThrow();
    expect(() => parsePolicyCreateInput({ ...base, currency: 'ZZZ' })).toThrow();
    expect(() => parsePolicyCreateInput({ ...base, identityVariant: 1 })).toThrow();
  });

  it('rejects identityVariant and assignee changes in generic PATCH', () => {
    expect(() => parsePolicyPatchInput({ expectedVersion: 1, identityVariant: 2 })).toThrow();
    expect(() =>
      parsePolicyPatchInput({ expectedVersion: 1, assigneeMembershipId: 'm2' }),
    ).toThrow();
    expect(parsePolicyPatchInput({ expectedVersion: 1, status: 'CANCELLED' }).status).toBe(
      'CANCELLED',
    );
  });

  it('requires a bounded reason and expected version for the secure variant command', () => {
    const token = 'x'.repeat(20);
    expect(() =>
      secureVariantSchema.parse({ expectedVersion: 1, grantEvidenceToken: token }),
    ).toThrow();
    expect(() =>
      secureVariantSchema.parse({ expectedVersion: 1, reason: '  ', grantEvidenceToken: token }),
    ).toThrow();
    expect(() =>
      secureVariantSchema.parse({ reason: 'Geçerli gerekçe', grantEvidenceToken: token }),
    ).toThrow();
  });

  it('exposes T04 health and installment catalog semantics through strict catalog inputs', () => {
    expect(
      CreateBranchSchema.parse({
        code: 'HEALTH',
        name: 'Sağlık',
        dataClassification: 'HEALTH',
      }),
    ).toMatchObject({ dataClassification: 'HEALTH' });
    expect(
      CreatePaymentMethodSchema.parse({
        code: 'CARD',
        name: 'Kart',
        supportsInstallments: true,
        maxInstallments: 18,
      }),
    ).toMatchObject({ supportsInstallments: true, maxInstallments: 18 });
    expect(
      UpdatePaymentMethodSchema.parse({ expectedVersion: 1, supportsInstallments: false }),
    ).toMatchObject({ supportsInstallments: false });
    expect(() =>
      CreatePaymentMethodSchema.parse({
        code: 'CARD',
        name: 'Kart',
        supportsInstallments: true,
        maxInstallments: 37,
      }),
    ).toThrow();
  });
});
