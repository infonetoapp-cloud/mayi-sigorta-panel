import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RenewalQuotesSection } from '../src/app/pages/today-work/RenewalQuotesSection';
import { quoteDraft, quotePayload } from '../src/app/pages/today-work/quote-model';
import { installQuotePopBoundary } from '../src/app/pages/today-work/quote-navigation';
import type {
  QuoteHistory,
  QuoteRecord,
  QuoteVersion,
} from '../src/app/pages/today-work/quote-model';
import { invalidateCsrfToken } from '../src/app/csrf';
import type {
  SelectableCatalogsDto,
  TodayTaskDto,
  TodayTasksResponseData,
} from '../src/shared/types';
import { MemoryRouter } from 'react-router';
import TodayWorkPage from '../src/app/pages/today-work/TodayWorkPage';
import type { VersionPayload } from '../src/app/components/RenewalQuoteForm';
const defaults: VersionPayload = {
  insurerId: 'i',
  productId: 'p',
  branchId: 'b',
  paymentMethodId: 'm',
  startDate: '2027-01-01',
  endDate: '2027-12-31',
  validUntil: '2027-01-01T09:00:00.123Z',
  grossPremiumMinor: 1050,
  currency: 'TRY',
  installmentCount: null,
  termsSummary: null,
};
const catalogs = {
  insurers: [{ id: 'i', agencyId: 'a', name: 'Şirket', status: 'ACTIVE' }],
  branches: [{ id: 'b', agencyId: 'a', name: 'Branş', status: 'ACTIVE' }],
  products: [
    { id: 'p', agencyId: 'a', insurerId: 'i', branchId: 'b', name: 'Ürün', status: 'ACTIVE' },
  ],
  paymentMethods: [
    {
      id: 'm',
      agencyId: 'a',
      name: 'Peşin',
      status: 'ACTIVE',
      supportsInstallments: false,
      maxInstallments: 1,
    },
  ],
} as unknown as SelectableCatalogsDto;
const response = (data: unknown, status = 200) =>
  new Response(
    JSON.stringify(
      status < 400
        ? { success: true, data }
        : { success: false, error: { code: 'FORBIDDEN', message: 'unsafe diagnostic' } },
    ),
    { status },
  );
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => invalidateCsrfToken());
const queueTask: TodayTaskDto = {
  taskId: 't',
  renewalId: 'r',
  customerId: 'c',
  customerDisplayName: 'Seçili Sentetik Müşteri',
  customerPhone: null,
  customerEmail: null,
  policyId: null,
  policyNumber: null,
  policyEndDate: null,
  title: 'Takip',
  dueAt: '2026-10-19T08:00:00.000Z',
  taskVersion: 1,
  renewalVersion: 3,
  assigneeMembershipId: 'self',
  renewalAssigneeMembershipId: 'self',
  renewalState: 'CONTACT_PENDING',
  bucket: 'TODAY',
  isUnassigned: false,
};
const queue: TodayTasksResponseData = {
  items: [queueTask],
  unassignedItems: [],
  hasMore: false,
  nextCursor: null,
  unassignedHasMore: false,
  unassignedNextCursor: null,
  canSeeUnassigned: true,
  canSeeReassignment: true,
  canAssign: true,
  timezone: 'Europe/Istanbul',
  todayLocalDate: '2026-10-19',
  now: '2026-10-19T08:00:00.000Z',
};
function workspace(quoteStatus = 200) {
  const fetcher = vi.fn(async (u: string, i?: RequestInit) => {
    if (u.startsWith('/api/tasks/today')) return response(queue);
    if (u.endsWith('csrf-token')) return response({ token: 'csrf' });
    if (u === '/api/catalogs/selectable') return response(catalogs);
    if (u.endsWith('/quotes'))
      return i?.method
        ? response(null, 503)
        : quoteStatus === 200
          ? response({ defaultVersion: defaults, quotes: [] })
          : response(null, quoteStatus);
    return response({
      interactions: [
        {
          id: 'interaction',
          outcome: 'NOTE',
          channel: 'OTHER',
          occurred_at: '2026-10-19T08:00:00.000Z',
          note: 'Bağımsız izinli iletişim',
          author_name: 'Yazar',
        },
      ],
      lastContactAt: null,
      lastAttemptAt: null,
      companyContacts: [],
      customerType: 'INDIVIDUAL',
    });
  });
  vi.stubGlobal('fetch', fetcher);
  render(
    <MemoryRouter>
      <TodayWorkPage owner />
    </MemoryRouter>,
  );
  return fetcher;
}
it('loads no eager quotes and preserves independently authorized communication/task sections when quote read is denied', async () => {
  const f = workspace(403);
  fireEvent.click(await screen.findByRole('button', { name: /Seçili Sentetik Müşteri/ }));
  await screen.findByText('Bağımsız izinli iletişim');
  expect(f.mock.calls.some(([u]) => u.endsWith('/quotes'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Teklif geçmişini aç' }));
  await screen.findByText(/Teklif geçmişine erişilemiyor/);
  expect(screen.getByText('Bağımsız izinli iletişim')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Yeni takip planını aç' }));
  expect(screen.getByLabelText('Yeni takip zamanı (İstanbul)')).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Yeni teklif taslağı aç' })).toBeNull();
});
it('preserves the communication draft, then pins an uncertain quote attempt through task/queue/refresh/legacy navigation', async () => {
  const f = workspace();
  fireEvent.click(await screen.findByRole('button', { name: /Seçili Sentetik Müşteri/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'İletişim kaydı ekle' }));
  fireEvent.change(screen.getByLabelText('Görüşme sonucu'), { target: { value: 'NOTE' } });
  fireEvent.change(screen.getByLabelText('İç not'), { target: { value: 'Silinmeyecek taslak' } });
  fireEvent.click(screen.getByRole('button', { name: 'Teklif geçmişini aç' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Yeni teklif taslağı aç' }));
  await screen.findByText(/İletişim\/görev taslağını açıkça kapatın/);
  expect(screen.queryByRole('form', { name: 'Yeni teklif formu' })).toBeNull();
  expect((screen.getByLabelText('İç not') as HTMLTextAreaElement).value).toBe(
    'Silinmeyecek taslak',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Formu kapat ve taslağı bırak' }));
  fireEvent.click(screen.getByRole('button', { name: 'Yeni teklif taslağı aç' }));
  submit();
  await screen.findByRole('button', { name: 'Aynı teklif isteğini yeniden dene' });
  for (const name of ['Listeyi yenile', 'Atanmamış işler', 'Görev listesine dön']) {
    fireEvent.click(screen.getByRole('button', { name }));
    await screen.findByText(/Teklif işleminin belirsiz sonucu/);
  }
  fireEvent.click(screen.getByRole('link', { name: 'Klasik iş akışını aç' }));
  expect(screen.getByRole('button', { name: 'Aynı teklif isteğini yeniden dene' })).toBeTruthy();
  expect(screen.queryByText('Hedefi değiştirmeden önce')).toBeNull();
  expect(f.mock.calls.filter(([, i]) => i?.method)).toHaveLength(1);
  expect(
    screen.getByRole('button', { name: 'Yeni takip planını aç' }).closest('fieldset')?.disabled,
  ).toBe(true);
});
it('validates quote money exactly, preserves default expiry precision and rejects invalid dates/installments', () => {
  const initial = quoteDraft(defaults);
  expect(quotePayload(initial, catalogs, 'b', Date.parse('2026-10-19T00:00:00Z'))).toEqual(
    defaults,
  );
  for (const premium of ['0.01', '90071992547409.91'])
    expect(quotePayload({ ...initial, premium }, catalogs, 'b', 0)?.grossPremiumMinor).toBe(
      Number(premium === '0.01' ? 1n : 9007199254740991n),
    );
  for (const premium of ['1e2', '0.001', '90071992547409.92', '-1'])
    expect(quotePayload({ ...initial, premium }, catalogs, 'b', 0)).toBeNull();
  expect(quotePayload({ ...initial, startDate: '2027-02-30' }, catalogs, 'b', 0)).toBeNull();
  expect(quotePayload({ ...initial, installmentCount: '3' }, catalogs, 'b', 0)).toBeNull();
  expect(quotePayload({ ...initial, currency: 'ZZZ' }, catalogs, 'b', 0)).toBeNull();
  expect(quotePayload({ ...initial, termsSummary: 'x'.repeat(1001) }, catalogs, 'b', 0)).toBeNull();
  expect(quotePayload({ ...initial, endDate: initial.startDate }, catalogs, 'b', 0)).toBeNull();
  expect(quotePayload(initial, catalogs, 'b', Date.parse(defaults.validUntil))).toBeNull();
  expect(quotePayload({ ...initial, productId: 'other' }, catalogs, 'b', 0)).toBeNull();
  const installmentCatalog = {
    ...catalogs,
    paymentMethods: catalogs.paymentMethods.map((row) => ({
      ...row,
      supportsInstallments: true,
      maxInstallments: 12,
    })),
  };
  expect(
    quotePayload({ ...initial, installmentCount: '12' }, installmentCatalog, 'b', 0)
      ?.installmentCount,
  ).toBe(12);
  expect(
    quotePayload({ ...initial, installmentCount: '13' }, installmentCatalog, 'b', 0),
  ).toBeNull();
});
it('does not silently lose an unresolved quote through a sidebar link or browser history', async () => {
  const removeBoundary = installQuotePopBoundary();
  const routerPop = vi.fn();
  addEventListener('popstate', routerPop);
  const state = window.history.state;
  window.history.replaceState({ idx: 7 }, '');
  const go = vi.spyOn(window.history, 'go').mockImplementation(() => {});
  const link = document.createElement('a');
  link.href = '#other-page';
  document.body.appendChild(link);
  try {
    workspace();
    fireEvent.click(await screen.findByRole('button', { name: /Seçili Sentetik Müşteri/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Teklif geçmişini aç' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Yeni teklif taslağı aç' }));
    submit();
    await screen.findByRole('button', { name: 'Aynı teklif isteğini yeniden dene' });
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => {
      link.dispatchEvent(click);
    });
    expect(click.defaultPrevented).toBe(true);
    window.history.replaceState({ idx: 6 }, '');
    act(() => {
      window.dispatchEvent(new PopStateEvent('popstate', { state: { idx: 6 } }));
    });
    expect(go).toHaveBeenCalledWith(1);
    expect(routerPop).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Aynı teklif isteğini yeniden dene' })).toBeTruthy();
  } finally {
    removeBoundary();
    removeEventListener('popstate', routerPop);
    go.mockRestore();
    window.history.replaceState(state, '');
    link.remove();
  }
});
it('loads quote history only on demand and creates an explicitly confirmed draft with server readback proof', async () => {
  let written = false;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('csrf-token')) return response({ token: 'csrf' });
    if (url === '/api/catalogs/selectable') return response(catalogs);
    if (init?.method) {
      written = true;
      return response(
        { operationId: 'op', quoteId: 'q', quoteVersionId: 'v', versionNumber: 1, status: 'DRAFT' },
        201,
      );
    }
    return response({
      defaultVersion: defaults,
      quotes: written
        ? [
            {
              id: 'q',
              status: 'DRAFT',
              version: 1,
              current_version_id: 'v',
              accepted_version_id: null,
              versions: [
                {
                  id: 'v',
                  version_number: 1,
                  insurer_id: 'i',
                  product_id: 'p',
                  product_name: 'Ürün',
                  branch_id: 'b',
                  payment_method_id: 'm',
                  start_date: defaults.startDate,
                  end_date: defaults.endDate,
                  valid_until: defaults.validUntil,
                  gross_premium_minor: 1050,
                  currency: 'TRY',
                  installment_count: null,
                  terms_summary: null,
                  created_at: '2026-10-19T00:00:00.000Z',
                },
              ],
              events: [],
            },
          ]
        : [],
    });
  });
  vi.stubGlobal('fetch', fetcher);
  render(
    <RenewalQuotesSection
      renewalId="r"
      renewalVersion={3}
      renewalOpen
      canOperate={() => true}
      compareRenewal={async () => 3}
      onRisk={() => {}}
    />,
  );
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Teklif geçmişini aç' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Yeni teklif taslağı aç' }));
  fireEvent.click(await screen.findByLabelText('Yeni teklif kaydını oluşturmayı onaylıyorum'));
  fireEvent.click(screen.getByRole('button', { name: 'Teklifi oluştur' }));
  await screen.findByText('Teklif yetkili geçmiş okumasıyla doğrulandı.');
  expect(JSON.parse(String(fetcher.mock.calls.find(([, i]) => i?.method)![1]!.body))).toEqual({
    expectedRenewalVersion: 3,
    version: defaults,
  });
});
function row(p = defaults, id = 'old-v', number = 1): QuoteVersion {
  return {
    id,
    version_number: number,
    insurer_id: p.insurerId,
    product_id: p.productId,
    product_name: 'Ürün',
    branch_id: p.branchId,
    payment_method_id: p.paymentMethodId,
    start_date: p.startDate,
    end_date: p.endDate,
    valid_until: p.validUntil,
    gross_premium_minor: p.grossPremiumMinor,
    currency: p.currency,
    installment_count: p.installmentCount,
    terms_summary: p.termsSummary,
    created_at: '2026-10-19T00:00:00.000Z',
  };
}
const original = (): QuoteRecord => ({
  id: 'q',
  status: 'SENT',
  version: 1,
  current_version_id: 'old-v',
  accepted_version_id: null,
  versions: [row()],
  events: [
    { id: 'e', quote_version_id: 'old-v', event: 'SENT', occurred_at: '2026-10-19T00:00:00.000Z' },
  ],
});
function fixture(
  mode: 'create' | 'version' = 'create',
  override?: (u: string, i?: RequestInit) => Response | Promise<Response> | undefined,
) {
  let h: QuoteHistory = {
    defaultVersion: defaults,
    quotes: mode === 'version' ? [original()] : [],
  };
  const fetcher = vi.fn(async (u: string, i?: RequestInit) => {
    const custom = override?.(u, i);
    if (custom) return custom;
    if (u.endsWith('csrf-token')) return response({ token: 'csrf' });
    if (u === '/api/catalogs/selectable') return response(catalogs);
    if (i?.method) {
      const body = JSON.parse(String(i.body)),
        target = u.includes('/versions') ? h.quotes.find((q) => q.id === 'q') : undefined,
        n = target ? Math.max(...target.versions.map((v) => v.version_number)) + 1 : 1,
        quoteId = target ? 'q' : 'created-q',
        v = row(body.version, 'new-v', n);
      if (target)
        h = {
          ...h,
          quotes: h.quotes.map((q) =>
            q.id === 'q'
              ? {
                  ...q,
                  version: q.version + 1,
                  status: 'DRAFT',
                  current_version_id: v.id,
                  versions: [...q.versions, v],
                }
              : q,
          ),
        };
      else
        h = {
          ...h,
          quotes: [
            ...h.quotes,
            {
              id: quoteId,
              status: 'DRAFT',
              version: 1,
              current_version_id: v.id,
              accepted_version_id: null,
              versions: [v],
              events: [],
            },
          ],
        };
      return response(
        { operationId: 'op', quoteId, quoteVersionId: v.id, versionNumber: n, status: 'DRAFT' },
        201,
      );
    }
    return response(h);
  });
  vi.stubGlobal('fetch', fetcher);
  const props = {
    renewalId: 'r',
    renewalVersion: 3,
    renewalOpen: true,
    canOperate: () => true,
    compareRenewal: vi.fn(async () => 4 as number | null),
    onRisk: vi.fn(),
  };
  const view = render(<RenewalQuotesSection {...props} />);
  return {
    ...view,
    props,
    fetcher,
    setHistory: (value: QuoteHistory) => {
      h = value;
    },
    getHistory: () => h,
  };
}
async function open(mode = 'create') {
  fireEvent.click(screen.getByRole('button', { name: 'Teklif geçmişini aç' }));
  const button = await screen.findByRole('button', {
    name:
      mode === 'create' ? 'Yeni teklif taslağı aç' : 'Teklif 1 için yeni değişmez sürüm taslağı aç',
  });
  await waitFor(() => expect(button.hasAttribute('disabled')).toBe(false));
  fireEvent.click(button);
}
function submit(mode = 'create') {
  fireEvent.click(
    screen.getByLabelText(
      mode === 'create'
        ? 'Yeni teklif kaydını oluşturmayı onaylıyorum'
        : 'Mevcut sürümü değiştirmeden yeni sürüm oluşturmayı onaylıyorum',
    ),
  );
  fireEvent.click(
    screen.getByRole('button', {
      name: mode === 'create' ? 'Teklifi oluştur' : 'Yeni değişmez sürümü oluştur',
    }),
  );
}
const success = () => screen.findByText('Teklif yetkili geçmiş okumasıyla doğrulandı.');
it('locks insurer/product identity in immutable version mode; alternatives require a new quote', async () => {
  const expanded = {
    ...catalogs,
    insurers: [...catalogs.insurers, { ...catalogs.insurers[0]!, id: 'i2', name: 'Diğer şirket' }],
    products: [
      ...catalogs.products,
      { ...catalogs.products[0]!, id: 'p2', insurerId: 'i2', name: 'Diğer ürün' },
    ],
  };
  const view = fixture('version', (u) =>
    u === '/api/catalogs/selectable' ? response(expanded) : undefined,
  );
  await open('version');
  const insurer = screen.getByLabelText('Teklif sigorta şirketi'),
    product = screen.getByLabelText('Teklif ürünü');
  expect(insurer.hasAttribute('disabled')).toBe(true);
  expect(product.hasAttribute('disabled')).toBe(true);
  fireEvent.change(insurer, { target: { value: 'i2' } });
  fireEvent.change(product, { target: { value: 'p2' } });
  submit('version');
  await screen.findByText(/Farklı şirket veya ürün için ayrı teklif oluşturun/);
  expect(view.fetcher.mock.calls.some(([, i]) => i?.method)).toBe(false);
});
it('preserves authorized read-only quote history when catalog access is denied without inventing labels', async () => {
  fixture('version', (u) => (u === '/api/catalogs/selectable' ? response(null, 403) : undefined));
  fireEvent.click(screen.getByRole('button', { name: 'Teklif geçmişini aç' }));
  await screen.findByText(/Şirket adı mevcut değil/);
  expect(screen.getByText('Sürüm 1 — Güncel kayıtlı sürüm')).toBeTruthy();
  expect(
    screen.getByRole('button', { name: 'Yeni teklif taslağı aç' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(screen.queryByRole('form')).toBeNull();
});
it('keeps quote CAS separate from the historical version number', async () => {
  const view = fixture('version');
  view.setHistory({ defaultVersion: defaults, quotes: [{ ...original(), version: 7 }] });
  await open('version');
  submit('version');
  await success();
  expect(
    JSON.parse(String(view.fetcher.mock.calls.find(([, i]) => i?.method)![1]!.body))
      .expectedQuoteVersion,
  ).toBe(7);
  expect(view.getHistory().quotes[0]!.versions.at(-1)!.version_number).toBe(2);
});
it('creates a new immutable version with quote CAS only and never edits persisted version controls', async () => {
  const view = fixture('version'),
    before = JSON.stringify(view.getHistory().quotes[0]!.versions[0]);
  await open('version');
  submit('version');
  await success();
  const write = view.fetcher.mock.calls.find(([, i]) => i?.method)!;
  expect(write[0]).toBe('/api/renewals/r/quotes/q/versions');
  expect(JSON.parse(String(write[1]!.body))).toEqual({
    expectedQuoteVersion: 1,
    version: defaults,
  });
  expect(JSON.stringify(view.getHistory().quotes[0]!.versions[0])).toBe(before);
  expect(screen.getByText('Sürüm 1 — Tarihsel değişmez sürüm')).toBeTruthy();
  expect(screen.getByText('Sürüm 2 — Güncel kayıtlı sürüm')).toBeTruthy();
  expect(screen.queryByLabelText('Teklif brüt primi (ana birim)')).toBeNull();
});
it.each(['create', 'version'] as const)(
  'pins %s target/body/expiry/key and prevents competing double writes after lost/429 responses',
  async (mode) => {
    let writes = 0;
    const view = fixture(mode, (_u, i) =>
      i?.method && ++writes === 1 ? response(null, 429) : undefined,
    );
    await open(mode);
    const form = screen.getByRole('form', {
      name: mode === 'create' ? 'Yeni teklif formu' : 'Yeni değişmez sürüm formu',
    });
    fireEvent.click(
      screen.getByLabelText(
        mode === 'create'
          ? 'Yeni teklif kaydını oluşturmayı onaylıyorum'
          : 'Mevcut sürümü değiştirmeden yeni sürüm oluşturmayı onaylıyorum',
      ),
    );
    fireEvent.submit(form);
    fireEvent.submit(form);
    fireEvent.click(
      await screen.findByRole('button', {
        name:
          mode === 'create'
            ? 'Aynı teklif isteğini yeniden dene'
            : 'Aynı sürüm isteğini yeniden dene',
      }),
    );
    await success();
    const attempts = view.fetcher.mock.calls.filter(([, i]) => i?.method);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(attempts[1]);
  },
);
it.each(['create', 'version'] as const)(
  'uses GET-only recovery for confirmed %s write with failed readback',
  async (mode) => {
    let reads = 0;
    const view = fixture(mode, (u, i) =>
      u === '/api/renewals/r/quotes' && !i?.method && ++reads === 2
        ? response(null, 503)
        : undefined,
    );
    await open(mode);
    submit(mode);
    fireEvent.click(
      await screen.findByRole('button', { name: 'Yalnız teklif geçmişini yeniden oku' }),
    );
    await success();
    expect(view.fetcher.mock.calls.filter(([, i]) => i?.method)).toHaveLength(1);
  },
);
it.each([
  'quoteId',
  'versionId',
  'versionNumber',
  'insurer',
  'product',
  'premium',
  'pointer',
] as const)(
  'does not accept GET200 with mismatched %s evidence, and never repeats a confirmed write',
  async (field) => {
    let reads = 0;
    const view = fixture('create', (u, i) =>
      u === '/api/renewals/r/quotes' && !i?.method && ++reads === 2
        ? response({
            defaultVersion: defaults,
            quotes: [
              {
                ...original(),
                id: field === 'quoteId' ? 'wrong' : 'created-q',
                status: 'DRAFT',
                current_version_id: field === 'pointer' ? 'unrelated' : 'new-v',
                versions: [
                  {
                    ...row(defaults, field === 'versionId' ? 'wrong' : 'new-v'),
                    version_number: field === 'versionNumber' ? 2 : 1,
                    insurer_id: field === 'insurer' ? 'wrong' : defaults.insurerId,
                    product_id: field === 'product' ? 'wrong' : defaults.productId,
                    gross_premium_minor: field === 'premium' ? 9 : 1050,
                  },
                ],
              },
            ],
          })
        : undefined,
    );
    await open();
    submit();
    const retry = await screen.findByRole('button', {
      name: 'Yalnız teklif geçmişini yeniden oku',
    });
    expect(screen.queryByText('Teklif yetkili geçmiş okumasıyla doğrulandı.')).toBeNull();
    fireEvent.click(retry);
    await success();
    expect(view.fetcher.mock.calls.filter(([, i]) => i?.method)).toHaveLength(1);
  },
);
it('rejects a different quote ID in version POST evidence as uncertain instead of switching targets', async () => {
  const view = fixture('version', (_u, i) =>
    i?.method
      ? response(
          {
            operationId: 'op',
            quoteId: 'other',
            quoteVersionId: 'new-v',
            versionNumber: 2,
            status: 'DRAFT',
          },
          201,
        )
      : undefined,
  );
  await open('version');
  submit('version');
  await screen.findByRole('button', { name: 'Aynı sürüm isteğini yeniden dene' });
  expect(screen.queryByText('Teklif yetkili geçmiş okumasıyla doğrulandı.')).toBeNull();
  expect(
    view.fetcher.mock.calls.filter(([u, i]) => u === '/api/renewals/r/quotes' && !i?.method),
  ).toHaveLength(1);
});
it.each(['create', 'version'] as const)(
  'preserves %s draft and requires explicit current-state comparison and reconfirmation after409',
  async (mode) => {
    let writes = 0;
    const view = fixture(mode, (_u, i) =>
      i?.method && ++writes === 1 ? response(null, 409) : undefined,
    );
    await open(mode);
    fireEvent.change(screen.getByLabelText('Teklif brüt primi (ana birim)'), {
      target: { value: '0.50' },
    });
    submit(mode);
    await screen.findByRole('button', { name: 'Güncel teklif durumunu karşılaştır' });
    if (mode === 'version')
      view.setHistory({
        defaultVersion: defaults,
        quotes: [
          {
            ...original(),
            version: 2,
            current_version_id: 'later-v',
            versions: [row(), row(defaults, 'later-v', 2)],
          },
        ],
      });
    fireEvent.click(screen.getByRole('button', { name: 'Güncel teklif durumunu karşılaştır' }));
    await screen.findByText(/Güncel yenileme v4/);
    expect((screen.getByLabelText('Teklif brüt primi (ana birim)') as HTMLInputElement).value).toBe(
      '0.50',
    );
    expect(
      (
        screen.getByLabelText(
          mode === 'create'
            ? 'Yeni teklif kaydını oluşturmayı onaylıyorum'
            : 'Mevcut sürümü değiştirmeden yeni sürüm oluşturmayı onaylıyorum',
        ) as HTMLInputElement
      ).checked,
    ).toBe(false);
    submit(mode);
    await success();
    const sent = JSON.parse(
      String(view.fetcher.mock.calls.filter(([, i]) => i?.method)[1]![1]!.body),
    );
    expect(sent[mode === 'create' ? 'expectedRenewalVersion' : 'expectedQuoteVersion']).toBe(
      mode === 'create' ? 4 : 2,
    );
    expect(sent.version.grossPremiumMinor).toBe(50);
  },
);
it('does not retarget a missing or accepted quote after an authorized conflict comparison', async () => {
  let writes = 0;
  const view = fixture('version', (_u, i) =>
    i?.method && ++writes === 1 ? response(null, 409) : undefined,
  );
  await open('version');
  submit('version');
  await screen.findByRole('button', { name: 'Güncel teklif durumunu karşılaştır' });
  view.setHistory({ defaultVersion: defaults, quotes: [{ ...original(), id: 'replacement' }] });
  fireEvent.click(screen.getByRole('button', { name: 'Güncel teklif durumunu karşılaştır' }));
  await screen.findByText(/Hedef veya yetkili görev artık uygun değil/);
  expect(
    screen.getByRole('button', { name: 'Yeni değişmez sürümü oluştur' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(writes).toBe(1);
});
it.each([400, 403, 404])(
  'preserves safe draft state after %i without displaying raw errors or inferring write success',
  async (status) => {
    const view = fixture('create', (_u, i) => (i?.method ? response(null, status) : undefined));
    await open();
    fireEvent.change(screen.getByLabelText('Teklif koşulları'), {
      target: { value: 'Korunan taslak' },
    });
    submit();
    await screen.findByRole('alert');
    expect(document.body.textContent).not.toContain('unsafe diagnostic');
    expect(view.fetcher.mock.calls.filter(([, i]) => i?.method)).toHaveLength(1);
    if (status !== 400) {
      expect(screen.queryByLabelText('Teklif koşulları')).toBeNull();
      fireEvent.click(screen.getByRole('button', { name: 'Güncel teklif durumunu karşılaştır' }));
      await screen.findByLabelText('Teklif koşulları');
    }
    expect((screen.getByLabelText('Teklif koşulları') as HTMLTextAreaElement).value).toBe(
      'Korunan taslak',
    );
  },
);
it('keeps accepted history read-only and excludes send/accept/reject actions', async () => {
  const view = fixture('version');
  view.setHistory({
    defaultVersion: defaults,
    quotes: [{ ...original(), status: 'ACCEPTED', accepted_version_id: 'old-v' }],
  });
  fireEvent.click(screen.getByRole('button', { name: 'Teklif geçmişini aç' }));
  await screen.findByText(/Kabul edilmiş teklif salt okunur/);
  expect(screen.queryByRole('button', { name: /yeni değişmez sürüm taslağı/ })).toBeNull();
  expect(screen.queryByRole('button', { name: /Gönder|Kabul et|Reddet/ })).toBeNull();
});
it('keeps original renewal snapshot during ordinary props refresh and requires explicit confirmation', async () => {
  const view = fixture();
  await open();
  view.rerender(<RenewalQuotesSection {...view.props} renewalVersion={30} />);
  fireEvent.click(screen.getByRole('button', { name: 'Teklifi oluştur' }));
  expect(view.fetcher.mock.calls.some(([, i]) => i?.method)).toBe(false);
  submit();
  await success();
  expect(
    JSON.parse(String(view.fetcher.mock.calls.find(([, i]) => i?.method)![1]!.body))
      .expectedRenewalVersion,
  ).toBe(3);
});
it.each(['history', 'csrf', 'post', 'readback'] as const)(
  'ignores delayed %s401 after changing selected renewal without contaminating the next task',
  async (stage) => {
    let release!: (r: Response) => void,
      waiting = false,
      writes = 0;
    const delayed = new Promise<Response>((r) => {
        release = r;
      }),
      ended = vi.fn();
    document.addEventListener('mayi-session-ended', ended);
    try {
      const view = fixture('create', (u, i) => {
        if (i?.method) writes++;
        if (
          (stage === 'history' && u === '/api/renewals/r/quotes') ||
          (stage === 'csrf' && u.endsWith('csrf-token')) ||
          (stage === 'post' && i?.method) ||
          (stage === 'readback' && u === '/api/renewals/r/quotes' && !i?.method && writes)
        ) {
          waiting = true;
          return delayed;
        }
        return undefined;
      });
      if (stage === 'history')
        fireEvent.click(screen.getByRole('button', { name: 'Teklif geçmişini aç' }));
      else {
        await open();
        submit();
      }
      await waitFor(() => expect(waiting).toBe(true));
      view.rerender(<RenewalQuotesSection {...view.props} renewalId="other" />);
      await act(async () => release(response(null, 401)));
      expect(ended).not.toHaveBeenCalled();
      expect(screen.getByRole('button', { name: 'Teklif geçmişini aç' })).toBeTruthy();
      expect(screen.queryByRole('alert')).toBeNull();
      expect(screen.queryByRole('form')).toBeNull();
    } finally {
      document.removeEventListener('mayi-session-ended', ended);
    }
  },
);
it('pins revisions to the first immutable identity even when a legacy current version diverges', async () => {
  const expanded = {
    ...catalogs,
    insurers: [...catalogs.insurers, { ...catalogs.insurers[0]!, id: 'i2', name: 'Diğer şirket' }],
    products: [
      ...catalogs.products,
      { ...catalogs.products[0]!, id: 'p2', insurerId: 'i2', name: 'Diğer ürün' },
    ],
  };
  const view = fixture('version', (u) =>
    u === '/api/catalogs/selectable' ? response(expanded) : undefined,
  );
  view.setHistory({
    defaultVersion: defaults,
    quotes: [
      {
        ...original(),
        version: 2,
        current_version_id: 'legacy-v',
        versions: [
          row(),
          row(
            { ...defaults, insurerId: 'i2', productId: 'p2', grossPremiumMinor: 1234 },
            'legacy-v',
            2,
          ),
        ],
      },
    ],
  });
  await open('version');
  expect(
    (screen.getByLabelText('Teklif sigorta şirketi') as unknown as HTMLSelectElement).value,
  ).toBe('i');
  expect((screen.getByLabelText('Teklif ürünü') as unknown as HTMLSelectElement).value).toBe('p');
  expect((screen.getByLabelText('Teklif brüt primi (ana birim)') as HTMLInputElement).value).toBe(
    '12.34',
  );
  submit('version');
  await success();
  const write = view.fetcher.mock.calls.find(([, i]) => i?.method)!;
  expect(JSON.parse(String(write[1]!.body))).toMatchObject({
    expectedQuoteVersion: 2,
    version: { insurerId: 'i', productId: 'p', grossPremiumMinor: 1234 },
  });
  expect(view.getHistory().quotes[0]!.versions[1]!.insurer_id).toBe('i2');
});

it('creates a different insurer/product alternative only as a new Quote, not a revision', async () => {
  const expanded = {
    ...catalogs,
    insurers: [...catalogs.insurers, { ...catalogs.insurers[0]!, id: 'i2', name: 'Diğer şirket' }],
    products: [
      ...catalogs.products,
      { ...catalogs.products[0]!, id: 'p2', insurerId: 'i2', name: 'Diğer ürün' },
    ],
  };
  const view = fixture('version', (u) =>
    u === '/api/catalogs/selectable' ? response(expanded) : undefined,
  );
  const before = JSON.stringify(view.getHistory().quotes[0]);
  await open();
  fireEvent.change(screen.getByLabelText('Teklif sigorta şirketi'), { target: { value: 'i2' } });
  fireEvent.change(screen.getByLabelText('Teklif ürünü'), { target: { value: 'p2' } });
  submit();
  await success();
  const write = view.fetcher.mock.calls.find(([, i]) => i?.method)!;
  expect(write[0]).toBe('/api/renewals/r/quotes');
  expect(JSON.parse(String(write[1]!.body))).toMatchObject({
    expectedRenewalVersion: 3,
    version: { insurerId: 'i2', productId: 'p2' },
  });
  expect(JSON.stringify(view.getHistory().quotes[0])).toBe(before);
  expect(view.getHistory().quotes).toHaveLength(2);
});
