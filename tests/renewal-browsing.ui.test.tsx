// @vitest-environment jsdom
import { afterEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor, act } from '@testing-library/react';
import { MemoryRouter, Routes, Route, useNavigate } from 'react-router';
import RenewalListPage from '../src/app/pages/renewals/RenewalListPage';
import RenewalDetailPage from '../src/app/pages/renewals/RenewalDetailPage';
import type { RenewalBrowseDetail } from '../src/shared/renewal-browsing';
import { WorkNavigationProvider } from '../src/app/pages/today-work/work-navigation';
const children = vi.hoisted(() => ({ quotes: vi.fn(), interactions: vi.fn() }));
vi.mock('../src/app/pages/today-work/RenewalQuotesSection', () => ({
  RenewalQuotesSection: (props: unknown) => {
    children.quotes(props);
    return <p>Şirket teklifleri alanı</p>;
  },
}));
vi.mock('../src/app/pages/today-work/RenewalInteractionsSection', () => ({
  RenewalInteractionsSection: (props: unknown) => {
    children.interactions(props);
    return <p>Görüşmeler alanı</p>;
  },
}));
const item: RenewalBrowseDetail = {
  id: 'r1',
  state: 'CONTACT_PENDING',
  version: 3,
  closedAt: null,
  isOpen: true,
  parentArchived: false,
  customer: { id: 'c1', displayName: 'Örnek Müşteri' },
  policy: {
    id: 'p1',
    number: 'POL-001',
    startDate: '2026-01-01',
    endDate: '2026-12-31',
    insurerName: 'Anadolu Sigorta',
    branchName: 'Kasko',
    grossPremiumMinor: 123456,
    currency: 'TRY',
    status: 'ACTIVE',
  },
  phone: null,
  email: null,
  referenceName: 'Abdurrahman',
  insurerCustomerNumber: '000123',
  vehicle: {
    vehicleId: 'v1',
    vehicleVersion: 1,
    details: {
      plate: null,
      brand: 'Ford',
      model: 'Transit',
      modelYear: 2024,
      vin: null,
      engineNumber: '000345',
      registrationSerial: null,
    },
  },
};
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ success: status < 400, data }), { status });
function HistoryBack() {
  const navigate = useNavigate();
  return <button onClick={() => void navigate(-1)}>Tarayıcı geri</button>;
}
function mount(url = '/renewals') {
  return render(
    <MemoryRouter initialEntries={[url]}>
      <WorkNavigationProvider>
        <HistoryBack />
        <Routes>
          <Route path="/renewals" element={<RenewalListPage />} />
          <Route path="/renewals/:renewalId" element={<RenewalDetailPage />} />
        </Routes>
      </WorkNavigationProvider>
    </MemoryRouter>,
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  children.quotes.mockClear();
  children.interactions.mockClear();
});
it('requests the server-filtered page, keeps cursor context and opens a Task-independent detail with its exact return URL', async () => {
  const fetcher = vi.fn(async (url: string) =>
    response(
      url.startsWith('/api/sales-cases?')
        ? { items: [] }
        : url.startsWith('/api/renewals?')
          ? { items: [item], nextCursor: 'bound-cursor' }
          : item,
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  mount('/renewals?view=ALL&q=Örnek');
  fireEvent.click(await screen.findByRole('button', { name: 'Sonraki yenilemeler' }));
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(
        ([url]) => url.includes('cursor=bound-cursor') && url.includes('view=ALL'),
      ),
    ).toBe(true),
  );
  fireEvent.click(await screen.findByRole('link', { name: 'Örnek Müşteri yenilemesini aç' }));
  await screen.findByRole('heading', { name: 'Örnek Müşteri' });
  expect(screen.getByText('000123')).toBeTruthy();
  expect(screen.getByText('000345')).toBeTruthy();
  expect(screen.getByRole('link', { name: '← Yenilemelere dön' }).getAttribute('href')).toContain(
    'cursor=bound-cursor',
  );
  expect(
    fetcher.mock.calls.every(
      ([url]) => url.startsWith('/api/renewals') || url.startsWith('/api/sales-cases?'),
    ),
  ).toBe(true);
  expect(children.quotes).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Kayıtlı teklif belgeleri ve önceki işlemler'));
  await waitFor(() => expect(children.quotes).toHaveBeenCalled());
  expect(children.quotes.mock.calls.at(-1)?.[0]).toMatchObject({
    renewalId: 'r1',
    renewalVersion: 3,
    renewalOpen: true,
  });
});
it('restores the exact renewal link after browser Back and after confirming draft departure', async () => {
  const fetcher = vi.fn(async (url: string) => {
    if (url.startsWith('/api/renewals?')) return response({ items: [item], nextCursor: null });
    if (url === '/api/renewals/r1') return response(item);
    return response({ items: [] });
  });
  vi.stubGlobal('fetch', fetcher);
  vi.stubGlobal('scrollY', 0);
  const scroll = vi.fn();
  vi.stubGlobal('scrollTo', scroll);
  const listUrl = '/renewals?view=ALL&q=Ornek&from=2026-01-01&cursor=bound-cursor';
  mount(listUrl);
  fireEvent.click(await screen.findByRole('link', { name: /^Örnek Müşteri$/ }));
  await screen.findByRole('heading', { name: 'Örnek Müşteri' });
  fireEvent.click(screen.getByRole('button', { name: 'Tarayıcı geri' }));
  const customer = await screen.findByRole('link', { name: /^Örnek Müşteri$/ });
  await waitFor(() => expect(document.activeElement).toBe(customer));
  screen.getByRole('region', { name: 'Görüntüleyebildiğiniz yenilemeler' }).scrollTop = 96;
  vi.stubGlobal('scrollY', 180);
  const open = () => screen.getByRole('link', { name: 'Örnek Müşteri yenilemesini aç' });
  fireEvent.click(open());
  await screen.findByRole('heading', { name: 'Örnek Müşteri' });
  const { onRiskChange } = children.interactions.mock.calls.at(-1)![0] as {
    onRiskChange: (state: 'draft') => void;
  };
  act(() => onRiskChange('draft'));
  const back = screen.getByRole('link', { name: '← Yenilemelere dön' });
  fireEvent.click(back);
  fireEvent.click(await screen.findByRole('button', { name: 'Bu ekranda kal' }));
  expect(screen.getByRole('heading', { name: 'Örnek Müşteri' })).toBeTruthy();
  fireEvent.click(back);
  vi.stubGlobal('scrollY', 0);
  fireEvent.click(await screen.findByRole('button', { name: 'Taslağı bırak ve ayrıl' }));
  await screen.findByRole('link', { name: 'Örnek Müşteri yenilemesini aç' });
  await waitFor(() => expect(document.activeElement).toBe(open()));
  expect(scroll).toHaveBeenCalledWith(0, 180);
  expect(screen.getByRole('region', { name: 'Görüntüleyebildiğiniz yenilemeler' }).scrollTop).toBe(
    96,
  );
  expect(
    fetcher.mock.calls.map(([url]) => url).filter((url) => url.startsWith('/api/renewals?')),
  ).toEqual(Array(3).fill('/api' + listUrl + '&limit=20'));
});
it('retries malformed list and detail responses without dropping filters, cursor or selected record', async () => {
  let listReads = 0;
  let detailReads = 0;
  const fetcher = vi.fn<(url: string, request?: RequestInit) => Promise<Response>>(async (url) => {
    if (url.startsWith('/api/renewals?')) {
      return response({
        items: [
          ++listReads === 1
            ? { ...item, customer: null }
            : { ...item, policy: { ...item.policy, endDate: '2026-02-31' } },
        ],
        nextCursor: null,
      });
    }
    if (url === '/api/renewals/r1') {
      return response(
        ++detailReads === 1
          ? { ...item, id: 'r2', customer: { id: 'c2', displayName: 'Başka müşteri' } }
          : item,
      );
    }
    return response({ items: [] });
  });
  vi.stubGlobal('fetch', fetcher);
  const listUrl = '/renewals?view=ALL&q=Ornek&from=2026-01-01&cursor=bound-cursor';
  mount(listUrl);
  const retryList = await screen.findByRole('button', { name: 'Yenilemeleri yeniden yükle' });
  expect(screen.queryByText('Seçtiğiniz filtrelere uygun yenileme bulunamadı.')).toBeNull();
  expect((screen.getByRole('searchbox') as HTMLInputElement).value).toBe('Ornek');
  fireEvent.click(retryList);
  await screen.findByText('Tarih kontrolü gerekiyor');
  fireEvent.click(screen.getByRole('link', { name: 'Örnek Müşteri yenilemesini aç' }));
  const retryDetail = await screen.findByRole('button', { name: 'Yenilemeyi yeniden yükle' });
  expect(screen.queryByText('Başka müşteri')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Poliçelendirme / takip' })).toBeNull();
  expect(screen.getByRole('link', { name: '← Yenilemelere dön' }).getAttribute('href')).toBe(
    listUrl,
  );
  fireEvent.click(retryDetail);
  await screen.findByRole('heading', { name: 'Örnek Müşteri' });
  expect(screen.getByText('000123')).toBeTruthy();
  const requests = fetcher.mock.calls.map(([url]) => url);
  const exactListRead = '/api' + listUrl + '&limit=20';
  expect(requests.filter((url) => url.startsWith('/api/renewals?'))).toEqual([
    exactListRead,
    exactListRead,
  ]);
  expect(requests.filter((url) => url.startsWith('/api/renewals/'))).toEqual([
    '/api/renewals/r1',
    '/api/renewals/r1',
  ]);
  expect(fetcher.mock.calls.every(([, request]) => !request?.method)).toBe(true);
});

it('applies filters only on submit and resets the old cursor', async () => {
  const fetcher = vi.fn(async (_url: string) => response({ items: [], nextCursor: null }));
  vi.stubGlobal('fetch', fetcher);
  mount('/renewals?cursor=old');
  await screen.findByText(/Bu sayfada 0 yenileme/);
  fireEvent.change(screen.getByRole('searchbox', { name: 'Müşteri veya poliçe no' }), {
    target: { value: 'Yeni müşteri' },
  });
  expect(fetcher).toHaveBeenCalledTimes(1);
  fireEvent.change(screen.getByRole('combobox', { name: 'Yenileme durumu' }), {
    target: { value: 'CLOSED' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Ara' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(fetcher.mock.calls.at(-1)?.[0]).toContain('view=CLOSED');
  expect(fetcher.mock.calls.at(-1)?.[0]).not.toContain('cursor=old');
});
it.each([false, true])('shows a reversed range locally (opened from URL: %s)', async (direct) => {
  const fetcher = vi.fn(async (_url: string) => response({ items: [], nextCursor: null }));
  vi.stubGlobal('fetch', fetcher);
  mount(direct ? '/renewals?from=2026-12-01&to=2026-11-01' : '/renewals');
  if (!direct) {
    await screen.findByText(/Bu sayfada 0 yenileme/);
    fireEvent.click(screen.getByText('Tarih aralığı'));
    const start = screen.getByLabelText('Poliçe bitişi — başlangıç');
    fireEvent.change(start, { target: { value: '2026-12-01' } });
    fireEvent.change(screen.getByLabelText('Poliçe bitişi — son'), {
      target: { value: '2026-11-01' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Ara' }));
    expect(document.activeElement).toBe(start);
  }
  expect(screen.getByRole('alert').textContent).toContain(
    'Başlangıç tarihi bitiş tarihinden sonra olamaz',
  );
  expect(fetcher).toHaveBeenCalledTimes(direct ? 0 : 1);
});
it('keeps closed renewals read-only while showing their company quotes and policy vehicle snapshot', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      response(
        url.startsWith('/api/sales-cases?')
          ? { items: [] }
          : { ...item, state: 'VOIDED', isOpen: false, closedAt: '2026-11-13T10:00:00.000Z' },
      ),
    ),
  );
  mount('/renewals/r1');
  await screen.findByRole('heading', { name: 'Örnek Müşteri' });
  expect(screen.getByText('Geçersiz')).toBeTruthy();
  expect(children.quotes).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('Kayıtlı teklif belgeleri ve önceki işlemler'));
  await waitFor(() => expect(children.quotes).toHaveBeenCalled());
  expect(children.quotes.mock.calls.at(-1)?.[0]).toMatchObject({ renewalOpen: false });
  expect(children.interactions.mock.calls.at(-1)?.[0]).toMatchObject({ readOnly: true });
  expect(screen.queryByRole('link', { name: /görev/i })).toBeNull();
});
it('does not fetch operational children for archived parents or invent a private Task', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response({ ...item, parentArchived: true, isOpen: false })),
  );
  mount('/renewals/r1');
  await screen.findByRole('heading', { name: 'Örnek Müşteri' });
  expect(children.quotes).not.toHaveBeenCalled();
  expect(children.interactions).not.toHaveBeenCalled();
  expect(
    screen.getByText(/Arşivlenmiş veya işlem için kapalı müşteri\/poliçenin yenileme özeti/),
  ).toBeTruthy();
});
it('clears inaccessible details and handles a late401 without ending a newer route session', async () => {
  let release!: (r: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => pending),
  );
  const ended = vi.fn();
  document.addEventListener('mayi-session-ended', ended);
  try {
    const page = mount('/renewals/r1');
    page.unmount();
    await act(async () => release(response(null, 401)));
    expect(ended).not.toHaveBeenCalled();
  } finally {
    document.removeEventListener('mayi-session-ended', ended);
  }
  cleanup();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response(null, 404)),
  );
  mount('/renewals/missing');
  await screen.findByRole('alert');
  expect(screen.queryByRole('heading', { name: 'Örnek Müşteri' })).toBeNull();
  expect(children.quotes).not.toHaveBeenCalled();
});

it('opens operation context only on demand and does not fabricate task access from a readable renewal', async () => {
  const fetcher = vi.fn(async (url: string) =>
    url.endsWith('/operation-context') ? response(null, 404) : response(item),
  );
  vi.stubGlobal('fetch', fetcher);
  mount('/renewals/r1');
  await screen.findByRole('heading', { name: item.customer.displayName });
  expect(fetcher.mock.calls.some(([url]) => url.endsWith('/operation-context'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Poliçelendirme / takip' }));
  await screen.findByText(/ilgili takip için işlem erişimi doğrulanamadı/);
  expect(screen.queryByRole('button', { name: 'Poliçelendir' })).toBeNull();
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/operation-context'))).toHaveLength(1);
});
