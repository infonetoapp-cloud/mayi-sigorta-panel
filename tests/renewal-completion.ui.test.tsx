// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RenewalWorkspacePanel } from '../src/app/components/RenewalWorkspacePanel';
import { TodayWorkPanel } from '../src/app/components/TodayWorkPanel';
import type { TodayTaskDto } from '../src/shared/types';

const reasons = [
  { id: 'price', code: 'PRICE', name: 'Fiyat' },
  { id: 'other', code: 'OTHER', name: 'Diğer neden' },
];
const policy = {
  id: 'new-policy',
  policyNumber: 'YENI-42',
  version: 8,
  grossPremiumMinor: 42050,
  currency: 'EUR',
  product: { id: 'product', name: 'Kasko' },
};
const page = { items: [{ ...policy, endDate: '2027-10-01' }], nextCursor: null };
function response(data: unknown, status = 200) {
  return new Response(
    JSON.stringify(
      status >= 400
        ? { success: false, error: { code: 'CONFLICT', message: 'unsafe SQL internal' } }
        : { success: true, data },
    ),
    { status },
  );
}
function fixture(
  override?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined,
) {
  const fetcher = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const result = override?.(url, init);
    if (result) return result;
    if (url.endsWith('/interactions'))
      return response({
        interactions: [],
        lastContactAt: null,
        lastAttemptAt: null,
        customerType: 'INDIVIDUAL',
        companyContacts: [],
      });
    if (url.endsWith('/quotes'))
      return response({
        quotes: [],
        defaultVersion: { grossPremiumMinor: 10000, currency: 'TRY' },
      });
    if (url.endsWith('/catalogs/selectable')) return response({ lossReasons: reasons });
    if (url.includes('/api/policies?')) return response(page);
    if (url.endsWith('/api/policies/new-policy')) return response(policy);
    if (url.includes('/close-') || url.endsWith('/void'))
      return response({ data: { operationId: 'op' } }, 201);
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
async function open(
  action: 'WON' | 'LOST' | 'VOIDED',
  refreshCompletionVersions?: () => Promise<{ renewalVersion: number; taskVersion: number }>,
) {
  const onTerminalOutcome = vi.fn();
  render(
    <RenewalWorkspacePanel
      renewalId="renewal"
      customerId="customer"
      customerDisplayName="Deneme"
      renewalVersion={4}
      taskId="task"
      taskVersion={3}
      getCsrfToken={async () => 'csrf'}
      invalidateCsrfToken={() => undefined}
      onTerminalOutcome={onTerminalOutcome}
      refreshCompletionVersions={refreshCompletionVersions}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'İletişim, teklif ve sonuçları aç: Deneme' }));
  fireEvent.change(await screen.findByLabelText('Sonuç türü: Deneme'), {
    target: { value: action },
  });
  return onTerminalOutcome;
}
function posts(fetcher: ReturnType<typeof fixture>) {
  return fetcher.mock.calls.filter(
    ([url, init]) => String(url).includes('/close-') && init?.method === 'POST',
  );
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Employee renewal completion', () => {
  it('pins the already selected task identity in the legacy VOIDED payload', async () => {
    const fetcher = fixture();
    const completed = await open('VOIDED');
    fireEvent.click(screen.getByRole('button', { name: 'VOIDED sonucunu kaydet: Deneme' }));
    await waitFor(() => expect(completed).toHaveBeenCalledOnce());
    const call = fetcher.mock.calls.find(
      ([url, init]) => String(url).endsWith('/void') && init?.method === 'POST',
    );
    expect(JSON.parse(String(call?.[1]?.body))).toEqual({
      expectedPrimaryTaskId: 'task',
      expectedRenewalVersion: 4,
      expectedTaskVersion: 3,
      voidReasonCode: 'TECHNICAL_ERROR',
    });
  });
  it('uses authorized policy detail version/premium/currency rather than quote defaults or list values', async () => {
    const fetcher = fixture((url) =>
      url.includes('/api/policies?')
        ? response({
            ...page,
            items: [{ ...page.items[0], version: 1, grossPremiumMinor: 1, currency: 'TRY' }],
          })
        : undefined,
    );
    const completed = await open('WON');
    fireEvent.change(await screen.findByLabelText('Bağlanacak poliçe: Deneme'), {
      target: { value: policy.id },
    });
    await screen.findByText('Seçilen poliçe: YENI-42 · 420,50 EUR');
    expect(screen.queryByLabelText('Poliçe sürümü: Deneme')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Kazanıldı sonucunu kaydet: Deneme' }));
    await waitFor(() => expect(completed).toHaveBeenCalledOnce());
    const request = posts(fetcher)[0]![1]!;
    expect(JSON.parse(String(request.body))).toEqual({
      expectedPrimaryTaskId: 'task',
      expectedRenewalVersion: 4,
      expectedTaskVersion: 3,
      result: {
        kind: 'LINK_POLICY',
        newPolicyId: policy.id,
        expectedPolicyVersion: 8,
        allocatedNewPremiumMinor: 42050,
        currency: 'EUR',
      },
    });
    expect(request.headers).toMatchObject({ 'X-CSRF-Token': 'csrf' });
    const listUrl = String(
      fetcher.mock.calls.find(([url]) => String(url).includes('/api/policies?'))![0],
    );
    expect(new URL(listUrl, 'https://test').searchParams.get('customerId')).toBe('customer');
  });

  it.each(['price', 'other'])(
    'submits Turkish catalog choice %s with explanation only for OTHER',
    async (reason) => {
      const fetcher = fixture();
      const completed = await open('LOST');
      await screen.findByRole('option', { name: 'Diğer neden' });
      fireEvent.change(screen.getByLabelText('Kayıp nedeni: Deneme'), {
        target: { value: reason },
      });
      if (reason === 'other') {
        const explanation = screen.getByLabelText('Kayıp açıklaması: Deneme');
        expect((explanation as HTMLTextAreaElement).required).toBe(true);
        fireEvent.submit(explanation.closest('form')!);
        await screen.findByText('Diğer kayıp nedeni için açıklama zorunludur.');
        expect(posts(fetcher)).toHaveLength(0);
        fireEvent.change(explanation, { target: { value: '  Müşteri aracı sattı.  ' } });
      }
      fireEvent.click(screen.getByRole('button', { name: 'Kaybedildi sonucunu kaydet: Deneme' }));
      await waitFor(() => expect(completed).toHaveBeenCalledOnce());
      expect(JSON.parse(String(posts(fetcher)[0]![1]!.body))).toEqual({
        expectedPrimaryTaskId: 'task',
        expectedRenewalVersion: 4,
        expectedTaskVersion: 3,
        lossReasonId: reason,
        lossReasonNotes: reason === 'other' ? 'Müşteri aracı sattı.' : null,
      });
    },
  );

  it('retains OTHER draft on 409 and refreshes versions without auto-submitting or losing explanation', async () => {
    let count = 0;
    const fetcher = fixture((url) =>
      url.endsWith('/close-lost') && ++count === 1 ? response(null, 409) : undefined,
    );
    const refresh = vi.fn(async () => ({ renewalVersion: 6, taskVersion: 5 }));
    const completed = await open('LOST', refresh);
    await screen.findByRole('option', { name: 'Diğer neden' });
    fireEvent.change(screen.getByLabelText('Kayıp nedeni: Deneme'), { target: { value: 'other' } });
    fireEvent.change(screen.getByLabelText('Kayıp açıklaması: Deneme'), {
      target: { value: 'Açıklama korunacak.' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Kaybedildi sonucunu kaydet: Deneme' }));
    await screen.findByText(/Kayıt değişti. Taslağınız korundu/);
    expect(screen.queryByText('unsafe SQL internal')).toBeNull();
    expect((screen.getByLabelText('Kayıp açıklaması: Deneme') as HTMLTextAreaElement).value).toBe(
      'Açıklama korunacak.',
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'Güncel bilgileri yükle / poliçeyi yeniden seç' }),
    );
    await screen.findByText(/Güncel iş bilgileri yüklendi/);
    expect(posts(fetcher)).toHaveLength(1);
    expect(
      (screen.getByLabelText('Kayıp nedeni: Deneme') as unknown as HTMLSelectElement).value,
    ).toBe('other');
    fireEvent.click(screen.getByRole('button', { name: 'Kaybedildi sonucunu kaydet: Deneme' }));
    await waitFor(() => expect(completed).toHaveBeenCalledOnce());
    expect(JSON.parse(String(posts(fetcher)[1]![1]!.body))).toMatchObject({
      expectedRenewalVersion: 6,
      expectedTaskVersion: 5,
      lossReasonNotes: 'Açıklama korunacak.',
    });
    expect(posts(fetcher)[1]![1]!.headers).not.toEqual(posts(fetcher)[0]![1]!.headers);
  });

  it('retries ambiguous failure with identical body and idempotency key; edited payload gets a new key', async () => {
    let count = 0;
    const fetcher = fixture((url) =>
      url.endsWith('/close-lost') && ++count < 3 ? Promise.reject(new Error('network')) : undefined,
    );
    const completed = await open('LOST');
    await screen.findByRole('option', { name: 'Diğer neden' });
    fireEvent.change(screen.getByLabelText('Kayıp nedeni: Deneme'), { target: { value: 'other' } });
    fireEvent.change(screen.getByLabelText('Kayıp açıklaması: Deneme'), {
      target: { value: 'İlk açıklama' },
    });
    const submit = screen.getByRole('button', { name: 'Kaybedildi sonucunu kaydet: Deneme' });
    fireEvent.click(submit);
    await screen.findByText('network');
    fireEvent.click(submit);
    await waitFor(() => expect(posts(fetcher)).toHaveLength(2));
    await screen.findByText('network');
    expect(posts(fetcher)[1]![1]!.body).toBe(posts(fetcher)[0]![1]!.body);
    expect(posts(fetcher)[1]![1]!.headers).toEqual(posts(fetcher)[0]![1]!.headers);
    fireEvent.change(screen.getByLabelText('Kayıp açıklaması: Deneme'), {
      target: { value: 'Düzeltilmiş açıklama' },
    });
    fireEvent.click(submit);
    await waitFor(() => expect(completed).toHaveBeenCalledOnce());
    expect(posts(fetcher)[2]![1]!.headers).not.toEqual(posts(fetcher)[0]![1]!.headers);
  });

  it('refreshes the actual Today Work task without unmounting the completion draft', async () => {
    const task: TodayTaskDto = {
      taskId: 'task',
      renewalId: 'renewal',
      customerId: 'customer',
      customerDisplayName: 'Deneme',
      customerEmail: null,
      customerPhone: null,
      policyId: 'old',
      policyNumber: 'ESKI',
      policyEndDate: '2026-10-16',
      title: 'Takip',
      dueAt: '2026-10-16T06:00:00.000Z',
      assigneeMembershipId: 'member',
      taskVersion: 3,
      renewalAssigneeMembershipId: 'member',
      renewalState: 'CONTACT_PENDING',
      renewalVersion: 4,
      bucket: 'TODAY',
      isUnassigned: false,
    };
    let reads = 0;
    let writes = 0;
    const fetcher = fixture((url) => {
      if (url === '/api/tasks/today')
        return response({
          items: [{ ...task, ...(++reads > 1 ? { renewalVersion: 6, taskVersion: 5 } : {}) }],
          unassignedItems: [],
          hasMore: false,
          nextCursor: null,
          canAssign: false,
          canSeeUnassigned: false,
          timezone: 'Europe/Istanbul',
          todayLocalDate: '2026-10-16',
        });
      if (url.endsWith('/close-lost') && ++writes === 1) return response(null, 409);
      return undefined;
    });
    render(
      <TodayWorkPanel getCsrfToken={async () => 'csrf'} invalidateCsrfToken={() => undefined} />,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'İletişim, teklif ve sonuçları aç: Deneme' }),
    );
    fireEvent.change(await screen.findByLabelText('Sonuç türü: Deneme'), {
      target: { value: 'LOST' },
    });
    await screen.findByRole('option', { name: 'Diğer neden' });
    fireEvent.change(screen.getByLabelText('Kayıp nedeni: Deneme'), { target: { value: 'other' } });
    fireEvent.change(screen.getByLabelText('Kayıp açıklaması: Deneme'), {
      target: { value: 'Taslak' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Kaybedildi sonucunu kaydet: Deneme' }));
    await screen.findByText(/Kayıt değişti. Taslağınız korundu/);
    fireEvent.click(
      screen.getByRole('button', { name: 'Güncel bilgileri yükle / poliçeyi yeniden seç' }),
    );
    await screen.findByText(/Güncel iş bilgileri yüklendi/);
    expect((screen.getByLabelText('Kayıp açıklaması: Deneme') as HTMLTextAreaElement).value).toBe(
      'Taslak',
    );
    expect(reads).toBe(2);
    expect(posts(fetcher)).toHaveLength(1);
  });

  it('preserves WON selection on conflict, then requires authoritative reselection before retry', async () => {
    let count = 0;
    let detailReads = 0;
    const fetcher = fixture((url) => {
      if (url.endsWith('/close-won') && ++count === 1) return response(null, 409);
      if (url.endsWith('/api/policies/new-policy'))
        return response({
          ...policy,
          version: ++detailReads === 1 ? 8 : 9,
          grossPremiumMinor: detailReads === 1 ? 42050 : 43000,
        });
      return undefined;
    });
    const completed = await open('WON', async () => ({ renewalVersion: 5, taskVersion: 4 }));
    fireEvent.change(await screen.findByLabelText('Bağlanacak poliçe: Deneme'), {
      target: { value: policy.id },
    });
    await screen.findByText(/Seçilen poliçe: YENI-42/);
    fireEvent.click(screen.getByRole('button', { name: 'Kazanıldı sonucunu kaydet: Deneme' }));
    await screen.findByText(/Kayıt değişti. Taslağınız korundu/);
    expect(screen.getByText(/Seçilen poliçe: YENI-42/)).toBeTruthy();
    fireEvent.click(
      screen.getByRole('button', { name: 'Güncel bilgileri yükle / poliçeyi yeniden seç' }),
    );
    await screen.findByText(/Güncel iş bilgileri yüklendi/);
    expect(
      (
        screen.getByRole('button', {
          name: 'Kazanıldı sonucunu kaydet: Deneme',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(posts(fetcher)).toHaveLength(1);
    await waitFor(() =>
      expect(
        (screen.getByLabelText('Bağlanacak poliçe: Deneme') as unknown as HTMLSelectElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.change(screen.getByLabelText('Bağlanacak poliçe: Deneme'), {
      target: { value: policy.id },
    });
    await screen.findByText('Seçilen poliçe: YENI-42 · 430,00 EUR');
    fireEvent.click(screen.getByRole('button', { name: 'Kazanıldı sonucunu kaydet: Deneme' }));
    await waitFor(() => expect(completed).toHaveBeenCalledOnce());
    expect(JSON.parse(String(posts(fetcher)[1]![1]!.body))).toMatchObject({
      expectedRenewalVersion: 5,
      expectedTaskVersion: 4,
      result: { expectedPolicyVersion: 9, allocatedNewPremiumMinor: 43000, currency: 'EUR' },
    });
  });

  it('retries exactly the failed policy cursor and searches by an authorized server query', async () => {
    let pageReads = 0;
    const fetcher = fixture((url) => {
      if (url.includes('cursor=page-2'))
        return ++pageReads === 1
          ? response(null, 503)
          : response({
              items: [{ ...policy, id: 'second', policyNumber: 'IKINCI', endDate: '2027-11-01' }],
              nextCursor: null,
            });
      if (url.includes('/api/policies?')) return response({ ...page, nextCursor: 'page-2' });
      return undefined;
    });
    await open('WON');
    fireEvent.click(await screen.findByRole('button', { name: 'Daha fazla poliçe' }));
    await screen.findByText('Poliçeler yüklenemedi veya erişim izniniz yok.');
    expect(screen.getByRole('option', { name: 'YENI-42 — 2027-10-01' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Poliçe listesini yeniden dene' }));
    await screen.findByRole('option', { name: 'IKINCI — 2027-11-01' });
    expect(pageReads).toBe(2);
    fireEvent.change(screen.getByLabelText('Poliçe numarasıyla ara: Deneme'), {
      target: { value: 'YENI' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Poliçeleri ara' }));
    await waitFor(() =>
      expect(
        fetcher.mock.calls.some(
          ([url]) =>
            String(url).includes('search=YENI') && String(url).includes('searchMode=prefix'),
        ),
      ).toBe(true),
    );
    await screen.findByRole('option', { name: 'YENI-42 — 2027-10-01' });
    expect(screen.queryByRole('option', { name: 'IKINCI — 2027-11-01' })).toBeNull();
  });

  it('uses Enter in policy search for searching, never for completing the renewal', async () => {
    const fetcher = fixture();
    await open('WON');
    fireEvent.change(await screen.findByLabelText('Bağlanacak poliçe: Deneme'), {
      target: { value: policy.id },
    });
    await screen.findByText(/Seçilen poliçe: YENI-42/);
    const input = screen.getByLabelText('Poliçe numarasıyla ara: Deneme');
    fireEvent.change(input, { target: { value: 'YENI' } });
    expect(fireEvent.keyDown(input, { key: 'Enter', code: 'Enter' })).toBe(false);
    await waitFor(() =>
      expect(fetcher.mock.calls.some(([url]) => String(url).includes('search=YENI'))).toBe(true),
    );
    expect(posts(fetcher)).toHaveLength(0);
  });

  it('fails closed on catalog errors and preserves explanation if conflict refresh fails', async () => {
    const fetcher = fixture((url) =>
      url.endsWith('/close-lost') ? response(null, 409) : undefined,
    );
    await open('LOST', async () => {
      throw new Error('unsafe SQL internal');
    });
    await screen.findByRole('option', { name: 'Diğer neden' });
    fireEvent.change(screen.getByLabelText('Kayıp nedeni: Deneme'), { target: { value: 'other' } });
    fireEvent.change(screen.getByLabelText('Kayıp açıklaması: Deneme'), {
      target: { value: 'Korunacak' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Kaybedildi sonucunu kaydet: Deneme' }));
    await screen.findByText(/Kayıt değişti/);
    fireEvent.click(
      screen.getByRole('button', { name: 'Güncel bilgileri yükle / poliçeyi yeniden seç' }),
    );
    await screen.findByText(/Güncel iş bilgileri yüklenemedi/);
    expect((screen.getByLabelText('Kayıp açıklaması: Deneme') as HTMLTextAreaElement).value).toBe(
      'Korunacak',
    );
    expect(screen.queryByText(/unsafe SQL/)).toBeNull();
    expect(posts(fetcher)).toHaveLength(1);
    vi.mocked(fetch).mockImplementation(async () => response(null, 403));
    fireEvent.click(screen.getByRole('button', { name: 'Kayıp nedenlerini yenile' }));
    await screen.findByText('Kayıp nedenleri yüklenemedi veya erişilemiyor.');
    expect(
      (
        screen.getByRole('button', {
          name: 'Kaybedildi sonucunu kaydet: Deneme',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });

  it('clears a hidden difference reason when reselecting a policy matching the sent quote', async () => {
    let details = 0;
    const fetcher = fixture((url) => {
      if (url.endsWith('/quotes'))
        return response({
          quotes: [
            {
              id: 'q',
              status: 'SENT',
              version: 2,
              current_version_id: 'qv',
              accepted_version_id: null,
              versions: [
                {
                  id: 'qv',
                  version_number: 1,
                  product_id: 'product',
                  product_name: 'Kasko',
                  gross_premium_minor: 42050,
                  currency: 'EUR',
                },
              ],
              events: [{ event: 'SENT', quote_version_id: 'qv' }],
            },
          ],
          defaultVersion: { grossPremiumMinor: 10000, currency: 'TRY' },
        });
      if (url.endsWith('/api/policies/new-policy'))
        return response({ ...policy, grossPremiumMinor: ++details === 1 ? 40000 : 42050 });
      return undefined;
    });
    const completed = await open('WON');
    fireEvent.change(await screen.findByLabelText('Bağlanacak poliçe: Deneme'), {
      target: { value: policy.id },
    });
    await screen.findByText(/Seçilen poliçe: YENI-42/);
    fireEvent.change(screen.getByLabelText('Kabul edilen teklif sürümü: Deneme'), {
      target: { value: 'qv' },
    });
    fireEvent.change(await screen.findByLabelText('Ürün/prim farkı nedeni: Deneme'), {
      target: { value: 'INSURER_REQUOTE' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Poliçe listesini yenile / yeniden seç' }));
    await waitFor(() =>
      expect(
        (screen.getByLabelText('Bağlanacak poliçe: Deneme') as unknown as HTMLSelectElement)
          .disabled,
      ).toBe(false),
    );
    fireEvent.change(screen.getByLabelText('Bağlanacak poliçe: Deneme'), {
      target: { value: policy.id },
    });
    await screen.findByText('Seçilen poliçe: YENI-42 · 420,50 EUR');
    expect(screen.queryByLabelText('Ürün/prim farkı nedeni: Deneme')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Kazanıldı sonucunu kaydet: Deneme' }));
    await waitFor(() => expect(completed).toHaveBeenCalledOnce());
    expect(JSON.parse(String(posts(fetcher)[0]![1]!.body))).not.toHaveProperty(
      'quoteDifferenceReasonCode',
    );
  });

  it('clears a policy denied by authoritative detail and never submits it', async () => {
    const fetcher = fixture((url) =>
      url.endsWith('/api/policies/new-policy') ? response(null, 404) : undefined,
    );
    await open('WON');
    fireEvent.change(await screen.findByLabelText('Bağlanacak poliçe: Deneme'), {
      target: { value: policy.id },
    });
    await screen.findByText(/Seçilen poliçeye erişilemiyor/);
    expect(screen.queryByText(/unsafe SQL/)).toBeNull();
    expect(
      (
        screen.getByRole('button', {
          name: 'Kazanıldı sonucunu kaydet: Deneme',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(posts(fetcher)).toHaveLength(0);
  });
});
