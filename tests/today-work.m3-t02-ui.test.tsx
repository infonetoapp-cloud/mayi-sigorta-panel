// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App, invalidateCsrfToken } from '../src/app/App';
import type { ApiResponse, TodayTaskDto, TodayTasksResponseData } from '../src/shared/types';

const items: TodayTaskDto[] = [
  {
    taskId: 'task-overdue',
    renewalId: 'renewal-overdue',
    customerId: 'customer-overdue',
    customerDisplayName: 'Ada Yılmaz',
    customerEmail: 'ada@example.test',
    customerPhone: '+905****2233',
    policyId: 'policy-overdue',
    policyNumber: 'POL-100',
    policyEndDate: '2026-10-01',
    title: 'Yenileme takibi',
    dueAt: '2026-09-23T06:00:00.000Z',
    assigneeMembershipId: 'member-owner',
    taskVersion: 1,
    renewalAssigneeMembershipId: 'member-owner',
    renewalState: 'CONTACT_PENDING',
    renewalVersion: 1,
    bucket: 'OVERDUE',
    isUnassigned: false,
  },
  {
    taskId: 'task-today',
    renewalId: 'renewal-today',
    customerId: 'customer-today',
    customerDisplayName: 'Mavi Ltd.',
    customerEmail: 'iletisim@mavi.example.test',
    customerPhone: '+902122223344',
    policyId: 'policy-today',
    policyNumber: 'POL-200',
    policyEndDate: '2026-10-02',
    title: 'Yenileme takibi',
    dueAt: '2026-09-24T09:00:00.000Z',
    assigneeMembershipId: 'member-owner',
    taskVersion: 1,
    renewalAssigneeMembershipId: 'member-owner',
    renewalState: 'QUOTE_SENT',
    renewalVersion: 1,
    bucket: 'TODAY',
    isUnassigned: false,
  },
  {
    taskId: 'task-unassigned',
    renewalId: 'renewal-unassigned',
    customerId: 'customer-unassigned',
    customerDisplayName: 'Deniz Kaya',
    customerEmail: null,
    customerPhone: '+905559998877',
    policyId: 'policy-unassigned',
    policyNumber: 'POL-300',
    policyEndDate: '2026-10-03',
    title: 'Yenileme takibi',
    dueAt: '2026-09-25T06:00:00.000Z',
    assigneeMembershipId: null,
    taskVersion: 1,
    renewalAssigneeMembershipId: null,
    renewalState: 'CONTACT_PENDING',
    renewalVersion: 1,
    bucket: 'UPCOMING',
    isUnassigned: true,
  },
];

const todayTasks: TodayTasksResponseData = {
  items: items.slice(0, 2),
  unassignedItems: [items[2]!],
  nextCursor: null,
  hasMore: false,
  unassignedNextCursor: null,
  unassignedHasMore: false,
  canSeeUnassigned: true,
  canAssign: true,
  timezone: 'Europe/Istanbul',
  todayLocalDate: '2026-09-24',
  now: '2026-09-24T06:00:00.000Z',
};

