import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CustomerArchiveSection } from '../src/app/components/CustomerArchiveSection';
import type { CustomerDetailDto } from '../src/shared/types';
vi.mock('../src/app/App', () => ({
  getCsrfToken: async () => 'synthetic-csrf',
  invalidateCsrfToken: vi.fn(),
  parseAppError: () => ({ message: 'Sonuç belirsiz.', isRetryable: true, category: 'NETWORK' }),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('selects a Turkish archive reason and freezes an uncertain write for exact retry', async () => {
  const fetcher = vi.fn(async (_url: string, _init?: RequestInit) => {
    throw new Error('synthetic lost response');
  });
  vi.stubGlobal('fetch', fetcher);
  render(
    <CustomerArchiveSection
      customer={{ id: 'customer-exact', version: 7, archivedAt: null } as CustomerDetailDto}
      onCustomerReload={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Müşteriyi Arşivle' }));
  const reason = screen.getByRole('combobox', { name: 'Arşiv Nedeni' });
  fireEvent.change(reason, { target: { value: 'HISTORICAL_RECORD' } });
  fireEvent.click(screen.getByRole('button', { name: 'Arşivlemeyi Onayla' }));
  await screen.findByRole('alert');
  expect((reason as unknown as HTMLSelectElement).disabled).toBe(true);
  expect((screen.getByRole('button', { name: 'Vazgeç' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Tekrar Dene' }));
  await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
  expect(fetcher.mock.calls[1]).toEqual(fetcher.mock.calls[0]);
  expect(fetcher.mock.calls[0]?.[0]).toBe('/api/customers/customer-exact/archive');
  expect(JSON.parse(fetcher.mock.calls[0]?.[1]?.body as string)).toEqual({
    expectedVersion: 7,
    reasonCode: 'HISTORICAL_RECORD',
  });
});
