import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PolicyPanel } from '../src/app/components/PolicyPanel';
const policy = {
  id: 'p1',
  customerId: 'c1',
  policyNumber: 'CP-1',
  startDate: '2026-01-01',
  endDate: '2026-12-31',
  grossPremiumMinor: 1200000,
  currency: 'TRY',
  status: 'ACTIVE',
  archivedAt: null,
  version: 1,
  customer: { id: 'c1', displayName: 'Sentetik Kişi' },
  insurer: { id: 'i', name: 'Sentetik Sigorta', status: 'ACTIVE' },
  product: { id: 'pr', name: 'Kasko', status: 'ACTIVE' },
  branch: { id: 'b', name: 'Motor', status: 'ACTIVE', dataClassification: 'GENERAL' },
  paymentMethod: { id: 'pm', name: 'Peşin', status: 'ACTIVE' },
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
async function setup() {
  const f = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const data = url.endsWith('/csrf-token')
      ? { token: 'synthetic-csrf' }
      : url === '/api/policies/p1'
        ? policy
        : url.startsWith('/api/policies?')
          ? { items: [policy], nextCursor: null, hasMore: false }
          : url.includes('/catalogs/selectable')
            ? { insurers: [], branches: [], products: [], paymentMethods: [], lossReasons: [] }
            : init?.method === 'POST'
              ? { id: 'amendment', ...JSON.parse(String(init.body)) }
              : [];
    return new Response(JSON.stringify({ success: true, data }));
  });
  vi.stubGlobal('fetch', f);
  render(<PolicyPanel />);
  fireEvent.click(await screen.findByRole('button', { name: 'Detayı Aç' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Zeyil Ekle' }));
  fireEvent.change(screen.getByLabelText('Zeyil Referansı'), { target: { value: 'CHECKPOINT-Z' } });
  fireEvent.change(screen.getByLabelText('Yürürlük Tarihi'), { target: { value: '2026-10-24' } });
  fireEvent.change(screen.getByLabelText('Zeyil Açıklaması'), {
    target: { value: 'Sentetik zeyil' },
  });
  return f;
}
it.each([
  ['100,50', '100.50'],
  ['-0,50', '-0.50'],
  ['12.500,50', '12500.50'],
])(
  'canonicalizes legacy amendment input %s without changing the server minor contract',
  async (input, expected) => {
    const f = await setup();
    fireEvent.change(screen.getByLabelText('Prim Farkı'), { target: { value: input } });
    fireEvent.click(screen.getByRole('button', { name: 'Zeyli Kaydet' }));
    await waitFor(() => expect(f.mock.calls.some(([, i]) => i?.method === 'POST')).toBe(true));
    const write = f.mock.calls.find(([, i]) => i?.method === 'POST')!;
    expect(JSON.parse(String(write[1]!.body))).toMatchObject({
      expectedVersion: 1,
      premiumDifference: expected,
      currency: 'TRY',
    });
    expect(JSON.parse(String(write[1]!.body))).not.toHaveProperty('premiumDifferenceMinor');
  },
);
it('retains an ambiguous legacy amendment amount and never submits it', async () => {
  const f = await setup();
  fireEvent.change(screen.getByLabelText('Prim Farkı'), { target: { value: '12.500' } });
  fireEvent.click(screen.getByRole('button', { name: 'Zeyli Kaydet' }));
  await screen.findByText(/Prim farkı biçimini/);
  expect(f.mock.calls.some(([, i]) => i?.method === 'POST')).toBe(false);
  expect((screen.getByLabelText('Prim Farkı') as HTMLInputElement).value).toBe('12.500');
});
