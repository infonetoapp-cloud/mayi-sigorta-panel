import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { App } from '../src/app/App';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('preserves the advanced customer modal boundary and all existing privileged commands', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async (url: string) =>
        new Response(
          JSON.stringify({
            success: true,
            data:
              url === '/api/customers/c'
                ? {
                    id: 'c',
                    type: 'INDIVIDUAL',
                    displayName: 'Yetkili Müşteri',
                    firstName: 'Yetkili',
                    lastName: 'Müşteri',
                    version: 1,
                    createdAt: '2026-01-01T00:00:00Z',
                    contacts: [],
                    archivedAt: null,
                  }
                : { items: [], hasMore: false, companyContacts: [] },
          }),
          { status: 200 },
        ),
    ),
  );
  const view = render(<App page="customers" initialCustomerId="c" />);
  await screen.findByRole('heading', { name: 'Yetkili Müşteri' });
  expect(view.container.querySelector('.customer-detail-route')).toBeNull();
  expect(view.container.querySelector('div[style*="position: fixed"]')).not.toBeNull();
  expect(screen.getByRole('button', { name: 'Kimlik Bilgisini Güncelle' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Sorumluyu Ata' })).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Müşteriyi Arşivle' })).toBeTruthy();
});
