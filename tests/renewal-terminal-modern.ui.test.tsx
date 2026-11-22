import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

import { RenewalOutcomesSection } from '../src/app/pages/today-work/RenewalOutcomesSection';

import { invalidateCsrfToken } from '../src/app/csrf';

import type { TodayTaskDto } from '../src/shared/types';

const task: TodayTaskDto = {
  taskId: 't',

  renewalId: 'r',

  customerId: 'c',

  customerDisplayName: 'Sentetik Müşteri',

  customerPhone: null,

  customerEmail: null,

  policyId: 'p',

  policyNumber: 'P-1',

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

const response = (data: unknown, status = 200) =>
  new Response(
    JSON.stringify(
      status < 400
        ? { success: true, data }
        : { success: false, error: { code: 'FORBIDDEN', message: 'unsafe diagnostic' } },
    ),

    { status },
  );

const reason = (id = 'price', code = 'PRICE', status = 'ACTIVE') => ({
  id,

  code,

  status,

  name: code === 'OTHER' ? 'Diğer' : 'Fiyat',

  version: 1,
});

const result = (state = 'LOST') => ({
  renewalId: 'r',

  primaryTaskId: 't',

  previousState: 'CONTACT_PENDING',

  state,

  renewalVersion: 4,

  taskVersion: 8,

  closedAt: '2026-10-19T09:00:00.000Z',

  ...(state === 'LOST' ? { lossReasonId: 'price' } : { voidReasonCode: 'TECHNICAL_ERROR' }),
});

afterEach(() => {
  cleanup();

  vi.unstubAllGlobals();
});

beforeEach(() => invalidateCsrfToken());

function fixture(
  override?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined,

  canOperate = () => true,

  cycleEnabled = false,
) {
  const read = vi.fn(async () => ({ current: { ...task }, apply: vi.fn() })),
    applied = vi.fn(),
    risk = vi.fn();

  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const custom = override?.(url, init);

    if (custom) return custom;

    if (url.endsWith('csrf-token')) return response({ token: 'csrf' });

    if (url === '/api/catalogs/selectable')
      return response({ lossReasons: [reason(), reason('other', 'OTHER')] });

    if (url.startsWith('/api/customers/c/renewals'))
      return response({ items: [{ id: 'r', state: 'LOST', version: 4 }], nextCursor: null });

    if (init?.method === 'POST') return response(result());

    throw new Error('Unexpected ' + url);
  });

  vi.stubGlobal('fetch', fetcher);

  const view = render(
    <RenewalOutcomesSection
      task={task}

      cycleEnabled={cycleEnabled}

      read={read}

      canOperate={canOperate}

      onRisk={risk}

      onApplied={applied}
    />,
  );

  return { fetcher, read, applied, risk, view };
}

const form = () => screen.getByRole('form', { name: 'LOST sonuçlandırma' });

async function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Yenilenmedi olarak sonuçlandır' }));

  await screen.findByRole('option', { name: 'Fiyat' });
}

function submit(id = 'price') {
  fireEvent.change(within(form()).getByLabelText('Kayıp nedeni'), { target: { value: id } });

  fireEvent.click(
    within(form()).getByLabelText('Yenilenmedi sonucunu ve seçili nedeni onaylıyorum'),
  );

  fireEvent.click(within(form()).getByRole('button', { name: 'Yenilenmedi olarak kaydet' }));
}

const writes = (f: ReturnType<typeof fixture>) =>
  f.fetcher.mock.calls.filter(([, i]) => i?.method === 'POST');

it('uses staff-facing Turkish for the loss confirmation while preserving exact internal targets', async () => {
  fixture();

  await open();

  expect(screen.getByRole('button', { name: 'Yenilenmedi olarak kaydet' })).toBeTruthy();

  expect(screen.getByLabelText('Yenilenmedi sonucunu ve seçili nedeni onaylıyorum')).toBeTruthy();
});

