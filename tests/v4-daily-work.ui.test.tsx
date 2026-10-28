import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import TodayWorkPage from '../src/app/pages/today-work/TodayWorkPage';
import type { TodayTaskDto, TodayTasksResponseData } from '../src/shared/types';
vi.mock('../src/app/pages/today-work/RenewalInteractionsSection', () => ({
  RenewalInteractionsSection: () => null,
}));
const task = (id: string, bucket: TodayTaskDto['bucket']): TodayTaskDto => ({
  taskId: id,
  renewalId: 'r-' + id,
  customerId: 'c-' + id,
  customerDisplayName: 'Sentetik ' + id,
  customerEmail: null,
  customerPhone: null,
  policyId: 'p-' + id,
  policyNumber: 'MS-' + id,
  policyEndDate: '2026-11-01',
  title: 'Yenileme takibi',
  dueAt: '2026-10-24T10:00:00Z',
  assigneeMembershipId: 'm',
  taskVersion: 1,
  renewalVersion: 1,
  renewalAssigneeMembershipId: 'm',
  renewalState: 'CONTACT_PENDING',
  bucket,
  isUnassigned: false,
});
const data: TodayTasksResponseData = {
  items: [task('A', 'OVERDUE'), task('B', 'TODAY'), task('C', 'UPCOMING')],
  unassignedItems: [],
  hasMore: true,
  nextCursor: 'opaque-next',
  unassignedHasMore: false,
  unassignedNextCursor: null,
  canSeeUnassigned: false,
  canAssign: false,
  timezone: 'Europe/Istanbul',
  now: '2026-10-24T08:00:00Z',
  todayLocalDate: '2026-10-24',
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('filters only loaded server buckets without treating the page as a total or retargeting selection', async () => {
  const fetcher = vi.fn(
    async () => new Response(JSON.stringify({ success: true, data }), { status: 200 }),
  );
  vi.stubGlobal('fetch', fetcher);
  render(
    <MemoryRouter>
      <TodayWorkPage owner={false} />
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: /Sentetik A/ }));
  expect(screen.getByRole('button', { name: 'İletişim' }).getAttribute('aria-expanded')).toBe(
    'false',
  );
  fireEvent.click(screen.getByRole('button', { name: 'Görev işlemleri' }));
  expect(screen.queryByRole('button', { name: 'Görev atama seçeneklerini aç' })).toBeNull();
  const filters = screen.getByRole('group', { name: 'Yüklü takiplerde tarih filtresi' });
  fireEvent.click(within(filters).getByRole('button', { name: /Bugün/ }));
  expect(screen.queryByRole('button', { name: /Sentetik A/ })).toBeNull();
  expect(screen.getByRole('button', { name: /Sentetik B/ })).toBeTruthy();
  expect(screen.queryByText('MS-A', { selector: 'dd' })).toBeNull();
  expect(screen.getByText(/yalnız yüklenen takipleri/)).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Atanmamış işler' })).toBeNull();
  expect(fetcher).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'Kompakt görünüm' }));
  expect(
    screen.getByRole('button', { name: 'Standart görünüm' }).getAttribute('aria-pressed'),
  ).toBe('true');
});
