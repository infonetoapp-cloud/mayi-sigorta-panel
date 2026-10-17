import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Link } from 'react-router';
import CustomerListPage from '../src/app/pages/customers/CustomerListPage';
import CustomerProfilePage from '../src/app/pages/customers/CustomerProfilePage';
const customer = (id: string) => ({
  id,
  displayName: id === 'a' ? 'Ahmet Müşteri' : 'Ayşe Müşteri',
  type: 'INDIVIDUAL',
  email: 'ornek@demo.invalid',
  phone: null,
  address: null,
  archivedAt: null,
  version: 1,
  createdAt: '2026-01-01T00:00:00Z',
  identityMasked: 'PROTECTED-MASK',
  identityValue: 'PROTECTED-IDENTITY',
});
const reply = (data: unknown, status = 200) =>
  new Response(
    JSON.stringify({
      success: status < 400,
      data,
      ...(status >= 400 ? { error: { message: 'unsafe SQL diagnostic' } } : {}),
    }),
    { status },
  );
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function profile() {
  return render(
    <MemoryRouter initialEntries={['/customers/a']}>
      <Link to="/customers/b">Diğer müşteri</Link>
      <Routes>
        <Route path="/customers/:customerId" element={<CustomerProfilePage />} />
      </Routes>
    </MemoryRouter>,
  );
}
it('edits contact fields inline and refreshes the profile header only after confirmed readback', async () => {
  let current = customer('a');
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('csrf-token')) return reply({ token: 'synthetic-csrf' });
    if (init?.method === 'PATCH') {
      current = { ...current, email: JSON.parse(String(init.body)).email, version: 2 };
      return reply(current);
    }
    return reply(current);
  });
  vi.stubGlobal('fetch', fetcher);
  profile();
  fireEvent.click(await screen.findByRole('link', { name: 'İletişim' }));
  fireEvent.click(screen.getByRole('button', { name: 'Düzenle' }));
  fireEvent.change(screen.getByLabelText('E-posta'), { target: { value: 'modern@demo.invalid' } });
  fireEvent.click(screen.getByRole('button', { name: 'İletişim bilgilerini kaydet' }));
  await screen.findByText('İletişim bilgileri kaydedildi.');
  expect(screen.getAllByText('modern@demo.invalid')).toHaveLength(2);
  const write = fetcher.mock.calls.find(([, init]) => init?.method === 'PATCH')!;
  expect(JSON.parse(String(write[1]!.body))).toEqual({
    expectedVersion: 1,
    email: 'modern@demo.invalid',
  });
});
it('does not offer modern contact editing on archived customers', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => reply({ ...customer('a'), archivedAt: '2026-01-02T00:00:00Z' })),
  );
  profile();
  fireEvent.click(await screen.findByRole('link', { name: 'İletişim' }));
  expect(screen.queryByRole('button', { name: 'Düzenle' })).toBeNull();
  expect(screen.getByText('Arşivlenmiş müşterinin iletişim bilgileri düzenlenemez.')).toBeTruthy();
});
it('hides an already loaded profile immediately while the next profile loads', async () => {
  let release!: (response: Response) => void;
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) =>
      url.endsWith('/a')
        ? Promise.resolve(reply(customer('a')))
        : new Promise<Response>((resolve) => {
            release = resolve;
          }),
    ),
  );
  profile();
  await screen.findByRole('heading', { name: 'Ahmet Müşteri' });
  fireEvent.click(screen.getByRole('link', { name: 'Diğer müşteri' }));
  expect(screen.queryByRole('heading', { name: 'Ahmet Müşteri' })).toBeNull();
  expect(screen.getByRole('status')).toBeTruthy();
  await act(async () => release(reply(customer('b'))));
  await screen.findByRole('heading', { name: 'Ayşe Müşteri' });
});
it('retries the exact failed cursor and restarts filtering without old page records', async () => {
  const requests: string[] = [];
  let second = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      requests.push(url);
      return url.includes('cursor=next')
        ? ++second === 1
          ? reply(null, 503)
          : reply({ items: [customer('b')], nextCursor: null, hasMore: false })
        : reply({ items: [customer('a')], nextCursor: 'next', hasMore: true });
    }),
  );
  render(
    <MemoryRouter>
      <CustomerListPage />
    </MemoryRouter>,
  );
  await screen.findByRole('link', { name: 'Ahmet Müşteri' });
  fireEvent.click(screen.getByRole('button', { name: 'Sonraki sayfa' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Yeniden dene' }));
  await screen.findByRole('link', { name: 'Ayşe Müşteri' });
  expect(requests.slice(-2)).toEqual([
    '/api/customers?limit=20&cursor=next',
    '/api/customers?limit=20&cursor=next',
  ]);
  expect(screen.queryByRole('link', { name: 'Ahmet Müşteri' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Ara' }));
  await screen.findByRole('link', { name: 'Ahmet Müşteri' });
  expect(requests.at(-1)).toBe('/api/customers?limit=20');
});
it('shows empty and permission-denied lists without reflecting server diagnostics', async () => {
  const fetcher = vi.fn(async () => reply({ items: [], nextCursor: null, hasMore: false }));
  vi.stubGlobal('fetch', fetcher);
  render(
    <MemoryRouter>
      <CustomerListPage />
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { name: 'Müşteri bulunamadı' });
  fetcher.mockImplementation(async () => reply(null, 403));
  fireEvent.click(screen.getByRole('button', { name: 'Ara' }));
  await screen.findByRole('heading', { name: 'Erişim izni gerekli' });
  expect(screen.queryByText('unsafe SQL diagnostic')).toBeNull();
});
it('uses the same notes mutation key/body on an uncertain write in the full-page workspace', async () => {
  let posts = 0;
  const note = {
    id: 'n',
    content: 'Ortak müşteri notu.',
    authorName: 'Tarihsel Ayşe',
    createdAt: '2026-10-14T21:30:00Z',
  };
  const fetcher = vi.fn(async (url: string, init?: RequestInit) =>
    url.endsWith('csrf-token')
      ? reply({ token: 'synthetic-csrf' })
      : url.endsWith('/notes')
        ? init?.method === 'POST'
          ? ++posts === 1
            ? reply(null, 503)
            : reply(note, 201)
          : reply({ items: [note], nextCursor: null, canCreate: true })
        : reply(customer('a')),
  );
  vi.stubGlobal('fetch', fetcher);
  profile();
  fireEvent.click(await screen.findByRole('link', { name: 'Müşteri notları' }));
  await screen.findByText('Kaydeden: Tarihsel Ayşe');
  expect(screen.getByText('15 Eki 2026 00:30')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Yeni müşteri notu'), { target: { value: note.content } });
  fireEvent.click(screen.getByRole('button', { name: 'Notu kaydet' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Aynı notu yeniden dene' }));
  await screen.findByText('Not kaydedildi.');
  const writes = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(writes).toHaveLength(2);
  expect(writes[0]![1]!.body).toBe(JSON.stringify({ content: note.content }));
  expect(writes[1]![1]).toEqual(writes[0]![1]);
  expect(writes[0]![1]!.headers).toMatchObject({
    'X-CSRF-Token': 'synthetic-csrf',
    'Idempotency-Key': expect.any(String),
  });
});
it('shows bounded server-paged customers with profile links and server search/type filtering', async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      requests.push(url);
      return reply({ items: [customer('a')], nextCursor: 'next', hasMore: true });
    }),
  );
  render(
    <MemoryRouter>
      <CustomerListPage />
    </MemoryRouter>,
  );
  expect((await screen.findByRole('link', { name: 'Ahmet Müşteri' })).getAttribute('href')).toBe(
    '/customers/a',
  );
  fireEvent.change(screen.getByLabelText('Müşteri türü'), { target: { value: 'COMPANY' } });
  fireEvent.change(screen.getByLabelText('Müşteri ara'), { target: { value: 'Deniz' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ara' }));
  await screen.findByRole('link', { name: 'Ahmet Müşteri' });
  expect(requests.at(-1)).toContain('search=Deniz');
  expect(requests.at(-1)).toContain('type=COMPANY');
  expect(requests.every((url) => url.includes('limit=20'))).toBe(true);
  expect(screen.queryByText(/PROTECTED/)).toBeNull();
});
it('never renders prior customer data while switching or after a late response', async () => {
  const pending = new Map<string, (r: Response) => void>();
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => new Promise<Response>((resolve) => pending.set(url, resolve))),
  );
  profile();
  fireEvent.click(screen.getByRole('link', { name: 'Diğer müşteri' }));
  await act(async () => {
    pending.get('/api/customers/b')!(reply(customer('b')));
  });
  await screen.findByRole('heading', { name: 'Ayşe Müşteri' });
  await act(async () => {
    pending.get('/api/customers/a')!(reply(customer('a')));
  });
  expect(screen.queryByText('Ahmet Müşteri')).toBeNull();
  expect(screen.queryByText(/PROTECTED/)).toBeNull();
  expect(screen.getByRole('link', { name: 'İleri müşteri işlemleri' }).getAttribute('href')).toBe(
    '/customers/b/advanced',
  );
});
it.each([403, 404, 500])(
  'renders safe profile denial/error %i without sensitive fields',
  async (status) => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => reply({}, status)),
    );
    profile();
    await screen.findByRole('alert');
    expect(screen.queryByText('unsafe SQL diagnostic')).toBeNull();
    expect(screen.queryByRole('link', { name: 'İleri müşteri işlemleri' })).toBeNull();
  },
);
it('dispatches session end on unauthorized profile reads', async () => {
  const ended = vi.fn();
  document.addEventListener('mayi-session-ended', ended);
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => reply({}, 401)),
  );
  profile();
  await screen.findByRole('alert');
  expect(ended).toHaveBeenCalledOnce();
  document.removeEventListener('mayi-session-ended', ended);
});
