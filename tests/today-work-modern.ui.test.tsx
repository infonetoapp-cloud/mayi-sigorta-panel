import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, act, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import TodayWorkPage from '../src/app/pages/today-work/TodayWorkPage';
import { AuthenticatedApp } from '../src/app/AuthenticatedApp';
import { Sidebar } from '../src/app/components/layout/Sidebar';
import type { TodayTaskDto, TodayTasksResponseData } from '../src/shared/types';
// Phase4A tests isolate browsing; the real operational child is covered by the4B suite.
vi.mock('../src/app/pages/today-work/RenewalInteractionsSection', () => ({
  RenewalInteractionsSection: () => null,
}));
const task = (id: string, bucket: TodayTaskDto['bucket'] = 'OVERDUE'): TodayTaskDto => ({
  taskId: id,
  renewalId: 'r-' + id,
  customerId: 'c-' + id,
  customerDisplayName: 'Müşteri ' + id,
  customerEmail: id + '@example.test',
  customerPhone: '+905551112233',
  policyId: null,
  policyNumber: null,
  policyEndDate: null,
  title: 'Takip ' + id,
  dueAt: '2026-10-17T21:10:00Z',
  assigneeMembershipId: 'member',
  taskVersion: 1,
  renewalVersion: 1,
  renewalAssigneeMembershipId: 'member',
  renewalState: 'CONTACT_PENDING',
  bucket,
  isUnassigned: false,
});
const base: TodayTasksResponseData = {
  items: [task('a'), task('b', 'TODAY'), task('c', 'UPCOMING')],
  unassignedItems: [{ ...task('u'), isUnassigned: true, assigneeMembershipId: null }],
  hasMore: true,
  nextCursor: 'work-2',
  unassignedHasMore: true,
  unassignedNextCursor: 'unassigned-2',
  canSeeUnassigned: true,
  canSeeReassignment: true,
  canAssign: true,
  timezone: 'Europe/Istanbul',
  now: '2026-10-17T21:30:00Z',
  todayLocalDate: '2026-10-18',
};
const response = (data: unknown, status = 200) =>
  new Response(
    JSON.stringify(
      status < 400
        ? { success: true, data }
        : { success: false, error: { code: 'FORBIDDEN', message: 'unsafe SQL' } },
    ),
    { status },
  );
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function mount(owner = true, key = 'first') {
  return render(
    <MemoryRouter>
      <TodayWorkPage key={key} owner={owner} />
    </MemoryRouter>,
  );
}
it('mounts the real today route and replaces private selection when the authenticated employee changes', async () => {
  let calls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      response(
        ++calls === 1
          ? base
          : {
              ...base,
              items: [task('employee-b')],
              unassignedItems: [],
              canSeeUnassigned: false,
              canSeeReassignment: false,
            },
      ),
    ),
  );
  const page = (email: string) => (
    <MemoryRouter initialEntries={['/today-work']}>
      <AuthenticatedApp
        session={{ state: 'NORMAL', email, isOwner: false }}
        busy={false}
        onLogout={() => {}}
        onReauth={() => {}}
        renderPassword={() => null}
        error=""
        reauth={null}
      />
    </MemoryRouter>
  );
  const view = render(page('employee-a@example.test'));
  fireEvent.click(await screen.findByRole('button', { name: /Müşteri a/ }));
  view.rerender(page('employee-b@example.test'));
  expect(screen.queryByText('a@example.test')).toBeNull();
  await screen.findByRole('button', { name: /Müşteri employee-b/ });
  expect(screen.queryByText('a@example.test')).toBeNull();
  expect(screen.getByRole('link', { name: 'Bugünkü İşler' }).getAttribute('aria-current')).toBe(
    'page',
  );
});
it('keeps today navigation active for the explicit legacy compatibility route', () => {
  render(
    <MemoryRouter initialEntries={['/today-work/legacy']}>
      <Sidebar
        owner
        collapsed={false}
        mobileOpen={false}
        onCollapse={() => {}}
        onClose={() => {}}
        sidebarRef={{ current: null }}
      />
    </MemoryRouter>,
  );
  expect(screen.getByRole('link', { name: 'Bugünkü İşler' }).getAttribute('aria-current')).toBe(
    'page',
  );
});
it('ends the current session when the reused statistics endpoint returns401', async () => {
  const ended = vi.fn();
  document.addEventListener('mayi-session-ended', ended);
  try {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('statistics') ? response(null, 401) : response(base),
      ),
    );
    mount();
    await screen.findByRole('button', { name: /Müşteri a/ });
    fireEvent.click(screen.getByRole('button', { name: 'Görev istatistiklerini göster' }));
    await screen.findByText(/Görev istatistikleri yüklenemedi/);
    expect(ended).toHaveBeenCalledOnce();
  } finally {
    document.removeEventListener('mayi-session-ended', ended);
  }
});
it('shows compact buckets and selects only loaded DTO data without a task detail fetch', async () => {
  const f = vi.fn(async () => response(base));
  vi.stubGlobal('fetch', f);
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /Müşteri a/ }));
  const overview = screen.getByRole('region', { name: 'Seçili görev özeti' });
  expect(within(overview).getByText('a@example.test')).toBeTruthy();
  expect(within(overview).getByText(/00:10/, { selector: 'dd' })).toBeTruthy();
  fireEvent.click(screen.getByText('Diğer yenileme işlemleri', { selector: 'summary' }));
  expect(screen.getByRole('link', { name: 'Klasik iş akışını aç' }).getAttribute('href')).toBe(
    '/today-work/legacy',
  );
  expect(f.mock.calls).toHaveLength(1);
});
it('keeps independent cursors and retries the exact failed page', async () => {
  let failed = false;
  const f = vi.fn(async (url: string) => {
    if (url.includes('cursor=work-2') && !failed) {
      failed = true;
      return response(null, 503);
    }
    if (url.includes('cursor=work-2'))
      return response({ ...base, items: [task('d')], hasMore: false, nextCursor: null });
    if (url.includes('unassignedCursor='))
      return response({
        ...base,
        unassignedItems: [{ ...task('u2'), isUnassigned: true }],
        unassignedHasMore: false,
        unassignedNextCursor: null,
      });
    return response(base);
  });
  vi.stubGlobal('fetch', f);
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Daha fazla iş yükle' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Aynı sayfayı yeniden dene' }));
  await screen.findByRole('button', { name: /Müşteri d/ });
  fireEvent.click(screen.getByRole('button', { name: 'Atanmamış işler' }));
  fireEvent.click(screen.getByRole('button', { name: 'Daha fazla iş yükle' }));
  await screen.findByRole('button', { name: /Müşteri u2/ });
  const urls = f.mock.calls.map(([u]) => u);
  expect(urls[1]).toBe(urls[2]);
  expect(urls.at(-1)).toContain('unassignedCursor=unassigned-2');
  expect(urls.at(-1)).not.toContain('cursor=work-2');
});
it.each([400, 401, 403, 404, 409])(
  'clears selected task, cached queues and statistics on invalidated/denied paging %i',
  async (status) => {
    const ended = vi.fn();
    document.addEventListener('mayi-session-ended', ended);
    try {
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) =>
          url.includes('cursor=') ? response(null, status) : response(base),
        ),
      );
      mount();
      fireEvent.click(await screen.findByRole('button', { name: /Müşteri a/ }));
      fireEvent.click(screen.getByRole('button', { name: 'Daha fazla iş yükle' }));
      await screen.findByRole('alert');
      expect(screen.queryByText('a@example.test')).toBeNull();
      expect(screen.queryByRole('button', { name: /Müşteri a/ })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Görev istatistiklerini göster' })).toBeNull();
      expect(document.body.textContent).not.toContain('unsafe SQL');
      expect(ended).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
    } finally {
      document.removeEventListener('mayi-session-ended', ended);
    }
  },
);
it('clears selection when changing queues and never selects an unloaded task or auto-reassigns history', async () => {
  const f = vi.fn(async (url: string) =>
    response(
      url.includes('needsReassignment=true')
        ? {
            ...base,
            items: [{ ...task('old'), needsReassignment: true, assigneeMembershipId: 'suspended' }],
          }
        : base,
    ),
  );
  vi.stubGlobal('fetch', f);
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /Müşteri a/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Atanmamış işler' }));
  expect(screen.queryByText('a@example.test')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Müşteri u/ }));
  expect(screen.getByText('u@example.test')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Yeniden atama gerekenler' }));
  await screen.findByRole('button', { name: /Müşteri old/ });
  expect(screen.queryByText('u@example.test')).toBeNull();
  expect(f.mock.calls.some(([url]) => url.includes('needsReassignment=true'))).toBe(true);
  expect(f.mock.calls.every(([url]) => url.startsWith('/api/tasks/today'))).toBe(true);
});
it('ignores late401 paging after queue change without clearing the current session or new selection', async () => {
  let release!: (r: Response) => void;
  const deferred = new Promise<Response>((resolve) => {
    release = resolve;
  });
  const ended = vi.fn();
  document.addEventListener('mayi-session-ended', ended);
  try {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => (url.includes('cursor=work-2') ? deferred : response(base))),
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Daha fazla iş yükle' }));
    fireEvent.click(screen.getByRole('button', { name: 'Atanmamış işler' }));
    fireEvent.click(screen.getByRole('button', { name: /Müşteri u/ }));
    await act(async () => release(response(null, 401)));
    expect(ended).not.toHaveBeenCalled();
    expect(screen.getByText('u@example.test')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
  } finally {
    document.removeEventListener('mayi-session-ended', ended);
  }
});
it('clears selection on refresh and retries the failed base URL, not an old next cursor', async () => {
  let initial = 0;
  const f = vi.fn(async (url: string) => {
    if (url.includes('cursor='))
      return response({ ...base, items: [task('later')], hasMore: false, nextCursor: null });
    return ++initial === 2 ? response(null, 503) : response(base);
  });
  vi.stubGlobal('fetch', f);
  mount();
  fireEvent.click(await screen.findByRole('button', { name: 'Daha fazla iş yükle' }));
  fireEvent.click(await screen.findByRole('button', { name: /Müşteri later/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Listeyi yenile' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Aynı sayfayı yeniden dene' }));
  await screen.findByRole('button', { name: /Müşteri a/ });
  expect(screen.queryByText('later@example.test')).toBeNull();
  expect(f.mock.calls[0]![0]).toBe(f.mock.calls.at(-1)![0]);
  expect(
    within(screen.getByRole('region', { name: 'Seçili görev özeti' })).getByText('Bir takip seçin'),
  ).toBeTruthy();
});
it('supports keyboard focus and switches selected overview without detail requests', async () => {
  const f = vi.fn(async () => response(base));
  vi.stubGlobal('fetch', f);
  mount();
  const a = await screen.findByRole('button', { name: /Müşteri a/ }),
    b = screen.getByRole('button', { name: /Müşteri b/ });
  a.focus();
  fireEvent.keyDown(a, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(b);
  fireEvent.click(b);
  await waitFor(() => expect(document.activeElement?.textContent).toBe('Müşteri b'));
  expect(screen.getByText('b@example.test')).toBeTruthy();
  fireEvent.click(a);
  expect(screen.queryByText('b@example.test')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Görev listesine dön' }));
  expect(screen.queryByText('a@example.test')).toBeNull();
  expect(f.mock.calls).toHaveLength(1);
});
it('does not offer privileged queues to a MEMBER even if unrelated capabilities appear', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response(base)),
  );
  mount(false);
  await screen.findByRole('button', { name: /Müşteri a/ });
  expect(screen.getByRole('button', { name: 'Kendi işlerim' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Atanmamış işler' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Yeniden atama gerekenler' })).toBeNull();
});
it('does not reuse old employee data or late errors after the session-keyed page is remounted', async () => {
  let release!: (r: Response) => void;
  const deferred = new Promise<Response>((resolve) => {
    release = resolve;
  });
  let requests = 0;
  const f = vi.fn(async (url: string) =>
    url.includes('cursor=')
      ? deferred
      : response(
          ++requests === 1
            ? base
            : {
                ...base,
                items: [task('employee-b')],
                canSeeUnassigned: false,
                canSeeReassignment: false,
                unassignedItems: [],
              },
        ),
  );
  vi.stubGlobal('fetch', f);
  const view = mount(false, 'employee-a');
  fireEvent.click(await screen.findByRole('button', { name: /Müşteri a/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Daha fazla iş yükle' }));
  view.rerender(
    <MemoryRouter>
      <TodayWorkPage key="employee-b" owner={false} />
    </MemoryRouter>,
  );
  expect(screen.queryByText('a@example.test')).toBeNull();
  await screen.findByRole('button', { name: /Müşteri employee-b/ });
  await act(async () => release(response(base)));
  expect(screen.queryByRole('button', { name: /Müşteri a/ })).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
});
const stats = (view: 'self' | 'team', canSeeTeam: boolean) => ({
  view,
  canSeeTeam,
  timezone: 'Europe/Istanbul',
  todayLocalDate: '2026-10-18',
  completionStart: '2026-09-18T21:00:00Z',
  now: base.now,
  summary: { overdue: 42, dueToday: 10, upcoming: 9, completedLast30Days: 8 },
  unassigned: null,
  employees: [],
  nextCursor: null,
});
it('uses server statistical totals rather than visible page counts and keeps MEMBER self-only', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      response(url.includes('statistics') ? stats('self', false) : base),
    ),
  );
  mount(false);
  await screen.findByRole('button', { name: /Müşteri a/ });
  fireEvent.click(screen.getByRole('button', { name: 'Görev istatistiklerini göster' }));
  await screen.findByText('42');
  expect(screen.queryByRole('button', { name: 'Ekip özeti' })).toBeNull();
  expect(screen.getByText('Kendi görev özetim')).toBeTruthy();
});
it('suppresses a late statistics401 after the statistics view is unmounted', async () => {
  let release!: (r: Response) => void;
  const deferred = new Promise<Response>((resolve) => {
    release = resolve;
  });
  let pending = false;
  const ended = vi.fn();
  document.addEventListener('mayi-session-ended', ended);
  try {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('statistics')) {
          pending = true;
          return deferred;
        }
        return response(base);
      }),
    );
    mount();
    await screen.findByRole('button', { name: /Müşteri a/ });
    fireEvent.click(screen.getByRole('button', { name: 'Görev istatistiklerini göster' }));
    await waitFor(() => expect(pending).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Görev istatistiklerini gizle' }));
    await act(async () => release(response(null, 401)));
    expect(ended).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  } finally {
    document.removeEventListener('mayi-session-ended', ended);
  }
});
