// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CustomerRenewalsSection } from '../src/app/components/CustomerRenewalsSection';
function response(data: unknown, status = 200) {
  return new Response(JSON.stringify({ success: status < 400, data }), { status });
}
const row = {
  id: 'shared-renewal',
  policyNumber: 'POL-123',
  policyEndDate: '2026-11-01',
  state: 'CONTACT_PENDING',
  version: 2,
};
const props = {
  customerId: 'customer',
  customerDisplayName: 'Ortak Müşteri',
  getCsrfToken: async () => 'csrf',
  invalidateCsrfToken: () => undefined,
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe('Customer shared renewal workspace', () => {
  it('reads attributed renewal notes from the customer profile without fetching private tasks or personnel', async () => {
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/customers/customer/renewals')
        return response({ items: [row], nextCursor: null });
      if (url.endsWith('/interactions'))
        return response({
          interactions: [
            {
              id: 'note',
              outcome: 'NOTE',
              channel: 'OTHER',
              author_name: 'Ayşe Yılmaz',
              occurred_at: '2026-10-14T21:30:00.000Z',
              note: 'Ortak teklif görüşmesi.',
            },
          ],
          lastContactAt: null,
          lastAttemptAt: null,
          customerType: 'INDIVIDUAL',
          companyContacts: [],
        });
      if (url.endsWith('/quotes')) return response(null, 403);
      throw new Error('Unexpected fetch');
    });
    vi.stubGlobal('fetch', fetcher);
    render(<CustomerRenewalsSection {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Yenileme kayıtlarını aç' }));
    fireEvent.click(
      await screen.findByRole('button', {
        name: 'POL-123 — yenileme görüşmelerini ve teklifleri aç',
      }),
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'İletişim, teklif ve sonuçları aç: Ortak Müşteri' }),
    );
    await screen.findByText('Kaydeden: Ayşe Yılmaz');
    expect(screen.getByText('15 Eki 2026 00:30')).toBeTruthy();
    expect(screen.getByText('Ortak teklif görüşmesi.')).toBeTruthy();
    expect(screen.getByText(/genel müşteri notu değildir/)).toBeTruthy();
    expect(
      screen.queryByRole('button', { name: /Takibi tamamla|Atama seçenekleri|Kazandık|Kaybettik/ }),
    ).toBeNull();
    expect(
      fetcher.mock.calls.every(
        ([url]) => !String(url).includes('/tasks') && !String(url).includes('/personnel'),
      ),
    ).toBe(true);
  });
  it('retries the exact failed customer page, keeping previous rows', async () => {
    let pages = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('cursor=shared-renewal')
        ? ++pages === 1
          ? response(null, 503)
          : response({
              items: [{ ...row, id: 'second', policyNumber: 'POL-456' }],
              nextCursor: null,
            })
        : response({ items: [row], nextCursor: 'shared-renewal' }),
    );
    vi.stubGlobal('fetch', fetcher);
    render(<CustomerRenewalsSection {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Yenileme kayıtlarını aç' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Daha fazla yenileme' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Aynı sayfayı yeniden dene' }));
    await screen.findByRole('button', {
      name: 'POL-456 — yenileme görüşmelerini ve teklifleri aç',
    });
    expect(
      screen.getByRole('button', { name: 'POL-123 — yenileme görüşmelerini ve teklifleri aç' }),
    ).toBeTruthy();
    expect(fetcher.mock.calls.map(([url]) => String(url)).slice(1)).toEqual([
      '/api/customers/customer/renewals?cursor=shared-renewal',
      '/api/customers/customer/renewals?cursor=shared-renewal',
    ]);
  });
  it('fails closed on denied shared-record access', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response(null, 403)),
    );
    render(<CustomerRenewalsSection {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Yenileme kayıtlarını aç' }));
    await waitFor(() =>
      expect(screen.getByRole('alert').textContent).toContain('Yenileme kayıtları okunamadı.'),
    );
    expect(screen.queryByRole('button', { name: /POL-123/ })).toBeNull();
  });
});
