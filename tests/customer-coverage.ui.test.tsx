// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Link, MemoryRouter, Routes, Route } from 'react-router';
import CustomerListPage from '../src/app/pages/customers/CustomerListPage';
import CustomerProfilePage from '../src/app/pages/customers/CustomerProfilePage';
import { AuthenticatedApp } from '../src/app/AuthenticatedApp';
import {
  WorkNavigationProvider,
  useWorkNavigation,
} from '../src/app/pages/today-work/work-navigation';
import type { CustomerCoverageSummary } from '../src/shared/customer-coverage';
import { customerDetailFixture } from './support/customer-detail-fixture';
const policy = {
  policyId: 'p-1',
  policyNumber: 'SENTETIK-1',
  branchName: 'Kasko',
  productName: 'Kasko Ürünü',
  insurerName: 'Sentetik Sigorta',
  startDate: '2026-01-01',
  endDate: '2099-01-01',
};
const coverage: CustomerCoverageSummary = {
  available: true,
  asOfDate: '2026-10-20',
  timezone: 'Europe/Istanbul',
  activePolicyCount: 25,
  expiredPolicyCount: 2,
  scheduledPolicyCount: 1,
  cancelledPolicyCount: 1,
  voidedPolicyCount: 1,
  archivedPolicyCount: 1,
  invalidPeriodPolicyCount: 0,
  types: [
    { label: 'Kasko', count: 23 },
    { label: 'Konut', count: 1 },
    { label: 'Trafik', count: 1 },
  ],
  additionalTypeCount: 1,
  nearestExpiry: policy,
  policies: [policy],
};
const customer = customerDetailFixture('a', { coverage });
const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ success: status < 400, data }), { status });
const emptyRelated = { items: [], nextCursor: null, hasMore: false };
function profileFixture(url: string) {
  return url.includes('/renewals') || url.startsWith('/api/policies?')
    ? emptyRelated
    : { ...customer, id: url.split('/').at(-1) };
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('shows compact real types and exact count in a customer row without per-row policy reads', async () => {
  const fetcher = vi.fn(async () => reply({ items: [customer], nextCursor: null, hasMore: false }));
  vi.stubGlobal('fetch', fetcher);
  render(
    <MemoryRouter>
      <CustomerListPage />
    </MemoryRouter>,
  );
  const row = (await screen.findByRole('link', { name: 'Sentetik müşteri' })).closest('tr')!;
  expect(within(row).getByText('25 yürürlükte poliçe')).toBeTruthy();
  expect(within(row).getByText('Kasko')).toBeTruthy();
  expect(within(row).getByText('+1')).toBeTruthy();
  expect(fetcher.mock.calls).toHaveLength(1);
});
it('shows linked named policies in the profile policy section', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => reply(url.endsWith('/coverage') ? coverage : profileFixture(url))),
  );
  render(
    <MemoryRouter initialEntries={['/customers/a']}>
      <Routes>
        <Route path="/customers/:customerId" element={<CustomerProfilePage />} />
      </Routes>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('link', { name: 'Poliçeler ve yenilemeler' }));
  const summary = await screen.findByRole('region', { name: 'Sigorta özeti' });
  expect(await within(summary).findByText('25 yürürlükte poliçe')).toBeTruthy();
  expect(
    within(summary)
      .getByRole('link', { name: /Kasko Ürünü.*Sentetik Sigorta.*SENTETIK-1/ })
      .getAttribute('href'),
  ).toBe('/policies/p-1');
  expect(within(summary).getByText(/Süresi dolmuş: 2/)).toBeTruthy();
});
function SeedReturnContext() {
  const store = useWorkNavigation();
  store?.entries.set('context', {
    taskId: 'task-a',
    queue: 'WORK',
    pageUrls: [],
    pageScroll: 0,
    queueScroll: 0,
    sections: {},
  });
  return null;
}
it.each([false, true])(
  'distinguishes unavailable policy authority from an authorized empty portfolio (%s)',
  async (available) => {
    const value = {
      ...coverage,
      available,
      activePolicyCount: available ? 0 : null,
      types: [],
      policies: [],
      nearestExpiry: null,
      additionalTypeCount: 0,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => reply(url.endsWith('/coverage') ? value : profileFixture(url))),
    );
    render(
      <MemoryRouter initialEntries={['/customers/a?section=policies']}>
        <Routes>
          <Route path="/customers/:customerId" element={<CustomerProfilePage />} />
        </Routes>
      </MemoryRouter>,
    );
    const summary = await screen.findByRole('region', { name: 'Sigorta özeti' });
    if (available) expect(await within(summary).findByText('0 yürürlükte poliçe')).toBeTruthy();
    else {
      expect(
        await within(summary).findByText('Poliçe bilgisi için görüntüleme yetkisi gerekli.'),
      ).toBeTruthy();
      expect(within(summary).queryByText('0 yürürlükte poliçe')).toBeNull();
    }
  },
);
it('does not label a failed summary as zero coverage and retries only its read', async () => {
  let calls = 0;
  const fetcher = vi.fn(async (url: string) =>
    url.endsWith('/coverage')
      ? ++calls === 1
        ? reply(null, 503)
        : reply(coverage)
      : reply(profileFixture(url)),
  );
  vi.stubGlobal('fetch', fetcher);
  render(
    <MemoryRouter initialEntries={['/customers/a?section=policies']}>
      <Routes>
        <Route path="/customers/:customerId" element={<CustomerProfilePage />} />
      </Routes>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Poliçe özetini yeniden dene' }));
  await screen.findByText('25 yürürlükte poliçe');
  expect(calls).toBe(2);
});
it('never renders a late coverage summary for a previously selected customer', async () => {
  let release!: (response: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url === '/api/customers/a/coverage'
        ? pending
        : reply(
            url.endsWith('/coverage') ? { ...coverage, activePolicyCount: 1 } : profileFixture(url),
          ),
    ),
  );
  render(
    <MemoryRouter initialEntries={['/customers/a?section=policies']}>
      <Link to="/customers/b?section=policies">Müşteri B</Link>
      <Routes>
        <Route path="/customers/:customerId" element={<CustomerProfilePage />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByText('Poliçe özeti yükleniyor…');
  fireEvent.click(screen.getByRole('link', { name: 'Müşteri B' }));
  await screen.findByText('1 yürürlükte poliçe');
  await act(async () => {
    release(reply({ ...coverage, activePolicyCount: 99 }));
  });
  expect(screen.queryByText('99 yürürlükte poliçe')).toBeNull();
});
it('keeps the Phase1 Task return through complete related policy pagination', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      reply(
        url.includes('/api/policies?')
          ? {
              items: [
                { ...policy, id: 'p-1', customerId: 'a', status: 'ACTIVE', archivedAt: null },
              ],
              hasMore: true,
              nextCursor: 'next',
            }
          : url.includes('/renewals')
            ? { items: [], nextCursor: null }
            : url.endsWith('/coverage')
              ? coverage
              : customer,
      ),
    ),
  );
  render(
    <MemoryRouter
      initialEntries={[
        { pathname: '/customers/a', search: '?section=policies', state: { workReturn: 'context' } },
      ]}
    >
      <WorkNavigationProvider>
        <SeedReturnContext />
        <Routes>
          <Route path="/customers/:customerId" element={<CustomerProfilePage />} />
        </Routes>
      </WorkNavigationProvider>
    </MemoryRouter>,
  );
  expect(
    (await screen.findByRole('link', { name: 'Seçili takibe dön' })).getAttribute('href'),
  ).toContain('task=task-a');
  fireEvent.click(await screen.findByRole('button', { name: 'Sonraki poliçeler' }));
  expect(
    (await screen.findByRole('link', { name: 'Seçili takibe dön' })).getAttribute('href'),
  ).toContain('task=task-a');
});
it('contains malformed successful reads in each section and retries the exact page independently', async () => {
  let broken = true;
  const related = {
    ...policy,
    id: 'related-policy',
    customerId: 'a',
    policyNumber: 'RELATED-1',
    endDate: '2026-02-31',
    status: 'ACTIVE',
    archivedAt: null,
  };
  const renewal = {
    id: 'r-1',
    policyNumber: 'RENEWAL-1',
    policyEndDate: '2026-11-30',
    state: 'WON',
  };
  const fetcher = vi.fn<(url: string, request?: RequestInit) => Promise<Response>>(async (url) => {
    if (url.startsWith('/api/policies?'))
      return reply({
        items: [broken ? { ...related, customerId: 'other' } : related],
        hasMore: true,
        nextCursor: 'policy-next',
      });
    if (url.includes('/renewals'))
      return reply({ items: broken ? null : [renewal], nextCursor: null });
    if (url.endsWith('/coverage'))
      return reply(broken ? { ...coverage, policies: [null] } : coverage);
    return reply(customer);
  });
  vi.stubGlobal('fetch', fetcher);
  render(
    <MemoryRouter
      initialEntries={[
        '/customers/a?section=policies&after=policy-page&renewalsAfter=renewal-page',
      ]}
    >
      <Routes>
        <Route path="/customers/:customerId" element={<CustomerProfilePage />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { name: 'Sentetik müşteri' });
  const policyRetry = await screen.findByRole('button', { name: 'Poliçeleri yeniden dene' });
  const renewalsRetry = await screen.findByRole('button', { name: 'Yenilemeleri yeniden dene' });
  const coverageRetry = await screen.findByRole('button', { name: 'Poliçe özetini yeniden dene' });
  expect(screen.queryByRole('link', { name: 'RELATED-1' })).toBeNull();
  expect(screen.queryByText('Görüntülenebilir yenileme bulunamadı.')).toBeNull();

  broken = false;
  fireEvent.click(policyRetry);
  await screen.findByRole('link', { name: 'RELATED-1' });
  expect(screen.getByText(/Tarih kontrolü gerekiyor/)).toBeTruthy();
  expect(fetcher.mock.calls.filter(([url]) => url.includes('/renewals'))).toHaveLength(1);
  fireEvent.click(renewalsRetry);
  await screen.findByRole('link', { name: 'RENEWAL-1' });
  fireEvent.click(coverageRetry);
  await screen.findByText('25 yürürlükte poliçe');
  const reads = fetcher.mock.calls.map(([url]) => url);
  expect(reads.filter((url) => url.startsWith('/api/policies?'))).toEqual([
    '/api/policies?customerId=a&pageSize=20&includeLabels=true&cursor=policy-page',
    '/api/policies?customerId=a&pageSize=20&includeLabels=true&cursor=policy-page',
  ]);
  expect(reads.filter((url) => url.includes('/renewals'))).toEqual([
    '/api/customers/a/renewals?cursor=renewal-page',
    '/api/customers/a/renewals?cursor=renewal-page',
  ]);
  expect(reads.filter((url) => url.endsWith('/coverage'))).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Sonraki poliçeler' }));
  await screen.findByRole('link', { name: 'RELATED-1' });
  expect(screen.getByRole('link', { name: 'RENEWAL-1' })).toBeTruthy();
  expect(fetcher.mock.calls.filter(([url]) => url.includes('/renewals'))).toHaveLength(2);
  expect(fetcher.mock.calls.every(([, request]) => !request?.method)).toBe(true);
});
it('restores private search, customer filter and cursor after returning from a profile in the same SPA session', async () => {
  const fetcher = vi.fn(async (url: string) =>
    reply(
      url.includes('/api/customers?')
        ? { items: [customer], nextCursor: 'second', hasMore: true }
        : url.endsWith('/coverage')
          ? coverage
          : customer,
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  render(
    <MemoryRouter initialEntries={['/customers']}>
      <AuthenticatedApp
        session={{ state: 'NORMAL', email: 'synthetic@demo.invalid', isOwner: false }}
        busy={false}
        onLogout={() => {}}
        onReauth={() => {}}
        renderPassword={() => null}
        error=""
        reauth={null}
      />
    </MemoryRouter>,
  );
  fireEvent.change(await screen.findByLabelText('Müşteri ara'), {
    target: { value: 'sentetik@example.invalid' },
  });
  fireEvent.change(screen.getByLabelText('Müşteri türü'), { target: { value: 'INDIVIDUAL' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ara' }));
  await screen.findByRole('link', { name: 'Sentetik müşteri' });
  fireEvent.click(screen.getByRole('button', { name: 'Sonraki sayfa' }));
  await screen.findByText('Sayfa 2 · Her sayfada en fazla 20 kayıt');
  fireEvent.click(await screen.findByRole('link', { name: 'Sentetik müşteri' }));
  await screen.findByRole('heading', { name: 'Sentetik müşteri' });
  fireEvent.click(screen.getByRole('link', { name: 'Müşteri listesine dön' }));
  expect(((await screen.findByLabelText('Müşteri ara')) as HTMLInputElement).value).toBe(
    'sentetik@example.invalid',
  );
  expect((screen.getByLabelText('Müşteri türü') as unknown as HTMLSelectElement).value).toBe(
    'INDIVIDUAL',
  );
  await screen.findByText('Sayfa 2 · Her sayfada en fazla 20 kayıt');
  expect(
    fetcher.mock.calls.filter(([url]) => url.includes('/api/customers?')).at(-1)?.[0],
  ).toContain('cursor=second');
});
