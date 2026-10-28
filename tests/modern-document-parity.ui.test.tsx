import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import PolicyDetailPage from '../src/app/pages/policies/PolicyDetailPage';
import CustomerProfilePage from '../src/app/pages/customers/CustomerProfilePage';
vi.mock('../src/app/components/DocumentSection', () => ({
  DocumentSection: ({ ownerType, ownerId }: { ownerType: string; ownerId: string }) => (
    <div>
      Belge kapsamı {ownerType}:{ownerId}
    </div>
  ),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('opens policy documents and exact secure duplicate-contract confirmation from the modern policy', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: {
              id: 'policy-exact',
              policyNumber: 'POL-EXACT',
              customerId: 'customer-exact',
              customer: { id: 'customer-exact', displayName: 'Sentetik Müşteri' },
              insurer: { name: 'Şirket' },
              branch: { name: 'Kasko' },
              product: { name: 'Kasko' },
              paymentMethod: { name: 'Peşin' },
              status: 'ACTIVE',
              startDate: '2026-01-01',
              endDate: '2027-01-01',
              version: 3,
              archivedAt: null,
              grossPremiumMinor: 123450,
              currency: 'TRY',
            },
          }),
        ),
    ),
  );
  render(
    <MemoryRouter initialEntries={['/policies/policy-exact?section=documents']}>
      <Routes>
        <Route path="/policies/:policyId" element={<PolicyDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByText('Belge kapsamı POLICY:policy-exact');
  const secure = screen.getByRole('link', { name: 'Aynı numarayla farklı sözleşme kaydet' });
  expect(secure.getAttribute('href')).toBe(
    '/secure/confirm/policies/policy-exact/identity-variant',
  );
  expect(screen.queryByRole('link', { name: /klasik/i })).toBeNull();
});
it('opens customer documents on the exact modern customer without opening another customer selector', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: {
              id: 'customer-exact',
              displayName: 'Sentetik Müşteri',
              type: 'INDIVIDUAL',
              version: 1,
              createdAt: '2026-01-01T00:00:00Z',
              archivedAt: null,
              contacts: [],
            },
          }),
        ),
    ),
  );
  render(
    <MemoryRouter initialEntries={['/customers/customer-exact?section=documents']}>
      <Routes>
        <Route path="/customers/:customerId" element={<CustomerProfilePage />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByText('Belge kapsamı CUSTOMER:customer-exact');
});
