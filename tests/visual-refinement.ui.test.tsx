import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import PolicyFormPage from '../src/app/pages/policies/PolicyFormPage';
import TodayWorkPage from '../src/app/pages/today-work/TodayWorkPage';

const response = (data: unknown) => new Response(JSON.stringify({ success: true, data }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const catalogs = {
  insurers: [],
  branches: [],
  products: [],
  paymentMethods: [],
  lossReasons: [],
  defaultInsurerId: null,
};
function policyFixture() {
  const fetcher = vi.fn(async (url: string) =>
    response(
      url === '/api/catalogs/selectable'
        ? catalogs
        : url.startsWith('/api/customers?')
          ? {
              items: [{ id: 'other', displayName: 'Başka Müşteri', archivedAt: null }],
              hasMore: false,
            }
          : { id: url.split('/').at(-1), displayName: 'Seçili Müşteri', archivedAt: null },
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  render(
    <MemoryRouter initialEntries={['/policies/new?customerId=origin']}>
      <PolicyFormPage />
    </MemoryRouter>,
  );
  return fetcher;
}
it('requires explicit draft-discard confirmation before changing the exact selected customer', async () => {
  const fetcher = policyFixture();
  fireEvent.change(await screen.findByLabelText('Poliçe numarası'), {
    target: { value: 'KORUNAN-TASLAK' },
  });
  fireEvent.change(screen.getByLabelText('Müşteri'), { target: { value: 'other' } });
  await screen.findByRole('dialog', { name: 'Müşteriyi değiştirmeden önce' });
  expect((screen.getByLabelText('Poliçe numarası') as HTMLInputElement).value).toBe(
    'KORUNAN-TASLAK',
  );
  expect(fetcher.mock.calls.some(([url]) => url === '/api/customers/other')).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Taslağı koru' }));
  expect((screen.getByLabelText('Müşteri') as unknown as HTMLSelectElement).value).toBe('origin');
  fireEvent.change(screen.getByLabelText('Müşteri'), { target: { value: 'other' } });
  fireEvent.click(
    await screen.findByRole('button', { name: 'Taslağı bırak ve müşteriyi değiştir' }),
  );
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([url]) => url === '/api/customers/other')).toBe(true),
  );
  await waitFor(() =>
    expect((screen.getByLabelText('Poliçe numarası') as HTMLInputElement).value).toBe(''),
  );
});
it('uses readable employee currency wording while retaining the canonical currency field', async () => {
  policyFixture();
  const input = await screen.findByLabelText('Para birimi');
  expect(input.id).toBe('contract-currency');
  expect(screen.queryByLabelText('ISO para birimi')).toBeNull();
});
it('distinguishes task scope from date filtering and renders a real empty queue after the scope click', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      response({
        items: [],
        unassignedItems: [],
        hasMore: false,
        unassignedHasMore: false,
        canSeeUnassigned: true,
        canSeeReassignment: false,
        canAssign: true,
        timezone: 'Europe/Istanbul',
        todayLocalDate: '2026-10-27',
        now: '2026-10-27T12:00:00Z',
      }),
    ),
  );
  render(
    <MemoryRouter>
      <TodayWorkPage owner />
    </MemoryRouter>,
  );
  await screen.findByText('İş kapsamı');
  expect(screen.getByText('Takip zamanı')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Atanmamış işler' }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Atanmamış işler' }).getAttribute('aria-pressed'),
    ).toBe('true'),
  );
  expect(screen.getByText('Bu kuyrukta gösterilecek takip bulunmuyor.')).toBeTruthy();
  expect(screen.queryByRole('region', { name: 'Seçili görev özeti' })).toBeNull();
});
