import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ComponentProps } from 'react';
import { App, invalidateCsrfToken } from '../src/app/App';
import { PolicyPanel } from '../src/app/components/PolicyPanel';
import { CustomerArchiveSection } from '../src/app/components/CustomerArchiveSection';
import type {
  CustomerDetailDto,
  PolicyDetailDto,
  SelectableCatalogsDto,
} from '../src/shared/types';

const customer: CustomerDetailDto = {
  id: 'customer-1',
  agencyId: 'agency-1',
  type: 'INDIVIDUAL',
  displayName: 'Ayşe Yılmaz',
  firstName: 'Ayşe',
  lastName: 'Yılmaz',
  companyTitle: null,
  email: null,
  phone: null,
  address: null,
  assigneeMembershipId: 'member-1',
  archivedAt: null,
  archivedByMembershipId: null,
  archiveReasonCode: null,
  hasIdentity: false,
  identityMasked: null,
  version: 3,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  contacts: [],
};

const policy: PolicyDetailDto = {
  id: 'policy-1',
  agencyId: 'agency-1',
  customerId: customer.id,
  insurerId: 'insurer-1',
  productId: 'product-1',
  branchId: 'branch-1',
  paymentMethodId: 'payment-1',
  assigneeMembershipId: 'member-1',
  policyNumber: 'P-2026-001',
  normalizedPolicyNumber: 'P2026001',
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  grossPremiumMinor: 123456,
  currency: 'TRY',
  installmentCount: null,
  status: 'ACTIVE',
  identityVariant: 0,
  archivedAt: null,
  archivedByMembershipId: null,
  archiveReason: null,
  version: 4,
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
  customer: { id: customer.id, displayName: customer.displayName },
  insurer: { id: 'insurer-1', name: 'Anadolu Sigorta', status: 'ACTIVE' },
  product: { id: 'product-1', name: 'Kasko', status: 'ACTIVE' },
  branch: { id: 'branch-1', name: 'Kasko', status: 'ACTIVE', dataClassification: 'GENERAL' },
  paymentMethod: { id: 'payment-1', name: 'Peşin', status: 'ACTIVE' },
};

const catalogs: SelectableCatalogsDto = {
  insurers: [
    {
      id: 'insurer-1',
      agencyId: 'agency-1',
      code: 'ANADOLU',
      name: 'Anadolu Sigorta',
      status: 'ACTIVE',
      version: 1,
      createdAt: '',
      updatedAt: '',
    },
  ],
  branches: [
    {
      id: 'branch-1',
      agencyId: 'agency-1',
      code: 'KASKO',
      name: 'Kasko',
      dataClassification: 'GENERAL',
      status: 'ACTIVE',
      version: 1,
      createdAt: '',
      updatedAt: '',
    },
    {
      id: 'branch-health',
      agencyId: 'agency-1',
      code: 'TSS',
      name: 'Tamamlayıcı Sağlık',
      dataClassification: 'HEALTH',
      status: 'ACTIVE',
      version: 1,
      createdAt: '',
      updatedAt: '',
    },
  ],
  products: [
    {
      id: 'product-1',
      agencyId: 'agency-1',
      insurerId: 'insurer-1',
      branchId: 'branch-1',
      code: 'KASKO',
      name: 'Kasko',
      status: 'ACTIVE',
      version: 1,
      createdAt: '',
      updatedAt: '',
    },
    {
      id: 'product-health',
      agencyId: 'agency-1',
      insurerId: 'insurer-1',
      branchId: 'branch-health',
      code: 'TSS',
      name: 'Tamamlayıcı Sağlık',
      status: 'ACTIVE',
      version: 1,
      createdAt: '',
      updatedAt: '',
    },
  ],
  paymentMethods: [
    {
      id: 'payment-1',
      agencyId: 'agency-1',
      code: 'CASH',
      name: 'Peşin',
      supportsInstallments: false,
      maxInstallments: 12,
      status: 'ACTIVE',
      version: 1,
      createdAt: '',
      updatedAt: '',
    },
  ],
  lossReasons: [],
  defaultInsurerId: 'insurer-1',
};

function response(data: unknown, status = 200) {
  return Promise.resolve({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => 'application/json' },
    json: async () => data,
  });
}

