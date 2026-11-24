// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { MemoryRouter, Route, Routes, useNavigate } from 'react-router';
import TodayWorkPage from '../src/app/pages/today-work/TodayWorkPage';
import { useTaskQueue } from '../src/app/pages/today-work/use-task-queue';
import { WorkNavigationProvider, ReturnToWork } from '../src/app/pages/today-work/work-navigation';
import type { TodayTaskDto, TodayTasksResponseData } from '../src/shared/types';
vi.mock('../src/app/pages/today-work/RenewalInteractionsSection', () => ({
  RenewalInteractionsSection: () => null,
}));
const task = (id: string): TodayTaskDto => ({
  taskId: id,
  renewalId: 'r-' + id,
  customerId: 'c-' + id,
  customerDisplayName: 'Müşteri ' + id,
  customerEmail: id + '@demo.invalid',
  customerPhone: null,
  policyId: 'p-' + id,
  policyNumber: 'POL-' + id,
  policyEndDate: '2026-11-01',
  title: 'Takip ' + id,
  dueAt: '2026-10-20T09:00:00.000Z',
  assigneeMembershipId: 'me',
  taskVersion: 1,
  renewalVersion: 1,
  renewalAssigneeMembershipId: 'me',
  renewalState: 'CONTACT_PENDING',
  bucket: 'TODAY',
  isUnassigned: false,
});
const data: TodayTasksResponseData = {
  items: [task('a'), task('b')],
  unassignedItems: [],
  nextCursor: null,
  hasMore: false,
  unassignedNextCursor: null,
  unassignedHasMore: false,
  canSeeUnassigned: false,
  canAssign: false,
  timezone: 'Europe/Istanbul',
  todayLocalDate: '2026-10-20',
  now: '2026-10-20T08:00:00.000Z',
};
const reply = (value: unknown, status = 200) =>
  new Response(JSON.stringify({ success: status < 400, data: value }), { status });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function Controls() {
  const navigate = useNavigate();
  return (
    <>
      <button onClick={() => void navigate(-1)}>Geri</button>
      <button onClick={() => void navigate(1)}>İleri</button>
    </>
  );
}
function mount(entry = '/today-work', denied = false) {
  const fetcher = vi.fn(async (url: string) =>
    url.includes('/context')
      ? reply({ ...data, items: [task('a')] }, denied ? 404 : 200)
      : reply(data),
  );
  vi.stubGlobal('fetch', fetcher);
  render(
    <MemoryRouter initialEntries={[entry]}>
      <WorkNavigationProvider>
        <Controls />
        <Routes>
          <Route path="/today-work" element={<TodayWorkPage owner={false} />} />
          <Route
            path="/customers/:id"
            element={
              <>
                <p>Müşteri kaydı</p>
                <ReturnToWork />
              </>
            }
          />
          <Route
            path="/policies/:id"
            element={
              <>
                <p>Poliçe kaydı</p>
                <ReturnToWork />
              </>
            }
          />
        </Routes>
      </WorkNavigationProvider>
    </MemoryRouter>,
  );
  return fetcher;
}
it.each(['UNASSIGNED', 'REASSIGNMENT'])(
  'opens an old %s task link through the current work queue',
  async (oldQueue) => {
    const fetcher = mount('/today-work?task=a&queue=' + oldQueue);
    await screen.findByText('a@demo.invalid');
    expect(
      fetcher.mock.calls.map(([url]) => url).filter((url) => url.startsWith('/api/tasks/')),
    ).toEqual(['/api/tasks/today?limit=20', '/api/tasks/a/context?queue=WORK']);
  },
);
it('restores exactly Task A after customer navigation and browser Back', async () => {
  const fetcher = mount();
  fireEvent.click(await screen.findByRole('button', { name: /Müşteri a/ }));
  fireEvent.click(screen.getByRole('link', { name: 'Müşteri profilini aç' }));
  await screen.findByText('Müşteri kaydı');
  fireEvent.click(screen.getByRole('button', { name: 'Geri' }));
  await screen.findByText('a@demo.invalid');
  expect(screen.queryByText('b@demo.invalid')).toBeNull();
  expect(fetcher.mock.calls.some(([url]) => url.includes('/tasks/a/context'))).toBe(true);
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Müşteri profilini aç' })),
  );
});
it('restores the bounded operation scroll with the same Task rather than full-page scrolling', async () => {
  vi.stubGlobal('scrollTo', vi.fn());
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /Müşteri a/ }));
  const area = document.querySelector('.crm-operation-region') as HTMLElement;
  area.scrollTop = 175;
  fireEvent.click(screen.getByRole('link', { name: 'Müşteri profilini aç' }));
  await screen.findByText('Müşteri kaydı');
  fireEvent.click(screen.getByRole('link', { name: 'Seçili takibe dön' }));
  await screen.findByText('a@demo.invalid');
  await waitFor(() => expect(document.querySelector('.crm-operation-region')?.scrollTop).toBe(175));
});
it('supports a direct link and a fresh authorized read instead of first-row selection', async () => {
  mount('/today-work?task=a&queue=WORK');
  await screen.findByText('a@demo.invalid');
  expect(screen.queryByText('b@demo.invalid')).toBeNull();
});
it('keeps accepted-write readback GET-only when a restored Task disappears from the open context endpoint', async () => {
  let closed = false;
  const fetcher = vi.fn(async (url: string) =>
    url.includes('/context')
      ? reply({ ...data, items: [task('a')] }, closed ? 404 : 200)
      : reply({ ...data, items: closed ? [task('b')] : [task('a'), task('b')] }),
  );
  vi.stubGlobal('fetch', fetcher);
  const view = renderHook(() =>
    useTaskQueue(false, {
      taskId: 'a',
      queue: 'WORK',
      pageUrls: [],
      pageScroll: 0,
      queueScroll: 0,
      sections: {},
    }),
  );
  await waitFor(() => expect(view.result.current.restoredSelection?.id).toBe('a'));
  closed = true;
  const result = await view.result.current.readOperation('a', new AbortController().signal);
  expect(result.current).toBeUndefined();
  expect(fetcher.mock.calls.at(-1)?.[0]).toBe('/api/tasks/today?limit=20');
});
it('opens the relevant section from a nonsensitive reload/deep-link hint', async () => {
  mount('/today-work?task=a&queue=WORK&work=quotes');
  await screen.findByText('a@demo.invalid');
  expect(screen.getByRole('button', { name: 'Teklifler' }).getAttribute('aria-pressed')).toBe(
    'true',
  );
});
it('retries a wrong successful context without losing the original Task identity', async () => {
  let attempt = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url.includes('/context')
        ? reply({ ...data, items: [task(++attempt === 1 ? 'b' : 'a')] })
        : reply(data),
    ),
  );
  render(
    <MemoryRouter initialEntries={['/today-work?task=a&queue=WORK']}>
      <TodayWorkPage owner={false} />
    </MemoryRouter>,
  );
  const retry = await screen.findByRole('button', { name: 'Aynı sayfayı yeniden dene' });
  expect(screen.queryByText('b@demo.invalid')).toBeNull();
  fireEvent.click(retry);
  await screen.findByText('a@demo.invalid');
  expect(screen.queryByText('b@demo.invalid')).toBeNull();
});
it('resumes later bookmarked pages and the exact task after an earlier malformed page', async () => {
  const first = '/api/tasks/today?limit=20';
  const next = first + '&cursor=later';
  const exact = '/api/tasks/c/context?queue=WORK';
  let firstReads = 0;
  const fetcher = vi.fn(async (url: string) => {
    if (url === first)
      return reply({
        ...data,
        items: ++firstReads === 1 ? [null] : [task('a')],
        hasMore: true,
        nextCursor: 'later',
      });
    return reply({ ...data, items: [task('c')] });
  });
  vi.stubGlobal('fetch', fetcher);
  const hook = renderHook(() =>
    useTaskQueue(false, {
      taskId: 'c',
      queue: 'WORK',
      pageUrls: [first, next],
      pageScroll: 0,
      queueScroll: 0,
      sections: {},
    }),
  );
  await waitFor(() => expect(hook.result.current.failure).toBeDefined());
  expect(hook.result.current.restoredSelection).toBeUndefined();
  act(() => hook.result.current.retry());
  await waitFor(() => expect(hook.result.current.restoredSelection?.id).toBe('c'));
  expect(hook.result.current.data?.items.map((row) => row.taskId)).toEqual(['a', 'c']);
  expect(fetcher.mock.calls.map(([url]) => url)).toEqual([first, first, next, exact]);
});
it('shows unavailable when exact A is closed or unauthorized without selecting B', async () => {
  mount('/today-work?task=a&queue=WORK', true);
  expect((await screen.findByRole('alert')).textContent).toContain(
    'Başka bir takip otomatik seçilmedi',
  );
  expect(screen.queryByText('a@demo.invalid')).toBeNull();
  expect(screen.queryByText('b@demo.invalid')).toBeNull();
  expect(screen.getByText('Bir takip seçin')).toBeTruthy();
});
it('restores open workspace sections through explicit return and supports browser Forward', async () => {
  mount();
  fireEvent.click(await screen.findByRole('button', { name: /Müşteri a/ }));
  fireEvent.change(screen.getByLabelText('Yüklü takiplerde ara'), { target: { value: 'POL-a' } });
  fireEvent.change(screen.getByLabelText('Takip zamanı'), { target: { value: 'TODAY' } });
  fireEvent.click(screen.getByRole('button', { name: 'Teklifler' }));
  fireEvent.click(screen.getByRole('link', { name: 'Poliçeyi aç' }));
  await screen.findByText('Poliçe kaydı');
  fireEvent.click(screen.getByRole('link', { name: 'Seçili takibe dön' }));
  await screen.findByText('a@demo.invalid');
  expect(screen.getByLabelText<HTMLInputElement>('Yüklü takiplerde ara').value).toBe('POL-a');
  expect(
    screen.getByLabelText('Takip zamanı').querySelector('option:checked')?.getAttribute('value'),
  ).toBe('TODAY');
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('link', { name: 'Poliçeyi aç' })),
  );
  expect(screen.getByRole('button', { name: 'Teklifler' }).getAttribute('aria-pressed')).toBe(
    'true',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Geri' }));
  await screen.findByText('Poliçe kaydı');
  fireEvent.click(screen.getByRole('button', { name: 'İleri' }));
  await screen.findByText('a@demo.invalid');
});
