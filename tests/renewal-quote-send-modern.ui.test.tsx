import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within, act } from '@testing-library/react';
import { RenewalQuotesSection } from '../src/app/pages/today-work/RenewalQuotesSection';
import type {
  QuoteHistory,
  QuoteRecord,
  QuoteVersion,
} from '../src/app/pages/today-work/quote-model';
import { invalidateCsrfToken } from '../src/app/csrf';
import { MemoryRouter } from 'react-router';
import { openWorkspaceSections, openWorkspaceSection } from './support/workspace-disclosures';
import TodayWorkPage from '../src/app/pages/today-work/TodayWorkPage';
import { installQuotePopBoundary } from '../src/app/pages/today-work/quote-navigation';
import type { TodayTaskDto, TodayTasksResponseData } from '../src/shared/types';

const baseVersion: QuoteVersion = {
  id: 'v1',
  version_number: 1,
  insurer_id: 'i',
  product_id: 'p',
  product_name: 'Sentetik ürün',
  branch_id: 'b',
  payment_method_id: 'm',
  start_date: '2027-01-01',
  end_date: '2027-12-31',
  valid_until: '2099-01-01T09:00:00.000Z',
  gross_premium_minor: 12345,
  currency: 'TRY',
  installment_count: null,
  terms_summary: null,
};
const defaults = {
  insurerId: 'i',
  productId: 'p',
  branchId: 'b',
  paymentMethodId: 'm',
  startDate: baseVersion.start_date,
  endDate: baseVersion.end_date,
  validUntil: baseVersion.valid_until,
  grossPremiumMinor: 12345,
  currency: 'TRY',
  installmentCount: null,
  termsSummary: null,
};
const original = (): QuoteRecord => ({
  id: 'q',
  status: 'DRAFT',
  version: 7,
  current_version_id: 'v1',
  accepted_version_id: null,
  versions: [{ ...baseVersion }],
  events: [],
});
it('explains an expired draft without offering SENT or changing the persisted quote status', async () => {
  const q = original();
  q.versions[0]!.valid_until = '2020-01-01T09:00:00.000Z';
  fixture((url, init) =>
    /\/quotes(?:\?.*)?$/.test(url) && !init?.method
      ? response({ quotes: [q], defaultVersion: defaults })
      : undefined,
  );
  {
    const read = screen.queryByRole('button', { name: 'Teklif geçmişini aç' });
    if (read) fireEvent.click(read);
  }
  await screen.findByText(/Bu sürümün geçerliliği sona erdi/);
  expect(screen.queryByRole('button', { name: 'Teklifi gönderildi olarak kaydet' })).toBeNull();
  expect(screen.getByRole('row', { name: 'Teklif 1 güncel özet' }).textContent).toContain('Taslak');
  expect(screen.getByRole('button', { name: 'Teklif 1 için revizyon' })).toBeTruthy();
});
const response = (data: unknown, status = 200) =>
  new Response(
    JSON.stringify(
      status < 400
        ? { success: true, data }
        : { success: false, error: { code: 'FORBIDDEN', message: 'unsafe diagnostic' } },
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
  workspace = false,
) {
  let h: QuoteHistory = { quotes: [original()], defaultVersion: defaults };
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const custom = override?.(url, init);
    if (custom) return custom;
    if (url.startsWith('/api/tasks/today')) return response(queue);
    if (url.endsWith('/interactions'))
      return response({
        interactions: [],
        lastContactAt: null,
        lastAttemptAt: null,
        companyContacts: [],
        customerType: 'INDIVIDUAL',
      });
    if (url.endsWith('csrf-token')) return response({ token: 'csrf' });
    if (url === '/api/catalogs/selectable')
      return response({
        insurers: [{ id: 'i', name: 'Sentetik şirket', agencyId: 'a', status: 'ACTIVE' }],
        products: [
          {
            id: 'p',
            name: 'Sentetik ürün',
            insurerId: 'i',
            branchId: 'b',
            agencyId: 'a',
            status: 'ACTIVE',
          },
        ],
        branches: [{ id: 'b', name: 'Branş', agencyId: 'a', status: 'ACTIVE' }],
        paymentMethods: [
          {
            id: 'm',
            name: 'Peşin',
            agencyId: 'a',
            status: 'ACTIVE',
            supportsInstallments: false,
            maxInstallments: 1,
          },
        ],
      });
    if (init?.method) {
      expect(url).toBe('/api/renewals/r/quotes/q/send');
      const q = h.quotes.find((q) => q.id === 'q')!;
      h = {
        ...h,
        quotes: h.quotes.map((row) =>
          row.id !== 'q'
            ? row
            : {
                ...row,
                status: 'SENT',
                version: q.version + 1,
                events: [
                  ...row.events,
                  {
                    id: 'sent-event',
                    quote_version_id: 'v1',
                    event: 'SENT',
                    operation_receipt_id: 'send-op',
                    occurred_at: '2026-10-19T09:00:00.000Z',
                  },
                ],
              },
        ),
      };
      return response(
        {
          operationId: 'send-op',
          quoteId: 'q',
          quoteVersionId: 'v1',
          versionNumber: 1,
          status: 'SENT',
        },
        201,
      );
    }
    return response(h);
  });
  vi.stubGlobal('fetch', fetcher);
  const props = {
    renewalId: 'r',
    renewalVersion: 3,
    renewalOpen: true,
    canOperate: () => true,
    compareRenewal: vi.fn(async () => 3 as number | null),
    onRisk: vi.fn(),
  };
  const view = render(
    workspace ? (
      <MemoryRouter>
        <TodayWorkPage owner />
      </MemoryRouter>
    ) : (
      <RenewalQuotesSection {...props} />
    ),
  );
  return {
    ...view,
    props,
    fetcher,
    getHistory: () => h,
    setHistory: (value: QuoteHistory) => {
      h = value;
    },
  };
}
async function open() {
  if (screen.queryByRole('button', { name: 'Teklifler' })) openWorkspaceSection('Teklifler');
  {
    const read = screen.queryByRole('button', { name: 'Teklif geçmişini aç' });
    if (read) fireEvent.click(read);
  }
  fireEvent.click(await screen.findByRole('button', { name: 'Teklifi gönderildi olarak kaydet' }));
  const select = screen.getByLabelText('Gönderildi olarak kaydedilecek teklif ve güncel sürüm');
  expect((select as unknown as HTMLSelectElement).value).toBe('');
  fireEvent.change(select, { target: { value: 'q' } });
}
function submit() {
  fireEvent.click(
    screen.getByLabelText(
      'Seçili sürümü dış kanaldan ilettiğimi ve gönderildi kaydını onaylıyorum',
    ),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Gönderildi kaydını onayla' }));
}
const success = () => screen.findByText(/Gönderildi kaydı kaydedildi ve geçmişte doğrulandı/);
const task: TodayTaskDto = {
  taskId: 't',
  renewalId: 'r',
  customerId: 'c',
  customerDisplayName: 'Seçili Sentetik Müşteri',
  customerPhone: null,
  customerEmail: null,
  policyId: null,
  policyNumber: null,
  policyEndDate: null,
  title: 'Takip',
  dueAt: '2026-10-19T08:00:00.000Z',
  taskVersion: 1,
  renewalVersion: 3,
  assigneeMembershipId: 'self',
  renewalAssigneeMembershipId: 'self',
  renewalState: 'CONTACT_PENDING',
  bucket: 'TODAY',
  isUnassigned: false,
};
const queue: TodayTasksResponseData = {
  items: [task],
  unassignedItems: [],
  hasMore: false,
  nextCursor: null,
  unassignedHasMore: false,
  unassignedNextCursor: null,
  canSeeUnassigned: true,
  canSeeReassignment: true,
  canAssign: true,
  timezone: 'Europe/Istanbul',
  todayLocalDate: '2026-10-19',
  now: '2026-10-19T08:00:00.000Z',
};
it('requires explicit quote/version selection and confirmation, posts only CAS/version ID and verifies the receipt-bound SENT event', async () => {
  const view = fixture();
  await open();
  const form = screen.getByRole('form', { name: 'Gönderildi durum kaydı' });
  expect(form.textContent).toContain(
    'Bu işlem müşteriye otomatik mesaj göndermez. Teklifi başka bir kanaldan ilettiyseniz gönderildi olarak kaydedin.',
  );
  expect(form.textContent).toContain('Sentetik şirket');
  expect(form.textContent).toContain('Sentetik ürün');
  expect(form.textContent).toContain('123,45');
  expect(form.textContent).toContain('₺');
  fireEvent.click(within(form).getByRole('button', { name: 'Gönderildi kaydını onayla' }));
  expect(view.fetcher.mock.calls.filter(([, i]) => i?.method)).toHaveLength(0);
  submit();
  await success();
  const writes = view.fetcher.mock.calls.filter(([, i]) => i?.method);
  expect(writes).toHaveLength(1);
  expect(writes[0]![0]).toBe('/api/renewals/r/quotes/q/send');
  expect(JSON.parse(String(writes[0]![1]!.body))).toEqual({
    expectedQuoteVersion: 7,
    quoteVersionId: 'v1',
  });
  expect(writes[0]![1]!.headers).toMatchObject({
    'X-CSRF-Token': 'csrf',
    'Idempotency-Key': expect.any(String),
  });
  expect(view.getHistory().quotes[0]).toMatchObject({
    status: 'SENT',
    version: 8,
    current_version_id: 'v1',
  });
});
it('allows READY and keeps already SENT/ACCEPTED/REJECTED/EXPIRED records read-only for this operation', async () => {
  const view = fixture();
  view.setHistory({
    defaultVersion: defaults,
    quotes: [
      { ...original(), status: 'READY' },
      ...['SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED'].map((status, index) => ({
        ...original(),
        id: 'readonly-' + index,
        status,
      })),
    ],
  });
  await open();
  submit();
  await success();
  expect(view.fetcher.mock.calls.filter(([, i]) => i?.method)).toHaveLength(1);
});
it.each(['SENT', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'past-validity', 'missing-current'])(
  'does not offer a send operation for %s',
  async (state) => {
    const view = fixture(),
      q = original();
    if (state === 'past-validity') q.versions[0]!.valid_until = '2020-01-01T00:00:00.000Z';
    else if (state === 'missing-current') q.current_version_id = 'absent';
    else q.status = state;
    view.setHistory({ defaultVersion: defaults, quotes: [q] });
    {
      const read = screen.queryByRole('button', { name: 'Teklif geçmişini aç' });
      if (read) fireEvent.click(read);
    }
    await screen.findByRole('row', { name: 'Teklif 1 güncel özet' });
    expect(screen.queryByRole('button', { name: 'Teklifi gönderildi olarak kaydet' })).toBeNull();
    expect(view.fetcher.mock.calls.some(([, i]) => i?.method)).toBe(false);
  },
);
it('rejects expiry while the selected confirmation is open instead of refreshing the deadline', async () => {
  const view = fixture();
  await open();
  const clock = vi.spyOn(Date, 'now').mockReturnValue(Date.parse(baseVersion.valid_until) + 1);
  try {
    submit();
    await screen.findByText(/geçerlilik süresi doldu/);
    expect(view.fetcher.mock.calls.some(([, i]) => i?.method)).toBe(false);
  } finally {
    clock.mockRestore();
  }
});
it.each(['network', 408, 429, 503, 'malformed-success'])(
  'pins the exact original target/body/key after %s and prevents double submission',
  async (failure) => {
    let posts = 0;
    const view = fixture((_u, i) => {
      if (!i?.method || ++posts !== 1) return undefined;
      if (failure === 'network') return Promise.reject(new Error('unsafe transport details'));
      return response(
        failure === 'malformed-success' ? {} : null,
        typeof failure === 'number' ? failure : 201,
      );
    });
    await open();
    fireEvent.click(
      screen.getByLabelText(
        'Seçili sürümü dış kanaldan ilettiğimi ve gönderildi kaydını onaylıyorum',
      ),
    );
    const form = screen.getByRole('form', { name: 'Gönderildi durum kaydı' });
    fireEvent.submit(form);
    fireEvent.submit(form);
    await screen.findByRole('button', { name: 'Aynı gönderildi isteğini yeniden dene' });
    view.rerender(<RenewalQuotesSection {...view.props} renewalVersion={99} />);
    expect(screen.getByRole('button', { name: 'Yeni teklif' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Aynı gönderildi isteğini yeniden dene' }));
    await success();
    const writes = view.fetcher.mock.calls.filter(([, i]) => i?.method);
    expect(writes).toHaveLength(2);
    expect(writes[0]).toEqual(writes[1]);
    expect(document.body.textContent).not.toContain('unsafe transport details');
  },
);
it('replays a lost successful response without recording a second SENT event', async () => {
  let posts = 0;
  const result = {
    operationId: 'send-op',
    quoteId: 'q',
    quoteVersionId: 'v1',
    versionNumber: 1,
    status: 'SENT',
  };
  const view = fixture((_u, i) => {
    if (!i?.method) return undefined;
    if (++posts === 1) {
      view.setHistory({
        defaultVersion: defaults,
        quotes: [
          {
            ...original(),
            status: 'SENT',
            version: 8,
            events: [
              {
                id: 'sent-event',
                event: 'SENT',
                quote_version_id: 'v1',
                operation_receipt_id: 'send-op',
                occurred_at: '2026-10-19T09:00:00.000Z',
              },
            ],
          },
        ],
      });
      return response(null, 503);
    }
    return response(result);
  });
  await open();
  submit();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Aynı gönderildi isteğini yeniden dene' }),
  );
  await success();
  const writes = view.fetcher.mock.calls.filter(([, i]) => i?.method);
  expect(writes[0]).toEqual(writes[1]);
  expect(view.getHistory().quotes[0]!.events).toHaveLength(1);
});
it.each([
  'http',
  'missing-event',
  'wrong-event-version',
  'wrong-receipt',
  'wrong-event-kind',
  'duplicate-event',
  'wrong-quote',
  'wrong-version',
  'wrong-sequence',
  'wrong-insurer',
  'wrong-premium',
  'wrong-cas',
  'wrong-pointer',
  'wrong-status',
  'wrong-time',
])(
  'requires GET-only recovery after a confirmed POST with %s readback evidence',
  async (failure) => {
    let reads = 0;
    const view = fixture((u, i) => {
      if (u.split('?')[0] !== '/api/renewals/r/quotes' || i?.method || ++reads !== 2)
        return undefined;
      if (failure === 'http') return response(null, 503);
      const h = structuredClone(view.getHistory()),
        q = h.quotes[0]!,
        v = q.versions[0]!,
        event = q.events[0]!;
      if (failure === 'missing-event') q.events = [];
      if (failure === 'wrong-event-version') event.quote_version_id = 'other-v';
      if (failure === 'wrong-receipt') event.operation_receipt_id = 'other-op';
      if (failure === 'wrong-event-kind') event.event = 'ACCEPTED';
      if (failure === 'duplicate-event') q.events.push({ ...event, id: 'duplicate' });
      if (failure === 'wrong-quote') q.id = 'other-q';
      if (failure === 'wrong-version') v.id = 'other-v';
      if (failure === 'wrong-sequence') v.version_number = 2;
      if (failure === 'wrong-insurer') v.insurer_id = 'other-i';
      if (failure === 'wrong-premium') v.gross_premium_minor = 999;
      if (failure === 'wrong-cas') q.version = 7;
      if (failure === 'wrong-pointer') q.current_version_id = 'missing';
      if (failure === 'wrong-status') q.status = 'DRAFT';
      if (failure === 'wrong-time') event.occurred_at = 'invalid';
      return response(h);
    });
    await open();
    submit();
    const retry = await screen.findByRole('button', {
      name: 'Yalnız gönderildi kanıtını yeniden oku',
    });
    expect(screen.queryByText(/Gönderildi kaydı kaydedildi ve geçmişte doğrulandı/)).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Aynı gönderildi isteğini yeniden dene' }),
    ).toBeNull();
    fireEvent.click(retry);
    await success();
    expect(view.fetcher.mock.calls.filter(([, i]) => i?.method)).toHaveLength(1);
  },
);
it('preserves the historical SENT proof but reports the actual later DRAFT/current version', async () => {
  let reads = 0;
  const view = fixture((u, i) => {
    if (u.split('?')[0] !== '/api/renewals/r/quotes' || i?.method || ++reads !== 2)
      return undefined;
    const h = structuredClone(view.getHistory()),
      q = h.quotes[0]!;
    q.status = 'DRAFT';
    q.version = 9;
    q.current_version_id = 'v2';
    q.versions.push({ ...baseVersion, id: 'v2', version_number: 2, gross_premium_minor: 23456 });
    return response(h);
  });
  await open();
  submit();
  const message = await success();
  expect(message.textContent).toContain('güncel teklif durumu: Taslak');
  expect(message.textContent).toContain(
    'tarihsel beyan güncel sürümün gönderildiği anlamına gelmez',
  );
  expect(screen.getByRole('row', { name: 'Teklif 1 güncel özet' }).textContent).toContain('Taslak');
  expect(view.fetcher.mock.calls.filter(([, i]) => i?.method)).toHaveLength(1);
});
it.each(['quoteId', 'quoteVersionId', 'versionNumber', 'operationId', 'status'])(
  'does not accept inconsistent POST %s as success or switch targets',
  async (field) => {
    let posts = 0;
    const bad = {
      operationId: 'send-op',
      quoteId: 'q',
      quoteVersionId: 'v1',
      versionNumber: 1,
      status: 'SENT',
      [field]:
        field === 'versionNumber'
          ? 2
          : field === 'operationId'
            ? 'invalid operation'
            : field === 'status'
              ? 'DRAFT'
              : 'other',
    };
    const view = fixture((_u, i) => (i?.method && ++posts === 1 ? response(bad, 201) : undefined));
    await open();
    submit();
    fireEvent.click(
      await screen.findByRole('button', { name: 'Aynı gönderildi isteğini yeniden dene' }),
    );
    await success();
    const writes = view.fetcher.mock.calls.filter(([, i]) => i?.method);
    expect(writes[0]).toEqual(writes[1]);
  },
);
it('checks a well-formed returned operationId against the persisted event receipt rather than guessing it', async () => {
  let posts = 0;
  const view = fixture((_u, i) =>
    i?.method && ++posts === 1
      ? response(
          {
            operationId: 'different-valid-operation',
            quoteId: 'q',
            quoteVersionId: 'v1',
            versionNumber: 1,
            status: 'SENT',
          },
          201,
        )
      : undefined,
  );
  await open();
  submit();
  await screen.findByRole('button', { name: 'Yalnız gönderildi kanıtını yeniden oku' });
  expect(screen.queryByText(/Gönderildi kaydı kaydedildi ve geçmişte doğrulandı/)).toBeNull();
  expect(view.fetcher.mock.calls.filter(([, i]) => i?.method)).toHaveLength(1);
});
it('compares the pinned target after409 and requires explicit reconfirmation for a fresh same-version operation', async () => {
  let posts = 0;
  const view = fixture((_u, i) => (i?.method && ++posts === 1 ? response(null, 409) : undefined));
  await open();
  submit();
  await screen.findByRole('button', { name: 'Gönderildi kaydı için güncel teklifi karşılaştır' });
  view.setHistory({
    defaultVersion: defaults,
    quotes: [{ ...original(), version: 8, status: 'READY' }],
  });
  fireEvent.click(
    screen.getByRole('button', { name: 'Gönderildi kaydı için güncel teklifi karşılaştır' }),
  );
  await screen.findByRole('complementary', { name: 'Önceki ve güncel teklif karşılaştırması' });
  expect(
    (
      screen.getByLabelText(
        'Seçili sürümü dış kanaldan ilettiğimi ve gönderildi kaydını onaylıyorum',
      ) as HTMLInputElement
    ).checked,
  ).toBe(false);
  expect(view.fetcher.mock.calls.filter(([, i]) => i?.method)).toHaveLength(1);
  submit();
  await success();
  const writes = view.fetcher.mock.calls.filter(([, i]) => i?.method);
  expect(JSON.parse(String(writes[1]![1]!.body))).toEqual({
    expectedQuoteVersion: 8,
    quoteVersionId: 'v1',
  });
  expect(writes[0]![1]!.headers).not.toEqual(writes[1]![1]!.headers);
});
it.each(['new-version', 'SENT', 'ACCEPTED', 'missing-target'])(
  'does not silently retarget or resubmit after409 comparison shows %s',
  async (change) => {
    const view = fixture((_u, i) => (i?.method ? response(null, 409) : undefined));
    await open();
    submit();
    await screen.findByRole('button', { name: 'Gönderildi kaydı için güncel teklifi karşılaştır' });
    const q = { ...original(), version: 8 };
    if (change === 'new-version') {
      q.current_version_id = 'v2';
      q.versions.push({ ...baseVersion, id: 'v2', version_number: 2 });
    } else if (change === 'missing-target') q.id = 'other-q';
    else q.status = change;
    view.setHistory({ defaultVersion: defaults, quotes: [q] });
    fireEvent.click(
      screen.getByRole('button', { name: 'Gönderildi kaydı için güncel teklifi karşılaştır' }),
    );
    await screen.findByText(/Seçili sürüm artık güncel\/gönderilebilir değil/);
    expect(
      screen.getByRole('button', { name: 'Gönderildi kaydını onayla' }).hasAttribute('disabled'),
    ).toBe(true);
    expect(view.fetcher.mock.calls.filter(([, i]) => i?.method)).toHaveLength(1);
  },
);
it.each([400, 403, 404])(
  'preserves context after%i and hides protected selection on authority loss',
  async (status) => {
    const view = fixture((_u, i) => (i?.method ? response(null, status) : undefined));
    await open();
    submit();
    await screen.findByRole('alert');
    const form = screen.getByRole('form', { name: 'Gönderildi durum kaydı' });
    expect(document.body.textContent).not.toContain('unsafe diagnostic');
    if (status !== 400) {
      expect(form.textContent).not.toContain('123,45');
      expect(form.textContent).not.toContain('Sentetik ürün');
    }
    expect(view.fetcher.mock.calls.filter(([, i]) => i?.method)).toHaveLength(1);
  },
);
it.each(['csrf', 'post', 'readback', 'comparison'])(
  'ignores delayed %s401 after switching renewal and does not contaminate the next session/task',
  async (stage) => {
    let release!: (r: Response) => void,
      waiting = false,
      posts = 0,
      reads = 0;
    const delayed = new Promise<Response>((r) => {
        release = r;
      }),
      ended = vi.fn();
    document.addEventListener('mayi-session-ended', ended);
    try {
      const view = fixture((u, i) => {
        if (i?.method) {
          posts++;
          if (stage === 'comparison') return response(null, 409);
        }
        if (u.split('?')[0] === '/api/renewals/r/quotes' && !i?.method) reads++;
        if (
          (stage === 'csrf' && u.endsWith('csrf-token')) ||
          (stage === 'post' && i?.method) ||
          (stage === 'readback' &&
            u.split('?')[0] === '/api/renewals/r/quotes' &&
            !i?.method &&
            posts) ||
          (stage === 'comparison' &&
            u.split('?')[0] === '/api/renewals/r/quotes' &&
            !i?.method &&
            reads > 1)
        ) {
          waiting = true;
          return delayed;
        }
        return undefined;
      });
      await open();
      submit();
      if (stage === 'comparison')
        fireEvent.click(
          await screen.findByRole('button', {
            name: 'Gönderildi kaydı için güncel teklifi karşılaştır',
          }),
        );
      await waitFor(() => expect(waiting).toBe(true));
      view.rerender(<RenewalQuotesSection {...view.props} renewalId="other" />);
      await act(async () => release(response(null, 401)));
      expect(ended).not.toHaveBeenCalled();
      expect(screen.queryByRole('form')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
    } finally {
      document.removeEventListener('mayi-session-ended', ended);
    }
  },
);
it('clears previously displayed SENT proof details when quote history authority is revoked', async () => {
  let deny = false;
  fixture((u, i) =>
    deny && u.split('?')[0] === '/api/renewals/r/quotes' && !i?.method
      ? response(null, 403)
      : undefined,
  );
  await open();
  submit();
  await success();
  deny = true;
  const refresh = screen.getByRole('button', {
    name: 'Kayıtlı teklifleri yenile',
  });
  await waitFor(() => expect(refresh.hasAttribute('disabled')).toBe(false));
  fireEvent.click(refresh);
  await screen.findByText(/Teklif geçmişine erişilemiyor/);
  expect(screen.queryByText(/Gönderildi kaydı kaydedildi ve geçmişte doğrulandı/)).toBeNull();
});
it('preserves communication/task drafts and pins an unresolved SENT attempt through queue, sidebar and POP navigation', async () => {
  const removeBoundary = installQuotePopBoundary(),
    state = history.state;
  history.replaceState({ idx: 7 }, '');
  const go = vi.spyOn(history, 'go').mockImplementation(() => {}),
    link = document.createElement('a');
  link.href = '#other-page';
  document.body.appendChild(link);
  let posts = 0;
  try {
    const view = fixture(
      (_u, i) => (i?.method && ++posts === 1 ? response(null, 503) : undefined),
      true,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Seçili Sentetik Müşteri/ }));
    openWorkspaceSections();
    openWorkspaceSection('Teklifler');
    {
      const read = screen.queryByRole('button', { name: 'Teklif geçmişini aç' });
      if (read) fireEvent.click(read);
    }
    await screen.findByRole('button', { name: 'Teklifi gönderildi olarak kaydet' });
    openWorkspaceSection('İletişim');
    fireEvent.click(screen.getByRole('button', { name: 'İletişim kaydı ekle' }));
    fireEvent.change(screen.getByLabelText('Görüşme sonucu'), { target: { value: 'NOTE' } });
    fireEvent.change(screen.getByLabelText('İç not'), {
      target: { value: 'Korunan iletişim taslağı' },
    });
    if (screen.queryByRole('button', { name: 'Teklifler' })) openWorkspaceSection('Teklifler');
    fireEvent.click(screen.getByRole('button', { name: 'Teklifi gönderildi olarak kaydet' }));
    await screen.findByText(/İletişim\/görev taslağını açıkça kapatın/);
    expect(
      screen.queryByLabelText('Gönderildi olarak kaydedilecek teklif ve güncel sürüm'),
    ).toBeNull();
    expect((screen.getByLabelText('İç not') as HTMLTextAreaElement).value).toBe(
      'Korunan iletişim taslağı',
    );
    openWorkspaceSection('İletişim');
    fireEvent.click(screen.getByRole('button', { name: 'Formu kapat ve taslağı bırak' }));
    openWorkspaceSection('Teklifler');
    openWorkspaceSection('Görev işlemleri');
    fireEvent.click(screen.getByRole('button', { name: 'Yeni takip planını aç' }));
    fireEvent.change(screen.getByLabelText('Yeni takip zamanı (İstanbul)'), {
      target: { value: '2099-01-01T12:00' },
    });
    if (screen.queryByRole('button', { name: 'Teklifler' })) openWorkspaceSection('Teklifler');
    fireEvent.click(screen.getByRole('button', { name: 'Teklifi gönderildi olarak kaydet' }));
    expect((screen.getByLabelText('Yeni takip zamanı (İstanbul)') as HTMLInputElement).value).toBe(
      '2099-01-01T12:00',
    );
    expect(
      screen.queryByLabelText('Gönderildi olarak kaydedilecek teklif ve güncel sürüm'),
    ).toBeNull();
    openWorkspaceSection('Görev işlemleri');
    fireEvent.click(screen.getByRole('button', { name: 'Plan taslağını kapat' }));
    openWorkspaceSection('Teklifler');
    if (screen.queryByRole('button', { name: 'Teklifler' })) openWorkspaceSection('Teklifler');
    fireEvent.click(screen.getByRole('button', { name: 'Teklifi gönderildi olarak kaydet' }));
    fireEvent.change(
      screen.getByLabelText('Gönderildi olarak kaydedilecek teklif ve güncel sürüm'),
      { target: { value: 'q' } },
    );
    submit();
    await screen.findByRole('button', { name: 'Aynı gönderildi isteğini yeniden dene' });
    fireEvent.click(screen.getByRole('button', { name: 'Listeyi yenile' }));
    await screen.findByText(/Teklif işleminin belirsiz sonucu/);
    expect(screen.queryByText(/Klasik çalışma alanı/)).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Aynı gönderildi isteğini yeniden dene' }),
    ).toBeTruthy();
    const event = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => {
      link.dispatchEvent(event);
    });
    expect(event.defaultPrevented).toBe(true);
    history.replaceState({ idx: 6 }, '');
    act(() => {
      dispatchEvent(new PopStateEvent('popstate', { state: { idx: 6 } }));
    });
    expect(go).toHaveBeenCalledWith(1);
    history.replaceState({ idx: 7 }, '');
    expect(screen.getByRole('button', { name: 'Yeni teklif' }).hasAttribute('disabled')).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Aynı gönderildi isteğini yeniden dene' }));
    await success();
    const writes = view.fetcher.mock.calls.filter(([, i]) => i?.method);
    expect(writes).toHaveLength(2);
    expect(writes[0]).toEqual(writes[1]);
    const stored = JSON.stringify({ ...localStorage, ...sessionStorage });
    for (const [, i] of writes)
      expect(stored).not.toContain((i!.headers as Record<string, string>)['Idempotency-Key']);
  } finally {
    removeBoundary();
    go.mockRestore();
    history.replaceState(state, '');
    link.remove();
  }
});
it('blocks navigation during confirmed-write GET-only recovery without silently discarding its receipt target', async () => {
  let reads = 0;
  const view = fixture(
    (u, i) =>
      u.split('?')[0] === '/api/renewals/r/quotes' && !i?.method && ++reads === 2
        ? response(null, 503)
        : undefined,
    true,
  );
  fireEvent.click(await screen.findByRole('button', { name: /Seçili Sentetik Müşteri/ }));
  openWorkspaceSections();
  await open();
  submit();
  await screen.findByRole('button', { name: 'Yalnız gönderildi kanıtını yeniden oku' });
  fireEvent.click(screen.getByRole('button', { name: 'Görev listesine dön' }));
  await screen.findByText(/Teklif işleminin belirsiz sonucu/);
  expect(
    screen.queryByRole('button', { name: 'Aynı gönderildi isteğini yeniden dene' }),
  ).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Yalnız gönderildi kanıtını yeniden oku' }));
  await success();
  expect(view.fetcher.mock.calls.filter(([, i]) => i?.method)).toHaveLength(1);
});
it.each(['post', 'readback'])(
  'ignores late %s success after changing the selected renewal',
  async (stage) => {
    let release!: (r: Response) => void,
      waiting = false,
      posts = 0;
    const delayed = new Promise<Response>((r) => {
      release = r;
    });
    const view = fixture((u, i) => {
      if (i?.method) posts++;
      if (
        (stage === 'post' && i?.method) ||
        (stage === 'readback' &&
          u.split('?')[0] === '/api/renewals/r/quotes' &&
          !i?.method &&
          posts)
      ) {
        waiting = true;
        return delayed;
      }
      return undefined;
    });
    await open();
    submit();
    await waitFor(() => expect(waiting).toBe(true));
    view.rerender(<RenewalQuotesSection {...view.props} renewalId="other" />);
    await act(async () =>
      release(
        response(
          stage === 'post'
            ? {
                operationId: 'send-op',
                quoteId: 'q',
                quoteVersionId: 'v1',
                versionNumber: 1,
                status: 'SENT',
              }
            : view.getHistory(),
          201,
        ),
      ),
    );
    expect(screen.queryByText(/Gönderildi kaydı kaydedildi ve geçmişte doğrulandı/)).toBeNull();
    expect(screen.queryByRole('form')).toBeNull();
  },
);
it('preserves an open Phase4D quote-editing draft and blocks SENT until it is explicitly closed', async () => {
  const view = fixture();
  {
    const read = screen.queryByRole('button', { name: 'Teklif geçmişini aç' });
    if (read) fireEvent.click(read);
  }
  fireEvent.click(await screen.findByRole('button', { name: 'Yeni teklif' }));
  fireEvent.change(screen.getByLabelText('Teklif koşulları'), {
    target: { value: 'Korunan teklif taslağı' },
  });
  const sent = screen.getByRole('button', { name: 'Teklifi gönderildi olarak kaydet' });
  expect(sent.hasAttribute('disabled')).toBe(true);
  fireEvent.click(sent);
  expect(
    screen.queryByLabelText('Gönderildi olarak kaydedilecek teklif ve güncel sürüm'),
  ).toBeNull();
  expect((screen.getByLabelText('Teklif koşulları') as HTMLTextAreaElement).value).toBe(
    'Korunan teklif taslağı',
  );
  expect(view.fetcher.mock.calls.some(([, i]) => i?.method)).toBe(false);
});
it('updates the displayed current state after a later authorized refresh without losing historical SENT proof', async () => {
  const view = fixture();
  await open();
  submit();
  await success();
  const h = structuredClone(view.getHistory()),
    q = h.quotes[0]!;
  q.status = 'DRAFT';
  q.version = 9;
  q.current_version_id = 'v2';
  q.events = [];
  h.historyMode = 'SUMMARY';
  q.versionCount = 2;
  h.hasMore = false;
  h.nextCursor = null;
  q.versions.push({ ...baseVersion, id: 'v2', version_number: 2 });
  view.setHistory(h);
  const refresh = screen.getByRole('button', {
    name: 'Kayıtlı teklifleri yenile',
  });
  await waitFor(() => expect(refresh.hasAttribute('disabled')).toBe(false));
  fireEvent.click(refresh);
  openPriceHistory();
  await screen.findByText('Güncel fiyat');
  expect((await success()).textContent).toContain('güncel teklif durumu: Taslak');
  expect(view.fetcher.mock.calls.filter(([, i]) => i?.method)).toHaveLength(1);
});
it.each(['quote-draft', 'sent-draft', 'sent-unresolved'])(
  'preserves %s and blocks Phase4F terminal outcomes',
  async (kind) => {
    fixture(
      (_u, i) => (kind === 'sent-unresolved' && i?.method ? response(null, 503) : undefined),
      true,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Seçili Sentetik Müşteri/ }));
    openWorkspaceSections();
    openWorkspaceSection('Teklifler');
    {
      const read = screen.queryByRole('button', { name: 'Teklif geçmişini aç' });
      if (read) fireEvent.click(read);
    }
    await screen.findByRole('button', { name: 'Teklifi gönderildi olarak kaydet' });
    if (kind === 'quote-draft') {
      fireEvent.click(screen.getByRole('button', { name: 'Yeni teklif' }));
      fireEvent.change(screen.getByLabelText('Teklif koşulları'), {
        target: { value: 'Korunan Phase4F taslağı' },
      });
    } else {
      if (screen.queryByRole('button', { name: 'Teklifler' })) openWorkspaceSection('Teklifler');
      fireEvent.click(screen.getByRole('button', { name: 'Teklifi gönderildi olarak kaydet' }));
      fireEvent.change(
        screen.getByLabelText('Gönderildi olarak kaydedilecek teklif ve güncel sürüm'),
        { target: { value: 'q' } },
      );
      if (kind === 'sent-unresolved') {
        submit();
        await screen.findByRole('button', { name: 'Aynı gönderildi isteğini yeniden dene' });
      }
    }
    openWorkspaceSection('Yenileme sonucu');
    fireEvent.click(screen.getByRole('button', { name: 'Yenilenmedi olarak sonuçlandır' }));
    await screen.findByText(/Önce iletişim\/görev\/teklif taslağını/);
    expect(screen.queryByRole('form', { name: 'LOST sonuçlandırma' })).toBeNull();
    if (kind === 'quote-draft')
      expect((screen.getByLabelText('Teklif koşulları') as HTMLTextAreaElement).value).toBe(
        'Korunan Phase4F taslağı',
      );
    else {
      openWorkspaceSection('Teklifler');
      expect(screen.getByRole('form', { name: 'Gönderildi durum kaydı' }).textContent).toContain(
        '123,45',
      );
      if (kind === 'sent-unresolved')
        expect(
          screen.getByRole('button', { name: 'Aynı gönderildi isteğini yeniden dene' }),
        ).toBeTruthy();
    }
  },
);

function openPriceHistory() {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', {
    configurable: true,
    value: function (this: HTMLDialogElement) {
      this.open = true;
    },
  });
  fireEvent.click(screen.getAllByRole('button', { name: /Fiyat geçmişi/ })[0]!);
}
