import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { SalesPricesSection, priceMinor } from '../src/app/pages/sales/SalesPricesSection';
import { invalidateCsrfToken } from '../src/app/csrf';
import type { SalesPriceRevision, SalesPriceCommandResult } from '../src/shared/sales-prices';

const original: SalesPriceRevision = {
  source: 'PRICE_REVISION',
  insurerId: 'i1',
  insurerName: 'Anadolu Sigorta',
  amountMinor: 1250050,
  currency: 'TRY',
  createdAt: '2026-11-18T09:00:00.000Z',
  priceId: 'price1',
  priceVersion: 2,
  revisionId: 'rev2',
  revisionNumber: 2,
  termsNote: null,
  offeredPeriod: null,
};
const legacy = {
  source: 'QUOTE_VERSION',
  insurerId: 'i2',
  insurerName: 'Allianz',
  amountMinor: 1380000,
  currency: 'TRY',
  createdAt: '2026-11-18T08:00:00.000Z',
  quoteId: 'quote1',
  quoteVersionId: 'quote-version1',
  quoteVersionNumber: 3,
  quoteStatus: 'SENT',
  validUntil: '2026-12-01T09:00:00.000Z',
  startDate: '2026-12-01',
  endDate: '2027-01-20',
  termsNote: 'Eski gerçek teklif.',
};
const ok = (data: unknown, status = 200) => Response.json({ success: true, data }, { status });
const denied = (code: string, status: number) =>
  Response.json(
    {
      success: false,
      error: {
        code,
        message: code === 'CONFLICT' ? 'Fiyat başka işlemle değişmiş.' : 'Kayıt okunamadı.',
      },
    },
    { status },
  );
beforeEach(() => invalidateCsrfToken());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
type Options = {
  existing?: boolean;
  quote?: boolean;
  readonly?: boolean;
  malformed?: boolean;
  uncertain?: boolean;
  readbackFail?: boolean;
  wrongRevision?: boolean;
  conflict?: boolean;
};
function setup(options: Options = {}) {
  let rows: unknown[] = options.existing ? [original] : [];
  if (options.quote) rows.push(legacy);
  let written: SalesPriceCommandResult | null = null,
    saved: SalesPriceRevision | null = null,
    postCount = 0,
    refresh = false;
  const risk = vi.fn();
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('csrf-token')) return ok({ token: 'csrf' });
    if (url === '/api/catalogs/insurers')
      return ok([
        { id: 'i1', name: 'Anadolu Sigorta', status: 'ACTIVE' },
        { id: 'inactive', name: 'Pasif şirket', status: 'INACTIVE' },
      ]);
    if (init?.method === 'POST') {
      postCount++;
      if (options.conflict && postCount === 1) return denied('CONFLICT', 409);
      const command = JSON.parse(String(init.body));
      if (!written) {
        written = {
          operationId: '00000000-0000-4000-8000-000000000111',
          caseId: 'case1',
          caseVersion: command.expectedCaseVersion + 1,
          priceId: 'price1',
          priceVersion: (command.expectedPriceVersion ?? 0) + 1,
          revisionId: 'rev-new',
          revisionNumber: (command.expectedPriceVersion ?? 0) + 1,
        };
        saved = {
          ...original,
          priceVersion: written.priceVersion,
          revisionNumber: written.revisionNumber,
          revisionId: written.revisionId,
          amountMinor: command.amountMinor,
          currency: command.currency,
          termsNote: command.termsNote,
          offeredPeriod: command.offeredPeriod,
        };
        rows = [saved];
      }
      if (options.uncertain && postCount === 1) throw Error('Bağlantı koptu');
      return ok(written, url.endsWith('/revisions') ? 200 : 201);
    }
    if (url === '/api/sales-cases/case1') {
      refresh = true;
      return ok({ id: 'case1', version: 5 });
    }
    if (url.includes('/price-operations/')) {
      if (options.readbackFail) {
        options.readbackFail = false;
        return denied('UNAVAILABLE', 503);
      }
      return ok(written);
    }
    if (url.includes('/revisions/')) {
      if (options.wrongRevision) {
        options.wrongRevision = false;
        return ok({ ...saved, revisionId: 'unrelated-revision' });
      }
      return ok(saved);
    }
    if (url.includes('/history?'))
      return ok({
        revisions: [
          {
            ...original,
            revisionId: url.includes('cursor=') ? 'rev-old' : 'rev2',
            revisionNumber: url.includes('cursor=') ? 1 : 2,
          },
        ],
        hasMore: !url.includes('cursor='),
        nextCursor: url.includes('cursor=') ? null : 'history-cursor',
      });
    if (url.startsWith('/api/sales-cases/case1/prices?')) {
      if (options.malformed)
        return ok({
          items: [{ ...original, amountMinor: '1250050' }],
          hasMore: false,
          nextCursor: null,
          canManage: true,
        });
      if (refresh && !written)
        rows = [{ ...original, priceVersion: 4, revisionNumber: 4, revisionId: 'rev4' }];
      return ok({ items: rows, hasMore: false, nextCursor: null, canManage: !options.readonly });
    }
    throw Error('Beklenmeyen istek: ' + url);
  });
  vi.stubGlobal('fetch', fetcher);
  render(
    <MemoryRouter initialEntries={['/sales-cases/case1']}>
      <SalesPricesSection caseId="case1" caseVersion={options.existing ? 3 : 1} onRisk={risk} />
    </MemoryRouter>,
  );
  return {
    fetcher,
    risk,
    posts: () => fetcher.mock.calls.filter(([, init]) => init?.method === 'POST'),
  };
}
async function openNew() {
  fireEvent.click(await screen.findByRole('button', { name: 'Şirket fiyatı ekle' }));
  await screen.findByRole('option', { name: 'Anadolu Sigorta' });
  fireEvent.change(screen.getByLabelText('Sigorta şirketi (zorunlu)'), { target: { value: 'i1' } });
  fireEvent.change(screen.getByLabelText('Fiyat (zorunlu)'), { target: { value: '12.500,50' } });
}
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'Fiyatı kaydet' }));

