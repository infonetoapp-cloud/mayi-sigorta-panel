import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WonPolicyOperation } from '../src/app/pages/today-work/WonPolicyOperation';
import { invalidateCsrfToken } from '../src/app/csrf';
import type { PolicyDetailDto, TodayTaskDto } from '../src/shared/types';
const task: TodayTaskDto = {
  taskId: 't',
  renewalId: 'r',
  customerId: 'c',
  customerDisplayName: 'Sentetik',
  customerPhone: null,
  customerEmail: null,
  policyId: 'old',
  policyNumber: 'OLD',
  policyEndDate: '2026-10-25',
  title: 'Takip',
  dueAt: '2026-10-19T08:00:00.000Z',
  taskVersion: 7,
  renewalVersion: 3,
  assigneeMembershipId: 'self',
  renewalAssigneeMembershipId: 'self',
  renewalState: 'CONTACT_PENDING',
  bucket: 'TODAY',
  isUnassigned: false,
};
const policy = {
  id: 'new',
  agencyId: 'a',
  customerId: 'c',
  customer: { id: 'c', displayName: 'Sentetik' },
  insurerId: 'i',
  productId: 'p',
  branchId: 'b',
  insurer: { id: 'i', name: 'Sigorta', status: 'ACTIVE' },
  product: { id: 'p', name: 'Ürün', status: 'ACTIVE' },
  branch: { id: 'b', name: 'Branş', status: 'ACTIVE', dataClassification: 'GENERAL' },
  policyNumber: 'NEW',
  status: 'ACTIVE',
  archivedAt: null,
  version: 4,
  grossPremiumMinor: 10001,
  currency: 'TRY',
  startDate: '2026-10-26',
  endDate: '2027-10-25',
} as PolicyDetailDto;
const result = {
  renewalId: 'r',
  primaryTaskId: 't',
  previousState: 'CONTACT_PENDING',
  state: 'WON',
  renewalVersion: 4,
  taskVersion: 8,
  closedAt: '2026-10-19T09:00:00.000Z',
  createdPolicyId: null,
  acceptedQuoteVersionId: null,
  acceptedPolicyId: null,
  newPolicyIds: ['new'],
  linkIds: ['link'],
  links: [
    {
      id: 'link',
      newPolicyId: 'new',
      allocatedNewPremiumMinor: 10001,
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
) {
  const applied = vi.fn(),
    risk = vi.fn(),
    read = vi.fn(async () => ({ current: { ...task }, apply: vi.fn() }));
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const x = override?.(url, init);
    if (x) return x;
    if (url.endsWith('csrf-token')) return response({ token: 'csrf' });
    if (url === '/api/policies/old') return response({ ...policy, id: 'old', policyNumber: 'OLD' });
    if (url === '/api/policies/new') return response(policy);
    if (url.startsWith('/api/policies?'))
      return response({ items: [policy], nextCursor: null, hasMore: false });
    if (url.startsWith('/api/customers/c/renewals'))
      return response({ items: [{ id: 'r', state: 'WON', version: 4 }], nextCursor: null });
    if (url.endsWith('/quotes')) return response({ quotes: [], defaultVersion: {} });
    if (init?.method === 'POST') return response(result);
    throw Error(url);
  });
  vi.stubGlobal('fetch', fetcher);
  const view = render(
    <WonPolicyOperation
      task={task}
      read={read}
      canOperate={() => true}
      blocked={() => false}
      onRisk={risk}
      onApplied={applied}
    />,
  );
  return { fetcher, applied, risk, read, view };
}
async function choose() {
  fireEvent.click(screen.getByRole('button', { name: 'Kazanıldı — mevcut poliçeyi bağla' }));
  await screen.findByRole('option', { name: /NEW/ });
  fireEvent.change(screen.getByLabelText('Bağlanacak mevcut poliçe'), { target: { value: 'new' } });
  await screen.findByText(/Poliçe sürümü: 4/);
}
function confirm() {
  fireEvent.click(
    screen.getByLabelText('Seçilen poliçenin priminin tamamını bu yenilemeye tahsis ediyorum'),
  );
  fireEvent.click(screen.getByLabelText('Kazanıldı sonucunu ve seçtiğim kayıtları onaylıyorum'));
  fireEvent.click(screen.getByRole('button', { name: 'Yenilemeyi kazanıldı olarak kaydet' }));
}
const writes = (f: ReturnType<typeof fixture>) =>
  f.fetcher.mock.calls.filter(([, i]) => i?.method === 'POST');
