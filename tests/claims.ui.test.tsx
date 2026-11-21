// @vitest-environment jsdom
import { afterEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router';
import { ClaimEditor } from '../src/app/pages/claims/ClaimEditor';
import ClaimsPage from '../src/app/pages/claims/ClaimsPage';
import type { ClaimDetail, ClaimFields } from '../src/shared/claims';
import type { PolicyDetailDto } from '../src/shared/types';
import { policyDetailFixture } from './support/policy-detail-fixture';
vi.mock('../src/app/csrf', () => ({
  getCsrfToken: async () => 'csrf',
  invalidateCsrfToken: vi.fn(),
}));
const fields: ClaimFields = {
  lossDate: '2026-11-15',
  fileNumber: '000/001',
  expertName: null,
  expertContact: null,
  status: 'WAITING',
  note: null,
};
const d: ClaimDetail = {
  claim: {
    ...fields,
    id: 'h1',
    policyId: 'p1',
    customerId: 'c1',
    insurerId: 'i1',
    branchId: 'b1',
    customerName: 'Örnek Müşteri',
    policyNumber: 'POL-1',
    insurerName: 'Örnek Sigorta',
    branchName: 'Kasko',
    referenceName: 'Abdurrahman',
    version: 1,
    createdAt: '2026-11-15T09:00:00.000Z',
    updatedAt: '2026-11-15T09:00:00.000Z',
    parentArchived: false,
  },
  history: [{ version: 1, fields, createdAt: '2026-11-15T09:00:00.000Z' }],
  nextHistoryVersion: null,
  verifiedHistory: null,
  canManage: true,
  today: '2026-11-17',
  policyStartDate: '2026-01-01',
  policyEndDate: '2026-12-31',
};
const changed = { ...fields, status: 'IN_PROGRESS' as const, note: 'Eksper raporu bekleniyor' },
  updated: ClaimDetail = {
    ...d,
    claim: { ...d.claim, ...changed, version: 2 },
    verifiedHistory: { version: 2, fields: changed, createdAt: '2026-11-17T09:00:00.000Z' },
  };
const reply = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ success: status < 400, data }), { status });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function mount(onDone = vi.fn()) {
  render(
    <MemoryRouter>
      <ClaimEditor detail={d} onRisk={vi.fn()} onDone={onDone} onClose={vi.fn()} />
    </MemoryRouter>,
  );
  return onDone;
}
function fill() {
  fireEvent.click(screen.getByLabelText('Süreçte'));
  fireEvent.change(screen.getByLabelText('Güncelleme / durum notu *'), {
    target: { value: changed.note },
  });
}
it('uses a required update note, preserves leading zero identifiers and verifies immutable history before success', async () => {
  const fetcher = vi.fn(async (_u: string, i?: RequestInit) =>
    i?.method === 'POST' ? reply({ claimId: 'h1', version: 2 }) : reply(updated),
  );
  vi.stubGlobal('fetch', fetcher);
  const done = mount();
  fireEvent.click(screen.getByRole('button', { name: 'Güncellemeyi kaydet' }));
  expect(fetcher).not.toHaveBeenCalled();
  expect(await screen.findByRole('alert')).toBeTruthy();
  fill();
  fireEvent.click(screen.getByRole('button', { name: 'Güncellemeyi kaydet' }));
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body)).fields.fileNumber).toBe('000/001');
  expect(fetcher.mock.calls[1]![0]).toBe('/api/claims/h1?verifyVersion=2');
});
it('retries exactly the frozen request after a lost response without creating another operation key', async () => {
  let posts = 0;
  const fetcher = vi.fn(async (_u: string, i?: RequestInit) => {
    if (i?.method === 'POST') {
      if (++posts === 1) throw Error('lost');
      return reply({ claimId: 'h1', version: 2 });
    }
    return reply(updated);
  });
  vi.stubGlobal('fetch', fetcher);
  const done = mount();
  fill();
  fireEvent.click(screen.getByRole('button', { name: 'Güncellemeyi kaydet' }));
  const retry = await screen.findByRole('button', { name: 'Aynı kaydı güvenle yeniden dene' });
  await waitFor(() => expect(retry.hasAttribute('disabled')).toBe(false));
  fireEvent.click(retry);
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  const calls = fetcher.mock.calls.filter(([, i]) => i?.method === 'POST');
  expect(calls[0]![1]?.body).toBe(calls[1]![1]?.body);
  expect(calls[0]![1]?.headers).toEqual(calls[1]![1]?.headers);
});
it.each(['missing proof', 'malformed history', 'wrong policy'] as const)(
  'retains an accepted operation and retries only its history read after %s',
  async (failure) => {
    let reads = 0;
    const invalid = {
      'missing proof': { ...updated, verifiedHistory: null },
      'malformed history': { ...updated, history: [null] },
      'wrong policy': { ...updated, claim: { ...updated.claim, policyId: 'other' } },
    }[failure];
    const fetcher = vi.fn(async (_u: string, i?: RequestInit) =>
      i?.method === 'POST'
        ? reply({ claimId: 'h1', version: 2 })
        : reply(++reads === 1 ? invalid : updated),
    );
    vi.stubGlobal('fetch', fetcher);
    const done = mount();
    fill();
    fireEvent.click(screen.getByRole('button', { name: 'Güncellemeyi kaydet' }));
    const retry = await screen.findByRole('button', { name: 'Yalnız kaydı ve geçmişi kontrol et' });
    await waitFor(() => expect(retry.hasAttribute('disabled')).toBe(false));
    expect(done).not.toHaveBeenCalled();
    fireEvent.click(retry);
    await waitFor(() => expect(done).toHaveBeenCalledOnce());
    expect(fetcher.mock.calls.filter(([, i]) => i?.method === 'POST')).toHaveLength(1);
    expect(fetcher.mock.calls.filter(([, i]) => !i?.method).map(([path]) => path)).toEqual([
      '/api/claims/h1?verifyVersion=2',
      '/api/claims/h1?verifyVersion=2',
    ]);
  },
);
it('does not silently replace a conflicted version and preserves draft during explicit comparison', async () => {
  const fetcher = vi.fn(async (_u: string, i?: RequestInit) =>
    i?.method === 'POST' ? reply(null, 409) : reply(updated),
  );
  vi.stubGlobal('fetch', fetcher);
  mount();
  fill();
  fireEvent.click(screen.getByRole('button', { name: 'Güncellemeyi kaydet' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Güncel bilgileri karşılaştır' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Güncel bilgilerle devam et' }));
  expect((screen.getByLabelText('Güncelleme / durum notu *') as HTMLTextAreaElement).value).toBe(
    changed.note,
  );
  expect(fetcher.mock.calls.filter(([, i]) => i?.method === 'POST')).toHaveLength(1);
});
it.each([false, true])(
  'keeps refreshed claim fields on the second save (same field conflict: %s)',
  async (sameField) => {
    const current = {
      ...d,
      claim: {
        ...d.claim,
        version: 2,
        fileNumber: '001/002',
        expertName: 'Yeni eksper',
        status: sameField ? ('COMPLETED' as const) : d.claim.status,
      },
    };
    const acceptedFields = {
      ...fields,
      fileNumber: current.claim.fileNumber,
      expertName: current.claim.expertName,
      status: sameField ? changed.status : current.claim.status,
      note: changed.note,
    };
    const final = {
      ...current,
      claim: { ...current.claim, ...acceptedFields, version: 3 },
      verifiedHistory: { version: 3, fields: acceptedFields, createdAt: d.claim.createdAt },
    };
    let posts = 0;
    const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
      if (init?.method === 'POST')
        return ++posts === 1 ? reply(null, 409) : reply({ claimId: 'h1', version: 3 });
      return reply(url.includes('verifyVersion=3') ? final : current);
    });
    vi.stubGlobal('fetch', fetcher);
    const done = mount();
    if (sameField) fill();
    else
      fireEvent.change(screen.getByLabelText('Güncelleme / durum notu *'), {
        target: { value: changed.note },
      });
    fireEvent.click(screen.getByRole('button', { name: 'Güncellemeyi kaydet' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Güncel bilgileri karşılaştır' }));
    const continueButton = await screen.findByRole('button', {
      name: 'Güncel bilgilerle devam et',
    });
    if (sameField) {
      expect(continueButton.matches(':disabled')).toBe(true);
      const choice = screen.getByLabelText('Durum için kullanılacak değer');
      expect(choice.textContent).toContain('Güncel kayıt');
      fireEvent.change(choice, { target: { value: 'draft' } });
    }
    fireEvent.click(continueButton);
    fireEvent.click(screen.getByRole('button', { name: 'Güncellemeyi kaydet' }));
    await waitFor(() => expect(done).toHaveBeenCalledWith(final));
    const saves = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(saves).toHaveLength(2);
    expect(JSON.parse(String(saves[1]?.[1]?.body))).toMatchObject({
      expectedVersion: 2,
      fields: acceptedFields,
    });
  },
);
it('allows an unknown company file number and expert while using the real policyholder and nonannual period', async () => {
  const policy = {
    id: 'p1',
    version: 3,
    customerId: 'c1',
    customer: { displayName: 'Örnek Müşteri' },
    policyNumber: 'POL-1',
    insurer: { name: 'Örnek Sigorta' },
    branch: { name: 'Kasko' },
    startDate: '2026-10-01',
    endDate: '2026-11-30',
  } as PolicyDetailDto;
  const created = {
    ...d,
    claim: { ...d.claim, fileNumber: null, version: 1 },
    verifiedHistory: {
      version: 1,
      fields: { ...fields, fileNumber: null },
      createdAt: d.claim.createdAt,
    },
  };
  const fetcher = vi.fn(async (_u: string, i?: RequestInit) =>
    i?.method === 'POST' ? reply({ claimId: 'h1', version: 1 }) : reply(created),
  );
  vi.stubGlobal('fetch', fetcher);
  const done = vi.fn();
  render(
    <MemoryRouter>
      <ClaimEditor policy={policy} onRisk={vi.fn()} onDone={done} onClose={vi.fn()} />
    </MemoryRouter>,
  );
  fireEvent.input(screen.getByLabelText('Hasar tarihi *'), { target: { value: fields.lossDate } });
  fireEvent.click(screen.getByRole('button', { name: 'Hasar kaydını oluştur' }));
  await waitFor(() => expect(done).toHaveBeenCalledOnce());
  expect(JSON.parse(String(fetcher.mock.calls[0]![1]?.body))).toMatchObject({
    customerId: 'c1',
    expectedPolicyVersion: 3,
    fields: { fileNumber: null, expertName: null, note: null },
  });
});
it('hides writes for read-only users and uses server-filtered records without invented totals', async () => {
  const fetcher = vi.fn(async (_url: string) =>
    reply({ items: [d.claim], nextCursor: 'next', canManage: false, today: '2026-11-17' }),
  );
  vi.stubGlobal('fetch', fetcher);
  render(
    <MemoryRouter>
      <ClaimsPage />
    </MemoryRouter>,
  );
  await screen.findByRole('button', { name: 'Örnek Müşteri' });
  expect(screen.queryByRole('button', { name: 'Yeni hasar kaydı' })).toBeNull();
  expect(screen.getByText('Bu sayfada 1 dosya')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Müşteri, dosya veya poliçe no ara'), {
    target: { value: 'Örnek' },
  });
  fireEvent.click(screen.getByRole('button', { name: /^Ara$/ }));
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([u]) => String(u).includes('q=%C3%96rnek'))).toBe(true),
  );
});

