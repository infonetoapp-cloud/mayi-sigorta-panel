// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import CustomerListPage from '../src/app/pages/customers/CustomerListPage';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('filters by employee identity or manual name on the server, preserving the reference column', async () => {
  const fetcher = vi.fn(
    async (url: string) =>
      new Response(
        JSON.stringify({
          success: true,
          data: url.includes('reference-options')
            ? {
                items: [{ membershipId: 'employee-1', displayName: 'Abdurrahman Işık' }],
                nextCursor: null,
              }
            : {
                items: [
                  {
                    id: 'c',
                    type: 'INDIVIDUAL',
                    displayName: 'Sentetik Müşteri',
                    referenceName: 'Abdurrahman Işık',
                    archivedAt: null,
                  },
                ],
                hasMore: false,
                nextCursor: null,
              },
        }),
      ),
  );
  vi.stubGlobal('fetch', fetcher);
  render(
    <MemoryRouter>
      <CustomerListPage />
    </MemoryRouter>,
  );
  await screen.findByRole('link', { name: 'Sentetik Müşteri' });
  expect(screen.getByRole('columnheader', { name: 'Referans kişi' })).toBeTruthy();
  const select = screen.getByLabelText('Referans kişi', { exact: true });
  fireEvent.focus(select);
  await screen.findByRole('option', { name: 'Abdurrahman Işık' });
  fireEvent.change(select, { target: { value: 'employee-1' } });
  fireEvent.click(screen.getByRole('button', { name: 'Ara' }));
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(([url]) => url.includes('referenceMembershipId=employee-1')),
    ).toBe(true),
  );
  fireEvent.change(select, { target: { value: 'manual' } });
  fireEvent.change(screen.getByLabelText('Referans kişinin adı soyadı'), {
    target: { value: 'Işık' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Ara' }));
  await waitFor(() =>
    expect(
      fetcher.mock.calls.some(
        ([url]) => new URL(url, 'https://example.invalid').searchParams.get('reference') === 'Işık',
      ),
    ).toBe(true),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Temizle' }));
  await waitFor(() =>
    expect(
      new URL(fetcher.mock.calls.at(-1)![0], 'https://example.invalid').searchParams.has(
        'reference',
      ),
    ).toBe(false),
  );
});
