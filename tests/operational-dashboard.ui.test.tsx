import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import OverviewPage from '../src/app/pages/OverviewPage';
const response = (data: unknown, status = 200) =>
  new Response(
    JSON.stringify({
      success: status < 400,
      data,
      error: status >= 400 ? { message: 'UNSAFE_SQL_DIAGNOSTIC' } : undefined,
    }),
    { status },
  );
const task = {
  taskId: 't1',
  renewalId: 'r1',
  customerDisplayName: 'Yetkili Müşteri',
  policyNumber: 'P-1',
  dueAt: '2026-10-23T08:00:00.000Z',
  renewalState: 'CONTACT_PENDING',
};
let calls: string[] = [];
function stub() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      calls.push(url);
      if (url.startsWith('/api/tasks/statistics'))
        return response({
          view: url.includes('team') ? 'team' : 'self',
          canSeeTeam: url.includes('team'),
          timezone: 'Europe/Istanbul',
          todayLocalDate: '2026-10-23',
          now: '2026-10-23T08:30:00.000Z',
          summary: { overdue: 2, dueToday: 3, upcoming: 4, completedLast30Days: 5 },
          unassigned: url.includes('team') ? { overdue: 1, dueToday: 1, upcoming: 0 } : null,
        });
      if (url.startsWith('/api/tasks/today'))
        return response({
          items: [task],
          unassignedItems: [{ ...task, taskId: 'u1', customerDisplayName: 'OWNER_ONLY' }],
          canSeeUnassigned: true,
          hasMore: true,
          nextCursor: 'next+cursor=',
          unassignedHasMore: false,
          unassignedNextCursor: null,
        });
      return response({
        items: [
          {
            id: 'p1',
            policyNumber: 'P-1',
            endDate: '2026-10-25',
            labels: { insurerName: 'Anadolu', productName: 'Kasko', branchName: 'Motor' },
            archivedAt: null,
          },
        ],
        hasMore: true,
        nextCursor: 'policy-cursor',
      });
    }),
  );
}
function mount(owner = false, path = '/') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <OverviewPage owner={owner} />
    </MemoryRouter>,
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  calls = [];
});
it('loads private operational counts, bounded renewals and server-filtered expiration labels without per-row requests', async () => {
  stub();
  mount();
  expect(await screen.findByRole('heading', { name: 'Yenileme takipleri' })).toBeTruthy();
  await screen.findByRole('link', { name: /Yetkili Müşteri/ });
  expect(screen.getByRole('link', { name: 'Geciken görevler: 2' })).toBeTruthy();
  expect(screen.getByRole('link', { name: 'Bugünkü görevler: 3' })).toBeTruthy();
  expect(screen.queryByRole('link', { name: /OWNER_ONLY/ })).toBeNull();
  expect(screen.queryByRole('link', { name: /Atanmamış görevler/ })).toBeNull();
  expect(calls.some((u) => u.includes('view=team'))).toBe(false);
  expect(calls.find((u) => u.startsWith('/api/tasks/today'))).toContain('limit=5');
  expect(calls.find((u) => u.startsWith('/api/policies?'))).toContain('includeLabels=true');
  expect(calls.some((u) => /\/api\/(customers|renewals)\//.test(u))).toBe(false);
  const follow = screen.getByRole('link', { name: /Yetkili Müşteri/ });
  expect(follow.getAttribute('href')).toContain('task=t1');
  expect(follow.getAttribute('href')).toContain('queue=WORK');
});
it('shows OWNER team summary and unassigned queue only when server capability permits', async () => {
  stub();
  mount(true);
  await screen.findByRole('link', { name: 'Atanmamış görevler: 2' });
  fireEvent.click(screen.getByRole('button', { name: 'Atanmamış takipler' }));
  expect(await screen.findByRole('link', { name: /OWNER_ONLY/ })).toBeTruthy();
  expect(calls[0]).toContain('view=team');
});
it('changes due filters before paginating and retries only the exact failed page', async () => {
  stub();
  mount();
  await screen.findByRole('link', { name: /Yetkili Müşteri/ });
  fireEvent.click(screen.getByRole('button', { name: 'Geciken takipler' }));
  await waitFor(() => expect(calls.at(-1)).toContain('due=OVERDUE'));
  fireEvent.click(await screen.findByRole('button', { name: 'Sonraki takipler' }));
  await waitFor(() => expect(calls.at(-1)).toContain('cursor=next%2Bcursor%3D'));
  fireEvent.click(screen.getByRole('button', { name: 'Bugünkü takipler' }));
  await waitFor(() => expect(calls.at(-1)).toContain('due=TODAY'));
  expect(calls.at(-1)).not.toContain('cursor=');
});
it('never turns denied statistics into zero and keeps independent authorized panels available', async () => {
  stub();
  const base = vi.mocked(fetch).getMockImplementation()!;
  vi.mocked(fetch).mockImplementation(async (url, init) =>
    String(url).includes('/statistics') ? response(null, 403) : base(url, init),
  );
  mount();
  expect(await screen.findByText('Görev özeti kullanılamıyor.')).toBeTruthy();
  expect(await screen.findByRole('link', { name: /Yetkili Müşteri/ })).toBeTruthy();
  expect(document.body.textContent).not.toContain('UNSAFE_SQL_DIAGNOSTIC');
  expect(screen.queryByRole('link', { name: 'Geciken görevler: 0' })).toBeNull();
});
it('refresh hides prior rows immediately and removes them on permission loss', async () => {
  stub();
  mount();
  await screen.findByRole('link', { name: /Yetkili Müşteri/ });
  vi.mocked(fetch).mockResolvedValue(response(null, 403));
  fireEvent.click(screen.getByRole('button', { name: 'Bilgileri yenile' }));
  await waitFor(() => expect(screen.queryByRole('link', { name: /Yetkili Müşteri/ })).toBeNull());
  expect(await screen.findByText('Takipler kullanılamıyor.')).toBeTruthy();
});

it('retries an exact failed cursor without retaining stale rows or replaying the first page', async () => {
  stub();
  const base = vi.mocked(fetch).getMockImplementation()!;
  let attempts = 0;
  vi.mocked(fetch).mockImplementation(async (url, init) => {
    const u = String(url);
    if (u.includes('cursor=')) {
      calls.push(u);
      return ++attempts === 1
        ? response(null, 503)
        : response({
            items: [{ ...task, taskId: 't2', customerDisplayName: 'Sonraki Müşteri' }],
            unassignedItems: [],
            hasMore: false,
            nextCursor: null,
          });
    }
    return base(url, init);
  });
  mount();
  await screen.findByRole('link', { name: /Yetkili Müşteri/ });
  fireEvent.click(screen.getByRole('button', { name: 'Sonraki takipler' }));
  await screen.findByText('Takipler kullanılamıyor.');
  expect(screen.queryByRole('link', { name: /Yetkili Müşteri/ })).toBeNull();
  const failed = calls.at(-1);
  fireEvent.click(screen.getByRole('button', { name: 'Takipleri yeniden yükle' }));
  await screen.findByRole('link', { name: /Sonraki Müşteri/ });
  expect(calls.at(-1)).toBe(failed);
});
it('ignores a late task response after the selected date range changes', async () => {
  stub();
  const base = vi.mocked(fetch).getMockImplementation()!;
  let finish!: (r: Response) => void;
  const old = new Promise<Response>((resolve) => {
    finish = resolve;
  });
  vi.mocked(fetch).mockImplementation(async (url, init) =>
    String(url).startsWith('/api/tasks/today') && String(url).includes('due=TODAY')
      ? old
      : base(url, init),
  );
  mount();
  fireEvent.click(screen.getByRole('button', { name: 'Geciken takipler' }));
  await screen.findByRole('link', { name: /Yetkili Müşteri/ });
  finish(
    response({
      items: [{ ...task, customerDisplayName: 'STALE_PRIVATE_ROW' }],
      unassignedItems: [],
      hasMore: false,
      nextCursor: null,
    }),
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(document.body.textContent).not.toContain('STALE_PRIVATE_ROW');
});
