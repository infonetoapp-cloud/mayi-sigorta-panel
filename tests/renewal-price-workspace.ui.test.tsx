import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import RenewalDetailPage from '../src/app/pages/renewals/RenewalDetailPage';
const legacy = vi.hoisted(() => vi.fn());
vi.mock('../src/app/pages/today-work/RenewalQuotesSection', () => ({
  RenewalQuotesSection: () => {
    legacy();
    return <p>Önceki teklif işlemleri</p>;
  },
}));
vi.mock('../src/app/pages/today-work/RenewalInteractionsSection', () => ({
  RenewalInteractionsSection: () => <p>Görüşmeler alanı</p>,
}));
const price = {
  source: 'PRICE_REVISION',
  priceId: 'price1',
  priceVersion: 2,
  revisionId: 'rev2',
  revisionNumber: 2,
  insurerId: 'i1',
  insurerName: 'Anadolu Sigorta',
  amountMinor: 1250050,
  currency: 'TRY',
  createdAt: '2026-11-18T09:00:00.000Z',
  termsNote: null,
  offeredPeriod: null,
};
const work = { id: 'case1', context: 'RENEWAL', renewalId: 'r1', customerId: 'c1', version: 3 };
function setup(readonly = false, malformed = false) {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    let data: unknown;
    if (url === '/api/renewals/r1')
      data = {
        id: 'r1',
        state: readonly ? 'LOST' : 'CONTACT_PENDING',
        version: 3,
        closedAt: readonly ? '2026-11-18T09:00:00.000Z' : null,
        isOpen: !readonly,
        parentArchived: readonly,
        customer: { id: 'c1', displayName: 'Örnek Müşteri' },
        policy: {
          id: 'p1',
          number: 'POL-001',
          startDate: '2026-01-01',
          endDate: '2026-12-31',
          insurerName: 'Anadolu Sigorta',
          branchName: 'Kasko',
          grossPremiumMinor: 1200050,
          currency: 'TRY',
          status: readonly ? 'CANCELLED' : 'ACTIVE',
        },
        phone: null,
        email: null,
        referenceName: null,
        insurerCustomerNumber: '000123',
        vehicle: null,
      };
    else if (url.startsWith('/api/sales-cases?'))
      data = malformed ? { items: 'broken' } : { items: [work] };
    else if (url === '/api/sales-cases/case1') data = work;
    else if (url.startsWith('/api/sales-cases/case1/prices/price1/history'))
      data = { revisions: [price], hasMore: false, nextCursor: null };
    else if (url.startsWith('/api/sales-cases/case1/prices?'))
      data = { items: [price], canManage: !readonly, hasMore: false, nextCursor: null };
    else throw Error('Unexpected ' + url);
    return Response.json({ success: true, data });
  });
  vi.stubGlobal('fetch', fetcher);
  render(
    <MemoryRouter initialEntries={['/renewals/r1']}>
      <Routes>
        <Route path="/renewals/:renewalId" element={<RenewalDetailPage />} />
        <Route path="/renewals" element={<p>Yenilemeler listesi</p>} />
      </Routes>
    </MemoryRouter>,
  );
  return fetcher;
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  legacy.mockClear();
});
it('uses the bounded company-price workspace by default, preserves a draft across sections and guards leaving', async () => {
  const fetcher = setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Fiyatı güncelle' }));
  fireEvent.change(screen.getByLabelText('Fiyat (zorunlu)'), { target: { value: '14.200,50' } });
  fireEvent.click(screen.getByRole('button', { name: 'Görüşmeler' }));
  fireEvent.click(screen.getByRole('button', { name: 'Şirket teklifleri' }));
  expect((screen.getByLabelText('Fiyat (zorunlu)') as HTMLInputElement).value).toBe('14.200,50');
  expect(legacy).not.toHaveBeenCalled();
  expect(
    fetcher.mock.calls.some(
      ([url]) => String(url).includes('operation-context') || String(url).endsWith('/task'),
    ),
  ).toBe(false);
  fireEvent.click(screen.getByRole('link', { name: '← Yenilemelere dön' }));
  await screen.findByRole('button', { name: 'Bu ekranda kal' });
  expect(screen.queryByText('Yenilemeler listesi')).toBeNull();
});
it('keeps cancelled/archived renewal price history readable and exposes no create or update controls', async () => {
  const fetcher = setup(true);
  fireEvent.click(await screen.findByRole('button', { name: 'Fiyat geçmişi' }));
  await screen
    .findByRole('region', { name: 'Anadolu Sigorta fiyat geçmişi' })
    .catch(() => screen.findByRole('heading', { name: 'Anadolu Sigorta · Fiyat geçmişi' }));
  expect(screen.queryByRole('button', { name: 'Şirket fiyatı ekle' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Fiyatı güncelle' })).toBeNull();
  expect(fetcher.mock.calls.some(([url]) => String(url).includes('/history'))).toBe(true);
  expect(legacy).not.toHaveBeenCalled();
});
it('does not create a case or request a private Task when the case-list DTO is malformed', async () => {
  const fetcher = setup(false, true);
  await screen.findByText('Şirket fiyatları yüklenemedi.');
  expect(screen.queryByRole('button', { name: 'Fiyatları girmeye başla' })).toBeNull();
  expect(fetcher.mock.calls.some(([url]) => String(url).includes('operation-context'))).toBe(false);
});
