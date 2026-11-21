import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import OverviewPage from '../src/app/pages/OverviewPage';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('opens the existing authorized workflow for each priority task type', async () => {
  const common = {
    customerId: 'customer',
    customerDisplayName: 'Sentetik Müşteri',
    dueAt: '2026-11-21T10:00:00.000Z',
    taskVersion: 1,
    assigneeMembershipId: 'member',
    bucket: 'OVERDUE',
    isUnassigned: false,
  };
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({
        success: true,
        data: {
          items: [
            {
              ...common,
              kind: 'GENERAL',
              taskId: 'general/one',
              title: 'Genel takip',
              caseId: null,
              branchName: null,
            },
            {
              ...common,
              kind: 'GENERAL',
              taskId: 'general-two',
              title: 'Teklif takibi',
              caseId: 'sale/one',
              branchName: null,
            },
            {
              ...common,
              taskId: 'renewal/one',
              title: 'Yenileme takibi',
              renewalId: 'renewal',
              renewalVersion: 1,
              renewalState: 'CONTACT_PENDING',
              renewalAssigneeMembershipId: 'member',
              customerEmail: null,
              customerPhone: null,
              policyId: null,
              policyNumber: null,
              policyEndDate: null,
            },
          ],
          unassignedItems: [],
          nextCursor: null,
          hasMore: false,
          unassignedNextCursor: null,
          unassignedHasMore: false,
          canSeeUnassigned: false,
          canAssign: false,
          timezone: 'Europe/Istanbul',
          todayLocalDate: '2026-11-21',
          now: '2026-11-21T11:00:00.000Z',
        },
      }),
    ),
  );
  render(
    <MemoryRouter>
      <OverviewPage owner={false} />
    </MemoryRouter>,
  );
  for (const [name, target] of [
    ['Genel takip', '/tasks/general%2Fone'],
    ['Teklif takibi', '/sales-cases/sale%2Fone'],
    ['Yenileme takibi', '/today-work?task=renewal%2Fone&queue=WORK'],
  ]) {
    expect(
      (await screen.findByRole('link', { name: new RegExp(name!) })).getAttribute('href'),
    ).toBe(target);
  }
  expect(screen.queryByRole('link', { name: 'İşletim durumu' })).toBeNull();
});
