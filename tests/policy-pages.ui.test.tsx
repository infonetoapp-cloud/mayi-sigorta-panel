import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import PolicyListPage from '../src/app/pages/policies/PolicyListPage';
import PolicyDetailPage from '../src/app/pages/policies/PolicyDetailPage';
import PolicyLegacyPage from '../src/app/pages/policies/PolicyLegacyPage';
import CustomerProfilePage from '../src/app/pages/customers/CustomerProfilePage';
import { Sidebar } from '../src/app/components/layout/Sidebar';
const policy = (id = 'a') => ({
  id,
  policyNumber: `POL-${id}`,
  customerId: 'customer',
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  grossPremiumMinor: 123456,
  currency: 'TRY',
  status: 'ACTIVE',
  archivedAt: null,
  installmentCount: 3,
  customer: { id: 'customer', displayName: 'Yetkili Müşteri' },
  insurer: { name: 'Sigorta Şirketi' },
  product: { name: 'Ürün' },
  branch: { name: 'Branş' },
  paymentMethod: { name: 'Kart' },
  identityValue: 'PROTECTED-IDENTITY',
  healthData: 'PROTECTED-HEALTH',
  assigneeMembershipId: 'PROTECTED-PERSONNEL',
});
const response = (data: unknown, status = 200) =>
  new Response(
    JSON.stringify({
      success: status < 400,
      data,
      ...(status >= 400 ? { error: { message: 'unsafe SQL diagnostic' } } : {}),
    }),
    { status },
  );
