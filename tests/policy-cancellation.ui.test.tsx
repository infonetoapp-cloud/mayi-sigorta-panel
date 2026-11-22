import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router';
import { PolicyLifecycleSection } from '../src/app/pages/policies/PolicyLifecycleSection';
import { policyDetailFixture } from './support/policy-detail-fixture';
import { invalidateCsrfToken } from '../src/app/csrf';
const policy = policyDetailFixture('p', {
  customerId: 'c',
  policyNumber: 'POL-001',
  product: { id: 'product1', name: 'Kasko', status: 'ACTIVE' },
});
const context = {
  policyId: 'p',
  policyVersion: 1,
  status: 'ACTIVE',
  startDate: '2026-01-01',
  endDate: '2027-12-31',
  eligible: true,
  targetSetFingerprint: 'a'.repeat(64),
  lossReasons: [],
  expectedRenewal: undefined,
};
const result = {
  operationId: '00000000-0000-4000-8000-000000000001',
  eventId: '00000000-0000-4000-8000-000000000002',
  policyId: 'p',
  policyVersion: 2,
  status: 'CANCELLED',
  closedRenewalId: null,
  completedTaskId: null,
};
const response = (data: unknown, status = 200) =>
  new Response(
    JSON.stringify(
      status < 400
        ? { success: true, data }
        : { success: false, error: { code: 'FORBIDDEN', message: 'Bu işlem için yetkiniz yok.' } },
    ),
    { status },
  );
