// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { TodayWorkPanel } from '../src/app/components/TodayWorkPanel';
import type { TaskStatisticsData } from '../src/shared/task-statistics';
const stats: TaskStatisticsData = {
  view: 'self',
  canSeeTeam: false,
  timezone: 'Europe/Istanbul',
  todayLocalDate: '2026-10-18',
  completionStart: '2026-09-18T21:00:00.000Z',
  now: '2026-10-17T21:30:00.000Z',
  summary: { overdue: 3, dueToday: 4, upcoming: 5, completedLast30Days: 6 },
  employees: [],
  unassigned: null,
  nextCursor: null,
};
const work = {
  items: [],
  unassignedItems: [],
  canAssign: false,
  canSeeUnassigned: false,
  hasMore: false,
  nextCursor: null,
  unassignedHasMore: false,
  unassignedNextCursor: null,
  timezone: 'Europe/Istanbul',
  todayLocalDate: '2026-10-18',
  now: stats.now,
};
function response(data: unknown) {
  return new Response(JSON.stringify({ success: true, data }), { status: 200 });
}
function mount() {
  render(<TodayWorkPanel getCsrfToken={async () => ''} invalidateCsrfToken={() => {}} />);
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe('Operational task statistics in Today Work', () => {
  it('retries the exact failed employee page without dropping earlier employees or adding totals twice', async () => {
    const employee = (id: string) => ({
      membershipId: id,
      displayName: id,
      status: 'ACTIVE' as const,
      userActive: true,
      ...stats.summary,
    });
    let attempts = 0;
    const team = {
      ...stats,
      view: 'team',
      canSeeTeam: true,
      employees: [employee('Ayşe')],
      nextCursor: 'Ayşe',
    };
    const mock = vi.fn(async (url: string) => {
      if (url.includes('cursor=')) {
        if (++attempts === 1) return new Response('{}', { status: 503 });
        return response({ ...team, employees: [employee('Bora')], nextCursor: null });
      }
      return response(
        url.includes('view=team')
          ? team
          : url.includes('/statistics')
            ? { ...stats, canSeeTeam: true }
            : work,
      );
    });
    vi.stubGlobal('fetch', mock);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Görev istatistiklerini göster' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ekip özeti' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Diğer çalışanları göster' }));
    fireEvent.click(await screen.findByRole('button', { name: 'İstatistikleri yeniden dene' }));
    expect(await screen.findByRole('article', { name: 'Bora' })).toBeTruthy();
    expect(screen.getByRole('article', { name: 'Ayşe' })).toBeTruthy();
    const urls = mock.mock.calls.map(([url]) => url).filter((url) => url.includes('cursor='));
    expect(urls).toHaveLength(2);
    expect(urls[0]).toBe(urls[1]);
    expect(
      screen.getByRole('heading', { name: 'Tüm ekip (atanmamış dahil)' }).nextElementSibling
        ?.textContent,
    ).toContain('Son 30 günde tamamlanan6');
  });
  it('shows owner employee rows and unassigned work without requesting personnel or task details', async () => {
    const owner = { ...stats, canSeeTeam: true };
    const team: TaskStatisticsData = {
      ...owner,
      view: 'team',
      unassigned: { overdue: 1, dueToday: 0, upcoming: 0 },
      employees: [
        {
          membershipId: 'a',
          displayName: 'Ayşe',
          status: 'SUSPENDED',
          userActive: true,
          overdue: 2,
          dueToday: 1,
          upcoming: 0,
          completedLast30Days: 7,
        },
      ],
    };
    const mock = vi.fn(async (url: string) =>
      response(url.includes('view=team') ? team : url.includes('/statistics') ? owner : work),
    );
    vi.stubGlobal('fetch', mock);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Görev istatistiklerini göster' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Ekip özeti' }));
    expect(await screen.findByText('Ayşe · Askıda')).toBeTruthy();
    expect(screen.getByText(/Açık işler bu kişide korunur/)).toBeTruthy();
    expect(screen.getByRole('heading', { name: /Atanmamış açık işler/ })).toBeTruthy();
    expect(mock.mock.calls.every(([url]) => url.startsWith('/api/tasks/'))).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Kendi özetim' }));
    expect(await screen.findByRole('heading', { name: 'Kendi görev özetim' })).toBeTruthy();
    expect(screen.queryByText('Ayşe · Askıda')).toBeNull();
  });
  it('clears privileged metrics on a failed refresh and never renders raw server errors', async () => {
    let fail = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) =>
        url.includes('/statistics')
          ? fail
            ? new Response(JSON.stringify({ error: { message: 'SQL PRIVATE TASK' } }), {
                status: 403,
              })
            : response(stats)
          : response(work),
      ),
    );
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Görev istatistiklerini göster' }));
    expect(await screen.findByText('6')).toBeTruthy();
    fail = true;
    fireEvent.click(screen.getByRole('button', { name: 'İstatistikleri yenile' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.queryByText('6')).toBeNull();
    expect(screen.queryByText(/SQL PRIVATE TASK/)).toBeNull();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'İstatistikleri yeniden dene' }));
    expect(await screen.findByText('6')).toBeTruthy();
  });
  it.each(['resolve', 'reject'])(
    'ignores a late %s after the statistics panel is closed',
    async (mode) => {
      let resolve!: (response: Response) => void;
      let reject!: (error: Error) => void;
      const pending = new Promise<Response>((yes, no) => {
        resolve = yes;
        reject = no;
      });
      vi.stubGlobal(
        'fetch',
        vi.fn(async (url: string) => (url.includes('/statistics') ? pending : response(work))),
      );
      mount();
      fireEvent.click(await screen.findByRole('button', { name: 'Görev istatistiklerini göster' }));
      expect(await screen.findByText('İstatistikler yükleniyor…')).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'Görev istatistiklerini gizle' }));
      await act(async () => {
        if (mode === 'resolve') resolve(response(stats));
        else reject(new Error('PRIVATE'));
      });
      expect(screen.queryByRole('region', { name: 'Görev istatistikleri' })).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
    },
  );
  it('opens own aggregated counts rather than counting the loaded task page, with Turkish definitions', async () => {
    const mock = vi.fn(async (url: string) => response(url.includes('/statistics') ? stats : work));
    vi.stubGlobal('fetch', mock);
    mount();
    fireEvent.click(await screen.findByRole('button', { name: 'Görev istatistiklerini göster' }));
    const region = await screen.findByRole('region', { name: 'Görev istatistikleri' });
    expect(await within(region).findByText('6')).toBeTruthy();
    expect(within(region).getByText(/Tamamlayan çalışana göre/)).toBeTruthy();
    expect(within(region).getByText(/Europe\/Istanbul/)).toBeTruthy();
    expect(within(region).getByText(/Güncel atanmış iş yükü: Geciken, bugünün 00:00/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ekip özeti' })).toBeNull();
    expect(mock.mock.calls.some(([url]) => url === '/api/tasks/statistics')).toBe(true);
  });
});
