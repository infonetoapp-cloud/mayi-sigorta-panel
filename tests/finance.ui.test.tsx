// @vitest-environment jsdom
import { afterEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, useNavigate } from 'react-router';
import { FinanceEditor } from '../src/app/pages/finance/FinanceEditor';
import FinancePage from '../src/app/pages/finance/FinancePage';
import type { FinanceDetail, FinanceEntry } from '../src/shared/finance';
import { policyDetailFixture } from './support/policy-detail-fixture';
vi.mock('../src/app/csrf', () => ({
  getCsrfToken: async () => 'csrf',
  invalidateCsrfToken: vi.fn(),
}));
const record: FinanceDetail = {
  receivable: {
    id: 'f1',
    policyId: 'p1',
    customerId: 'c1',
    customerName: 'Örnek Müşteri',
    policyNumber: 'POL-1',
    branchName: 'Kasko',
    amountMinor: 10000,
    collectedMinor: 0,
    remainingMinor: 10000,
    currency: 'TRY',
    dueDate: '2026-12-01',
    method: 'DEFERRED',
    status: 'ACTIVE',
    version: 1,
    createdAt: '2026-11-01T00:00:00.000Z',
    state: 'OPEN',
  },
  entries: [],
  revisions: [],
  canManage: true,
  today: '2026-11-13',
};
const payment: FinanceEntry = {
  id: 'e1',
  kind: 'PAYMENT',
  amountMinor: 3000,
  receivedDate: '2026-11-12',
  method: 'BANK',
  reversesId: null,
  reasonCode: null,
  createdAt: '2026-11-13T00:00:00.000Z',
};
const updated: FinanceDetail = {
  ...record,
  receivable: {
    ...record.receivable,
    version: 2,
    collectedMinor: 3000,
    remainingMinor: 7000,
    state: 'PARTIAL',
  },
  entries: [payment],
  verifiedEntry: payment,
};
const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ success: status < 400, data }), { status });
function HistoryBack() {
  const navigate = useNavigate();
  return <button onClick={() => void navigate(-1)}>Tarayıcı geri</button>;
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function mount(kind: 'COLLECT' | 'REVERSE' | 'ADJUST' = 'COLLECT', onDone = vi.fn()) {
  render(
    <MemoryRouter>
      <FinanceEditor
        kind={kind}
        detail={record}
        entry={kind === 'REVERSE' ? payment : undefined}
        onDone={onDone}
        onRisk={vi.fn()}
        onClose={vi.fn()}
      />
    </MemoryRouter>,
  );
  return onDone;
}
function fill() {
  fireEvent.change(screen.getByLabelText('Tutar (TRY) *'), { target: { value: '30.00' } });
  fireEvent.input(screen.getByLabelText('Tahsilat tarihi *'), { target: { value: '2026-11-12' } });
  fireEvent.click(screen.getByLabelText('Bu tutarı acentenin aldığını onaylıyorum'));
}
it('requires actual agency receipt confirmation and verifies the immutable payment before showing success', async () => {
  const fetcher = vi.fn(async (_u: string, init?: RequestInit) =>
    init?.method === 'POST'
      ? reply({ receivableId: 'f1', version: 2, entryId: 'e1' })
      : reply(updated),
  );
  vi.stubGlobal('fetch', fetcher);
  const done = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Tahsilatı kaydet' }));
  expect(fetcher).not.toHaveBeenCalled();
  expect(await screen.findByRole('alert')).toBeTruthy();
  fill();
  fireEvent.click(screen.getByRole('button', { name: 'Tahsilatı kaydet' }));
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(fetcher.mock.calls[1]![0]).toBe('/api/finance/receivables/f1?verifyEntry=e1');
});
it('keeps the other worker’s due date when resubmitting a translated amount', async () => {
  const current = {
    ...record,
    receivable: { ...record.receivable, version: 2, dueDate: '2026-12-20' },
  };
  const final = {
    ...current,
    receivable: { ...current.receivable, amountMinor: 125050, remainingMinor: 125050, version: 3 },
    verifiedRevision: {
      version: 3,
      amountMinor: 125050,
      dueDate: '2026-12-20',
      status: 'ACTIVE',
      reasonCode: 'DATA_ERROR',
      createdAt: record.receivable.createdAt,
    },
  };
  let posts = 0;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === 'POST')
      return ++posts === 1
        ? reply(null, 409)
        : reply({ receivableId: 'f1', version: 3, entryId: null });
    return reply(url.includes('verifyVersion=3') ? final : current);
  });
  vi.stubGlobal('fetch', fetcher);
  const done = mount('ADJUST');
  fireEvent.change(screen.getByLabelText('Tutar (TRY) *'), { target: { value: '1.250,50' } });
  fireEvent.change(screen.getByLabelText('Düzeltme nedeni *'), { target: { value: 'DATA_ERROR' } });
  const confirm = screen.getByLabelText('Düzeltmeyi ve nedenini onaylıyorum');
  fireEvent.click(confirm);
  const save = screen.getByRole('button', { name: 'Düzeltmeyi kaydet' });
  fireEvent.click(save);
  fireEvent.click(await screen.findByRole('button', { name: 'Güncel bilgileri karşılaştır' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Güncel bilgilerle devam et' }));
  fireEvent.click(confirm);
  fireEvent.click(save);
  await waitFor(() => expect(done).toHaveBeenCalledWith(final));
  const saves = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(saves).toHaveLength(2);
  expect(JSON.parse(String(saves[1]?.[1]?.body))).toMatchObject({
    kind: 'ADJUST',
    expectedVersion: 2,
    amount: '1250.50',
    dueDate: '2026-12-20',
  });
});
it('fills the current balance and agency date without submitting a collection', () => {
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Kalan tutarı kullan' }));
  fireEvent.click(screen.getByRole('button', { name: /^Bugün$/ }));
  expect((screen.getByLabelText('Tutar (TRY) *') as HTMLInputElement).value).toBe('100,00');
  expect((screen.getByLabelText('Tahsilat tarihi *') as HTMLInputElement).value).toBe(record.today);
  expect(screen.getByText(/100,00 TRY .*Havale/)).toBeTruthy();
  expect(fetcher).not.toHaveBeenCalled();
});
it('freezes an uncertain write and retries the exact body and key without a second draft', async () => {
  let posts = 0;
  const fetcher = vi.fn(async (_u: string, init?: RequestInit) => {
    if (init?.method === 'POST') {
      if (++posts === 1) throw Error('connection lost');
      return reply({ receivableId: 'f1', version: 2, entryId: 'e1' });
    }
    return reply(updated);
  });
  vi.stubGlobal('fetch', fetcher);
  const done = mount();
  fill();
  fireEvent.click(screen.getByRole('button', { name: 'Tahsilatı kaydet' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Aynı kaydı güvenle yeniden dene' }));
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  const calls = fetcher.mock.calls.filter(([, i]) => i?.method === 'POST');
  expect(calls).toHaveLength(2);
  expect(calls[1]![1]?.body).toBe(calls[0]![1]?.body);
  expect(calls[1]![1]?.headers).toEqual(calls[0]![1]?.headers);
});
it.each(['mismatched proof', 'invalid history'])(
  'only retries reads after accepted write and %s',
  async (failure) => {
    let reads = 0;
    const fetcher = vi.fn(async (_u: string, init?: RequestInit) =>
      init?.method === 'POST'
        ? reply({ receivableId: 'f1', version: 2, entryId: 'e1' })
        : reply(
            ++reads === 1
              ? failure === 'mismatched proof'
                ? { ...updated, verifiedEntry: { ...payment, amountMinor: 9999 } }
                : { ...updated, entries: [null] }
              : updated,
          ),
    );
    vi.stubGlobal('fetch', fetcher);
    const done = mount();
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Tahsilatı kaydet' }));
    const retry = await screen.findByRole('button', {
      name: 'Yalnız kaydı ve bakiyeyi kontrol et',
    });
    await waitFor(() =>
      expect(screen.getByLabelText('Tutar (TRY) *').matches(':disabled')).toBe(true),
    );
    await waitFor(() => expect(retry.hasAttribute('disabled')).toBe(false));
    expect(done).not.toHaveBeenCalled();
    fireEvent.click(retry);
    await waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(fetcher.mock.calls.filter(([, i]) => i?.method === 'POST')).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([, i]) => !i?.method).map(([url]) => url)).toEqual([
      '/api/finance/receivables/f1?verifyEntry=e1',
      '/api/finance/receivables/f1?verifyEntry=e1',
    ]);
  },
);
it('keeps a conflict draft and explicitly compares fresh balance before adopting its version', async () => {
  let posts = 0;
  const fetcher = vi.fn(async (_u: string, init?: RequestInit) =>
    init?.method === 'POST'
      ? ++posts === 1
        ? reply(null, 409)
        : reply({ receivableId: 'f1', version: 3, entryId: 'e1' })
      : reply(
          posts === 1 ? updated : { ...updated, receivable: { ...updated.receivable, version: 3 } },
        ),
  );
  vi.stubGlobal('fetch', fetcher);
  mount();
  fill();
  fireEvent.click(screen.getByRole('button', { name: 'Tahsilatı kaydet' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Güncel bilgileri karşılaştır' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Güncel bilgilerle devam et' }));
  expect((screen.getByLabelText('Tutar (TRY) *') as HTMLInputElement).value).toBe('30.00');
  expect(screen.getByText(/Görüntülenen kalan/).textContent).toContain('70,00');
  fireEvent.click(screen.getByLabelText('Bu tutarı acentenin aldığını onaylıyorum'));
  fireEvent.click(screen.getByRole('button', { name: 'Tahsilatı kaydet' }));
  await waitFor(() => expect(posts).toBe(2));
  const body = JSON.parse(
    String(fetcher.mock.calls.filter(([, i]) => i?.method === 'POST')[1]![1]?.body),
  );
  expect(body.expectedVersion).toBe(2);
});
it('requires a correction reason and appends a reversal without presenting it as a refund', async () => {
  const reverse = {
    ...payment,
    id: 'e2',
    kind: 'REVERSAL',
    reversesId: 'e1',
    reasonCode: 'DATA_ERROR',
  };
  const fetcher = vi.fn(async (_u: string, init?: RequestInit) =>
    init?.method === 'POST'
      ? reply({ receivableId: 'f1', version: 2, entryId: 'e2' })
      : reply({ ...updated, verifiedEntry: reverse }),
  );
  vi.stubGlobal('fetch', fetcher);
  const done = mount('REVERSE');
  expect(screen.getByText(/gerçek para iadesi yapmaz/)).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Düzeltme nedeni *'), { target: { value: 'DATA_ERROR' } });
  fireEvent.click(screen.getByLabelText('Düzeltmeyi ve nedenini onaylıyorum'));
  fireEvent.click(screen.getByRole('button', { name: 'Ters kaydı oluştur' }));
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toEqual({
    kind: 'REVERSE',
    receivableId: 'f1',
    expectedVersion: 1,
    entryId: 'e1',
    reasonCode: 'DATA_ERROR',
  });
});
it('uses server totals for the filtered collection and does not offer writes to a read-only member', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      reply({
        items: [record.receivable],
        nextCursor: null,
        totals: [
          { currency: 'TRY', amountMinor: 90000, collectedMinor: 20000, remainingMinor: 70000 },
        ],
        canManage: false,
        today: '2026-11-13',
      }),
    ),
  );
  render(
    <MemoryRouter>
      <FinancePage />
    </MemoryRouter>,
  );
  await screen.findByRole('button', { name: 'Örnek Müşteri' });
  expect(screen.queryByRole('button', { name: 'Yeni acente alacağı' })).toBeNull();
  expect(screen.getByLabelText('Filtrelenmiş kayıtların toplamı').textContent).toContain('700,00');
});