function installBaseFetch(
  overrides?: (url: string, init?: RequestInit) => Promise<unknown> | undefined,
) {
  global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
    const overridden = overrides?.(url, init);
    if (overridden) return overridden;
    if (url === '/api/csrf-token')
      return response({ success: true, data: { token: 'csrf-token' } });
    if (url === '/api/policies?pageSize=20&sort=end_date_asc')
      return response({
        success: true,
        data: { items: [policy], nextCursor: null, hasMore: false },
      });
    if (url === '/api/policies/policy-1') return response({ success: true, data: policy });
    if (url === '/api/catalogs/selectable') return response({ success: true, data: catalogs });
    if (url === '/api/customers?limit=100')
      return response({
        success: true,
        data: { items: [customer], nextCursor: null, hasMore: false },
      });
    if (url === '/api/policies/policy-1/assignment-options')
      return response({
        success: true,
        data: [
          { membershipId: 'member-1', label: 'owner@test.test', membershipType: 'OWNER' },
          { membershipId: 'member-2', label: 'agent@test.test', membershipType: 'MEMBER' },
        ],
      });
    if (url === '/api/policies/policy-1/parties') return response({ success: true, data: [] });
    if (url === '/api/policies/policy-1/amendments') return response({ success: true, data: [] });
    if (url === '/api/policies/policy-1/external-references')
      return response({ success: true, data: [] });
    return response({ success: true, data: {} });
  });
}

async function openPolicyDetail(props: ComponentProps<typeof PolicyPanel> = {}) {
  render(<PolicyPanel {...props} />);
  fireEvent.click(await screen.findByRole('button', { name: /Detayı Aç/i }));
  await screen.findByText('Poliçe Detayı');
}

