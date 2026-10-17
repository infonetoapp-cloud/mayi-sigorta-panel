import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
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
function mount() {
  return render(
    <MemoryRouter initialEntries={['/customers/new']}>
      <Routes>
        <Route path="/customers/new" element={<CustomerCreatePage />} />
        <Route path="/customers/:customerId" element={<h1>Modern müşteri profili</h1>} />
      </Routes>
    </MemoryRouter>,
  );
}
it('ends the protected session when the CSRF request discovers revocation', async () => {
  const ended = vi.fn();
  document.addEventListener('mayi-session-ended', ended);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response(null, 401)),
  );
  mount();
  fill();
  fireEvent.click(screen.getByRole('button', { name: 'Müşteriyi kaydet' }));
  await screen.findByRole('alert');
  expect(ended).toHaveBeenCalledOnce();
  document.removeEventListener('mayi-session-ended', ended);
});
function fill() {
  fireEvent.change(screen.getByLabelText('Ad'), { target: { value: 'Deniz' } });
  fireEvent.change(screen.getByLabelText('Soyad'), { target: { value: 'Yılmaz' } });
}
it('validates inline without requests then creates an individual with server-owned authority', async () => {
  const fetcher = vi.fn(async (url: string) =>
    url.endsWith('csrf-token')
      ? response({ token: 'csrf' })
      : response({ id: 'new-customer' }, 201),
  );
  vi.stubGlobal('fetch', fetcher);
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Müşteriyi kaydet' }));
  await screen.findByText('Ad zorunludur.');
  expect(fetcher).not.toHaveBeenCalled();
  fill();
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
  fill();
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
  fill();
  fireEvent.change(screen.getByLabelText('Müşteri türü'), { target: { value: 'COMPANY' } });
  fireEvent.change(screen.getByLabelText('Şirket unvanı'), { target: { value: 'Deneme AŞ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Müşteriyi kaydet' }));
  await screen.findByRole('alert');
  expect(screen.queryByText('unsafe SQL diagnostic')).toBeNull();
  const write = fetcher.mock.calls.find(([url]) => url === '/api/customers')!;
  expect(JSON.parse(String(write[1]!.body))).toEqual({
    type: 'COMPANY',
    companyTitle: 'Deneme AŞ',
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
  fill();
  fireEvent.click(screen.getByRole('button', { name: 'Müşteriyi kaydet' }));
  await screen.findByText('Kaydediliyor…');
  await act(async () => Promise.resolve());
  view.unmount();
  await act(async () => release(response({ id: 'late' }, 201)));
  expect(screen.queryByRole('heading', { name: 'Modern müşteri profili' })).toBeNull();
});