it('isolates malformed list and detail responses and retries the same filters and history page', async () => {
  let listReads = 0,
    detailReads = 0,
    historyReads = 0;
  const fetcher = vi.fn<(path: string, init?: RequestInit) => Promise<Response>>(async (path) => {
    const url = new URL(path, 'https://example.invalid');
    if (url.pathname === '/api/finance/receivables') {
      return reply({
        items: [record.receivable],
        nextCursor: null,
        canManage: true,
        today: record.today,
        totals: [
          {
            currency: 'TRY',
            amountMinor: 10000,
            collectedMinor: 0,
            remainingMinor: ++listReads === 1 ? 1 : 10000,
          },
        ],
      });
    }
    if (url.pathname === '/api/finance/receivables/f1') {
      if (url.searchParams.has('entriesBefore'))
        return reply({ ...record, entries: ++historyReads === 1 ? [null] : [payment] });
      return reply(
        ++detailReads === 1
          ? {
              ...record,
              receivable: { ...record.receivable, id: 'f2', customerName: 'Başka alacak' },
            }
          : { ...record, entriesNextCursor: 'older' },
      );
    }
    return reply({ branches: [] });
  });
  vi.stubGlobal('fetch', fetcher);
  render(
    <MemoryRouter initialEntries={['/finance?view=ALL&due=TODAY&q=Ornek&cursor=page-2']}>
      <FinancePage />
      <HistoryBack />
    </MemoryRouter>,
  );
  const retryList = await screen.findByRole('button', { name: 'Listeyi yeniden yükle' });
  expect(screen.queryByLabelText('Filtrelenmiş kayıtların toplamı')).toBeNull();
  fireEvent.click(retryList);
  fireEvent.click(await screen.findByRole('button', { name: 'Örnek Müşteri' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Alacağı yeniden yükle' }));
  expect(screen.queryByText('Başka alacak')).toBeNull();
  fireEvent.click(await screen.findByRole('button', { name: 'Önceki tahsilatlar' }));
  const retryHistory = await screen.findByRole('button', { name: 'Alacağı yeniden yükle' });
  expect(screen.getByRole('button', { name: 'Örnek Müşteri' })).toBeTruthy();
  fireEvent.click(retryHistory);
  await screen.findByText(/Tahsilat · 30,00 TRY/);
  fireEvent.click(screen.getByRole('button', { name: 'Detayı kapat' }));
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Örnek Müşteri' })),
  );
  expect(screen.getByRole('button', { name: 'İlk sayfa' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Detayı aç' }));
  await screen.findByRole('button', { name: 'Detayı kapat' });
  fireEvent.click(screen.getByRole('button', { name: 'Tarayıcı geri' }));
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Detayı aç' })),
  );
  const requests = fetcher.mock.calls.map(([path]) => path);
  const listUrl = '/api/finance/receivables?view=ALL&due=TODAY&q=Ornek&cursor=page-2';
  expect(requests.filter((path) => path.startsWith('/api/finance/receivables?'))).toEqual([
    listUrl,
    listUrl,
  ]);
  expect(requests.filter((path) => path.includes('entriesBefore='))).toEqual([
    '/api/finance/receivables/f1?entriesBefore=older',
    '/api/finance/receivables/f1?entriesBefore=older',
  ]);
  expect(fetcher.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

it('shows one creation heading and keeps collection ahead of balance corrections', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => {
      const url = new URL(path, 'https://example.invalid');
      if (url.pathname === '/api/finance/receivables/f1') return reply(record);
      if (url.pathname === '/api/finance/receivables')
        return reply({
          items: [record.receivable],
          nextCursor: null,
          canManage: true,
          totals: [],
          today: record.today,
        });
      if (url.pathname === '/api/catalogs/selectable') return reply({ branches: [] });
      if (url.pathname === '/api/policies/p1')
        return reply(policyDetailFixture('p1', { policyNumber: 'POL-1' }));
      throw Error(path);
    }),
  );
  render(
    <MemoryRouter initialEntries={['/finance?policyId=p1']}>
      <FinancePage />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Yeni acente alacağı' }));
  const form = await screen.findByRole('form', { name: 'Acente alacağı oluştur' });
  expect(
    screen.getAllByRole('heading', { level: 2 }).map((heading) => heading.textContent),
  ).toEqual(['Acente alacağı oluştur']);
  expect(form.contains(screen.getByRole('button', { name: 'Alacağı kaydet' }))).toBe(true);
  expect(form.contains(screen.getByRole('button', { name: 'Vazgeç' }))).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Vazgeç' }));
  fireEvent.click(screen.getByRole('button', { name: 'Detayı aç' }));
  const actions = await screen.findByRole('group', { name: 'Alacak işlemleri' });
  expect(Array.from(actions.querySelectorAll('button'), (button) => button.textContent)).toEqual([
    'Tahsilat kaydet',
    'Alacağı veya vadeyi düzelt',
    'Alacağı iptal et',
  ]);
  fireEvent.click(screen.getByRole('button', { name: 'Tahsilat kaydet' }));
  expect(await screen.findByRole('heading', { name: 'Tahsilat kaydet', level: 3 })).toBeTruthy();
});
