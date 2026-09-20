import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { App, invalidateCsrfToken } from '../src/app/App';
import type {
  InsurerDto,
  InsuranceBranchDto,
  InsuranceProductDto,
  PaymentMethodDto,
  LossReasonDto,
  AgencySettingsDto,
  SelectableCatalogsDto,
} from '../src/shared/types';

describe('M2-T03 UI Kabul Testleri (Catalogs & Agency Settings)', () => {
  const mockInsurers: InsurerDto[] = [
    {
      id: 'ins-1',
      agencyId: 'agency-1',
      code: 'ANADOLU',
      name: 'Anadolu Sigorta',
      status: 'ACTIVE',
      version: 1,
      createdAt: '2026-09-20T10:00:00.000Z',
      updatedAt: '2026-09-20T10:00:00.000Z',
    },
    {
      id: 'ins-2',
      agencyId: 'agency-1',
      code: 'ALLIANZ',
      name: 'Allianz Sigorta',
      status: 'INACTIVE',
      version: 2,
      createdAt: '2026-09-20T10:00:00.000Z',
      updatedAt: '2026-09-20T10:00:00.000Z',
    },
  ];

  const mockBranches: InsuranceBranchDto[] = [
    {
      id: 'br-1',
      agencyId: 'agency-1',
      code: 'KASKO',
      name: 'Kasko Branşı',
      status: 'ACTIVE',
      version: 1,
      createdAt: '2026-09-20T10:00:00.000Z',
      updatedAt: '2026-09-20T10:00:00.000Z',
    },
    {
      id: 'br-2',
      agencyId: 'agency-1',
      code: 'TSS',
      name: 'Tamamlayıcı Sağlık',
      status: 'INACTIVE',
      version: 1,
      createdAt: '2026-09-20T10:00:00.000Z',
      updatedAt: '2026-09-20T10:00:00.000Z',
    },
  ];

  const mockProducts: InsuranceProductDto[] = [
    {
      id: 'prod-1',
      agencyId: 'agency-1',
      insurerId: 'ins-1',
      branchId: 'br-1',
      code: 'ANADOLU_KASKO_GENIS',
      name: 'Genişletilmiş Kasko',
      status: 'ACTIVE',
      version: 1,
      createdAt: '2026-09-20T10:00:00.000Z',
      updatedAt: '2026-09-20T10:00:00.000Z',
    },
  ];

  const mockPaymentMethods: PaymentMethodDto[] = [
    {
      id: 'pm-1',
      agencyId: 'agency-1',
      code: 'CREDIT_CARD',
      name: 'Kredi Kartı',
      status: 'ACTIVE',
      version: 1,
      createdAt: '2026-09-20T10:00:00.000Z',
      updatedAt: '2026-09-20T10:00:00.000Z',
    },
  ];

  const mockLossReasons: LossReasonDto[] = [
    {
      id: 'lr-1',
      agencyId: 'agency-1',
      code: 'PRICE_HIGH',
      name: 'Fiyat Yüksek Bulundu',
      status: 'ACTIVE',
      version: 1,
      createdAt: '2026-09-20T10:00:00.000Z',
      updatedAt: '2026-09-20T10:00:00.000Z',
    },
  ];

  const mockAgencySettings: AgencySettingsDto = {
    id: 'set-1',
    agencyId: 'agency-1',
    defaultInsurerId: 'ins-1',
    timezone: 'Europe/Istanbul',
    renewalWindowDays: 30,
    version: 1,
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:00.000Z',
  };

  const mockSelectable: SelectableCatalogsDto = {
    insurers: [mockInsurers[0]!],
    branches: [mockBranches[0]!],
    products: [mockProducts[0]!],
    paymentMethods: [mockPaymentMethods[0]!],
    lossReasons: [mockLossReasons[0]!],
    defaultInsurerId: 'ins-1',
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    invalidateCsrfToken();
  });

  it('1. Kataloglar sekmesinde aktif liste görünmeli, inaktifler varsayılanda listelenmemelidir', async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/catalogs/insurers') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: mockInsurers.filter((i) => i.status === 'ACTIVE'),
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: [] }),
      });
    });

    render(<App />);
    const catalogsNavBtn = await screen.findByRole('button', { name: 'Kataloglar' });
    fireEvent.click(catalogsNavBtn);

    await screen.findByText('Anadolu Sigorta');
    expect(screen.queryByText('Allianz Sigorta')).toBeNull();
  });

  it('2. "İnaktifleri Göster" seçildiğinde include_inactive=true ile çağrı yapılmalı ve INACTIVE rozeti gösterilmelidir', async () => {
    let capturedUrl = '';
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/catalogs/insurers')) {
        capturedUrl = url;
        if (url.includes('include_inactive=true')) {
          return Promise.resolve({
            ok: true,
            status: 200,
            json: async () => ({ success: true, data: mockInsurers }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: mockInsurers.filter((i) => i.status === 'ACTIVE'),
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: [] }),
      });
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Kataloglar' }));
    await screen.findByText('Anadolu Sigorta');

    const toggleInactive = screen.getByLabelText(/İnaktifleri Göster|Tümünü Göster/i);
    fireEvent.click(toggleInactive);

    await screen.findByText('Allianz Sigorta');
    expect(capturedUrl).toContain('include_inactive=true');
    expect(screen.getAllByText('INACTIVE').length).toBeGreaterThanOrEqual(1);
  });

  it('3. Sigortacı oluşturma POST /api/catalogs/insurers ile yapılmalıdır', async () => {
    let capturedPostHeaders: Record<string, string> = {};
    let capturedPostBody: unknown = null;

    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/csrf-token')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { token: 'csrf-catalog-token' } }),
        });
      }
      if (url.includes('/api/catalogs/insurers') && init?.method === 'POST') {
        capturedPostHeaders = (init.headers ?? {}) as Record<string, string>;
        capturedPostBody = JSON.parse(init.body as string);
        return Promise.resolve({
          ok: true,
          status: 201,
          json: async () => ({
            success: true,
            data: {
              id: 'ins-new',
              agencyId: 'agency-1',
              code: 'AKSIGORTA',
              name: 'Aksigorta',
              status: 'ACTIVE',
              version: 1,
              createdAt: '2026-09-20T10:00:00.000Z',
              updatedAt: '2026-09-20T10:00:00.000Z',
            },
          }),
        });
      }
      if (url.includes('/api/catalogs/insurers')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: mockInsurers.filter((i) => i.status === 'ACTIVE'),
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: [] }),
      });
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Kataloglar' }));
    await screen.findByText('Anadolu Sigorta');

    fireEvent.click(
      screen.getByRole('button', { name: /Yeni Sigorta Şirketi|Yeni Ekle|\+ Ekle/i }),
    );

    const codeInput = screen.getByPlaceholderText(/Kod \(Örn: AKSIGORTA\)|Kod/i);
    const nameInput = screen.getByPlaceholderText(/İsim \(Örn: Aksigorta\)|İsim|Ad/i);
    fireEvent.change(codeInput, { target: { value: 'AKSIGORTA' } });
    fireEvent.change(nameInput, { target: { value: 'Aksigorta' } });

    fireEvent.click(screen.getByRole('button', { name: /Kaydet/i }));

    await waitFor(() => {
      expect(capturedPostHeaders['X-CSRF-Token']).toBe('csrf-catalog-token');
      expect(capturedPostHeaders['Idempotency-Key']).toBeDefined();
      expect(capturedPostBody).toEqual({
        code: 'AKSIGORTA',
        name: 'Aksigorta',
      });
    });
  });

  it('4. Sigortacı güncelleme PATCH ile yapılmalı, kod alanı düzenlenemez (immutable) olmalıdır', async () => {
    let capturedPatchBody: unknown = null;

    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/csrf-token')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { token: 'csrf-update' } }),
        });
      }
      if (url === '/api/catalogs/insurers/ins-1' && init?.method === 'PATCH') {
        capturedPatchBody = JSON.parse(init.body as string);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { ...mockInsurers[0], name: 'Anadolu Anonim Türk Sigorta Şirketi', version: 2 },
          }),
        });
      }
      if (url.includes('/api/catalogs/insurers')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: mockInsurers.filter((i) => i.status === 'ACTIVE'),
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: [] }),
      });
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Kataloglar' }));
    await screen.findByText('Anadolu Sigorta');

    fireEvent.click(screen.getByRole('button', { name: /Düzenle/i }));

    // Kod alanı disabled veya readOnly olmalıdır
    const codeDisplayOrInput = screen.getByDisplayValue('ANADOLU');
    expect(
      (codeDisplayOrInput as HTMLInputElement).disabled ||
        (codeDisplayOrInput as HTMLInputElement).readOnly,
    ).toBe(true);

    const nameInput = screen.getByDisplayValue('Anadolu Sigorta');
    fireEvent.change(nameInput, { target: { value: 'Anadolu Anonim Türk Sigorta Şirketi' } });

    fireEvent.click(screen.getByRole('button', { name: /Güncelle|Kaydet/i }));

    await waitFor(() => {
      expect(capturedPatchBody).toEqual({
        expectedVersion: 1,
        name: 'Anadolu Anonim Türk Sigorta Şirketi',
      });
      expect(capturedPatchBody).not.toHaveProperty('code');
    });
  });

  it('5. Sigortacı pasifleştirme POST /api/catalogs/insurers/:id/deactivate ile expectedVersion iletilerek yapılmalıdır', async () => {
    let capturedDeactivateBody: unknown = null;
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/csrf-token')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { token: 'csrf-deactivate' } }),
        });
      }
      if (url === '/api/catalogs/insurers/ins-1/deactivate' && init?.method === 'POST') {
        capturedDeactivateBody = JSON.parse(init.body as string);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { ...mockInsurers[0], status: 'INACTIVE', version: 2 },
          }),
        });
      }
      if (url.includes('/api/catalogs/insurers')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: mockInsurers.filter((i) => i.status === 'ACTIVE'),
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: [] }),
      });
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Kataloglar' }));
    await screen.findByText('Anadolu Sigorta');

    fireEvent.click(screen.getByRole('button', { name: /Pasifleştir/i }));

    await waitFor(() => {
      expect(capturedDeactivateBody).toEqual({
        expectedVersion: 1,
      });
    });
  });

  it('6. Yeni Ürün oluştururken sigortacı ve branş seçicileri /api/catalogs/selectable üzerinden yalnızca aktifleri içermelidir', async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/catalogs/selectable') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: mockSelectable,
          }),
        });
      }
      if (url.includes('/api/catalogs/products')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: mockProducts }),
        });
      }
      if (url.includes('/api/catalogs/insurers')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: mockInsurers.filter((i) => i.status === 'ACTIVE'),
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: [] }),
      });
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Kataloglar' }));

    // Ürünler alt sekmesine geç
    fireEvent.click(screen.getByRole('button', { name: /Ürünler/i }));
    await screen.findByText('Genişletilmiş Kasko');

    fireEvent.click(screen.getByRole('button', { name: /Yeni Ürün|Yeni Ekle|\+ Ekle/i }));

    // Insurer ve Branch dropdown'larında sadece aktif olanlar bulunmalı
    const insurerSelect = screen.getByTestId('product-insurer-select');
    const branchSelect = screen.getByTestId('product-branch-select');

    expect(insurerSelect.textContent).toContain('Anadolu Sigorta');
    expect(insurerSelect.textContent).not.toContain('Allianz Sigorta');

    expect(branchSelect.textContent).toContain('Kasko Branşı');
    expect(branchSelect.textContent).not.toContain('Tamamlayıcı Sağlık');
  });

  it('7. Acente Ayarları sekmesi GET /api/agency/settings verilerini göstermeli ve varsayılan sigortacı değiştirilebilmelidir', async () => {
    let capturedPatchBody: unknown = null;

    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/csrf-token')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { token: 'csrf-settings' } }),
        });
      }
      if (url === '/api/agency/settings' && !init?.method) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: mockAgencySettings }),
        });
      }
      if (url === '/api/catalogs/selectable') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: mockSelectable }),
        });
      }
      if (url === '/api/agency/settings' && init?.method === 'PATCH') {
        capturedPatchBody = JSON.parse(init.body as string);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: {
              ...mockAgencySettings,
              defaultInsurerId: null,
              timezone: 'Europe/Istanbul',
              renewalWindowDays: 45,
              version: 2,
            },
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: {} }),
      });
    });

    render(<App />);
    const settingsNavBtn = await screen.findByRole('button', { name: 'Acente Ayarları' });
    fireEvent.click(settingsNavBtn);

    await screen.findByDisplayValue('Europe/Istanbul');
    const renewalDaysInput = screen.getByDisplayValue('30');
    fireEvent.change(renewalDaysInput, { target: { value: '45' } });

    const saveSettingsBtn = screen.getByRole('button', { name: /Ayarları Kaydet|Kaydet/i });
    fireEvent.click(saveSettingsBtn);

    await waitFor(() => {
      expect(capturedPatchBody).toEqual({
        expectedVersion: 1,
        timezone: 'Europe/Istanbul',
        renewalWindowDays: 45,
        defaultInsurerId: 'ins-1',
      });
    });
  });

  it('8. Acente ayarlarında geçersiz timezone veya renewal_window_days istemci doğrulamasından geçmemelidir', async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/agency/settings') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: mockAgencySettings }),
        });
      }
      if (url === '/api/catalogs/selectable') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: mockSelectable }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: {} }),
      });
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Acente Ayarları' }));
    await screen.findByDisplayValue('Europe/Istanbul');

    const renewalDaysInput = screen.getByDisplayValue('30');
    fireEvent.change(renewalDaysInput, { target: { value: '250' } }); // > 120 gün geçersiz!

    fireEvent.click(screen.getByRole('button', { name: /Ayarları Kaydet|Kaydet/i }));

    await screen.findByText(/en fazla 120 gün|Geçersiz yenileme penceresi/i);
  });

  it('9. Katalog mutasyonunda 403 yetkisiz erişim güvenli hata mesajı vermelidir', async () => {
    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/csrf-token')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { token: 'csrf-err' } }),
        });
      }
      if (url.includes('/api/catalogs/insurers') && init?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 403,
          json: async () => ({
            success: false,
            error: { code: 'FORBIDDEN', message: 'Bu işlem için yetkiniz bulunmamaktadır.' },
          }),
        });
      }
      if (url.includes('/api/catalogs/insurers')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: mockInsurers.filter((i) => i.status === 'ACTIVE'),
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: [] }),
      });
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Kataloglar' }));
    await screen.findByText('Anadolu Sigorta');

    fireEvent.click(
      screen.getByRole('button', { name: /Yeni Sigorta Şirketi|Yeni Ekle|\+ Ekle/i }),
    );
    fireEvent.change(screen.getByPlaceholderText(/Kod \(Örn: AKSIGORTA\)|Kod/i), {
      target: { value: 'TEST' },
    });
    fireEvent.change(screen.getByPlaceholderText(/İsim \(Örn: Aksigorta\)|İsim|Ad/i), {
      target: { value: 'Test' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Kaydet/i }));

    await screen.findByText(/yetkiniz bulunmamaktadır veya erişim reddedildi/i);
    expect(screen.queryByRole('button', { name: 'Tekrar Dene' })).toBeNull();
  });

  it('10. Katalog mutasyonunda 409 versiyon çakışmasında uygun çatışma mesajı gösterilmelidir', async () => {
    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/csrf-token')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { token: 'csrf-conflict' } }),
        });
      }
      if (url.includes('/api/catalogs/insurers/ins-1') && init?.method === 'PATCH') {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({
            success: false,
            error: {
              code: 'OPTIMISTIC_CONCURRENCY_CONFLICT',
              message: 'Kayıt başka bir işlem tarafından güncellenmiş.',
            },
          }),
        });
      }
      if (url.includes('/api/catalogs/insurers')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: mockInsurers.filter((i) => i.status === 'ACTIVE'),
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: [] }),
      });
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Kataloglar' }));
    await screen.findByText('Anadolu Sigorta');

    fireEvent.click(screen.getByRole('button', { name: /Düzenle/i }));
    fireEvent.change(screen.getByDisplayValue('Anadolu Sigorta'), { target: { value: 'Yeni Ad' } });
    fireEvent.click(screen.getByRole('button', { name: /Güncelle|Kaydet/i }));

    await screen.findByText(
      /başka bir işlem tarafından güncellenmiş|işlem çakışması tespit edildi/i,
    );
    expect(screen.queryByRole('button', { name: 'Tekrar Dene' })).toBeNull();
  });

  it('11. Katalog mutasyonunda ağ/5xx hatasında aynı Idempotency-Key ile "Tekrar Dene" butonu sunulmalıdır', async () => {
    const keysUsed: string[] = [];
    let callCount = 0;

    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/csrf-token')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { token: 'csrf-retry-catalog' } }),
        });
      }
      if (url.includes('/api/catalogs/insurers') && init?.method === 'POST') {
        const key = ((init.headers ?? {}) as Record<string, string>)['Idempotency-Key'];
        keysUsed.push(key!);
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new TypeError('network failure'));
        }
        return Promise.resolve({
          ok: true,
          status: 201,
          json: async () => ({
            success: true,
            data: {
              id: 'ins-retry',
              agencyId: 'agency-1',
              code: 'RETRY_INS',
              name: 'Retry Insurer',
              status: 'ACTIVE',
              version: 1,
              createdAt: '2026-09-20T10:00:00.000Z',
              updatedAt: '2026-09-20T10:00:00.000Z',
            },
          }),
        });
      }
      if (url.includes('/api/catalogs/insurers')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: mockInsurers.filter((i) => i.status === 'ACTIVE'),
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: [] }),
      });
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Kataloglar' }));
    await screen.findByText('Anadolu Sigorta');

    fireEvent.click(
      screen.getByRole('button', { name: /Yeni Sigorta Şirketi|Yeni Ekle|\+ Ekle/i }),
    );
    fireEvent.change(screen.getByPlaceholderText(/Kod \(Örn: AKSIGORTA\)|Kod/i), {
      target: { value: 'RETRY_INS' },
    });
    fireEvent.change(screen.getByPlaceholderText(/İsim \(Örn: Aksigorta\)|İsim|Ad/i), {
      target: { value: 'Retry Insurer' },
    });
    fireEvent.click(screen.getByRole('button', { name: /Kaydet/i }));

    const retryBtn = await screen.findByRole('button', { name: 'Tekrar Dene' });
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(keysUsed.length).toBe(2);
      expect(keysUsed[0]).toBe(keysUsed[1]);
    });
  });

  it('12. Süresi dolan CSRF belirtecini açık retry sırasında yeniler ve idempotency anahtarını korur', async () => {
    const keysUsed: string[] = [];
    let csrfCalls = 0;
    let mutationCalls = 0;

    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/csrf-token')) {
        csrfCalls++;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { token: `csrf-${csrfCalls}` } }),
        });
      }
      if (url.includes('/api/catalogs/insurers') && init?.method === 'POST') {
        keysUsed.push(((init.headers ?? {}) as Record<string, string>)['Idempotency-Key']!);
        mutationCalls++;
        if (mutationCalls === 1) {
          return Promise.resolve({
            ok: false,
            status: 403,
            json: async () => ({
              success: false,
              error: { code: 'EXPIRED_TOKEN', message: 'internal text must not render' },
            }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 201,
          json: async () => ({ success: true, data: mockInsurers[0] }),
        });
      }
      if (url.includes('/api/catalogs/insurers')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: [mockInsurers[0]] }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: [] }),
      });
    });

    render(<App />);
    fireEvent.click(await screen.findByRole('button', { name: 'Kataloglar' }));
    await screen.findByText('Anadolu Sigorta');
    fireEvent.click(screen.getByRole('button', { name: /Yeni Ekle/i }));
    fireEvent.change(screen.getByPlaceholderText(/Kod/i), { target: { value: 'CSRF_RETRY' } });
    fireEvent.change(screen.getByPlaceholderText(/İsim/i), { target: { value: 'CSRF Retry' } });
    fireEvent.click(screen.getByRole('button', { name: /Kaydet/i }));

    expect(await screen.findByText(/Güvenlik oturumu yenilenmeli/i)).toBeTruthy();
    expect(screen.queryByText('internal text must not render')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Tekrar Dene' }));

    await waitFor(() => {
      expect(csrfCalls).toBe(2);
      expect(keysUsed).toHaveLength(2);
      expect(keysUsed[0]).toBe(keysUsed[1]);
    });
  });
});
