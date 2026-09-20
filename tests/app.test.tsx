import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { App, invalidateCsrfToken } from '../src/app/App';

describe('İstemci Bileşen Testleri (Client Component Tests)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    invalidateCsrfToken();
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/customers')) {
        return Promise.resolve({
          ok: true,
          json: async () => ({
            success: true,
            data: {
              items: [
                {
                  id: 'cust-1',
                  agencyId: 'agency-1',
                  type: 'INDIVIDUAL',
                  displayName: 'Can Demir',
                  firstName: 'Can',
                  lastName: 'Demir',
                  companyTitle: null,
                  email: 'can@demir.test',
                  phone: '+905551234567',
                  address: 'Kadıköy',
                  assigneeMembershipId: 'mem-1',
                  version: 1,
                  createdAt: '2026-09-17T12:00:00.000Z',
                  updatedAt: '2026-09-17T12:00:00.000Z',
                },
                {
                  id: 'cust-2',
                  agencyId: 'agency-1',
                  type: 'COMPANY',
                  displayName: 'Mayı Lojistik A.Ş.',
                  firstName: null,
                  lastName: null,
                  companyTitle: 'Mayı Lojistik A.Ş.',
                  email: 'info@mayilojistik.test',
                  phone: '+902165550011',
                  address: 'Ataşehir',
                  assigneeMembershipId: 'mem-1',
                  version: 1,
                  createdAt: '2026-09-17T13:00:00.000Z',
                  updatedAt: '2026-09-17T13:00:00.000Z',
                },
              ],
              nextCursor: null,
              hasMore: false,
            },
            timestamp: new Date().toISOString(),
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => ({ success: true, data: {}, timestamp: new Date().toISOString() }),
      });
    });
  });

  it('App bileşeni sorunsuz render olmalı ve sistem başlığını göstermelidir', () => {
    render(<App />);
    const heading = screen.getByRole('heading', { level: 1 });
    expect(heading).toBeDefined();
    expect(heading.textContent).toBe('Mayı Sigorta CRM');

    const statusBadge = screen.getByText('Sistem Temeli Aktif (M1-T01)');
    expect(statusBadge).toBeDefined();

    const moduleBadge = screen.getByText('Müşteri Modülü Aktif (M2-T01)');
    expect(moduleBadge).toBeDefined();
  });

  it('Müşteriler sekmesine geçiş yapılabilmeli ve müşteri listesi yüklenmelidir', async () => {
    render(<App />);

    const customersNavBtn = screen.getByRole('button', { name: 'Müşteriler' });
    fireEvent.click(customersNavBtn);

    await waitFor(() => {
      expect(screen.getByText('Can Demir')).toBeDefined();
      expect(screen.getByText('Mayı Lojistik A.Ş.')).toBeDefined();
    });

    expect(
      screen.getByPlaceholderText('Müşteri adı, unvanı veya iletişim ile ara...'),
    ).toBeDefined();
    expect(screen.getByRole('button', { name: '+ Yeni Müşteri' })).toBeDefined();
  });

  it('Yeni Müşteri Oluştur modalı açılabilmeli ve Bireysel/Kurumsal alanları dinamik değişmelidir', async () => {
    render(<App />);

    // Müşteriler sekmesine git
    fireEvent.click(screen.getByRole('button', { name: 'Müşteriler' }));

    // Yeni Müşteri butonuna tıkla
    const addBtn = await screen.findByRole('button', { name: '+ Yeni Müşteri' });
    fireEvent.click(addBtn);

    // Modal başlığı kontrolü
    expect(screen.getByText('Yeni Müşteri Oluştur')).toBeDefined();

    // Varsayılan Bireysel alanları: Ad ve Soyad
    expect(screen.getByPlaceholderText('Ahmet')).toBeDefined();
    expect(screen.getByPlaceholderText('Yılmaz')).toBeDefined();

    // Kurumsal seçeneğine tıkla
    fireEvent.click(screen.getByRole('button', { name: 'Kurumsal (COMPANY)' }));

    // Kurumsal alanı: Şirket Unvanı
    expect(screen.getByPlaceholderText('Mayı Lojistik ve Ticaret Ltd. Şti.')).toBeDefined();

    // Modalı kapat
    fireEvent.click(screen.getByRole('button', { name: 'Vazgeç' }));
    expect(screen.queryByText('Yeni Müşteri Oluştur')).toBeNull();
  });

  it('Mutasyon işlemlerinde sunucudan alınan CSRF belirteci X-CSRF-Token başlığında gönderilmelidir', async () => {
    let capturedHeaders: Record<string, string> = {};
    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/csrf-token')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { token: 'mock-server-issued-csrf-token.signature123' },
            timestamp: new Date().toISOString(),
          }),
        });
      }
      if (url.includes('/api/customers') && init?.method === 'POST') {
        capturedHeaders = (init.headers ?? {}) as Record<string, string>;
        return Promise.resolve({
          ok: true,
          status: 201,
          json: async () => ({
            success: true,
            data: {
              id: 'cust-new',
              agencyId: 'agency-1',
              type: 'INDIVIDUAL',
              displayName: 'Ali Kaya',
              firstName: 'Ali',
              lastName: 'Kaya',
              version: 1,
              createdAt: new Date().toISOString(),
              updatedAt: new Date().toISOString(),
            },
            timestamp: new Date().toISOString(),
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { items: [], nextCursor: null, hasMore: false },
          timestamp: new Date().toISOString(),
        }),
      });
    });

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Müşteriler' }));
    const addBtn = await screen.findByRole('button', { name: '+ Yeni Müşteri' });
    fireEvent.click(addBtn);

    fireEvent.change(screen.getByPlaceholderText('Ahmet'), { target: { value: 'Ali' } });
    fireEvent.change(screen.getByPlaceholderText('Yılmaz'), { target: { value: 'Kaya' } });

    const submitBtn = screen.getByRole('button', { name: 'Müşteriyi Kaydet' });
    fireEvent.click(submitBtn);

    await waitFor(() => {
      expect(capturedHeaders['X-CSRF-Token']).toBe('mock-server-issued-csrf-token.signature123');
      expect(capturedHeaders['X-CSRF-Token']).not.toBe('client-mutation-token');
    });
  });

  it('403 hatasında açık yetki/erişim reddi mesajı gösterilmelidir', async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/customers')) {
        return Promise.resolve({
          ok: false,
          status: 403,
          json: async () => ({
            success: false,
            error: { code: 'FORBIDDEN', message: 'Erişim reddedildi.' },
            timestamp: new Date().toISOString(),
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: {}, timestamp: new Date().toISOString() }),
      });
    });

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Müşteriler' }));

    await waitFor(() => {
      expect(
        screen.getByText('Bu işlem için yetkiniz bulunmamaktadır veya erişim reddedildi.'),
      ).toBeDefined();
    });
    // 403 hatasında retry butonu bulunmamalıdır
    expect(screen.queryByRole('button', { name: 'Tekrar Dene' })).toBeNull();
  });

  it('409 çakışma hatasında çatışma/stale yönlendirmesi gösterilmeli ve retryable gibi davranmamalıdır', async () => {
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/customers')) {
        return Promise.resolve({
          ok: false,
          status: 409,
          json: async () => ({
            success: false,
            error: { code: 'OPTIMISTIC_CONCURRENCY_CONFLICT', message: 'Kayıt güncellendi.' },
            timestamp: new Date().toISOString(),
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: {}, timestamp: new Date().toISOString() }),
      });
    });

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Müşteriler' }));

    await waitFor(() => {
      expect(
        screen.getByText(
          'Veri başka bir işlem tarafından güncellenmiş veya işlem çakışması tespit edildi. Lütfen sayfayı yenileyip güncel durumu kontrol ediniz.',
        ),
      ).toBeDefined();
    });
    expect(screen.queryByRole('button', { name: 'Tekrar Dene' })).toBeNull();
  });

  it('5xx veya ağ hatasında kullanıcıya açık "Tekrar Dene" butonu sunulmalıdır', async () => {
    let callCount = 0;
    global.fetch = vi.fn().mockImplementation((url: string) => {
      if (url.includes('/api/customers')) {
        callCount++;
        if (callCount === 1) {
          return Promise.resolve({
            ok: false,
            status: 503,
            json: async () => ({
              success: false,
              error: { code: 'SERVICE_UNAVAILABLE', message: 'Hizmet geçici olarak durdu.' },
              timestamp: new Date().toISOString(),
            }),
          });
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { items: [], nextCursor: null, hasMore: false },
            timestamp: new Date().toISOString(),
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: {}, timestamp: new Date().toISOString() }),
      });
    });

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Müşteriler' }));

    const retryBtn = await screen.findByRole('button', { name: 'Tekrar Dene' });
    expect(retryBtn).toBeDefined();
    expect(
      screen.getByText('Sunucuda geçici bir hata oluştu. Lütfen daha sonra tekrar deneyiniz.'),
    ).toBeDefined();

    // Kullanıcı açıkça tekrar dener
    fireEvent.click(retryBtn);

    await waitFor(() => {
      expect(callCount).toBe(2);
    });
  });

  it('4xx doğrulama hatasında doğrulama mesajı verilmeli ve ham veritabanı/SQL metni gösterilmemelidir', async () => {
    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/csrf-token')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { token: 'mock-csrf' },
            timestamp: new Date().toISOString(),
          }),
        });
      }
      if (url.includes('/api/customers') && init?.method === 'POST') {
        return Promise.resolve({
          ok: false,
          status: 400,
          json: async () => ({
            success: false,
            error: {
              code: 'SQLITE_ERROR',
              message: 'D1_ERROR: near "SYNTAX": syntax error in sql table',
            },
            timestamp: new Date().toISOString(),
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { items: [] },
          timestamp: new Date().toISOString(),
        }),
      });
    });

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Müşteriler' }));
    const addBtn = await screen.findByRole('button', { name: '+ Yeni Müşteri' });
    fireEvent.click(addBtn);

    fireEvent.change(screen.getByPlaceholderText('Ahmet'), { target: { value: 'Test' } });
    fireEvent.change(screen.getByPlaceholderText('Yılmaz'), { target: { value: 'Kullanıcı' } });

    fireEvent.click(screen.getByRole('button', { name: 'Müşteriyi Kaydet' }));

    await waitFor(() => {
      expect(
        screen.getByText('Girdi doğrulama hatası: Geçersiz veya eksik veri sağlandı.'),
      ).toBeDefined();
    });
    // Ham veritabanı veya SQL detayı arayüze sızmamalıdır
    expect(screen.queryByText(/SQLITE_ERROR/)).toBeNull();
    expect(screen.queryByText(/syntax error/)).toBeNull();
    expect(screen.queryByRole('button', { name: 'Tekrar Dene' })).toBeNull();
  });

  it('kayıp başarılı yanıttan sonra Customer retry aynı idempotency key ile replay etmeli, yeni submit fresh key almalıdır', async () => {
    const attemptedKeys: string[] = [];
    const appliedKeys = new Set<string>();
    let businessEffectCount = 0;

    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/csrf-token')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { token: 'issued-csrf-token.signature' },
            timestamp: new Date().toISOString(),
          }),
        });
      }
      if (url === '/api/customers' && init?.method === 'POST') {
        const headers = init.headers as Record<string, string>;
        const key = headers['Idempotency-Key']!;
        attemptedKeys.push(key);
        if (!appliedKeys.has(key)) {
          appliedKeys.add(key);
          businessEffectCount += 1;
          return Promise.reject(new TypeError('lost response after commit'));
        }
        return Promise.resolve({
          ok: true,
          status: 201,
          json: async () => ({
            success: true,
            data: {
              id: `cust-${businessEffectCount}`,
              agencyId: 'agency-1',
              type: 'INDIVIDUAL',
              displayName: 'Retry Customer',
              firstName: 'Retry',
              lastName: 'Customer',
              companyTitle: null,
              email: null,
              phone: null,
              address: null,
              assigneeMembershipId: 'mem-1',
              version: 1,
              createdAt: '2026-09-20T00:00:00.000Z',
              updatedAt: '2026-09-20T00:00:00.000Z',
            },
            timestamp: new Date().toISOString(),
          }),
        });
      }
      return Promise.resolve({
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: { items: [], nextCursor: null, hasMore: false },
          timestamp: new Date().toISOString(),
        }),
      });
    });

    const submitCustomer = async (firstName: string, lastName: string) => {
      fireEvent.click(screen.getByRole('button', { name: '+ Yeni Müşteri' }));
      fireEvent.change(screen.getByPlaceholderText('Ahmet'), { target: { value: firstName } });
      fireEvent.change(screen.getByPlaceholderText('Yılmaz'), { target: { value: lastName } });
      fireEvent.click(screen.getByRole('button', { name: 'Müşteriyi Kaydet' }));
      const retry = await screen.findByRole('button', { name: 'Tekrar Dene' });
      fireEvent.click(retry);
      await waitFor(() => {
        expect(screen.queryByText('Yeni Müşteri Oluştur')).toBeNull();
      });
    };

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Müşteriler' }));
    await screen.findByRole('button', { name: '+ Yeni Müşteri' });

    await submitCustomer('Retry', 'Customer');
    expect(attemptedKeys[0]).toBe(attemptedKeys[1]);
    expect(businessEffectCount).toBe(1);

    await submitCustomer('Fresh', 'Operation');
    expect(attemptedKeys[2]).toBe(attemptedKeys[3]);
    expect(attemptedKeys[2]).not.toBe(attemptedKeys[0]);
    expect(businessEffectCount).toBe(2);
  });

  it('CompanyContact add, set-primary ve deactivate retry aynı logical request/key ile yapılmalıdır', async () => {
    const attempts = new Map<string, string[]>();
    const applied = new Map<string, Set<string>>();
    const businessEffects = new Map<string, number>();
    const contact = (id: string, firstName: string) => ({
      id,
      agencyId: 'agency-1',
      customerId: 'company-1',
      firstName,
      lastName: 'Contact',
      role: null,
      email: null,
      phone: null,
      isPrimary: false,
      status: 'ACTIVE',
      version: 1,
      createdAt: '2026-09-20T00:00:00.000Z',
      updatedAt: '2026-09-20T00:00:00.000Z',
    });
    const contacts = [contact('contact-1', 'Bir'), contact('contact-2', 'İki')];

    const lostResponseOnce = (
      operation: 'add' | 'set-primary' | 'deactivate',
      key: string,
      responseContact: ReturnType<typeof contact>,
    ) => {
      const operationAttempts = attempts.get(operation) ?? [];
      operationAttempts.push(key);
      attempts.set(operation, operationAttempts);
      const operationKeys = applied.get(operation) ?? new Set<string>();
      applied.set(operation, operationKeys);
      if (!operationKeys.has(key)) {
        operationKeys.add(key);
        businessEffects.set(operation, (businessEffects.get(operation) ?? 0) + 1);
        return Promise.reject(new TypeError(`lost ${operation} response`));
      }
      return Promise.resolve({
        ok: true,
        status: operation === 'add' ? 201 : 200,
        json: async () => ({
          success: true,
          data: responseContact,
          timestamp: new Date().toISOString(),
        }),
      });
    };

    global.fetch = vi.fn().mockImplementation((url: string, init?: RequestInit) => {
      if (url.includes('/api/csrf-token')) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: { token: 'issued-contact-csrf.signature' },
            timestamp: new Date().toISOString(),
          }),
        });
      }
      if (url === '/api/customers?limit=20') {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: {
              items: [
                {
                  id: 'company-1',
                  agencyId: 'agency-1',
                  type: 'COMPANY',
                  displayName: 'Retry Company',
                  firstName: null,
                  lastName: null,
                  companyTitle: 'Retry Company',
                  email: null,
                  phone: null,
                  address: null,
                  assigneeMembershipId: 'mem-1',
                  version: 1,
                  createdAt: '2026-09-20T00:00:00.000Z',
                  updatedAt: '2026-09-20T00:00:00.000Z',
                },
              ],
              nextCursor: null,
              hasMore: false,
            },
            timestamp: new Date().toISOString(),
          }),
        });
      }
      if (url === '/api/customers/company-1' && !init?.method) {
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => ({
            success: true,
            data: {
              id: 'company-1',
              agencyId: 'agency-1',
              type: 'COMPANY',
              displayName: 'Retry Company',
              firstName: null,
              lastName: null,
              companyTitle: 'Retry Company',
              email: null,
              phone: null,
              address: null,
              assigneeMembershipId: 'mem-1',
              version: 1,
              createdAt: '2026-09-20T00:00:00.000Z',
              updatedAt: '2026-09-20T00:00:00.000Z',
              contacts,
            },
            timestamp: new Date().toISOString(),
          }),
        });
      }

      const key = ((init?.headers ?? {}) as Record<string, string>)['Idempotency-Key']!;
      if (url === '/api/customers/company-1/contacts' && init?.method === 'POST') {
        return lostResponseOnce('add', key, contact('contact-new', 'Yeni'));
      }
      if (url.includes('/set-primary') && init?.method === 'POST') {
        return lostResponseOnce('set-primary', key, {
          ...contacts[0]!,
          isPrimary: true,
          version: 2,
        });
      }
      if (url.includes('/deactivate') && init?.method === 'POST') {
        return lostResponseOnce('deactivate', key, {
          ...contacts[0]!,
          status: 'INACTIVE',
          version: 2,
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });
    vi.spyOn(window, 'confirm').mockReturnValue(true);

    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Müşteriler' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Detay & Yetkililer' }));
    await screen.findByText('Şirket Yetkilileri (Contacts)');

    fireEvent.click(screen.getByRole('button', { name: '+ Yeni Yetkili Ekle' }));
    const contactForm = document.querySelector('form');
    expect(contactForm).not.toBeNull();
    const contactInputs = contactForm!.querySelectorAll('input');
    fireEvent.change(contactInputs[0]!, { target: { value: 'Yeni' } });
    fireEvent.change(contactInputs[1]!, { target: { value: 'Yetkili' } });
    fireEvent.click(screen.getByRole('button', { name: 'Yetkiliyi Kaydet' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Tekrar Dene' }));
    await waitFor(() => expect(attempts.get('add')?.length).toBe(2));

    fireEvent.click(screen.getAllByRole('button', { name: 'Birincil Yap' })[0]!);
    fireEvent.click(await screen.findByRole('button', { name: 'Tekrar Dene' }));
    await waitFor(() => expect(attempts.get('set-primary')?.length).toBe(2));

    fireEvent.click(screen.getAllByRole('button', { name: 'Pasifleştir' })[0]!);
    fireEvent.click(await screen.findByRole('button', { name: 'Tekrar Dene' }));
    await waitFor(() => expect(attempts.get('deactivate')?.length).toBe(2));

    for (const operation of ['add', 'set-primary', 'deactivate'] as const) {
      const keys = attempts.get(operation)!;
      expect(keys[0]).toBe(keys[1]);
      expect(businessEffects.get(operation)).toBe(1);
    }
  });
});
