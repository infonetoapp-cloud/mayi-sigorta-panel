import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Routes, Route, Link } from 'react-router';
import CustomerProfilePage from '../src/app/pages/customers/CustomerProfilePage';
const customer = {
  id: 'a',
  type: 'COMPANY',
  displayName: 'Örnek Ada AŞ',
  email: 'ada@example.test',
  phone: null,
  address: null,
  archivedAt: null,
  version: 1,
  createdAt: '2026-01-01T00:00:00Z',
  contacts: [],
  assigneeMembershipId: 'member-a',
};
const reply = (data: unknown, status = 200) =>
  new Response(
    JSON.stringify({
      success: status < 400,
      data,
      ...(status >= 400 ? { error: { code: 'SERVICE_UNAVAILABLE', message: 'unsafe' } } : {}),
    }),
    { status },
  );
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function profile(section = 'overview') {
  return render(
    <MemoryRouter initialEntries={['/customers/a?section=' + section]}>
      <Link to="/customers/b">Diğer kayıt</Link>
      <Routes>
        <Route path="/customers/:customerId" element={<CustomerProfilePage />} />
      </Routes>
    </MemoryRouter>,
  );
}
function fixture(uncertain = false) {
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('csrf-token')) return reply({ token: 'test-csrf' });
    if (init?.method === 'PATCH')
      return uncertain ? Promise.reject(new Error('network')) : reply(customer);
    if (url.includes('/renewals'))
      return reply({
        items: [
          {
            id: 'r1',
            state: 'OPEN',
            version: 1,
            policyNumber: 'POL-ONE',
            policyEndDate: '2026-12-01',
          },
          {
            id: 'r2',
            state: 'OPEN',
            version: 1,
            policyNumber: 'POL-TWO',
            policyEndDate: '2026-12-02',
          },
        ],
        nextCursor: null,
      });
    if (url.includes('/policies')) return reply({ items: [], nextCursor: null, hasMore: false });
    if (url.includes('/coverage')) return reply({ available: false, types: [], policies: [] });
    return reply({ ...customer, id: url.endsWith('/b') ? 'b' : 'a' });
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
it('preserves contact and representative drafts across customer tabs and asks before leaving the customer', async () => {
  fixture();
  profile('contact');
  await screen.findByRole('heading', { name: 'Örnek Ada AŞ' });
  fireEvent.click(screen.getByRole('button', { name: 'Düzenle' }));
  fireEvent.change(screen.getByLabelText('E-posta'), { target: { value: 'taslak@example.test' } });
  fireEvent.click(screen.getByRole('link', { name: 'Genel bakış' }));
  fireEvent.click(screen.getByRole('link', { name: 'İletişim' }));
  expect((screen.getByLabelText('E-posta') as HTMLInputElement).value).toBe('taslak@example.test');
  fireEvent.click(screen.getByRole('link', { name: 'Diğer kayıt' }));
  await screen.findByRole('dialog');
  fireEvent.click(screen.getByRole('button', { name: 'Bu ekranda kal' }));
  expect((screen.getByLabelText('E-posta') as HTMLInputElement).value).toBe('taslak@example.test');
  fireEvent.click(screen.getByRole('button', { name: 'Vazgeç' }));
  fireEvent.click(screen.getByRole('button', { name: 'Yetkili ekle' }));
  fireEvent.change(screen.getByLabelText('Yetkili adı'), { target: { value: 'Deniz' } });
  fireEvent.click(screen.getByRole('link', { name: 'Genel bakış' }));
  fireEvent.click(screen.getByRole('link', { name: 'İletişim' }));
  expect((screen.getByLabelText('Yetkili adı') as HTMLInputElement).value).toBe('Deniz');
  fireEvent.click(screen.getByRole('link', { name: 'Diğer kayıt' }));
  await screen.findByRole('dialog');
});
it('freezes an uncertain modern contact request and does not offer a new write or silent discard', async () => {
  const fetcher = fixture(true);
  profile('contact');
  await screen.findByRole('heading', { name: 'Örnek Ada AŞ' });
  fireEvent.click(screen.getByRole('button', { name: 'Düzenle' }));
  fireEvent.change(screen.getByLabelText('E-posta'), {
    target: { value: 'bekleyen@example.test' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'İletişim bilgilerini kaydet' }));
  await screen.findByRole('button', { name: 'Aynı isteği tekrar dene' });
  expect(screen.getByLabelText('E-posta').matches(':disabled')).toBe(true);
  expect((screen.getByRole('button', { name: 'Vazgeç' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('link', { name: 'Diğer kayıt' }));
  await screen.findByText(/İşlemin sonucu henüz kesinleşmedi/);
  expect(screen.queryByRole('dialog')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Aynı isteği tekrar dene' }));
  await waitFor(() =>
    expect(fetcher.mock.calls.filter(([, i]) => i?.method === 'PATCH')).toHaveLength(2),
  );
  const writes = fetcher.mock.calls.filter(([, i]) => i?.method === 'PATCH');
  expect(writes[1]![1]).toEqual(writes[0]![1]);
});
it('requires explicit renewal selection and never fetches private task lists from a shared profile', async () => {
  const fetcher = fixture();
  profile('renewals');
  await screen.findByText('POL-ONE');
  await screen.findByText('POL-TWO');
  expect(
    fetcher.mock.calls.some(([url]) => url.includes('/interactions') || url.includes('/api/tasks')),
  ).toBe(false);
  expect(screen.getByText(/Bir yenileme seçin/)).toBeTruthy();
});
