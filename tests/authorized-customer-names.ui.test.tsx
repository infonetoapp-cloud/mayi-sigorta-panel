import { afterEach, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import {
  AuthorizedCustomerNames,
  AuthorizedCustomerName,
} from '../src/app/pages/policies/AuthorizedCustomerNames';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const reply = (id: string) =>
  new Response(JSON.stringify({ success: true, data: { id, displayName: 'Yetkili ' + id } }));
it('uses one authorized GET per distinct customer on the current page, not one per policy row', async () => {
  const f = vi.fn(async (url: string) => reply(url.split('/').at(-1)!));
  vi.stubGlobal('fetch', f);
  render(
    <MemoryRouter>
      <AuthorizedCustomerNames ids={['c1', 'c1', 'c2']}>
        <AuthorizedCustomerName id="c1" state={null} />
        <AuthorizedCustomerName id="c1" state={null} />
        <AuthorizedCustomerName id="c2" state={null} />
      </AuthorizedCustomerNames>
    </MemoryRouter>,
  );
  expect(await screen.findAllByRole('link', { name: 'Yetkili c1' })).toHaveLength(2);
  await screen.findByRole('link', { name: 'Yetkili c2' });
  expect(f).toHaveBeenCalledTimes(2);
});
it('hides previous page names immediately and suppresses late authorized responses after page change', async () => {
  const pending = new Map<string, (r: Response) => void>();
  vi.stubGlobal(
    'fetch',
    vi.fn((url: string) => new Promise<Response>((resolve) => pending.set(url, resolve))),
  );
  const view = render(
    <MemoryRouter>
      <AuthorizedCustomerNames ids={['a']}>
        <AuthorizedCustomerName id="a" state={null} />
      </AuthorizedCustomerNames>
    </MemoryRouter>,
  );
  view.rerender(
    <MemoryRouter>
      <AuthorizedCustomerNames ids={['b']}>
        <AuthorizedCustomerName id="b" state={null} />
      </AuthorizedCustomerNames>
    </MemoryRouter>,
  );
  await act(async () => pending.get('/api/customers/a')!(reply('a')));
  expect(screen.queryByRole('link', { name: 'Yetkili a' })).toBeNull();
  await act(async () => pending.get('/api/customers/b')!(reply('b')));
  await screen.findByRole('link', { name: 'Yetkili b' });
  expect(screen.queryByText('Yetkili a')).toBeNull();
});
