import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import { render, cleanup, screen, fireEvent, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes, Link, useLocation } from 'react-router';
import SalesCasePage, { SalesCasesSection } from '../src/app/pages/sales/SalesCases';
import { invalidateCsrfToken } from '../src/app/csrf';
import { WorkQueueTable } from '../src/app/pages/today-work/WorkQueueTable';
const customer = { id: 'c1', displayName: 'Poliçesiz Müşteri', archivedAt: null };
const result = {
  operationId: '00000000-0000-4000-8000-000000000001',
  caseId: 'case1',
  caseVersion: 1,
  taskId: 'task1',
  taskVersion: 1,
  dueAt: '2027-01-10T06:00:00.000Z',
};
const record = {
  id: 'case1',
  customerId: 'c1',
  customerName: customer.displayName,
  branchId: 'b1',
  branchName: 'Kasko',
  context: 'NEW_BUSINESS',
  dataClassification: 'GENERAL',
  result: 'OPEN',
  cycleDate: null,
  dateBasis: 'MANUAL',
  version: 1,
  createdAt: '2026-11-17T06:00:00.000Z',
};
const response = (data: unknown, status = 200) =>
  Response.json(
    status < 400
      ? { success: true, data }
      : { success: false, error: { code: 'DENIED', message: 'Kayıt okunamadı.' } },
    { status },
  );
