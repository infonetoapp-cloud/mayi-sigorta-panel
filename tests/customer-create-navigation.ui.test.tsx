import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router';
import CustomerCreatePage from '../src/app/pages/customers/CustomerCreatePage';
import { AppShell } from '../src/app/components/layout/AppShell';
import { invalidateCsrfToken } from '../src/app/csrf';
const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ success: true, data }), { status });
beforeEach(() => invalidateCsrfToken());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
function mount() {
  return render(
    <MemoryRouter initialEntries={['/customers/new']}>
      <AppShell
        session={{ state: 'NORMAL', email: 'synthetic@example.invalid', isOwner: true }}
        busy={false}
        onLogout={() => {}}
        onReauth={() => {}}
      >
        <Routes>
          <Route path="/customers/new" element={<CustomerCreatePage />} />
          <Route path="/customers" element={<h1>Müşteri listesi hedefi</h1>} />
          <Route path="/customers/:id" element={<h1>Doğrulanmış müşteri profili</h1>} />
          <Route path="/" element={<Link to="/customers/new">Yeni müşteri</Link>} />
        </Routes>
      </AppShell>
    </MemoryRouter>,
  );
}
function fill() {
  fireEvent.change(screen.getByLabelText('Ad'), { target: { value: 'Deniz' } });
  fireEvent.change(screen.getByLabelText('Soyad'), { target: { value: 'Sentetik' } });
}
it.each(['sidebar', 'cancel', 'list link'])(
  'keeps all private draft fields on Stay through %s',
  async (kind) => {
    const storage = vi.spyOn(Storage.prototype, 'setItem');
    mount();
    fill();
    fireEvent.change(screen.getByLabelText('Adres'), { target: { value: 'Sentetik adres' } });
    if (kind === 'sidebar') fireEvent.click(screen.getByRole('button', { name: 'Menüyü aç' }));
    fireEvent.click(
      screen.getByRole('link', {
        name:
          kind === 'sidebar'
            ? 'Müşteriler'
            : kind === 'cancel'
              ? 'Vazgeç ve listeye dön'
              : 'Müşteri listesine dön',
      }),
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Bu ekranda kal' }));
    expect((screen.getByLabelText('Ad') as HTMLInputElement).value).toBe('Deniz');
    expect((screen.getByLabelText('Adres') as HTMLTextAreaElement).value).toBe('Sentetik adres');
    expect(screen.queryByRole('heading', { name: 'Müşteri listesi hedefi' })).toBeNull();
    expect(storage.mock.calls.some(([, value]) => /Deniz|Sentetik adres/.test(String(value)))).toBe(
      false,
    );
  },
);
it('leaves only after explicit draft discard and warns on unload', async () => {
  mount();
  fill();
  const unload = new Event('beforeunload', { cancelable: true });
  window.dispatchEvent(unload);
  expect(unload.defaultPrevented).toBe(true);
  fireEvent.click(screen.getByRole('link', { name: 'Vazgeç ve listeye dön' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Taslağı bırak ve ayrıl' }));
  await screen.findByRole('heading', { name: 'Müşteri listesi hedefi' });
});
it('pins a pending request then retries the identical uncertain body/key once and navigates after success', async () => {
  let reject!: (e: Error) => void;
  let writes = 0;
  const fetcher = vi.fn((url: string, init?: RequestInit) => {
    if (url.endsWith('csrf-token')) return Promise.resolve(reply({ token: 'csrf' }));
    if (init?.method === 'POST' && ++writes === 1)
      return new Promise<Response>((_, fail) => {
        reject = fail;
      });
    return Promise.resolve(reply({ id: 'created-once' }, 201));
  });
  vi.stubGlobal('fetch', fetcher);
  mount();
  fill();
  const submit = screen.getByRole('button', { name: 'Müşteriyi kaydet' });
  fireEvent.click(submit);
  fireEvent.click(submit);
  await waitFor(() => expect(writes).toBe(1));
  fireEvent.click(screen.getByRole('link', { name: 'Vazgeç ve listeye dön' }));
  expect(screen.queryByRole('heading', { name: 'Müşteri listesi hedefi' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Taslağı bırak ve ayrıl' })).toBeNull();
  await act(async () => reject(new Error('Synthetic connection loss')));
  fireEvent.click(screen.getByRole('link', { name: 'Müşteriler' }));
  expect(screen.queryByRole('heading', { name: 'Müşteri listesi hedefi' })).toBeNull();
  expect(screen.getByLabelText('Ad').matches(':disabled')).toBe(true);
  fireEvent.click(await screen.findByRole('button', { name: 'Aynı kaydı güvenle yeniden dene' }));
  await screen.findByRole('heading', { name: 'Doğrulanmış müşteri profili' });
  const attempts = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(attempts).toHaveLength(2);
  expect(attempts[1]?.[1]).toEqual(attempts[0]?.[1]);
});