describe('M2 Batch-B policy/customer lifecycle UI', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    invalidateCsrfToken();
  });

  it('lists policies, opens canonical detail and describes one contract period without renewal semantics', async () => {
    installBaseFetch();
    await openPolicyDetail();
    expect(screen.getAllByText('P-2026-001')).toHaveLength(2);
    expect(
      screen.getAllByText((_, element) => element?.textContent?.includes('1.234,56') ?? false)
        .length,
    ).toBeGreaterThan(0);
    expect(screen.getByText(/tek sözleşme dönemini temsil eder/i)).toBeTruthy();
    expect(screen.queryByText(/yenileme oluştur/i)).toBeNull();
  });

  it('loads later policy pages from the server cursor', async () => {
    const secondPolicy = { ...policy, id: 'policy-2', policyNumber: 'P-2026-002' };
    installBaseFetch((url) => {
      if (url === '/api/policies?pageSize=20&sort=end_date_asc') {
        return response({
          success: true,
          data: { items: [policy], nextCursor: 'next-page', hasMore: true },
        });
      }
      if (url === '/api/policies?pageSize=20&sort=end_date_asc&cursor=next-page') {
        return response({
          success: true,
          data: { items: [secondPolicy], nextCursor: null, hasMore: false },
        });
      }
      return undefined;
    });
    render(<PolicyPanel />);
    fireEvent.click(await screen.findByRole('button', { name: /Daha Fazla Poliçe/i }));
    expect(await screen.findByText('P-2026-002')).toBeTruthy();
  });

  it('searches the policy list by policy number through the server query', async () => {
    let searchUrl = '';
    installBaseFetch((url) => {
      if (url.includes('&search=')) {
        searchUrl = url;
        return response({
          success: true,
          data: { items: [policy], nextCursor: null, hasMore: false },
        });
      }
      return undefined;
    });
    render(<PolicyPanel />);
    await screen.findByText('P-2026-001');
    fireEvent.change(screen.getByRole('textbox', { name: /Poliçe numarası ara/i }), {
      target: { value: 'P-2026' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Poliçelerde Ara/i }));
    await waitFor(() => expect(searchUrl).toContain('search=P-2026'));
    expect(await screen.findByText('P-2026-001')).toBeTruthy();
  });

  it('creates a policy from Customer -> Add Policy with real CSRF and no authority fields', async () => {
    let captured: {
      url?: string;
      headers?: Record<string, string>;
      body?: Record<string, unknown>;
    } = {};
    installBaseFetch((url, init) => {
      if (url === '/api/customers?limit=20')
        return response({
          success: true,
          data: { items: [customer], nextCursor: null, hasMore: false },
        });
      if (url === '/api/customers/customer-1') return response({ success: true, data: customer });
      if (url === '/api/customers/customer-1/assignment-options')
        return response({ success: true, data: [] });
      if (url === '/api/customers/customer-1/external-references')
        return response({ success: true, data: [] });
      if (url === '/api/policies' && init?.method === 'POST') {
        captured = {
          url,
          headers: init.headers as Record<string, string>,
          body: JSON.parse(init.body as string),
        };
        return response({ success: true, data: policy }, 201);
      }
      return undefined;
    });
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Müşteriler' }));
    fireEvent.click(await screen.findByRole('button', { name: /Detay & Yetkililer/i }));
    fireEvent.click(await screen.findByRole('button', { name: /Poliçe Ekle/i }));
    await waitFor(() =>
      expect((screen.getByLabelText('Müşteri') as unknown as HTMLSelectElement).value).toBe(
        'customer-1',
      ),
    );
    fireEvent.change(screen.getByLabelText('Poliçe Numarası'), { target: { value: 'P-2027-001' } });
    fireEvent.change(screen.getByLabelText('Başlangıç Tarihi'), {
      target: { value: '2027-01-01' },
    });
    fireEvent.change(screen.getByLabelText('Bitiş Tarihi'), { target: { value: '2027-12-31' } });
    fireEvent.change(screen.getByLabelText('Brüt Prim'), { target: { value: '1500.25' } });
    fireEvent.click(screen.getByRole('button', { name: /Poliçeyi Kaydet/i }));
    await waitFor(() => expect(captured.url).toBe('/api/policies'));
    expect(captured.headers?.['X-CSRF-Token']).toBe('csrf-token');
    expect(captured.headers?.['Idempotency-Key']).toBeTruthy();
    expect(captured.body?.customerId).toBe('customer-1');
    expect(captured.body).not.toHaveProperty('agencyId');
    expect(captured.body).not.toHaveProperty('role');
    expect(captured.body).not.toHaveProperty('identityVariant');
  });

  it('edits only accepted policy fields and never sends assignee or identityVariant through PATCH', async () => {
    let body: Record<string, unknown> | undefined;
    installBaseFetch((url, init) => {
      if (url === '/api/policies/policy-1' && init?.method === 'PATCH') {
        body = JSON.parse(init.body as string);
        return response({
          success: true,
          data: { ...policy, policyNumber: 'P-UPDATED', version: 5 },
        });
      }
      return undefined;
    });
    await openPolicyDetail();
    fireEvent.click(screen.getByRole('button', { name: /Poliçeyi Düzenle/i }));
    fireEvent.change(screen.getByLabelText('Poliçe Numarası'), { target: { value: 'P-UPDATED' } });
    fireEvent.click(screen.getByRole('button', { name: /Değişiklikleri Kaydet/i }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body).toMatchObject({ expectedVersion: 4, policyNumber: 'P-UPDATED' });
    expect(body).not.toHaveProperty('assigneeMembershipId');
    expect(body).not.toHaveProperty('identityVariant');
  });

  it('keeps exact minor-unit premium text and selects a compatible product while editing', async () => {
    const highValuePolicy = { ...policy, grossPremiumMinor: Number.MAX_SAFE_INTEGER };
    installBaseFetch((url) => {
      if (url === '/api/policies/policy-1') {
        return response({ success: true, data: highValuePolicy });
      }
      return undefined;
    });
    await openPolicyDetail();
    expect(screen.getAllByText(/90\.071\.992\.547\.409,91/).length).toBeGreaterThan(0);
    fireEvent.click(screen.getByRole('button', { name: /Poliçeyi Düzenle/i }));
    expect((screen.getByLabelText('Brüt Prim') as unknown as HTMLInputElement).value).toBe(
      '90071992547409.91',
    );
    await screen.findByRole('option', { name: 'Tamamlayıcı Sağlık' });
    fireEvent.change(screen.getByLabelText('Branş'), { target: { value: 'branch-health' } });
    await waitFor(() =>
      expect((screen.getByLabelText('Ürün') as unknown as HTMLSelectElement).value).toBe(
        'product-health',
      ),
    );
  });

  it('collects installment count when the selected payment method supports installments', async () => {
    let body: Record<string, unknown> | undefined;
    const installmentCatalogs: SelectableCatalogsDto = {
      ...catalogs,
      paymentMethods: [
        {
          ...catalogs.paymentMethods[0]!,
          id: 'payment-installment',
          name: 'Kredi Kartı',
          supportsInstallments: true,
          maxInstallments: 12,
        },
      ],
    };
    installBaseFetch((url, init) => {
      if (url === '/api/catalogs/selectable') {
        return response({ success: true, data: installmentCatalogs });
      }
      if (url === '/api/policies' && init?.method === 'POST') {
        body = JSON.parse(init.body as string);
        return response({ success: true, data: policy }, 201);
      }
      return undefined;
    });
    render(
      <PolicyPanel initialCustomer={{ id: customer.id, displayName: customer.displayName }} />,
    );
    fireEvent.change(await screen.findByLabelText('Poliçe Numarası'), {
      target: { value: 'P-INSTALLMENT' },
    });
    fireEvent.change(screen.getByLabelText('Başlangıç Tarihi'), {
      target: { value: '2027-01-01' },
    });
    fireEvent.change(screen.getByLabelText('Bitiş Tarihi'), {
      target: { value: '2027-12-31' },
    });
    fireEvent.change(screen.getByLabelText('Brüt Prim'), { target: { value: '1200.00' } });
    fireEvent.change(await screen.findByLabelText('Taksit Sayısı'), { target: { value: '6' } });
    fireEvent.click(screen.getByRole('button', { name: /Poliçeyi Kaydet/i }));
    await waitFor(() => expect(body?.installmentCount).toBe(6));
  });

  it('uses explicit policy assignment with active server options and preserves retry idempotency', async () => {
    const keys: string[] = [];
    let attempts = 0;
    installBaseFetch((url, init) => {
      if (url === '/api/policies/policy-1/assign' && init?.method === 'POST') {
        keys.push((init.headers as Record<string, string>)['Idempotency-Key']!);
        attempts++;
        if (attempts === 1) return Promise.reject(new TypeError('lost response'));
        return response({
          success: true,
          data: { ...policy, assigneeMembershipId: 'member-2', version: 5 },
        });
      }
      return undefined;
    });
    await openPolicyDetail();
    fireEvent.change(await screen.findByLabelText('Poliçe Sorumlusu'), {
      target: { value: 'member-2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sorumluyu Ata' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Tekrar Dene' }));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[0]).toBe(keys[1]);
  });

  it('shows health classification without treating UI hiding as authorization and keeps sensitive values out of URLs/storage', async () => {
    installBaseFetch();
    render(
      <PolicyPanel initialCustomer={{ id: customer.id, displayName: customer.displayName }} />,
    );
    fireEvent.change(await screen.findByLabelText('Branş'), { target: { value: 'branch-health' } });
    expect(
      screen.getByText(/sağlık sınıfındadır.*sunucu ayrıca hassas sağlık yetkisini denetler/i),
    ).toBeTruthy();
    const calls = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.map(([url]) => String(url));
    expect(calls.every((url) => !url.includes('P-2026-001'))).toBe(true);
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('creates and deactivates PolicyParty without linking to the related customer portfolio', async () => {
    const calls: Array<{ url: string; body?: unknown }> = [];
    const activeParty = {
      id: 'party-1',
      agencyId: 'agency-1',
      policyId: 'policy-1',
      customerId: 'customer-1',
      customerDisplayName: 'Ayşe Yılmaz',
      role: 'INSURED',
      status: 'ACTIVE',
      version: 1,
      deactivatedAt: null,
      deactivatedByMembershipId: null,
      createdAt: '',
      updatedAt: '',
    };
    installBaseFetch((url, init) => {
      if (url === '/api/policies/policy-1/parties' && init?.method === 'POST') {
        calls.push({ url, body: JSON.parse(init.body as string) });
        return response({ success: true, data: activeParty }, 201);
      }
      if (url === '/api/policies/policy-1/parties/party-1/deactivate' && init?.method === 'POST') {
        calls.push({ url, body: JSON.parse(init.body as string) });
        return response({
          success: true,
          data: { ...activeParty, status: 'INACTIVE', version: 2 },
        });
      }
      if (url === '/api/policies/policy-1/parties')
        return response({ success: true, data: calls.length ? [activeParty] : [] });
      return undefined;
    });
    await openPolicyDetail();
    fireEvent.click(screen.getByRole('button', { name: /Taraf Ekle/i }));
    fireEvent.click(screen.getByRole('button', { name: /Tarafı Kaydet/i }));
    const deactivateButton = await screen.findByRole('button', { name: /Tarafı Pasifleştir/i });
    expect(deactivateButton.parentElement?.textContent).toContain('Ayşe Yılmaz');
    expect(screen.queryByRole('link', { name: /Ayşe Yılmaz/i })).toBeNull();
    fireEvent.click(deactivateButton);
    await waitFor(() => expect(calls[1]?.url).toContain('/deactivate'));
  });

  it('creates a minimal amendment with decimal-string money and presents it as an amendment, not renewal', async () => {
    let body: Record<string, unknown> | undefined;
    installBaseFetch((url, init) => {
      if (url === '/api/policies/policy-1/amendments' && init?.method === 'POST') {
        body = JSON.parse(init.body as string);
        return response(
          {
            success: true,
            data: {
              id: 'am-1',
              agencyId: 'agency-1',
              policyId: 'policy-1',
              externalReference: 'ZY-42',
              effectiveDate: '2026-05-01',
              description: 'Teminat düzeltmesi',
              premiumDifferenceMinor: -50,
              currency: 'TRY',
              createdAt: '',
            },
          },
          201,
        );
      }
      if (url === '/api/policies/policy-1/amendments')
        return response({
          success: true,
          data: body
            ? [
                {
                  id: 'am-1',
                  agencyId: 'agency-1',
                  policyId: 'policy-1',
                  externalReference: 'ZY-42',
                  effectiveDate: '2026-05-01',
                  description: 'Teminat düzeltmesi',
                  premiumDifferenceMinor: -50,
                  currency: 'TRY',
                  createdAt: '',
                },
              ]
            : [],
        });
      return undefined;
    });
    await openPolicyDetail();
    fireEvent.click(screen.getByRole('button', { name: /Zeyil Ekle/i }));
    fireEvent.change(screen.getByLabelText('Zeyil Referansı'), { target: { value: 'ZY-42' } });
    fireEvent.change(screen.getByLabelText('Yürürlük Tarihi'), { target: { value: '2026-05-01' } });
    fireEvent.change(screen.getByLabelText('Zeyil Açıklaması'), {
      target: { value: 'Teminat düzeltmesi' },
    });
    fireEvent.change(screen.getByLabelText('Prim Farkı'), { target: { value: '-0.50' } });
    fireEvent.click(screen.getByRole('button', { name: /Zeyli Kaydet/i }));
    await waitFor(() =>
      expect(body).toMatchObject({ premiumDifference: '-0.50', currency: 'TRY' }),
    );
    expect(body).not.toHaveProperty('premiumDifferenceMinor');
    const amendmentRow = await screen.findByText(/Teminat düzeltmesi/);
    expect(amendmentRow.textContent).toContain('-0,50');
    expect(screen.getByText(/yeni poliçe veya yeni sözleşme dönemi oluşturmaz/i)).toBeTruthy();
  });

  it('keeps exact external-reference retry key and does not disguise a domain duplicate as replay success', async () => {
    const keys: string[] = [];
    let attempts = 0;
    installBaseFetch((url, init) => {
      if (url === '/api/policies/policy-1/external-references' && init?.method === 'POST') {
        keys.push((init.headers as Record<string, string>)['Idempotency-Key']!);
        attempts++;
        if (attempts === 1) return Promise.reject(new TypeError('lost response'));
        if (attempts === 2)
          return response(
            {
              success: true,
              data: {
                id: 'ref-1',
                agencyId: 'agency-1',
                policyId: 'policy-1',
                sourceNamespace: 'IMPORT',
                externalKey: 'EXT-1',
                createdAt: '',
              },
              replayed: true,
            },
            201,
          );
        return response(
          {
            success: false,
            error: {
              code: 'DUPLICATE_EXTERNAL_REFERENCE',
              message: 'unsafe raw duplicate details',
            },
          },
          409,
        );
      }
      return undefined;
    });
    await openPolicyDetail();
    fireEvent.click(screen.getByRole('button', { name: /Referans Ekle/i }));
    fireEvent.change(screen.getByLabelText('Kaynak Sistem'), { target: { value: 'IMPORT' } });
    fireEvent.change(screen.getByLabelText('Harici Anahtar'), { target: { value: 'EXT-1' } });
    fireEvent.click(screen.getByRole('button', { name: /Referansı Kaydet/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Tekrar Dene' }));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[0]).toBe(keys[1]);
    fireEvent.click(screen.getByRole('button', { name: /Referans Ekle/i }));
    fireEvent.change(screen.getByLabelText('Kaynak Sistem'), { target: { value: 'IMPORT' } });
    fireEvent.change(screen.getByLabelText('Harici Anahtar'), { target: { value: 'EXT-1' } });
    fireEvent.click(screen.getByRole('button', { name: /Referansı Kaydet/i }));
    expect(await screen.findByText('Bu harici referans zaten mevcut.')).toBeTruthy();
    expect(screen.queryByText('unsafe raw duplicate details')).toBeNull();
  });

  it('archives customers explicitly, requires a reason and renders OPEN_DEPENDENCIES safely', async () => {
    let body: unknown;
    installBaseFetch((url, init) => {
      if (url === '/api/customers/customer-1/archive' && init?.method === 'POST') {
        body = JSON.parse(init.body as string);
        return response(
          {
            success: false,
            error: { code: 'OPEN_DEPENDENCIES', message: 'raw SQL and identifiers' },
          },
          409,
        );
      }
      return undefined;
    });
    render(<CustomerArchiveSection customer={customer} onCustomerReload={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /Müşteriyi Arşivle/i }));
    expect(screen.getByText(/silme işlemi değildir/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Arşiv Nedeni'), {
      target: { value: 'PORTFOLIO_CLOSED' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Arşivlemeyi Onayla/i }));
    await waitFor(() =>
      expect(body).toEqual({ expectedVersion: 3, reasonCode: 'PORTFOLIO_CLOSED' }),
    );
    expect(await screen.findByText(/önce açık poliçe ve işleri sonuçlandırın/i)).toBeTruthy();
    expect(screen.queryByText(/raw SQL/)).toBeNull();
  });

  it('archives a policy without presenting archive as cancellation or voiding', async () => {
    let body: unknown;
    installBaseFetch((url, init) => {
      if (url === '/api/policies/policy-1/archive' && init?.method === 'POST') {
        body = JSON.parse(init.body as string);
        return response({
          success: true,
          data: {
            ...policy,
            archivedAt: '2026-09-21T00:00:00Z',
            archiveReason: 'DUPLICATE_RECORD',
            version: 5,
          },
        });
      }
      return undefined;
    });
    await openPolicyDetail();
    fireEvent.click(screen.getByRole('button', { name: /Poliçeyi Arşivle/i }));
    expect(screen.getByText(/iptal.*void.*değildir/i)).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Arşiv Nedeni'), {
      target: { value: 'DUPLICATE_RECORD' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Arşivlemeyi Onayla/i }));
    await waitFor(() =>
      expect(body).toEqual({ expectedVersion: 4, reasonCode: 'DUPLICATE_RECORD' }),
    );
  });

  it('shows create network errors and retries with the same idempotency key', async () => {
    const keys: string[] = [];
    let attempts = 0;
    installBaseFetch((url, init) => {
      if (url === '/api/policies' && init?.method === 'POST') {
        keys.push((init.headers as Record<string, string>)['Idempotency-Key']!);
        attempts++;
        if (attempts === 1) return Promise.reject(new TypeError('lost response'));
        return response({ success: true, data: policy }, 201);
      }
      return undefined;
    });
    render(
      <PolicyPanel initialCustomer={{ id: customer.id, displayName: customer.displayName }} />,
    );
    fireEvent.change(await screen.findByLabelText('Poliçe Numarası'), {
      target: { value: 'P-RETRY' },
    });
    fireEvent.change(screen.getByLabelText('Başlangıç Tarihi'), {
      target: { value: '2027-01-01' },
    });
    fireEvent.change(screen.getByLabelText('Bitiş Tarihi'), {
      target: { value: '2027-12-31' },
    });
    fireEvent.change(screen.getByLabelText('Brüt Prim'), { target: { value: '100.00' } });
    fireEvent.click(screen.getByRole('button', { name: /Poliçeyi Kaydet/i }));
    fireEvent.click(await screen.findByRole('button', { name: 'Tekrar Dene' }));
    await waitFor(() => expect(keys).toHaveLength(2));
    expect(keys[0]).toBe(keys[1]);
  });

  it('clears a failed mutation before opening another policy detail', async () => {
    const secondPolicy = { ...policy, id: 'policy-2', policyNumber: 'P-2026-002' };
    installBaseFetch((url, init) => {
      if (url === '/api/policies?pageSize=20&sort=end_date_asc')
        return response({
          success: true,
          data: { items: [policy, secondPolicy], nextCursor: null, hasMore: false },
        });
      if (url === '/api/policies/policy-2') return response({ success: true, data: secondPolicy });
      if (url === '/api/policies/policy-1/assign' && init?.method === 'POST')
        return Promise.reject(new TypeError('lost response'));
      return undefined;
    });
    render(<PolicyPanel />);
    const detailButtons = await screen.findAllByRole('button', { name: /Detayı Aç/i });
    fireEvent.click(detailButtons[0]!);
    fireEvent.change(await screen.findByLabelText('Poliçe Sorumlusu'), {
      target: { value: 'member-2' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Sorumluyu Ata' }));
    expect(await screen.findByRole('button', { name: 'Tekrar Dene' })).toBeTruthy();
    fireEvent.click(detailButtons[1]!);
    await screen.findByText('P-2026-002');
    expect(screen.queryByRole('button', { name: 'Tekrar Dene' })).toBeNull();
  });

  it('patches only changed fields when historical catalogs are inactive', async () => {
    let body: Record<string, unknown> | undefined;
    const historical = {
      ...policy,
      insurer: { ...policy.insurer, status: 'INACTIVE' as const },
      product: { ...policy.product, status: 'INACTIVE' as const },
    };
    installBaseFetch((url, init) => {
      if (url === '/api/policies/policy-1') {
        if (init?.method === 'PATCH') {
          body = JSON.parse(init.body as string);
          return response({ success: true, data: historical });
        }
        return response({ success: true, data: historical });
      }
      if (url === '/api/catalogs/selectable')
        return response({ success: true, data: { ...catalogs, insurers: [], products: [] } });
      return undefined;
    });
    await openPolicyDetail();
    fireEvent.click(screen.getByRole('button', { name: /Poliçeyi Düzenle/i }));
    fireEvent.change(screen.getByLabelText('Poliçe Numarası'), {
      target: { value: 'P-CORRECTED' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Değişiklikleri Kaydet/i }));
    await waitFor(() => expect(body).toBeDefined());
    expect(body).toEqual({ expectedVersion: 4, policyNumber: 'P-CORRECTED' });
  });

  it('marks archived policies and removes mutation controls', async () => {
    installBaseFetch((url) => {
      if (url === '/api/policies/policy-1')
        return response({
          success: true,
          data: {
            ...policy,
            archivedAt: '2026-09-21T00:00:00.000Z',
            archivedByMembershipId: 'member-1',
            archiveReason: 'DUPLICATE_RECORD',
          },
        });
      return undefined;
    });
    await openPolicyDetail();
    expect(screen.getByText(/Arşivlenmiş poliçe/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Poliçeyi Düzenle/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Poliçeyi Arşivle/i })).toBeNull();
    expect(screen.queryByRole('button', { name: /Taraf Ekle/i })).toBeNull();
  });

  it('shows related-section failures and allows an explicit retry', async () => {
    let attempts = 0;
    installBaseFetch((url) => {
      if (url === '/api/policies/policy-1/parties') {
        attempts++;
        if (attempts === 1)
          return response({ success: false, error: { code: 'INTERNAL_ERROR' } }, 500);
        return response({ success: true, data: [] });
      }
      return undefined;
    });
    await openPolicyDetail();
    fireEvent.click(
      await screen.findByRole('button', { name: /İlişkili Verileri Yeniden Yükle/i }),
    );
    await waitFor(() => expect(attempts).toBe(2));
  });

  it('navigates at top level to secure confirmation without putting reason in the URL', async () => {
    const navigateToSecure = vi.fn();
    installBaseFetch();
    await openPolicyDetail({ navigateToSecure });
    fireEvent.click(screen.getByRole('button', { name: /Güvenli Kimlik Varyantı/i }));
    expect(navigateToSecure).toHaveBeenCalledWith(
      '/secure/confirm/policies/policy-1/identity-variant',
    );
    expect(navigateToSecure.mock.calls[0]?.[0]).not.toContain('reason');
    const secureFetches = (global.fetch as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) =>
      String(url).startsWith('/secure/'),
    );
    expect(secureFetches).toHaveLength(0);
  });
});
