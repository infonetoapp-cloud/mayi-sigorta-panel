// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { TodayWorkPanel } from '../src/app/components/TodayWorkPanel';
import type { TodayTaskDto, TodayTasksResponseData } from '../src/shared/types';
const orphan: TodayTaskDto = {
  taskId: 'orphan-task',
  renewalId: 'renewal',
  customerId: 'customer',
  customerDisplayName: 'Devir Müşterisi',
  customerEmail: null,
  customerPhone: null,
  policyId: 'policy',
  policyNumber: 'POL',
  policyEndDate: '2026-11-01',
  title: 'Takip',
  dueAt: '2026-10-16T06:00:00.000Z',
  assigneeMembershipId: 'inactive',
  renewalAssigneeMembershipId: 'inactive',
  taskVersion: 4,
  renewalVersion: 3,
  renewalState: 'CONTACT_PENDING',
  bucket: 'OVERDUE',
  isUnassigned: false,
  needsReassignment: true,
};
const empty: TodayTasksResponseData = {
  items: [],
  unassignedItems: [],
  hasMore: false,
  nextCursor: null,
  unassignedHasMore: false,
  unassignedNextCursor: null,
  canSeeUnassigned: true,
  canSeeReassignment: true,
  canAssign: true,
  timezone: 'Europe/Istanbul',
  todayLocalDate: '2026-10-16',
  now: '2026-10-16T09:00:00.000Z',
};
function response(data: unknown, status = 200) {
  return new Response(JSON.stringify({ success: status < 400, data }), { status });
}
function fixture(failure?: number) {
  let assigned = false;
  let writes = 0;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/tasks/today'))
      return response({
        ...empty,
        items: url.includes('needsReassignment=true') && !assigned ? [orphan] : [],
        unassignedItems: [
          {
            ...orphan,
            taskId: 'unassigned',
            renewalId: 'unassigned-renewal',
            customerDisplayName: 'Atanmamış Müşteri',
            assigneeMembershipId: null,
            renewalAssigneeMembershipId: null,
            isUnassigned: true,
            needsReassignment: false,
          },
        ],
      });
    if (url.endsWith('/assignment-options'))
      return response([
        { membershipId: 'active', label: 'Aktif Çalışan', membershipType: 'MEMBER' },
      ]);
    if (url.endsWith('/assign') && init?.method === 'POST') {
      if (++writes === 1 && failure) return response(null, failure);
      assigned = true;
      return response({});
    }
    throw new Error('Unexpected endpoint');
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
async function open() {
  render(
    <TodayWorkPanel getCsrfToken={async () => 'csrf'} invalidateCsrfToken={() => undefined} />,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Yeniden Atama Gerekenler' }));
  await screen.findByText('Devir Müşterisi');
  fireEvent.click(screen.getByRole('button', { name: 'Atama seçeneklerini aç: Devir Müşterisi' }));
  await screen.findByRole('option', { name: 'Aktif Çalışan (MEMBER)' });
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
describe('Explicit reassignment', () => {
  it.each(['csrf', 'response'])(
    'cancels stale %s work on view switch without a stuck save or stale CSRF retry',
    async (stage) => {
      const base = fixture();
      let releaseToken!: (token: string) => void;
      let releaseResponse!: (response: Response) => void;
      const token = new Promise<string>((resolve) => {
        releaseToken = resolve;
      });
      const pendingResponse = new Promise<Response>((resolve) => {
        releaseResponse = resolve;
      });
      const getCsrfToken = vi.fn(() => (stage === 'csrf' ? token : Promise.resolve('csrf')));
      const invalidateCsrfToken = vi.fn();
      const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
        init?.method === 'POST' ? pendingResponse : base(input, init),
      );
      vi.stubGlobal('fetch', fetcher);
      render(
        <TodayWorkPanel getCsrfToken={getCsrfToken} invalidateCsrfToken={invalidateCsrfToken} />,
      );
      fireEvent.click(await screen.findByRole('button', { name: 'Yeniden Atama Gerekenler' }));
      fireEvent.click(
        await screen.findByRole('button', { name: 'Atama seçeneklerini aç: Devir Müşterisi' }),
      );
      await screen.findByRole('option', { name: 'Aktif Çalışan (MEMBER)' });
      fireEvent.change(screen.getByLabelText('Yeni sorumlu: Devir Müşterisi'), {
        target: { value: 'active' },
      });
      fireEvent.click(screen.getByRole('button', { name: 'Atamayı kaydet: Devir Müşterisi' }));
      await waitFor(() =>
        expect(
          stage === 'csrf'
            ? getCsrfToken.mock.calls.length
            : fetcher.mock.calls.filter(([, init]) => init?.method === 'POST').length,
        ).toBe(1),
      );
      fireEvent.click(screen.getByRole('button', { name: 'Tüm açık takipler' }));
      await screen.findByRole('heading', { name: 'Geciken Takipler' });
      await act(async () => {
        releaseToken('csrf');
        releaseResponse(
          new Response(JSON.stringify({ success: false, error: { code: 'CSRF_INVALID' } }), {
            status: 403,
          }),
        );
        await Promise.resolve();
      });
      fireEvent.click(screen.getByRole('button', { name: 'Yeniden Atama Gerekenler' }));
      fireEvent.click(
        await screen.findByRole('button', { name: 'Atama seçeneklerini aç: Devir Müşterisi' }),
      );
      await screen.findByRole('option', { name: 'Aktif Çalışan (MEMBER)' });
      fireEvent.change(screen.getByLabelText('Yeni sorumlu: Devir Müşterisi'), {
        target: { value: 'active' },
      });
      expect(
        (
          screen.getByRole('button', {
            name: 'Atamayı kaydet: Devir Müşterisi',
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false);
      expect(getCsrfToken).toHaveBeenCalledTimes(1);
      expect(invalidateCsrfToken).not.toHaveBeenCalled();
      expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(
        stage === 'csrf' ? 0 : 1,
      );
    },
  );

  it('does not offer the owner view without server permission', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => response({ ...empty, canSeeReassignment: false, canAssign: false })),
    );
    render(
      <TodayWorkPanel getCsrfToken={async () => 'csrf'} invalidateCsrfToken={() => undefined} />,
    );
    await screen.findByText('Atanmamış İşler');
    expect(screen.queryByRole('button', { name: 'Yeniden Atama Gerekenler' })).toBeNull();
  });

  it('keeps the reassignment filter on cursor pagination and exact failed-page retry', async () => {
    let pageAttempts = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url === '/api/tasks/today') return response(empty);
      if (url.includes('cursor=page-2'))
        return ++pageAttempts === 1
          ? response(null, 503)
          : response({
              ...empty,
              items: [{ ...orphan, taskId: 'second', customerDisplayName: 'İkinci Devir' }],
            });
      return response({ ...empty, items: [orphan], hasMore: true, nextCursor: 'page-2' });
    });
    vi.stubGlobal('fetch', fetcher);
    render(
      <TodayWorkPanel getCsrfToken={async () => 'csrf'} invalidateCsrfToken={() => undefined} />,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Yeniden Atama Gerekenler' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Daha fazla göster' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Aynı sayfayı yeniden dene' }));
    await screen.findByText('İkinci Devir');
    expect(screen.getByText('Devir Müşterisi')).toBeTruthy();
    expect(
      fetcher.mock.calls
        .filter(([url]) => String(url).includes('cursor=page-2'))
        .map(([url]) => String(url)),
    ).toEqual([
      '/api/tasks/today?needsReassignment=true&cursor=page-2',
      '/api/tasks/today?needsReassignment=true&cursor=page-2',
    ]);
  });

  it('distinguishes orphaned from unassigned and requires active employee selection', async () => {
    const fetcher = fixture();
    await open();
    expect(
      screen.getByText('Önceki sorumlu pasif veya askıda; açık takip korunuyor.'),
    ).toBeTruthy();
    const save = screen.getByRole('button', { name: 'Atamayı kaydet: Devir Müşterisi' });
    expect((save as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByLabelText('Yeni sorumlu: Devir Müşterisi'), {
      target: { value: 'active' },
    });
    fireEvent.click(save);
    await waitFor(() => expect(screen.queryByText('Devir Müşterisi')).toBeNull());
    expect(screen.getByText('Atanmamış Müşteri')).toBeTruthy();
    const request = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')!;
    expect(request[0]).toBe('/api/renewals/renewal/tasks/orphan-task/assign');
    expect(JSON.parse(String(request[1]!.body))).toEqual({
      expectedRenewalVersion: 3,
      expectedTaskVersion: 4,
      assigneeMembershipId: 'active',
    });
    expect(request[1]!.headers).toMatchObject({
      'X-CSRF-Token': 'csrf',
      'Idempotency-Key': expect.any(String),
    });
  });
  it('retries uncertain assignment with the same body/key', async () => {
    const fetcher = fixture(503);
    await open();
    fireEvent.change(screen.getByLabelText('Yeni sorumlu: Devir Müşterisi'), {
      target: { value: 'active' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Atamayı kaydet: Devir Müşterisi' }));
    fireEvent.click(
      await screen.findByRole('button', { name: 'Aynı atamayı yeniden dene: Devir Müşterisi' }),
    );
    await waitFor(() => expect(screen.queryByText('Devir Müşterisi')).toBeNull());
    const requests = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(requests).toHaveLength(2);
    expect(requests[1]![1]!.body).toBe(requests[0]![1]!.body);
    expect(requests[1]![1]!.headers).toEqual(requests[0]![1]!.headers);
  });
  it('retains explicit selection and requests refresh on stale CAS', async () => {
    const fetcher = fixture(409);
    await open();
    fireEvent.change(screen.getByLabelText('Yeni sorumlu: Devir Müşterisi'), {
      target: { value: 'active' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Atamayı kaydet: Devir Müşterisi' }));
    await screen.findByText('Kayıt güncellendi. Listeyi yenileyip yeniden deneyin.');
    expect(
      (screen.getByLabelText('Yeni sorumlu: Devir Müşterisi') as unknown as HTMLSelectElement)
        .value,
    ).toBe('active');
    expect(fetcher.mock.calls.filter(([, init]) => init?.method === 'POST')).toHaveLength(1);
  });
});