it('opens without writes and requires a reason and separate confirmation, pins both CAS and verifies authorized renewal state', async () => {
  const f = fixture();

  await open();

  expect(writes(f)).toHaveLength(0);

  fireEvent.click(within(form()).getByRole('button', { name: 'Yenilenmedi olarak kaydet' }));

  expect(writes(f)).toHaveLength(0);

  expect(form().textContent).toContain('P-1');

  expect(form().textContent).not.toContain('Görev sürümü:');

  expect(form().textContent).not.toContain('Yenileme sürümü:');

  submit();

  await waitFor(() => expect(f.applied).toHaveBeenCalledTimes(1));

  expect(writes(f)).toHaveLength(1);

  expect(writes(f)[0]![0]).toBe('/api/renewals/r/close-lost');

  expect(JSON.parse(writes(f)[0]![1]!.body as string)).toEqual({
    expectedPrimaryTaskId: 't',

    expectedRenewalVersion: 3,

    expectedTaskVersion: 7,

    lossReasonId: 'price',

    lossReasonNotes: null,
  });

  expect(f.applied.mock.calls[0]![0]).toContain('Yenilenmedi sonucu kaydedildi');
});

it('requires OTHER trimmed note and caps 500', async () => {
  const f = fixture((_url, init) =>
    init?.method === 'POST' ? response({ ...result(), lossReasonId: 'other' }) : undefined,
  );

  await open();

  submit('other');

  await screen.findByText(/1–500 karakter açıklama gerekir/);

  expect(writes(f)).toHaveLength(0);

  fireEvent.change(screen.getByLabelText('Diğer kayıp açıklaması'), {
    target: { value: '  Açık neden  ' },
  });

  fireEvent.click(screen.getByLabelText('Yenilenmedi sonucunu ve seçili nedeni onaylıyorum'));

  fireEvent.click(screen.getByRole('button', { name: 'Yenilenmedi olarak kaydet' }));

  await waitFor(() => expect(f.applied).toHaveBeenCalledTimes(1));

  expect(JSON.parse(writes(f)[0]![1]!.body as string).lossReasonNotes).toBe('Açık neden');
});

it.each(['TECHNICAL_ERROR', 'DUPLICATE', 'NOT_ELIGIBLE_AFTER_CANCELLATION_OR_RESTRUCTURE'])(
  'uses only exact VOIDED fields for %s',

  async (code) => {
    const f = fixture((url, init) =>
      init?.method === 'POST'
        ? response({ ...result('VOIDED'), voidReasonCode: code })
        : url.startsWith('/api/customers')
          ? response({ items: [{ id: 'r', state: 'VOIDED', version: 4 }], nextCursor: null })
          : undefined,
    );

    fireEvent.click(screen.getByRole('button', { name: 'Geçersiz olarak işaretle' }));

    const p = screen.getByRole('form', { name: 'VOIDED sonuçlandırma' });

    expect(within(p).queryByRole('textbox')).toBeNull();

    expect(p.textContent).toContain('Müşteri geçerli bir teklifi reddettiyse Yenilenmedi');

    fireEvent.change(within(p).getByLabelText('Geçersizlik nedeni'), { target: { value: code } });

    fireEvent.click(within(p).getByLabelText('Geçersiz sonucunu ve seçili nedeni onaylıyorum'));

    fireEvent.click(within(p).getByRole('button', { name: 'Geçersiz olarak kaydet' }));

    await waitFor(() => expect(f.applied).toHaveBeenCalledTimes(1));

    expect(writes(f)[0]![0]).toBe('/api/renewals/r/void');

    expect(JSON.parse(writes(f)[0]![1]!.body as string)).toEqual({
      expectedPrimaryTaskId: 't',

      expectedRenewalVersion: 3,

      expectedTaskVersion: 7,

      voidReasonCode: code,
    });

    expect(f.fetcher.mock.calls.some(([u]) => u.includes('catalogs'))).toBe(false);
  },
);

