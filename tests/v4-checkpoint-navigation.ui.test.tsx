import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, Link, useLocation } from 'react-router';
import TodayWorkPage from '../src/app/pages/today-work/TodayWorkPage';
vi.mock('../src/app/pages/today-work/RenewalInteractionsSection', () => ({
  RenewalInteractionsSection: ({
    onRiskChange,
  }: {
    onRiskChange: (risk: 'draft' | 'uncertain' | 'clean') => void;
  }) => (
    <>
      <button onClick={() => onRiskChange('draft')}>Test taslağını aç</button>
      <button onClick={() => onRiskChange('uncertain')}>Test yazımını belirsiz bırak</button>
      <button onClick={() => onRiskChange('clean')}>Test yazımını uzlaştır</button>
    </>
  ),
}));
const task = {
  taskId: 't1',
  renewalId: 'r1',
  customerId: 'c1',
  customerDisplayName: 'Sentetik Birleşik',
  customerEmail: null,
  customerPhone: null,
  policyId: 'p1',
  policyNumber: 'V4-CHECKPOINT',
  policyEndDate: '2026-11-01',
  title: 'Yenileme',
  dueAt: '2026-10-24T10:00:00Z',
  assigneeMembershipId: 'm1',
  taskVersion: 1,
  renewalVersion: 1,
  renewalAssigneeMembershipId: 'm1',
  renewalState: 'CONTACT_PENDING',
  bucket: 'TODAY',
  isUnassigned: false,
};
const data = {
  items: [task],
  unassignedItems: [],
  hasMore: false,
  nextCursor: null,
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
it('clears a blocked-navigation warning when the selected uncertain operation has reconciled', async () => {
  await setup();
  fireEvent.click(screen.getByRole('button', { name: 'Test yazımını belirsiz bırak' }));
  fireEvent.click(screen.getByRole('button', { name: 'Çıkış Yap' }));
  await screen.findByText(/belirsiz sonucu çözülmeden/);
  fireEvent.click(screen.getByRole('button', { name: 'Test yazımını uzlaştır' }));
  expect(screen.queryByText(/belirsiz sonucu çözülmeden/)).toBeNull();
});
function Destination() {
  const route = useLocation();
  return <output aria-label="Korunan hedef bağlamı">{JSON.stringify(route.state)}</output>;
}
async function setup() {
  const proceed = vi.fn(),
    clicked = vi.fn();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ success: true, data }))),
  );
  render(
    <MemoryRouter initialEntries={['/today-work']}>
      <Routes>
        <Route
          path="/today-work"
          element={
            <>
              <button
                onClick={() =>
                  document.dispatchEvent(
                    new CustomEvent('mayi-logout-requested', {
                      cancelable: true,
                      detail: { proceed },
                    }),
                  )
                }
              >
                Çıkış Yap
              </button>
              <Link
                to="/done"
                state={{
                  policyListReturn: '/policies?cursor=known',
                  workReturn: 'selected-context',
                }}
                onClick={clicked}
              >
                Bağlamlı sayfaya git
              </Link>
              <TodayWorkPage owner={false} />
            </>
          }
        />
        <Route path="/done" element={<Destination />} />
      </Routes>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: /Sentetik Birleşik/ }));
  fireEvent.click(screen.getByRole('button', { name: 'İletişim' }));
  return { proceed, clicked };
}
it('requires explicit discard before voluntary Daily Work logout, and preserves unresolved writes', async () => {
  const { proceed } = await setup();
  fireEvent.click(screen.getByRole('button', { name: 'Test taslağını aç' }));
  fireEvent.click(screen.getByRole('button', { name: 'Çıkış Yap' }));
  await screen.findByRole('dialog');
  expect(proceed).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Bu ekranda kal' }));
  fireEvent.click(screen.getByRole('button', { name: 'Test yazımını belirsiz bırak' }));
  fireEvent.click(screen.getByRole('button', { name: 'Çıkış Yap' }));
  await screen.findByText(/belirsiz sonucu çözülmeden/);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(proceed).not.toHaveBeenCalled();
});
it('invokes voluntary logout exactly once after explicit draft-discard confirmation', async () => {
  const { proceed } = await setup();
  fireEvent.click(screen.getByRole('button', { name: 'Test taslağını aç' }));
  fireEvent.click(screen.getByRole('button', { name: 'Çıkış Yap' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Ayrılmayı onayla' }));
  expect(proceed).toHaveBeenCalledTimes(1);
});
it('replays the original Daily Work Link with router state and contextual onClick intact', async () => {
  const { clicked } = await setup();
  fireEvent.click(screen.getByRole('button', { name: 'Test taslağını aç' }));
  fireEvent.click(screen.getByRole('link', { name: 'Bağlamlı sayfaya git' }));
  await screen.findByRole('dialog');
  expect(clicked).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Ayrılmayı onayla' }));
  expect((await screen.findByLabelText('Korunan hedef bağlamı')).textContent).toBe(
    JSON.stringify({ policyListReturn: '/policies?cursor=known', workReturn: 'selected-context' }),
  );
  expect(clicked).toHaveBeenCalledTimes(1);
});