it('does not reopen an archived policy when an earlier assignment readback arrives late on the same page', async () => {
  let live: Omit<ReturnType<typeof policy>, 'archivedAt'> & {
    version: number;
    archivedAt: string | null;
  } = { ...policy(), version: 3, assigneeMembershipId: 'm1' };
  let resolveOld!: (r: Response) => void;
  const oldRead = new Promise<Response>((resolve) => {
    resolveOld = resolve;
  });
  let assignmentWritten = false,
    held = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.endsWith('csrf-token')) return response({ token: 'csrf' });
      if (url.endsWith('/assignment-options'))
        return response([
          { membershipId: 'm1', label: 'Sorumlu Bir', membershipType: 'OWNER' },
          { membershipId: 'm2', label: 'Sorumlu İki', membershipType: 'MEMBER' },
        ]);
      if (init?.method === 'POST') {
        const body = JSON.parse(String(init.body));
        if (body.expectedVersion !== live.version) return response(null, 409);
        if (url.endsWith('/assign')) {
          live = { ...live, version: 4, assigneeMembershipId: 'm2' };
          assignmentWritten = true;
          return response(live);
        }
        live = { ...live, version: 5, archivedAt: '2026-10-18T00:00:00Z' };
        return response(live);
      }
      if (url === '/api/policies/a') {
        if (assignmentWritten && !held) {
          held = true;
          return oldRead;
        }
        return response(live);
      }
      return response([]);
    }),
  );
  mount('/policies/a?section=management');
  fireEvent.click(await screen.findByRole('button', { name: 'Sorumluyu değiştir' }));
  fireEvent.change(screen.getByLabelText('Yeni poliçe sorumlusu'), { target: { value: 'm2' } });
  fireEvent.click(screen.getByLabelText('Sorumlu değişikliğini onaylıyorum'));
  fireEvent.click(screen.getByRole('button', { name: 'Poliçeyi arşivle' }));
  fireEvent.change(screen.getByLabelText('Arşiv nedeni'), {
    target: { value: 'HISTORICAL_RECORD' },
  });
  fireEvent.click(screen.getByLabelText('Bu poliçeyi arşivlemek istediğimi onaylıyorum'));
  fireEvent.click(screen.getByRole('button', { name: 'Atamayı kaydet' }));
  await waitFor(() => expect(held).toBe(true));
  const earlier = { ...live };
  fireEvent.click(screen.getByRole('button', { name: 'Arşivlemeyi onayla' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Güncel poliçeyi karşılaştır' }));
  await screen.findByText('Karşılaştırılan poliçe sürümü: 4');
  await waitFor(() =>
    expect(
      (screen.getByLabelText('Bu poliçeyi arşivlemek istediğimi onaylıyorum') as HTMLInputElement)
        .checked,
    ).toBe(false),
  );
  fireEvent.click(screen.getByLabelText('Bu poliçeyi arşivlemek istediğimi onaylıyorum'));
  fireEvent.click(screen.getByRole('button', { name: 'Karşılaştırdım, arşivlemeyi onayla' }));
  await screen.findByText('Poliçe arşivlendi.');
  await act(async () => resolveOld(response(earlier)));
  await screen.findByText('Poliçe sorumlusu güncellendi.');
  expect(screen.queryByRole('link', { name: 'Poliçeyi düzenle' })).toBeNull();
  fireEvent.click(screen.getByRole('link', { name: 'Zeyiller' }));
  await screen.findByText('Bu bölümde kayıt bulunmuyor.');
  expect(screen.queryByRole('button', { name: 'Zeyil ekle' })).toBeNull();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function mount(path = '/policies') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Link to="/policies/b">Diğer poliçe</Link>
      <Routes>
        <Route path="/policies" element={<PolicyListPage />} />
        <Route path="/policies/:policyId" element={<PolicyDetailPage />} />
        <Route path="/policies/legacy" element={<PolicyLegacyPage />} />
        <Route path="/customers/:customerId" element={<CustomerProfilePage />} />
      </Routes>
    </MemoryRouter>,
  );
}
it.each(['/policies/a', '/policies/legacy'])('keeps the policy sidebar active at %s', (path) => {
  render(
    <MemoryRouter initialEntries={[path]}>
      <Sidebar
        owner
        collapsed={false}
        mobileOpen={false}
        onCollapse={() => {}}
        onClose={() => {}}
        sidebarRef={{ current: null }}
      />
    </MemoryRouter>,
  );
  expect(screen.getByRole('link', { name: 'Poliçeler' }).getAttribute('aria-current')).toBe('page');
});
it('requests strict pageSize and default end-date order; renders only list DTO fields with exact minor money', async () => {
  const fetcher = vi.fn(async (_url: string) =>
    response({
      items: [
        policy(),
        {
          ...policy('big'),
          grossPremiumMinor: Number.MAX_SAFE_INTEGER,
          archivedAt: '2026-02-01',
          status: 'CANCELLED',
        },
      ],
      hasMore: false,
      nextCursor: null,
    }),
  );
  vi.stubGlobal('fetch', fetcher);
  mount();
  await screen.findByRole('link', { name: 'POL-a' });
  expect(fetcher.mock.calls[0]![0]).toContain('pageSize=20');
  expect(fetcher.mock.calls[0]![0]).toContain('sort=end_date_asc');
  expect(screen.getByText('1.234,56 ₺')).toBeTruthy();
  expect(screen.getByText('90.071.992.547.409,91 ₺')).toBeTruthy();
  expect(within(screen.getByRole('row', { name: /POL-big/ })).getByText('İptal')).toBeTruthy();
  expect(screen.getByText('Arşivlenmiş')).toBeTruthy();
  expect(screen.queryByText('Sigorta Şirketi')).toBeNull();
  expect(screen.queryByText('Yetkili Müşteri')).toBeNull();
  expect(document.body.textContent).not.toContain('PROTECTED-');
  expect(screen.getByRole('link', { name: 'POL-a' }).getAttribute('href')).toBe('/policies/a');
});
it('retries the exact failed cursor and resets it when applying search/status/date/sort filters', async () => {
  const urls: string[] = [];
  let next = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.startsWith('/api/policies')) urls.push(url);
      if (url.includes('cursor='))
        return ++next === 1
          ? response(null, 503)
          : response({ items: [policy('next')], hasMore: false, nextCursor: null });
      return response({ items: [policy()], hasMore: true, nextCursor: 'opaque+cursor=' });
    }),
  );
  mount();
  await screen.findByText('POL-a');
  fireEvent.click(screen.getByRole('button', { name: 'Sonraki sayfa' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Yeniden dene' }));
  await screen.findByText('POL-next');
  expect(urls[1]).toBe(urls[2]);
  expect(screen.queryByText('POL-a')).toBeNull();
  fireEvent.change(screen.getByLabelText('Poliçe numarası'), { target: { value: 'ABC' } });
  fireEvent.change(screen.getByLabelText('Eşleştirme'), { target: { value: 'prefix' } });
  fireEvent.change(screen.getByLabelText('Poliçe durumu'), { target: { value: 'VOIDED' } });
  fireEvent.change(screen.getByLabelText('Bitiş başlangıcı'), { target: { value: '2026-01-01' } });
  fireEvent.change(screen.getByLabelText('Bitiş sonu'), { target: { value: '2026-12-31' } });
  fireEvent.change(screen.getByLabelText('Sıralama'), { target: { value: 'end_date_desc' } });
  fireEvent.click(screen.getByRole('button', { name: 'Filtrele' }));
  await screen.findByText('POL-a');
  const last = urls.at(-1)!;
  expect(last).toContain('search=ABC');
  expect(last).toContain('searchMode=prefix');
  expect(last).toContain('status=VOIDED');
  expect(last).toContain('endFrom=2026-01-01');
  expect(last).not.toContain('cursor=');
});
it('shows full authorized historical detail without identity/health/personnel data or document viewer', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      response({
        ...policy(),
        archivedAt: '2026-02-01',
        status: 'VOIDED',
        archiveReason: 'Tarihsel kayıt',
      }),
    ),
  );
  mount('/policies/a');
  await screen.findByRole('heading', { name: 'POL-a' });
  for (const text of ['Sigorta Şirketi', 'Ürün', 'Branş', 'Kart', '1.234,56 ₺'])
    expect(screen.getByText(text, { selector: 'dd' })).toBeTruthy();
  expect(screen.getByText('Geçersiz')).toBeTruthy();
  expect(screen.getByText('Arşivlenmiş')).toBeTruthy();
  expect(screen.getByText(/Tarihsel kayıt/)).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Yetkili Müşteri' }).getAttribute('href')).toBe(
    '/customers/customer',
  );
  expect(screen.queryByRole('link', { name: 'Aynı numarayla farklı sözleşme kaydet' })).toBeNull();
  expect(document.body.textContent).not.toContain('PROTECTED-');
  expect(screen.getByRole('link', { name: 'Belgeler' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Belge yükle' })).toBeNull();
});
it('loads read-only related sections on demand and formats negative endorsement minor amounts exactly', async () => {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url.startsWith('/api/policies')) urls.push(url);
      return response(
        url.endsWith('/parties')
          ? [
              {
                id: 'party',
                customerDisplayName: 'Sigortalı Adı',
                role: 'INSURED',
                status: 'INACTIVE',
                identityValue: 'PROTECTED-IDENTITY',
              },
            ]
          : url.endsWith('/amendments')
            ? [
                {
                  id: 'amend',
                  externalReference: 'ZEYL-1',
                  effectiveDate: '2026-05-01',
                  description: 'Tarihsel zeyil',
                  premiumDifferenceMinor: -50,
                  currency: 'TRY',
                },
              ]
            : url.endsWith('/external-references')
              ? [{ id: 'ref', sourceNamespace: 'Kaynak', externalKey: 'REF-1' }]
              : policy(),
      );
    }),
  );
  mount('/policies/a');
  await screen.findByRole('heading', { name: 'POL-a' });
  expect(urls).toEqual(['/api/policies/a']);
  fireEvent.click(screen.getByRole('link', { name: 'Sigortalılar ve lehtarlar' }));
  await screen.findByText('Sigortalı Adı');
  expect(screen.getByText('Sigortalı · Pasif')).toBeTruthy();
  fireEvent.click(screen.getByRole('link', { name: 'Zeyiller' }));
  await screen.findByText('-0,50 ₺');
  fireEvent.click(screen.getByRole('link', { name: 'Dış referanslar' }));
  await screen.findByText('REF-1');
  expect(document.body.textContent).not.toContain('PROTECTED-');
});
it('suppresses late detail data after rapid policy switching and hides the old page immediately', async () => {
  let release!: (r: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      url.endsWith('/a')
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : Promise.resolve(response(policy('b'))),
    ),
  );
  mount('/policies/a');
  fireEvent.click(screen.getByRole('link', { name: 'Diğer poliçe' }));
  await screen.findByRole('heading', { name: 'POL-b' });
  await act(async () => release(response(policy())));
  expect(screen.queryByText('POL-a')).toBeNull();
});
it.each([200, 401])(
  'suppresses a late related response/status %i when the loaded policy is replaced',
  async (status) => {
    let release!: (r: Response) => void;
    const ended = vi.fn();
    document.addEventListener('mayi-session-ended', ended);
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn((url: string) =>
          url.endsWith('/a/parties')
            ? new Promise<Response>((resolve) => {
                release = resolve;
              })
            : Promise.resolve(response(policy(url.endsWith('/b') ? 'b' : 'a'))),
        ),
      );
      mount('/policies/a');
      await screen.findByRole('heading', { name: 'POL-a' });
      fireEvent.click(screen.getByRole('link', { name: 'Sigortalılar ve lehtarlar' }));
      fireEvent.click(screen.getByRole('link', { name: 'Diğer poliçe' }));
      expect(screen.queryByRole('heading', { name: 'POL-a' })).toBeNull();
      await screen.findByRole('heading', { name: 'POL-b' });
      await act(async () =>
        release(
          response(
            [
              {
                id: 'stale',
                customerDisplayName: 'Eski Sigortalı',
                role: 'INSURED',
                status: 'ACTIVE',
              },
            ],
            status,
          ),
        ),
      );
      expect(screen.queryByText('Eski Sigortalı')).toBeNull();
      expect(ended).not.toHaveBeenCalled();
    } finally {
      document.removeEventListener('mayi-session-ended', ended);
    }
  },
);
it('shows an empty collection and rejects inverted dates without issuing another query', async () => {
  const fetcher = vi.fn(async (_url: string) =>
    response({ items: [], hasMore: false, nextCursor: null }),
  );
  vi.stubGlobal('fetch', fetcher);
  mount();
  await screen.findByRole('heading', { name: 'Poliçe bulunamadı' });
  fireEvent.change(screen.getByLabelText('Bitiş başlangıcı'), { target: { value: '2026-12-31' } });
  fireEvent.change(screen.getByLabelText('Bitiş sonu'), { target: { value: '2026-01-01' } });
  fireEvent.click(screen.getByRole('button', { name: 'Filtrele' }));
  await screen.findByRole('alert');
  expect(
    fetcher.mock.calls.filter(([url]) => String(url).startsWith('/api/policies')),
  ).toHaveLength(1);
  expect(screen.getByRole('button', { name: 'Sonraki sayfa' }).hasAttribute('disabled')).toBe(true);
});
it.each([401, 403, 404])(
  'cleans protected detail content for denied status %i without raw diagnostics',
  async (status) => {
    const ended = vi.fn();
    document.addEventListener('mayi-session-ended', ended);
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => response(null, status)),
      );
      mount('/policies/a');
      await screen.findByRole('alert');
      expect(document.body.textContent).not.toContain('unsafe SQL');
      expect(screen.queryByText('Yetkili Müşteri')).toBeNull();
      expect(ended).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    } finally {
      document.removeEventListener('mayi-session-ended', ended);
    }
  },
);
it('keeps the authorized originating customer selected even outside the legacy first customer page', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      response(
        url === '/api/customers/origin'
          ? { id: 'origin', displayName: 'Kaynak Müşteri', archivedAt: null }
          : url === '/api/catalogs/selectable'
            ? { insurers: [], branches: [], products: [], paymentMethods: [], lossReasons: [] }
            : url.startsWith('/api/customers?')
              ? { items: [{ id: 'other', displayName: 'Diğer Müşteri' }] }
              : { items: [], hasMore: false, nextCursor: null },
      ),
    ),
  );
  mount('/policies/legacy?customerId=origin');
  await screen.findByRole('option', { name: 'Diğer Müşteri' });
  expect((screen.getByLabelText('Müşteri') as unknown as HTMLSelectElement).value).toBe('origin');
});
it('does not mount legacy mutation forms when the customer handoff is denied', async () => {
  const fetcher = vi.fn(async () => response(null, 403));
  vi.stubGlobal('fetch', fetcher);
  mount('/policies/legacy?customerId=foreign');
  await screen.findByRole('alert');
  expect(screen.queryByLabelText('Müşteri')).toBeNull();
  expect(fetcher.mock.calls).toHaveLength(1);
});
it('uses pageSize=20 for customer-profile policies and links each entry to modern policy detail', async () => {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url);
      return response(
        url.includes('/api/policies?')
          ? { items: [policy()], hasMore: false, nextCursor: null }
          : url.includes('/renewals')
            ? { items: [], nextCursor: null }
            : {
                id: 'customer',
                displayName: 'Yetkili Müşteri',
                type: 'INDIVIDUAL',
                createdAt: '2026-01-01',
                archivedAt: null,
              },
      );
    }),
  );
  mount('/customers/customer?section=policies');
  expect((await screen.findByRole('link', { name: 'POL-a' })).getAttribute('href')).toBe(
    '/policies/a',
  );
  const url = urls.find((url) => url.startsWith('/api/policies?'))!;
  expect(url).toContain('pageSize=20');
  expect(url).not.toContain('limit=');
});
