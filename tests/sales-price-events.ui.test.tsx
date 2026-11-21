import { MemoryRouter } from 'react-router';
import { SalesPricesSection } from '../src/app/pages/sales/SalesPricesSection';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { SalesPriceEventsPanel } from '../src/app/pages/sales/SalesPriceEventsPanel';
import { invalidateCsrfToken } from '../src/app/csrf';
import type { SalesPriceRevision } from '../src/shared/sales-prices';
const price: SalesPriceRevision = {
  source: 'PRICE_REVISION',
  priceId: 'p1',
  revisionId: 'rev2',
  priceVersion: 2,
  revisionNumber: 2,
  insurerId: 'i1',
  insurerName: 'Anadolu Sigorta',
  amountMinor: 1250050,
  currency: 'TRY',
  termsNote: null,
  offeredPeriod: null,
  createdAt: '2026-11-18T09:00:00.000Z',
};
const ok = (data: unknown, status = 200) => Response.json({ success: true, data }, { status });
beforeEach(() => invalidateCsrfToken());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function setup(
  options: {
    denied?: boolean;
    integrated?: boolean;
    wrongHistory?: boolean;
    uncertain?: boolean;
    proofFail?: boolean;
    conflict?: boolean;
    wrongProof?: boolean;
    allowed?: string[];
  } = {},
) {
  let result: Record<string, unknown> | null = null,
    posts = 0,
    reads = 0;
  const bodies: string[] = [],
    keys: string[] = [],
    risk = vi.fn(),
    changed = vi.fn();
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes('csrf-token')) return ok({ token: 'csrf' });
    if (init?.method === 'POST') {
      posts++;
      bodies.push(String(init.body));
      keys.push((init.headers as Record<string, string>)['idempotency-key']!);
      const c = JSON.parse(String(init.body));
      if (options.conflict && posts === 1)
        return Response.json(
          { success: false, error: { code: 'CONFLICT', message: 'Takip değişmiş.' } },
          { status: 409 },
        );
      result ??= {
        operationId: '00000000-0000-4000-8000-000000000121',
        eventId: 'e1',
        caseId: 'c1',
        caseVersion: c.expectedCaseVersion + 1,
        revisionId: c.revisionId,
        event: c.event,
        occurredAt: c.occurredAt,
      };
      if (options.uncertain && posts === 1) throw Error('Bağlantı kesildi');
      return ok(result, 201);
    }
    if (url.includes('/price-event-operations/')) {
      reads++;
      if (options.proofFail && reads === 1) throw Error('Okuma kesildi');
      return ok(options.wrongProof ? { ...result, eventId: 'wrong' } : result);
    }
    if (url.includes('/price-event-context/'))
      return options.denied
        ? Response.json({ success: false }, { status: 404 })
        : ok({
            taskId: 'real-task',
            taskVersion: 7,
            caseVersion: 4,
            revisionId: 'rev2',
            allowedEvents: options.allowed ?? ['SHARED'],
          });
    if (url.includes('/events?'))
      return ok({
        events: options.wrongHistory
          ? [
              {
                eventId: 'wrong-history',
                revisionId: 'other-revision',
                event: 'SHARED',
                occurredAt: '2026-11-18T09:00:00.000Z',
                createdAt: '2026-11-18T09:00:00.000Z',
                caseVersion: 3,
              },
            ]
          : [],
        hasMore: false,
        nextCursor: null,
      });
    if (url === '/api/sales-cases/c1/prices?limit=20')
      return ok({ items: [price], canManage: true, hasMore: false, nextCursor: null });
    throw Error(url);
  });
  vi.stubGlobal('fetch', fetcher);
  render(
    options.integrated ? (
      <MemoryRouter>
        <SalesPricesSection caseId="c1" caseVersion={4} onRisk={risk} />
      </MemoryRouter>
    ) : (
      <SalesPriceEventsPanel
        caseId="c1"
        price={price}
        canWrite
        canOperate={() => true}
        onRisk={risk}
        onChanged={changed}
        onClose={vi.fn()}
      />
    ),
  );
  return { fetcher, changed, risk, bodies, keys, posts: () => posts };
}
async function edit() {
  fireEvent.click(await screen.findByRole('button', { name: 'Durumu kaydet' }));
  await screen.findByRole('form', { name: 'Paylaşım / onay kaydı' });
}
it('reads only common event history until the worker explicitly opens actual Task context', async () => {
  const s = setup();
  await screen.findByText('Bu fiyat için henüz paylaşım veya onay kaydı yok.');
  expect(s.fetcher.mock.calls.every(([url]) => !String(url).includes('event-context'))).toBe(true);
  await edit();
  fireEvent.click(screen.getByRole('button', { name: 'Kaydı onayla' }));
  await screen.findByText('Müşteriye iletildi kaydı doğrulandı.');
  expect(JSON.parse(s.bodies[0]!)).toMatchObject({
    revisionId: 'rev2',
    expectedCaseVersion: 4,
    expectedTaskId: 'real-task',
    expectedTaskVersion: 7,
    event: 'SHARED',
  });
  expect(s.changed).toHaveBeenCalledOnce();
});
it('does not invent another employee Task when private context is unavailable', async () => {
  const s = setup({ denied: true });
  fireEvent.click(await screen.findByRole('button', { name: 'Durumu kaydet' }));
  expect((await screen.findByRole('alert')).textContent).toMatch(
    /gerçek takip görevine erişiminiz/,
  );
  expect(screen.queryByRole('button', { name: 'Kaydı onayla' })).toBeNull();
  expect(s.posts()).toBe(0);
});
it('retries uncertain writes with the frozen body/key and blocks closing or cancelling', async () => {
  const s = setup({ uncertain: true });
  await edit();
  fireEvent.click(screen.getByRole('button', { name: 'Kaydı onayla' }));
  await screen.findByRole('button', { name: 'Aynı işlemi yeniden dene' });
  expect(screen.getByRole('button', { name: 'Paylaşımı kapat' }).hasAttribute('disabled')).toBe(
    true,
  );
  expect(screen.getByRole('button', { name: 'Vazgeç' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Aynı işlemi yeniden dene' }));
  await screen.findByText('Müşteriye iletildi kaydı doğrulandı.');
  expect(s.bodies[1]).toBe(s.bodies[0]);
  expect(s.keys[1]).toBe(s.keys[0]);
});
it('uses only GET after a confirmed POST when exact operation readback fails', async () => {
  const s = setup({ proofFail: true });
  await edit();
  fireEvent.click(screen.getByRole('button', { name: 'Kaydı onayla' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Kaydı yeniden doğrula' }));
  await screen.findByText('Müşteriye iletildi kaydı doğrulandı.');
  expect(s.posts()).toBe(1);
});
it('preserves stale time input and requires an explicit context refresh before a new command', async () => {
  const s = setup({ conflict: true });
  await edit();
  const time = screen.getByLabelText('İşlem zamanı · İstanbul (zorunlu)');
  fireEvent.change(time, { target: { value: '2026-11-01T12:30:00' } });
  fireEvent.click(screen.getByRole('button', { name: 'Kaydı onayla' }));
  const refresh = await screen.findByRole('button', {
    name: 'Taslağı koru, güncel durumu kontrol et',
  });
  expect((time as HTMLInputElement).value).toBe('2026-11-01T12:30');
  expect(s.posts()).toBe(1);
  expect(screen.getByRole('button', { name: 'Kaydı onayla' }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(refresh);
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Kaydı onayla' }).hasAttribute('disabled')).toBe(
      false,
    ),
  );
});
it('rejects a mismatched event receipt and never exposes an unoffered acceptance choice', async () => {
  const s = setup({ wrongProof: true });
  await edit();
  expect(screen.queryByLabelText('Müşteri kabul etti')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Kaydı onayla' }));
  await screen.findByRole('button', { name: 'Kaydı yeniden doğrula' });
  expect(s.changed).not.toHaveBeenCalled();
  expect(s.posts()).toBe(1);
});

it('locks sibling price actions and propagates the event draft to navigation protection', async () => {
  const s = setup({ integrated: true });
  fireEvent.click(await screen.findByRole('button', { name: 'Paylaşım / onay' }));
  await edit();
  await waitFor(() => expect(s.risk).toHaveBeenLastCalledWith({ dirty: true, unresolved: false }));
  for (const name of ['Şirket fiyatı ekle', 'Fiyatı güncelle', 'Fiyatları yenile'])
    expect(screen.getByRole('button', { name }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Vazgeç' }));
  await waitFor(() => expect(s.risk).toHaveBeenLastCalledWith({ dirty: false, unresolved: false }));
});

it('rejects history returned for a different price revision', async () => {
  setup({ wrongHistory: true });
  await screen.findByRole('button', { name: 'Paylaşım geçmişini yeniden yükle' });
  expect(screen.queryByText('Bu fiyat için henüz paylaşım veya onay kaydı yok.')).toBeNull();
  expect(screen.queryByText('Kayıt zamanı:')).toBeNull();
});
