import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { App, invalidateCsrfToken } from '../src/app/App';
import type { CustomerDetailDto } from '../src/shared/types';

describe('M2-T02 UI Kabul Testleri (Customer Identity, Assignment & External References)', () => {
  const baseCustomer: CustomerDetailDto = {
    id: 'cust-101',
    agencyId: 'agency-1',
    type: 'INDIVIDUAL',
    displayName: 'Mehmet Öz',
    firstName: 'Mehmet',
    lastName: 'Öz',
    companyTitle: null,
    email: 'mehmet@example.test',
    phone: '+905551112233',
    address: 'Beşiktaş, İstanbul',
    assigneeMembershipId: 'mem-1',
    archivedAt: null,
    archivedByMembershipId: null,
    archiveReasonCode: null,
    hasIdentity: true,
    identityMasked: '123******01',
    version: 3,
    createdAt: '2026-09-20T10:00:00.000Z',
    updatedAt: '2026-09-20T10:00:00.000Z',
    contacts: [],
  };

  beforeEach(() => {
    vi.restoreAllMocks();
    invalidateCsrfToken();
  });

  it('1. Müşteri detayında kimlik varsayılan olarak maskelenmiş görünmeli ve açık kimlik bilgisi otomatik çağrılmamalıdır', async () => {
    let identityEndpointCalled = false;
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/customers?limit=20') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { items: [baseCustomer], nextCursor: null, hasMore: false },
          }),
        });
      }
      if (url === '/api/customers/cust-101') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: baseCustomer,
          }),
        });
      }
      if (url.includes('/api/customers/cust-101/identity')) {
        identityEndpointCalled = true;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { customerId: 'cust-101', identityType: 'TCKN', identityValue: '12345678901' },
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
    fireEvent.click(screen.getByRole('button', { name: 'Müşteriler' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Detay & Yetkililer' }));

    await screen.findByText('123******01');
    expect(identityEndpointCalled).toBe(false);
    expect(screen.queryByText('12345678901')).toBeNull();
    expect(screen.getByRole('button', { name: /^Kimliği Göster$/i })).toBeDefined();
  });

  it('2. Açık "Kimliği Göster" tıklandığında dedicated endpoint çağrılmalı ve kimlik gösterilmelidir', async () => {
    let identityCallCount = 0;
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/customers?limit=20') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { items: [baseCustomer], nextCursor: null, hasMore: false },
          }),
        });
      }
      if (url === '/api/customers/cust-101') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: baseCustomer }),
        });
      }
      if (url === '/api/customers/cust-101/identity') {
        identityCallCount++;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { customerId: 'cust-101', identityType: 'TCKN', identityValue: '12345678901' },
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
    fireEvent.click(screen.getByRole('button', { name: 'Müşteriler' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Detay & Yetkililer' }));
    await screen.findByText('123******01');

    const revealBtn = screen.getByRole('button', { name: /^Kimliği Göster$/i });
    fireEvent.click(revealBtn);

    await screen.findByText('12345678901');
    expect(identityCallCount).toBe(1);
  });

  it('3. Kimlik reveal işleminde 403 hatası güvenli şekilde ele alınmalıdır', async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/customers?limit=20') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { items: [baseCustomer], nextCursor: null, hasMore: false },
          }),
        });
      }
      if (url === '/api/customers/cust-101') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: baseCustomer }),
        });
      }
      if (url === '/api/customers/cust-101/identity') {
        return Promise.resolve({
          ok: false,
          status: 403,
          json: async () => ({
            success: false,
            error: { code: 'FORBIDDEN', message: 'Hassas kimlik görüntüleme yetkiniz yok.' },
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
    fireEvent.click(screen.getByRole('button', { name: 'Müşteriler' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Detay & Yetkililer' }));
    await screen.findByText('123******01');

    const revealBtn = screen.getByRole('button', { name: /^Kimliği Göster$/i });
    fireEvent.click(revealBtn);

    await screen.findByText(/yetkiniz bulunmamaktadır|erişim reddedildi/i);
    expect(screen.queryByText('12345678901')).toBeNull();
  });

  it('4. "Kimliği Gizle" tıklandığında veya modal kapatıldığında açık kimlik bellekten temizlenmelidir', async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url === '/api/customers?limit=20') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { items: [baseCustomer], nextCursor: null, hasMore: false },
          }),
        });
      }
      if (url === '/api/customers/cust-101') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: baseCustomer }),
        });
      }
      if (url === '/api/customers/cust-101/identity') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { customerId: 'cust-101', identityType: 'TCKN', identityValue: '12345678901' },
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
    fireEvent.click(screen.getByRole('button', { name: 'Müşteriler' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Detay & Yetkililer' }));
    await screen.findByText('123******01');

    fireEvent.click(screen.getByRole('button', { name: /^Kimliği Göster$/i }));
    await screen.findByText('12345678901');

    const hideBtn = screen.getByRole('button', { name: /Kimliği Gizle|Gizle/i });
    fireEvent.click(hideBtn);

    expect(screen.queryByText('12345678901')).toBeNull();
    expect(screen.getByText('123******01')).toBeDefined();

    fireEvent.click(screen.getByRole('button', { name: /Kimlik Bilgisini Güncelle/i }));
    const draftInput = screen.getByLabelText('TCKN numarası') as HTMLInputElement;
    fireEvent.change(draftInput, { target: { value: '98765432154' } });
    fireEvent.click(screen.getByRole('button', { name: 'Kapat' }));
    fireEvent.click(screen.getByRole('button', { name: /Kimlik Bilgisini Güncelle/i }));
    expect((screen.getByLabelText('TCKN numarası') as HTMLInputElement).value).toBe('');
  });

  it('5. Kimlik güncelleme PUT /api/customers/:id/identity çağrısı yapmalı, CSRF ve Idempotency-Key iletmeli, başarıda hassas formu temizlemeli ve DTO yenilenmelidir', async () => {
    let capturedPutHeaders: Record<string, string> = {};
    let capturedPutBody: unknown = null;
    let detailFetchCount = 0;

    const updatedCustomer: CustomerDetailDto = {
      ...baseCustomer,
      identityMasked: '987******54',
      version: 4,
    };

    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/csrf-token')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { token: 'csrf-identity-token.sig' },
          }),
        });
      }
      if (url === '/api/customers?limit=20') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { items: [baseCustomer], nextCursor: null, hasMore: false },
          }),
        });
      }
      if (url === '/api/customers/cust-101' && !init?.method) {
        detailFetchCount++;
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: detailFetchCount > 1 ? updatedCustomer : baseCustomer,
          }),
        });
      }
      if (url === '/api/customers/cust-101/identity' && init?.method === 'PUT') {
        capturedPutHeaders = (init.headers ?? {}) as Record<string, string>;
        capturedPutBody = JSON.parse(init.body as string);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: {
              customerId: 'cust-101',
              hasIdentity: true,
              identityType: 'TCKN',
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
    fireEvent.click(screen.getByRole('button', { name: 'Müşteriler' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Detay & Yetkililer' }));
    await screen.findByText('123******01');

    // Kimlik düzenleme bölümünü aç / formu doldur
    const editIdentityBtn = screen.getByRole('button', {
      name: /Kimlik Bilgisini Güncelle|Kimlik Düzenle/i,
    });
    fireEvent.click(editIdentityBtn);

    const identityInput = await screen.findByLabelText('TCKN numarası');
    fireEvent.change(identityInput, { target: { value: '98765432154' } });

    const saveIdentityBtn = screen.getByRole('button', { name: /Kimliği Kaydet|Kaydet/i });
    fireEvent.click(saveIdentityBtn);

    await waitFor(() => {
      expect(capturedPutHeaders['X-CSRF-Token']).toBe('csrf-identity-token.sig');
      expect(capturedPutHeaders['Idempotency-Key']).toBeDefined();
      expect(capturedPutBody).toEqual({
        expectedVersion: 3,
        identityType: 'TCKN',
        identityValue: '98765432154',
      });
      // İstemci gövdesi şifreli alan, HMAC veya keyVersion gibi sunucu/kripto iç alanlarını ASLA içermemelidir
      expect(capturedPutBody).not.toHaveProperty('ciphertext');
      expect(capturedPutBody).not.toHaveProperty('searchHash');
      expect(capturedPutBody).not.toHaveProperty('keyVersion');
    });

    // Başarı sonrası yeni maskeli değer gösterilmeli
    await screen.findByText('987******54');
    expect(detailFetchCount).toBeGreaterThanOrEqual(2);
  });

  it('6. Kimlik temizleme işlemi clear: true gövdesiyle çağrılmalıdır', async () => {
    let capturedPutBody: unknown = null;
    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/csrf-token')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { token: 'csrf-clear' } }),
        });
      }
      if (url === '/api/customers?limit=20') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { items: [baseCustomer], nextCursor: null, hasMore: false },
          }),
        });
      }
      if (url === '/api/customers/cust-101' && !init?.method) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: baseCustomer }),
        });
      }
      if (url === '/api/customers/cust-101/identity' && init?.method === 'PUT') {
        capturedPutBody = JSON.parse(init.body as string);
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { customerId: 'cust-101', hasIdentity: false, identityType: null },
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
    fireEvent.click(screen.getByRole('button', { name: 'Müşteriler' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Detay & Yetkililer' }));
    await screen.findByText('123******01');

    fireEvent.click(
      screen.getByRole('button', { name: /Kimlik Bilgisini Güncelle|Kimlik Düzenle/i }),
    );
    const clearIdentityBtn = screen.getByRole('button', {
      name: /Kimliği Kaldır|Kimliği Sil|Temizle/i,
    });
    fireEvent.click(clearIdentityBtn);

    await waitFor(() => {
      expect(capturedPutBody).toEqual({
        expectedVersion: 3,
        clear: true,
      });
    });
  });

  it('7. Hassas kimlik araması POST /api/customers/search-sensitive gövdesiyle yapılmalı, URL/query kullanılmamalıdır', async () => {
    let capturedUrl = '';
    let capturedBody: unknown = null;
    let capturedMethod = '';
    let capturedCsrf = '';

    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/csrf-token')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { token: 'csrf-sensitive-search' } }),
        });
      }
      if (url.includes('/api/customers/search-sensitive')) {
        capturedUrl = url;
        capturedMethod = init?.method ?? 'GET';
        capturedBody = JSON.parse(init?.body as string);
        capturedCsrf = ((init?.headers ?? {}) as Record<string, string>)['X-CSRF-Token'] ?? '';
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: [
              {
                id: 'cust-sensitive-result',
                agencyId: 'agency-1',
                type: 'INDIVIDUAL',
                displayName: 'Bulunan Müşteri',
                firstName: 'Bulunan',
                lastName: 'Müşteri',
                companyTitle: null,
                email: 'bulunan@test.com',
                phone: null,
                address: null,
                assigneeMembershipId: 'mem-1',
                hasIdentity: true,
                identityMasked: '123******01',
                version: 1,
                createdAt: '2026-09-20T10:00:00.000Z',
                updatedAt: '2026-09-20T10:00:00.000Z',
              },
            ],
          }),
        });
      }
      if (url.includes('/api/customers')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { items: [], nextCursor: null, hasMore: false },
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
    fireEvent.click(screen.getByRole('button', { name: 'Müşteriler' }));

    // Hassas arama butonuna/bölümüne tıkla
    const sensitiveSearchToggle = await screen.findByRole('button', {
      name: /Hassas Arama|TCKN\/VKN ile Ara/i,
    });
    fireEvent.click(sensitiveSearchToggle);

    const sensitiveInput = screen.getByPlaceholderText(/TCKN veya VKN ile tam eşleşme ara/i);
    fireEvent.change(sensitiveInput, { target: { value: '12345678901' } });

    const searchSubmitBtn = screen.getByRole('button', { name: 'Hassas Ara' });
    fireEvent.click(searchSubmitBtn);

    await screen.findByText('Bulunan Müşteri');
    expect(capturedMethod).toBe('POST');
    expect(capturedCsrf).toBe('csrf-sensitive-search');
    expect(capturedUrl).not.toContain('?');
    expect(capturedUrl).not.toContain('12345678901');
    expect(capturedBody).toEqual({
      identityType: 'TCKN',
      identityValue: '12345678901',
    });

    // Temizle butonuna basılınca sonuçlar ve input temizlenmelidir
    const clearBtn = screen.getByRole('button', { name: /Aramayı Temizle|Sonuçları Temizle/i });
    fireEvent.click(clearBtn);

    expect(screen.queryByText('Bulunan Müşteri')).toBeNull();
  });

  it('8. Müşteri sorumlusu atama POST /api/customers/:id/assign ile çağrılmalı ve 409 stale conflict doğru gösterilmelidir', async () => {
    let capturedAssignBody: unknown = null;
    let assignStatus = 200;
    let currentCustomer = baseCustomer;

    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/csrf-token')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { token: 'csrf-assign' } }),
        });
      }
      if (url === '/api/customers/cust-101/assignment-options') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: [
              { membershipId: 'mem-1', label: 'owner@test.com', membershipType: 'OWNER' },
              { membershipId: 'mem-2', label: 'agent@test.com', membershipType: 'MEMBER' },
            ],
          }),
        });
      }
      if (url === '/api/customers?limit=20') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { items: [baseCustomer], nextCursor: null, hasMore: false },
          }),
        });
      }
      if (url === '/api/customers/cust-101' && !init?.method) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: currentCustomer }),
        });
      }
      if (url === '/api/customers/cust-101/assign' && init?.method === 'POST') {
        capturedAssignBody = JSON.parse(init.body as string);
        if (assignStatus === 409) {
          return Promise.resolve({
            ok: false,
            status: 409,
            json: async () => ({
              success: false,
              error: {
                code: 'OPTIMISTIC_CONCURRENCY_CONFLICT',
                message: 'Kayıt başka bir işlem tarafından güncellendi.',
              },
            }),
          });
        }
        currentCustomer = { ...baseCustomer, assigneeMembershipId: 'mem-2', version: 4 };
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: currentCustomer,
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
    fireEvent.click(screen.getByRole('button', { name: 'Müşteriler' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Detay & Yetkililer' }));
    await screen.findByText('123******01');

    // Sorumlu atama kontrolü
    await screen.findByRole('option', { name: 'agent@test.com (MEMBER)' });
    const assignSelect = await screen.findByTestId('assignee-select');
    fireEvent.change(assignSelect, { target: { value: 'mem-2' } });

    const assignSubmitBtn = screen.getByRole('button', { name: 'Sorumluyu Ata' });
    fireEvent.click(assignSubmitBtn);

    await waitFor(() => {
      expect(capturedAssignBody).toEqual({
        expectedVersion: 3,
        assigneeMembershipId: 'mem-2',
      });
    });

    // 409 durumunu test et
    expect(await screen.findByRole('button', { name: 'Sorumluyu Ata' })).toHaveProperty(
      'disabled',
      true,
    );
    assignStatus = 409;
    fireEvent.change(assignSelect, { target: { value: 'mem-1' } });
    fireEvent.click(assignSubmitBtn);
    await screen.findByText(/başka bir işlem tarafından güncellenmiş|çakışma/i);
    expect(capturedAssignBody).toEqual({ expectedVersion: 4, assigneeMembershipId: 'mem-1' });
    expect(screen.queryByRole('button', { name: 'Tekrar Dene' })).toBeNull();
  });

  it('9. Müşteri atama network/5xx hatasında aynı Idempotency-Key ile tekrar denenebilmelidir', async () => {
    const keysUsed: string[] = [];
    let callCount = 0;

    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/csrf-token')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { token: 'csrf-assign-retry' } }),
        });
      }
      if (url === '/api/customers/cust-101/assignment-options') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: [
              { membershipId: 'mem-1', label: 'owner@test.com', membershipType: 'OWNER' },
              { membershipId: 'mem-2', label: 'agent@test.com', membershipType: 'MEMBER' },
            ],
          }),
        });
      }
      if (url === '/api/customers?limit=20') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { items: [baseCustomer], nextCursor: null, hasMore: false },
          }),
        });
      }
      if (url === '/api/customers/cust-101' && !init?.method) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: baseCustomer }),
        });
      }
      if (url === '/api/customers/cust-101/assign' && init?.method === 'POST') {
        const key = ((init.headers ?? {}) as Record<string, string>)['Idempotency-Key'];
        keysUsed.push(key!);
        callCount++;
        if (callCount === 1) {
          return Promise.reject(new TypeError('network failed on assign'));
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { ...baseCustomer, assigneeMembershipId: 'mem-2', version: 4 },
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
    fireEvent.click(screen.getByRole('button', { name: 'Müşteriler' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Detay & Yetkililer' }));
    await screen.findByText('123******01');

    const assignSelect = await screen.findByTestId('assignee-select');
    fireEvent.change(assignSelect, { target: { value: 'mem-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Sorumluyu Ata' }));

    const retryBtn = await screen.findByRole('button', { name: 'Tekrar Dene' });
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(keysUsed.length).toBe(2);
      expect(keysUsed[0]).toBe(keysUsed[1]);
    });
  });

  it('10. Harici referans listesi yüklenmeli, referans oluşturulmalı ve 409 DUPLICATE_EXTERNAL_REFERENCE ayırt edilmelidir', async () => {
    let duplicateMode = false;
    let createdRef = false;

    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/csrf-token')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: { token: 'csrf-ref' } }),
        });
      }
      if (url === '/api/customers?limit=20') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { items: [baseCustomer], nextCursor: null, hasMore: false },
          }),
        });
      }
      if (url === '/api/customers/cust-101' && !init?.method) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({ success: true, data: baseCustomer }),
        });
      }
      if (
        url === '/api/customers/cust-101/external-references' &&
        (!init?.method || init.method === 'GET')
      ) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: createdRef
              ? [
                  {
                    id: 'ref-1',
                    agencyId: 'agency-1',
                    customerId: 'cust-101',
                    sourceNamespace: 'POLIS_360',
                    externalKey: 'EXT-9988',
                    createdAt: '2026-09-20T10:00:00.000Z',
                  },
                ]
              : [],
          }),
        });
      }
      if (url === '/api/customers/cust-101/external-references' && init?.method === 'POST') {
        if (duplicateMode) {
          return Promise.resolve({
            ok: false,
            status: 409,
            json: async () => ({
              success: false,
              error: {
                code: 'DUPLICATE_EXTERNAL_REFERENCE',
                message: 'Bu acente için harici kaynak ve referans anahtarı zaten tanımlı.',
              },
            }),
          });
        }
        createdRef = true;
        return Promise.resolve({
          ok: true,
          status: 201,
          json: async () => ({
            success: true,
            data: {
              id: 'ref-1',
              agencyId: 'agency-1',
              customerId: 'cust-101',
              sourceNamespace: 'POLIS_360',
              externalKey: 'EXT-9988',
              createdAt: '2026-09-20T10:00:00.000Z',
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
    fireEvent.click(screen.getByRole('button', { name: 'Müşteriler' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Detay & Yetkililer' }));
    await screen.findByText('123******01');

    // Harici referans oluştur
    const nsInput = await screen.findByPlaceholderText(
      /Kaynak Sistem \(Örn: POLIS_360\)|Kaynak Sistem/i,
    );
    const keyInput = screen.getByPlaceholderText(/Harici Anahtar \(Örn: M-12345\)|Harici Anahtar/i);
    fireEvent.change(nsInput, { target: { value: 'POLIS_360' } });
    fireEvent.change(keyInput, { target: { value: 'EXT-9988' } });

    const addRefBtn = screen.getByRole('button', { name: /Referans Ekle|Kaydet/i });
    fireEvent.click(addRefBtn);

    await screen.findByText('POLIS_360');
    expect(screen.getByText('EXT-9988')).toBeDefined();

    // Duplicate referans 409 hatası
    duplicateMode = true;
    fireEvent.change(nsInput, { target: { value: 'POLIS_360' } });
    fireEvent.change(keyInput, { target: { value: 'EXT-9988' } });
    fireEvent.click(addRefBtn);

    await screen.findByText(/zaten tanımlı|Bu harici referans zaten mevcut/i);
    // 409 duplicate retryable değildir
    expect(screen.queryByRole('button', { name: 'Tekrar Dene' })).toBeNull();
  });
});
