// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RenewalWorkspacePanel } from '../src/app/components/RenewalWorkspacePanel';

const defaults = {
  insurerId: 'anadolu-random',
  productId: 'anadolu-kasko',
  branchId: 'kasko',
  paymentMethodId: 'cash',
  startDate: '2026-10-25',
  endDate: '2027-10-24',
  validUntil: '2099-10-20T12:00:00.000Z',
  grossPremiumMinor: 10000,
  currency: 'TRY',
  installmentCount: null,
  termsSummary: null,
};
const insurers = [
  {
    id: 'other-random',
    code: 'OTHER',
    name: 'Diğer Sigorta',
    status: 'ACTIVE',
    agencyId: 'agency',
  },
  {
    id: 'anadolu-random',
    code: 'ANADOLU',
    name: 'Anadolu Sigorta',
    status: 'ACTIVE',
    agencyId: 'agency',
  },
];
const catalogs = {
  insurers,
  products: [
    {
      id: 'anadolu-kasko',
      insurerId: 'anadolu-random',
      branchId: 'kasko',
      name: 'Anadolu Kasko',
      status: 'ACTIVE',
      agencyId: 'agency',
    },
    {
      id: 'other-kasko',
      insurerId: 'other-random',
      branchId: 'kasko',
      name: 'Diğer Kasko',
      status: 'ACTIVE',
      agencyId: 'agency',
    },
  ],
  branches: [{ id: 'kasko', name: 'Kasko', status: 'ACTIVE', agencyId: 'agency' }],
  paymentMethods: [
    {
      id: 'cash',
      name: 'Peşin',
      status: 'ACTIVE',
      supportsInstallments: false,
      maxInstallments: 1,
    },
  ],
  lossReasons: [],
  defaultInsurerId: 'other-random',
};
function response(data: unknown, status = 200) {
  return new Response(JSON.stringify({ success: status < 400, data }), { status });
}
function fixture(
  original = defaults,
  override?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined,
) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const custom = override?.(url, init);
    if (custom) return custom;
    if (url === '/api/catalogs/selectable') return response(catalogs);
    if (url.endsWith('/interactions'))
      return response({
        interactions: [],
        companyContacts: [],
        customerType: 'INDIVIDUAL',
        lastContactAt: null,
        lastAttemptAt: null,
      });
    if (url.endsWith('/quotes') && init?.method !== 'POST')
      return response({ quotes: [], defaultVersion: original });
    if (init?.method === 'POST')
      return response(
        {
          quoteId: 'q',
          quoteVersionId: 'qv',
          versionNumber: 1,
          status: 'DRAFT',
          operationId: 'op',
        },
        201,
      );
    throw new Error('Unexpected endpoint ' + url);
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
async function open() {
  render(
    <RenewalWorkspacePanel
      renewalId="renewal"
      renewalVersion={4}
      customerDisplayName="Deneme"
      getCsrfToken={async () => 'csrf'}
      invalidateCsrfToken={() => undefined}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'İletişim, teklif ve sonuçları aç: Deneme' }));
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Anadolu-focused renewal quotes', () => {
  it('keeps the original Anadolu product and offers a fast authorized create flow', async () => {
    const fetcher = fixture();
    await open();
    const insurer = await screen.findByLabelText('Teklif şirketi: Deneme');
    await waitFor(() =>
      expect((insurer as unknown as HTMLSelectElement).value).toBe(defaults.insurerId),
    );
    expect(screen.getByText('Mevcut poliçe: Anadolu Sigorta · Anadolu Kasko')).toBeTruthy();
    expect(
      (screen.getByLabelText('Teklif ürünü: Deneme') as unknown as HTMLSelectElement).value,
    ).toBe(defaults.productId);
    fireEvent.change(screen.getByLabelText('Teklif primi (TRY): Deneme'), {
      target: { value: '123,45' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Teklif oluştur: Deneme' }));
    await waitFor(() =>
      expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true),
    );
    const init = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')![1]!;
    expect(JSON.parse(String(init.body))).toEqual({
      expectedRenewalVersion: 4,
      version: { ...defaults, grossPremiumMinor: 12345 },
    });
    expect(init.headers).toMatchObject({
      'X-CSRF-Token': 'csrf',
      'Idempotency-Key': expect.any(String),
    });
  });

  it('preserves another original insurer and requires explicit Anadolu selection, product, premium and confirmation', async () => {
    const fetcher = fixture({ ...defaults, insurerId: 'other-random', productId: 'other-kasko' });
    await open();
    await screen.findByRole('button', { name: 'Anadolu Sigorta ile teklif hazırla' });
    expect(screen.getByText('Mevcut poliçe: Diğer Sigorta · Diğer Kasko')).toBeTruthy();
    expect(
      (screen.getByLabelText('Teklif şirketi: Deneme') as unknown as HTMLSelectElement).value,
    ).toBe('other-random');
    fireEvent.click(screen.getByRole('button', { name: 'Anadolu Sigorta ile teklif hazırla' }));
    expect(
      (screen.getByLabelText('Teklif ürünü: Deneme') as unknown as HTMLSelectElement).value,
    ).toBe('');
    expect((screen.getByLabelText('Teklif primi (TRY): Deneme') as HTMLInputElement).value).toBe(
      '',
    );
    expect(screen.queryByRole('option', { name: 'Diğer Kasko' })).toBeNull();
    fireEvent.change(screen.getByLabelText('Teklif ürünü: Deneme'), {
      target: { value: 'anadolu-kasko' },
    });
    fireEvent.change(screen.getByLabelText('Teklif primi (TRY): Deneme'), {
      target: { value: '150,00' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Teklif oluştur: Deneme' }));
    await screen.findByText('Yeni şirket, ürün ve prim bilgilerini kontrol edip onaylayın.');
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
    fireEvent.click(screen.getByLabelText('Yeni şirket, ürün ve prim bilgilerini kontrol ettim.'));
    fireEvent.click(screen.getByRole('button', { name: 'Teklif oluştur: Deneme' }));
    await waitFor(() =>
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1),
    );
    expect(screen.getByText('Mevcut poliçe: Diğer Sigorta · Diğer Kasko')).toBeTruthy();
    const init = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')![1]!;
    expect(JSON.parse(String(init.body)).version).toMatchObject({
      insurerId: 'anadolu-random',
      productId: 'anadolu-kasko',
      grossPremiumMinor: 15000,
      branchId: 'kasko',
    });
  });

  it('supports another active insurer without carrying an invalid product or old premium', async () => {
    const fetcher = fixture();
    await open();
    await screen.findByRole('option', { name: 'Diğer Sigorta' });
    fireEvent.change(screen.getByLabelText('Teklif şirketi: Deneme'), {
      target: { value: 'other-random' },
    });
    expect(screen.queryByRole('option', { name: 'Anadolu Kasko' })).toBeNull();
    expect((screen.getByLabelText('Teklif primi (TRY): Deneme') as HTMLInputElement).value).toBe(
      '',
    );
    fireEvent.change(screen.getByLabelText('Teklif ürünü: Deneme'), {
      target: { value: 'other-kasko' },
    });
    fireEvent.change(screen.getByLabelText('Teklif primi (TRY): Deneme'), {
      target: { value: '210.25' },
    });
    fireEvent.click(screen.getByLabelText('Yeni şirket, ürün ve prim bilgilerini kontrol ettim.'));
    fireEvent.click(screen.getByRole('button', { name: 'Teklif oluştur: Deneme' }));
    await waitFor(() =>
      expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true),
    );
    expect(
      JSON.parse(String(fetcher.mock.calls.find(([, init]) => init?.method === 'POST')![1]!.body))
        .version,
    ).toMatchObject({
      insurerId: 'other-random',
      productId: 'other-kasko',
      grossPremiumMinor: 21025,
    });
  });

  it.each(['insurer', 'product', 'branch', 'relationship'])(
    'rejects an inactive or invalid %s combination without silent replacement',
    async (kind) => {
      const data = structuredClone(catalogs);
      if (kind === 'insurer') data.insurers[1]!.status = 'INACTIVE';
      if (kind === 'product') data.products[0]!.status = 'INACTIVE';
      if (kind === 'branch') data.branches[0]!.status = 'INACTIVE';
      if (kind === 'relationship') data.products[0]!.agencyId = 'unrelated-agency';
      const fetcher = fixture(defaults, (url) =>
        url === '/api/catalogs/selectable' ? response(data) : undefined,
      );
      await open();
      await screen.findByLabelText('Teklif şirketi: Deneme');
      await waitFor(() => expect(screen.queryByText('Teklif katalogları yükleniyor…')).toBeNull());
      expect(
        (screen.getByRole('button', { name: 'Teklif oluştur: Deneme' }) as HTMLButtonElement)
          .disabled,
      ).toBe(true);
      expect(
        screen.queryByRole('button', { name: 'Anadolu Sigorta ile teklif hazırla' }),
      ).toBeNull();
      expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    },
  );

  it('identifies Anadolu by catalog name with installation-specific ID/code', async () => {
    const data = structuredClone(catalogs);
    data.insurers[1] = {
      ...data.insurers[1]!,
      id: 'company-782',
      code: 'LOCAL_CODE',
      name: 'Anadolu Sigorta',
    };
    data.products[0]!.insurerId = 'company-782';
    fixture({ ...defaults, insurerId: 'other-random', productId: 'other-kasko' }, (url) =>
      url === '/api/catalogs/selectable' ? response(data) : undefined,
    );
    await open();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Anadolu Sigorta ile teklif hazırla' }),
    );
    expect(
      (screen.getByLabelText('Teklif şirketi: Deneme') as unknown as HTMLSelectElement).value,
    ).toBe('company-782');
  });

  it('creates a new immutable quote version with current quote CAS and displays its insurer', async () => {
    const version = {
      id: 'old-version',
      version_number: 1,
      insurer_id: defaults.insurerId,
      product_id: defaults.productId,
      product_name: 'Anadolu Kasko',
      gross_premium_minor: 11000,
      currency: 'TRY',
      valid_until: '2025-01-01T00:00:00.000Z',
    };
    const quote = {
      id: 'q',
      version: 5,
      current_version_id: 'old-version',
      status: 'SENT',
      accepted_version_id: null,
      versions: [version],
      events: [],
    };
    const fetcher = fixture(defaults, (url, init) =>
      url.endsWith('/quotes') && init?.method !== 'POST'
        ? response({ quotes: [quote], defaultVersion: defaults })
        : undefined,
    );
    await open();
    const button = await screen.findByRole('button', {
      name: 'Yeni teklif sürümü oluştur: Deneme',
    });
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(screen.getByText(/Sigorta şirketi: Anadolu Sigorta · Ürün: Anadolu Kasko/)).toBeTruthy();
    expect((screen.getByLabelText('Teklif primi (TRY): Deneme') as HTMLInputElement).value).toBe(
      '110,00',
    );
    fireEvent.change(screen.getByLabelText('Teklif primi (TRY): Deneme'), {
      target: { value: '120,00' },
    });
    fireEvent.click(button);
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(
          ([url, init]) => String(url).endsWith('/versions') && init?.method === 'POST',
        ),
      ).toBe(true),
    );
    const request = fetcher.mock.calls.find(
      ([url, init]) => String(url).endsWith('/versions') && init?.method === 'POST',
    )![1]!;
    expect(JSON.parse(String(request.body))).toMatchObject({
      expectedQuoteVersion: 5,
      version: {
        insurerId: defaults.insurerId,
        productId: defaults.productId,
        grossPremiumMinor: 12000,
        validUntil: defaults.validUntil,
      },
    });
    expect(screen.getByText(/v1: 110,00 TRY/)).toBeTruthy();
  });

  it('resolves inactive original labels using existing scoped catalog endpoints', async () => {
    fixture(
      { ...defaults, insurerId: 'historical-company', productId: 'historical-product' },
      (url) => {
        if (url.endsWith('/resolve/insurer/historical-company'))
          return response({ id: 'historical-company', name: 'Eski Sigorta' });
        if (url.endsWith('/resolve/product/historical-product'))
          return response({ id: 'historical-product', name: 'Eski Kasko' });
        return undefined;
      },
    );
    await open();
    await screen.findByText('Mevcut poliçe: Eski Sigorta · Eski Kasko');
    expect(
      (screen.getByRole('button', { name: 'Teklif oluştur: Deneme' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(document.body.textContent).not.toContain('historical-company');
  });

  it('creates a separate alternative rather than changing the insurer of an existing offer', async () => {
    const version = {
      id: 'original-version',
      version_number: 1,
      insurer_id: defaults.insurerId,
      product_id: defaults.productId,
      product_name: 'Anadolu Kasko',
      gross_premium_minor: 10000,
      currency: 'TRY',
    };
    const quote = {
      id: 'original-quote',
      version: 3,
      current_version_id: version.id,
      status: 'SENT',
      accepted_version_id: null,
      versions: [version],
      events: [],
    };
    const fetcher = fixture(defaults, (url, init) =>
      url.endsWith('/quotes') && init?.method !== 'POST'
        ? response({ quotes: [quote], defaultVersion: defaults })
        : undefined,
    );
    await open();
    await screen.findByRole('option', { name: 'Diğer Sigorta' });
    fireEvent.change(screen.getByLabelText('Teklif şirketi: Deneme'), {
      target: { value: 'other-random' },
    });
    fireEvent.change(screen.getByLabelText('Teklif ürünü: Deneme'), {
      target: { value: 'other-kasko' },
    });
    fireEvent.change(screen.getByLabelText('Teklif primi (TRY): Deneme'), {
      target: { value: '200' },
    });
    fireEvent.click(screen.getByLabelText('Yeni şirket, ürün ve prim bilgilerini kontrol ettim.'));
    fireEvent.change(screen.getByLabelText('Teklif primi (TRY): Deneme'), {
      target: { value: '201' },
    });
    expect(
      (
        screen.getByLabelText(
          'Yeni şirket, ürün ve prim bilgilerini kontrol ettim.',
        ) as HTMLInputElement
      ).checked,
    ).toBe(false);
    fireEvent.click(screen.getByLabelText('Yeni şirket, ürün ve prim bilgilerini kontrol ettim.'));
    fireEvent.click(screen.getByRole('button', { name: 'Ayrı teklif oluştur: Deneme' }));
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(
          ([url, init]) => String(url).endsWith('/quotes') && init?.method === 'POST',
        ),
      ).toBe(true),
    );
    expect(
      fetcher.mock.calls.some(
        ([url, init]) => String(url).endsWith('/versions') && init?.method === 'POST',
      ),
    ).toBe(false);
    expect(screen.getByText(/Sigorta şirketi: Anadolu Sigorta · Ürün: Anadolu Kasko/)).toBeTruthy();
  });

  it('labels every saved offer with its own insurer rather than the current form choice', async () => {
    const makeQuote = (id: string, insurerId: string, productId: string, name: string) => ({
      id,
      version: 1,
      status: 'DRAFT',
      current_version_id: id + '-v',
      accepted_version_id: null,
      events: [],
      versions: [
        {
          id: id + '-v',
          insurer_id: insurerId,
          product_id: productId,
          product_name: name,
          gross_premium_minor: 10000,
          currency: 'TRY',
          version_number: 1,
        },
      ],
    });
    fixture(defaults, (url, init) =>
      url.endsWith('/quotes') && init?.method !== 'POST'
        ? response({
            defaultVersion: defaults,
            quotes: [
              makeQuote('q-a', 'anadolu-random', 'anadolu-kasko', 'Anadolu Kasko'),
              makeQuote('q-b', 'other-random', 'other-kasko', 'Diğer Kasko'),
            ],
          })
        : undefined,
    );
    await open();
    await screen.findByText(/Sigorta şirketi: Anadolu Sigorta · Ürün: Anadolu Kasko/);
    expect(screen.getByText(/Sigorta şirketi: Diğer Sigorta · Ürün: Diğer Kasko/)).toBeTruthy();
  });

  it('blocks quote writes when authorized catalogs cannot be loaded', async () => {
    const fetcher = fixture(defaults, (url) =>
      url === '/api/catalogs/selectable' ? response(null, 403) : undefined,
    );
    await open();
    await screen.findByText('Teklif katalogları yüklenemedi veya erişilemiyor.');
    expect(
      (screen.getByRole('button', { name: 'Teklif oluştur: Deneme' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
    expect(screen.getByRole('button', { name: 'Görüşmeyi kaydet: Deneme' })).toBeTruthy();
  });

  it('preserves the draft and idempotency key on retry and rejects malformed premium', async () => {
    let count = 0;
    const fetcher = fixture(defaults, (_, init) =>
      init?.method === 'POST' && ++count === 1 ? response(null, 503) : undefined,
    );
    await open();
    await screen.findByRole('option', { name: 'Anadolu Kasko' });
    const input = screen.getByLabelText('Teklif primi (TRY): Deneme');
    fireEvent.change(input, { target: { value: '1e3' } });
    fireEvent.click(screen.getByRole('button', { name: 'Teklif oluştur: Deneme' }));
    await screen.findByText(/Primi en fazla iki ondalık/);
    expect(count).toBe(0);
    fireEvent.change(input, { target: { value: '199,99' } });
    fireEvent.click(screen.getByRole('button', { name: 'Teklif oluştur: Deneme' }));
    await screen.findByText('İşlem tamamlanamadı.');
    expect((input as HTMLInputElement).value).toBe('199,99');
    fireEvent.click(screen.getByRole('button', { name: 'Teklif oluştur: Deneme' }));
    await waitFor(() => expect(count).toBe(2));
    const requests = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(requests[1]![1]!.headers).toEqual(requests[0]![1]!.headers);
    expect(requests[1]![1]!.body).toBe(requests[0]![1]!.body);
  });
});
