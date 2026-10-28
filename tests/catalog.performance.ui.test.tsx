import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { CatalogsPanel } from '../src/app/components/CatalogsPanel';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('loads only the active catalog and capability until product relations are actually needed', async () => {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url);
      return new Response(
        JSON.stringify({
          success: true,
          data: url.includes('capabilities') ? { canManage: true } : [],
        }),
      );
    }),
  );
  render(<CatalogsPanel />);
  await screen.findByText('Bu katalogda kayıt yok');
  expect(urls.filter((u) => u.startsWith('/api/catalogs/insurers'))).toHaveLength(1);
  expect(urls.filter((u) => u.startsWith('/api/catalogs/branches'))).toHaveLength(0);
  fireEvent.click(screen.getByRole('button', { name: 'Ürünler' }));
  await waitFor(() => expect(urls.some((u) => u.includes('/branches?'))).toBe(true));
});
