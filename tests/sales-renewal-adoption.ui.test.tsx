import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router';
import SalesCasePage, { RenewalSalesCaseAction } from '../src/app/pages/sales/SalesCases';
import { invalidateCsrfToken } from '../src/app/csrf';

const task = {
  renewalId: 'r1',
  renewalVersion: 7,
  taskId: 'actual-task',
  taskVersion: 4,
  customerId: 'c1',
  dueAt: '2027-02-01T06:00:00.000Z',
};
const result = {
  operationId: '00000000-0000-4000-8000-000000000001',
  caseId: 's1',
  caseVersion: 1,
  taskId: task.taskId,
  taskVersion: task.taskVersion,
  dueAt: task.dueAt,
};
const record = {
  id: 's1',
  customerId: 'c1',
  customerName: 'Örnek Müşteri',
  branchId: 'b1',
  branchName: 'Kasko',
  dataClassification: 'GENERAL',
  context: 'RENEWAL',
  renewalId: 'r1',
  sourcePolicyId: 'p1',
  result: 'QUOTE_SENT',
  cycleDate: '2027-02-15',
  dateBasis: 'KNOWN_END_DATE',
  version: 1,
  createdAt: '2026-11-18T09:00:00.000Z',
};
const ok = (data: unknown) => Response.json({ success: true, data });
beforeEach(() => invalidateCsrfToken());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup(options: { existing?: boolean; uncertain?: boolean; readbackFail?: boolean } = {}) {
  let posts = 0,
    proofReads = 0;
  const risk = vi.fn();
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/sales-cases/s1/prices?'))
      return ok({ items: [], hasMore: false, nextCursor: null, canManage: false });
    if (url.includes('csrf-token')) return ok({ token: 'test-csrf' });
    if (url.startsWith('/api/sales-cases?'))
      return ok({ items: options.existing ? [record] : [], hasMore: false, nextCursor: null });
    if (init?.method === 'POST') {
      posts++;
      if (options.uncertain && posts === 1) throw Error('Bağlantı kesildi');
      return ok(result);
    }
    if (url.includes('/operations/')) {
      proofReads++;
      if (options.readbackFail && proofReads === 1) throw Error('Okuma kesildi');
      return ok(result);
    }
    if (url === '/api/sales-cases/s1') return ok(record);
    throw Error('Unexpected ' + url);
  });
  vi.stubGlobal('fetch', fetcher);
  render(
    <MemoryRouter>
      <RenewalSalesCaseAction task={task} canOperate={() => true} onRisk={risk} />
    </MemoryRouter>,
  );
  return { fetcher, risk, postCount: () => posts };
}
it('does not read or mutate until requested, and reuses an existing renewal case without POST', async () => {
  const { fetcher } = setup({ existing: true });
  expect(fetcher).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Teklif çalışmasını aç' }));
  const link = await screen.findByRole('link', { name: 'Çalışmaya git' });
  expect(link.getAttribute('href')).toBe('/sales-cases/s1');
  expect(fetcher.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
it('adopts the selected actual Task without asking for another date or creating policy fields', async () => {
  const { fetcher, risk, postCount } = setup();
  fireEvent.click(screen.getByRole('button', { name: 'Teklif çalışmasını aç' }));
  await screen.findByRole('link', { name: 'Çalışmaya git' });
  const post = fetcher.mock.calls.find(([, init]) => init?.method === 'POST')!;
  expect(post[0]).toBe('/api/customers/c1/sales-cases');
  expect(JSON.parse(String(post[1]?.body))).toEqual({
    context: 'RENEWAL',
    renewalId: 'r1',
    expectedVersion: 7,
    expectedPrimaryTaskId: 'actual-task',
    expectedPrimaryTaskVersion: 4,
  });
  expect(postCount()).toBe(1);
  expect(screen.queryByRole('textbox')).toBeNull();
  await waitFor(() => expect(risk).toHaveBeenLastCalledWith({ dirty: false, unresolved: false }));
});
it('keeps the exact request/key on uncertain writes and only retries GET after accepted writes', async () => {
  const { fetcher, postCount } = setup({ uncertain: true, readbackFail: true });
  fireEvent.click(screen.getByRole('button', { name: 'Teklif çalışmasını aç' }));
  const retry = await screen.findByRole('button', { name: 'Aynı işlemi tekrar kontrol et' });
  await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(retry);
  const readAgain = await screen.findByRole('button', { name: 'Kayıtlı sonucu doğrula' });
  await waitFor(() => expect((readAgain as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(readAgain);
  await screen.findByRole('link', { name: 'Çalışmaya git' });
  const posts = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(postCount()).toBe(2);
  expect(posts[0]![1]!.body).toBe(posts[1]![1]!.body);
  expect(posts[0]![1]!.headers).toEqual(posts[1]![1]!.headers);
});
it('opens a renewal case through the existing renewal workspace without reading a second private Task or showing GENERAL actions', async () => {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).startsWith('/api/sales-cases/s1/prices?'))
      return ok({ items: [], hasMore: false, nextCursor: null, canManage: false });
    if (String(input) === '/api/sales-cases/s1') return ok(record);
    throw Error('Unexpected ' + String(input));
  });
  vi.stubGlobal('fetch', fetcher);
  render(
    <MemoryRouter initialEntries={['/sales-cases/s1']}>
      <Routes>
        <Route path="/sales-cases/:caseId" element={<SalesCasePage />} />
      </Routes>
    </MemoryRouter>,
  );
  expect((await screen.findByRole('link', { name: 'Yenilemeye git' })).getAttribute('href')).toBe(
    '/renewals/r1',
  );
  expect(screen.queryByRole('button', { name: 'Takip zamanını değiştir' })).toBeNull();
  expect(fetcher.mock.calls.every(([input]) => !String(input).endsWith('/task'))).toBe(true);
});
