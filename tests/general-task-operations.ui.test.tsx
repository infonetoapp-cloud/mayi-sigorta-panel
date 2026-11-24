import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import GeneralTaskPage from '../src/app/pages/today-work/GeneralTaskPage';
import { invalidateCsrfToken } from '../src/app/csrf';
import { WorkQueueTable } from '../src/app/pages/today-work/WorkQueueTable';
const initial = {
  kind: 'GENERAL',
  taskId: 't1',
  taskVersion: 3,
  title: 'Müşteriyi ara',
  customerId: 'c1',
  customerName: 'Örnek Müşteri',
  policyId: null,
  caseId: null,
  dueAt: '2027-01-10T06:00:00.000Z',
  assigneeMembershipId: 'm1',
  status: 'OPEN',
  canReschedule: true,
  canComplete: true,
  canAssign: true,
};
const ok = (data: unknown, status = 200) => Response.json({ success: true, data }, { status });
beforeEach(() => invalidateCsrfToken());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup(
  options: {
    uncertain?: boolean;
    readbackFail?: boolean;
    case?: boolean;
    conflict?: boolean;
    badDto?: boolean;
  } = {},
) {
  let row = {
      ...initial,
      ...(options.case ? { caseId: 'case1', canReschedule: false, canComplete: false } : {}),
    },
    result: Record<string, unknown> | undefined,
    posts = 0,
    proofs = 0;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('csrf-token')) return ok({ token: 'csrf' });
    if (url === '/api/tasks/t1/general-context')
      return ok(options.badDto ? { ...row, taskVersion: '3' } : row);
    if (url.startsWith('/api/tasks/t1/assignment-options'))
      return ok({
        memberships: [{ membershipId: 'm2', displayName: 'Abdurrahman Örnek' }],
        hasMore: false,
        nextCursor: null,
      });
    if (url.includes('/operations/')) {
      proofs++;
      if (options.readbackFail && proofs === 1) throw Error('Okuma kesildi');
      return ok(result);
    }
    if (init?.method === 'POST') {
      posts++;
      const command = JSON.parse(String(init.body));
      if (options.conflict && posts === 1) {
        row = { ...row, taskVersion: 4 };
        return Response.json(
          { success: false, error: { code: 'CONFLICT', message: 'Takip değişti.' } },
          { status: 409 },
        );
      }
      if (!result) {
        row = {
          ...row,
          taskVersion: command.expectedTaskVersion + 1,
          ...(command.dueAt ? { dueAt: command.dueAt } : {}),
          ...(command.assigneeMembershipId
            ? { assigneeMembershipId: command.assigneeMembershipId }
            : {}),
          ...(url.endsWith('/complete')
            ? { status: 'COMPLETED', canReschedule: false, canComplete: false, canAssign: false }
            : {}),
        };
        result = {
          operationId: '00000000-0000-4000-8000-000000000001',
          taskId: row.taskId,
          taskVersion: row.taskVersion,
          status: row.status,
          dueAt: row.dueAt,
          assigneeMembershipId: row.assigneeMembershipId,
        };
      }
      if (options.uncertain && posts === 1) throw Error('Bağlantı kesildi');
      return ok(result);
    }
    throw Error('Unexpected ' + url);
  });
  vi.stubGlobal('fetch', fetcher);
  render(
    <MemoryRouter initialEntries={['/tasks/t1']}>
      <Routes>
        <Route path="/tasks/:taskId" element={<GeneralTaskPage />} />
        <Route path="/today-work" element={<p>Günlük liste</p>} />
      </Routes>
    </MemoryRouter>,
  );
  return { fetcher, postCount: () => posts };
}
async function openFollowup() {
  fireEvent.click(await screen.findByRole('button', { name: 'Takip zamanını değiştir' }));
  fireEvent.change(screen.getByLabelText('Yeni takip zamanı · İstanbul (zorunlu)'), {
    target: { value: '2027-02-12T09:00' },
  });
  fireEvent.change(screen.getByLabelText('Kısa not (isteğe bağlı)'), {
    target: { value: 'Müşteri istedi' },
  });
}
it('updates the actual standalone Task with a deliberate Istanbul date and only the real Task version', async () => {
  const { fetcher } = setup();
  await openFollowup();
  fireEvent.click(screen.getByRole('button', { name: 'Takip zamanını kaydet' }));
  await screen.findByText('Takip zamanı güncellendi.');
  const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(post[0]).toBe('/api/tasks/t1/reschedule');
  expect(JSON.parse(String(post[1]?.body))).toEqual({
    expectedTaskVersion: 3,
    dueAt: '2027-02-12T06:00:00.000Z',
    reasonCode: 'CALL_AGAIN',
    notes: 'Müşteri istedi',
  });
  expect(screen.queryByText(/Poliçe no/)).toBeNull();
});
it('requires explicit completion and verifies accepted writes with GET-only retry', async () => {
  const { fetcher, postCount } = setup({ readbackFail: true });
  fireEvent.click(await screen.findByRole('button', { name: 'İşi tamamla' }));
  expect(postCount()).toBe(0);
  fireEvent.click(screen.getByRole('radio', { name: 'Takip tamamlandı' }));
  fireEvent.click(screen.getByRole('button', { name: 'Tamamlandığını kaydet' }));
  const retry = await screen.findByRole('button', { name: 'Kayıtlı sonucu doğrula' });
  await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(retry);
  await screen.findByText('Müşteri takibi tamamlandı.');
  expect(postCount()).toBe(1);
  expect(
    fetcher.mock.calls.filter(([input]) => String(input).includes('/operations/')),
  ).toHaveLength(2);
  expect(screen.queryByRole('button', { name: 'İşi tamamla' })).toBeNull();
});
it('preserves an uncertain body/key and blocks leaving before the same request is verified', async () => {
  const { fetcher } = setup({ uncertain: true });
  await openFollowup();
  fireEvent.click(screen.getByRole('button', { name: 'Takip zamanını kaydet' }));
  const retry = await screen.findByRole('button', { name: 'Aynı işlemi tekrar kontrol et' });
  await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false));
  expect(screen.getByLabelText('Kısa not (isteğe bağlı)').matches(':disabled')).toBe(true);
  fireEvent.click(screen.getByRole('link', { name: '← Bugünkü İşler' }));
  await screen.findByText(
    'Müşteri takibi kaydı henüz doğrulanmadı. Önce aynı işlemi veya kayıtlı bilgileri yeniden kontrol edin.',
  );
  expect(screen.queryByText('Günlük liste')).toBeNull();
  fireEvent.click(retry);
  await screen.findByText('Takip zamanı güncellendi.');
  const posts = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(posts).toHaveLength(2);
  expect(posts[0]![1]!.body).toBe(posts[1]![1]!.body);
  expect(posts[0]![1]!.headers).toEqual(posts[1]![1]!.headers);
});
it('keeps case outcome controls in the case and omits reassignment for capable users', async () => {
  const { fetcher } = setup({ case: true });
  await screen.findByRole('link', { name: 'Teklif çalışmasını aç' });
  expect(screen.queryByRole('button', { name: 'İşi tamamla' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Takip zamanını değiştir' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Başka çalışana aktar' })).toBeNull();
  expect(fetcher.mock.calls.some(([url]) => String(url).includes('/assignment-options'))).toBe(
    false,
  );
});
it('keeps a stale draft, refreshes explicitly and never sends a new version automatically', async () => {
  const { fetcher, postCount } = setup({ conflict: true });
  await openFollowup();
  fireEvent.click(screen.getByRole('button', { name: 'Takip zamanını kaydet' }));
  const reload = await screen.findByRole('button', { name: 'Güncel takibi kontrol et' });
  expect(postCount()).toBe(1);
  expect((screen.getByLabelText('Kısa not (isteğe bağlı)') as HTMLTextAreaElement).value).toBe(
    'Müşteri istedi',
  );
  fireEvent.click(reload);
  await screen.findByRole('button', { name: 'Takip zamanını kaydet' });
  expect(postCount()).toBe(1);
  fireEvent.click(screen.getByRole('button', { name: 'Takip zamanını kaydet' }));
  await screen.findByText('Takip zamanı güncellendi.');
  const posts = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(JSON.parse(String(posts[1]![1]!.body)).expectedTaskVersion).toBe(4);
});
it('rejects malformed Task DTOs without rendering write actions or guessed identifiers', async () => {
  const { postCount } = setup({ badDto: true });
  await screen.findByText('Takip bilgisi doğrulanamadı. Yeniden yükleyin.');
  expect(screen.queryByRole('button', { name: 'İşi tamamla' })).toBeNull();
  expect(postCount()).toBe(0);
});
it('links a standalone GENERAL row directly to its actual Task page', () => {
  render(
    <MemoryRouter>
      <WorkQueueTable
        items={[
          {
            taskId: initial.taskId,
            title: initial.title,
            customerId: initial.customerId,
            dueAt: initial.dueAt,
            assigneeMembershipId: initial.assigneeMembershipId,
            kind: 'GENERAL',
            caseId: null,
            taskVersion: 3,
            customerDisplayName: initial.customerName,
            branchName: null,
            bucket: 'TODAY',
            isUnassigned: false,
          },
        ]}
        timezone="Europe/Istanbul"
        onSelect={() => {}}
        onKeyDown={() => {}}
        register={() => {}}
      />
    </MemoryRouter>,
  );
  expect(screen.getByRole('link', { name: 'İşi aç ›' }).getAttribute('href')).toBe('/tasks/t1');
});
