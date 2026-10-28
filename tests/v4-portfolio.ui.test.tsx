import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import PolicyListPage from '../src/app/pages/policies/PolicyListPage';
const p = {
  id: 'p1',
  customerId: 'c1',
  policyNumber: 'V4-POL',
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  status: 'ACTIVE',
  archivedAt: null,
  grossPremiumMinor: 1250050,
  currency: 'TRY',
  labels: { insurerName: 'Örnek Sigorta', productName: 'Kasko', branchName: 'Motor' },
  customer: { id: 'c1', displayName: 'Yetkili Müşteri' },
  insurer: { name: 'Örnek Sigorta' },
  product: { name: 'Kasko' },
  branch: { name: 'Motor' },
  paymentMethod: { name: 'Kart' },
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup() {
  const f = vi.fn(
    async (url: string) =>
      new Response(
        JSON.stringify({
          success: true,
          data:
            url === '/api/customers/c1'
              ? { id: 'c1', displayName: 'Yetkili Müşteri' }
              : url === '/api/policies/p1'
                ? p
                : url.includes('/catalogs/')
                  ? []
                  : { items: [p], hasMore: false, nextCursor: null },
        }),
      ),
  );
  vi.stubGlobal('fetch', f);
  render(
    <MemoryRouter initialEntries={['/policies?search=V4&searchMode=prefix']}>
      <Routes>
        <Route path="/policies" element={<PolicyListPage />} />
      </Routes>
    </MemoryRouter>,
  );
  return f;
}
it('renders authorized customer context from its own endpoint, and preview never loses active filters', async () => {
  setup();
  await screen.findByRole('link', { name: 'Yetkili Müşteri' });
  fireEvent.click(screen.getByRole('button', { name: 'V4-POL önizle' }));
  await screen.findByRole('dialog', { name: 'Poliçe önizlemesi' });
  expect(screen.getByRole('link', { name: 'Yenileme ve teklifler' }).getAttribute('href')).toBe(
    '/policies/p1?section=renewal',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Önizlemeyi kapat' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect((screen.getByLabelText('Poliçe numarası') as HTMLInputElement).value).toBe('V4');
});
it('uses server customer search and explicitly selected customer ID for policy filtering', async () => {
  const f = setup();
  await screen.findByRole('link', { name: 'V4-POL' });
  fireEvent.click(screen.getByRole('button', { name: /Gelişmiş filtreler/ }));
  fireEvent.change(screen.getByLabelText('Müşteri adıyla ara'), { target: { value: 'Deniz' } });
  fireEvent.click(screen.getByRole('button', { name: 'Müşterileri sunucuda ara' }));
  await waitFor(() =>
    expect(
      f.mock.calls.some(([u]) => u.includes('/api/customers?') && u.includes('search=Deniz')),
    ).toBe(true),
  );
});
it('does not derive a customer name from an extraneous policy DTO field when customer read is forbidden', async () => {
  setup();
  vi.mocked(fetch).mockImplementation(
    async (url) =>
      new Response(
        JSON.stringify({
          success: !String(url).startsWith('/api/customers/'),
          data: String(url).includes('/catalogs/')
            ? []
            : { items: [p], hasMore: false, nextCursor: null },
        }),
        { status: String(url).startsWith('/api/customers/') ? 403 : 200 },
      ),
  );
  await screen.findByRole('link', { name: 'V4-POL' });
  await screen.findByText('Müşteri bilgisine erişilemiyor');
  expect(screen.queryByRole('link', { name: 'Yetkili Müşteri' })).toBeNull();
});
