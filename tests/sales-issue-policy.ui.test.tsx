import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { invalidateCsrfToken } from '../src/app/csrf';
import { SalesIssueSection } from '../src/app/pages/sales/SalesIssueSection';

const context = {
  caseId: 'case',
  caseVersion: 4,
  taskId: 'task',
  taskVersion: 1,
  customerId: 'customer',
  customerName: 'Sentetik Müşteri',
  branchId: 'b',
  branchName: 'Kasko',
  canCreate: true,
};
const row = { agencyId: 'a', status: 'ACTIVE', version: 1 };
const insurer = { ...row, id: 'i', name: 'Anadolu Sigorta' };
const catalogs = {
  insurers: [insurer],
  branches: [{ ...row, id: 'b', name: 'Kasko' }],
  products: [{ ...row, id: 'p', name: 'Kasko', insurerId: 'i', branchId: 'b' }],
  paymentMethods: [
    { ...row, id: 'm', name: 'Nakit', supportsInstallments: false, maxInstallments: 1 },
  ],
};
const policy = {
  ...row,
  id: 'policy',
  customerId: 'customer',
  branchId: 'b',
  insurerId: 'i',
  policyNumber: 'PL-20',
  archivedAt: null,
  startDate: '2027-01-10',
  endDate: '2027-04-01',
  grossPremiumMinor: 12345,
  currency: 'TRY',
};
const source = {
  kind: 'PRICE_REVISION',
  caseId: 'case',
  expectedCaseVersion: 4,
  revisionId: 'rev',
  acceptanceEventId: 'accept',
};
const accepted = {
  source,
  insurerId: 'i',
  insurerName: insurer.name,
  branchId: 'b',
  amountMinor: 12345,
  currency: 'TRY',
  startDate: policy.startDate,
  endDate: policy.endDate,
};
const result = {
  operationId: '00000000-0000-4000-8000-000000000004',
  caseId: 'case',
  caseVersion: 5,
  taskId: 'task',
  taskVersion: 2,
  policyId: 'policy',
  policyVersion: 1,
  createdPolicy: true,
  closedAt: '2026-11-19T13:00:00.000Z',
};
const ok = (data: unknown, status = 200) => Response.json({ success: true, data }, { status });
const failure = () => new Response(null, { status: 503 });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => invalidateCsrfToken());

function setup(resolve?: (url: string, init?: RequestInit) => Response | undefined) {
  const changed = vi.fn();
  const risk = vi.fn();
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const override = resolve?.(url, init);
    if (override) return override;
    if (url.endsWith('issue-context')) return ok(context);
    if (url.endsWith('issue-price-options')) return ok({ options: [accepted], nextAfter: null });
    if (url.endsWith('csrf-token')) return ok({ token: 'csrf' });
    if (url.endsWith('issue-operation')) return ok(result);
    if (url.endsWith('issue-policy')) return ok(result, 201);
    if (url.includes('/api/policies?')) return ok({ items: [policy], nextCursor: null });
    if (url.endsWith('catalogs/selectable')) return ok(catalogs);
    throw Error(url);
  });
  vi.stubGlobal('fetch', fetcher);
  render(
    <MemoryRouter>
      <SalesIssueSection
        caseId="case"
        expectedTaskId="task"
        canOperate={() => true}
        onRisk={risk}
        onChanged={changed}
      />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Poliçelendir' }));
  return {
    changed,
    risk,
    fetcher,
    writes: () => fetcher.mock.calls.filter(([, init]) => init?.method === 'POST'),
  };
}

