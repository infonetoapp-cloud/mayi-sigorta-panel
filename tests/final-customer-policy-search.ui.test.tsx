import { afterEach, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { CustomerPolicies } from '../src/app/pages/customers/CustomerRelationships';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function Where() {
  return <output aria-label="Konum">{useLocation().search}</output>;
}
it('searches all customer policies on server, resets cursor and preserves route context', async () => {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url);
      return new Response(
        JSON.stringify({ success: true, data: { items: [], hasMore: false, nextCursor: null } }),
      );
    }),
  );
  render(
    <MemoryRouter initialEntries={['/customers/c1?section=policies&after=stale']}>
      <CustomerPolicies customerId="c1" />
      <Where />
    </MemoryRouter>,
  );
  const input = await screen.findByRole('searchbox', {
    name: 'Bu müşterinin tüm poliçelerinde ara',
  });
  fireEvent.change(input, { target: { value: 'GROW-29' } });
  fireEvent.click(screen.getByRole('button', { name: 'Poliçelerde ara' }));
  await waitFor(() =>
    expect(
      urls.some(
        (url) =>
          new URL(url, 'https://example.test').searchParams.get('customerSearch') === 'GROW-29',
      ),
    ).toBe(true),
  );
  const q = new URL(urls.at(-1)!, 'https://example.test').searchParams;
  expect(q.get('customerId')).toBe('c1');
  expect(q.get('cursor')).toBeNull();
  expect(q.get('pageSize')).toBe('20');
  expect(screen.getByLabelText('Konum').textContent).toContain('policySearch=GROW-29');
  fireEvent.click(screen.getByRole('button', { name: 'Aramayı temizle' }));
  await waitFor(() =>
    expect(new URL(urls.at(-1)!, 'https://example.test').searchParams.has('customerSearch')).toBe(
      false,
    ),
  );
  expect(screen.queryByText(/yalnız yüklenen 20/)).toBeNull();
});
it('restores applied search from route and preserves it on next page', async () => {
  const urls: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      urls.push(url);
      return new Response(
        JSON.stringify({
          success: true,
          data: { items: [], hasMore: true, nextCursor: 'next-page' },
        }),
      );
    }),
  );
  render(
    <MemoryRouter initialEntries={['/customers/c1?section=policies&policySearch=Kasko']}>
      <CustomerPolicies customerId="c1" />
    </MemoryRouter>,
  );
  const input = await screen.findByRole('searchbox', {
    name: 'Bu müşterinin tüm poliçelerinde ara',
  });
  expect((input as HTMLInputElement).value).toBe('Kasko');
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Sonraki poliçeler' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Sonraki poliçeler' }));
  await waitFor(() =>
    expect(new URL(urls.at(-1)!, 'https://example.test').searchParams.get('cursor')).toBe(
      'next-page',
    ),
  );
  expect(new URL(urls.at(-1)!, 'https://example.test').searchParams.get('customerSearch')).toBe(
    'Kasko',
  );
});
