import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import TodayWorkPage from '../src/app/pages/today-work/TodayWorkPage';
import { Button } from '../src/app/components/ui/button';
import { PageContainer } from '../src/app/components/layout/PageContainer';
import { PermissionComparison } from '../src/app/components/PersonnelPermissions';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('keeps a long permission comparison keyboard accessible in its bounded scroll region', () => {
  render(
    <PermissionComparison
      before={[]}
      after={[{ permission_code: 'customer.read', scope: 'AGENCY' }]}
    />,
  );
  expect(
    screen.getByRole('region', { name: 'İzin karşılaştırma tablosu' }).getAttribute('tabindex'),
  ).toBe('0');
});
it('exposes a single reusable action-priority contract on buttons and navigation controls', () => {
  render(
    <>
      <Button>Kaydet</Button>
      <Button variant="outline">Vazgeç</Button>
      <Button variant="ghost" asChild>
        <a href="/customers">Müşteriler</a>
      </Button>
    </>,
  );
  expect(screen.getByRole('button', { name: 'Kaydet' }).getAttribute('data-variant')).toBe(
    'primary',
  );
  expect(screen.getByRole('button', { name: 'Vazgeç' }).getAttribute('data-variant')).toBe(
    'secondary',
  );
  expect(screen.getByRole('link', { name: 'Müşteriler' }).getAttribute('data-variant')).toBe(
    'tertiary',
  );
});
it('opts every authenticated page into the same component system rather than just three routes', () => {
  const { container } = render(
    <PageContainer>
      <p>Yetkili içerik</p>
    </PageContainer>,
  );
  expect(container.querySelector('.premium-ui')).not.toBeNull();
});
it('shows one actionable empty queue without empty overdue/today/upcoming group headings', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            success: true,
            data: {
              items: [],
              unassignedItems: [],
              hasMore: false,
              unassignedHasMore: false,
              canSeeUnassigned: true,
              canSeeReassignment: false,
              canAssign: true,
              timezone: 'Europe/Istanbul',
              todayLocalDate: '2026-10-27',
              now: '2026-10-27T12:00:00Z',
            },
          }),
        ),
    ),
  );
  render(
    <MemoryRouter>
      <TodayWorkPage owner />
    </MemoryRouter>,
  );
  await screen.findByText('Bu kuyrukta gösterilecek takip bulunmuyor.');
  expect(screen.queryByRole('heading', { name: 'Geciken takipler' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Bugünkü takipler' })).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Yaklaşan takipler' })).toBeNull();
});
