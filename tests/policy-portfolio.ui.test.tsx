import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router';
import PolicyListPage from '../src/app/pages/policies/PolicyListPage';
import PolicyDetailPage from '../src/app/pages/policies/PolicyDetailPage';
const row = {
  id: 'p',
  customerId: 'c',
  policyNumber: 'PORT-1',
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  grossPremiumMinor: 1250050,
  currency: 'TRY',
  status: 'ACTIVE',
  archivedAt: null,
  labels: { insurerName: 'Anadolu Test', productName: 'Kasko Test', branchName: 'Motor Test' },
  customer: { id: 'c', displayName: 'DETAIL_ONLY_CUSTOMER' },
  insurer: { name: 'Anadolu Test' },
  product: { name: 'Kasko Test' },
  branch: { name: 'Motor Test' },
  paymentMethod: { name: 'Kart' },
};
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ success: status === 200, data }), { status });
let urls: string[] = [];
function stub() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url);
      if (url.startsWith('/api/catalogs/insurers'))
        return response([
          { id: 'i', name: 'Anadolu Test', status: 'ACTIVE' },
          { id: 'old', name: 'Eski Şirket', status: 'INACTIVE' },
        ]);
      if (url === '/api/policies/p') return response(row);
      return response({
        items: [row, { ...row, id: 'missing', policyNumber: 'PORT-2', labels: undefined }],
        hasMore: !url.includes('cursor='),
        nextCursor: 'opaque+cursor=',
      });
    }),
  );
}
function Location() {
  const l = useLocation();
  return <output aria-label="Konum">{l.pathname + l.search}</output>;
}
function mount(path = '/policies') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Location />
      <Routes>
        <Route path="/policies" element={<PolicyListPage />} />
        <Route path="/policies/:policyId" element={<PolicyDetailPage />} />
      </Routes>
    </MemoryRouter>,
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  urls = [];
});
it('requests server labels once per page and renders labels without DTO-extraneous customer names or per-row GETs', async () => {
  stub();
  mount();
  const link = await screen.findByRole('link', { name: 'PORT-1' });
  const tr = link.closest('tr')!;
  expect(within(tr).getByText('Anadolu Test')).toBeTruthy();
  expect(within(tr).getByText('Kasko Test')).toBeTruthy();
  expect(within(tr).getByText('Motor Test')).toBeTruthy();
  expect(document.body.textContent).not.toContain('DETAIL_ONLY_CUSTOMER');
  expect(urls.filter((u) => u.startsWith('/api/policies?'))[0]).toContain('includeLabels=true');
  expect(urls.filter((u) => u.startsWith('/api/policies/'))).toEqual([]);
  expect(urls.filter((u) => u.startsWith('/api/catalogs/insurers'))).toHaveLength(1);
});
it('applies insurer with existing filters, drops old cursor and preserves exact page on detail return', async () => {
  stub();
  mount('/policies?search=PORT&searchMode=prefix&status=ACTIVE&insurerId=i&cursor=old');
  await screen.findByRole('link', { name: 'PORT-1' });
  await waitFor(() =>
    expect((screen.getByLabelText('Sigortacı') as unknown as HTMLSelectElement).value).toBe('i'),
  );
  fireEvent.change(screen.getByLabelText('Sigortacı'), { target: { value: 'old' } });
  fireEvent.click(screen.getByRole('button', { name: 'Filtrele' }));
  await waitFor(() =>
    expect(screen.getByLabelText('Konum').textContent).toContain('insurerId=old'),
  );
  expect(screen.getByLabelText('Konum').textContent).not.toContain('cursor=');
  expect(urls.at(-1)).toContain('search=PORT');
  fireEvent.click(screen.getByRole('button', { name: 'Sonraki sayfa' }));
  await waitFor(() => expect(screen.getByLabelText('Konum').textContent).toContain('cursor='));
  const before = screen.getByLabelText('Konum').textContent;
  fireEvent.click(await screen.findByRole('link', { name: 'PORT-1' }));
  fireEvent.click(await screen.findByRole('link', { name: '← Poliçe listesine dön' }));
  await screen.findByRole('link', { name: 'PORT-1' });
  expect(screen.getByLabelText('Konum').textContent).toBe(before);
});
it('uses Istanbul calendar shortcuts and retains insurer/status/search while resetting pagination', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-22T21:30:00Z'));
  stub();
  mount('/policies?insurerId=i&status=ACTIVE&search=PORT&cursor=old');
  await screen.findByRole('link', { name: 'PORT-1' });
  fireEvent.click(screen.getByRole('button', { name: '7 gün' }));
  await waitFor(() =>
    expect(screen.getByLabelText('Konum').textContent).toContain('endFrom=2026-10-23'),
  );
  const url = new URL('https://test.invalid' + screen.getByLabelText('Konum').textContent);
  expect(url.searchParams.get('endTo')).toBe('2026-10-29');
  expect(url.searchParams.get('insurerId')).toBe('i');
  expect(url.searchParams.get('cursor')).toBeNull();
  expect(url.searchParams.get('status')).toBe('ACTIVE');
  fireEvent.click(screen.getByRole('button', { name: 'Vadesi geçmiş' }));
  await waitFor(() =>
    expect(screen.getByLabelText('Konum').textContent).toContain('endTo=2026-10-22'),
  );
  expect(screen.getByRole('button', { name: 'Vadesi geçmiş' }).getAttribute('aria-pressed')).toBe(
    'true',
  );
});
it('keeps policy rows usable when the insurer catalogue fails and never invents a selected label', async () => {
  stub();
  const f = vi.mocked(fetch);
  f.mockImplementation(async (url) => {
    const u = String(url);
    urls.push(u);
    return u.startsWith('/api/catalogs/')
      ? response(null, 503)
      : response({ items: [row], hasMore: false, nextCursor: null });
  });
  mount('/policies?insurerId=hidden');
  await screen.findByRole('link', { name: 'PORT-1' });
  expect(await screen.findByText(/Sigortacı seçenekleri yüklenemedi/)).toBeTruthy();
  expect((screen.getByLabelText('Sigortacı') as unknown as HTMLSelectElement).value).toBe('hidden');
  fireEvent.click(screen.getByRole('button', { name: 'Gelişmiş filtreler' }));
  expect(screen.getByRole('option', { name: /Seçili sigortacı/ })).toBeTruthy();
});

it('anchors a shortcut to click time when the screen stays open across Istanbul midnight', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  vi.setSystemTime(new Date('2026-10-22T20:59:00Z'));
  stub();
  mount();
  await screen.findByRole('link', { name: 'PORT-1' });
  vi.setSystemTime(new Date('2026-10-22T21:01:00Z'));
  fireEvent.click(screen.getByRole('button', { name: 'Bugün' }));
  await waitFor(() =>
    expect(screen.getByLabelText('Konum').textContent).toContain('endFrom=2026-10-23'),
  );
});