it('preserves customer, policy, selected file and exact cursors on malformed list and history reads', async () => {
  let listReads = 0,
    detailReads = 0,
    historyReads = 0;
  const fetcher = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>(async (url) => {
    const path = new URL(url, 'https://example.invalid');
    if (path.pathname === '/api/claims')
      return reply({
        items: [++listReads === 1 ? { ...d.claim, customerId: 'c2' } : d.claim],
        nextCursor: null,
        canManage: true,
        today: d.today,
      });
    if (path.pathname === '/api/claims/h1') {
      if (path.searchParams.has('before'))
        return reply(++historyReads === 1 ? { ...d, history: [null] } : d);
      return reply(
        ++detailReads === 1
          ? { ...d, claim: { ...d.claim, policyId: 'other', customerName: 'Başka dosya' } }
          : { ...d, nextHistoryVersion: 1 },
      );
    }
    return reply({ branches: [] });
  });
  vi.stubGlobal('fetch', fetcher);
  const search = '?customerId=c1&policyId=p1&status=WAITING&cursor=page-2';
  render(
    <MemoryRouter initialEntries={['/claims' + search]}>
      <ClaimsPage />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Listeyi yeniden yükle' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Örnek Müşteri' }));
  const retryDetail = await screen.findByRole('button', { name: 'Hasar dosyasını yeniden yükle' });
  expect(screen.queryByText('Başka dosya')).toBeNull();
  fireEvent.click(retryDetail);
  fireEvent.click(await screen.findByRole('button', { name: 'Önceki kayıtlar' }));
  const retryHistory = await screen.findByRole('button', { name: 'Hasar dosyasını yeniden yükle' });
  expect(screen.getByRole('button', { name: 'Örnek Müşteri' })).toBeTruthy();
  fireEvent.click(retryHistory);
  await screen.findByText('Hasar dosyası oluşturuldu.');
  fireEvent.click(screen.getByRole('button', { name: 'Detayı kapat' }));
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Örnek Müşteri' })),
  );
  expect(screen.getByRole('button', { name: 'İlk sayfa' })).toBeTruthy();
  const requests = fetcher.mock.calls.map(([path]) => path);
  expect(requests.filter((path) => path.startsWith('/api/claims?'))).toEqual([
    '/api/claims' + search,
    '/api/claims' + search,
  ]);
  expect(requests.filter((path) => path.startsWith('/api/claims/h1'))).toEqual([
    '/api/claims/h1',
    '/api/claims/h1',
    '/api/claims/h1?before=1',
    '/api/claims/h1?before=1',
  ]);
  expect(fetcher.mock.calls.every(([, init]) => !init?.method)).toBe(true);
});

