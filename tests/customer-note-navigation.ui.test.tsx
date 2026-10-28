// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import CustomerProfilePage from '../src/app/pages/customers/CustomerProfilePage';
const reply = (data: unknown) => new Response(JSON.stringify({ success: true, data }));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function mount() {
  const fetcher = vi.fn(async (url: string) =>
    reply(
      url.endsWith('/notes')
        ? { items: [], nextCursor: null, canCreate: true }
        : {
            id: url.split('/').at(-1),
            displayName: 'Sentetik müşteri',
            type: 'INDIVIDUAL',
            archivedAt: null,
            createdAt: '2026-01-01T00:00:00Z',
          },
    ),
  );
  vi.stubGlobal('fetch', fetcher);
  render(
    <MemoryRouter initialEntries={['/customers/a?section=notes']}>
      <Link to="/customers/b">Başka müşteri</Link>
      <Routes>
        <Route path="/customers/:customerId" element={<CustomerProfilePage />} />
      </Routes>
    </MemoryRouter>,
  );
  return fetcher;
}
it('keeps the exact note input and draft across profile sections without writes', async () => {
  const fetcher = mount();
  const input = (await screen.findByLabelText('Yeni müşteri notu')) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: '  İlk satır\nİkinci satır  ' } });
  fireEvent.click(screen.getByRole('link', { name: 'Genel bakış' }));
  fireEvent.click(screen.getByRole('link', { name: 'Müşteri notları' }));
  expect(await screen.findByLabelText('Yeni müşteri notu')).toBe(input);
  expect(input.value).toBe('  İlk satır\nİkinci satır  ');
  expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/notes'))).toHaveLength(1);
});
it('requires an explicit decision before a note can leave its customer', async () => {
  mount();
  const input = (await screen.findByLabelText('Yeni müşteri notu')) as HTMLTextAreaElement;
  fireEvent.change(input, { target: { value: 'Yalnız müşteri A' } });
  fireEvent.click(screen.getByRole('link', { name: 'Başka müşteri' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Bu ekranda kal' }));
  expect(screen.getByLabelText('Yeni müşteri notu')).toBe(input);
  expect(input.value).toBe('Yalnız müşteri A');
  fireEvent.click(screen.getByRole('button', { name: 'Not taslağını iptal et' }));
  expect(input.value).toBe('');
  fireEvent.click(screen.getByRole('link', { name: 'Başka müşteri' }));
  fireEvent.click(await screen.findByRole('link', { name: 'Müşteri notları' }));
  expect(((await screen.findByLabelText('Yeni müşteri notu')) as HTMLTextAreaElement).value).toBe(
    '',
  );
});
it('keeps a pending request mounted through sections, blocks customer changes and writes once', async () => {
  mount();
  const input = (await screen.findByLabelText('Yeni müşteri notu')) as HTMLTextAreaElement;
  let release!: (r: Response) => void;
  const pending = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const fetcher = vi.fn(async (url: string, init?: RequestInit) =>
    url.endsWith('csrf-token')
      ? reply({ token: 'synthetic-csrf' })
      : init?.method === 'POST'
        ? pending
        : reply({ items: [], canCreate: true, nextCursor: null }),
  );
  vi.stubGlobal('fetch', fetcher);
  fireEvent.change(input, { target: { value: 'Bekleyen not' } });
  fireEvent.click(screen.getByRole('button', { name: 'Notu kaydet' }));
  await waitFor(() =>
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1),
  );
  fireEvent.click(screen.getByRole('link', { name: 'Genel bakış' }));
  fireEvent.click(screen.getByRole('link', { name: 'Başka müşteri' }));
  expect((await screen.findByText(/^İşlemin sonucu henüz kesinleşmedi/)).getAttribute('role')).toBe(
    'alert',
  );
  fireEvent.click(screen.getByRole('link', { name: 'Müşteri notları' }));
  expect(screen.getByLabelText('Yeni müşteri notu')).toBe(input);
  expect(input.disabled).toBe(true);
  await act(async () => {
    release(
      reply({
        id: 'note',
        content: 'Bekleyen not',
        authorName: 'Sentetik',
        createdAt: '2026-10-20T09:00:00.000Z',
      }),
    );
  });
  await screen.findByText('Not kaydedildi.');
  expect(input.value).toBe('');
  expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
});
it('retains an uncertain frozen note and retries only the original body/key after section switching', async () => {
  mount();
  const input = (await screen.findByLabelText('Yeni müşteri notu')) as HTMLTextAreaElement;
  let posts = 0;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) =>
    url.endsWith('csrf-token')
      ? reply({ token: 'synthetic-csrf' })
      : init?.method === 'POST'
        ? ++posts === 1
          ? new Response('{}', { status: 503 })
          : reply({ id: 'n', content: 'Özgün not' })
        : reply({ items: [], canCreate: true, nextCursor: null }),
  );
  vi.stubGlobal('fetch', fetcher);
  fireEvent.change(input, { target: { value: '  Özgün not  ' } });
  fireEvent.click(screen.getByRole('button', { name: 'Notu kaydet' }));
  await screen.findByRole('button', { name: 'Aynı notu yeniden dene' });
  fireEvent.click(screen.getByRole('link', { name: 'Genel bakış' }));
  fireEvent.click(screen.getByRole('link', { name: 'Müşteri notları' }));
  expect(input.value).toBe('  Özgün not  ');
  expect(input.disabled).toBe(true);
  fireEvent.change(input, { target: { value: 'Gecikmiş değişiklik' } });
  expect(input.value).toBe('  Özgün not  ');
  expect(
    (screen.getByRole('button', { name: 'Not taslağını iptal et' }) as HTMLButtonElement).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Aynı notu yeniden dene' }));
  await screen.findByText('Not kaydedildi.');
  const writes = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(writes).toHaveLength(2);
  expect(writes[1]![1]).toEqual(writes[0]![1]);
});
it('preserves a rejected draft and recovers an accepted write using GET only', async () => {
  mount();
  const input = (await screen.findByLabelText('Yeni müşteri notu')) as HTMLTextAreaElement;
  let mode = 'reject',
    posts = 0;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('csrf-token')) return reply({ token: 'synthetic-csrf' });
    if (init?.method === 'POST') {
      posts++;
      return mode === 'reject'
        ? new Response('{}', { status: 400 })
        : reply({ id: 'n', content: 'Not' });
    }
    return mode === 'accept'
      ? new Response('{}', { status: 503 })
      : reply({ items: [], canCreate: true, nextCursor: null });
  });
  vi.stubGlobal('fetch', fetcher);
  fireEvent.change(input, { target: { value: 'Not' } });
  fireEvent.click(screen.getByRole('button', { name: 'Notu kaydet' }));
  await screen.findByText(/Not kaydedilemedi/);
  fireEvent.click(screen.getByRole('link', { name: 'Genel bakış' }));
  fireEvent.click(screen.getByRole('link', { name: 'Müşteri notları' }));
  expect(input.value).toBe('Not');
  mode = 'accept';
  fireEvent.click(screen.getByRole('button', { name: 'Notu kaydet' }));
  await screen.findByText(/Notlar okunamadı/);
  expect(input.value).toBe('');
  mode = 'read';
  fireEvent.click(screen.getByRole('button', { name: 'Aynı not sayfasını yeniden dene' }));
  await screen.findByText('Henüz müşteri notu yok.');
  expect(posts).toBe(2);
});