it('parses Turkish money exactly, including explicit zero, and rejects ambiguous precision, negatives and unsafe minor totals', () => {
  for (const [input, expected] of [
    ['12.500,50', 1250050],
    ['12500,5', 1250050],
    ['12.500', 1250000],
    ['0', 0],
    ['0,00', 0],
    ['90071992547409,91', Number.MAX_SAFE_INTEGER],
  ] as const)
    expect(priceMinor(input)).toBe(expected);
  for (const input of ['', '-1', '1,123', '12.50,50', '1e3', 'Infinity', '90071992547409,92'])
    expect(priceMinor(input)).toBeNull();
});

it('saves only insurer and exact price by default, verifies the operation and revision before success, and reports draft risk', async () => {
  const f = setup();
  await openNew();
  expect(screen.queryByRole('option', { name: 'Pasif şirket' })).toBeNull();
  expect(screen.queryByLabelText(/Ürün|Ödeme yöntemi|Geçerlilik/)).toBeNull();
  expect(f.fetcher.mock.calls.some(([url]) => String(url).includes('history'))).toBe(false);
  expect(f.risk).toHaveBeenLastCalledWith({ dirty: true, unresolved: false });
  submit();
  await screen.findByText('Şirket fiyatı kaydedildi.');
  expect(f.posts()).toHaveLength(1);
  expect(JSON.parse(String(f.posts()[0]![1]!.body))).toEqual({
    expectedCaseVersion: 1,
    insurerId: 'i1',
    amountMinor: 1250050,
    currency: 'TRY',
    termsNote: null,
    offeredPeriod: null,
  });
  expect(f.fetcher.mock.calls.some(([url]) => String(url).includes('/price-operations/'))).toBe(
    true,
  );
  expect(f.fetcher.mock.calls.some(([url]) => String(url).endsWith('/revisions/rev-new'))).toBe(
    true,
  );
  expect(f.risk).toHaveBeenLastCalledWith({ dirty: false, unresolved: false });
});

it('revises the selected current price with both versions and an explicit nonannual period, preserving the source identity', async () => {
  const f = setup({ existing: true });
  fireEvent.click(await screen.findByRole('button', { name: 'Fiyatı güncelle' }));
  fireEvent.change(screen.getByLabelText('Fiyat (zorunlu)'), { target: { value: '0' } });
  fireEvent.click(screen.getByText('Koşul veya farklı teklif dönemi ekle (isteğe bağlı)'));
  fireEvent.change(screen.getByLabelText('Kısa koşul notu'), {
    target: { value: '  Kısa dönem.  ' },
  });
  fireEvent.change(screen.getByLabelText('Teklif dönemi başlangıcı'), {
    target: { value: '2027-01-01' },
  });
  fireEvent.change(screen.getByLabelText('Teklif dönemi bitişi'), {
    target: { value: '2027-04-18' },
  });
  submit();
  await screen.findByText('Şirket fiyatı kaydedildi.');
  expect(String(f.posts()[0]![0])).toBe('/api/sales-cases/case1/prices/price1/revisions');
  expect(JSON.parse(String(f.posts()[0]![1]!.body))).toEqual({
    expectedCaseVersion: 3,
    expectedPriceVersion: 2,
    amountMinor: 0,
    currency: 'TRY',
    termsNote: 'Kısa dönem.',
    offeredPeriod: { startDate: '2027-01-01', endDate: '2027-04-18' },
  });
});

