import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import CustomerListPage from '../src/app/pages/customers/CustomerListPage';
import TodayWorkPage from '../src/app/pages/today-work/TodayWorkPage';
import PolicyFormPage from '../src/app/pages/policies/PolicyFormPage';

const response = (data: unknown) => new Response(JSON.stringify({ success: true, data }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('clears an empty customer search through a visible recovery action without changing the server paging contract', async () => {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url);
      return response({ items: [], hasMore: false, nextCursor: null });
    }),
  );
  render(
    <MemoryRouter>
      <CustomerListPage />
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { name: 'Müşteri bulunamadı' });
  fireEvent.change(screen.getByLabelText('Müşteri ara'), { target: { value: 'Sentetik arama' } });
  fireEvent.change(screen.getByLabelText('Müşteri türü'), { target: { value: 'COMPANY' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ara' }));
  await waitFor(() => expect(urls.at(-1)).toContain('type=COMPANY'));
  fireEvent.click(screen.getByRole('button', { name: 'Aramayı temizle' }));
  await waitFor(() => expect(urls.at(-1)).toBe('/api/customers?limit=20&include=coverage'));
  expect((screen.getByLabelText('Müşteri ara') as HTMLInputElement).value).toBe('');
  expect((screen.getByLabelText('Müşteri türü') as unknown as HTMLSelectElement).value).toBe('ALL');
  expect(urls.every((url) => !url.includes('limit=1000'))).toBe(true);
});
it('keeps business-day semantics available on demand rather than above the work queue', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      response({
        items: [],
        unassignedItems: [],
        hasMore: false,
        unassignedHasMore: false,
        canSeeUnassigned: false,
        canSeeReassignment: false,
        canAssign: false,
        timezone: 'Europe/Istanbul',
        todayLocalDate: '2026-10-27',
        now: '2026-10-27T10:00:00Z',
      }),
    ),
  );
  render(
    <MemoryRouter>
      <TodayWorkPage owner={false} />
    </MemoryRouter>,
  );
  const summary = await screen.findByText('Liste ve iş günü bilgisi');
  const details = summary.closest('details');
  expect(details).not.toBeNull();
  expect(details?.open).toBe(false);
  expect(details?.textContent).toContain('İstanbul takvim gününe');
  fireEvent.click(summary);
  expect(screen.getByRole('button', { name: 'Listeyi yenile' })).toBeTruthy();
});
it('keeps monetary guidance linked to the new policy premium in an optional disclosure', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      response(
        url === '/api/catalogs/selectable'
          ? {
              insurers: [],
              branches: [],
              products: [],
              paymentMethods: [],
              lossReasons: [],
              defaultInsurerId: null,
            }
          : url.startsWith('/api/customers?')
            ? { items: [{ id: 'c', displayName: 'Sentetik Müşteri' }], hasMore: false }
            : { id: 'c', displayName: 'Sentetik Müşteri', archivedAt: null },
      ),
    ),
  );
  render(
    <MemoryRouter initialEntries={['/policies/new?customerId=c']}>
      <PolicyFormPage />
    </MemoryRouter>,
  );
  const premium = await screen.findByLabelText('Brüt prim');
  expect(premium.getAttribute('aria-describedby')).toBe('contract-premium-help');
  const disclosure = screen.getByText('Prim giriş biçimi').closest('details');
  expect(disclosure?.open).toBe(false);
  expect(disclosure?.textContent).toContain('12.500,50');
  expect(screen.getByRole('button', { name: 'Poliçeyi oluştur' })).toBeTruthy();
});