it('blocks stale/inactive reasons without changing the selection', async () => {
  let stale = false;

  const f = fixture((url) =>
    url === '/api/catalogs/selectable' && stale
      ? response({ lossReasons: [reason('other', 'OTHER')] })
      : undefined,
  );

  await open();

  fireEvent.change(screen.getByLabelText('Kayıp nedeni'), { target: { value: 'price' } });

  stale = true;

  fireEvent.click(screen.getByLabelText('Yenilenmedi sonucunu ve seçili nedeni onaylıyorum'));

  fireEvent.click(screen.getByRole('button', { name: 'Yenilenmedi olarak kaydet' }));

  await screen.findByText(/Seçilen kayıp nedeni değişti veya pasif/);

  expect(writes(f)).toHaveLength(0);

  expect((screen.getByLabelText('Kayıp nedeni') as unknown as HTMLSelectElement).value).toBe(
    'price',
  );
});

it('blocks unavailable catalogs and preserves the draft through safe reload', async () => {
  let fail = false;

  const f = fixture((url) =>
    url === '/api/catalogs/selectable' && fail ? response(null, 503) : undefined,
  );

  await open();

  fireEvent.change(screen.getByLabelText('Kayıp nedeni'), { target: { value: 'other' } });

  fireEvent.change(screen.getByLabelText('Diğer kayıp açıklaması'), {
    target: { value: 'Taslak' },
  });

  fail = true;

  fireEvent.click(screen.getByLabelText('Yenilenmedi sonucunu ve seçili nedeni onaylıyorum'));

  fireEvent.click(screen.getByRole('button', { name: 'Yenilenmedi olarak kaydet' }));

  await screen.findByText(/Kayıp nedenleri okunamadı/);

  expect(writes(f)).toHaveLength(0);

  expect((screen.getByLabelText('Diğer kayıp açıklaması') as HTMLTextAreaElement).value).toBe(
    'Taslak',
  );

  fail = false;

  fireEvent.click(screen.getByRole('button', { name: 'Kayıp nedenlerini yeniden oku' }));

  await screen.findByRole('option', { name: 'Diğer' });

  expect(
    (screen.getByLabelText('Yenilenmedi sonucunu ve seçili nedeni onaylıyorum') as HTMLInputElement)
      .checked,
  ).toBe(false);
});

