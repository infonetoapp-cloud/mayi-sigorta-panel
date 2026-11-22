import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import PolicyFormPage from '../src/app/pages/policies/PolicyFormPage';
import { invalidateCsrfToken } from '../src/app/csrf';
import { policyDetailFixture } from './support/policy-detail-fixture';
const customer = (id = 'origin') => ({
  id,
  displayName: id === 'origin' ? 'Kaynak Müşteri' : 'Başka Müşteri',
  type: 'COMPANY',
  archivedAt: null,
});
const policy = policyDetailFixture('policy-a', {
  version: 2,
  customerId: 'origin',
  customer: customer(),
  insurerId: 'i',
  insurer: { id: 'i', name: 'Sigorta Şirketi', status: 'ACTIVE' },
  branchId: 'b',
  branch: {
    id: 'b',
    name: 'Branş',
    status: 'ACTIVE',
    dataClassification: 'GENERAL',
    supportsVehicleDetails: false,
  },
  productId: 'p',
  product: { id: 'p', name: 'Ürün', status: 'ACTIVE' },
  paymentMethodId: 'cash',
  paymentMethod: { id: 'cash', name: 'Peşin', status: 'ACTIVE' },
  policyNumber: 'POL-1',
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  grossPremiumMinor: 123456,
  currency: 'TRY',
  installmentCount: null as number | null,
  status: 'ACTIVE',
  archivedAt: null,
});
const catalogs = {
  insurers: [
    { id: 'i', name: 'Sigorta Şirketi', status: 'ACTIVE' },
    { id: 'other-i', name: 'Diğer Sigortacı', status: 'ACTIVE' },
  ],
  branches: [
    { id: 'b', name: 'Branş', status: 'ACTIVE', dataClassification: 'GENERAL' },
    { id: 'other-b', name: 'Diğer Branş', status: 'ACTIVE', dataClassification: 'GENERAL' },
  ],
  products: [
    { id: 'p', name: 'Ürün', insurerId: 'i', branchId: 'b', status: 'ACTIVE' },
    {
      id: 'other-p',
      name: 'Diğer Ürün',
      insurerId: 'other-i',
      branchId: 'other-b',
      status: 'ACTIVE',
    },
  ],
  paymentMethods: [
    {
      id: 'cash',
      name: 'Peşin',
      status: 'ACTIVE',
      supportsInstallments: false,
      maxInstallments: 12,
    },
    { id: 'card', name: 'Kart', status: 'ACTIVE', supportsInstallments: true, maxInstallments: 6 },
  ],
  lossReasons: [],
  defaultInsurerId: null,
};
const response = (data: unknown, status = 200, code = 'VALIDATION_ERROR') =>
  new Response(
    JSON.stringify(
      status < 400
        ? { success: true, data }
        : { success: false, error: { code, message: 'unsafe SQL diagnostic' } },
    ),
    { status },
  );
