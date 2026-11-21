import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  act,
  cleanup,
  fireEvent,
  render,
  renderHook,
  screen,
  waitFor,
} from '@testing-library/react';
import { TaskOperationsSection } from '../src/app/pages/today-work/TaskOperationsSection';
import type { TodayTaskDto, TodayTasksResponseData } from '../src/shared/types';
import { useTaskQueue } from '../src/app/pages/today-work/use-task-queue';
import { invalidateCsrfToken } from '../src/app/csrf';
import { canonicalOccurrence } from '../src/app/pages/today-work/interaction-model';
import { MemoryRouter } from 'react-router';
import { openWorkspaceSections, openWorkspaceSection } from './support/workspace-disclosures';
import TodayWorkPage from '../src/app/pages/today-work/TodayWorkPage';
export const task: TodayTaskDto = {
  taskId: 't',
  renewalId: 'r',
  customerId: 'c',
  customerDisplayName: 'Sentetik',
  customerPhone: null,
  customerEmail: null,
  policyId: null,
  policyNumber: null,
  policyEndDate: null,
  title: 'Takip',
  dueAt: '2026-10-18T08:00:00.000Z',
  taskVersion: 3,
  renewalVersion: 7,
  assigneeMembershipId: 'ahmet',
  renewalAssigneeMembershipId: 'ahmet',
  renewalState: 'CONTACT_PENDING',
  bucket: 'TODAY',
  isUnassigned: false,
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
it('rejects invalid calendar dates and ambiguous Istanbul fall-back local times', () => {
  expect(canonicalOccurrence('2026-02-30T12:00:00')).toBeNull();
  expect(canonicalOccurrence('2015-11-08T03:30:00')).toBeNull();
  expect(canonicalOccurrence('2026-10-19T11:00:00')).toBe('2026-10-19T08:00:00.000Z');
});
function setup(
  override?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined,
  initial = task,
) {
  const apply = vi.fn(),
    read = vi.fn(async () => ({ current: undefined as TodayTaskDto | undefined, apply }));
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const custom = override?.(url, init);
    if (custom) return custom;
    if (url.endsWith('csrf-token')) return response({ token: 'csrf' });
    if (!init?.method)
      return response([{ membershipId: 'ayse', label: 'Ayşe', membershipType: 'MEMBER' }]);
    if (url.endsWith('/assign'))
      return response({
        renewalId: initial.renewalId,
        taskId: initial.taskId,
        assigneeMembershipId: JSON.parse(String(init!.body)).assigneeMembershipId,
        renewalVersion: initial.renewalVersion + 1,
        taskVersion: initial.taskVersion + 1,
        updatedAt: '2026-10-18T09:00:00.000Z',
      });
    return response({
      renewalId: 'r',
      completedTaskId: 't',
      replacementTaskId: 'new',
      replacementDueAt: '2026-10-19T08:00:00.000Z',
      completedTaskVersion: 4,
      replacementTaskVersion: 1,
      renewalVersion: 7,
      completedAt: '2026-10-18T09:00:00.000Z',
    });
  });
  vi.stubGlobal('fetch', fetcher);
  const props = {
    task: initial,
    read,
    canOperate: () => true,
    onRisk: vi.fn(),
    onApplied: vi.fn(),
  };
  const view = render(<TaskOperationsSection {...props} />);
  return { ...view, props, fetcher, apply, read };
}
it('requires explicit replacement/confirmation and posts only opening dual CAS with canonical Istanbul date', async () => {
  const { fetcher, read, apply } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Yeni takip planını aç' }));
  expect((screen.getByLabelText('Yeni takip zamanı (İstanbul)') as HTMLInputElement).value).toBe(
    '',
  );
  fireEvent.change(screen.getByLabelText('Yeni takip zamanı (İstanbul)'), {
    target: { value: '2026-10-19T11:00:00' },
  });
  fireEvent.click(
    screen.getByLabelText('Mevcut takibi tamamlayıp yenisini planlamayı onaylıyorum'),
  );
  fireEvent.click(screen.getByRole('button', { name: 'Takibi tamamla ve planla' }));
  await waitFor(() => expect(apply).toHaveBeenCalledOnce());
  const write = fetcher.mock.calls.find(([, i]) => i?.method === 'POST')!;
  expect(JSON.parse(String(write[1]!.body))).toEqual({
    expectedRenewalVersion: 7,
    expectedTaskVersion: 3,
    replacementDueAt: '2026-10-19T08:00:00.000Z',
  });
  expect(read).toHaveBeenCalled();
});
function plan() {
  fireEvent.click(screen.getByRole('button', { name: 'Yeni takip planını aç' }));
  fireEvent.change(screen.getByLabelText('Yeni takip zamanı (İstanbul)'), {
    target: { value: '2026-10-19T11:00:00' },
  });
  fireEvent.click(
    screen.getByLabelText('Mevcut takibi tamamlayıp yenisini planlamayı onaylıyorum'),
  );
}
const submit = () =>
  fireEvent.click(screen.getByRole('button', { name: 'Takibi tamamla ve planla' }));
