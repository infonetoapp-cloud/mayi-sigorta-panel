import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { PolicyPanel } from '../src/app/components/PolicyPanel';
import { invalidateCsrfToken } from '../src/app/App';
const policy = {
  id: 'p1',
  customerId: 'c1',
  insurerId: 'i',
  productId: 'pr',
  branchId: 'b',
  paymentMethodId: 'pm',
  policyNumber: 'FINAL-MONEY',
  startDate: '2026-01-01',
  endDate: '2027-01-01',
  grossPremiumMinor: 10000,
  currency: 'TRY',
  status: 'ACTIVE',
  archivedAt: null,
  installmentCount: null,
  version: 1,
  customer: { id: 'c1', displayName: 'Sentetik' },
  insurer: { id: 'i', name: 'Sigorta', status: 'ACTIVE' },
  product: { id: 'pr', name: 'Kasko', status: 'ACTIVE' },
  branch: { id: 'b', name: 'Motor', status: 'ACTIVE', dataClassification: 'GENERAL' },
  paymentMethod: { id: 'pm', name: 'Peşin', status: 'ACTIVE' },
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  invalidateCsrfToken();
});
async function setup(
  edit = false,
  initialPolicyId?: string,
  writeResponse?: (attempt: number) => Promise<Response | undefined>,
) {
  const writes: { body: Record<string, unknown>; init: RequestInit }[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) => {
      if (init?.method === 'POST' || init?.method === 'PATCH') {
        writes.push({ body: JSON.parse(String(init.body)), init });
        const forced = await writeResponse?.(writes.length);
        if (forced) return forced;
      }
      const data = input.endsWith('/csrf-token')
        ? { token: 'synthetic-token' }
        : input === '/api/policies/p1' || init?.method === 'POST' || init?.method === 'PATCH'
          ? policy
          : input.startsWith('/api/policies?')
            ? { items: [policy], hasMore: false, nextCursor: null }
            : input.includes('catalogs/selectable')
              ? {
                  insurers: [policy.insurer],
                  products: [{ ...policy.product, insurerId: 'i', branchId: 'b' }],
                  branches: [policy.branch],
                  paymentMethods: [{ ...policy.paymentMethod, supportsInstallments: false }],
                  lossReasons: [],
                }
              : [];
      return new Response(JSON.stringify({ success: true, data }));
    }),
  );
  render(
    <PolicyPanel
      initialPolicyId={initialPolicyId}
      initialCustomer={edit || initialPolicyId ? undefined : { id: 'c1', displayName: 'Sentetik' }}
    />,
  );
  if (edit) {
    fireEvent.click(await screen.findByRole('button', { name: 'Detayı Aç' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Poliçeyi Düzenle' }));
  }
  await screen.findByLabelText('Brüt Prim');
  return writes;
}
it.each([
  ['12.500,50', '12500.50'],
  ['12500,50', '12500.50'],
  ['12500.50', '12500.50'],
  ['0,50', '0.50'],
])(
  'legacy create canonicalizes %s to %s without altering backend money',
  async (input, canonical) => {
    const writes = await setup();
    fireEvent.change(screen.getByLabelText('Brüt Prim'), { target: { value: input } });
    fireEvent.submit(screen.getByLabelText('Brüt Prim').closest('form')!);
    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]!.body.grossPremium).toBe(canonical);
    expect(writes[0]!.body).not.toHaveProperty('grossPremiumMinor');
  },
);
it.each(['12.500', '12,500', '1.23,45', '1,234', '-0,50', '90071992547409,92'])(
  'legacy create rejects invalid/ambiguous/overflow amount %s without request',
  async (input) => {
    const writes = await setup();
    fireEvent.change(screen.getByLabelText('Brüt Prim'), { target: { value: input } });
    fireEvent.submit(screen.getByLabelText('Brüt Prim').closest('form')!);
    await screen.findByText(/Brüt prim biçimini/);
    expect(writes).toHaveLength(0);
    expect((screen.getByLabelText('Brüt Prim') as HTMLInputElement).value).toBe(input);
  },
);
it('legacy edit sends canonical changed amount with CAS', async () => {
  const writes = await setup(true);
  fireEvent.change(screen.getByLabelText('Brüt Prim'), { target: { value: '12.500,50' } });
  fireEvent.submit(screen.getByLabelText('Brüt Prim').closest('form')!);
  await waitFor(() => expect(writes).toHaveLength(1));
  expect(writes[0]!.body).toEqual({ expectedVersion: 1, grossPremium: '12500.50' });
});
it('freezes the original policy attempt through a lost response, new submit and a denied replay', async () => {
  const writes = await setup(true, undefined, async (n) => {
    if (n === 1) throw new TypeError('lost response');
    if (n === 2)
      return new Response(JSON.stringify({ success: false, error: { code: 'FORBIDDEN' } }), {
        status: 403,
      });
    return undefined;
  });
  fireEvent.change(screen.getByLabelText('Brüt Prim'), { target: { value: '12.500,50' } });
  const form = screen.getByLabelText('Brüt Prim').closest('form')!;
  fireEvent.submit(form);
  fireEvent.click(await screen.findByRole('button', { name: 'Tekrar Dene' }));
  await waitFor(() => expect(writes).toHaveLength(2));
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Tekrar Dene' }).matches(':disabled')).toBe(false),
  );
  expect(screen.getByLabelText('Brüt Prim').matches(':disabled')).toBe(true);
  fireEvent.submit(form);
  expect(writes).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Tekrar Dene' }));
  await waitFor(() => expect(writes).toHaveLength(3));
  expect(writes[1]!.init).toEqual(writes[0]!.init);
  expect(writes[2]!.init).toEqual(writes[0]!.init);
});
it('blocks new form submission, target close and navigation while the first lost request is unresolved', async () => {
  const writes = await setup(true, undefined, async () => {
    throw new TypeError('lost response');
  });
  fireEvent.change(screen.getByLabelText('Brüt Prim'), { target: { value: '12.500,50' } });
  const form = screen.getByLabelText('Brüt Prim').closest('form')!;
  fireEvent.submit(form);
  await screen.findByRole('button', { name: 'Tekrar Dene' });
  fireEvent.submit(form);
  fireEvent.click(screen.getByRole('button', { name: 'Kapat' }));
  expect(writes).toHaveLength(1);
  expect(screen.getByLabelText('Brüt Prim')).toBeTruthy();
  const link = document.createElement('a');
  link.href = '/customers/c1';
  document.body.appendChild(link);
  const allowed = fireEvent.click(link);
  link.remove();
  expect(allowed).toBe(false);
  expect(writes).toHaveLength(1);
});
