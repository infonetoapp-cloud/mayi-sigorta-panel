import { afterEach, expect, it, vi } from 'vitest';
import './support/workspace-disclosures';
import { cleanup, fireEvent, render, screen, waitFor, act, within } from '@testing-library/react';
import { MemoryRouter, Routes, Route } from 'react-router';
import { WorkNavigationProvider, ReturnToWork } from '../src/app/pages/today-work/work-navigation';
import TodayWorkPage from '../src/app/pages/today-work/TodayWorkPage';
import { AuthenticatedApp } from '../src/app/AuthenticatedApp';
import { Sidebar } from '../src/app/components/layout/Sidebar';
import type { TodayTaskDto, TodayTasksResponseData } from '../src/shared/types';
// Phase4A tests isolate browsing; the real operational child is covered by the4B suite.
vi.mock('../src/app/pages/today-work/RenewalInteractionsSection', () => ({
  RenewalInteractionsSection: () => null,
}));
vi.mock('../src/app/pages/today-work/RenewalQuotesSection', () => ({
  RenewalQuotesSection: () => null,
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
it('renders a mixed daily page and filters policy-free work by its real branch without opening renewal controls', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      response({
        ...base,
        items: [
          ...base.items,
          {
            kind: 'GENERAL',
            caseId: 'real-case',
            taskId: 'real-general',
            customerId: 'c-new',
            customerDisplayName: 'Poliçesiz yeni müşteri',
            branchName: 'Kasko',
            title: 'Teklif çalışması',
            dueAt: '2027-01-10T06:00:00.000Z',
            taskVersion: 1,
            assigneeMembershipId: 'member',
            bucket: 'UPCOMING',
            isUnassigned: false,
          },
        ],
      }),
    ),
  );
  mount(false);
  const link = await screen.findByRole('link', { name: 'Poliçesiz yeni müşteri' });
  expect(link.getAttribute('href')).toBe('/sales-cases/real-case');
  fireEvent.change(screen.getByLabelText('Yüklü takiplerde ara'), { target: { value: 'Kasko' } });
  expect(screen.getByRole('link', { name: 'İşi aç ›' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Müşteri a/ })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Poliçelendir' })).toBeNull();
});
it('restores a GENERAL daily return with its search, time filter and loaded page context', async () => {
  const general = {
    kind: 'GENERAL',
    caseId: null,
    taskId: 'general-return',
    customerId: 'return-customer',
    customerDisplayName: 'Genel müşteri',
    branchName: null,
    title: 'Müşteriyi ara',
    dueAt: '2027-01-10T06:00:00.000Z',
    taskVersion: 1,
    assigneeMembershipId: 'member',
    bucket: 'UPCOMING',
    isUnassigned: false,
  };
  const reads = vi.fn(async () =>
    response({ ...base, items: [...base.items, general], hasMore: false, nextCursor: null }),
  );
  vi.stubGlobal('fetch', reads);
  render(
    <MemoryRouter initialEntries={['/today-work']}>
      <WorkNavigationProvider>
        <Routes>
          <Route path="/today-work" element={<TodayWorkPage owner={false} />} />
          <Route
            path="/tasks/:taskId"
            element={
              <>
                <h1>Gerçek genel takip</h1>
                <ReturnToWork fallback />
              </>
            }
          />
        </Routes>
      </WorkNavigationProvider>
    </MemoryRouter>,
  );
  await screen.findByRole('link', { name: 'Genel müşteri' });
  fireEvent.change(screen.getByLabelText('Yüklü takiplerde ara'), {
    target: { value: 'Genel müşteri' },
  });
  fireEvent.change(screen.getByLabelText('Takip zamanı'), { target: { value: 'UPCOMING' } });
  fireEvent.click(screen.getByRole('link', { name: 'İşi aç ›' }));
  await screen.findByRole('heading', { name: 'Gerçek genel takip' });
  const back = screen.getByRole('link', { name: 'Seçili takibe dön' });
  expect(back.getAttribute('href')).toContain('task=general-return');
  fireEvent.click(back);
  await screen.findByRole('link', { name: 'Genel müşteri' });
  expect((screen.getByLabelText('Yüklü takiplerde ara') as HTMLInputElement).value).toBe(
    'Genel müşteri',
  );
  expect(
    screen.getByLabelText('Takip zamanı').querySelector('option:checked')?.getAttribute('value'),
  ).toBe('UPCOMING');
  expect(screen.queryByRole('button', { name: /Müşteri a/ })).toBeNull();
  expect(reads.mock.calls.length).toBeGreaterThan(1);
});
it('moves keyboard focus across general and renewal rows in their visible order', async () => {
  const general = {
    ...task('g', 'TODAY'),
    kind: 'GENERAL',
    caseId: null,
    branchName: null,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      response({
        ...base,
        items: [base.items[2], general, base.items[0]],
      }),
    ),
  );
  mount(false);
  const first = await screen.findByRole('button', { name: 'Müşteri a Takip a' });
  const between = screen.getByRole('link', { name: 'Müşteri g' });
  const last = screen.getByRole('button', { name: 'Müşteri c Takip c' });
  first.focus();
  fireEvent.keyDown(first, { key: 'ArrowDown' });
  expect(document.activeElement).toBe(between);
  fireEvent.keyDown(between, { key: 'End' });
  expect(document.activeElement).toBe(last);
  fireEvent.keyDown(last, { key: 'Home' });
  expect(document.activeElement).toBe(first);
});
it('mounts the real today route and replaces private selection when the authenticated employee changes', async () => {
  let calls = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.startsWith('/api/tasks/a/context')
        ? response(null, 404)
        : response(
            ++calls === 1
              ? base
              : {
                  ...base,
                  items: [task('employee-b')],
                  unassignedItems: [],
                  unassignedHasMore: false,
                  unassignedNextCursor: null,
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
it('redirects old daily-work addresses into the single current workspace', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response(base)),
  );
  render(
    <MemoryRouter initialEntries={['/today-work/legacy']}>
      <AuthenticatedApp
        session={{ state: 'NORMAL', email: 'synthetic@example.invalid', isOwner: true }}
        busy={false}
        onLogout={() => {}}
        onReauth={() => {}}
        renderPassword={() => null}
        error=""
        reauth={null}
      />
    </MemoryRouter>,
  );
  await screen.findByRole('heading', { name: 'Bugünkü İşler' });
  expect(screen.queryByText(/klasik çalışma alanı/i)).toBeNull();
  expect(screen.queryByText(/Modern iş kuyruğuna dön/)).toBeNull();
  await screen.findByRole('button', { name: /Müşteri a/ });
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
    fireEvent.click(screen.getByRole('button', { name: 'İş yükü özeti' }));
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
  expect(screen.queryByRole('button', { name: 'Diğer yenileme işlemleri' })).toBeNull();
  expect(screen.queryByRole('link', { name: /Klasik/ })).toBeNull();
  expect(f.mock.calls).toHaveLength(1);
});
it('uses one unified cursor and retries the exact failed page', async () => {
  let failed = false;
  const f = vi.fn(async (url: string) => {
    if (url.includes('cursor=work-2') && !failed) {
      failed = true;
      return response({
        ...base,
        items: [{ ...task('malformed'), taskVersion: 'bad-version' }],
        hasMore: false,
        nextCursor: null,
      });
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
  fireEvent.click(await screen.findByRole('button', { name: /Müşteri a/ }));
  fireEvent.click(await screen.findByRole('button', { name: 'Daha fazla iş yükle' }));
  const retry = await screen.findByRole('button', { name: 'Aynı sayfayı yeniden dene' });
  expect(screen.getByText('a@example.test')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Müşteri malformed/ })).toBeNull();
  fireEvent.click(retry);
  await screen.findByRole('button', { name: /Müşteri d/ });
  const urls = f.mock.calls.map(([u]) => u);
  expect(urls[1]).toBe(urls[2]);
  expect(urls.at(-1)).toContain('cursor=work-2');
  expect(urls.every((url) => url.includes('unified=true'))).toBe(true);
  expect(screen.queryByText('Ekip işlemleri')).toBeNull();
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
it('shows assigned and unassigned work together without team selectors or automatic reassignment', async () => {
  const f = vi.fn(async () =>
    response({ ...base, items: [...base.items, ...base.unassignedItems] }),
  );
  vi.stubGlobal('fetch', f);
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /Müşteri a/ }));
  expect(screen.queryByRole('button', { name: 'Atanmamış işler' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Yeniden atama gerekenler' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Müşteri u/ }));
  expect(screen.getByText('u@example.test')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Görev işlemleri' }));
  expect(screen.getByRole('button', { name: 'Yeni takip planını aç' })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Görev atama seçeneklerini aç' })).toBeNull();
  expect(screen.queryByText(/Görev atanmamış durumda/)).toBeNull();
  expect(f).toHaveBeenCalledTimes(1);
});
it('ignores late401 paging after refresh without clearing the current session or new selection', async () => {
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
    fireEvent.click(screen.getByRole('button', { name: 'Listeyi yenile' }));
    fireEvent.click(await screen.findByRole('button', { name: /Müşteri b/ }));
    await act(async () => release(response(null, 401)));
    expect(ended).not.toHaveBeenCalled();
    expect(screen.getByText('b@example.test')).toBeTruthy();
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
it('filters only the loaded authorized queue without additional reads or changing the selected task', async () => {
  const f = vi.fn(async () => response(base));
  vi.stubGlobal('fetch', f);
  mount();
  await screen.findByRole('button', { name: /Müşteri a/ });
  fireEvent.change(screen.getByLabelText('Yüklü takiplerde ara'), {
    target: { value: 'Müşteri b' },
  });
  expect(screen.queryByRole('button', { name: /Müşteri a/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: /Müşteri b/ }));
  fireEvent.change(screen.getByLabelText('Takip zamanı'), { target: { value: 'OVERDUE' } });
  expect(screen.getByText('b@example.test')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /Müşteri b/ })).toBeNull();
  expect(f.mock.calls).toHaveLength(1);
});
it('submits an authorized queue search beyond loaded rows and keeps search focus and pagination', async () => {
  const fetcher = vi.fn(async (url: string) => {
    const q = new URL(url, 'https://panel.example.test').searchParams;
    if (!q.has('q')) return response(base);
    return response({
      ...base,
      items: [task(q.has('cursor') ? 'sonuç-iki' : 'sonuç-bir')],
      hasMore: !q.has('cursor'),
      nextCursor: q.has('cursor') ? null : 'search-next',
    });
  });
  vi.stubGlobal('fetch', fetcher);
  mount(false);
  await screen.findByRole('button', { name: /Müşteri a/ });
  const input = screen.getByRole('searchbox');
  input.focus();
  fireEvent.change(input, { target: { value: 'Görüşme' } });
  expect(fetcher.mock.calls).toHaveLength(1);
  fireEvent.submit(input.closest('form')!);
  await screen.findByRole('button', { name: /Müşteri sonuç-bir/ });
  expect(document.activeElement).toBe(input);
  expect(screen.queryByRole('button', { name: /Müşteri a/ })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Daha fazla sonuç yükle' }));
  await screen.findByRole('button', { name: /Müşteri sonuç-iki/ });
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([
    '/api/tasks/today?limit=20',
    '/api/tasks/today?limit=20&q=G%C3%B6r%C3%BC%C5%9Fme',
    '/api/tasks/today?limit=20&q=G%C3%B6r%C3%BC%C5%9Fme&cursor=search-next',
  ]);
  fireEvent.change(input, { target: { value: '' } });
  fireEvent.submit(input.closest('form')!);
  await screen.findByRole('button', { name: /Müşteri a/ });
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
  expect(screen.getByRole('heading', { name: 'Kendi işlerim' })).toBeTruthy();
  expect(screen.queryByText('Ekip işlemleri')).toBeNull();
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
      : url.startsWith('/api/tasks/a/context')
        ? response(null, 404)
        : response(
            ++requests === 1
              ? base
              : {
                  ...base,
                  items: [task('employee-b')],
                  canSeeUnassigned: false,
                  canSeeReassignment: false,
                  unassignedItems: [],
                  unassignedHasMore: false,
                  unassignedNextCursor: null,
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
  // The URL now carries an exact Task hint; a different employee cannot resolve it.
  // This is a fresh, generic unavailable notice, not the old deferred response.
  expect(screen.getByRole('alert').textContent).toContain('Başka bir takip otomatik seçilmedi');
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
  const reads = vi.fn(async (url: string) =>
    response(url.includes('statistics') ? stats('self', false) : base),
  );
  vi.stubGlobal('fetch', reads);
  mount(false);
  await screen.findByRole('button', { name: /Müşteri a/ });
  expect(reads.mock.calls.some(([url]) => url.includes('statistics'))).toBe(false);
  fireEvent.click(screen.getByRole('button', { name: 'İş yükü özeti' }));
  await screen.findByText('42');
  expect(screen.queryByRole('button', { name: 'Görev istatistiklerini göster' })).toBeNull();
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
    fireEvent.click(screen.getByRole('button', { name: 'İş yükü özeti' }));
    await waitFor(() => expect(pending).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Ayrıntıları kapat' }));
    await act(async () => release(response(null, 401)));
    expect(ended).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
  } finally {
    document.removeEventListener('mayi-session-ended', ended);
  }
});
