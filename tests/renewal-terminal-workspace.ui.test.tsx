import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { openWorkspaceSections } from './support/workspace-disclosures';
import TodayWorkPage from '../src/app/pages/today-work/TodayWorkPage';
import { installQuotePopBoundary } from '../src/app/pages/today-work/quote-navigation';
import { invalidateCsrfToken } from '../src/app/csrf';
import type { TodayTaskDto, TodayTasksResponseData } from '../src/shared/types';
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
const response = (data: unknown, status = 200) =>
  new Response(
    JSON.stringify(
      status < 400 ? { success: true, data } : { success: false, error: { code: 'FORBIDDEN' } },
    ),
    { status },
  );
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
beforeEach(() => invalidateCsrfToken());
function fixture(
  override?: (u: string, i?: RequestInit) => Response | Promise<Response> | undefined,
) {
  const fetcher = vi.fn(async (u: string, i?: RequestInit) => {
    const custom = override?.(u, i);
    if (custom) return custom;
    if (u.startsWith('/api/tasks/today')) return response(queue);
    if (u.endsWith('csrf-token')) return response({ token: 'csrf' });
    if (u === '/api/catalogs/selectable')
      return response({
        lossReasons: [{ id: 'price', code: 'PRICE', name: 'Fiyat', status: 'ACTIVE', version: 1 }],
        insurers: [],
        products: [],
        branches: [],
        paymentMethods: [],
      });
    if (u.endsWith('/interactions'))
      return response({
        interactions: [],
        lastContactAt: null,
        lastAttemptAt: null,
        customerType: 'INDIVIDUAL',
        companyContacts: [],
      });
    if (u.includes('/customers/c/renewals'))
      return response({ items: [{ id: 'r', state: 'LOST', version: 4 }], nextCursor: null });
    if (i?.method === 'POST')
      return response({
        renewalId: 'r',
        primaryTaskId: 't',
        previousState: 'CONTACT_PENDING',
        state: 'LOST',
        renewalVersion: 4,
        taskVersion: 8,
        closedAt: '2026-10-19T09:00:00.000Z',
        lossReasonId: 'price',
      });
    return response(null, 403);
  });
  vi.stubGlobal('fetch', fetcher);
  const view = render(
    <MemoryRouter>
      <TodayWorkPage owner />
    </MemoryRouter>,
  );
  return { fetcher, view };
}
async function select() {
  fireEvent.click(await screen.findByRole('button', { name: /Sentetik Müşteri/ }));
  openWorkspaceSections();
  await screen.findByRole('button', { name: 'Yenilenmedi olarak sonuçlandır' });
}
async function open() {
  fireEvent.click(screen.getByRole('button', { name: 'Yenilenmedi olarak sonuçlandır' }));
  await screen.findByRole('option', { name: 'Fiyat' });
}
function submit() {
  fireEvent.change(screen.getByLabelText('Kayıp nedeni'), { target: { value: 'price' } });
  fireEvent.click(screen.getByLabelText('Yenilenmedi sonucunu ve seçili nedeni onaylıyorum'));
  fireEvent.click(screen.getByRole('button', { name: 'Yenilenmedi olarak kaydet' }));
}
it('preserves a terminal draft through refresh prompt and blocks other workspace writes', async () => {
  fixture();
  await select();
  await open();
  fireEvent.change(screen.getByLabelText('Kayıp nedeni'), { target: { value: 'price' } });
  expect(screen.getByRole('button', { name: 'Yeni takip planını aç' }).matches(':disabled')).toBe(
    true,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Listeyi yenile' }));
  await screen.findByText('Hedefi değiştirmeden önce');
  fireEvent.click(screen.getByRole('button', { name: 'Bu ekranda kal' }));
  expect((screen.getByLabelText('Kayıp nedeni') as unknown as HTMLSelectElement).value).toBe(
    'price',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Bu sonuç taslağını açıkça kapat' }));
  expect(
    (screen.getByRole('button', { name: 'Yeni takip planını aç' }) as HTMLButtonElement).disabled,
  ).toBe(false);
});
it.each(['communication', 'task'])(
  'does not discard an existing %s draft when terminal action is opened',
  async (kind) => {
    fixture();
    await select();
    if (kind === 'communication') {
      fireEvent.click(screen.getByRole('button', { name: 'İletişim kaydı ekle' }));
      fireEvent.change(screen.getByLabelText('Görüşme sonucu'), { target: { value: 'NOTE' } });
      fireEvent.change(screen.getByLabelText('İç not'), { target: { value: 'Korunan taslak' } });
    } else {
      fireEvent.click(screen.getByRole('button', { name: 'Yeni takip planını aç' }));
      fireEvent.change(screen.getByLabelText('Yeni takip zamanı (İstanbul)'), {
        target: { value: '2099-01-01T12:00' },
      });
    }
    fireEvent.click(screen.getByRole('button', { name: 'Yenilenmedi olarak sonuçlandır' }));
    await screen.findByText(/Önce iletişim\/görev\/teklif taslağını/);
    expect(screen.queryByRole('form', { name: 'LOST sonuçlandırma' })).toBeNull();
    expect(
      (
        screen.getByLabelText(
          kind === 'communication' ? 'İç not' : 'Yeni takip zamanı (İstanbul)',
        ) as HTMLInputElement
      ).value,
    ).toBe(kind === 'communication' ? 'Korunan taslak' : '2099-01-01T12:00');
  },
);
it('keeps an unresolved terminal attempt through queue, task switch, sidebar, native POP and storage checks', async () => {
  const boundary = installQuotePopBoundary(),
    state = history.state;
  history.replaceState({ idx: 7 }, '');
  const go = vi.spyOn(history, 'go').mockImplementation(() => {}),
    link = document.createElement('a');
  link.href = '#elsewhere';
  document.body.appendChild(link);
  try {
    const f = fixture((_u, i) => (i?.method === 'POST' ? response(null, 503) : undefined));
    await select();
    await open();
    submit();
    await screen.findByRole('button', { name: 'Aynı LOST isteğini yeniden dene' });
    fireEvent.click(screen.getByRole('button', { name: 'Listeyi yenile' }));
    await screen.findByText(/Sonuçlandırma\/iletişim işleminin sonucu doğrulanmadan/);
    fireEvent.click(screen.getByRole('button', { name: 'Görev listesine dön' }));
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => {
      link.dispatchEvent(click);
    });
    expect(click.defaultPrevented).toBe(true);
    history.replaceState({ idx: 6 }, '');
    act(() => {
      dispatchEvent(new PopStateEvent('popstate', { state: { idx: 6 } }));
    });
    expect(go).toHaveBeenCalledWith(1);
    history.replaceState({ idx: 7 }, '');
    expect(screen.getByRole('button', { name: 'Aynı LOST isteğini yeniden dene' })).toBeTruthy();
    const writes = f.fetcher.mock.calls.filter(([, i]) => i?.method === 'POST');
    expect(writes).toHaveLength(1);
    const stored = JSON.stringify({ ...localStorage, ...sessionStorage, state: history.state });
    expect(stored).not.toContain(writes[0]![1]!.body as string);
    expect(stored).not.toContain(
      (writes[0]![1]!.headers as Record<string, string>)['idempotency-key'],
    );
  } finally {
    boundary();
    go.mockRestore();
    history.replaceState(state, '');
    link.remove();
  }
});
it('preserves original queue cursor provenance for later-page 409 comparison', async () => {
  const first = {
    ...task,
    taskId: 'first',
    renewalId: 'first-r',
    customerDisplayName: 'İlk Müşteri',
  };
  let conflict = false;
  const f = fixture((u, i) => {
    if (u === '/api/tasks/today?limit=20')
      return response({ ...queue, items: [first], hasMore: true, nextCursor: 'original-cursor' });
    if (u === '/api/tasks/today?limit=20&cursor=original-cursor')
      return response({
        ...queue,
        items: [{ ...task, ...(conflict ? { renewalVersion: 4, taskVersion: 8 } : {}) }],
      });
    if (i?.method === 'POST') {
      conflict = true;
      return response(null, 409);
    }
    return undefined;
  });
  fireEvent.click(await screen.findByRole('button', { name: 'Daha fazla iş yükle' }));
  await select();
  await open();
  submit();
  await screen.findByText(/Sonuçlandırma çakıştı/);
  fireEvent.click(screen.getByRole('button', { name: 'Güncel aynı hedefi karşılaştır' }));
  await screen.findByText(/Önceki yenileme\/görev: 3\/7; güncel: 4\/8/);
  expect(
    f.fetcher.mock.calls.filter(([u]) => u === '/api/tasks/today?limit=20&cursor=original-cursor'),
  ).toHaveLength(2);
  expect(f.fetcher.mock.calls.filter(([u]) => u === '/api/tasks/today?limit=20')).toHaveLength(1);
});
it('refreshes queue after verified closure, removes the old selected task and does not claim a task-detail GET', async () => {
  let closed = false;
  const f = fixture((u) => {
    if (u.startsWith('/api/customers/c/renewals')) {
      closed = true;
      return undefined;
    }
    if (u.startsWith('/api/tasks/today') && closed) return response({ ...queue, items: [] });
    return undefined;
  });
  await select();
  await open();
  submit();
  await screen.findByText(/sonucu kaydedildi ve yenileme kaydı kontrol edildi/);
  await screen.findByText('Bu kuyrukta gösterilecek takip bulunmuyor.');
  expect(screen.queryByRole('form', { name: 'LOST sonuçlandırma' })).toBeNull();
  expect(
    f.fetcher.mock.calls.filter(([u]) => /\/tasks\//.test(u) && !u.includes('today')),
  ).toHaveLength(0);
});
it('does not present an old terminal success banner as evidence for a newly selected task', async () => {
  let closed = false;
  fixture((u) => {
    if (u.startsWith('/api/customers/c/renewals')) {
      closed = true;
      return undefined;
    }
    if (u.startsWith('/api/tasks/today') && closed)
      return response({
        ...queue,
        items: [
          {
            ...task,
            taskId: 'next-t',
            renewalId: 'next-r',
            customerDisplayName: 'Sonraki Müşteri',
          },
        ],
      });
    return undefined;
  });
  await select();
  await open();
  submit();
  await screen.findByText(/sonucu kaydedildi ve yenileme kaydı kontrol edildi/);
  fireEvent.click(await screen.findByRole('button', { name: /Sonraki Müşteri/ }));
  expect(screen.queryByText(/sonucu kaydedildi ve yenileme kaydı kontrol edildi/)).toBeNull();
});
it('keeps WON dirty snapshot through queue refresh guard and disables LOST/VOIDED/task/quote operations', async () => {
  fixture((u) =>
    u === '/api/policies/p'
      ? response({
          id: 'p',
          agencyId: 'a',
          customerId: 'c',
          customer: { id: 'c' },
          insurerId: 'i',
          insurer: { id: 'i' },
          productId: 'product',
          product: { id: 'product' },
          status: 'ACTIVE',
          archivedAt: null,
          version: 1,
          grossPremiumMinor: 1000,
          currency: 'TRY',
          policyNumber: 'P-1',
          startDate: '2026-01-01',
          endDate: '2026-10-25',
        })
      : u.startsWith('/api/policies?')
        ? response({ items: [], nextCursor: null, hasMore: false })
        : undefined,
  );
  await select();
  fireEvent.click(screen.getByRole('button', { name: 'Kazanıldı — mevcut poliçeyi bağla' }));
  await screen.findByRole('combobox', { name: 'Bağlanacak mevcut poliçe' });
  await waitFor(() =>
    expect(screen.queryByText('WON işlemi veya yetkili okuma sürüyor…')).toBeNull(),
  );
  await act(async () => {
    await Promise.resolve();
  });
  expect(
    screen.getByRole('button', { name: 'Yenilenmedi olarak sonuçlandır' }).matches(':disabled'),
  ).toBe(true);
  expect(
    screen.getByRole('button', { name: 'Geçersiz olarak işaretle' }).matches(':disabled'),
  ).toBe(true);
  expect(screen.getByRole('button', { name: 'Yeni takip planını aç' }).matches(':disabled')).toBe(
    true,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Listeyi yenile' }));
  await screen.findByText('Hedefi değiştirmeden önce');
  fireEvent.click(screen.getByRole('button', { name: 'Bu ekranda kal' }));
  expect(screen.getByRole('form', { name: 'Yenilemede mevcut poliçe bağlama' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Kazanıldı taslağını açıkça kapat' }));
  expect(
    screen.getByRole('button', { name: 'Yenilenmedi olarak sonuçlandır' }).matches(':disabled'),
  ).toBe(false);
});
it.each(['communication', 'task', 'LOST', 'VOIDED'])(
  'opening WON never discards existing %s draft',
  async (kind) => {
    fixture();
    await select();
    if (kind === 'communication') {
      fireEvent.click(screen.getByRole('button', { name: 'İletişim kaydı ekle' }));
      fireEvent.change(screen.getByLabelText('Görüşme sonucu'), { target: { value: 'NOTE' } });
      fireEvent.change(screen.getByLabelText('İç not'), { target: { value: 'Korunan taslak' } });
    } else if (kind === 'task') {
      fireEvent.click(screen.getByRole('button', { name: 'Yeni takip planını aç' }));
      fireEvent.change(screen.getByLabelText('Yeni takip zamanı (İstanbul)'), {
        target: { value: '2099-01-01T12:00' },
      });
    } else if (kind === 'LOST') await open();
    else fireEvent.click(screen.getByRole('button', { name: 'Geçersiz olarak işaretle' }));
    fireEvent.click(screen.getByRole('button', { name: 'Kazanıldı — mevcut poliçeyi bağla' }));
    expect(screen.queryByRole('form', { name: 'Yenilemede mevcut poliçe bağlama' })).toBeNull();
    if (kind === 'communication')
      expect((screen.getByLabelText('İç not') as unknown as HTMLInputElement).value).toBe(
        'Korunan taslak',
      );
  },
);
it('keeps CREATE draft exclusive with LINK_POLICY and other terminal branches through refresh guard', async () => {
  fixture((u) =>
    u === '/api/catalogs/selectable'
      ? response({
          insurers: [{ id: 'i', name: 'I', status: 'ACTIVE', agencyId: 'a', version: 1 }],
          products: [],
          branches: [],
          paymentMethods: [],
          lossReasons: [],
        })
      : undefined,
  );
  await select();
  fireEvent.click(screen.getByRole('button', { name: 'Kazanıldı — yeni poliçe oluştur' }));
  await screen.findByRole('option', { name: 'I' });
  await act(async () => {
    await Promise.resolve();
  });
  fireEvent.change(screen.getByLabelText('Yeni poliçe numarası'), {
    target: { value: 'DRAFT-ONLY' },
  });
  expect(
    screen.getByRole('button', { name: 'Kazanıldı — mevcut poliçeyi bağla' }).matches(':disabled'),
  ).toBe(true);
  expect(
    screen.getByRole('button', { name: 'Yenilenmedi olarak sonuçlandır' }).matches(':disabled'),
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Listeyi yenile' }));
  await screen.findByText('Hedefi değiştirmeden önce');
  fireEvent.click(screen.getByRole('button', { name: 'Bu ekranda kal' }));
  expect((screen.getByLabelText('Yeni poliçe numarası') as unknown as HTMLInputElement).value).toBe(
    'DRAFT-ONLY',
  );
  fireEvent.click(
    screen.getByRole('button', { name: 'Yeni poliçeyle kazanma taslağını açıkça kapat' }),
  );
  expect(
    screen.getByRole('button', { name: 'Kazanıldı — mevcut poliçeyi bağla' }).matches(':disabled'),
  ).toBe(false);
});