it('closes the exact open case with a reason and verifies accepted responses without a second POST', async () => {
  const outcome = {
    operationId: '00000000-0000-4000-8000-000000000002',
    caseId: 'case1',
    caseVersion: 2,
    taskId: 'task1',
    taskVersion: 2,
    closedAt: '2026-11-19T13:00:00.000Z',
  };
  let submitted = false,
    reads = 0;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/void-context'))
      return response({ caseId: 'case1', caseVersion: 1, taskId: 'task1', taskVersion: 1 });
    if (url.endsWith('/void') && init?.method === 'POST') {
      submitted = true;
      return response(null);
    }
    if (url.endsWith('/void-operation'))
      return ++reads === 1 ? response(null, 503) : response(outcome);
    if (url.includes('csrf-token')) return response({ token: 'csrf' });
    if (url.includes('/prices?'))
      return response({ items: [], hasMore: false, nextCursor: null, canManage: false });
    if (url.endsWith('/case1/task'))
      return response({
        taskId: 'task1',
        taskVersion: 1,
        dueAt: result.dueAt,
        assigneeMembershipId: 'm1',
      });
    if (url.endsWith('/case1'))
      return response(submitted ? { ...record, version: 2, result: 'VOIDED' } : record);
    throw Error(url);
  });
  vi.stubGlobal('fetch', fetcher);
  render(
    <MemoryRouter initialEntries={['/sales-cases/case1']}>
      <Routes>
        <Route path="/sales-cases/:caseId" element={<SalesCasePage />} />
      </Routes>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Çalışmayı geçersiz kıl' }));
  await screen.findByLabelText('Kapatma nedeni *');
  expect(screen.getByRole('button', { name: 'Poliçelendir' }).hasAttribute('disabled')).toBe(true);
  fireEvent.change(screen.getByLabelText('Kapatma nedeni *'), { target: { value: 'DUPLICATE' } });
  fireEvent.change(screen.getByLabelText(/Kısa açıklama/), {
    target: { value: 'Müşteri için ikinci çalışma.' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Çalışmayı kapat' }));
  await screen.findByText(/Kapanış sonucu henüz doğrulanamadı/);
  fireEvent.click(screen.getByRole('button', { name: 'Kayıtlı sonucu doğrula' }));
  await screen.findByText('Çalışma geçersiz kılındı ve bağlı takip kapatıldı.');
  await screen.findByText('Geçersiz çalışma');
  const writes = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(writes).toHaveLength(1);
  expect(JSON.parse(String(writes[0]?.[1]?.body))).toEqual({
    expectedCaseVersion: 1,
    expectedTaskId: 'task1',
    expectedTaskVersion: 1,
    reasonCode: 'DUPLICATE',
    notes: 'Müşteri için ikinci çalışma.',
  });
});
it('keeps the next-cycle details visible and opens the verified replacement follow-up', async () => {
  let reopened = false;
  const successor = { caseId: 'child', caseVersion: 1, taskId: 'child-task', taskVersion: 1 };
  const source = {
    caseId: 'case1',
    caseVersion: 2,
    resultRevisionId: 'loss-rev',
    taskId: 'task1',
    taskVersion: 2,
    successor: { ...successor, dueAt: '2028-01-30T06:00:00.000Z' },
  };
  const outcome = {
    operationId: '00000000-0000-4000-8000-000000000003',
    caseId: 'case1',
    caseVersion: 3,
    resultRevisionId: 'loss-rev',
    previousTaskId: 'task1',
    previousTaskVersion: 2,
    taskId: 'new-task',
    taskVersion: 1,
    dueAt: '2027-02-17T09:00:00.000Z',
    reopenedAt: '2026-11-19T13:00:00.000Z',
    successor: { ...successor, caseVersion: 2, taskVersion: 2 },
  };
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('/reopen-context')) return response(source);
    if (url.endsWith('/reopen') && init?.method === 'POST') {
      reopened = true;
      return response(outcome);
    }
    if (url.endsWith('/reopen-operation')) return response(outcome);
    if (url.includes('csrf-token')) return response({ token: 'csrf' });
    if (url.includes('/prices?'))
      return response({ items: [], hasMore: false, nextCursor: null, canManage: false });
    if (url.endsWith('/case1/task'))
      return response({
        taskId: 'new-task',
        taskVersion: 1,
        dueAt: outcome.dueAt,
        assigneeMembershipId: 'm1',
      });
    if (url.endsWith('/case1'))
      return response({ ...record, version: reopened ? 3 : 2, result: reopened ? 'OPEN' : 'LOST' });
    if (url.endsWith('/loss-result')) return response(null, 404);
    throw Error(url);
  });
  vi.stubGlobal('fetch', fetcher);
  render(
    <MemoryRouter initialEntries={['/sales-cases/case1']}>
      <Routes>
        <Route path="/sales-cases/:caseId" element={<SalesCasePage />} />
      </Routes>
    </MemoryRouter>,
  );
  fireEvent.click(await screen.findByRole('button', { name: 'Çalışmayı yeniden aç' }));
  await screen.findByText(/Sonraki dönem takibi geri alınacak/);
  fireEvent.change(screen.getByLabelText('Yeni takip zamanı (İstanbul) *'), {
    target: { value: '2027-02-17T12:00' },
  });
  fireEvent.change(screen.getByLabelText('Yeniden açma nedeni *'), {
    target: { value: 'WRONG_OUTCOME' },
  });
  fireEvent.change(screen.getByLabelText(/Kısa açıklama/), {
    target: { value: 'Kayıp sonucu yanlış seçildi.' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Yeniden aç ve takip oluştur' }));
  const link = await screen.findByRole('link', { name: 'Yeni takibi aç' });
  expect(link.getAttribute('href')).toBe('/tasks/new-task');
  const writes = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
  expect(writes).toHaveLength(1);
  expect(JSON.parse(String(writes[0]?.[1]?.body))).toEqual({
    expectedCaseVersion: 2,
    expectedResultRevisionId: 'loss-rev',
    expectedTaskId: 'task1',
    expectedTaskVersion: 2,
    expectedSuccessor: successor,
    replacementDueAt: outcome.dueAt,
    reasonCode: 'WRONG_OUTCOME',
    notes: 'Kayıp sonucu yanlış seçildi.',
  });
});
beforeEach(() => invalidateCsrfToken());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup(
  options: { uncertain?: boolean; readbackFail?: boolean; private?: boolean } = {},
  detail = false,
) {
  let written = false,
    attempts = 0;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('/api/sales-cases/case1/prices?'))
      return response({ items: [], hasMore: false, nextCursor: null, canManage: false });
    if (url.includes('csrf-token')) return response({ token: 'csrf' });
    if (url === '/api/catalogs/branches')
      return response([{ id: 'b1', name: 'Kasko', status: 'ACTIVE' }]);
    if (url.startsWith('/api/sales-cases?'))
      return response({ items: written ? [record] : [], hasMore: false, nextCursor: null });
    if (init?.method === 'POST') {
      written = true;
      attempts++;
      if (options.uncertain && attempts === 1) throw Error('Connection lost');
      return response(result, 201);
    }
    if (url.includes('/operations/')) return response(result);
    if (url.endsWith('/task')) {
      if (options.private) return response(null, 404);
      if (written && options.readbackFail) {
        options.readbackFail = false;
        return response(null, 503);
      }
      return response({
        taskId: 'task1',
        taskVersion: 1,
        dueAt: result.dueAt,
        assigneeMembershipId: 'm1',
      });
    }
    if (url === '/api/sales-cases/case1') return response(record);
    throw Error('Unexpected ' + url);
  });
  vi.stubGlobal('fetch', fetcher);
  render(
    <MemoryRouter initialEntries={[detail ? '/sales-cases/case1' : '/customers/c1']}>
      <Routes>
        <Route path="/customers/:id" element={<ProfileTab />} />
        <Route path="/sales-cases/:caseId" element={<SalesCasePage />} />
      </Routes>
    </MemoryRouter>,
  );
  return fetcher;
}
function ProfileTab() {
  const location = useLocation();
  return (
    <>
      <Link to="?section=general">Genel bilgilere dön</Link>
      {location.search.includes('section=general') ? (
        <p>Genel bilgiler</p>
      ) : (
        <SalesCasesSection customer={customer} />
      )}
    </>
  );
}
async function fill() {
  fireEvent.click(screen.getByRole('button', { name: 'Yeni teklif çalışması' }));
  await screen.findByRole('option', { name: 'Kasko' });
  fireEvent.change(screen.getByLabelText('Branş (zorunlu)'), { target: { value: 'b1' } });
  fireEvent.change(screen.getByLabelText('Takip zamanı · İstanbul (zorunlu)'), {
    target: { value: '2027-01-10T09:00' },
  });
}
it('creates with employee selected time and no invented policy, period or payment fields', async () => {
  const fetcher = setup();
  await fill();
  fireEvent.click(screen.getByRole('button', { name: 'Çalışmayı ve takibi kaydet' }));
  await screen.findByRole('link', { name: 'Çalışmayı aç' });
  const call = fetcher.mock.calls.find(([, i]) => i?.method === 'POST')!;
  expect(call[0]).toBe('/api/customers/c1/sales-cases');
  expect(JSON.parse(String(call[1]!.body))).toEqual({
    context: 'NEW_BUSINESS',
    branchId: 'b1',
    cycleDate: null,
    dateBasis: 'MANUAL',
    followup: { dueAt: result.dueAt },
    confirmSimilar: false,
  });
});
it('freezes an uncertain attempt and retries identical body and key', async () => {
  const fetcher = setup({ uncertain: true });
  await fill();
  fireEvent.click(screen.getByRole('button', { name: 'Çalışmayı ve takibi kaydet' }));
  const retry = await screen.findByRole('button', { name: 'Aynı işlemi tekrar kontrol et' });
  await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false));
  expect(
    screen.getByLabelText('Branş (zorunlu)').closest('fieldset')!.hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.click(retry);
  await screen.findByRole('link', { name: 'Çalışmayı aç' });
  const calls = fetcher.mock.calls.filter(([, i]) => i?.method === 'POST');
  expect(calls).toHaveLength(2);
  expect(calls[0]![1]).toEqual(calls[1]![1]);
});
it('uses only GET after an accepted write when the exact readback is interrupted', async () => {
  const fetcher = setup({ readbackFail: true });
  await fill();
  fireEvent.click(screen.getByRole('button', { name: 'Çalışmayı ve takibi kaydet' }));
  const retry = await screen.findByRole('button', { name: 'Kayıtlı sonucu doğrula' });
  await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(retry);
  await screen.findByRole('link', { name: 'Çalışmayı aç' });
  expect(fetcher.mock.calls.filter(([, i]) => i?.method === 'POST')).toHaveLength(1);
});
it('shows shared case information without exposing or editing another employees Task', async () => {
  setup({ private: true }, true);
  await screen.findByText('Bu çalışmanın kişisel takip işine erişiminiz yok veya takip kapanmış.');
  expect(screen.getByRole('heading', { name: customer.displayName })).toBeTruthy();
  expect(screen.queryByRole('button', { name: 'Takip zamanını değiştir' })).toBeNull();
  expect(document.body.textContent).not.toContain('task1');
  expect(document.body.textContent).not.toContain('10 Ocak');
});
it('opens a GENERAL case directly from the daily table and shows the followup year', () => {
  const select = vi.fn();
  render(
    <MemoryRouter>
      <WorkQueueTable
        timezone="Europe/Istanbul"
        onSelect={select}
        onKeyDown={() => {}}
        register={() => {}}
        items={[
          {
            kind: 'GENERAL',
            caseId: 'case1',
            taskId: 'task1',
            customerId: 'c1',
            customerDisplayName: 'Poliçesiz Müşteri',
            branchName: 'Kasko',
            title: 'Teklif çalışması',
            dueAt: '2027-01-10T06:00:00.000Z',
            taskVersion: 1,
            assigneeMembershipId: 'm1',
            bucket: 'UPCOMING',
            isUnassigned: false,
          },
        ]}
      />
    </MemoryRouter>,
  );
  expect(screen.getByRole('link', { name: 'İşi aç ›' }).getAttribute('href')).toBe(
    '/sales-cases/case1',
  );
  expect(screen.getByText(/2027/)).toBeTruthy();
  expect(select).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: /İşlem/ })).toBeNull();
});
it('protects a draft and an uncertain request from same-customer tab navigation', async () => {
  setup({ uncertain: true });
  await fill();
  fireEvent.click(screen.getByRole('link', { name: 'Genel bilgilere dön' }));
  await screen.findByText('Teklif çalışması taslağını bırakmadan önce');
  fireEvent.click(screen.getByRole('button', { name: 'Bu ekranda kal' }));
  expect(screen.getByRole('form', { name: 'Yeni teklif çalışması' })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'Çalışmayı ve takibi kaydet' }));
  const retry = await screen.findByRole('button', { name: 'Aynı işlemi tekrar kontrol et' });
  await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(screen.getByRole('link', { name: 'Genel bilgilere dön' }));
  await screen.findByText(
    'Teklif çalışması kaydı henüz doğrulanmadı. Önce aynı işlemi veya kayıtlı bilgileri yeniden kontrol edin.',
  );
  expect(screen.queryByText('Genel bilgiler')).toBeNull();
  expect(screen.getByRole('form', { name: 'Yeni teklif çalışması' })).toBeTruthy();
});