it('requires independent full allocation and final confirmations; freezes exact task, dual CAS and full policy CAS then verifies authorized GETs', async () => {
  const f = fixture();
  await choose();
  fireEvent.click(screen.getByRole('button', { name: 'Yenilemeyi kazanıldı olarak kaydet' }));
  expect(writes(f)).toHaveLength(0);
  confirm();
  await waitFor(() => expect(f.applied).toHaveBeenCalledTimes(1));
  expect(JSON.parse(writes(f)[0]![1]!.body as string)).toEqual({
    expectedPrimaryTaskId: 't',
    expectedRenewalVersion: 3,
    expectedTaskVersion: 7,
    result: {
      kind: 'LINK_POLICY',
      newPolicyId: 'new',
      expectedPolicyVersion: 4,
      allocatedNewPremiumMinor: 10001,
      currency: 'TRY',
    },
  });
});
it('retries an ambiguous POST with exact body URL and key', async () => {
  let calls = 0;
  const f = fixture((_u, i) => {
    if (i?.method === 'POST' && ++calls === 1) throw Error('lost');
  });
  await choose();
  confirm();
  await screen.findByText(/Sonuç belirsiz/);
  fireEvent.click(screen.getByRole('button', { name: 'Aynı kazanıldı isteğini yeniden dene' }));
  await waitFor(() => expect(f.applied).toHaveBeenCalled());
  expect(writes(f)).toHaveLength(2);
  expect(writes(f)[0]![0]).toBe(writes(f)[1]![0]);
  expect(writes(f)[0]![1]!.body).toBe(writes(f)[1]![1]!.body);
  expect(writes(f)[0]![1]!.headers).toEqual(writes(f)[1]![1]!.headers);
});
it('does GET-only recovery after confirmed POST and an unreadable policy detail', async () => {
  let posted = false,
    fail = true;
  const f = fixture((u, i) => {
    if (i?.method === 'POST') posted = true;
    if (posted && u === '/api/policies/new' && fail) return response({}, 503);
  });
  await choose();
  confirm();
  await screen.findByText(/Başarı henüz doğrulanmadı/);
  expect(f.applied).not.toHaveBeenCalled();
  fail = false;
  fireEvent.click(screen.getByRole('button', { name: 'Yalnız kazanıldı sonucunu kontrol et' }));
  await waitFor(() => expect(f.applied).toHaveBeenCalled());
  expect(writes(f)).toHaveLength(1);
});
it.each([408, 429, 500, 503])(
  'keeps HTTP%s unresolved with exact retry rather than a definitive conflict',
  async (status) => {
    const f = fixture((_u, i) => (i?.method === 'POST' ? response({}, status) : undefined));
    await choose();
    confirm();
    await screen.findByText(/Sonuç belirsiz/);
    expect(
      screen.queryByRole('button', { name: 'Kazanılacak yenilemenin kayıtlarını karşılaştır' }),
    ).toBeNull();
    expect(
      screen
        .getByRole('button', { name: 'Kazanıldı taslağını açıkça kapat' })
        .hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Aynı kazanıldı isteğini yeniden dene' }));
    await waitFor(() => expect(writes(f)).toHaveLength(2));
    expect(writes(f)[1]![1]!.body).toBe(writes(f)[0]![1]!.body);
  },
);
it.each(['customer', 'self', 'archived', 'inactive', 'agency', 'version'])(
  'blocks invalid full policy detail %s before POST',
  async (kind) => {
    const f = fixture((u) =>
      u === '/api/policies/new'
        ? response({
            ...policy,
            ...(kind === 'customer'
              ? { customerId: 'other' }
              : kind === 'self'
                ? { id: 'old' }
                : kind === 'archived'
                  ? { archivedAt: '2026-01-01' }
                  : kind === 'inactive'
                    ? { status: 'VOIDED' }
                    : kind === 'agency'
                      ? { agencyId: 'other' }
                      : { version: 0 }),
          })
        : undefined,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Kazanıldı — mevcut poliçeyi bağla' }));
    await screen.findByRole('option', { name: /NEW/ });
    fireEvent.change(screen.getByLabelText('Bağlanacak mevcut poliçe'), {
      target: { value: 'new' },
    });
    await screen.findByText(/Seçilen poliçe uygun veya yetkili değil/);
    expect(writes(f)).toHaveLength(0);
  },
);
it.each(['task', 'renewal', 'policy', 'created', 'amount', 'currency', 'version', 'date'])(
  'never claims success for contradictory POST %s evidence',
  async (kind) => {
    const altered = {
      ...result,
      ...(kind === 'task'
        ? { primaryTaskId: 'B' }
        : kind === 'renewal'
          ? { renewalId: 'other' }
          : kind === 'policy'
            ? { newPolicyIds: ['other'] }
            : kind === 'created'
              ? { createdPolicyId: 'created' }
              : kind === 'version'
                ? { taskVersion: 99 }
                : kind === 'date'
                  ? { closedAt: 'bad' }
                  : {
                      links: [
                        {
                          ...result.links[0],
                          ...(kind === 'amount'
                            ? { allocatedNewPremiumMinor: 1 }
                            : { currency: 'USD' }),
                        },
                      ],
                    }),
    };
    const f = fixture((_u, i) => (i?.method === 'POST' ? response(altered) : undefined));
    await choose();
    confirm();
    await screen.findByText(/Başarı henüz doğrulanmadı/);
    expect(f.applied).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Yalnız kazanıldı sonucunu kontrol et' }));
    await waitFor(() => expect(writes(f)).toHaveLength(1));
  },
);
it('does not silently adopt replacement Task B after409 even with equal numeric versions', async () => {
  const f = fixture((_u, i) => (i?.method === 'POST' ? response({}, 409) : undefined));
  f.read.mockResolvedValue({ current: { ...task, taskId: 'B' }, apply: vi.fn() });
  await choose();
  confirm();
  await screen.findByText(/Kazanıldı kaydı çakıştı/);
  fireEvent.click(
    screen.getByRole('button', { name: 'Kazanılacak yenilemenin kayıtlarını karşılaştır' }),
  );
  await screen.findByText(/Başka görev seçilmedi/);
  expect(screen.queryByRole('button', { name: 'Aynı takip ile poliçeyi yeniden seç' })).toBeNull();
  expect(JSON.parse(writes(f)[0]![1]!.body as string).expectedPrimaryTaskId).toBe('t');
});
it('requires explicit same Task adoption then fresh policy selection and separate confirmations after409', async () => {
  let conflict = true;
  const f = fixture((_u, i) => (i?.method === 'POST' && conflict ? response({}, 409) : undefined));
  await choose();
  confirm();
  await screen.findByText(/Kazanıldı kaydı çakıştı/);
  fireEvent.click(
    screen.getByRole('button', { name: 'Kazanılacak yenilemenin kayıtlarını karşılaştır' }),
  );
  await screen.findByRole('button', { name: 'Aynı takip ile poliçeyi yeniden seç' });
  fireEvent.click(screen.getByRole('button', { name: 'Aynı takip ile poliçeyi yeniden seç' }));
  expect(
    screen.queryByLabelText('Kazanıldı sonucunu ve seçtiğim kayıtları onaylıyorum'),
  ).toBeNull();
  fireEvent.change(screen.getByLabelText('Bağlanacak mevcut poliçe'), { target: { value: 'new' } });
  await screen.findByText(/Poliçe sürümü: 4/);
  conflict = false;
  confirm();
  await waitFor(() => expect(f.applied).toHaveBeenCalled());
  expect((writes(f)[0]![1]!.headers as Record<string, string>)['idempotency-key']).not.toBe(
    (writes(f)[1]![1]!.headers as Record<string, string>)['idempotency-key'],
  );
});
const sentQuote = (premium = 10001) => ({
  id: 'q',
  status: 'SENT',
  version: 2,
  current_version_id: 'v',
  accepted_version_id: null,
  accepted_policy_id: null,
  versions: [
    {
      id: 'v',
      version_number: 1,
      product_id: 'p',
      insurer_id: 'i',
      branch_id: 'b',
      payment_method_id: 'm',
      start_date: policy.startDate,
      end_date: policy.endDate,
      valid_until: '2099-01-01T00:00:00.000Z',
      gross_premium_minor: premium,
      currency: 'TRY',
      installment_count: null,
      terms_summary: null,
    },
  ],
  events: [
    { id: 'e', event: 'SENT', quote_version_id: 'v', occurred_at: '2026-10-19T08:00:00.000Z' },
  ],
});
it.each([false, true])(
  'explicitly selects SENT and submits only the required difference reason (different: %s)',
  async (different) => {
    const q = sentQuote(different ? 9000 : 10001);
    let posted = false;
    const f = fixture((u, i) => {
      if (i?.method === 'POST') {
        posted = true;
        return response({ ...result, acceptedQuoteVersionId: 'v', acceptedPolicyId: 'new' });
      }
      if (u.endsWith('/quotes'))
        return response({
          quotes: [
            posted
              ? {
                  ...q,
                  status: 'ACCEPTED',
                  accepted_version_id: 'v',
                  accepted_policy_id: 'new',
                  events: [
                    ...q.events,
                    {
                      id: 'a',
                      event: 'ACCEPTED',
                      quote_version_id: 'v',
                      accepted_policy_id: 'new',
                      occurred_at: result.closedAt,
                    },
                  ],
                }
              : q,
          ],
        });
    });
    await choose();
    fireEvent.click(
      screen.getByRole('button', { name: 'İsteğe bağlı gönderildi kayıtlı teklifleri oku' }),
    );
    await screen.findByRole('option', { name: /Teklif 1 · Sürüm 1/ });
    expect(
      (screen.getByLabelText('İsteğe bağlı kabul edilecek teklif') as unknown as HTMLSelectElement)
        .value,
    ).toBe('');
    fireEvent.change(screen.getByLabelText('İsteğe bağlı kabul edilecek teklif'), {
      target: { value: 'v' },
    });
    if (different) {
      confirm();
      await screen.findByText(/Fark için sizin belirlediğiniz/);
      expect(writes(f)).toHaveLength(0);
      fireEvent.change(screen.getByLabelText('Teklif farkı neden kodu'), {
        target: { value: 'CUSTOMER_CONFIRMED' },
      });
      fireEvent.click(
        screen.getByLabelText('Kazanıldı sonucunu ve seçtiğim kayıtları onaylıyorum'),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Yenilemeyi kazanıldı olarak kaydet' }));
    } else confirm();
    await waitFor(() => expect(f.applied).toHaveBeenCalled());
    const b = JSON.parse(writes(f)[0]![1]!.body as string);
    expect(b.acceptedQuoteVersionId).toBe('v');
    expect(b.quoteDifferenceReasonCode).toBe(different ? 'CUSTOMER_CONFIRMED' : undefined);
  },
);
it('does not use an expired or noncurrent quote automatically', async () => {
  const q = sentQuote();
  q.versions[0]!.valid_until = '2020-01-01T00:00:00.000Z';
  const f = fixture((u) => (u.endsWith('/quotes') ? response({ quotes: [q] }) : undefined));
  await choose();
  fireEvent.click(
    screen.getByRole('button', { name: 'İsteğe bağlı gönderildi kayıtlı teklifleri oku' }),
  );
  await screen.findByLabelText('İsteğe bağlı kabul edilecek teklif');
  expect(screen.queryByRole('option', { name: /q \/ v1/ })).toBeNull();
  confirm();
  await waitFor(() => expect(f.applied).toHaveBeenCalled());
  expect(JSON.parse(writes(f)[0]![1]!.body as string).acceptedQuoteVersionId).toBeUndefined();
});
it('pins customer filtering, search and failed pagination cursor to exact list retry', async () => {
  let fails = true;
  const f = fixture((u) => {
    if (u.startsWith('/api/policies?')) {
      const p = new URL(u, 'https://local');
      expect(p.searchParams.get('customerId')).toBe('c');
      if (p.searchParams.get('cursor') === 'next')
        return fails
          ? response({}, 503)
          : response({ items: [], nextCursor: null, hasMore: false });
      return response({ items: [policy], nextCursor: 'next', hasMore: true });
    }
  });
  await choose();
  fireEvent.click(screen.getByRole('button', { name: 'Daha fazla poliçe' }));
  await screen.findByRole('button', { name: 'Poliçe listesini yeniden dene' });
  fails = false;
  fireEvent.click(screen.getByRole('button', { name: 'Poliçe listesini yeniden dene' }));
  await waitFor(() =>
    expect(screen.queryByRole('button', { name: 'Poliçe listesini yeniden dene' })).toBeNull(),
  );
  const calls = f.fetcher.mock.calls.filter(([u]) => u.includes('cursor=next'));
  expect(calls).toHaveLength(2);
  expect(calls[0]![0]).toBe(calls[1]![0]);
});
it.each([401, 200])(
  'suppresses a delayed policy detail HTTP%s after authority scope unmount',
  async (status) => {
    let resolve!: (r: Response) => void;
    const deferred = new Promise<Response>((r) => {
      resolve = r;
    });
    const f = fixture((u) => (u === '/api/policies/new' ? deferred : undefined));
    fireEvent.click(screen.getByRole('button', { name: 'Kazanıldı — mevcut poliçeyi bağla' }));
    await screen.findByRole('option', { name: /NEW/ });
    fireEvent.change(screen.getByLabelText('Bağlanacak mevcut poliçe'), {
      target: { value: 'new' },
    });
    f.view.unmount();
    resolve(response(policy, status));
    await deferred;
    await new Promise((r) => setTimeout(r, 0));
    expect(writes(f)).toHaveLength(0);
    expect(f.applied).not.toHaveBeenCalled();
  },
);
it('ends the active session on a live WON401 without interpreting it as an uncertain retry', async () => {
  const ended = vi.fn();
  document.addEventListener('mayi-session-ended', ended);
  try {
    const f = fixture((_u, i) => (i?.method === 'POST' ? response({}, 401) : undefined));
    await choose();
    confirm();
    await waitFor(() => expect(ended).toHaveBeenCalledTimes(1));
    expect(writes(f)).toHaveLength(1);
    expect(
      screen.queryByRole('button', { name: 'Aynı kazanıldı isteğini yeniden dene' }),
    ).toBeNull();
  } finally {
    document.removeEventListener('mayi-session-ended', ended);
  }
});