it.each([503, 408, 429])(
  'freezes ambiguous HTTP%s URL/method/body/key and prevents concurrent terminal submissions',

  async (status) => {
    let fail = true;

    const f = fixture((_u, i) =>
      i?.method === 'POST' && fail ? response(null, status) : undefined,
    );

    await open();

    submit();

    await screen.findByText(/Sonuç belirsiz/);

    expect(
      (screen.getByRole('button', { name: 'Geçersiz olarak işaretle' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    expect(f.risk.mock.calls.at(-1)![0]).toEqual({ dirty: true, unresolved: true });

    fail = false;

    fireEvent.click(screen.getByRole('button', { name: 'Aynı LOST isteğini yeniden dene' }));

    await waitFor(() => expect(f.applied).toHaveBeenCalledTimes(1));

    expect(writes(f)).toHaveLength(2);

    expect(writes(f)[1]![0]).toBe(writes(f)[0]![0]);

    for (const field of ['method', 'body', 'headers'] as const)
      expect(writes(f)[1]![1]![field]).toEqual(writes(f)[0]![1]![field]);
  },
);

it.each([403, 503])(
  'keeps confirmed writes GET-only when independent customer renewals read returns %s',

  async (status) => {
    let fail = true;

    const f = fixture((url) =>
      url.startsWith('/api/customers') && fail ? response(null, status) : undefined,
    );

    await open();

    submit();

    await screen.findByText(/Kayıt kabul edildi; yenilemenin güncel sonucu/);

    expect(writes(f)).toHaveLength(1);

    expect(f.applied).not.toHaveBeenCalled();

    fail = false;

    fireEvent.click(screen.getByRole('button', { name: 'Yalnız yenileme okumasını yeniden dene' }));

    await waitFor(() => expect(f.applied).toHaveBeenCalledTimes(1));

    expect(writes(f)).toHaveLength(1);
  },
);

it.each([
  { renewalId: 'wrong' },

  { primaryTaskId: 'wrong' },

  { state: 'VOIDED' },

  { renewalVersion: 99 },

  { taskVersion: 99 },

  { closedAt: '2026-10-19' },

  { lossReasonId: 'other' },

  { previousState: 'WRONG' },

  null,
])(
  'does not fabricate success or repeat POST after contradictory accepted proof %j',

  async (change) => {
    const f = fixture((_u, i) =>
      i?.method === 'POST' ? response(change ? { ...result(), ...change } : null) : undefined,
    );

    await open();

    submit();

    await screen.findByText(/Kayıt kabul edildi ancak sonuç bilgileri eksik/);

    expect(f.applied).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole('button', { name: 'Yalnız yenileme okumasını yeniden dene' }));

    await waitFor(() =>
      expect(f.fetcher.mock.calls.filter(([u]) => u.startsWith('/api/customers'))).toHaveLength(2),
    );

    expect(writes(f)).toHaveLength(1);

    expect(f.applied).not.toHaveBeenCalled();
  },
);

it.each([
  { state: 'CONTACT_PENDING', version: 3 },

  { state: 'VOIDED', version: 4 },

  { state: 'LOST', version: 5 },
])('rejects contradictory current readback %j', async (current) => {
  const f = fixture((url) =>
    url.startsWith('/api/customers')
      ? response({ items: [{ id: 'r', ...current }], nextCursor: null })
      : undefined,
  );

  await open();

  submit();

  await screen.findByText(/sonuç bilgileri eksik veya tutarsız/);

  expect(f.applied).not.toHaveBeenCalled();

  expect(writes(f)).toHaveLength(1);
});

it('uses genuine raw customer renewal cursors for bounded later-page readback', async () => {
  const f = fixture((url) =>
    url === '/api/customers/c/renewals?limit=50'
      ? response({ items: [{ id: 'earlier', state: 'LOST', version: 2 }], nextCursor: 'earlier' })
      : undefined,
  );

  await open();

  submit();

  await waitFor(() => expect(f.applied).toHaveBeenCalledTimes(1));

  expect(
    f.fetcher.mock.calls.some(([u]) => u === '/api/customers/c/renewals?limit=50&cursor=earlier'),
  ).toBe(true);
});

it('bounds cyclic or missing renewal evidence and offers GET-only retry', async () => {
  const f = fixture((url) =>
    url.startsWith('/api/customers')
      ? response({ items: [{ id: 'earlier', state: 'LOST', version: 2 }], nextCursor: 'earlier' })
      : undefined,
  );

  await open();

  submit();

  await screen.findByText(/yenilemenin güncel sonucu henüz okunamadı/);

  expect(f.fetcher.mock.calls.filter(([u]) => u.startsWith('/api/customers'))).toHaveLength(2);

  expect(f.applied).not.toHaveBeenCalled();
});

it('compares dual CAS after 409, adopts only the explicit same target and reconfirms with a new key', async () => {
  let conflict = true;

  const f = fixture((_u, i) =>
    i?.method === 'POST'
      ? conflict
        ? response(null, 409)
        : response({ ...result(), renewalVersion: 5, taskVersion: 9 })
      : _u.startsWith('/api/customers')
        ? response({ items: [{ id: 'r', state: 'LOST', version: 5 }], nextCursor: null })
        : undefined,
  );

  await open();

  submit();

  await screen.findByText(/Sonuçlandırma çakıştı/);

  f.read.mockResolvedValue({
    current: { ...task, renewalVersion: 4, taskVersion: 8 },

    apply: vi.fn(),
  });

  fireEvent.click(screen.getByRole('button', { name: 'Güncel aynı hedefi karşılaştır' }));

  await screen.findByText(/Önceki yenileme\/görev: 3\/7; güncel: 4\/8/);

  expect(writes(f)).toHaveLength(1);

  fireEvent.click(screen.getByRole('button', { name: 'Güncel aynı hedefi benimse' }));

  expect(
    (screen.getByLabelText('Yenilenmedi sonucunu ve seçili nedeni onaylıyorum') as HTMLInputElement)
      .checked,
  ).toBe(false);

  conflict = false;

  fireEvent.click(screen.getByLabelText('Yenilenmedi sonucunu ve seçili nedeni onaylıyorum'));

  fireEvent.click(screen.getByRole('button', { name: 'Yenilenmedi olarak kaydet' }));

  await waitFor(() => expect(f.applied).toHaveBeenCalledTimes(1));

  expect(JSON.parse(writes(f)[1]![1]!.body as string)).toMatchObject({
    expectedPrimaryTaskId: 't',

    expectedRenewalVersion: 4,

    expectedTaskVersion: 8,
  });

  expect((writes(f)[1]![1]!.headers as Record<string, string>)['idempotency-key']).not.toBe(
    (writes(f)[0]![1]!.headers as Record<string, string>)['idempotency-key'],
  );
});

it('never silently switches to a replacement primary task on 409 comparison', async () => {
  const f = fixture((_u, i) => (i?.method === 'POST' ? response(null, 409) : undefined));

  await open();

  submit();

  await screen.findByText(/Sonuçlandırma çakıştı/);

  f.read.mockResolvedValue({ current: { ...task, taskId: 'replacement' }, apply: vi.fn() });

  fireEvent.click(screen.getByRole('button', { name: 'Güncel aynı hedefi karşılaştır' }));

  await screen.findByText(/Başka birincil göreve geçilmedi/);

  expect(screen.queryByRole('button', { name: 'Güncel aynı hedefi benimse' })).toBeNull();

  expect(writes(f)).toHaveLength(1);
});

it.each(['LOST', 'VOIDED'])(
  'keeps the original %s task identity when a replacement has exactly the same numeric versions',

  async (kind) => {
    const f = fixture((_u, i) => (i?.method === 'POST' ? response(null, 409) : undefined));

    if (kind === 'LOST') {
      await open();

      submit();
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'Geçersiz olarak işaretle' }));

      fireEvent.change(screen.getByLabelText('Geçersizlik nedeni'), {
        target: { value: 'DUPLICATE' },
      });

      fireEvent.click(screen.getByLabelText('Geçersiz sonucunu ve seçili nedeni onaylıyorum'));

      fireEvent.click(screen.getByRole('button', { name: 'Geçersiz olarak kaydet' }));
    }

    await screen.findByText(/Sonuçlandırma çakıştı/);

    const originalBody = writes(f)[0]![1]!.body;

    expect(JSON.parse(originalBody as string)).toMatchObject({
      expectedPrimaryTaskId: 't',

      expectedRenewalVersion: 3,

      expectedTaskVersion: 7,
    });

    f.read.mockResolvedValue({ current: { ...task, taskId: 'replacement' }, apply: vi.fn() });

    fireEvent.click(screen.getByRole('button', { name: 'Güncel aynı hedefi karşılaştır' }));

    await screen.findByText(/Başka birincil göreve geçilmedi/);

    expect(screen.queryByRole('button', { name: 'Güncel aynı hedefi benimse' })).toBeNull();

    expect(writes(f)).toHaveLength(1);

    expect(writes(f)[0]![1]!.body).toBe(originalBody);

    expect(JSON.parse(String(originalBody)).expectedPrimaryTaskId).toBe('t');

    expect(screen.getByRole('form', { name: `${kind} sonuçlandırma` }).textContent).not.toContain(
      'r / t',
    );
  },
);

