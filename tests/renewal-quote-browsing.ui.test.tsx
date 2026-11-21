import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { RenewalQuotesSection } from '../src/app/pages/today-work/RenewalQuotesSection';
import { invalidateCsrfToken } from '../src/app/csrf';
const defaults = {
  insurerId: 'i',
  productId: 'p',
  branchId: 'b',
  paymentMethodId: 'm',
  startDate: '2027-01-11',
  endDate: '2027-04-20',
  validUntil: '2099-01-01T00:00:00.000Z',
  grossPremiumMinor: 1250050,
  currency: 'TRY',
  installmentCount: null,
  termsSummary: null,
};
const version = (n: number) => ({
  id: 'v' + n,
  version_number: n,
  insurer_id: 'i',
  insurer_name: 'Anadolu Sigorta',
  product_id: 'p',
  product_name: 'Kasko',
  branch_id: 'b',
  payment_method_id: 'm',
  start_date: defaults.startDate,
  end_date: defaults.endDate,
  valid_until: defaults.validUntil,
  gross_premium_minor: 1250050 + n,
  currency: 'TRY',
  installment_count: null,
  terms_summary: null,
  created_at: '2026-11-18T09:00:00.000Z',
});
const quote = {
  id: 'q',
  status: 'DRAFT',
  version: 23,
  current_version_id: 'v23',
  accepted_version_id: null,
  versionCount: 23,
  versions: [version(1), version(23)],
  events: [],
};
const page = (quotes: unknown[]) => ({
  quotes,
  defaultVersion: defaults,
  historyMode: 'SUMMARY',
  hasMore: false,
  nextCursor: null,
  selectedQuoteId: null,
});
const ok = (data: unknown, status = 200) => Response.json({ success: true, data }, { status });
beforeEach(() => {
  invalidateCsrfToken();
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = false;
      this.dispatchEvent(new Event('close'));
    },
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function fixture(
  options: { wrongHistory?: boolean; malformed?: boolean; catalogDenied?: boolean } = {},
) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = new URL(String(input), 'http://localhost'),
      root = '/api/renewals/r/quotes';
    if (u.pathname.includes('csrf-token')) return ok({ token: 'csrf' });
    if (u.pathname === '/api/catalogs/selectable' && options.catalogDenied)
      return Response.json({ success: false }, { status: 403 });
    if (u.pathname === '/api/catalogs/selectable')
      return ok({
        insurers: [{ id: 'i', name: 'Anadolu Sigorta', status: 'ACTIVE' }],
        products: [{ id: 'p', name: 'Kasko', insurerId: 'i', branchId: 'b', status: 'ACTIVE' }],
        branches: [{ id: 'b', name: 'Kasko', status: 'ACTIVE' }],
        paymentMethods: [
          {
            id: 'm',
            name: 'Nakit',
            status: 'ACTIVE',
            supportsInstallments: false,
            maxInstallments: 1,
          },
        ],
      });
    if (init?.method === 'POST')
      return ok(
        {
          operationId: '00000000-0000-4000-8000-000000000223',
          quoteId: 'q',
          quoteVersionId: 'v24',
          versionNumber: 24,
          status: 'DRAFT',
        },
        201,
      );
    if (u.pathname === root + '/q/history') {
      const kind = u.searchParams.get('kind'),
        next = u.searchParams.has('cursor');
      return ok({
        quoteId: options.wrongHistory ? 'other' : 'q',
        kind,
        items: kind === 'versions' ? [version(next ? 1 : 23)] : [],
        hasMore: kind === 'versions' && !next,
        nextCursor: kind === 'versions' && !next ? 'history-next' : null,
      });
    }
    if (u.pathname === root && u.searchParams.has('quoteId'))
      return ok({
        ...page([
          {
            ...quote,
            version: 24,
            versionCount: 24,
            current_version_id: 'v24',
            versions: [version(1), { ...version(24), gross_premium_minor: 1250073 }],
          },
        ]),
        selectedQuoteId: 'q',
      });
    if (u.pathname === root) {
      if (u.searchParams.has('cursor')) return ok(page([{ ...quote, id: 'q-next' }]));
      return ok({
        ...page([{ ...quote, current_version_id: options.malformed ? 'missing' : 'v23' }]),
        hasMore: true,
        nextCursor: 'list-next',
      });
    }
    throw Error(String(input));
  });
  vi.stubGlobal('fetch', fetcher);
  render(
    <RenewalQuotesSection
      active
      renewalId="r"
      renewalVersion={1}
      renewalOpen
      canOperate={() => true}
      compareRenewal={async () => 1}
      onRisk={vi.fn()}
    />,
  );
  return fetcher;
}
it('defers both bounded historical reads until the native details dialog opens and pages prices separately', async () => {
  const f = fixture();
  await screen.findByRole('row', { name: 'Teklif 1 güncel özet' });
  expect(f.mock.calls.some(([u]) => String(u).includes('/history'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Anadolu Sigorta · Fiyat geçmişi' }));
  await screen.findByRole('dialog', { name: 'Anadolu Sigorta · Fiyat geçmişi' });
  await screen.findByText(/23 fiyat kaydı/);
  expect(f.mock.calls.filter(([u]) => String(u).includes('/history'))).toHaveLength(2);
  fireEvent.click(screen.getByRole('button', { name: 'Önceki fiyatlar' }));
  await waitFor(() =>
    expect(
      f.mock.calls.some(
        ([u]) => String(u).includes('kind=versions') && String(u).includes('cursor=history-next'),
      ),
    ).toBe(true),
  );
  expect(f.mock.calls.filter(([u]) => String(u).includes('kind=events'))).toHaveLength(1);
  expect(f.mock.calls.some(([u]) => String(u).includes('/tasks/'))).toBe(false);
});
it('refuses another quote history without inventing an empty or complete history', async () => {
  fixture({ wrongHistory: true });
  fireEvent.click(await screen.findByRole('button', { name: 'Anadolu Sigorta · Fiyat geçmişi' }));
  await screen.findByRole('button', { name: 'Geçmişi yeniden yükle' });
  expect(screen.queryByText(/23 fiyat kaydı/)).toBeNull();
});
it('pages current summaries explicitly and disables page changes while a price draft is open', async () => {
  const f = fixture();
  fireEvent.click(await screen.findByRole('button', { name: 'Diğer teklifler' }));
  await waitFor(() =>
    expect(f.mock.calls.some(([u]) => String(u).includes('cursor=list-next'))).toBe(true),
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Teklif 1 için revizyon' }));
  await screen.findByRole('form', { name: 'Teklif revizyon formu' });
  expect(screen.getByRole('button', { name: 'İlk teklif sayfası' }).hasAttribute('disabled')).toBe(
    true,
  );
});
it('verifies a saved revision using its exact quote/version/operation instead of scanning the current page', async () => {
  const f = fixture();
  fireEvent.click(await screen.findByRole('button', { name: 'Teklif 1 için revizyon' }));
  const form = await screen.findByRole('form');
  fireEvent.click(
    screen.getByLabelText('Mevcut sürümü değiştirmeden yeni sürüm oluşturmayı onaylıyorum'),
  );
  fireEvent.submit(form);
  await waitFor(() =>
    expect(
      f.mock.calls.some(([u]) =>
        String(u).includes('operationId=00000000-0000-4000-8000-000000000223'),
      ),
    ).toBe(true),
  );
  const exact = f.mock.calls.find(([u]) => String(u).includes('operationId='))!;
  const q = new URL(String(exact[0]), 'http://localhost').searchParams;
  expect(q.get('quoteId')).toBe('q');
  expect(q.get('versionId')).toBe('v24');
});
it('rejects a bounded summary whose current revision is missing', async () => {
  const f = fixture({ malformed: true });
  await screen.findByRole('alert');
  expect(screen.queryByRole('button', { name: 'Teklif 1 için revizyon' })).toBeNull();
  expect(f.mock.calls.some(([, i]) => i?.method === 'POST')).toBe(false);
});

it('keeps authorized company names and price history readable when write catalogs are unavailable', async () => {
  fixture({ catalogDenied: true });
  const row = await screen.findByRole('row', { name: 'Teklif 1 güncel özet' });
  expect(row.textContent).toContain('Anadolu Sigorta');
  expect(
    screen.getByRole('button', { name: 'Teklif 1 için revizyon' }).hasAttribute('disabled'),
  ).toBe(true);
  expect(
    screen
      .getByRole('button', { name: 'Anadolu Sigorta · Fiyat geçmişi' })
      .hasAttribute('disabled'),
  ).toBe(false);
});
