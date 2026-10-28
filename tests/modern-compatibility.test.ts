import { expect, it } from 'vitest';
import { modernCompatibilityTarget } from '../src/app/pages/modern-compatibility';
it('maps old exact business targets to real modern workflows without retargeting an ambiguous link', () => {
  expect(modernCompatibilityTarget('policies', '?policyId=exact-policy')).toBe(
    '/policies/exact-policy',
  );
  expect(modernCompatibilityTarget('policies', '?customerId=exact-customer')).toBe(
    '/policies/new?customerId=exact-customer',
  );
  expect(modernCompatibilityTarget('policies', '?customerId=a&policyId=b')).toBeNull();
  expect(modernCompatibilityTarget('customers', '')).toBe('/customers');
  expect(modernCompatibilityTarget('customers', '?customerId=exact')).toBe(
    '/customers/exact/manage',
  );
  expect(modernCompatibilityTarget('today-work', '?task=exact&queue=WORK&work=quotes')).toBe(
    '/today-work?task=exact&queue=WORK&work=quotes',
  );
  expect(modernCompatibilityTarget('today-work', '?password=not-forwarded')).toBe('/today-work');
  for (const query of [
    '?task=a&task=b',
    '?task=a&queue=WORK&queue=UNASSIGNED',
    '?task=a&work=quotes&work=interactions',
  ])
    expect(modernCompatibilityTarget('today-work', query)).toBeNull();
});
