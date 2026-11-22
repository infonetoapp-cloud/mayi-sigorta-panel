import { MemoryRouter } from 'react-router';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SalesLossSection } from '../src/app/pages/sales/SalesLossSection';
import { invalidateCsrfToken } from '../src/app/csrf';
beforeEach(() => invalidateCsrfToken());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const ok = (data: unknown) => Response.json({ success: true, data });
function setup(
  options: {
    unknown?: boolean;
    proofFail?: boolean;
    conflict?: boolean;
    denied?: boolean;
    malformed?: boolean;
    canCreate?: boolean;
  } = {},
) {
  let posts = 0,
    reads = 0;
  let result: Record<string, unknown> | null = null;
  const bodies: string[] = [],
    keys: string[] = [],
    changed = vi.fn(),
    risk = vi.fn();
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('csrf-token')) return ok({ token: 'csrf' });
    if (init?.method === 'POST') {
      posts++;
      bodies.push(String(init.body));
      keys.push((init.headers as Record<string, string>)['idempotency-key']!);
      if (options.conflict && posts === 1)
        return Response.json(
          { success: false, error: { code: 'CONFLICT', message: 'Çalışma değişti.' } },
          { status: 409 },
        );
      const c = JSON.parse(String(init.body));
      result ??= {
        operationId: '00000000-0000-4000-8000-000000000121',
        caseId: 'c1',
        caseVersion: c.expectedCaseVersion + 1,
        resultRevisionId: 'result1',
        taskId: c.expectedTaskId,
        taskVersion: c.expectedTaskVersion + 1,
        closedAt: '2026-11-19T09:00:00.000Z',
        followup:
          c.nextCycle.mode === 'FOLLOW_UP'
            ? {
                caseId: 'next1',
                caseVersion: 1,
                taskId: 'new-task',
                taskVersion: 1,
                dueAt: c.nextCycle.dueAt,
                cycleDate: c.nextCycle.cycleDate,
                dateBasis: c.nextCycle.dateBasis,
              }
            : null,
      };
      if (options.unknown && posts === 1) throw Error('Bağlantı kesildi');
      return ok(options.malformed ? { ...result, taskId: 'wrong-task' } : result);
    }
    if (url.endsWith('/loss-context'))
      return options.denied
        ? Response.json({ success: false }, { status: 404 })
        : ok({
            caseId: 'c1',
            caseVersion: 4,
            taskId: 'real-task',
            taskVersion: 7,
            cycleDate: '2026-12-31',
            renewalWindowDays: 30,
            canCreateFollowup: options.canCreate ?? true,
            lossReasons: [{ id: 'reason1', code: 'PRICE', name: 'Fiyat uygun bulunmadı' }],
          });
    if (url.includes('/loss-operations/')) {
      reads++;
      if (options.proofFail && reads === 1) throw Error('Okuma kesildi');
      return ok(result);
    }
    throw Error(url);
  });
  vi.stubGlobal('fetch', fetcher);
  render(
    <MemoryRouter>
      <SalesLossSection
        caseId="c1"
        result="OPEN"
        canOperate={() => true}
        onRisk={risk}
        onChanged={changed}
      />
    </MemoryRouter>,
  );
  return { fetcher, changed, risk, bodies, keys, posts: () => posts };
}
async function edit() {
  fireEvent.click(screen.getByRole('button', { name: 'Poliçelendirilmedi' }));
  await screen.findByRole('form', { name: 'Poliçelendirilmedi' });
}
function fill() {
  fireEvent.change(screen.getByLabelText('Poliçelendirilmedi nedeni (zorunlu)'), {
    target: { value: 'reason1' },
  });
  fireEvent.change(screen.getByLabelText('Sonraki dönem tarihi (biliniyorsa)'), {
    target: { value: '2028-02-29' },
  });
  fireEvent.click(screen.getByLabelText('Bu tarih müşterinin bilinen poliçe bitişidir'));
  fireEvent.click(screen.getByRole('button', { name: 'Tarihe göre takip öner' }));
  fireEvent.click(screen.getByLabelText('Özeti kontrol ettim, kaydet'));
}
function submit() {
  fireEvent.submit(screen.getByRole('form', { name: 'Poliçelendirilmedi' }));
}
it('reads no private Task until opened and sends one real atomic command with Istanbul dates and exact proof', async () => {
  const s = setup();
  expect(s.fetcher).not.toHaveBeenCalled();
  await edit();
  expect((screen.getByLabelText('Sonraki dönem tekrar takip et') as HTMLInputElement).checked).toBe(
    true,
  );
  fill();
  expect(
    (screen.getByLabelText('Tekrar aranacak zaman · İstanbul (zorunlu)') as HTMLInputElement).value,
  ).toBe('2028-01-30T09:00');
  submit();
  await waitFor(() => expect(s.changed).toHaveBeenCalledOnce());
  expect(s.posts()).toBe(1);
  expect(JSON.parse(s.bodies[0]!)).toMatchObject({
    expectedCaseVersion: 4,
    expectedTaskId: 'real-task',
    expectedTaskVersion: 7,
    lossReasonId: 'reason1',
    nextCycle: {
      mode: 'FOLLOW_UP',
      cycleDate: '2028-02-29',
      dateBasis: 'KNOWN_END_DATE',
      dueAt: '2028-01-30T06:00:00.000Z',
    },
  });
});
it('retries an uncertain write with the frozen body/key and locks edits', async () => {
  const s = setup({ unknown: true });
  await edit();
  fill();
  submit();
  await screen.findByText('Bağlantı kesildi');
  expect(
    screen.getByRole('button', { name: 'Sonucu ve takibi kaydet' }).hasAttribute('disabled'),
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Aynı işlemi tekrar kontrol et' }));
  await waitFor(() => expect(s.changed).toHaveBeenCalledOnce());
  expect(s.bodies[1]).toBe(s.bodies[0]);
  expect(s.keys[1]).toBe(s.keys[0]);
});
it('uses GET-only after accepted success and preserves uncertain state on a malformed success body', async () => {
  const s = setup({ proofFail: true });
  await edit();
  fill();
  submit();
  await screen.findByText('Okuma kesildi');
  fireEvent.click(screen.getByRole('button', { name: 'Kayıtlı sonucu doğrula' }));
  await waitFor(() => expect(s.changed).toHaveBeenCalledOnce());
  expect(s.posts()).toBe(1);
  cleanup();
  const malformed = setup({ malformed: true });
  await edit();
  fill();
  submit();
  await screen.findByText(/Kayıt yanıtı gönderilen/);
  fireEvent.click(screen.getByRole('button', { name: 'Kayıtlı sonucu doğrula' }));
  await screen.findByText(/Sunucu kaydı kabul etti/);
  expect(malformed.posts()).toBe(1);
  expect(malformed.changed).not.toHaveBeenCalled();
});
it('preserves the draft after a conflict and requires explicit context refresh and fresh confirmation', async () => {
  const s = setup({ conflict: true });
  await edit();
  fill();
  submit();
  await screen.findByText('Çalışma değişti.');
  fireEvent.click(screen.getByRole('button', { name: 'Taslağı koru, güncel kaydı kontrol et' }));
  await waitFor(() =>
    expect(
      screen.getByRole('button', { name: 'Sonucu ve takibi kaydet' }).hasAttribute('disabled'),
    ).toBe(false),
  );
  expect(
    (screen.getByLabelText('Sonraki dönem tarihi (biliniyorsa)') as HTMLInputElement).value,
  ).toBe('2028-02-29');
  expect((screen.getByLabelText('Özeti kontrol ettim, kaydet') as HTMLInputElement).checked).toBe(
    false,
  );
  expect(s.posts()).toBe(1);
});
it('requires explicit exception and notes instead of silently dropping the next-year followup', async () => {
  const s = setup({ canCreate: false });
  await edit();
  fill();
  submit();
  await screen.findByText(/Yeni takip için yetki/);
  expect(s.posts()).toBe(0);
  fireEvent.click(screen.getByLabelText('Gerekçeli istisna: yeni takip açma'));
  fireEvent.change(screen.getByLabelText('Yeni takip açmama nedeni (zorunlu)'), {
    target: { value: 'NO_FURTHER_CONTACT' },
  });
  fireEvent.change(screen.getByLabelText('Kısa not (zorunlu)'), {
    target: { value: 'Tekrar iletişim istemiyor.' },
  });
  fireEvent.click(screen.getByLabelText('Özeti kontrol ettim, kaydet'));
  submit();
  await waitFor(() => expect(s.changed).toHaveBeenCalledOnce());
  expect(JSON.parse(s.bodies[0]!).nextCycle).toEqual({
    mode: 'NO_FOLLOW_UP',
    exceptionCode: 'NO_FURTHER_CONTACT',
  });
});
it('never invents a Task on denied context', async () => {
  const s = setup({ denied: true });
  await edit().catch(() => {});
  expect(screen.queryByRole('form')).toBeNull();
  expect(s.posts()).toBe(0);
  expect(s.changed).not.toHaveBeenCalled();
});