it('creates through the existing policy form with the real price, current case, and GENERAL Task versions', async () => {
  const f = setup();
  fireEvent.click(await screen.findByRole('button', { name: 'Yeni poliçe kaydet' }));
  await screen.findByRole('option', { name: /Anadolu Sigorta ·/ });
  fireEvent.change(screen.getByLabelText('Kayıtlı teklif *'), { target: { value: 'price:rev' } });
  fireEvent.click(screen.getByRole('button', { name: 'Devam et' }));
  for (const [label, value] of [
    ['Ürün *', 'p'],
    ['Ödeme yöntemi *', 'm'],
    ['Yeni poliçe numarası *', 'PL-20'],
  ])
    fireEvent.change(screen.getByLabelText(label!), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Devam et' }));
  expect(screen.getByText('Müşterinin kabul ettiği fiyat')).toBeTruthy();
  fireEvent.click(screen.getByLabelText('Poliçe ve ödeme bilgilerini kontrol ettim'));
  fireEvent.click(screen.getByRole('button', { name: 'Poliçeyi kaydet' }));
  await waitFor(() => expect(f.changed).toHaveBeenCalledWith(result));
  expect(f.writes()).toHaveLength(1);
  expect(JSON.parse(String(f.writes()[0]?.[1]?.body))).toMatchObject({
    expectedCaseVersion: 4,
    expectedTaskId: 'task',
    expectedTaskVersion: 1,
    source: { kind: 'PRICE_REVISION', revisionId: 'rev', acceptanceEventId: 'accept' },
    result: {
      kind: 'CREATE_POLICY',
      policy: { insurerId: 'i', branchId: 'b', grossPremium: '123.45', endDate: '2027-04-01' },
    },
  });
});

it('explains a missing insurer and branch product before opening policy details', async () => {
  const catalogWithoutMatch = {
    ...catalogs,
    products: [{ ...catalogs.products[0], insurerId: 'another-company' }],
  };
  const f = setup((url) => {
    if (url.endsWith('catalogs/selectable')) return ok(catalogWithoutMatch);
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Yeni poliçe kaydet' }));
  await screen.findByRole('option', { name: /Anadolu Sigorta ·/ });
  fireEvent.change(screen.getByLabelText('Kayıtlı teklif *'), { target: { value: 'price:rev' } });
  fireEvent.click(screen.getByRole('button', { name: 'Devam et' }));
  expect(screen.getByText(/Bu şirket ve branş için etkin ürün bulunamadı/)).toBeTruthy();
  expect(screen.getByRole('button', { name: 'Poliçe seçeneklerini yenile' })).toBeTruthy();
  expect(screen.queryByLabelText('Ürün *')).toBeNull();
  expect(f.writes()).toHaveLength(0);
});

it('links with an explicit no-quote reason, retries ambiguous POST exactly, and then uses only GET verification', async () => {
  let posts = 0,
    reads = 0;
  const f = setup((url) => {
    if (url.endsWith('/issue-policy')) return ++posts === 1 ? failure() : ok(null);
    if (url.endsWith('/issue-operation'))
      return ++reads === 1 ? failure() : ok({ ...result, createdPolicy: false });
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Mevcut poliçeyi bağla' }));
  await screen.findByRole('option', { name: /PL-20/ });
  fireEvent.change(screen.getByLabelText('Mevcut poliçe *'), { target: { value: 'policy' } });
  fireEvent.change(screen.getByLabelText('Kayıtlı teklif *'), { target: { value: 'NONE' } });
  fireEvent.change(screen.getByLabelText('Teklif kaydı olmadan devam etme nedeni *'), {
    target: { value: 'Müşteri doğrudan onayladı' },
  });
  fireEvent.click(screen.getByLabelText('Poliçeyi kontrol ettim, takibi kapat'));
  fireEvent.click(screen.getByRole('button', { name: 'Poliçeyi bağla' }));
  await screen.findByText(/Kayıt sonucu belirsiz/);
  fireEvent.click(screen.getByRole('button', { name: 'Aynı işlemi tekrar kontrol et' }));
  await screen.findByText(/Sonuç henüz doğrulanamadı/);
  fireEvent.click(screen.getByRole('button', { name: 'Kayıtlı sonucu doğrula' }));
  await waitFor(() => expect(f.changed).toHaveBeenCalledWith({ ...result, createdPolicy: false }));
  expect(f.writes()).toHaveLength(2);
  expect(f.writes()[0]).toEqual(f.writes()[1]);
  expect(JSON.parse(String(f.writes()[0]?.[1]?.body))).toMatchObject({
    source: { kind: 'NO_QUOTE', reason: 'Müşteri doğrudan onayladı' },
    result: { kind: 'LINK_POLICY', policyId: 'policy', expectedPolicyVersion: 1 },
  });
});

it('keeps another task out of the workflow', async () => {
  const f = setup((url) =>
    url.endsWith('/issue-context') ? ok({ ...context, taskId: 'other' }) : undefined,
  );
  await screen.findByText(/Takip değişti/);
  expect(screen.queryByRole('button', { name: 'Yeni poliçe kaydet' })).toBeNull();
  expect(f.writes()).toHaveLength(0);
});
