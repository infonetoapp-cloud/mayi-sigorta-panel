import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import CustomerManagementPage from '../src/app/pages/customers/CustomerManagementPage';
vi.mock('../src/app/components/CustomerAssignmentSection', () => ({
  CustomerAssignmentSection: () => <div>Sorumlu atama alanı</div>,
}));
vi.mock('../src/app/components/CustomerIdentitySection', () => ({
  CustomerIdentitySection: () => <div>Kimlik işlemleri alanı</div>,
}));
vi.mock('../src/app/components/CustomerExternalReferencesSection', () => ({
  CustomerExternalReferencesSection: () => <div>Dış referans alanı</div>,
}));
vi.mock('../src/app/components/CustomerArchiveSection', () => ({
  CustomerArchiveSection: () => <div>Arşivleme alanı</div>,
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('keeps the exact customer in a full-page operations workspace without a classic dialog or duplicate customer selection', async () => {
  const fetcher = vi.fn(
    async (_url: string) =>
      new Response(
        JSON.stringify({
          success: true,
          data: {
            id: 'customer-exact',
            displayName: 'Sentetik Acente Müşterisi',
            type: 'INDIVIDUAL',
            version: 3,
            archivedAt: null,
          },
        }),
      ),
  );
  vi.stubGlobal('fetch', fetcher);
  render(
    <MemoryRouter initialEntries={['/customers/customer-exact/manage']}>
      <Routes>
        <Route path="/customers/:customerId/manage" element={<CustomerManagementPage />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { name: 'Sentetik Acente Müşterisi' });
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.getByText('Sorumlu atama alanı')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Kimlik bilgileri' }));
  expect(screen.getByText('Kimlik işlemleri alanı')).toBeTruthy();
  fireEvent.keyDown(
    screen.getByRole('region', { name: 'Sentetik Acente Müşterisi müşteri işlemleri' }),
    { key: 'Escape' },
  );
  expect(screen.getByRole('heading', { name: 'Sentetik Acente Müşterisi' })).toBeTruthy();
  expect(fetcher.mock.calls.every(([url]) => url === '/api/customers/customer-exact')).toBe(true);
  expect(screen.queryByText(/klasik/i)).toBeNull();
});