it('pins both original versions even if props are refreshed while the plan stays open', async () => {
  const view = setup();
  plan();
  view.rerender(
    <TaskOperationsSection
      {...view.props}
      task={{ ...task, renewalVersion: 20, taskVersion: 30 }}
    />,
  );
  submit();
  await waitFor(() => expect(view.apply).toHaveBeenCalled());
  expect(
    JSON.parse(String(view.fetcher.mock.calls.find(([, i]) => i?.method)![1]!.body)),
  ).toMatchObject({ expectedRenewalVersion: 7, expectedTaskVersion: 3 });
});
it.each([503, 429])(
  'freezes original timestamp/body/key and blocks double submits after uncertain %i',
  async (status) => {
    let writes = 0;
    const view = setup((_u, i) =>
      i?.method && ++writes === 1 ? response(null, status) : undefined,
    );
    plan();
    const form = screen.getByRole('form', { name: 'Takip tamamlama formu' });
    fireEvent.submit(form);
    fireEvent.submit(form);
    await screen.findByRole('button', { name: 'Aynı tamamlama isteğini yeniden dene' });
    expect(writes).toBe(1);
    expect(
      screen.getByRole('button', { name: 'Plan taslağını kapat' }).hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Aynı tamamlama isteğini yeniden dene' }));
    await waitFor(() => expect(view.apply).toHaveBeenCalled());
    const attempts = view.fetcher.mock.calls.filter(([, i]) => i?.method);
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toEqual(attempts[1]);
  },
);
it('keeps GET-only recovery after confirmed completion; does not repeat the write', async () => {
  const view = setup();
  view.read.mockRejectedValueOnce(new Error('offline'));
  plan();
  submit();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Yalnız tamamlama kuyruğunu yeniden oku' }),
  );
  await waitFor(() => expect(view.apply).toHaveBeenCalled());
  expect(view.fetcher.mock.calls.filter(([, i]) => i?.method)).toHaveLength(1);
});
it('does not infer success from a missing task when the POST response is malformed', async () => {
  const view = setup((_u, i) => (i?.method ? response({ completedTaskId: 'wrong' }) : undefined));
  plan();
  submit();
  await screen.findByRole('button', { name: 'Aynı tamamlama isteğini yeniden dene' });
  expect(view.apply).not.toHaveBeenCalled();
  expect(view.read).not.toHaveBeenCalled();
});
it('compares the authorized current state after409, preserving date and requiring fresh confirmation', async () => {
  let writes = 0;
  const view = setup((_u, i) => (i?.method && ++writes === 1 ? response(null, 409) : undefined));
  view.read.mockResolvedValue({
    current: { ...task, renewalVersion: 8, taskVersion: 4 },
    apply: view.apply,
  });
  plan();
  submit();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Güncel tamamlama durumunu karşılaştır' }),
  );
  await screen.findByText(/Karşılaştırılan: yenileme v8/);
  expect(
    (screen.getByLabelText('Yeni takip zamanı (İstanbul)') as HTMLInputElement).value,
  ).toContain('2026-10-19T11:00');
  submit();
  expect(writes).toBe(1);
  fireEvent.click(
    screen.getByLabelText('Mevcut takibi tamamlayıp yenisini planlamayı onaylıyorum'),
  );
  submit();
  await waitFor(() => expect(writes).toBe(2));
  const body = JSON.parse(
    String(view.fetcher.mock.calls.filter(([, i]) => i?.method)[1]![1]!.body),
  );
  expect(body).toMatchObject({ expectedRenewalVersion: 8, expectedTaskVersion: 4 });
});
it('does not substitute first-page versions if a conflicting task is no longer in its original authorized page', async () => {
  setup((_u, i) => (i?.method ? response(null, 409) : undefined));
  plan();
  submit();
  fireEvent.click(
    await screen.findByRole('button', { name: 'Güncel tamamlama durumunu karşılaştır' }),
  );
  await screen.findByText(/Seçtiğiniz takip güncel iş listenizde bulunamadı/);
  expect(
    screen.getByRole('button', { name: 'Takibi tamamla ve planla' }).hasAttribute('disabled'),
  ).toBe(true);
});
it('uses only authorized assignment options with explicit selection and confirmation', async () => {
  const view = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Görev atama seçeneklerini aç' }));
  const select = await screen.findByLabelText('Yeni görev sorumlusu');
  expect((select as unknown as HTMLSelectElement).value).toBe('');
  fireEvent.change(select, { target: { value: 'ayse' } });
  fireEvent.click(screen.getByLabelText('Görev ve yenileme sorumlusunu değiştirmeyi onaylıyorum'));
  fireEvent.click(screen.getByRole('button', { name: 'Görev sorumlusunu kaydet' }));
  await waitFor(() => expect(view.apply).toHaveBeenCalled());
  const attempt = view.fetcher.mock.calls.find(([, i]) => i?.method)!;
  expect(attempt[0]).toBe('/api/renewals/r/tasks/t/assign');
  expect(JSON.parse(String(attempt[1]!.body))).toEqual({
    expectedRenewalVersion: 7,
    expectedTaskVersion: 3,
    assigneeMembershipId: 'ayse',
  });
  expect(view.fetcher.mock.calls.every(([u]) => !u.includes('personnel'))).toBe(true);
});
it('hides denied assignment directory without an alternative personnel fetch', async () => {
  const view = setup((u) => (u.endsWith('assignment-options') ? response(null, 404) : undefined));
  fireEvent.click(screen.getByRole('button', { name: 'Görev atama seçeneklerini aç' }));
  await screen.findByRole('alert');
  expect(screen.queryByLabelText('Yeni görev sorumlusu')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Görev sorumlusunu kaydet' })).toBeNull();
  expect(view.fetcher.mock.calls).toHaveLength(1);
});
it('preserves suspended historical association without offering null reassignment or silently selecting an active person', async () => {
  setup(undefined, { ...task, needsReassignment: true });
  fireEvent.click(screen.getByRole('button', { name: 'Görev atama seçeneklerini aç' }));
  await screen.findByLabelText('Yeni görev sorumlusu');
  expect(screen.queryByRole('option', { name: /Atanmamış bırak/ })).toBeNull();
  expect(
    (screen.getByLabelText('Yeni görev sorumlusu') as unknown as HTMLSelectElement).value,
  ).toBe('');
});
it('does not send task operations while a communication draft/pending write blocks them', async () => {
  const view = setup();
  view.rerender(<TaskOperationsSection {...view.props} canOperate={() => false} />);
  plan();
  submit();
  expect(view.fetcher).not.toHaveBeenCalled();
});
it('keeps workflow drafts independent and prevents a sibling operation discarding an open draft', async () => {
  const view = setup();
  plan();
  fireEvent.click(screen.getByRole('button', { name: 'Görev atama seçeneklerini aç' }));
  await screen.findByText(/Diğer görev işleminin açık taslağını kapatın/);
  expect(
    (screen.getByLabelText('Yeni takip zamanı (İstanbul)') as HTMLInputElement).value,
  ).toContain('2026-10-19');
  expect(view.fetcher).not.toHaveBeenCalled();
});
it('ignores delayed POST401 after task/session context unmount', async () => {
  let release!: (r: Response) => void;
  const deferred = new Promise<Response>((r) => {
    release = r;
  });
  const ended = vi.fn();
  document.addEventListener('mayi-session-ended', ended);
  try {
    const view = setup((_u, i) => (i?.method ? deferred : undefined));
    plan();
    submit();
    await waitFor(() => expect(view.fetcher.mock.calls.some(([, i]) => i?.method)).toBe(true));
    view.unmount();
    await act(async () => release(response(null, 401)));
    expect(ended).not.toHaveBeenCalled();
    expect(view.apply).not.toHaveBeenCalled();
  } finally {
    document.removeEventListener('mayi-session-ended', ended);
  }
});
const queueData = (items: TodayTaskDto[]): TodayTasksResponseData => ({
  items,
  unassignedItems: [],
  hasMore: false,
  nextCursor: null,
  unassignedHasMore: false,
  unassignedNextCursor: null,
  canSeeUnassigned: true,
  canSeeReassignment: true,
  canAssign: true,
  timezone: 'Europe/Istanbul',
  now: '2026-10-18T10:00:00.000Z',
  todayLocalDate: '2026-10-18',
});
it('re-reads the exact original later WORK cursor provenance, not the first page or a fictional task GET', async () => {
  const base = '/api/tasks/today?limit=20&unified=true',
    later = base + '&cursor=later%2Fpage';
  let reads = 0;
  const fetcher = vi.fn(async (url: string) => {
    if (url === later) return response(queueData([{ ...task, taskVersion: ++reads + 3 }]));
    return response({
      ...queueData([{ ...task, taskId: 'first' }]),
      hasMore: true,
      nextCursor: 'later/page',
    });
  });
  vi.stubGlobal('fetch', fetcher);
  const hook = renderHook(() => useTaskQueue(true));
  await waitFor(() => expect(hook.result.current.data).not.toBeNull());
  act(() => hook.result.current.more());
  await waitFor(() => expect(hook.result.current.data?.items).toHaveLength(2));
  const read = await hook.result.current.readOperation('t', new AbortController().signal);
  expect(read.current?.taskVersion).toBe(5);
  expect(fetcher.mock.calls.map(([u]) => u)).toEqual([base, later, later]);
  act(() => read.apply());
  expect(hook.result.current.data?.items.map((t) => t.taskId)).toEqual(['t']);
});
it('does not apply an old assignment queue snapshot after a newer completion refresh', async () => {
  let count = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => response(queueData(++count < 3 ? [task] : []))),
  );
  const hook = renderHook(() => useTaskQueue(true));
  await waitFor(() => expect(hook.result.current.data).not.toBeNull());
  const old = await hook.result.current.readOperation('t', new AbortController().signal),
    fresh = await hook.result.current.readOperation('t', new AbortController().signal);
  act(() => fresh.apply());
  act(() => old.apply());
  expect(hook.result.current.data?.items).toEqual([]);
});
it('cleans protected queue details when authorized readback loses permission', async () => {
  let reads = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => (++reads === 1 ? response(queueData([task])) : response(null, 403))),
  );
  const hook = renderHook(() => useTaskQueue(true));
  await waitFor(() => expect(hook.result.current.data).not.toBeNull());
  await act(async () => {
    await expect(
      hook.result.current.readOperation('t', new AbortController().signal),
    ).rejects.toBeTruthy();
  });
  expect(hook.result.current.data).toBeNull();
  expect(hook.result.current.canSeeUnassigned).toBe(false);
});
it('integrates the interaction draft guard and holds the operation key against queue refresh while unresolved', async () => {
  let posts = 0;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (url.startsWith('/api/tasks/today')) return response(queueData([task]));
      if (url.endsWith('csrf-token')) return response({ token: 'csrf' });
      if (init?.method) {
        posts++;
        return response(null, 503);
      }
      return response({
        interactions: [],
        lastContactAt: null,
        lastAttemptAt: null,
        customerType: 'INDIVIDUAL',
        companyContacts: [],
      });
    }),
  );
  render(
    <MemoryRouter>
      <TodayWorkPage owner />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: /Sentetik/ }));
  openWorkspaceSections();
  openWorkspaceSection('İletişim');
  fireEvent.click(await screen.findByRole('button', { name: 'İletişim kaydı ekle' }));
  fireEvent.change(screen.getByLabelText('Görüşme sonucu'), { target: { value: 'NOTE' } });
  fireEvent.change(screen.getByLabelText('İç not'), { target: { value: 'Kaybolmamalı' } });
  openWorkspaceSection('Görev işlemleri');
  plan();
  submit();
  await screen.findByText(/İletişim taslağını açıkça kapatın/);
  expect(posts).toBe(0);
  expect((screen.getByLabelText('İç not') as HTMLTextAreaElement).value).toBe('Kaybolmamalı');
  openWorkspaceSection('İletişim');
  fireEvent.click(screen.getByRole('button', { name: 'Formu kapat ve taslağı bırak' }));
  openWorkspaceSection('Görev işlemleri');
  submit();
  await screen.findByRole('button', { name: 'Aynı tamamlama isteğini yeniden dene' });
  fireEvent.click(screen.getByRole('button', { name: 'Listeyi yenile' }));
  await screen.findByText(/Görev işleminin sonucu çözülmeden/);
  expect(screen.getByRole('button', { name: 'Aynı tamamlama isteğini yeniden dene' })).toBeTruthy();
  expect(posts).toBe(1);
  openWorkspaceSection('İletişim');
  expect(
    screen.getByRole('button', { name: 'İletişim kaydı ekle' }).closest('fieldset')?.disabled,
  ).toBe(true);
});
