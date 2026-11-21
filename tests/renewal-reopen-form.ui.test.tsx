import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { afterEach, expect, it, vi } from 'vitest';
import { RenewalReopenForm } from '../src/app/pages/renewals/RenewalReopenForm';
import { invalidateCsrfToken } from '../src/app/csrf';

afterEach(() => {
  cleanup();
  invalidateCsrfToken();
  vi.unstubAllGlobals();
});
const ok = (data: unknown) => Response.json({ success: true, data });

function setup(blocked = false) {
  const recall = {
    caseId: 'case',
    expectedCaseVersion: 2,
    resultRevisionId: 'result',
    successorCaseId: 'child',
  };
  const applied = vi.fn();
  let reads = 0;
  const requests = vi.fn(async (root: string, init?: RequestInit) => {
    if (root.endsWith('mode=reopen'))
      return ok({
        renewalId: 'r',
        renewalVersion: 2,
        taskId: 'old',
        taskVersion: 3,
        salesCycle: {
          ...recall,
          successorCaseId: blocked ? null : 'child',
          successorDueAt: blocked ? null : '2028-01-30T06:00:00.000Z',
          canRecall: !blocked,
        },
      });
    if (root.endsWith('csrf-token')) return ok({ token: 'csrf' });
    if (init?.method === 'POST')
      return ok({
        renewalId: 'r',
        renewalVersion: 3,
        primaryTaskId: 'new',
        closedTaskId: 'old',
        closedTaskVersion: 3,
        taskVersion: 1,
        salesCycle: { ...recall, successorTaskId: 'child-task' },
      });
    if (root.endsWith('operation-context')) {
      reads++;
      if (reads === 1) throw Error('Bağlantı kesildi');
      return ok({
        renewalId: 'r',
        renewalVersion: 3,
        taskId: 'new',
        taskVersion: 1,
        dueAt: '2027-02-01T06:00:00.000Z',
      });
    }
    throw Error('Unexpected request');
  });
  vi.stubGlobal('fetch', requests);
  render(
    <MemoryRouter>
      <RenewalReopenForm
        renewalId="r"
        canOperate={() => true}
        onRisk={() => {}}
        onApplied={applied}
      />
    </MemoryRouter>,
  );
  fireEvent.click(screen.getByRole('button', { name: 'Yenilemeyi yeniden aç' }));
  return { requests, recall, applied };
}
it('shows the exact successor, submits explicit recall, and retries accepted write with GET only', async () => {
  const { requests, recall, applied } = setup();
  expect(
    (await screen.findByRole('link', { name: /sonraki dönem takibi/ })).getAttribute('href'),
  ).toBe('/sales-cases/child');
  fireEvent.change(screen.getByLabelText('Takip zamanı · İstanbul'), {
    target: { value: '2027-02-01T09:00' },
  });
  fireEvent.click(screen.getByRole('checkbox', { name: /geri alınmasını/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Yeni takip oluştur ve yeniden aç' }));
  await screen.findByText(/İşlem henüz doğrulanamadı/);
  fireEvent.click(screen.getByRole('button', { name: 'Kayıtlı sonucu doğrula' }));
  await waitFor(() => expect(applied).toHaveBeenCalledOnce());
  const posts = requests.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(posts).toHaveLength(1);
  expect(JSON.parse(String(posts[0]![1]?.body))).toMatchObject({
    expectedTaskVersion: 3,
    replacementDueAt: '2027-02-01T06:00:00.000Z',
    salesCycle: recall,
  });
});
it('blocks reopening and hides successor link when task is unavailable', async () => {
  const { requests } = setup(true);
  await screen.findByText(/Sonraki dönem takibi ilerlemiş/);
  expect(screen.queryByRole('link', { name: /sonraki dönem takibi/ })).toBeNull();
  expect(
    (
      screen.getByRole('button', { name: 'Yeni takip oluştur ve yeniden aç' }) as HTMLButtonElement
    ).matches(':disabled'),
  ).toBe(true);
  expect(requests.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false);
});
