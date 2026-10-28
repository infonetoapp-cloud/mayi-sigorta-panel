import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import IdentitySearchPage from '../src/app/pages/customers/IdentitySearchPage';
vi.mock('../src/app/csrf', () => ({
  getCsrfToken: async () => 'synthetic-csrf',
  invalidateCsrfToken: vi.fn(),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('finds the exact authorized customer by body-only CSRF protected search without storage or internal type labels', async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          success: true,
          data: [
            {
              id: 'exact',
              displayName: 'Sentetik Müşteri',
              type: 'INDIVIDUAL',
              identityMasked: '*******1234',
            },
          ],
        }),
      ),
  );
  vi.stubGlobal('fetch', fetcher);
  render(
    <MemoryRouter>
      <IdentitySearchPage />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText('Kimlik numarası'), { target: { value: '10000000146' } });
  fireEvent.click(screen.getByRole('button', { name: 'Müşteri Bul' }));
  await screen.findByRole('link', { name: /Sentetik Müşteri/ });
  const call = (fetcher.mock.calls as unknown as [string, RequestInit][])[0]!;
  expect(call[0]).toBe('/api/customers/search-sensitive');
  expect(call[1].method).toBe('POST');
  expect(JSON.parse(call[1].body as string)).toEqual({
    identityType: 'TCKN',
    identityValue: '10000000146',
  });
  expect(call[1].headers).toMatchObject({ 'X-CSRF-Token': 'synthetic-csrf' });
  expect(screen.queryByText(/INDIVIDUAL|UUID|klasik/)).toBeNull();
  expect(localStorage.length + sessionStorage.length).toBe(0);
});
it('clearing a pending lookup prevents its late result from reappearing', async () => {
  let resolve!: (response: Response) => void;
  const fetcher = vi.fn(
    () =>
      new Promise<Response>((r) => {
        resolve = r;
      }),
  );
  vi.stubGlobal('fetch', fetcher);
  render(
    <MemoryRouter>
      <IdentitySearchPage />
    </MemoryRouter>,
  );
  fireEvent.change(screen.getByLabelText('Kimlik numarası'), { target: { value: '10000000146' } });
  fireEvent.click(screen.getByRole('button', { name: 'Müşteri Bul' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledOnce());
  fireEvent.click(screen.getByRole('button', { name: 'Temizle' }));
  resolve(
    new Response(
      JSON.stringify({ success: true, data: [{ id: 'late', displayName: 'Geç Gelen Müşteri' }] }),
    ),
  );
  await waitFor(() => expect(screen.queryByText('Geç Gelen Müşteri')).toBeNull());
});