it.each([401, 403, 404])(
  'masks details after authority denial %s and does not echo raw diagnostics',

  async (status) => {
    const f = fixture((_u, i) => (i?.method === 'POST' ? response(null, status) : undefined));

    await open();

    submit();

    await screen.findByText(/korunan hedef ayrıntıları gizlendi/);

    expect(within(form()).queryByText('Sentetik Müşteri')).toBeNull();

    expect(screen.queryByText(/unsafe diagnostic/)).toBeNull();

    expect(f.applied).not.toHaveBeenCalled();
  },
);

it.each([200, 401])(
  'ignores late mutation status %s after unmount without applying stale queue changes',

  async (status) => {
    let resolve!: (r: Response) => void;

    const promise = new Promise<Response>((r) => {
      resolve = r;
    });

    const f = fixture((_u, i) => (i?.method === 'POST' ? promise : undefined));

    await open();

    submit();

    await waitFor(() => expect(writes(f)).toHaveLength(1));

    f.view.unmount();

    resolve(response(result(), status));

    await promise;

    expect(f.applied).not.toHaveBeenCalled();
  },
);

it('does not erase an open outcome draft when its action is clicked again', async () => {
  fixture();

  await open();

  fireEvent.change(screen.getByLabelText('Kayıp nedeni'), { target: { value: 'other' } });

  fireEvent.change(screen.getByLabelText('Diğer kayıp açıklaması'), {
    target: { value: 'Korunacak açıklama' },
  });

  fireEvent.click(screen.getByRole('button', { name: 'Yenilenmedi olarak sonuçlandır' }));

  expect((screen.getByLabelText('Diğer kayıp açıklaması') as HTMLTextAreaElement).value).toBe(
    'Korunacak açıklama',
  );
});