it.each(['accepted', 'interrupted'])(
  'keeps the correction draft through reauth and verifies the %s write without duplicating it',
  async (mode) => {
    const target = {
      expectedCaseVersion: 3,
      expectedIssueReceiptId: 'issue1',
      expectedTaskId: 'task1',
      expectedTaskVersion: 2,
      expectedPolicyId: 'policy1',
      expectedPolicyVersion: 1,
    };
    let closed = true;
    let reads = 0;
    let reauths = 0;
    const outcome = {
      ...result,
      caseVersion: 4,
      taskId: 'replacement-task',
      correctedAt: '2026-11-20T13:00:00.000Z',
    };
    const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input);
      if (path.endsWith('/api/auth/reauth')) {
        reauths++;
        return response({ reauthenticated: true });
      }
      if (path.endsWith('/won-correction-context'))
        return response({ ...target, policyNumber: 'POL-77' });
      if (path.endsWith('/won-correction-grants')) {
        expect(reauths).toBe(1);
        expect(JSON.parse(String(init?.body))).toEqual({
          ...target,
          replacementDueAt: result.dueAt,
          notes: 'Yanlış çalışma kapatıldı.',
        });
        return response(
          {
            grantId: result.operationId,
            grantEvidenceToken: 'a'.repeat(64),
            expiresAt: new Date(Date.now() + 180000).toISOString(),
          },
          201,
        );
      }
      if (path.endsWith('/correct-won'))
        return mode === 'accepted' ? response(outcome) : response(null, 503);
      if (path.endsWith('/won-correction-operation')) {
        if (++reads === 1 && mode === 'accepted') return response(null, 503);
        closed = false;
        return response(outcome);
      }
      if (path.includes('csrf-token')) return response({ token: 'csrf' });
      if (path.includes('/prices?'))
        return response({ items: [], hasMore: false, nextCursor: null, canManage: false });
      if (path.endsWith('/case1/task'))
        return response({
          taskId: outcome.taskId,
          taskVersion: 1,
          dueAt: result.dueAt,
          assigneeMembershipId: 'm1',
        });
      if (path.endsWith('/case1'))
        return response({ ...record, version: closed ? 3 : 4, result: closed ? 'WON' : 'OPEN' });
      throw Error(path);
    });
    vi.stubGlobal('fetch', fetcher);
    render(
      <MemoryRouter initialEntries={['/sales-cases/case1']}>
        <Routes>
          <Route path="/sales-cases/:caseId" element={<SalesCasePage />} />
        </Routes>
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Poliçelendirmeyi düzelt' }));
    expect(screen.getByText('POL-77')).toBeTruthy();
    fireEvent.input(screen.getByLabelText(/Yeni takip zamanı/), {
      target: { value: '2027-01-10T09:00' },
    });
    fireEvent.change(screen.getByLabelText(/Düzeltme gerekçesi/), {
      target: { value: 'Yanlış çalışma kapatıldı.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Doğrula ve yeni takip aç' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Vazgeç' }));
    expect((screen.getByLabelText(/Düzeltme gerekçesi/) as HTMLTextAreaElement).value).toBe(
      'Yanlış çalışma kapatıldı.',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Doğrula ve yeni takip aç' }));
    fireEvent.change(screen.getByLabelText('Şifre'), {
      target: { value: 'sentetik parola örneği' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Doğrula' }));
    await screen.findByText(/İşlem sonucu henüz doğrulanamadı/);
    expect(screen.queryByRole('link', { name: 'Yeni takibi aç' })).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'İşlem sonucunu kontrol et' }));
    expect((await screen.findByRole('link', { name: 'Yeni takibi aç' })).getAttribute('href')).toBe(
      '/tasks/replacement-task',
    );
    const writes = fetcher.mock.calls.filter(([url]) => String(url).endsWith('/correct-won'));
    expect(writes).toHaveLength(1);
    const proofs = fetcher.mock.calls.filter(([url]) =>
      String(url).endsWith('/won-correction-operation'),
    );
    expect(proofs).toHaveLength(mode === 'accepted' ? 2 : 1);
    for (const [, proof] of proofs)
      expect(new Headers(proof?.headers).get('idempotency-key')).toBe(
        new Headers(writes[0]?.[1]?.headers).get('idempotency-key'),
      );
  },
);