function mountMismatchedClaim() {
  function Location() {
    return <output aria-label="Ekran adresi">{useLocation().search}</output>;
  }
  const policy = policyDetailFixture('p1', {
    version: 3,
    policyNumber: 'POL-1',
    endDate: '2026-12-31',
  });
  const wrong = policyDetailFixture('wrong-policy', {
    policyNumber: 'POL-OTHER',
    customerId: 'c2',
  });
  const fetcher = vi.fn(async (path: string, init?: RequestInit) => {
    const url = new URL(path, 'https://example.invalid');
    if (url.pathname === '/api/claims/commands' && init?.method === 'POST')
      return reply({ claimId: d.claim.id, version: 1 });
    if (url.pathname === '/api/claims/h1')
      return reply({
        ...d,
        verifiedHistory: { ...d.history[0], fields: { ...fields, fileNumber: null } },
        claim: { ...d.claim, fileNumber: null },
      });
    if (url.pathname === '/api/claims')
      return reply({ items: [], nextCursor: null, canManage: true, today: '2026-11-17' });
    if (url.pathname === '/api/catalogs/selectable') return reply({ branches: [] });
    if (url.pathname === '/api/policies/wrong-policy') return reply(wrong);
    if (url.pathname === '/api/policies/p1') return reply(policy);
    if (url.pathname === '/api/policies' && url.searchParams.get('customerId') === 'c1')
      return reply({ items: [wrong, policy], hasMore: false, nextCursor: null });
    throw Error(path);
  });
  vi.stubGlobal('fetch', fetcher);
  render(
    <MemoryRouter
      initialEntries={['/claims?customerId=c1&policyId=wrong-policy&status=WAITING&cursor=old']}
    >
      <ClaimsPage />
      <Location />
    </MemoryRouter>,
  );
  return fetcher;
}