it('saves renewal loss and the selected next-cycle date in one POST and reads exact evidence', async () => {
  const cycle = {
    operationId: '00000000-0000-4000-8000-000000000001',

    caseId: 'case',

    caseVersion: 3,

    resultRevisionId: 'revision',

    taskId: 't',

    taskVersion: 8,

    closedAt: result().closedAt,

    followup: {
      caseId: 'child',

      caseVersion: 1,

      taskId: 'child-task',

      taskVersion: 1,

      dueAt: '2028-01-30T06:00:00.000Z',

      cycleDate: '2028-02-29',

      dateBasis: 'KNOWN_END_DATE',
    },
  };

  const f = fixture(
    (url, init) => {
      if (url.endsWith('cycle-context?mode=close'))
        return response({
          renewalId: 'r',

          renewalVersion: 3,

          taskId: 't',

          taskVersion: 7,

          salesCycle: { caseId: 'case', expectedCaseVersion: 2, canCreateFollowup: true },
        });

      if (url.includes('/loss-operations/')) return response(cycle);

      if (init?.method === 'POST') return response({ ...result(), salesCycle: cycle });
    },

    () => true,

    true,
  );

  await open();

  fireEvent.change(screen.getByLabelText('Bilinen sonraki poliçe bitişi (isteğe bağlı)'), {
    target: { value: '2028-02-29' },
  });

  fireEvent.change(screen.getByLabelText('Takip zamanı · İstanbul'), {
    target: { value: '2028-01-30T09:00' },
  });

  submit();

  await waitFor(() => expect(f.applied).toHaveBeenCalledOnce());

  expect(writes(f)).toHaveLength(1);

  expect(JSON.parse(String(writes(f)[0]![1]?.body))).toMatchObject({
    expectedPrimaryTaskId: 't',

    salesCycle: {
      caseId: 'case',

      expectedCaseVersion: 2,

      notes: null,

      nextCycle: {
        mode: 'FOLLOW_UP',

        cycleDate: '2028-02-29',

        dateBasis: 'KNOWN_END_DATE',

        dueAt: '2028-01-30T06:00:00.000Z',
      },
    },
  });

  expect(f.fetcher.mock.calls.some(([url]) => url.includes('/loss-operations/'))).toBe(true);
});
