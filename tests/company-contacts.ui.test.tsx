import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { CompanyContactsSection } from '../src/app/components/CompanyContactsSection';
import type { CustomerDetailDto, CompanyContactDto } from '../src/shared/types';
import { invalidateCsrfToken } from '../src/app/csrf';
const contact = (id: string, isPrimary = false): CompanyContactDto => ({
  id,
  agencyId: 'agency',
  customerId: 'company',
  firstName: id,
  lastName: 'Yetkili',
  role: 'Muhasebe',
  email: null,
  phone: null,
  status: 'ACTIVE',
  isPrimary,
  version: 1,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
});
const customer = {
  id: 'company',
  type: 'COMPANY',
  displayName: 'Sentetik Şirket',
  archivedAt: null,
  contacts: [contact('Birinci', true), contact('İkinci')],
} as unknown as CustomerDetailDto;
const response = (data: unknown, status = 200, code = 'VALIDATION_ERROR') =>
  new Response(
    JSON.stringify(
      status < 400
        ? { success: true, data }
        : { success: false, error: { code, message: 'unsafe SQL detail' } },
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
) {
  const updated = vi.fn();
  const fetcher = vi.fn(
    async (url: string, init?: RequestInit) =>
      override?.(url, init) ??
      (url.endsWith('csrf-token')
        ? response({ token: 'csrf' })
        : init?.method
          ? response(contact('Yeni'), 201)
          : response(customer)),
  );
  vi.stubGlobal('fetch', fetcher);
  return { updated, fetcher };
}
function create() {
  fireEvent.click(screen.getByRole('button', { name: 'Yetkili ekle' }));
  fireEvent.change(screen.getByLabelText('Yetkili adı'), { target: { value: 'Yeni' } });
  fireEvent.change(screen.getByLabelText('Yetkili soyadı'), { target: { value: 'Kişi' } });
}
it('allows only the already pending exact retry after a parent becomes archived', async () => {
  let posts = 0;
  const archived = { ...customer, archivedAt: '2026-01-02T00:00:00Z' };
  const { updated, fetcher } = fixture((url, init) =>
    init?.method === 'POST'
      ? ++posts === 1
        ? response(null, 503)
        : response(contact('Yeni'), 201)
      : url === '/api/customers/company'
        ? response(archived)
        : undefined,
  );
  const view = render(<CompanyContactsSection customer={customer} onUpdated={updated} />);
  create();
  fireEvent.click(screen.getByRole('button', { name: 'Yetkiliyi kaydet' }));
  await screen.findByRole('button', { name: 'Aynı işlemi yeniden dene' });
  view.rerender(<CompanyContactsSection customer={archived} onUpdated={updated} />);
  fireEvent.click(screen.getByRole('button', { name: 'Aynı işlemi yeniden dene' }));
  await screen.findByText('Yetkili eklendi.');
  const attempts = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(attempts).toHaveLength(2);
  expect(attempts[0]![1]).toEqual(attempts[1]![1]);
  expect(screen.queryByRole('button', { name: 'Yetkili ekle' })).toBeNull();
});
it('validates contact names and email before sending any mutation', async () => {
  const { updated, fetcher } = fixture();
  render(<CompanyContactsSection customer={customer} onUpdated={updated} />);
  fireEvent.click(screen.getByRole('button', { name: 'Yetkili ekle' }));
  fireEvent.click(screen.getByRole('button', { name: 'Yetkiliyi kaydet' }));
  expect(screen.getByText('Yetkili adı zorunludur; en fazla 100 karakter olabilir.')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Yetkili adı'), { target: { value: 'Yeni' } });
  fireEvent.change(screen.getByLabelText('Yetkili soyadı'), { target: { value: 'Yetkili' } });
  fireEvent.change(screen.getByLabelText('Yetkili e-postası'), { target: { value: 'invalid' } });
  fireEvent.click(screen.getByRole('button', { name: 'Yetkiliyi kaydet' }));
  expect(screen.getByText('Geçerli bir e-posta girin.')).toBeTruthy();
  expect(fetcher).not.toHaveBeenCalled();
});
it('confirms primary selection with the exact target/version and keeps task assignment out of payloads', async () => {
  const { updated, fetcher } = fixture();
  render(<CompanyContactsSection customer={customer} onUpdated={updated} />);
  fireEvent.click(
    within(screen.getByRole('region', { name: 'İkinci Yetkili' })).getByRole('button', {
      name: 'Birincil yap',
    }),
  );
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Birincil yapmayı onayla' }));
  await screen.findByText('Birincil yetkili değiştirildi.');
  const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(post[0]).toBe('/api/customers/company/contacts/%C4%B0kinci/set-primary');
  expect(JSON.parse(String(post[1]!.body))).toEqual({ expectedVersion: 1 });
});
it.each([403, 404])(
  'hides stale contact history and blocks actions on permission denial %i',
  async (status) => {
    const { updated } = fixture((_url, init) =>
      init?.method === 'POST' ? response(null, status) : undefined,
    );
    render(<CompanyContactsSection customer={customer} onUpdated={updated} />);
    create();
    fireEvent.click(screen.getByRole('button', { name: 'Yetkiliyi kaydet' }));
    await screen.findByRole('alert');
    expect(screen.queryByText('unsafe SQL detail')).toBeNull();
    expect(screen.queryByRole('region', { name: 'Birinci Yetkili' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Yetkili ekle' })).toBeNull();
    expect(updated).not.toHaveBeenCalled();
  },
);
it('ends the session on a revoked write without reusing the action under a different customer', async () => {
  const ended = vi.fn();
  document.addEventListener('mayi-session-ended', ended);
  try {
    const { updated } = fixture((_url, init) =>
      init?.method === 'POST' ? response(null, 401) : undefined,
    );
    render(<CompanyContactsSection customer={customer} onUpdated={updated} />);
    create();
    fireEvent.click(screen.getByRole('button', { name: 'Yetkiliyi kaydet' }));
    await screen.findByRole('alert');
    expect(ended).toHaveBeenCalledOnce();
    expect(updated).not.toHaveBeenCalled();
  } finally {
    document.removeEventListener('mayi-session-ended', ended);
  }
});
it('becomes read-only when a conflict refresh discovers that the company was archived', async () => {
  const { updated } = fixture((url, init) =>
    init?.method === 'POST'
      ? response(null, 409)
      : url === '/api/customers/company'
        ? response({ ...customer, archivedAt: '2026-01-02T00:00:00Z' })
        : undefined,
  );
  render(<CompanyContactsSection customer={customer} onUpdated={updated} />);
  create();
  fireEvent.click(screen.getByRole('button', { name: 'Yetkiliyi kaydet' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Güncel yetkilileri yükle' }));
  await screen.findByText('Arşivlenmiş müşterinin yetkili geçmişi salt okunurdur.');
  expect(screen.getByRole('button', { name: 'Yetkiliyi kaydet' }).hasAttribute('disabled')).toBe(
    true,
  );
});
it('shows active/inactive contact history and no company actions for individual or archived customers', () => {
  const { updated } = fixture();
  const view = render(
    <CompanyContactsSection
      customer={{
        ...customer,
        contacts: [contact('Birinci', true), { ...contact('Pasif'), status: 'INACTIVE' }],
      }}
      onUpdated={updated}
    />,
  );
  expect(screen.getByText('Pasif Yetkili')).toBeTruthy();
  expect(screen.getByText('Birincil yetkili')).toBeTruthy();
  view.rerender(
    <CompanyContactsSection
      customer={{ ...customer, archivedAt: '2026-01-02T00:00:00Z' }}
      onUpdated={updated}
    />,
  );
  expect(screen.queryByRole('button', { name: 'Yetkili ekle' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Pasifleştir' })).toBeNull();
  view.rerender(
    <CompanyContactsSection customer={{ ...customer, type: 'INDIVIDUAL' }} onUpdated={updated} />,
  );
  expect(screen.queryByRole('heading', { name: 'Şirket yetkilileri' })).toBeNull();
});
it('creates with secure protocol and only updates the profile from an authorized detail readback', async () => {
  const { updated, fetcher } = fixture();
  render(<CompanyContactsSection customer={customer} onUpdated={updated} />);
  create();
  fireEvent.click(screen.getByRole('button', { name: 'Yetkiliyi kaydet' }));
  await screen.findByText('Yetkili eklendi.');
  expect(updated).toHaveBeenCalledWith(customer);
  const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(post[0]).toBe('/api/customers/company/contacts');
  expect(JSON.parse(String(post[1]!.body))).toEqual({
    firstName: 'Yeni',
    lastName: 'Kişi',
    role: null,
    email: null,
    phone: null,
    isPrimary: false,
  });
  expect(post[1]!.headers).toMatchObject({
    'X-CSRF-Token': 'csrf',
    'Idempotency-Key': expect.any(String),
  });
});
it('locks an uncertain create and retries the exact serialized body and key', async () => {
  let posts = 0;
  const { updated, fetcher } = fixture((_url, init) =>
    init?.method === 'POST'
      ? ++posts === 1
        ? response(null, 503)
        : response(contact('Yeni'), 201)
      : undefined,
  );
  render(<CompanyContactsSection customer={customer} onUpdated={updated} />);
  create();
  fireEvent.click(screen.getByRole('button', { name: 'Yetkiliyi kaydet' }));
  const retry = await screen.findByRole('button', { name: 'Aynı işlemi yeniden dene' });
  expect(screen.getByLabelText('Yetkili adı').closest('fieldset')!.hasAttribute('disabled')).toBe(
    true,
  );
  fireEvent.click(retry);
  await screen.findByText('Yetkili eklendi.');
  const attempts = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(attempts).toHaveLength(2);
  expect(attempts[0]![1]).toEqual(attempts[1]![1]);
});
it('requires explicit deactivation confirmation and sends only the selected contact version', async () => {
  const { updated, fetcher } = fixture();
  render(<CompanyContactsSection customer={customer} onUpdated={updated} />);
  fireEvent.click(
    within(screen.getByRole('region', { name: 'Birinci Yetkili' })).getByRole('button', {
      name: 'Pasifleştir',
    }),
  );
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Pasifleştirmeyi onayla' }));
  await screen.findByText('Yetkili pasifleştirildi.');
  const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(post[0]).toBe('/api/customers/company/contacts/Birinci/deactivate');
  expect(JSON.parse(String(post[1]!.body))).toEqual({ expectedVersion: 1 });
});
it('keeps edit draft on conflict, refreshes latest version and submits only changed fields after comparison', async () => {
  let writes = 0;
  const latest = {
    ...customer,
    contacts: [
      contact('Birinci', true),
      { ...contact('İkinci'), role: 'Başkasının görevi', version: 3 },
    ],
  };
  const { updated, fetcher } = fixture((url, init) =>
    init?.method === 'PATCH'
      ? ++writes === 1
        ? response(null, 409)
        : response(contact('İkinci'))
      : url === '/api/customers/company'
        ? response(latest)
        : undefined,
  );
  const view = render(<CompanyContactsSection customer={customer} onUpdated={updated} />);
  fireEvent.click(
    within(screen.getByRole('region', { name: 'İkinci Yetkili' })).getByRole('button', {
      name: 'Yetkiliyi düzenle',
    }),
  );
  fireEvent.change(screen.getByLabelText('Yetkili e-postası'), {
    target: { value: 'new@demo.invalid' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Değişiklikleri kaydet' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Güncel yetkilileri yükle' }));
  await screen.findByText('Başkasının görevi');
  expect((screen.getByLabelText('Yetkili e-postası') as HTMLInputElement).value).toBe(
    'new@demo.invalid',
  );
  // An unrelated parent refresh must not silently advance the compared CAS.
  view.rerender(
    <CompanyContactsSection
      customer={{
        ...latest,
        contacts: latest.contacts.map((c) => (c.id === 'İkinci' ? { ...c, version: 9 } : c)),
      }}
      onUpdated={updated}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Karşılaştırdım, değişiklikleri kaydet' }));
  await screen.findByText('Yetkili bilgileri güncellendi.');
  const attempts = fetcher.mock.calls.filter(([, init]) => init?.method === 'PATCH');
  expect(JSON.parse(String(attempts[1]![1]!.body))).toEqual({
    expectedVersion: 3,
    email: 'new@demo.invalid',
  });
});
it('never repeats a committed write when authorized refresh fails', async () => {
  let reads = 0;
  const { updated, fetcher } = fixture((url, init) =>
    !init?.method && url === '/api/customers/company'
      ? ++reads === 1
        ? response(null, 503)
        : response(customer)
      : undefined,
  );
  render(<CompanyContactsSection customer={customer} onUpdated={updated} />);
  create();
  fireEvent.click(screen.getByRole('button', { name: 'Yetkiliyi kaydet' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Güncel yetkilileri yükle' }));
  await screen.findByText('Yetkili eklendi.');
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});
it.each(['csrf', 'detail'])(
  'ignores a late %s response after switching keyed customer profiles',
  async (stage) => {
    let release!: (value: Response) => void;
    const deferred = new Promise<Response>((resolve) => {
      release = resolve;
    });
    const delayedUrl = stage === 'csrf' ? '/api/csrf-token' : '/api/customers/company';
    const { updated, fetcher } = fixture((url) => (url === delayedUrl ? deferred : undefined));
    const view = render(
      <CompanyContactsSection key="company" customer={customer} onUpdated={updated} />,
    );
    create();
    fireEvent.click(screen.getByRole('button', { name: 'Yetkiliyi kaydet' }));
    await vi.waitFor(() =>
      expect(fetcher.mock.calls.some(([url]) => url === delayedUrl)).toBe(true),
    );
    const nextUpdated = vi.fn();
    view.rerender(
      <CompanyContactsSection
        key="other"
        customer={{ ...customer, id: 'other', contacts: [] }}
        onUpdated={nextUpdated}
      />,
    );
    await act(async () => {
      release(stage === 'csrf' ? response({ token: 'csrf' }) : response(customer));
    });
    expect(updated).not.toHaveBeenCalled();
    expect(nextUpdated).not.toHaveBeenCalled();
    expect(screen.queryByText('Birinci Yetkili')).toBeNull();
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(
      stage === 'csrf' ? 0 : 1,
    );
    expect(fetcher.mock.calls.some(([url]) => url.includes('/other'))).toBe(false);
  },
);
it('ignores a late mutation after switching to a different keyed customer profile', async () => {
  let release!: (r: Response) => void;
  const { updated } = fixture((_url, init) =>
    init?.method === 'POST'
      ? new Promise<Response>((resolve) => {
          release = resolve;
        })
      : undefined,
  );
  const view = render(
    <CompanyContactsSection key="company" customer={customer} onUpdated={updated} />,
  );
  create();
  fireEvent.click(screen.getByRole('button', { name: 'Yetkiliyi kaydet' }));
  await screen.findByRole('status');
  view.rerender(
    <CompanyContactsSection
      key="other"
      customer={{ ...customer, id: 'other', contacts: [] }}
      onUpdated={updated}
    />,
  );
  await act(async () => release(response(contact('Yeni'), 201)));
  expect(updated).not.toHaveBeenCalled();
  expect(screen.queryByText('Yetkili eklendi.')).toBeNull();
});