function apiResponse<T>(data: T): Response {
  const body: ApiResponse<T> = { success: true, data, timestamp: '2026-09-24T06:00:00.000Z' };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

describe('M3-T02 Today’s Work UI', () => {
  let originalTimezone: string | undefined;

  beforeEach(() => {
    originalTimezone = process.env.TZ;
    invalidateCsrfToken();
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => apiResponse(todayTasks)),
    );
  });

  afterEach(() => {
    if (originalTimezone === undefined) delete process.env.TZ;
    else process.env.TZ = originalTimezone;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('shows scoped daily and unassigned work with minimal customer contact context', async () => {
    const fetchMock = vi.mocked(fetch);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Bugünkü İşler' }));

    expect(await screen.findByRole('heading', { name: 'Bugünkü İşler' })).toBeTruthy();
    expect(await screen.findByText('Geciken Takipler')).toBeTruthy();
    expect(await screen.findByText('Bugünkü Takipler')).toBeTruthy();
    expect(await screen.findByText('Atanmamış İşler')).toBeTruthy();
    expect(await screen.findByText('Ada Yılmaz')).toBeTruthy();
    expect(await screen.findByText('Telefon: +905****2233')).toBeTruthy();
    expect(await screen.findByText('Poliçe: POL-200')).toBeTruthy();
    expect(fetchMock).toHaveBeenCalledWith(
      '/api/tasks/today',
      expect.objectContaining({ method: 'GET' }),
    );
    await waitFor(() => expect(screen.queryByText('API Error')).toBeNull());
  });

  it('shows a parent-authorized unassigned Task without exposing the agency queue or assignment controls', async () => {
    const memberData: TodayTasksResponseData = {
      ...todayTasks,
      items: [items[2]!],
      canSeeUnassigned: false,
      canAssign: false,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => apiResponse(memberData)),
    );
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Bugünkü İşler' }));

    expect(await screen.findByText('Deniz Kaya')).toBeTruthy();
    expect(screen.queryByRole('heading', { name: 'Atanmamış İşler' })).toBeNull();
    expect(screen.getByText('Atanmamış')).toBeTruthy();
    expect(screen.queryByRole('button', { name: /Atama seçeneklerini/ })).toBeNull();
  });

  it('retries the exact failed cursor without dropping the previously loaded work', async () => {
    const firstPage: TodayTasksResponseData = {
      ...todayTasks,
      items: [items[0]!],
      nextCursor: 'opaque-page-two',
      hasMore: true,
      canSeeUnassigned: false,
      canAssign: false,
    };
    const secondPage: TodayTasksResponseData = {
      ...todayTasks,
      items: [items[1]!],
      nextCursor: null,
      hasMore: false,
      canSeeUnassigned: false,
      canAssign: false,
    };
    let pageTwoAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      if (url === '/api/tasks/today') return apiResponse(firstPage);
      if (url === '/api/tasks/today?cursor=opaque-page-two') {
        pageTwoAttempts += 1;
        return pageTwoAttempts === 1
          ? new Response('{}', { status: 503 })
          : apiResponse(secondPage);
      }
      throw new Error(`Unexpected request: ${url} ${init?.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Bugünkü İşler' }));
    expect(await screen.findByText('Ada Yılmaz')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Daha fazla göster' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('Ada Yılmaz')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Aynı sayfayı yeniden dene' }));
    expect(await screen.findByText('Mavi Ltd.')).toBeTruthy();
    expect(pageTwoAttempts).toBe(2);
    expect(
      fetchMock.mock.calls
        .map(([input]) =>
          typeof input === 'string'
            ? input
            : input instanceof Request
              ? input.url
              : input.toString(),
        )
        .filter((url) => url === '/api/tasks/today?cursor=opaque-page-two'),
    ).toHaveLength(2);
  });

  it('paginates the agency queue with its own cursor and retry token', async () => {
    const firstPage: TodayTasksResponseData = {
      ...todayTasks,
      unassignedItems: [items[2]!],
      unassignedHasMore: true,
      unassignedNextCursor: 'unassigned-page-two',
    };
    const secondPage: TodayTasksResponseData = {
      ...todayTasks,
      unassignedItems: [
        { ...items[2]!, taskId: 'task-unassigned-next', customerDisplayName: 'Fırat Yılmaz' },
      ],
      unassignedHasMore: false,
      unassignedNextCursor: null,
    };
    let queueAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      if (url === '/api/tasks/today') return apiResponse(firstPage);
      if (url === '/api/tasks/today?unassignedCursor=unassigned-page-two') {
        queueAttempts += 1;
        return queueAttempts === 1 ? new Response('{}', { status: 503 }) : apiResponse(secondPage);
      }
      throw new Error(`Unexpected request: ${url} ${init?.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Bugünkü İşler' }));
    expect(await screen.findByText('Deniz Kaya')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Daha fazla atanmamış iş' }));
    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByText('Deniz Kaya')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Aynı sayfayı yeniden dene' }));
    expect(await screen.findByText('Fırat Yılmaz')).toBeTruthy();
    expect(queueAttempts).toBe(2);
  });

  it('ignores a late successful list response after Today’s Work is unmounted', async () => {
    const stale = deferred<Response>();
    const staleTasks: TodayTasksResponseData = {
      ...todayTasks,
      items: [{ ...items[0]!, customerDisplayName: 'Eski Yanıt' }],
      canSeeUnassigned: false,
      canAssign: false,
    };
    const currentTasks: TodayTasksResponseData = {
      ...todayTasks,
      items: [{ ...items[1]!, customerDisplayName: 'Güncel Yanıt' }],
      canSeeUnassigned: false,
      canAssign: false,
    };
    let loads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      if (url !== '/api/tasks/today') throw new Error(`Unexpected request: ${url}`);
      loads += 1;
      return loads === 1 ? stale.promise : apiResponse(currentTasks);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Bugünkü İşler' }));
    await waitFor(() => expect(loads).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: 'Genel Bakış' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bugünkü İşler' }));
    expect(await screen.findByText('Güncel Yanıt')).toBeTruthy();
    await act(async () => {
      stale.resolve(apiResponse(staleTasks));
      await stale.promise;
    });
    expect(screen.getByText('Güncel Yanıt')).toBeTruthy();
    expect(screen.queryByText('Eski Yanıt')).toBeNull();
  });

  it('ignores a late list error after Today’s Work is unmounted', async () => {
    const stale = deferred<Response>();
    const currentTasks: TodayTasksResponseData = {
      ...todayTasks,
      items: [{ ...items[1]!, customerDisplayName: 'Güncel Yanıt' }],
      canSeeUnassigned: false,
      canAssign: false,
    };
    let loads = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, _init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      if (url !== '/api/tasks/today') throw new Error(`Unexpected request: ${url}`);
      loads += 1;
      return loads === 1 ? stale.promise : apiResponse(currentTasks);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Bugünkü İşler' }));
    await waitFor(() => expect(loads).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: 'Genel Bakış' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bugünkü İşler' }));
    expect(await screen.findByText('Güncel Yanıt')).toBeTruthy();
    await act(async () => {
      stale.reject(new Error('stale hidden failure'));
      await stale.promise.catch(() => undefined);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByText('stale hidden failure')).toBeNull();
  });

  it('clears previously loaded work after the server denies a refreshed view', async () => {
    let listCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      if (url !== '/api/tasks/today') throw new Error(`Unexpected request: ${url}`);
      listCalls += 1;
      return listCalls === 1
        ? apiResponse(todayTasks)
        : new Response('{}', { status: 403, headers: { 'Content-Type': 'application/json' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Bugünkü İşler' }));
    expect(await screen.findByText('Ada Yılmaz')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Yenile' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Bu görev listesine erişilemiyor.',
    );
    expect(screen.queryByText('Ada Yılmaz')).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Atanmamış İşler' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Takibi tamamla ve yenisini planla/ })).toBeNull();
    expect(listCalls).toBe(2);
  });

  it('does not refresh the new Today’s Work view from a late successful completion', async () => {
    const pendingMutation = deferred<Response>();
    const replacementList: TodayTasksResponseData = {
      ...todayTasks,
      items: [
        { ...items[1]!, taskId: 'after-completion', customerDisplayName: 'After Completion' },
      ],
      canSeeUnassigned: false,
      canAssign: false,
    };
    let listCalls = 0;
    let postCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      if (url === '/api/tasks/today') {
        listCalls += 1;
        return apiResponse(listCalls === 1 ? todayTasks : replacementList);
      }
      if (url === '/api/csrf-token') return apiResponse({ token: 'csrf-navigation-token' });
      if (url === '/api/renewals/renewal-overdue/tasks/task-overdue/complete') {
        postCalls += 1;
        expect(init?.method).toBe('POST');
        return pendingMutation.promise;
      }
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Bugünkü İşler' }));
    const dueField = await screen.findByLabelText('Yeni takip zamanı: Ada Yılmaz');
    fireEvent.change(dueField, { target: { value: '2026-09-25T12:00' } });
    fireEvent.click(
      screen.getByRole('button', { name: 'Takibi tamamla ve yenisini planla: Ada Yılmaz' }),
    );
    await waitFor(() => expect(postCalls).toBe(1));
    fireEvent.click(screen.getByRole('button', { name: 'Genel Bakış' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bugünkü İşler' }));
    expect(await screen.findByText('After Completion')).toBeTruthy();
    await act(async () => {
      pendingMutation.resolve(
        apiResponse({
          renewalId: 'renewal-overdue',
          completedTaskId: 'task-overdue',
          replacementTaskId: 'replacement-after-navigation',
          replacementDueAt: '2026-09-25T09:00:00.000Z',
          completedTaskVersion: 2,
          replacementTaskVersion: 1,
          renewalVersion: 1,
          completedAt: '2026-09-24T06:00:00.000Z',
        }),
      );
      await pendingMutation.promise;
    });
    expect(screen.getByText('After Completion')).toBeTruthy();
    expect(screen.queryByText('Yeni takip planlandı.')).toBeNull();
    expect(listCalls).toBe(2);
  });

  it('does not restore a stale completion retry after a late mutation failure', async () => {
    const pendingMutation = deferred<Response>();
    const replacementList: TodayTasksResponseData = {
      ...todayTasks,
      items: [
        { ...items[1]!, taskId: 'after-failure', customerDisplayName: 'Fresh After Failure' },
      ],
      canSeeUnassigned: false,
      canAssign: false,
    };
    let listCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      if (url === '/api/tasks/today') {
        listCalls += 1;
        return apiResponse(listCalls === 1 ? todayTasks : replacementList);
      }
      if (url === '/api/csrf-token') return apiResponse({ token: 'csrf-navigation-error-token' });
      if (url === '/api/renewals/renewal-overdue/tasks/task-overdue/complete')
        return pendingMutation.promise;
      throw new Error(`Unexpected request: ${url}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Bugünkü İşler' }));
    const dueField = await screen.findByLabelText('Yeni takip zamanı: Ada Yılmaz');
    fireEvent.change(dueField, { target: { value: '2026-09-25T12:00' } });
    fireEvent.click(
      screen.getByRole('button', { name: 'Takibi tamamla ve yenisini planla: Ada Yılmaz' }),
    );
    await waitFor(() =>
      expect(fetchMock.mock.calls.some(([input]) => String(input).includes('/complete'))).toBe(
        true,
      ),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Genel Bakış' }));
    fireEvent.click(screen.getByRole('button', { name: 'Bugünkü İşler' }));
    expect(await screen.findByText('Fresh After Failure')).toBeTruthy();
    await act(async () => {
      pendingMutation.reject(new Error('stale mutation failure'));
      await pendingMutation.promise.catch(() => undefined);
    });
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.queryByRole('button', { name: /Aynı işlemi yeniden dene/ })).toBeNull();
  });

  it('rejects a nonexistent wall-clock time in the configured agency timezone', async () => {
    process.env.TZ = 'UTC';
    const daylightGapTasks: TodayTasksResponseData = {
      ...todayTasks,
      items: [items[0]!],
      canSeeUnassigned: false,
      canAssign: false,
      timezone: 'America/New_York',
    };
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) =>
      apiResponse(daylightGapTasks),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Bugünkü İşler' }));
    const dueField = await screen.findByLabelText('Yeni takip zamanı: Ada Yılmaz');
    fireEvent.change(dueField, { target: { value: '2026-03-08T02:30' } });
    fireEvent.click(
      screen.getByRole('button', { name: 'Takibi tamamla ve yenisini planla: Ada Yılmaz' }),
    );

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Yeni takip zamanını acente saatinde geçerli biçimde seçin.',
    );
    expect(fetchMock.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
  });

  it('retries an ambiguous completion with the same payload and idempotency key', async () => {
    process.env.TZ = 'UTC';
    const dueInput = '2026-09-25T12:00';
    const replacementDueAt = '2026-09-25T09:00:00.000Z';
    let completionAttempts = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      if (url === '/api/tasks/today') return apiResponse(todayTasks);
      if (url === '/api/csrf-token') return apiResponse({ token: 'csrf-ui-test-token' });
      if (url === '/api/renewals/renewal-overdue/tasks/task-overdue/complete') {
        completionAttempts += 1;
        if (completionAttempts === 1) {
          return new Response(
            JSON.stringify({
              success: false,
              error: { code: 'INTERNAL_ERROR', message: 'raw internal server detail' },
              timestamp: '2026-09-24T06:00:00.000Z',
            }),
            { status: 500, headers: { 'Content-Type': 'application/json' } },
          );
        }
        return apiResponse({
          renewalId: 'renewal-overdue',
          completedTaskId: 'task-overdue',
          replacementTaskId: '00000000-0000-4000-8000-000000000001',
          replacementDueAt,
          completedTaskVersion: 2,
          replacementTaskVersion: 1,
          renewalVersion: 1,
          completedAt: '2026-09-24T06:00:00.000Z',
        });
      }
      throw new Error(`Unexpected request: ${url} ${init?.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    invalidateCsrfToken();
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Bugünkü İşler' }));

    const dueField = await screen.findByLabelText('Yeni takip zamanı: Ada Yılmaz');
    fireEvent.change(dueField, { target: { value: dueInput } });
    fireEvent.click(
      screen.getByRole('button', { name: 'Takibi tamamla ve yenisini planla: Ada Yılmaz' }),
    );

    expect((await screen.findByRole('alert')).textContent).toContain(
      'İşlem sonucu doğrulanamadı. Aynı isteği güvenle yeniden deneyebilirsiniz.',
    );
    expect(screen.queryByText('raw internal server detail')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Aynı işlemi yeniden dene: Ada Yılmaz' }));
    await waitFor(() => expect(completionAttempts).toBe(2));

    const completionCalls = fetchMock.mock.calls.filter(([input, init]) => {
      const url =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      return (
        url === '/api/renewals/renewal-overdue/tasks/task-overdue/complete' &&
        init?.method === 'POST'
      );
    });
    expect(completionCalls).toHaveLength(2);
    const [firstAttempt, secondAttempt] = completionCalls;
    const firstInit = firstAttempt?.[1] as RequestInit;
    const secondInit = secondAttempt?.[1] as RequestInit;
    expect(firstInit.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-CSRF-Token': 'csrf-ui-test-token',
    });
    expect((firstInit.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
    expect((secondInit.headers as Record<string, string>)['Idempotency-Key']).toBe(
      (firstInit.headers as Record<string, string>)['Idempotency-Key'],
    );
    const expectedBody = {
      expectedRenewalVersion: 1,
      expectedTaskVersion: 1,
      replacementDueAt,
    };
    expect(JSON.parse(String(firstInit.body))).toEqual(expectedBody);
    expect(JSON.parse(String(secondInit.body))).toEqual(expectedBody);
    expect(JSON.parse(String(firstInit.body))).not.toHaveProperty('agencyId');
    expect(JSON.parse(String(firstInit.body))).not.toHaveProperty('actorUserId');
  });

  it('loads scoped assignee options and assigns the Renewal and Task without client authority fields', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      if (url === '/api/tasks/today') return apiResponse(todayTasks);
      if (url === '/api/csrf-token') return apiResponse({ token: 'csrf-assignment-test-token' });
      if (url === '/api/renewals/renewal-unassigned/tasks/task-unassigned/assignment-options') {
        return apiResponse([
          {
            membershipId: 'membership-agent',
            label: 'agent@example.test',
            membershipType: 'MEMBER',
          },
        ]);
      }
      if (
        url === '/api/renewals/renewal-unassigned/tasks/task-unassigned/assign' &&
        init?.method === 'POST'
      ) {
        return apiResponse({
          renewalId: 'renewal-unassigned',
          taskId: 'task-unassigned',
          assigneeMembershipId: 'membership-agent',
          renewalVersion: 2,
          taskVersion: 2,
          updatedAt: '2026-09-24T06:00:00.000Z',
        });
      }
      throw new Error(`Unexpected request: ${url} ${init?.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    invalidateCsrfToken();
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Bugünkü İşler' }));
    await screen.findByText('Deniz Kaya');
    fireEvent.click(screen.getByRole('button', { name: 'Atama seçeneklerini aç: Deniz Kaya' }));

    const assignee = await screen.findByLabelText('Yeni sorumlu: Deniz Kaya');
    fireEvent.change(assignee, { target: { value: 'membership-agent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Atamayı kaydet: Deniz Kaya' }));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        '/api/renewals/renewal-unassigned/tasks/task-unassigned/assign',
        expect.objectContaining({ method: 'POST' }),
      ),
    );
    const assignCall = fetchMock.mock.calls.find(([input, init]) => {
      const url =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      return (
        url === '/api/renewals/renewal-unassigned/tasks/task-unassigned/assign' &&
        init?.method === 'POST'
      );
    });
    const init = assignCall?.[1] as RequestInit;
    expect(init.headers).toMatchObject({
      'Content-Type': 'application/json',
      'X-CSRF-Token': 'csrf-assignment-test-token',
    });
    expect((init.headers as Record<string, string>)['Idempotency-Key']).toBeTruthy();
    expect(JSON.parse(String(init.body))).toEqual({
      expectedRenewalVersion: 1,
      expectedTaskVersion: 1,
      assigneeMembershipId: 'membership-agent',
    });
    expect(JSON.parse(String(init.body))).not.toHaveProperty('agencyId');
    expect(JSON.parse(String(init.body))).not.toHaveProperty('actorMembershipId');
  });

  it('does not fabricate completion success after a server conflict', async () => {
    let listCalls = 0;
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      if (url === '/api/tasks/today') {
        listCalls += 1;
        return apiResponse(todayTasks);
      }
      if (url === '/api/csrf-token') return apiResponse({ token: 'csrf-completion-conflict' });
      if (
        url === '/api/renewals/renewal-overdue/tasks/task-overdue/complete' &&
        init?.method === 'POST'
      ) {
        return new Response(
          JSON.stringify({
            success: false,
            error: { code: 'CONFLICT' },
            timestamp: '2026-09-24T06:00:00.000Z',
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected request: ${url} ${init?.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Bugünkü İşler' }));
    const dueField = await screen.findByLabelText('Yeni takip zamanı: Ada Yılmaz');
    fireEvent.change(dueField, { target: { value: '2026-09-25T12:00' } });
    fireEvent.click(
      screen.getByRole('button', { name: 'Takibi tamamla ve yenisini planla: Ada Yılmaz' }),
    );

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Kayıt güncellendi. Listeyi yenileyip yeniden deneyin.',
    );
    expect(screen.getByText('Ada Yılmaz')).toBeTruthy();
    expect(screen.queryByText('Yeni takip planlandı.')).toBeNull();
    expect(screen.queryByRole('button', { name: /Aynı işlemi yeniden dene/ })).toBeNull();
    expect(listCalls).toBe(1);
  });

  it('does not fabricate assignment success after a server conflict', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url =
        typeof input === 'string' ? input : input instanceof Request ? input.url : input.toString();
      if (url === '/api/tasks/today') return apiResponse(todayTasks);
      if (url === '/api/csrf-token') return apiResponse({ token: 'csrf-assignment-conflict' });
      if (url === '/api/renewals/renewal-unassigned/tasks/task-unassigned/assignment-options') {
        return apiResponse([
          {
            membershipId: 'membership-agent',
            label: 'agent@example.test',
            membershipType: 'MEMBER',
          },
        ]);
      }
      if (
        url === '/api/renewals/renewal-unassigned/tasks/task-unassigned/assign' &&
        init?.method === 'POST'
      ) {
        return new Response(
          JSON.stringify({
            success: false,
            error: { code: 'CONFLICT' },
            timestamp: '2026-09-24T06:00:00.000Z',
          }),
          { status: 409, headers: { 'Content-Type': 'application/json' } },
        );
      }
      throw new Error(`Unexpected request: ${url} ${init?.method ?? 'GET'}`);
    });
    vi.stubGlobal('fetch', fetchMock);
    render(<App />);
    fireEvent.click(screen.getByRole('button', { name: 'Bugünkü İşler' }));
    await screen.findByText('Deniz Kaya');
    fireEvent.click(screen.getByRole('button', { name: 'Atama seçeneklerini aç: Deniz Kaya' }));
    const assignee = await screen.findByLabelText('Yeni sorumlu: Deniz Kaya');
    fireEvent.change(assignee, { target: { value: 'membership-agent' } });
    fireEvent.click(screen.getByRole('button', { name: 'Atamayı kaydet: Deniz Kaya' }));

    expect((await screen.findByRole('alert')).textContent).toContain(
      'Kayıt güncellendi. Listeyi yenileyip yeniden deneyin.',
    );
    const unassignedCard = screen.getByRole('heading', { name: 'Deniz Kaya' }).closest('article');
    expect(unassignedCard?.textContent).toContain('Atanmamış');
    expect(screen.queryByText('Atama güncellendi.')).toBeNull();
    expect(screen.queryByRole('button', { name: /Aynı atamayı yeniden dene/ })).toBeNull();
  });
});
