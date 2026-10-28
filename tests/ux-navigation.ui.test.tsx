import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { AppShell } from '../src/app/components/layout/AppShell';
import TodayWorkPage from '../src/app/pages/today-work/TodayWorkPage';
const reply = (data: unknown) =>
  new Response(JSON.stringify({ success: true, data }), { status: 200 });
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('closes the mobile drawer before the dirty navigation decision and keeps the draft on stay', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (u: string) => {
      if (u.startsWith('/api/tasks/today'))
        return reply({
          items: [
            {
              taskId: 't',
              renewalId: 'r',
              customerId: 'c',
              customerDisplayName: 'Deneme',
              policyId: 'p',
              policyNumber: 'POL-1',
              policyEndDate: '2026-10-25',
              title: 'Takip',
              dueAt: '2026-10-20T09:00:00.000Z',
              taskVersion: 1,
              renewalVersion: 1,
              assigneeMembershipId: 'm',
              renewalAssigneeMembershipId: 'm',
              renewalState: 'CONTACT_PENDING',
              bucket: 'TODAY',
              isUnassigned: false,
            },
          ],
          unassignedItems: [],
          hasMore: false,
          nextCursor: null,
          timezone: 'Europe/Istanbul',
          todayLocalDate: '2026-10-20',
          now: '2026-10-20T09:00:00.000Z',
        });
      if (u.endsWith('/interactions'))
        return reply({
          interactions: [],
          lastContactAt: null,
          lastAttemptAt: null,
          customerType: 'INDIVIDUAL',
          companyContacts: [],
        });
      return reply({});
    }),
  );
  render(
    <MemoryRouter initialEntries={['/today-work']}>
      <AppShell
        session={{ state: 'NORMAL', email: 'demo@example.invalid', isOwner: true }}
        busy={false}
        onLogout={() => {}}
        onReauth={() => {}}
      >
        <TodayWorkPage owner />
      </AppShell>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: /Deneme/ }));
  expect(screen.getByRole('link', { name: 'Poliçeyi aç' }).getAttribute('href')).toBe(
    '/policies/p',
  );
  expect(screen.getByRole('link', { name: 'Müşteri profilini aç' }).getAttribute('href')).toBe(
    '/customers/c',
  );
  expect(screen.getByText('Kayıtlı iş aşaması')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'İletişim' }));
  fireEvent.click(await screen.findByRole('button', { name: 'İletişim kaydı ekle' }));
  fireEvent.change(screen.getByLabelText('Görüşme sonucu'), { target: { value: 'NOTE' } });
  fireEvent.change(screen.getByLabelText('İç not'), { target: { value: 'Korunan taslak' } });
  fireEvent.click(screen.getByRole('button', { name: 'Menüyü aç' }));
  const sidebar = screen.getByRole('complementary', { name: 'Çalışma alanı menüsü' });
  expect(sidebar.getAttribute('data-mobile-open')).toBe('true');
  fireEvent.click(screen.getByRole('link', { name: 'Müşteriler' }));
  await screen.findByText('Hedefi değiştirmeden önce');
  expect(sidebar.getAttribute('data-mobile-open')).toBe('false');
  fireEvent.click(screen.getByRole('button', { name: 'Bu ekranda kal' }));
  await waitFor(() =>
    expect((screen.getByLabelText('İç not') as HTMLTextAreaElement).value).toBe('Korunan taslak'),
  );
  expect(screen.queryByText('Hedefi değiştirmeden önce')).toBeNull();
  expect(document.activeElement?.textContent).toBe('Deneme');
  fireEvent.click(screen.getByRole('link', { name: 'Poliçeyi aç' }));
  const dialog = await screen.findByRole('dialog');
  fireEvent(dialog, new Event('cancel', { cancelable: true }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect((screen.getByLabelText('İç not') as HTMLTextAreaElement).value).toBe('Korunan taslak');
});