beforeEach(() => invalidateCsrfToken());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function fixture(
  override?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined,
  initial = policy,
) {
  let current = { ...initial };
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const custom = override?.(url, init);
    if (custom) return custom;
    if (url.endsWith('csrf-token')) return response({ token: 'csrf' });
    if (url === '/api/catalogs/selectable') return response(catalogs);
    if (url.startsWith('/api/customers?'))
      return response({ items: [customer('other')], hasMore: true, nextCursor: 'not-downloaded' });
    if (url.startsWith('/api/customers/')) return response(customer(url.split('/').at(-1)));
    if (init?.method === 'POST') {
      current = { ...policy, id: 'created', version: 1 };
      return response(current, 201);
    }
    if (init?.method === 'PATCH') {
      const { expectedVersion: _version, ...changes } = JSON.parse(String(init.body));
      current = { ...current, ...changes, version: current.version + 1 };
      return response(current);
    }
    return response(current);
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
function mount(path = '/policies/new?customerId=origin') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Link to="/policies/b/edit">Diğer poliçe</Link>
      <Routes>
        <Route path="/policies/new" element={<PolicyFormPage />} />
        <Route path="/policies/:policyId/edit" element={<PolicyFormPage />} />
        <Route path="/policies/:policyId" element={<p>Modern detay</p>} />
      </Routes>
    </MemoryRouter>,
  );
}
async function fill() {
  await screen.findByLabelText('Poliçe numarası');
  for (const [label, value] of [
    ['Sigorta şirketi', 'i'],
    ['Branş', 'b'],
    ['Ürün', 'p'],
    ['Ödeme yöntemi', 'cash'],
    ['Poliçe numarası', 'NEW-1'],
    ['Başlangıç tarihi', '2026-01-01'],
    ['Bitiş tarihi', '2026-12-31'],
    ['Brüt prim', '1234.56'],
  ])
    fireEvent.change(screen.getByLabelText(label!), { target: { value } });
}
it.each(['12500,50', '12500.50', '12.500,50'])(
  'sends canonical decimal policy creation from employee input %s',
  async (value) => {
    const f = fixture();
    mount();
    await fill();
    fireEvent.change(screen.getByLabelText('Brüt prim'), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Poliçeyi oluştur' }));
    await screen.findByText('Modern detay');
    expect(
      JSON.parse(String(f.mock.calls.find(([, i]) => i?.method === 'POST')![1]!.body)).grossPremium,
    ).toBe('12500.50');
  },
);
it.each(['12500,50', '12500.50', '12.500,50'])(
  'sends canonical CAS PATCH from employee input %s',
  async (value) => {
    const f = fixture();
    mount('/policies/policy-a/edit');
    await screen.findByLabelText('Brüt prim');
    fireEvent.change(screen.getByLabelText('Brüt prim'), { target: { value } });
    fireEvent.click(screen.getByRole('button', { name: 'Değişiklikleri kaydet' }));
    await screen.findByText('Modern detay');
    expect(
      JSON.parse(String(f.mock.calls.find(([, i]) => i?.method === 'PATCH')![1]!.body)),
    ).toEqual({ expectedVersion: 2, grossPremium: '12500.50' });
  },
);
it('never rewrites a frozen canonical money payload on ambiguous retry after a field change', async () => {
  let attempts = 0;
  const f = fixture((u, i) =>
    u === '/api/policies/created'
      ? response({ ...policy, id: 'created', version: 1 })
      : i?.method === 'POST'
        ? ++attempts === 1
          ? response(null, 503)
          : response({ ...policy, id: 'created', version: 1 }, 201)
        : undefined,
  );
  mount();
  await fill();
  fireEvent.change(screen.getByLabelText('Brüt prim'), { target: { value: '12.500,50' } });
  fireEvent.click(screen.getByRole('button', { name: 'Poliçeyi oluştur' }));
  await screen.findByRole('button', { name: 'Aynı işlemi yeniden dene' });
  fireEvent.change(screen.getByLabelText('Brüt prim'), { target: { value: '1,00' } });
  fireEvent.click(screen.getByRole('button', { name: 'Aynı işlemi yeniden dene' }));
  await screen.findByText('Modern detay');
  const calls = f.mock.calls.filter(([, i]) => i?.method === 'POST');
  expect(calls).toHaveLength(2);
  expect(calls[0]![1]!.body).toBe(calls[1]![1]!.body);
  expect(calls[0]![1]!.headers).toEqual(calls[1]![1]!.headers);
  expect(JSON.parse(String(calls[1]![1]!.body)).grossPremium).toBe('12500.50');
});
it('does not write when a policy amount changes only its employee-facing separators', async () => {
  const f = fixture();
  mount('/policies/policy-a/edit');
  await screen.findByLabelText('Brüt prim');
  fireEvent.change(screen.getByLabelText('Brüt prim'), { target: { value: '1.234,56' } });
  fireEvent.click(screen.getByRole('button', { name: 'Değişiklikleri kaydet' }));
  await screen.findByText('En az bir sözleşme bilgisini değiştirin.');
  expect(f.mock.calls.some(([, i]) => i?.method)).toBe(false);
});
it('preselects the exact authorized origin outside bounded search results and creates with canonical fields', async () => {
  const fetcher = fixture();
  mount();
  await fill();
  fireEvent.input(screen.getByLabelText('Başlangıç tarihi'), { target: { value: '2026-02-01' } });
  fireEvent.input(screen.getByLabelText('Bitiş tarihi'), { target: { value: '2026-05-01' } });
  expect(screen.getByText('Kaynak Müşteri')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Poliçeyi oluştur' }));
  await screen.findByText('Modern detay');
  const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(post[0]).toBe('/api/policies');
  expect(JSON.parse(String(post[1]!.body))).toEqual({
    customerId: 'origin',
    insurerId: 'i',
    branchId: 'b',
    productId: 'p',
    paymentMethodId: 'cash',
    policyNumber: 'NEW-1',
    startDate: '2026-02-01',
    endDate: '2026-05-01',
    grossPremium: '1234.56',
    currency: 'TRY',
    installmentCount: null,
    status: 'ACTIVE',
  });
  expect(fetcher.mock.calls.some(([url]) => url.includes('cursor='))).toBe(false);
});
it('validates exact decimal premium, ISO currency and dependent product without making a write', async () => {
  const fetcher = fixture();
  mount();
  await fill();
  fireEvent.change(screen.getByLabelText('Brüt prim'), { target: { value: '1,250' } });
  fireEvent.click(screen.getByRole('button', { name: 'Poliçeyi oluştur' }));
  await screen.findByText(/12500,50 veya 12500.50/, { selector: '.customer-field-error' });
  fireEvent.change(screen.getByLabelText('Brüt prim'), { target: { value: '90071992547409.92' } });
  fireEvent.change(screen.getByLabelText('Para birimi'), { target: { value: 'ZZZ' } });
  fireEvent.change(screen.getByLabelText('Sigorta şirketi'), { target: { value: 'other-i' } });
  expect((screen.getByLabelText('Ürün') as unknown as HTMLSelectElement).value).toBe('');
  fireEvent.click(screen.getByRole('button', { name: 'Poliçeyi oluştur' }));
  await screen.findByText('Seçilen sigortacı ve branşa bağlı aktif ürünü seçin.');
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
it('supports only the selected payment installment limits and resets installments explicitly for a cash change', async () => {
  const fetcher = fixture();
  mount();
  await fill();
  expect(screen.queryByLabelText('Taksit sayısı')).toBeNull();
  fireEvent.change(screen.getByLabelText('Ödeme yöntemi'), { target: { value: 'card' } });
  fireEvent.change(screen.getByLabelText('Taksit sayısı'), { target: { value: '7' } });
  fireEvent.click(screen.getByRole('button', { name: 'Poliçeyi oluştur' }));
  await screen.findByText('Taksit sayısı 2–6 arasında olmalıdır.');
  fireEvent.change(screen.getByLabelText('Ödeme yöntemi'), { target: { value: 'cash' } });
  fireEvent.click(screen.getByRole('button', { name: 'Poliçeyi oluştur' }));
  await screen.findByText('Modern detay');
  expect(
    JSON.parse(String(fetcher.mock.calls.find(([, init]) => init?.method === 'POST')![1]!.body))
      .installmentCount,
  ).toBeNull();
});
it('edits using a field-only PATCH plus the loaded CAS and cannot change its customer', async () => {
  const fetcher = fixture();
  mount('/policies/policy-a/edit');
  await screen.findByLabelText('Poliçe numarası');
  expect(screen.queryByLabelText('Müşteri')).toBeNull();
  fireEvent.change(screen.getByLabelText('Poliçe numarası'), { target: { value: 'EDITED-1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Değişiklikleri kaydet' }));
  await screen.findByText('Modern detay');
  const patch = fetcher.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
  expect(patch[0]).toBe('/api/policies/policy-a');
  expect(JSON.parse(String(patch[1]!.body))).toEqual({
    expectedVersion: 2,
    policyNumber: 'EDITED-1',
  });
});
it('keeps the original immutable body/key on lost POST response and blocks duplicate submits or changing the customer', async () => {
  let release!: (r: Response) => void;
  let posts = 0;
  const created = { ...policy, id: 'created', version: 1 };
  const fetcher = fixture((url, init) =>
    init?.method === 'POST'
      ? ++posts === 1
        ? new Promise<Response>((resolve) => {
            release = resolve;
          })
        : response(created, 201)
      : url === '/api/policies/created'
        ? response(created)
        : undefined,
  );
  mount();
  await fill();
  const form = screen.getByRole('form', { name: 'Poliçe sözleşme formu' });
  fireEvent.submit(form);
  fireEvent.submit(form);
  await waitFor(() => expect(posts).toBe(1));
  await act(async () => release(response(null, 503)));
  expect(screen.queryByLabelText('Müşteri')).toBeNull();
  expect(
    (screen.getByLabelText('Poliçe numarası') as HTMLInputElement).closest('fieldset')!.disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Aynı işlemi yeniden dene' }));
  await screen.findByText('Modern detay');
  const attempts = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(attempts).toHaveLength(2);
  expect(attempts[0]![1]).toEqual(attempts[1]![1]);
});
it.each(['POST', 'PATCH'])(
  'retries only the detail GET after a successful %s and malformed readback',
  async (method) => {
    let reads = 0;
    const urlOfRecord = method === 'POST' ? '/api/policies/created' : '/api/policies/policy-a';
    const fetcher = fixture((url, init) =>
      !init?.method && url === urlOfRecord && ++reads === (method === 'POST' ? 1 : 2)
        ? response({ ...policy, id: url.split('/').at(-1), customer: null })
        : undefined,
    );
    if (method === 'POST') {
      mount();
      await fill();
    } else {
      mount('/policies/policy-a/edit');
      fireEvent.change(await screen.findByLabelText('Poliçe numarası'), {
        target: { value: 'UPDATED' },
      });
    }
    fireEvent.click(
      screen.getByRole('button', {
        name: method === 'POST' ? 'Poliçeyi oluştur' : 'Değişiklikleri kaydet',
      }),
    );
    await screen.findByText(
      'Poliçe kaydedildi. Gelen detay doğrulanamadı. Kaydedilen poliçeyi yeniden okuyun.',
    );
    expect(screen.queryByRole('button', { name: 'Aynı işlemi yeniden dene' })).toBeNull();
    expect(
      (screen.getByLabelText('Poliçe numarası') as HTMLInputElement).matches(':disabled'),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Kaydedilen poliçeyi yeniden oku' }));
    await screen.findByText('Modern detay');
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === method)).toHaveLength(1);
    expect(reads).toBe(method === 'POST' ? 2 : 3);
  },
);

it('rejects a wrong edit target and malformed catalog before enabling the form', async () => {
  let policyReads = 0,
    catalogReads = 0;
  const fetcher = fixture((url) => {
    if (url === '/api/policies/policy-a' && ++policyReads === 1)
      return response({ ...policy, id: 'another-policy' });
    if (url === '/api/catalogs/selectable' && ++catalogReads === 1)
      return response({ ...catalogs, paymentMethods: [null] });
  });
  mount('/policies/policy-a/edit');
  const retryPolicy = await screen.findByRole('button', { name: 'Yeniden dene' });
  expect(catalogReads).toBe(0);
  expect(screen.queryByLabelText('Poliçe numarası')).toBeNull();
  fireEvent.click(retryPolicy);
  const retryCatalog = await screen.findByRole('button', { name: 'Yeniden dene' });
  expect(screen.queryByLabelText('Poliçe numarası')).toBeNull();
  fireEvent.click(retryCatalog);
  await screen.findByLabelText('Poliçe numarası');
  expect(catalogReads).toBe(2);
  expect(policyReads).toBe(2);
  expect(fetcher.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});
it('requires explicit 409 comparison and sends only originally changed fields at the compared version', async () => {
  let writes = 0;
  let live = { ...policy };
  const fetcher = fixture((url, init) => {
    if (init?.method === 'PATCH') {
      if (++writes === 1) {
        live = { ...live, version: 7, currency: 'EUR' };
        return response(null, 409);
      }
      live = { ...live, policyNumber: 'MY-DRAFT', version: 8 };
      return response(live);
    }
    return url === '/api/policies/policy-a' ? response(live) : undefined;
  });
  mount('/policies/policy-a/edit');
  fireEvent.change(await screen.findByLabelText('Poliçe numarası'), {
    target: { value: 'MY-DRAFT' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Değişiklikleri kaydet' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Güncel poliçeyi karşılaştır' }));
  await screen.findByText(/karşılaştırma kaydı · sürüm 7/);
  expect(screen.getByLabelText('Sözleşme özeti').textContent).toContain('€');
  expect((screen.getByLabelText('Poliçe numarası') as HTMLInputElement).value).toBe('MY-DRAFT');
  fireEvent.click(screen.getByRole('button', { name: 'Karşılaştırdım, değişiklikleri kaydet' }));
  await screen.findByText('Modern detay');
  expect(
    JSON.parse(
      String(fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH')[1]![1]!.body),
    ),
  ).toEqual({ expectedVersion: 7, policyNumber: 'MY-DRAFT' });
});
it('preserves missing/inactive historical catalog values and installments on an unrelated basic edit', async () => {
  const historical: typeof policy = {
    ...policy,
    product: { ...policy.product, status: 'INACTIVE' },
    paymentMethod: { ...policy.paymentMethod, status: 'INACTIVE' },
    installmentCount: 3,
  };
  const fetcher = fixture(
    (url) =>
      url === '/api/catalogs/selectable'
        ? response({ ...catalogs, products: [], paymentMethods: [] })
        : undefined,
    historical,
  );
  mount('/policies/policy-a/edit');
  fireEvent.change(await screen.findByLabelText('Poliçe numarası'), {
    target: { value: 'HISTORICAL-EDIT' },
  });
  expect((screen.getByLabelText('Ürün') as unknown as HTMLSelectElement).value).toBe('p');
  expect(screen.queryByLabelText('Taksit sayısı')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Değişiklikleri kaydet' }));
  await screen.findByText('Modern detay');
  expect(
    JSON.parse(String(fetcher.mock.calls.find(([, init]) => init?.method === 'PATCH')![1]!.body)),
  ).toEqual({ expectedVersion: 2, policyNumber: 'HISTORICAL-EDIT' });
});
it.each([403, 404])(
  'never substitutes another customer or mounts fields for an inaccessible origin %i',
  async (status) => {
    const fetcher = fixture((url) =>
      url === '/api/customers/origin' ? response(null, status) : undefined,
    );
    mount();
    await screen.findByRole('alert');
    expect(screen.queryByLabelText('Poliçe numarası')).toBeNull();
    expect(document.body.textContent).not.toContain('unsafe SQL');
    expect(fetcher.mock.calls.some(([url]) => url === '/api/catalogs/selectable')).toBe(false);
  },
);
it.each(['policy', 'customer'])(
  'does not mount editable fields for an archived %s',
  async (kind) => {
    fixture((url) =>
      url === (kind === 'policy' ? '/api/policies/policy-a' : '/api/customers/origin')
        ? response({ ...(kind === 'policy' ? policy : customer()), archivedAt: '2026-01-01' })
        : undefined,
    );
    mount(kind === 'policy' ? '/policies/policy-a/edit' : '/policies/new?customerId=origin');
    await screen.findByRole('alert');
    expect(screen.queryByLabelText('Poliçe numarası')).toBeNull();
  },
);
it.each([401, 403])(
  'clears editable policy data after a live write permission/session denial %i',
  async (status) => {
    const ended = vi.fn();
    document.addEventListener('mayi-session-ended', ended);
    try {
      fixture((_url, init) => (init?.method === 'PATCH' ? response(null, status) : undefined));
      mount('/policies/policy-a/edit');
      fireEvent.change(await screen.findByLabelText('Poliçe numarası'), {
        target: { value: 'DENIED-DRAFT' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Değişiklikleri kaydet' }));
      await screen.findByRole('alert');
      expect(screen.queryByLabelText('Poliçe numarası')).toBeNull();
      expect(document.body.textContent).not.toContain('unsafe SQL');
      expect(ended).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    } finally {
      document.removeEventListener('mayi-session-ended', ended);
    }
  },
);
it('does not start a new create attempt after a definitive duplicate-contract conflict', async () => {
  const fetcher = fixture((_url, init) =>
    init?.method === 'POST' ? response(null, 409) : undefined,
  );
  mount();
  await fill();
  fireEvent.click(screen.getByRole('button', { name: 'Poliçeyi oluştur' }));
  await screen.findByRole('alert');
  expect(screen.queryByRole('button', { name: 'Poliçeyi oluştur' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Aynı işlemi yeniden dene' })).toBeNull();
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});
it('searches a bounded server customer page and requires explicit authorized selection', async () => {
  const fetcher = fixture();
  mount('/policies/new');
  await screen.findByRole('option', { name: 'Başka Müşteri' });
  expect(screen.queryByLabelText('Poliçe numarası')).toBeNull();
  fireEvent.change(screen.getByLabelText('Müşteri ara'), { target: { value: 'Başka' } });
  fireEvent.click(screen.getByRole('button', { name: 'Müşterileri ara' }));
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([url]) => url.includes('limit=20&search=Ba'))).toBe(true),
  );
  fireEvent.change(screen.getByLabelText('Müşteri'), { target: { value: 'other' } });
  await screen.findByLabelText('Poliçe numarası');
  expect(fetcher.mock.calls.some(([url]) => url === '/api/customers/other')).toBe(true);
  expect(fetcher.mock.calls.some(([url]) => url.includes('cursor='))).toBe(false);
});
it('retries the exact PATCH after an ambiguous committed response', async () => {
  let writes = 0;
  const live = { ...policy, version: 3, policyNumber: 'EXACT-PATCH' };
  const fetcher = fixture((url, init) =>
    init?.method === 'PATCH'
      ? ++writes === 1
        ? response(null, 503)
        : response(live)
      : url === '/api/policies/policy-a' && writes
        ? response(live)
        : undefined,
  );
  mount('/policies/policy-a/edit');
  fireEvent.change(await screen.findByLabelText('Poliçe numarası'), {
    target: { value: 'EXACT-PATCH' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Değişiklikleri kaydet' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Aynı işlemi yeniden dene' }));
  await screen.findByText('Modern detay');
  const attempts = fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH');
  expect(attempts).toHaveLength(2);
  expect(attempts[0]![1]).toEqual(attempts[1]![1]);
});
it('blocks a preserved conflict draft when comparison discovers archive', async () => {
  let writes = 0;
  const fetcher = fixture((url, init) =>
    init?.method === 'PATCH'
      ? (writes++, response(null, 409))
      : url === '/api/policies/policy-a' && writes
        ? response({ ...policy, version: 4, archivedAt: '2026-01-01' })
        : undefined,
  );
  mount('/policies/policy-a/edit');
  fireEvent.change(await screen.findByLabelText('Poliçe numarası'), { target: { value: 'DRAFT' } });
  fireEvent.click(screen.getByRole('button', { name: 'Değişiklikleri kaydet' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Güncel poliçeyi karşılaştır' }));
  await screen.findByText('Arşivlenmiş poliçe düzenlenemez.');
  expect(screen.queryByLabelText('Poliçe numarası')).toBeNull();
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
});
it.each(['csrf', 'csrf-401', 'mutation', 'readback', 'readback-401'])(
  'ignores a late %s after switching keyed edit pages',
  async (stage) => {
    let release!: (r: Response) => void;
    const deferred = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let reads = 0;
    const ended = vi.fn();
    document.addEventListener('mayi-session-ended', ended);
    try {
      const fetcher = fixture((url, init) => {
        if (url === '/api/policies/b')
          return response({ ...policy, id: 'b', policyNumber: 'POL-B' });
        if (stage.startsWith('csrf') && url.endsWith('csrf-token')) return deferred;
        if (stage === 'mutation' && init?.method === 'PATCH') return deferred;
        if (
          stage.startsWith('readback') &&
          url === '/api/policies/policy-a' &&
          !init?.method &&
          ++reads > 1
        )
          return deferred;
        return undefined;
      });
      mount('/policies/policy-a/edit');
      fireEvent.change(await screen.findByLabelText('Poliçe numarası'), {
        target: { value: 'OLD-DRAFT' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Değişiklikleri kaydet' }));
      await waitFor(() =>
        expect(
          stage.startsWith('readback')
            ? reads > 1
            : stage === 'mutation'
              ? fetcher.mock.calls.some(([, init]) => init?.method === 'PATCH')
              : fetcher.mock.calls.some(([url]) => url.endsWith('csrf-token')),
        ).toBe(true),
      );
      fireEvent.click(screen.getByRole('link', { name: 'Diğer poliçe' }));
      await waitFor(() =>
        expect((screen.getByLabelText('Poliçe numarası') as HTMLInputElement).value).toBe('POL-B'),
      );
      await act(async () =>
        release(
          stage.startsWith('csrf')
            ? response({ token: 'csrf' }, stage === 'csrf-401' ? 401 : 200)
            : response({ ...policy, version: 3 }, stage === 'readback-401' ? 401 : 200),
        ),
      );
      expect(screen.queryByText('Modern detay')).toBeNull();
      expect((screen.getByLabelText('Poliçe numarası') as HTMLInputElement).value).toBe('POL-B');
      expect(ended).not.toHaveBeenCalled();
      if (stage.startsWith('csrf'))
        expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
    } finally {
      document.removeEventListener('mayi-session-ended', ended);
    }
  },
);
