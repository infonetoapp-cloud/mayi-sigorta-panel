import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import PolicyListPage from '../src/app/pages/policies/PolicyListPage';
import CustomerProfilePage from '../src/app/pages/customers/CustomerProfilePage';
import { RenewalQuotesSection } from '../src/app/pages/today-work/RenewalQuotesSection';
import { PersonnelPanel } from '../src/app/components/PersonnelPanel';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('keeps full access one click while ordinary reasons remain an optional closed disclosure', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            data: {
              personnel: [
                {
                  id: 'member',
                  user_id: 'u',
                  display_name: 'Sentetik',
                  login_email: 'test@example.invalid',
                  status: 'ACTIVE',
                  type: 'MEMBER',
                  version: 1,
                  grants: [],
                },
              ],
              nextCursor: null,
            },
          }),
        ),
    ),
  );
  render(<PersonnelPanel />);
  fireEvent.click(await screen.findByRole('button', { name: 'İzinleri düzenle' }));
  const reason = screen.getByLabelText('Gerekçe') as HTMLTextAreaElement;
  expect(reason.required).toBe(false);
  expect(reason.closest('details')).not.toBeNull();
  expect(reason.closest('details')?.open).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Tam Yetki Ver' }));
  expect(screen.getByText('Tam yetki taslağı')).toBeTruthy();
  expect(screen.getByRole('region', { name: 'İzin karşılaştırma tablosu' })).toBeTruthy();
});
it('separates the next legitimate quotation action from historical read/refresh controls and never implies message delivery', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (u: string) =>
        new Response(
          JSON.stringify({
            success: true,
            data: u.includes('/catalogs/selectable')
              ? { insurers: [], branches: [], products: [], paymentMethods: [] }
              : u.includes('/catalogs/insurers')
                ? []
                : {
                    defaultVersion: {
                      insurerId: 'i',
                      branchId: 'b',
                      productId: 'p',
                      paymentMethodId: 'm',
                      startDate: '2027-01-01',
                      endDate: '2027-12-31',
                      validUntil: '2027-01-01T09:00:00Z',
                      grossPremiumMinor: 10000,
                      currency: 'TRY',
                      installmentCount: null,
                      termsSummary: null,
                    },
                    quotes: [],
                  },
          }),
        ),
    ),
  );
  render(
    <RenewalQuotesSection
      renewalId="r"
      renewalVersion={1}
      renewalOpen
      canOperate={() => true}
      compareRenewal={async () => 1}
      onRisk={() => {}}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Teklif geçmişini aç' }));
  await screen.findByText('Henüz teklif kaydı bulunmuyor.');
  const actions = screen.getByRole('group', { name: 'Sonraki teklif işlemi' });
  expect(actions.contains(screen.getByRole('button', { name: 'Yeni teklif taslağı aç' }))).toBe(
    true,
  );
  expect(
    actions.contains(
      screen.getByRole('button', { name: 'Teklif geçmişini ve katalogları yeniden oku' }),
    ),
  ).toBe(false);
  expect(screen.getByText(/Bu bölüm müşteriye mesaj göndermez/)).toBeTruthy();
});
it('prioritizes actual customer coverage without motivational duplicate navigation or private task reads', async () => {
  const request = vi.fn(
    async (url: string) =>
      new Response(
        JSON.stringify({
          success: true,
          data: url.includes('/coverage')
            ? { available: false, types: [], policies: [] }
            : {
                id: 'a',
                type: 'INDIVIDUAL',
                displayName: 'Yetkili Örnek',
                email: null,
                phone: null,
                address: null,
                archivedAt: null,
                version: 1,
                createdAt: '2026-01-01T00:00:00Z',
                contacts: [],
                assigneeMembershipId: null,
              },
        }),
      ),
  );
  vi.stubGlobal('fetch', request);
  render(
    <MemoryRouter initialEntries={['/customers/a']}>
      <Routes>
        <Route path="/customers/:customerId" element={<CustomerProfilePage />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { name: 'Yetkili Örnek' });
  expect(screen.queryByRole('heading', { name: 'Bir sonraki adım, doğru bağlamda.' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Çalışma bağlantıları' })).toBeNull();
  expect(screen.getAllByRole('link', { name: 'İleri müşteri işlemleri' })).toHaveLength(1);
  expect(request.mock.calls.some(([u]) => u.startsWith('/api/tasks'))).toBe(false);
});
it('folds secondary portfolio controls without losing exact search, matching or sort values', async () => {
  const request = vi.fn(
    async (url: string) =>
      new Response(
        JSON.stringify({
          success: true,
          data: url.includes('/catalogs/') ? [] : { items: [], hasMore: false, nextCursor: null },
        }),
      ),
  );
  vi.stubGlobal('fetch', request);
  const { container } = render(
    <MemoryRouter initialEntries={['/policies?status=ACTIVE']}>
      <PolicyListPage />
    </MemoryRouter>,
  );
  await waitFor(() => expect(request).toHaveBeenCalled());
  const panel = container.querySelector('[data-filters-open]');
  expect(panel).not.toBeNull();
  expect(panel?.getAttribute('data-filters-open')).toBe('false');
  expect(screen.getByRole('region', { name: 'Etkin filtreler' }).textContent).toContain('Aktif');
  fireEvent.click(screen.getByRole('button', { name: 'Gelişmiş filtreler' }));
  expect(panel?.getAttribute('data-filters-open')).toBe('true');
  fireEvent.change(screen.getByLabelText('Eşleştirme'), { target: { value: 'prefix' } });
  fireEvent.change(screen.getByLabelText('Sıralama'), { target: { value: 'created_at_desc' } });
  fireEvent.change(screen.getByLabelText('Poliçe numarası'), { target: { value: 'SENTETIK' } });
  fireEvent.click(screen.getByRole('button', { name: 'Filtrele' }));
  await waitFor(() =>
    expect(
      request.mock.calls.some(
        ([u]) =>
          u.includes('search=SENTETIK') &&
          u.includes('searchMode=prefix') &&
          u.includes('sort=created_at_desc') &&
          u.includes('status=ACTIVE'),
      ),
    ).toBe(true),
  );
});
