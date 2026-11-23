import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Link, useNavigate } from 'react-router';
import CustomerListPage from '../src/app/pages/customers/CustomerListPage';
import CustomerProfilePage from '../src/app/pages/customers/CustomerProfilePage';
import { customerDetailFixture } from './support/customer-detail-fixture';
import { CustomerListContextProvider } from '../src/app/pages/customers/customer-list-context';
import { WorkNavigationProvider } from '../src/app/pages/today-work/work-navigation';
const customer = (id: string) => ({
  ...customerDetailFixture(id, {
    displayName: id === 'a' ? 'Ahmet Müşteri' : 'Ayşe Müşteri',
    email: 'ornek@demo.invalid',
  }),
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
it('opens only the selected customer in management without fetching the directory or closed tools', async () => {
  const fetcher = vi.fn(async () => reply(customer('a')));
  vi.stubGlobal('fetch', fetcher);
  render(
    <MemoryRouter initialEntries={['/customers/a/advanced']}>
      <Routes>
        <Route path="/customers/:customerId/advanced" element={<CustomerProfilePage />} />
      </Routes>
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { name: 'Müşteri işlemleri' });
  expect(screen.getByRole('heading', { name: 'Ahmet Müşteri' })).toBeTruthy();
  expect(fetcher.mock.calls).toHaveLength(1);
  expect(fetcher).toHaveBeenCalledWith('/api/customers/a', expect.anything());
});
it('edits contact fields in a dialog and displays the confirmed email once', async () => {
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
  const dialog = screen.getByRole('dialog', { name: 'İletişim bilgilerini düzenle' });
  fireEvent.change(screen.getByLabelText('E-posta'), { target: { value: 'modern@demo.invalid' } });
  fireEvent.click(screen.getByRole('button', { name: 'İletişim bilgilerini kaydet' }));
  await screen.findByText('İletişim bilgileri kaydedildi.');
  expect(dialog.isConnected).toBe(false);
  expect(screen.getByRole('link', { name: 'modern@demo.invalid' }).getAttribute('href')).toBe(
    'mailto:modern@demo.invalid',
  );
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
          ? reply({ items: [null], nextCursor: null, hasMore: false })
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
    '/api/customers?limit=20&include=coverage&cursor=next',
    '/api/customers?limit=20&include=coverage&cursor=next',
  ]);
  expect(screen.queryByRole('link', { name: 'Ahmet Müşteri' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Ara' }));
  await screen.findByRole('link', { name: 'Ahmet Müşteri' });
  expect(requests.at(-1)).toBe('/api/customers?limit=20&include=coverage');
});
function HistoryBack() {
  const navigate = useNavigate();
  return <button onClick={() => void navigate(-1)}>Tarayıcı geri</button>;
}
it('fetches only the new customer query, and refreshes once when the same search is repeated', async () => {
  const fetcher = vi.fn(async (_url: string) =>
    reply({ items: [customer('a')], nextCursor: null, hasMore: false }),
  );
  vi.stubGlobal('fetch', fetcher);
  render(
    <MemoryRouter>
      <CustomerListPage />
    </MemoryRouter>,
  );
  await screen.findByRole('link', { name: 'Ahmet Müşteri' });
  fireEvent.change(screen.getByLabelText('Müşteri ara'), { target: { value: 'İpek Şahin' } });
  const search = screen.getByRole('button', { name: 'Ara' });
  fireEvent.click(search);
  await screen.findByRole('link', { name: 'Ahmet Müşteri' });
  expect(fetcher).toHaveBeenCalledTimes(2);
  const target = fetcher.mock.calls[1]![0];
  expect(new URLSearchParams(target.split('?')[1]).get('search')).toBe('İpek Şahin');
  fireEvent.click(search);
  await screen.findByRole('link', { name: 'Ahmet Müşteri' });
  expect(fetcher.mock.calls.slice(1).map(([url]) => url)).toEqual([target, target]);
});
it('restores the filtered second page and the exact profile link through both return paths', async () => {
  const requests: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (url === '/api/customers/b') return reply(customer('b'));
      if (url === '/api/customers/reference-options')
        return reply({
          items: [{ membershipId: 'm1', displayName: 'Abdurrahman' }],
          nextCursor: null,
        });
      if (!url.startsWith('/api/customers?')) return reply({ items: [] });
      requests.push(url);
      return url.includes('cursor=next')
        ? reply({ items: [customer('b')], nextCursor: null, hasMore: false })
        : reply({ items: [customer('a')], nextCursor: 'next', hasMore: true });
    }),
  );
  const scroll = vi.fn();
  vi.stubGlobal('scrollTo', scroll);
  vi.stubGlobal('scrollY', 0);
  render(
    <MemoryRouter initialEntries={['/customers']}>
      <WorkNavigationProvider>
        <CustomerListContextProvider>
          <HistoryBack />
          <Routes>
            <Route path="/customers" element={<CustomerListPage />} />
            <Route path="/customers/:customerId" element={<CustomerProfilePage />} />
          </Routes>
        </CustomerListContextProvider>
      </WorkNavigationProvider>
    </MemoryRouter>,
  );
  await screen.findByRole('link', { name: 'Ahmet Müşteri' });
  fireEvent.focus(screen.getByLabelText('Referans kişi'));
  await screen.findByRole('option', { name: 'Abdurrahman' });
  fireEvent.change(screen.getByLabelText('Referans kişi'), { target: { value: 'm1' } });
  fireEvent.change(screen.getByLabelText('Müşteri ara'), { target: { value: 'Müşteri' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ara' }));
  await screen.findByRole('link', { name: 'Ahmet Müşteri' });
  fireEvent.click(screen.getByRole('button', { name: 'Sonraki sayfa' }));
  const action = () => screen.getByRole('link', { name: 'Ayşe Müşteri profilini aç' });
  await screen.findByRole('link', { name: 'Ayşe Müşteri profilini aç' });
  vi.stubGlobal('scrollY', 160);
  fireEvent.click(action());
  await screen.findByRole('heading', { name: 'Ayşe Müşteri' });
  vi.stubGlobal('scrollY', 0);
  fireEvent.click(screen.getByRole('link', { name: 'Müşteri listesine dön' }));
  await screen.findByRole('link', { name: 'Ayşe Müşteri profilini aç' });
  await waitFor(() => expect(document.activeElement).toBe(action()));
  expect(scroll).toHaveBeenCalledWith(0, 160);
  expect(screen.getByLabelText('Müşteri ara').getAttribute('value')).toBe('Müşteri');
  expect(
    screen.getByLabelText('Referans kişi').querySelector('option:checked')?.getAttribute('value'),
  ).toBe('m1');
  const nameLink = () => screen.getByRole('link', { name: 'Ayşe Müşteri' });
  fireEvent.click(nameLink());
  await screen.findByRole('heading', { name: 'Ayşe Müşteri' });
  fireEvent.click(screen.getByRole('button', { name: 'Tarayıcı geri' }));
  await screen.findByRole('link', { name: 'Ayşe Müşteri' });
  await waitFor(() => expect(document.activeElement).toBe(nameLink()));
  expect(requests.slice(-3)).toEqual(
    Array(3).fill(
      '/api/customers?limit=20&include=coverage&search=M%C3%BC%C5%9Fteri&referenceMembershipId=m1&cursor=next',
    ),
  );
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
it.each([401, 403])(
  'clears a populated customer list after a refresh returns %s',
  async (status) => {
    const fetcher = vi.fn(async () =>
      reply({ items: [customer('a')], nextCursor: null, hasMore: false }),
    );
    vi.stubGlobal('fetch', fetcher);
    render(
      <MemoryRouter>
        <CustomerListPage />
      </MemoryRouter>,
    );
    await screen.findByRole('link', { name: 'Ahmet Müşteri' });
    fetcher.mockImplementation(async () => reply(null, status));
    fireEvent.click(screen.getByRole('button', { name: 'Ara' }));
    await screen.findByRole('heading', {
      name: status === 403 ? 'Erişim izni gerekli' : 'Müşteriler yüklenemedi',
    });
    expect(screen.queryByText('Ahmet Müşteri')).toBeNull();
    expect(screen.queryByText('ornek@demo.invalid')).toBeNull();
    expect(fetcher).toHaveBeenCalledTimes(2);
  },
);
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
  expect(screen.getByRole('link', { name: 'Diğer müşteri işlemleri' }).getAttribute('href')).toBe(
    '/customers/b/advanced',
  );
});
it('rejects a successful response for another customer and reloads only the requested profile', async () => {
  let broken = true;
  const fetcher = vi.fn<(url: string, request?: RequestInit) => Promise<Response>>(async (url) =>
    reply(url.endsWith('/a') ? customer(broken ? 'b' : 'a') : []),
  );
  vi.stubGlobal('fetch', fetcher);
  profile();
  await screen.findByText('Sunucudan beklenen bilgiler alınamadı. Yeniden deneyin.');
  expect(screen.queryByText('Ayşe Müşteri')).toBeNull();
  broken = false;
  fireEvent.click(screen.getByRole('button', { name: 'Yeniden dene' }));
  await screen.findByRole('heading', { name: 'Ahmet Müşteri' });
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/a'))).toHaveLength(2);
  expect(fetcher.mock.calls.every(([, request]) => !request?.method)).toBe(true);
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
    expect(screen.queryByRole('link', { name: 'Diğer müşteri işlemleri' })).toBeNull();
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