it('recovers a mismatched deep link by selecting and writing only the intended customer’s policy', async () => {
  const fetcher = mountMismatchedClaim();
  fireEvent.click(await screen.findByRole('button', { name: 'Yeni hasar kaydı' }));
  expect((await screen.findByRole('alert')).textContent).toContain(
    'poliçe seçili müşteriye ait değil',
  );
  expect(screen.queryByRole('button', { name: 'Hasar kaydını oluştur' })).toBeNull();
  expect(screen.queryByText('POL-OTHER')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Poliçe seç' }));
  const chooser = await screen.findByRole('heading', { name: 'Hasar için poliçe seçin' });
  expect(document.activeElement).toBe(chooser);
  expect(await screen.findByRole('option', { name: /POL-1/ })).toBeTruthy();
  expect(screen.queryByRole('option', { name: /POL-OTHER/ })).toBeNull();
  expect(screen.getByLabelText('Ekran adresi').textContent).toBe('?customerId=c1&status=WAITING');
  fireEvent.change(screen.getByLabelText('Poliçe seçin'), { target: { value: 'p1' } });
  fireEvent.input(await screen.findByLabelText('Hasar tarihi *'), {
    target: { value: fields.lossDate },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Hasar kaydını oluştur' }));
  await waitFor(() =>
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(true),
  );
  await screen.findByText('Hasar kaydı oluşturuldu ve geçmiş kontrol edildi.');
  const writes = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(writes).toHaveLength(1);
  expect(JSON.parse(String(writes[0]?.[1]?.body))).toMatchObject({
    kind: 'CREATE',
    policyId: 'p1',
    customerId: 'c1',
    expectedPolicyVersion: 3,
  });
});

it('closes a mismatched link and returns to the customer’s own filtered list without writing', async () => {
  const fetcher = mountMismatchedClaim();
  fireEvent.click(await screen.findByRole('button', { name: 'Yeni hasar kaydı' }));
  await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: 'Kapat' }));
  expect(screen.queryByRole('heading', { name: 'Poliçe seçimini kontrol edin' })).toBeNull();
  expect(screen.getByLabelText('Ekran adresi').textContent).toBe('?customerId=c1&status=WAITING');
  await screen.findByRole('button', { name: 'Yeni hasar kaydı' });
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
