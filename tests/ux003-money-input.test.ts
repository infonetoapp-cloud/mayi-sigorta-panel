// @vitest-environment node
import { expect, it } from 'vitest';
import {
  blankPolicyDraft,
  contractValues,
  premiumMinor,
} from '../src/app/pages/policies/policy-form-model';
import { policyMoney } from '../src/app/pages/policies/policy-display';
it.each(['12500,50', '12500.50', '12.500,50', '12.500,5', ' 12500,50 '])(
  'accepts an unambiguous employee amount %s without floating point',
  (value) => {
    expect(premiumMinor(value)).toBe(1250050n);
    expect(contractValues({ ...blankPolicyDraft, grossPremium: value }).grossPremium).toBe(
      '12500.50',
    );
  },
);
it.each([
  '12.500',
  '12,500',
  '12,500.50',
  '12.50,50',
  '1.23.500,50',
  '1..000,00',
  '01,50',
  '0.000,50',
  '+1,00',
  '-1,00',
  '1e3',
  'NaN',
  'Infinity',
  '1 000,00',
  '0.005',
  '0,005',
  '12500,501',
  '90071992547409,92',
  '90.071.992.547.409,92',
  '',
  ',50',
  '.50',
])('rejects ambiguous, imprecise or invalid input %s', (value) =>
  expect(premiumMinor(value)).toBeNull(),
);
it.each([
  ['0,01', 1n],
  ['0', 0n],
  ['90071992547409.91', 9007199254740991n],
  ['90.071.992.547.409,91', 9007199254740991n],
])('keeps exact cent/overflow boundaries for %s', (value, minor) =>
  expect(premiumMinor(String(value))).toBe(minor),
);
it.each([
  ['TRY', '₺'],
  ['EUR', '€'],
  ['USD', '$'],
  ['CAD', 'CA$'],
  ['AUD', 'AU$'],
  ['JPY', '¥'],
])('formats %s under the existing two-decimal minor-unit contract', (currency, symbol) => {
  expect(policyMoney(1250050, currency)).toBe(`12.500,50 ${symbol}`);
  expect(policyMoney(-50, currency)).toBe(`-0,50 ${symbol}`);
});
it('formats the maximum integer exactly without a floating point major-unit division', () =>
  expect(policyMoney(Number.MAX_SAFE_INTEGER, 'TRY')).toBe('90.071.992.547.409,91 ₺'));