it('loads bounded history only on demand and keeps legacy QuoteVersion rows outside lightweight edit actions', async () => {
  const f = setup({ existing: true, quote: true });
  const company = await screen.findByText('Allianz'),
    legacyRow = company.closest('tr')!;
  expect(within(legacyRow).getByText('İletildi')).toBeTruthy();
  expect(within(legacyRow).queryByRole('button', { name: 'Fiyatı güncelle' })).toBeNull();
  expect(within(legacyRow).queryByRole('button', { name: 'Fiyat geçmişi' })).toBeNull();
  expect(f.fetcher.mock.calls.some(([url]) => String(url).includes('/history'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'Fiyat geçmişi' }));
  await screen.findByRole('region', { name: 'Anadolu Sigorta fiyat geçmişi' });
  await waitFor(() =>
    expect(
      f.fetcher.mock.calls.some(([url]) => String(url).endsWith('/prices/price1/history?limit=20')),
    ).toBe(true),
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Önceki fiyatlar' }));
  await waitFor(() =>
    expect(
      f.fetcher.mock.calls.some(([url]) =>
        String(url).endsWith('/history?limit=20&cursor=history-cursor'),
      ),
    ).toBe(true),
  );
  expect(f.posts()).toHaveLength(0);
});

it('keeps uncertain writes frozen with the same body and key and uses GET-only verification after accepted success', async () => {
  const f = setup({ uncertain: true, readbackFail: true });
  await openNew();
  submit();
  const retry = await screen.findByRole('button', { name: 'Aynı fiyat kaydını tekrar kontrol et' });
  await waitFor(() => expect(retry.hasAttribute('disabled')).toBe(false));
  expect(
    (screen.getByLabelText('Fiyat (zorunlu)') as HTMLInputElement).closest('fieldset')!.disabled,
  ).toBe(true);
  fireEvent.click(retry);
  const verify = await screen.findByRole('button', { name: 'Kayıtlı fiyatı doğrula' });
  await waitFor(() => expect(verify.hasAttribute('disabled')).toBe(false));
  expect(f.posts()).toHaveLength(2);
  expect(f.posts()[0]![1]!.body).toBe(f.posts()[1]![1]!.body);
  expect(new Headers(f.posts()[0]![1]!.headers).get('idempotency-key')).toBe(
    new Headers(f.posts()[1]![1]!.headers).get('idempotency-key'),
  );
  fireEvent.click(verify);
  await screen.findByText('Şirket fiyatı kaydedildi.');
  expect(f.posts()).toHaveLength(2);
});

it('preserves the entered amount on CAS conflict and requires explicit refresh before using current case and price versions', async () => {
  const f = setup({ existing: true, conflict: true });
  fireEvent.click(await screen.findByRole('button', { name: 'Fiyatı güncelle' }));
  fireEvent.change(screen.getByLabelText('Fiyat (zorunlu)'), { target: { value: '14.200,20' } });
  submit();
  const refresh = await screen.findByRole('button', {
    name: 'Taslağı koru, güncel fiyatı kontrol et',
  });
  expect((screen.getByLabelText('Fiyat (zorunlu)') as HTMLInputElement).value).toBe('14.200,20');
  expect(screen.getByRole('button', { name: 'Fiyatı kaydet' }).hasAttribute('disabled')).toBe(true);
  expect(f.posts()).toHaveLength(1);
  fireEvent.click(refresh);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Fiyatı kaydet' }).hasAttribute('disabled')).toBe(
      false,
    ),
  );
  expect((screen.getByLabelText('Fiyat (zorunlu)') as HTMLInputElement).value).toBe('14.200,20');
  submit();
  await screen.findByText('Şirket fiyatı kaydedildi.');
  expect(JSON.parse(String(f.posts()[1]![1]!.body))).toMatchObject({
    expectedCaseVersion: 5,
    expectedPriceVersion: 4,
    amountMinor: 1420020,
  });
});

it('shows read-only prices without edit actions and rejects malformed DTO data without enabling writes', async () => {
  const f = setup({ existing: true, readonly: true });
  await screen.findByText('Anadolu Sigorta');
  expect(screen.queryByRole('button', { name: 'Şirket fiyatı ekle' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Fiyatı güncelle' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Fiyat geçmişi' })).toBeTruthy();
  expect(f.posts()).toHaveLength(0);
  cleanup();
  setup({ malformed: true });
  await screen.findByText('Şirket fiyatları okunamadı. Kayıtlar değiştirilmedi.');
  expect(screen.queryByRole('button', { name: 'Şirket fiyatı ekle' })).toBeNull();
  expect(screen.queryByText('Anadolu Sigorta')).toBeNull();
});

it('rejects a mismatched exact revision identity despite equal money and versions, preserving accepted GET-only retry', async () => {
  const f = setup({ wrongRevision: true });
  await openNew();
  submit();
  const retry = await screen.findByRole('button', { name: 'Kayıtlı fiyatı doğrula' });
  await waitFor(() => expect(retry.hasAttribute('disabled')).toBe(false));
  expect(screen.queryByText('Şirket fiyatı kaydedildi.')).toBeNull();
  expect(
    (screen.getByLabelText('Fiyat (zorunlu)') as HTMLInputElement).closest('fieldset')!.disabled,
  ).toBe(true);
  expect(f.risk).toHaveBeenLastCalledWith({ dirty: true, unresolved: true });
  expect(f.posts()).toHaveLength(1);
  fireEvent.click(retry);
  await screen.findByText('Şirket fiyatı kaydedildi.');
  expect(f.posts()).toHaveLength(1);
  const reads = f.fetcher.mock.calls.filter(([url]) => String(url).endsWith('/revisions/rev-new'));
  expect(reads).toHaveLength(2);
  expect(f.risk).toHaveBeenLastCalledWith({ dirty: false, unresolved: false });
});
