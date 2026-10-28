import { afterEach, it, expect, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { RenewalWorkspacePanel } from '../src/app/components/RenewalWorkspacePanel';
import { CustomerRenewalsSection } from '../src/app/components/CustomerRenewalsSection';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const reply = (data: unknown) => new Response(JSON.stringify({ success: true, data }));
const props = {
  renewalId: 'legacy-renewal',
  customerId: 'legacy-customer',
  customerDisplayName: 'Sentetik Kabul',
  getCsrfToken: async () => 'synthetic-csrf',
  invalidateCsrfToken: () => {},
};
function network() {
  const posts: RequestInit[] = [];
  const f = vi.fn(async (path: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      posts.push(init);
      if (posts.length === 1) throw new TypeError('lost response');
      return reply({ operationId: 'op', interactionId: 'ix' });
    }
    if (path.includes('/customers/'))
      return reply({
        items: [
          {
            id: 'legacy-renewal',
            policyNumber: 'LEGACY-KABUL',
            policyEndDate: '2026-11-01',
            state: 'CONTACT_PENDING',
            version: 1,
          },
        ],
        nextCursor: null,
      });
    if (path.endsWith('/quotes'))
      return new Response(JSON.stringify({ success: false, error: { code: 'FORBIDDEN' } }), {
        status: 403,
      });
    return reply({
      interactions: [],
      lastContactAt: null,
      lastAttemptAt: null,
      customerType: 'INDIVIDUAL',
      companyContacts: [],
    });
  });
  vi.stubGlobal('fetch', f);
  return posts;
}
async function note() {
  fireEvent.click(
    screen.getByRole('button', { name: 'İletişim, teklif ve sonuçları aç: Sentetik Kabul' }),
  );
  fireEvent.change(await screen.findByLabelText('Görüşme sonucu: Sentetik Kabul'), {
    target: { value: 'NOTE' },
  });
  fireEvent.change(screen.getByLabelText('Not: Sentetik Kabul'), {
    target: { value: 'Sentetik belirsiz not' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Görüşmeyi kaydet: Sentetik Kabul' }));
  await screen.findByText('lost response');
}
it('legacy uncertain interaction freezes occurredAt, body and idempotency key for exact retry', async () => {
  const posts = network();
  render(<RenewalWorkspacePanel {...props} />);
  await note();
  const retry =
    screen.queryByRole('button', { name: 'Aynı görüşme isteğini yeniden dene: Sentetik Kabul' }) ??
    screen.getByRole('button', { name: 'Görüşmeyi kaydet: Sentetik Kabul' });
  fireEvent.click(retry);
  await waitFor(() => expect(posts).toHaveLength(2));
  expect(posts[1]!.body).toBe(posts[0]!.body);
  expect((posts[1]!.headers as Record<string, string>)['Idempotency-Key']).toBe(
    (posts[0]!.headers as Record<string, string>)['Idempotency-Key'],
  );
  await screen.findByText('Not kaydedildi.');
});
it('legacy customer selection cannot unmount an unresolved interaction and erase recovery identity', async () => {
  const posts = network();
  render(<CustomerRenewalsSection {...props} />);
  fireEvent.click(screen.getByRole('button', { name: 'Yenileme kayıtlarını aç' }));
  fireEvent.click(
    await screen.findByRole('button', {
      name: 'LEGACY-KABUL — yenileme görüşmelerini ve teklifleri aç',
    }),
  );
  await note();
  fireEvent.click(
    screen.getByRole('button', {
      name: 'LEGACY-KABUL — yenileme görüşmelerini ve teklifleri kapat',
    }),
  );
  expect((screen.getByLabelText('Not: Sentetik Kabul') as HTMLTextAreaElement).value).toBe(
    'Sentetik belirsiz not',
  );
  expect(posts).toHaveLength(1);
});
it('keeps the original uncertain attempt after a denied replay instead of treating denial as proof of no initial commit', async () => {
  const base = vi.fn(async (path: string) =>
    path.endsWith('/quotes')
      ? new Response(null, { status: 403 })
      : reply({
          interactions: [],
          lastContactAt: null,
          lastAttemptAt: null,
          customerType: 'INDIVIDUAL',
          companyContacts: [],
        }),
  );
  const posts: RequestInit[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        posts.push(init);
        if (posts.length === 1) throw new TypeError('lost response');
        if (posts.length === 2)
          return new Response(JSON.stringify({ success: false, error: { code: 'FORBIDDEN' } }), {
            status: 403,
          });
        return reply({ operationId: 'op', interactionId: 'ix' });
      }
      return base(path);
    }),
  );
  render(<RenewalWorkspacePanel {...props} />);
  await note();
  fireEvent.click(
    screen.getByRole('button', { name: 'Aynı görüşme isteğini yeniden dene: Sentetik Kabul' }),
  );
  await screen.findByText('Bu yenileme kaydına erişilemiyor.');
  expect((screen.getByLabelText('Not: Sentetik Kabul') as HTMLTextAreaElement).disabled).toBe(true);
  fireEvent.click(
    screen.getByRole('button', { name: 'Aynı görüşme isteğini yeniden dene: Sentetik Kabul' }),
  );
  await screen.findByText('Not kaydedildi.');
  expect(posts).toHaveLength(3);
  expect(posts.map((p) => p.body)).toEqual([posts[0]!.body, posts[0]!.body, posts[0]!.body]);
  expect((posts[2]!.headers as Record<string, string>)['Idempotency-Key']).toBe(
    (posts[0]!.headers as Record<string, string>)['Idempotency-Key'],
  );
});