beforeEach(() => invalidateCsrfToken());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup(
  options: {
    uncertain?: boolean;
    denied?: boolean;
    readbackFail?: boolean;
    conflict?: boolean;
  } = {},
) {
  let posted = false,
    postCount = 0;
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.endsWith('csrf-token')) return response({ token: 'csrf' });
    if (url.endsWith('cancellation-context'))
      return options.denied ? response(null, 403) : response(context);
    if (url.endsWith('cancellations'))
      return response(
        posted
          ? [
              {
                id: result.eventId,
                eventDate: '2026-11-17',
                reasonCode: 'VEHICLE_SOLD',
                notes: null,
                status: 'CANCELLED',
              },
            ]
          : [],
      );
    if (init?.method === 'POST') {
      postCount++;
      if (options.conflict)
        return new Response(
          JSON.stringify({
            success: false,
            error: { code: 'TARGET_SET_CHANGED', message: 'Takip değişmiş.' },
          }),
          { status: 409 },
        );
      posted = true;
      if (options.uncertain && postCount === 1) throw Error('Connection lost');
      return response(result);
    }
    if (url === '/api/policies/p') {
      if (options.conflict) return response(policy);
      if (options.readbackFail) {
        options.readbackFail = false;
        return response({ ...policy, version: 2, status: 'CANCELLED', customer: null });
      }
      return response({ ...policy, version: 2, status: 'CANCELLED' });
    }
    throw Error('Unexpected request ' + url);
  });
  vi.stubGlobal('fetch', fetcher);
  const updated = vi.fn();
  render(
    <MemoryRouter>
      <PolicyLifecycleSection policy={policy} onUpdated={updated} />
    </MemoryRouter>,
  );
  return { fetcher, updated };
}
async function review() {
  fireEvent.click(screen.getByRole('button', { name: 'Poliçeyi iptal et' }));
  await screen.findByRole('heading', { name: 'İptal bilgileri' });
  fireEvent.click(screen.getByLabelText('Araç / sigortalı varlık satıldı'));
  fireEvent.click(screen.getByRole('button', { name: 'Özeti gör' }));
  await screen.findByRole('heading', { name: 'İşlem özeti' });
}
it('shows a focused summary before posting and confirms exact policy and history readback', async () => {
  const { fetcher, updated } = setup();
  await review();
  expect(fetcher.mock.calls.filter(([, i]) => i?.method === 'POST')).toHaveLength(0);
  expect(document.activeElement).toBe(screen.getByRole('heading', { name: 'İşlem özeti' }));
  expect(screen.getByText('Kapatılacak açık yenileme takibi yok.')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'İptali kaydet' }));
  await waitFor(() =>
    expect(updated).toHaveBeenCalledWith(
      expect.objectContaining({ status: 'CANCELLED', version: 2 }),
    ),
  );
  const [, init] = fetcher.mock.calls.find(([, i]) => i?.method === 'POST')!;
  expect(JSON.parse(String(init!.body))).toMatchObject({
    expectedPolicyVersion: 1,
    reasonCode: 'VEHICLE_SOLD',
    targetSetFingerprint: 'a'.repeat(64),
  });
});
it('preserves frozen body/key on uncertain response and requires the same request', async () => {
  const { fetcher, updated } = setup({ uncertain: true });
  await review();
  fireEvent.click(screen.getByRole('button', { name: 'İptali kaydet' }));
  const retry = await screen.findByRole('button', { name: 'Aynı işlemi tekrar kontrol et' });
  await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false));
  expect(screen.queryByRole('button', { name: 'Bilgileri düzenle' })).toBeNull();
  fireEvent.click(retry);
  await waitFor(() => expect(updated).toHaveBeenCalledOnce());
  const calls = fetcher.mock.calls.filter(([, i]) => i?.method === 'POST');
  expect(calls).toHaveLength(2);
  expect(calls[0]![1]).toEqual(calls[1]![1]);
});
it('rechecks accepted results without issuing another POST when readback fails', async () => {
  const { fetcher, updated } = setup({ readbackFail: true });
  await review();
  fireEvent.click(screen.getByRole('button', { name: 'İptali kaydet' }));
  const retry = await screen.findByRole('button', { name: 'Kayıtlı sonucu doğrula' });
  await waitFor(() => expect((retry as HTMLButtonElement).disabled).toBe(false));
  expect(updated).not.toHaveBeenCalled();
  fireEvent.click(retry);
  await waitFor(() => expect(updated).toHaveBeenCalledOnce());
  expect(fetcher.mock.calls.filter(([, i]) => i?.method === 'POST')).toHaveLength(1);
});
it('does not expose a form or write when the real target is inaccessible', async () => {
  const { fetcher } = setup({ denied: true });
  fireEvent.click(screen.getByRole('button', { name: 'Poliçeyi iptal et' }));
  await screen.findByRole('alert');
  expect(screen.queryByRole('form')).toBeNull();
  expect(fetcher.mock.calls.filter(([, i]) => i?.method === 'POST')).toHaveLength(0);
});
it('keeps the draft on CAS conflict and never resubmits automatically after refreshing context', async () => {
  const { fetcher } = setup({ conflict: true });
  fireEvent.click(screen.getByRole('button', { name: 'Poliçeyi iptal et' }));
  await screen.findByRole('heading', { name: 'İptal bilgileri' });
  fireEvent.click(screen.getByLabelText('Araç / sigortalı varlık satıldı'));
  fireEvent.change(screen.getByLabelText('Açıklama (isteğe bağlı)'), {
    target: { value: 'Taslağı koru' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Özeti gör' }));
  fireEvent.click(screen.getByRole('button', { name: 'İptali kaydet' }));
  const refresh = await screen.findByRole('button', {
    name: 'Taslağı koru, güncel durumu kontrol et',
  });
  await waitFor(() => expect((refresh as HTMLButtonElement).disabled).toBe(false));
  expect((screen.getByLabelText('Açıklama (isteğe bağlı)') as HTMLTextAreaElement).value).toBe(
    'Taslağı koru',
  );
  expect((screen.getByRole('button', { name: 'Özeti gör' }) as HTMLButtonElement).disabled).toBe(
    true,
  );
  fireEvent.click(refresh);
  await waitFor(() =>
    expect((screen.getByRole('button', { name: 'Özeti gör' }) as HTMLButtonElement).disabled).toBe(
      false,
    ),
  );
  expect((screen.getByLabelText('Açıklama (isteğe bağlı)') as HTMLTextAreaElement).value).toBe(
    'Taslağı koru',
  );
  expect(fetcher.mock.calls.filter(([, i]) => i?.method === 'POST')).toHaveLength(1);
});
