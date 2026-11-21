import { expect, it } from 'vitest';
import { policyPeriodLabel } from '../src/app/pages/policies/policy-display';
import { istanbulToday } from '../src/shared/customer-profile';

it('distinguishes an active record from inclusive nonannual coverage in Istanbul', () => {
  const policy = { status: 'ACTIVE' as const, startDate: '2026-11-17', endDate: '2026-12-03' };
  expect(policyPeriodLabel(policy, '2026-11-16')).toBe('Henüz başlamadı');
  expect(policyPeriodLabel(policy, '2026-11-17')).toBe('Yürürlükte');
  expect(policyPeriodLabel(policy, '2026-12-03')).toBe('Yürürlükte');
  expect(policyPeriodLabel(policy, '2026-12-04')).toBe('Süresi doldu');
  expect(istanbulToday(new Date('2026-11-16T21:01:00Z'))).toBe('2026-11-17');
});
it('never presents cancelled, voided or archived records as current coverage', () => {
  const policy = { startDate: '2026-11-01', endDate: '2026-12-01' };
  expect(policyPeriodLabel({ ...policy, status: 'CANCELLED' }, '2026-11-17')).toBe('İptal');
  expect(policyPeriodLabel({ ...policy, status: 'VOIDED' }, '2026-11-17')).toBe('Geçersiz');
  expect(
    policyPeriodLabel({ ...policy, status: 'ACTIVE', archivedAt: '2026-11-15' }, '2026-11-17'),
  ).toBe('Arşivlenmiş kayıt');
});
