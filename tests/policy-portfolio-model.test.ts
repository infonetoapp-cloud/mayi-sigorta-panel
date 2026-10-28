import { expect, it } from 'vitest';
import { expirationRange, portfolioReturn } from '../src/app/pages/policies/policy-portfolio';
it('uses inclusive Istanbul dates across UTC midnight, year and leap boundaries', () => {
  expect(expirationRange(1, new Date('2026-10-22T21:00:00Z'))).toEqual({
    endFrom: '2026-10-23',
    endTo: '2026-10-23',
  });
  expect(expirationRange(3, new Date('2026-12-30T21:00:00Z'))).toEqual({
    endFrom: '2026-12-31',
    endTo: '2027-01-02',
  });
  expect(expirationRange(3, new Date('2028-02-27T12:00:00Z'))).toEqual({
    endFrom: '2028-02-27',
    endTo: '2028-02-29',
  });
  expect(expirationRange('past', new Date('2026-10-22T21:00:00Z'))).toEqual({
    endFrom: '',
    endTo: '2026-10-22',
  });
});
it('allows only local portfolio return URLs and known query parameters', () => {
  for (const value of [
    'https://foreign.invalid',
    '//foreign.invalid',
    '/policies/../../foreign',
    '/customers',
    '/policies#bad',
  ])
    expect(portfolioReturn({ policyListReturn: value })).toBe('/policies');
  expect(
    portfolioReturn({
      policyListReturn: '/policies?insurerId=i&cursor=opaque%2B&untrusted=secret',
    }),
  ).toBe('/policies?insurerId=i&cursor=opaque%2B');
});
