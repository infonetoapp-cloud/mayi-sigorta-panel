// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App, invalidateCsrfToken } from '../src/app/App';
import { CustomerContactSection } from '../src/app/components/CustomerContactSection';
import type { CustomerDetailDto } from '../src/shared/types';

const customer: CustomerDetailDto = {
  id: 'contact-customer',
  agencyId: 'agency',
  type: 'INDIVIDUAL',
  displayName: 'Deneme Kişi',
  firstName: 'Deneme',
  lastName: 'Kişi',
  companyTitle: null,
  email: 'onceki@example.test',
  phone: '+905321234567',
  address: 'Eski adres',
  assigneeMembershipId: 'member',
  archivedAt: null,
  archivedByMembershipId: null,
  archiveReasonCode: null,
  hasIdentity: false,
  identityMasked: null,
  version: 3,
  createdAt: '2026-10-16T00:00:00.000Z',
  updatedAt: '2026-10-16T00:00:00.000Z',
  contacts: [],
};
function response(data: unknown, status = 200) {
  return new Response(
    JSON.stringify(
      status >= 400
        ? {
            success: false,
            error: {
              code: status === 409 ? 'OPTIMISTIC_CONCURRENCY_CONFLICT' : 'VALIDATION_ERROR',
              message: 'unsafe SQL',
            },
          }
        : { success: true, data },
    ),
    { status },
  );
}
function fixture(
  override?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined,
) {
  let current = customer;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const custom = override?.(url, init);
    if (custom) return custom;
    if (url === '/api/csrf-token') return response({ token: 'csrf' });
    if (url.startsWith('/api/customers?'))
      return response({ items: [current], hasMore: false, nextCursor: null });
    if (url === '/api/customers/contact-customer') {
      if (init?.method === 'PATCH') {
        current = { ...current, ...JSON.parse(String(init.body)), version: 4 };
        return response(current);
      }
      return response(current);
    }
    if (url.startsWith('/api/documents')) return response(null, 404);
    return response([]);
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
async function openDetail() {
  render(<App />);
  fireEvent.click(screen.getByRole('button', { name: 'Müşteriler' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Detay & Yetkililer' }));
  fireEvent.click(await screen.findByRole('button', { name: 'İletişim bilgilerini düzenle' }));
}
beforeEach(() => invalidateCsrfToken());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Customer contact editing', () => {
  it('edits the reference and birthday through the existing CAS command', async () => {
    const fetcher = fixture();
    await openDetail();
    fireEvent.change(screen.getByLabelText('Referans kişi'), { target: { value: 'manual' } });
    fireEvent.change(screen.getByLabelText('Referans kişinin adı soyadı'), {
      target: { value: 'Dış Referans' },
    });
    fireEvent.input(screen.getByLabelText('Doğum tarihi'), { target: { value: '2000-02-29' } });
    fireEvent.click(screen.getByRole('button', { name: 'İletişim bilgilerini kaydet' }));
    await screen.findByText('İletişim bilgileri kaydedildi.');
    const patch = fetcher.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    expect(JSON.parse(String(patch[1]!.body))).toEqual({
      expectedVersion: 3,
      referenceName: 'Dış Referans',
      birthDate: '2000-02-29',
    });
  });
  it('edits email from the real detail screen using scoped PATCH and refreshes displayed data', async () => {
    const fetcher = fixture();
    await openDetail();
    fireEvent.change(screen.getByLabelText('E-posta'), { target: { value: 'yeni@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'İletişim bilgilerini kaydet' }));
    expect(await screen.findAllByText('yeni@example.test')).toHaveLength(2);
    const patch = fetcher.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
    expect(patch[0]).toBe('/api/customers/contact-customer');
    expect(JSON.parse(String(patch[1]!.body))).toEqual({
      expectedVersion: 3,
      email: 'yeni@example.test',
    });
    expect(patch[1]!.headers).toMatchObject({
      'X-CSRF-Token': 'csrf',
      'Idempotency-Key': expect.any(String),
    });
    await waitFor(() =>
      expect(
        fetcher.mock.calls.filter(
          ([url, init]) =>
            String(url) === '/api/customers/contact-customer' && init?.method !== 'PATCH',
        ),
      ).toHaveLength(2),
    );
  });

  it('keeps the draft on 409 and writes only edited fields after explicit comparison', async () => {
    let reads = 0;
    let writes = 0;
    const fetcher = fixture((url, init) => {
      if (url !== '/api/customers/contact-customer') return undefined;
      if (init?.method === 'PATCH') {
        writes++;
        return writes === 1 ? response(null, 409) : response({ ...customer, version: 6 });
      }
      return response(
        ++reads === 1
          ? customer
          : {
              ...customer,
              version: 5,
              email: writes < 2 ? 'baska@example.test' : 'taslak@example.test',
              phone: '+902121112233',
            },
      );
    });
    await openDetail();
    fireEvent.change(screen.getByLabelText('E-posta'), {
      target: { value: 'taslak@example.test' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'İletişim bilgilerini kaydet' }));
    await screen.findByText(/Kayıt başka bir işlemde değişti/);
    expect((screen.getByLabelText('E-posta') as HTMLInputElement).value).toBe(
      'taslak@example.test',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Güncel bilgileri yükle' }));
    await screen.findByText('baska@example.test');
    expect((screen.getByLabelText('E-posta') as HTMLInputElement).value).toBe(
      'taslak@example.test',
    );
    expect(writes).toBe(1);
    fireEvent.click(
      screen.getByRole('button', { name: 'Karşılaştırdım, iletişim bilgilerini kaydet' }),
    );
    await screen.findByRole('button', { name: 'İletişim bilgilerini düzenle' });
    const requests = fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH');
    expect(JSON.parse(String(requests[1]![1]!.body))).toEqual({
      expectedVersion: 5,
      email: 'taslak@example.test',
    });
    expect(requests[1]![1]!.headers).not.toEqual(requests[0]![1]!.headers);
    expect(await screen.findAllByText('+902121112233')).toHaveLength(2);
  });

  it('keeps saving blocked and retains the draft when conflict refresh fails', async () => {
    let reads = 0;
    const fetcher = fixture((url, init) => {
      if (url !== '/api/customers/contact-customer') return undefined;
      if (init?.method === 'PATCH') return response(null, 409);
      return ++reads > 1 ? response(null, 503) : undefined;
    });
    await openDetail();
    fireEvent.change(screen.getByLabelText('Adres'), { target: { value: 'Kaybolmayacak' } });
    fireEvent.click(screen.getByRole('button', { name: 'İletişim bilgilerini kaydet' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Güncel bilgileri yükle' }));
    await screen.findByText(/Güncel bilgiler yüklenemedi veya kayda erişilemiyor/);
    expect((screen.getByLabelText('Adres') as HTMLTextAreaElement).value).toBe('Kaybolmayacak');
    expect(
      (screen.getByRole('button', { name: 'İletişim bilgilerini kaydet' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
  });

  it('retains invalid values and server validation errors without disclosing raw messages', async () => {
    const fetcher = fixture((_, init) =>
      init?.method === 'PATCH' ? response(null, 400) : undefined,
    );
    await openDetail();
    fireEvent.change(screen.getByLabelText('E-posta'), { target: { value: 'bozuk' } });
    fireEvent.click(screen.getByRole('button', { name: 'İletişim bilgilerini kaydet' }));
    await screen.findByText('Geçerli bir e-posta adresi girin.');
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PATCH')).toBe(false);
    fireEvent.change(screen.getByLabelText('E-posta'), {
      target: { value: 'duzeltildi@example.test' },
    });
    fireEvent.change(screen.getByLabelText('Adres'), { target: { value: 'Taslak adres' } });
    fireEvent.click(screen.getByRole('button', { name: 'İletişim bilgilerini kaydet' }));
    await screen.findByText(/Girdi doğrulama hatası/);
    expect((screen.getByLabelText('Adres') as HTMLTextAreaElement).value).toBe('Taslak adres');
    expect(screen.queryByText('unsafe SQL')).toBeNull();
  });

  it('clears empty fields as null and safely replays a failed request with the same key/body', async () => {
    let writes = 0;
    const fetcher = fixture((_, init) =>
      init?.method === 'PATCH' && ++writes === 1 ? response(null, 503) : undefined,
    );
    await openDetail();
    for (const label of ['E-posta', 'Telefon', 'Adres'])
      fireEvent.change(screen.getByLabelText(label), { target: { value: '   ' } });
    fireEvent.click(screen.getByRole('button', { name: 'İletişim bilgilerini kaydet' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Aynı isteği tekrar dene' }));
    await screen.findByRole('button', { name: 'İletişim bilgilerini düzenle' });
    const requests = fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH');
    expect(requests).toHaveLength(2);
    expect(requests[1]![1]!.body).toBe(requests[0]![1]!.body);
    expect(requests[1]![1]!.headers).toEqual(requests[0]![1]!.headers);
    expect(JSON.parse(String(requests[0]![1]!.body))).toEqual({
      expectedVersion: 3,
      email: null,
      phone: null,
      address: null,
    });
  });

  it('uses a new key for edited payload after an ambiguous failure', async () => {
    const fetcher = fixture((_, init) =>
      init?.method === 'PATCH' ? Promise.reject(new Error('network')) : undefined,
    );
    await openDetail();
    fireEvent.change(screen.getByLabelText('Telefon'), { target: { value: '+905551112233' } });
    fireEvent.click(screen.getByRole('button', { name: 'İletişim bilgilerini kaydet' }));
    await screen.findByRole('button', { name: 'Aynı isteği tekrar dene' });
    fireEvent.change(screen.getByLabelText('Telefon'), { target: { value: '+905559998877' } });
    expect(screen.queryByRole('button', { name: 'Aynı isteği tekrar dene' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'İletişim bilgilerini kaydet' }));
    await screen.findByRole('button', { name: 'Aynı isteği tekrar dene' });
    const requests = fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH');
    expect(requests[1]![1]!.headers).not.toEqual(requests[0]![1]!.headers);
  });

  it('does not resend a committed PATCH when the detail refresh fails', async () => {
    let reads = 0;
    const fetcher = fixture((url, init) =>
      url === '/api/customers/contact-customer' && init?.method !== 'PATCH' && ++reads === 2
        ? response(null, 503)
        : undefined,
    );
    await openDetail();
    fireEvent.change(screen.getByLabelText('Adres'), { target: { value: 'Yeni adres' } });
    fireEvent.click(screen.getByRole('button', { name: 'İletişim bilgilerini kaydet' }));
    await screen.findByText(/Değişiklikler kaydedildi, ancak güncel detaylar yüklenemedi/);
    fireEvent.click(screen.getByRole('button', { name: 'Güncel bilgileri yükle' }));
    expect(await screen.findAllByText('Yeni adres')).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
  });

  it.each([403, 404])(
    'keeps the draft but blocks writing after permission/access denial %s',
    async (status) => {
      const fetcher = fixture((_, init) =>
        init?.method === 'PATCH' ? response(null, status) : undefined,
      );
      await openDetail();
      fireEvent.change(screen.getByLabelText('Adres'), { target: { value: 'Korunan taslak' } });
      fireEvent.click(screen.getByRole('button', { name: 'İletişim bilgilerini kaydet' }));
      await waitFor(() =>
        expect(
          (screen.getByRole('button', { name: 'İletişim bilgilerini kaydet' }) as HTMLButtonElement)
            .disabled,
        ).toBe(true),
      );
      expect((screen.getByLabelText('Adres') as HTMLTextAreaElement).value).toBe('Korunan taslak');
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH')).toHaveLength(1);
    },
  );

  it('hides edit for archived customers and blocks a customer archived during conflict', async () => {
    const updated = vi.fn();
    const view = render(
      <CustomerContactSection
        customer={{ ...customer, archivedAt: '2026-10-16T01:00:00.000Z' }}
        onUpdated={updated}
      />,
    );
    expect(screen.queryByRole('button', { name: 'İletişim bilgilerini düzenle' })).toBeNull();
    view.unmount();
    let reads = 0;
    fixture((url, init) => {
      if (url !== '/api/customers/contact-customer') return undefined;
      if (init?.method === 'PATCH') return response(null, 409);
      return response(
        ++reads === 1
          ? customer
          : { ...customer, version: 4, archivedAt: '2026-10-16T01:00:00.000Z' },
      );
    });
    await openDetail();
    fireEvent.change(screen.getByLabelText('Adres'), { target: { value: 'Taslak' } });
    fireEvent.click(screen.getByRole('button', { name: 'İletişim bilgilerini kaydet' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Güncel bilgileri yükle' }));
    await screen.findByText(/Bu müşteri arşivlenmiş/);
    expect(
      (
        screen.getByRole('button', {
          name: 'Karşılaştırdım, iletişim bilgilerini kaydet',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it('ignores late responses after navigating to another customer', async () => {
    let resolve!: (value: Response) => void;
    fixture((_, init) =>
      init?.method === 'PATCH'
        ? new Promise<Response>((done) => {
            resolve = done;
          })
        : undefined,
    );
    const updated = vi.fn();
    const view = render(
      <CustomerContactSection key={customer.id} customer={customer} onUpdated={updated} />,
    );
    fireEvent.click(screen.getByRole('button', { name: 'İletişim bilgilerini düzenle' }));
    fireEvent.change(screen.getByLabelText('Adres'), { target: { value: 'Geç yanıt' } });
    fireEvent.click(screen.getByRole('button', { name: 'İletişim bilgilerini kaydet' }));
    await waitFor(() => expect(resolve).toBeDefined());
    view.rerender(
      <CustomerContactSection
        key="other"
        customer={{ ...customer, id: 'other', address: 'Başka adres' }}
        onUpdated={updated}
      />,
    );
    await act(async () => resolve(response({ ...customer, version: 4 })));
    expect(updated).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'İletişim bilgilerini düzenle' }));
    expect((screen.getByLabelText('Adres') as HTMLTextAreaElement).value).toBe('Başka adres');
  });
});
