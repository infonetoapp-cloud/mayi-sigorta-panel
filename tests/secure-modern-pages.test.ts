import { expect, it } from 'vitest';
import { renderPolicyIdentityVariantConfirmation } from '../src/server/policies/secure-confirm';
import { REAUTH_PAGE } from '../src/server/auth/reauth-page';
import type { PolicyDetailDto } from '../src/shared/types';
it('renders both secured employee pages in the shared light V4 shell without changing protocol hooks', () => {
  const html = renderPolicyIdentityVariantConfirmation({
    id: 'exact',
    policyNumber: '<unsafe>',
    customer: { displayName: 'Sentetik & Müşteri' },
    startDate: '2026-01-01',
    endDate: '2027-01-01',
    version: 3,
  } as PolicyDetailDto);
  for (const page of [html, REAUTH_PAGE]) {
    expect(page).toContain('employee-secure');
    expect(page).toContain('Mayı Sigorta');
    expect(page).toContain(':focus-visible');
  }
  expect(html).toContain('Aynı numarayla farklı sözleşme');
  expect(html).toContain('data-policy-id="exact"');
  expect(html).toContain('data-expected-version="3"');
  expect(html).toContain('&lt;unsafe&gt;');
  expect(html).toContain('/policies/exact');
  expect(REAUTH_PAGE).toContain('autocomplete="current-password"');
  expect(REAUTH_PAGE).toContain('id="reauth-form"');
});
