import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WonPolicyOperation } from '../src/app/pages/today-work/WonPolicyOperation';
import { invalidateCsrfToken } from '../src/app/csrf';
import { StrictMode } from 'react';
import type { TodayTaskDto } from '../src/shared/types';
const task = {
  taskId: 't',
  renewalId: 'r',
  customerId: 'c',
  customerDisplayName: 'Sentetik',
  policyId: 'old',
  policyNumber: 'OLD',
  taskVersion: 7,
  renewalVersion: 3,
  assigneeMembershipId: 'self',
  renewalState: 'CONTACT_PENDING',
} as TodayTaskDto;
const row = { agencyId: 'a', status: 'ACTIVE', version: 1 };
const catalogs = {
  insurers: [{ ...row, id: 'i', name: 'Sigortacı' }],
  branches: [{ ...row, id: 'b', name: 'Branş', dataClassification: 'GENERAL' }],
  products: [{ ...row, id: 'p', name: 'Ürün', insurerId: 'i', branchId: 'b' }],
  paymentMethods: [
    { ...row, id: 'm', name: 'Peşin', supportsInstallments: false, maxInstallments: 12 },
  ],
  lossReasons: [],
};
const policy = {
  id: 'created',
  agencyId: 'a',
  customerId: 'c',
  customer: { id: 'c' },
  insurerId: 'i',
  productId: 'p',
  branchId: 'b',
  paymentMethodId: 'm',
  assigneeMembershipId: 'self',
  policyNumber: 'NEW-1',
  startDate: '2027-01-01',
  endDate: '2027-12-31',
  grossPremiumMinor: 125050,
  currency: 'TRY',
  installmentCount: null,
  status: 'ACTIVE',
  archivedAt: null,
  version: 1,
  insurer: { id: 'i', name: 'Sigortacı' },
  product: { id: 'p', name: 'Ürün' },
};
const result = {
  renewalId: 'r',
  primaryTaskId: 't',
  previousState: 'CONTACT_PENDING',
  state: 'WON',
  renewalVersion: 4,
  taskVersion: 8,
  closedAt: '2026-10-19T09:00:00.000Z',
  createdPolicyId: 'created',
  acceptedQuoteVersionId: null,
  acceptedPolicyId: null,
  newPolicyIds: ['created'],
  linkIds: ['link'],
  links: [
    {
      id: 'link',
      newPolicyId: 'created',
      allocatedNewPremiumMinor: 125050,
      currency: 'TRY',
      differentPolicyholderReasonCode: null,
    },
  ],
};
const response = (data: unknown, status = 200) =>
  new Response(
    JSON.stringify(
      status < 400
        ? { success: true, data }
        : { success: false, error: { code: 'CONFLICT', message: 'unsafe diagnostic' } },
    ),
    { status },
  );
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => invalidateCsrfToken());
function fixture(
  override?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined,
  strict = false,
) {
  const applied = vi.fn(),
    read = vi.fn(async () => ({ current: { ...task }, apply: vi.fn() }));
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const r = override?.(url, init);
    if (r) return r;
    if (url.endsWith('csrf-token')) return response({ token: 'csrf' });
    if (url === '/api/catalogs/selectable') return response(catalogs);
    if (url === '/api/policies/created') return response(policy);
    if (url.startsWith('/api/customers/c/renewals'))
      return response({ items: [{ id: 'r', state: 'WON', version: 4 }], nextCursor: null });
    if (init?.method === 'POST') return response(result, 201);
    throw Error(url);
  });
  vi.stubGlobal('fetch', fetcher);
  const ui = (
    <WonPolicyOperation
      mode="CREATE_POLICY"
      task={task}
      read={read}
      canOperate={() => true}
      blocked={() => false}
      onRisk={() => {}}
      onApplied={applied}
    />
  );
  const view = render(strict ? <StrictMode>{ui}</StrictMode> : ui);
  return { fetcher, applied, read, view };
}
async function fill() {
  fireEvent.click(screen.getByRole('button', { name: 'Kazanıldı — yeni poliçe oluştur' }));
  await screen.findByRole('option', { name: 'Sigortacı' });
  for (const [label, value] of [
    ['Sigorta şirketi', 'i'],
    ['Branş', 'b'],
    ['Ürün', 'p'],
    ['Ödeme yöntemi', 'm'],
    ['Poliçe sorumlusu', 'self'],
    ['Yeni poliçe numarası', 'NEW-1'],
    ['Başlangıç tarihi', '2027-01-01'],
    ['Bitiş tarihi', '2027-12-31'],
    ['Brüt prim', '1250.50'],
  ] as const)
    fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Yeni poliçeyi gözden geçir' }));
  await screen.findByText(/İncelenen yeni poliçe/);
}
function submit() {
  fireEvent.click(
    screen.getByLabelText('Yeni poliçe oluşturulmasını ve kazanıldı sonucunu onaylıyorum'),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Yeni poliçe oluştur ve kazanıldı kaydet' }));
}
const writes = (f: ReturnType<typeof fixture>) =>
  f.fetcher.mock.calls.filter(([, i]) => i?.method === 'POST');
it('creates policy and WON only through one frozen atomic command with decimal string premium', async () => {
  const f = fixture();
  await fill();
  expect(writes(f)).toHaveLength(0);
  submit();
  await waitFor(() => expect(f.applied).toHaveBeenCalled());
  expect(writes(f)[0]![0]).toBe('/api/renewals/r/close-won');
  expect(JSON.parse(writes(f)[0]![1]!.body as string)).toEqual({
    expectedPrimaryTaskId: 't',
    expectedRenewalVersion: 3,
    expectedTaskVersion: 7,
    result: {
      kind: 'CREATE_POLICY',
      policy: {
        customerId: 'c',
        insurerId: 'i',
        branchId: 'b',
        productId: 'p',
        paymentMethodId: 'm',
        assigneeMembershipId: 'self',
        policyNumber: 'NEW-1',
        startDate: '2027-01-01',
        endDate: '2027-12-31',
        grossPremium: '1250.50',
        currency: 'TRY',
        installmentCount: null,
        status: 'ACTIVE',
      },
    },
  });
});
it.each([408, 429, 500, 503])(
  'preserves exact CREATE_POLICY retry after uncertain HTTP%s',
  async (status) => {
    let calls = 0;
    const f = fixture((_u, i) =>
      i?.method === 'POST' && ++calls === 1 ? response({}, status) : undefined,
    );
    await fill();
    submit();
    await screen.findByText(/Sonuç belirsiz/);
    expect(
      screen
        .getByRole('button', { name: 'Yeni poliçeyle kazanma taslağını açıkça kapat' })
        .hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.click(
      screen.getByRole('button', { name: 'Aynı poliçe oluşturma isteğini yeniden dene' }),
    );
    await waitFor(() => expect(f.applied).toHaveBeenCalled());
    expect(writes(f)).toHaveLength(2);
    expect(writes(f)[0]![0]).toBe(writes(f)[1]![0]);
    expect(writes(f)[0]![1]!.body).toBe(writes(f)[1]![1]!.body);
    expect(writes(f)[0]![1]!.headers).toEqual(writes(f)[1]![1]!.headers);
  },
);
it('keeps confirmed creation GET-only when policy readback is temporarily unavailable', async () => {
  let failed = true;
  const f = fixture((u) =>
    u === '/api/policies/created' && failed ? response({}, 503) : undefined,
  );
  await fill();
  submit();
  await screen.findByText(/Başarı henüz doğrulanmadı/);
  failed = false;
  fireEvent.click(
    screen.getByRole('button', { name: 'Yalnız oluşturulan poliçe okumalarını yeniden dene' }),
  );
  await waitFor(() => expect(f.applied).toHaveBeenCalled());
  expect(writes(f)).toHaveLength(1);
});
it.each([
  'customerId',
  'insurerId',
  'assigneeMembershipId',
  'grossPremiumMinor',
  'version',
  'status',
])('does not claim success for contradictory new policy detail %s', async (field) => {
  const f = fixture((u) =>
    u === '/api/policies/created'
      ? response({
          ...policy,
          [field]: field === 'grossPremiumMinor' ? 1 : field === 'version' ? 2 : 'wrong',
        })
      : undefined,
  );
  await fill();
  submit();
  await screen.findByText(/Başarı henüz doğrulanmadı/);
  expect(f.applied).not.toHaveBeenCalled();
  expect(writes(f)).toHaveLength(1);
});
it.each(['createdPolicyId', 'primaryTaskId', 'allocatedNewPremiumMinor'])(
  'does not trust malformed CREATE response %s despite HTTP201',
  async (field) => {
    const r =
      field === 'allocatedNewPremiumMinor'
        ? { ...result, links: [{ ...result.links[0], allocatedNewPremiumMinor: 1 }] }
        : { ...result, [field]: field === 'createdPolicyId' ? null : 'other' };
    const f = fixture((_u, i) => (i?.method === 'POST' ? response(r, 201) : undefined));
    await fill();
    submit();
    await screen.findByText(/Başarı henüz doğrulanmadı/);
    expect(f.applied).not.toHaveBeenCalled();
    expect(writes(f)).toHaveLength(1);
  },
);
it('preserves draft and requires new review after catalog lifecycle changes before POST', async () => {
  let reads = 0;
  const f = fixture((u) =>
    u === '/api/catalogs/selectable' && ++reads > 1
      ? response({ ...catalogs, products: [{ ...catalogs.products[0], status: 'INACTIVE' }] })
      : undefined,
  );
  await fill();
  submit();
  await screen.findByText(/Katalog veya seçim değişti/);
  expect(writes(f)).toHaveLength(0);
  expect((screen.getByLabelText('Yeni poliçe numarası') as unknown as HTMLInputElement).value).toBe(
    'NEW-1',
  );
});
it.each([
  ['Brüt prim', '1.005'],
  ['Brüt prim', '9007199254740992'],
  ['Bitiş tarihi', '2020-01-01'],
  ['Para birimi', 'ZZZ'],
])('blocks invalid %s = %s before review or POST', async (label, value) => {
  const f = fixture();
  await fill();
  fireEvent.change(screen.getByLabelText(label), { target: { value } });
  fireEvent.click(screen.getByRole('button', { name: 'Yeni poliçeyi gözden geçir' }));
  expect(screen.queryByText(/İncelenen yeni poliçe/)).toBeNull();
  expect(writes(f)).toHaveLength(0);
});
it('keeps duplicate409 definitive, preserves number, compares original target, and requires explicit re-review', async () => {
  const f = fixture((u, i) =>
    i?.method === 'POST'
      ? response({}, 409)
      : u.startsWith('/api/policies?')
        ? response({ items: [], nextCursor: null, hasMore: false })
        : undefined,
  );
  await fill();
  submit();
  await screen.findByText(/Kazanıldı kaydı çakıştı/);
  expect(
    screen.queryByRole('button', { name: 'Aynı poliçe oluşturma isteğini yeniden dene' }),
  ).toBeNull();
  await waitFor(() =>
    expect(
      screen
        .getByRole('button', { name: 'Poliçe oluşturma bilgilerini karşılaştır' })
        .hasAttribute('disabled'),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Poliçe oluşturma bilgilerini karşılaştır' }));
  await screen.findByRole('button', { name: 'Aynı takip ile oluşturma taslağını yeniden incele' });
  fireEvent.click(
    screen.getByRole('button', { name: 'Aynı takip ile oluşturma taslağını yeniden incele' }),
  );
  expect((screen.getByLabelText('Yeni poliçe numarası') as unknown as HTMLInputElement).value).toBe(
    'NEW-1',
  );
  expect(
    screen.queryByRole('checkbox', {
      name: 'Yeni poliçe oluşturulmasını ve kazanıldı sonucunu onaylıyorum',
    }),
  ).toBeNull();
  expect(writes(f)).toHaveLength(1);
});
it('never adopts replacement Task B after CREATE409', async () => {
  const f = fixture((u, i) =>
    i?.method === 'POST'
      ? response({}, 409)
      : u.startsWith('/api/policies?')
        ? response({ items: [], nextCursor: null, hasMore: false })
        : undefined,
  );
  f.read.mockResolvedValue({ current: { ...task, taskId: 'B' }, apply: vi.fn() });
  await fill();
  submit();
  await screen.findByText(/Kazanıldı kaydı çakıştı/);
  await waitFor(() =>
    expect(
      screen
        .getByRole('button', { name: 'Poliçe oluşturma bilgilerini karşılaştır' })
        .hasAttribute('disabled'),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Poliçe oluşturma bilgilerini karşılaştır' }));
  await screen.findByText(/replacement Task benimsenmedi/);
  expect(writes(f)).toHaveLength(1);
});
it('blocks catalog read failure while keeping decimal and policy-number drafts intact', async () => {
  let failed = false;
  const f = fixture((u) =>
    u === '/api/catalogs/selectable' && failed ? response({}, 503) : undefined,
  );
  await fill();
  failed = true;
  submit();
  await screen.findByText(/Taslak korunur; yeni gönderim kapalıdır/);
  expect((screen.getByLabelText('Brüt prim') as unknown as HTMLInputElement).value).toBe('1250.50');
  expect((screen.getByLabelText('Yeni poliçe numarası') as unknown as HTMLInputElement).value).toBe(
    'NEW-1',
  );
  expect(writes(f)).toHaveLength(0);
});
it('permits explicit integer installments only for a supporting payment method', async () => {
  const cats = {
    ...catalogs,
    paymentMethods: [
      ...catalogs.paymentMethods,
      { ...row, id: 'install', name: 'Taksitli', supportsInstallments: true, maxInstallments: 4 },
    ],
  };
  const f = fixture((u) => (u === '/api/catalogs/selectable' ? response(cats) : undefined));
  await fill();
  fireEvent.change(screen.getByLabelText('Ödeme yöntemi'), { target: { value: 'install' } });
  fireEvent.change(screen.getByLabelText('Taksit sayısı'), { target: { value: '5' } });
  fireEvent.click(screen.getByRole('button', { name: 'Yeni poliçeyi gözden geçir' }));
  expect(screen.queryByText(/İncelenen yeni poliçe/)).toBeNull();
  expect(writes(f)).toHaveLength(0);
  fireEvent.change(screen.getByLabelText('Taksit sayısı'), { target: { value: '4' } });
  fireEvent.click(screen.getByRole('button', { name: 'Yeni poliçeyi gözden geçir' }));
  await screen.findByText(/İncelenen yeni poliçe/);
  expect(writes(f)).toHaveLength(0);
});
it('suppresses an old catalog401 after component unmount', async () => {
  let resolve!: (r: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  const ended = vi.fn();
  document.addEventListener('mayi-session-ended', ended);
  try {
    const f = fixture((u) => (u === '/api/catalogs/selectable' ? promise : undefined));
    fireEvent.click(screen.getByRole('button', { name: 'Kazanıldı — yeni poliçe oluştur' }));
    f.view.unmount();
    resolve(response({}, 401));
    await promise;
    await new Promise((r) => setTimeout(r, 0));
    expect(ended).not.toHaveBeenCalled();
    expect(writes(f)).toHaveLength(0);
  } finally {
    document.removeEventListener('mayi-session-ended', ended);
  }
});
it('loads catalogs and completes CREATE under the application StrictMode effect lifecycle', async () => {
  const f = fixture(undefined, true);
  await fill();
  submit();
  await waitFor(() => expect(f.applied).toHaveBeenCalled());
  expect(writes(f)).toHaveLength(1);
});
