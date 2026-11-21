import { CustomerIdentitySection } from '../src/app/components/CustomerIdentitySection';
import type { CustomerDetailDto } from '../src/shared/types';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useSearchParams } from 'react-router';
import CustomerCreatePage from '../src/app/pages/customers/CustomerCreatePage';
import { invalidateCsrfToken } from '../src/app/csrf';
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
function PolicyDestination() {
  const [params] = useSearchParams();
  return <h1>Poliçe müşterisi: {params.get('customerId')}</h1>;
}
function mount() {
  const fetcher = vi.mocked(fetch),
    original = fetcher.getMockImplementation();
  fetcher.mockImplementation((url, init) =>
    String(url) === '/api/catalogs/insurers'
      ? Promise.resolve(response([{ id: 'insurer-test', name: 'Test Sigorta' }]))
      : original!(url, init),
  );
  return render(
    <MemoryRouter initialEntries={['/customers/new']}>
      <Routes>
        <Route path="/customers/new" element={<CustomerCreatePage />} />
        <Route path="/customers/:customerId" element={<h1>Modern müşteri profili</h1>} />
        <Route path="/policies/new" element={<PolicyDestination />} />
      </Routes>
    </MemoryRouter>,
  );
}
it('preserves the save-and-add-policy destination through an uncertain creation retry', async () => {
  let count = 0;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) =>
    url.endsWith('csrf-token')
      ? response({ token: 'csrf' })
      : init?.method === 'POST' && ++count === 1
        ? response(null, 503)
        : response({ id: 'confirmed-customer' }, 201),
  );
  vi.stubGlobal('fetch', fetcher);
  mount();
  await fill();
  fireEvent.click(screen.getByRole('button', { name: 'Kaydet ve poliçe ekle' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Aynı kaydı güvenle yeniden dene' }));
  await screen.findByRole('heading', { name: 'Poliçe müşterisi: confirmed-customer' });
  const writes = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(writes).toHaveLength(2);
  expect(writes[1]![1]).toEqual(writes[0]![1]);
});
it('ends the protected session when the CSRF request discovers revocation', async () => {
  const ended = vi.fn();
  document.addEventListener('mayi-session-ended', ended);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response(null, 401)),
  );
  mount();
  await fill();
  fireEvent.click(screen.getByRole('button', { name: 'Müşteriyi kaydet' }));
  await screen.findByRole('alert');
  expect(ended).toHaveBeenCalledOnce();
  document.removeEventListener('mayi-session-ended', ended);
});
async function fill() {
  await fillNumber();
  fireEvent.change(screen.getByLabelText('Ad'), { target: { value: 'Deniz' } });
  fireEvent.change(screen.getByLabelText('Soyad'), { target: { value: 'Yılmaz' } });
}
async function fillNumber() {
  await screen.findByRole('option', { name: 'Test Sigorta' });
  fireEvent.change(screen.getByLabelText('Sigorta şirketi (zorunlu)'), {
    target: { value: 'insurer-test' },
  });
  fireEvent.change(screen.getByLabelText('Şirket müşteri no (zorunlu)'), {
    target: { value: '000123' },
  });
}
it('validates inline without requests then creates an individual with server-owned authority', async () => {
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) =>
    url.endsWith('csrf-token')
      ? response({ token: 'csrf' })
      : response({ id: 'new-customer' }, 201),
  );
  vi.stubGlobal('fetch', fetcher);
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Müşteriyi kaydet' }));
  await screen.findByText('Ad zorunludur.');
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
  await fill();
  fireEvent.click(screen.getByRole('button', { name: 'Müşteriyi kaydet' }));
  await screen.findByRole('heading', { name: 'Modern müşteri profili' });
  const post = fetcher.mock.calls.find(([url]) => url === '/api/customers');
  expect(post).toBeTruthy();
});
it('keeps ambiguous creation locked and retries the exact key/body without a duplicate operation', async () => {
  let count = 0;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) =>
    url.endsWith('csrf-token')
      ? response({ token: 'csrf' })
      : init?.method === 'POST'
        ? ++count === 1
          ? response(null, 503)
          : response({ id: 'replayed' }, 201)
        : response(null),
  );
  vi.stubGlobal('fetch', fetcher);
  mount();
  await fill();
  fireEvent.click(screen.getByRole('button', { name: 'Müşteriyi kaydet' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Aynı kaydı güvenle yeniden dene' }));
  await screen.findByRole('heading', { name: 'Modern müşteri profili' });
  const writes = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(writes).toHaveLength(2);
  expect(writes[1]![1]).toEqual(writes[0]![1]);
  expect(JSON.parse(String(writes[0]![1]!.body))).toEqual({
    type: 'INDIVIDUAL',
    firstName: 'Deniz',
    lastName: 'Yılmaz',
    insurerNumber: { insurerId: 'insurer-test', customerNumber: '000123' },
    email: null,
    phone: null,
    address: null,
  });
  expect(writes[0]![1]!.headers).toMatchObject({
    'X-CSRF-Token': 'csrf',
    'Idempotency-Key': expect.any(String),
  });
});
it('creates a company without hidden individual fields and keeps safe duplicate/permission feedback', async () => {
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) =>
    url.endsWith('csrf-token')
      ? response({ token: 'csrf' })
      : response(null, 409, 'IDEMPOTENCY_CONFLICT'),
  );
  vi.stubGlobal('fetch', fetcher);
  mount();
  await fill();
  fireEvent.change(screen.getByLabelText('Müşteri türü'), { target: { value: 'COMPANY' } });
  fireEvent.change(screen.getByLabelText('Şirket unvanı'), { target: { value: 'Deneme AŞ' } });
  fireEvent.change(screen.getByLabelText('Vergi no (zorunlu)'), {
    target: { value: '0012345678' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Müşteriyi kaydet' }));
  await screen.findByRole('alert');
  expect(screen.queryByText('unsafe SQL diagnostic')).toBeNull();
  const write = fetcher.mock.calls.find(([url]) => url === '/api/customers')!;
  expect(JSON.parse(String(write[1]!.body))).toEqual({
    type: 'COMPANY',
    companyTitle: 'Deneme AŞ',
    taxNumber: '0012345678',
    insurerNumber: { insurerId: 'insurer-test', customerNumber: '000123' },
    email: null,
    phone: null,
    address: null,
  });
  expect(screen.queryByRole('heading', { name: 'Modern müşteri profili' })).toBeNull();
});
it('does not navigate after an unmounted creation resolves', async () => {
  let release!: (r: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      url.endsWith('csrf-token')
        ? Promise.resolve(response({ token: 'csrf' }))
        : new Promise<Response>((resolve) => {
            release = resolve;
          }),
    ),
  );
  const view = mount();
  await fill();
  fireEvent.click(screen.getByRole('button', { name: 'Müşteriyi kaydet' }));
  await screen.findByText('Kaydediliyor…');
  await act(async () => Promise.resolve());
  view.unmount();
  await act(async () => release(response({ id: 'late' }, 201)));
  expect(screen.queryByRole('heading', { name: 'Modern müşteri profili' })).toBeNull();
});

it('sends a real employee membership and date-only birthday; supports manual reference for companies', async () => {
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) =>
    url.includes('reference-options')
      ? response({
          items: [{ membershipId: 'employee-1', displayName: 'Abdurrahman Işık' }],
          nextCursor: null,
        })
      : url.endsWith('csrf-token')
        ? response({ token: 'csrf' })
        : response({ id: 'new-customer' }, 201),
  );
  vi.stubGlobal('fetch', fetcher);
  const view = mount();
  await fill();
  const select = screen.getByLabelText('Referans kişi');
  fireEvent.focus(select);
  await screen.findByRole('option', { name: 'Abdurrahman Işık' });
  fireEvent.change(select, { target: { value: 'employee-1' } });
  fireEvent.input(screen.getByLabelText('Doğum tarihi'), { target: { value: '1990-02-28' } });
  fireEvent.click(screen.getByRole('button', { name: 'Müşteriyi kaydet' }));
  await screen.findByRole('heading', { name: 'Modern müşteri profili' });
  expect(
    JSON.parse(String(fetcher.mock.calls.find(([url]) => url === '/api/customers')![1]!.body)),
  ).toMatchObject({
    referenceMembershipId: 'employee-1',
    referenceName: 'Abdurrahman Işık',
    birthDate: '1990-02-28',
  });
  view.unmount();
  fetcher.mockClear();
  mount();
  fireEvent.change(screen.getByLabelText('Müşteri türü'), { target: { value: 'COMPANY' } });
  fireEvent.change(screen.getByLabelText('Şirket unvanı'), {
    target: { value: 'Sentetik Şirket' },
  });
  await fillNumber();
  fireEvent.change(screen.getByLabelText('Vergi no (zorunlu)'), {
    target: { value: '0012345678' },
  });
  expect(screen.queryByLabelText('Doğum tarihi')).toBeNull();
  fireEvent.change(screen.getByLabelText('Referans kişi'), { target: { value: 'manual' } });
  fireEvent.change(screen.getByLabelText('Referans kişinin adı soyadı'), {
    target: { value: 'Dış Referans' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Müşteriyi kaydet' }));
  await screen.findByRole('heading', { name: 'Modern müşteri profili' });
  const payload = JSON.parse(
    String(fetcher.mock.calls.find(([url]) => url === '/api/customers')![1]!.body),
  );
  expect(payload.referenceName).toBe('Dış Referans');
  expect(payload.birthDate).toBeUndefined();
  expect(payload.referenceMembershipId).toBeUndefined();
});

it('focuses a future birthday error without submitting the customer', async () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  mount();
  await fill();
  fireEvent.input(screen.getByLabelText('Doğum tarihi'), { target: { value: '2999-01-01' } });
  fireEvent.click(screen.getByRole('button', { name: 'Müşteriyi kaydet' }));
  expect(
    await screen.findByText('Geçerli, gelecekte olmayan bir doğum tarihi girin.'),
  ).toBeTruthy();
  expect(document.activeElement).toBe(screen.getByLabelText('Doğum tarihi'));
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(0);
});

it('requires a manual number for individuals and a tax number for companies before submitting', async () => {
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => response({ token: 'csrf' }));
  vi.stubGlobal('fetch', fetcher);
  mount();
  await fill();
  fireEvent.change(screen.getByLabelText('Şirket müşteri no (zorunlu)'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Müşteriyi kaydet' }));
  expect(document.activeElement).toBe(screen.getByLabelText('Şirket müşteri no (zorunlu)'));
  fireEvent.change(screen.getByLabelText('Müşteri türü'), { target: { value: 'COMPANY' } });
  fireEvent.change(screen.getByLabelText('Şirket unvanı'), { target: { value: 'Sentetik' } });
  await fillNumber();
  fireEvent.click(screen.getByRole('button', { name: 'Müşteriyi kaydet' }));
  const tax = screen.getByLabelText('Vergi no (zorunlu)') as HTMLInputElement;
  expect(document.activeElement).toBe(tax);
  expect(tax.required).toBe(true);
  expect(tax.type).toBe('text');
  expect(tax.inputMode).toBe('numeric');
  expect(tax.getAttribute('aria-invalid')).toBe('true');
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});

it('allows correcting an atomically rejected duplicate company customer number without unlocking uncertain writes', async () => {
  const fetcher = vi.fn(async (url: string, _init?: RequestInit) =>
    url.endsWith('csrf-token')
      ? response({ token: 'csrf' })
      : response(null, 409, 'DUPLICATE_EXTERNAL_REFERENCE'),
  );
  vi.stubGlobal('fetch', fetcher);
  mount();
  await fill();
  fireEvent.click(screen.getByRole('button', { name: 'Müşteriyi kaydet' }));
  await screen.findByText(/müşteri no başka bir müşteride kayıtlı/);
  const input = screen.getByLabelText('Şirket müşteri no (zorunlu)') as HTMLInputElement;
  expect(input.closest('fieldset')?.disabled).toBe(false);
  fireEvent.change(input, { target: { value: '000124' } });
  fireEvent.click(screen.getByRole('button', { name: 'Müşteriyi kaydet' }));
  await act(async () => {});
  const writes = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(writes).toHaveLength(2);
  expect(JSON.parse(String(writes[1]![1]!.body))).toMatchObject({
    insurerNumber: { customerNumber: '000124' },
  });
  expect(writes[1]![1]!.headers).not.toEqual(writes[0]![1]!.headers);
});

it('keeps tax-number correction available without offering corporate identifier deletion', () => {
  const customer = {
    id: 'synthetic-company',
    type: 'COMPANY',
    hasIdentity: true,
    version: 1,
  } as CustomerDetailDto;
  const view = render(
    <CustomerIdentitySection customer={customer} onCustomerReload={async () => {}} styles={{}} />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Kimlik Bilgisini Güncelle' }));
  expect(screen.queryByRole('button', { name: 'Kimliği Kaldır' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Kimliği Kaydet' })).toBeTruthy();
  view.unmount();
  render(
    <CustomerIdentitySection
      customer={{ ...customer, type: 'INDIVIDUAL' }}
      onCustomerReload={async () => {}}
      styles={{}}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Kimlik Bilgisini Güncelle' }));
  expect(screen.getByRole('button', { name: 'Kimliği Kaldır' })).toBeTruthy();
});

it('gives a legacy company missing its tax number a named repair form', () => {
  render(
    <CustomerIdentitySection
      customer={
        {
          id: 'legacy-company',
          type: 'COMPANY',
          hasIdentity: false,
          version: 1,
        } as CustomerDetailDto
      }
      onCustomerReload={async () => {}}
      styles={{}}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Vergi numarası ekle' }));
  expect(screen.getByRole('form', { name: 'Vergi numarası (VKN)' })).toBeTruthy();
  const input = screen.getByRole('textbox', { name: 'Vergi numarası (10 hane)' });
  expect(input.getAttribute('inputmode')).toBe('numeric');
  expect(input.hasAttribute('required')).toBe(true);
  expect(screen.queryByRole('combobox')).toBeNull();
});
