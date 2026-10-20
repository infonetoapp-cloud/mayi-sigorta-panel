import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { RenewalInteractionsSection } from '../src/app/pages/today-work/RenewalInteractionsSection';
import { invalidateCsrfToken } from '../src/app/csrf';
import { MemoryRouter } from 'react-router';
import TodayWorkPage from '../src/app/pages/today-work/TodayWorkPage';
import type { TodayTaskDto, TodayTasksResponseData } from '../src/shared/types';
import {
  localOccurrence,
  canonicalOccurrence,
  type InteractionHistory,
} from '../src/app/pages/today-work/interaction-model';
const empty: InteractionHistory = {
  interactions: [],
  lastContactAt: null,
  lastAttemptAt: null,
  customerType: 'INDIVIDUAL',
  companyContacts: [],
};
const response = (data: unknown, status = 200) =>
  new Response(
    JSON.stringify(
      status < 400
        ? { success: true, data }
        : { success: false, error: { code: 'FORBIDDEN', message: 'unsafe SQL diagnostic' } },
    ),
    { status },
  );
beforeEach(() => invalidateCsrfToken());
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function fixture(
  override?: (url: string, init?: RequestInit) => Response | Promise<Response> | undefined,
  initial: InteractionHistory = empty,
) {
  let current: InteractionHistory = initial;
  const fetcher = vi.fn(async (url: string, init?: RequestInit) => {
    const custom = override?.(url, init);
    if (custom) return custom;
    if (url.endsWith('csrf-token')) return response({ token: 'csrf' });
    if (!init?.method && url !== '/api/renewals/r/interactions') return response(empty);
    if (init?.method === 'POST') {
      const body = JSON.parse(String(init.body));
      current = {
        ...current,
        interactions: [
          {
            id: 'saved',
            outcome: body.outcome,
            channel: body.channel,
            occurred_at: body.occurredAt,
            note: body.note,
            company_contact_id: body.companyContactId,
            author_name: 'Kayıt Yazarı',
          },
        ],
      };
      return response(
        {
          interactionId: 'saved',
          renewalId: 'r',
          outcome: body.outcome,
          occurredAt: body.occurredAt,
        },
        201,
      );
    }
    return response(current);
  });
  vi.stubGlobal('fetch', fetcher);
  return fetcher;
}
function mount(id = 'r', risk = vi.fn()) {
  return render(<RenewalInteractionsSection renewalId={id} onRiskChange={risk} />);
}
async function draft(outcome = 'NOTE', channel = 'OTHER') {
  fireEvent.click(await screen.findByRole('button', { name: 'İletişim kaydı ekle' }));
  fireEvent.change(screen.getByLabelText('Görüşme sonucu'), { target: { value: outcome } });
  if (outcome !== 'NOTE')
    fireEvent.change(screen.getByLabelText('İletişim kanalı'), { target: { value: channel } });
  fireEvent.change(screen.getByLabelText('Gerçekleşme zamanı (İstanbul)'), {
    target: { value: '2026-10-18T00:30:00' },
  });
  if (outcome === 'NOTE')
    fireEvent.change(screen.getByLabelText('İç not'), { target: { value: 'Taslak not' } });
  else if (outcome === 'CONTACT_CONFIRMED')
    fireEvent.click(screen.getByLabelText('Gerçek müşteri temasının gerçekleştiğini doğruluyorum'));
}
it('converts explicit Istanbul local occurrence to canonical UTC without inferring invalid dates', () => {
  expect(canonicalOccurrence('2026-10-18T00:30:00')).toBe('2026-10-17T21:30:00.000Z');
  expect(localOccurrence('2026-10-17T21:30:00.000Z')).toBe('2026-10-18T00:30:00');
  expect(canonicalOccurrence('2026-02-30T00:00:00')).toBeNull();
});
it('reads history without loading quotes or personnel and preserves missing historical metadata honestly', async () => {
  const f = fixture((url) =>
    url.endsWith('/interactions')
      ? response({
          ...empty,
          interactions: [
            {
              id: 'old',
              outcome: 'WHATSAPP_OPENED',
              channel: 'WHATSAPP',
              occurred_at: null,
              author_name: null,
              note: 'Geçmiş not',
            },
          ],
        })
      : undefined,
  );
  mount();
  await screen.findByText('Geçmiş not');
  expect(screen.getByText('Kaydeden: Çalışan adı mevcut değil')).toBeTruthy();
  expect(screen.getAllByText('Tarih bilgisi bulunmuyor').length).toBeGreaterThan(0);
  expect(f.mock.calls.map(([url]) => url)).toEqual(['/api/renewals/r/interactions']);
  expect(screen.getByText(/WhatsApp açıldı; gerçek temas değildir/)).toBeTruthy();
});
it('creates a note with OTHER/null contact, no invented CAS, then verifies authorized readback', async () => {
  const f = fixture();
  const risk = vi.fn();
  mount('r', risk);
  await draft();
  fireEvent.click(screen.getByRole('button', { name: 'İletişim kaydını kaydet' }));
  await screen.findByText('İletişim kaydı kaydedildi ve geçmiş güncellendi.');
  await waitFor(() => expect(risk).toHaveBeenLastCalledWith('clean'));
  const request = f.mock.calls.find(([, i]) => i?.method === 'POST')!;
  expect(JSON.parse(String(request[1]!.body))).toEqual({
    outcome: 'NOTE',
    channel: 'OTHER',
    occurredAt: '2026-10-17T21:30:00.000Z',
    companyContactId: null,
    note: 'Taslak not',
  });
  expect(f.mock.calls.filter(([u, i]) => u.endsWith('/interactions') && !i?.method)).toHaveLength(
    2,
  );
});
it.each([
  ['CONTACT_CONFIRMED', 'PHONE'],
  ['ATTEMPT_NO_RESPONSE', 'EMAIL'],
  ['ATTEMPT_NO_RESPONSE', 'WHATSAPP'],
])('records %s via %s without note text or a WhatsApp-open action', async (outcome, channel) => {
  const f = fixture();
  mount();
  await draft(outcome, channel);
  expect(screen.queryByRole('option', { name: 'WhatsApp açıldı' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'İletişim kaydını kaydet' }));
  await screen.findByText('İletişim kaydı kaydedildi ve geçmiş güncellendi.');
  const sent = JSON.parse(String(f.mock.calls.find(([, i]) => i?.method === 'POST')![1]!.body));
  expect(sent).toMatchObject({ outcome, channel, note: null, companyContactId: null });
  expect(f.mock.calls.some(([u]) => u.includes('whatsapp'))).toBe(false);
});
it('requires actual contact confirmation rather than treating a call attempt as contact proof', async () => {
  const f = fixture();
  mount();
  await draft('CONTACT_CONFIRMED', 'PHONE');
  fireEvent.click(screen.getByLabelText('Gerçek müşteri temasının gerçekleştiğini doğruluyorum'));
  fireEvent.click(screen.getByRole('button', { name: 'İletişim kaydını kaydet' }));
  await screen.findByRole('alert');
  expect(f.mock.calls.some(([, i]) => i?.method === 'POST')).toBe(false);
});
it('requires an explicit authorized company contact and never selects the first one automatically', async () => {
  const f = fixture(undefined, {
    ...empty,
    customerType: 'COMPANY',
    companyContacts: [{ id: 'contact', displayName: 'Yetkili Kişi', role: 'Finans' }],
  });
  mount();
  await draft();
  expect((screen.getByLabelText('Şirket yetkilisi') as unknown as HTMLSelectElement).value).toBe(
    '',
  );
  fireEvent.click(screen.getByRole('button', { name: 'İletişim kaydını kaydet' }));
  await screen.findByRole('alert');
  expect(f.mock.calls.some(([, i]) => i?.method)).toBe(false);
  fireEvent.change(screen.getByLabelText('Şirket yetkilisi'), { target: { value: 'contact' } });
  fireEvent.click(screen.getByRole('button', { name: 'İletişim kaydını kaydet' }));
  await screen.findByText('İletişim kaydı kaydedildi ve geçmiş güncellendi.');
  expect(
    JSON.parse(String(f.mock.calls.find(([, i]) => i?.method)![1]!.body)).companyContactId,
  ).toBe('contact');
});
it.each([503, 429])(
  'prevents double submit and permits only exact timestamp/body/key retry after %i',
  async (status) => {
    let writes = 0;
    const f = fixture((_u, i) =>
      i?.method === 'POST' && ++writes === 1 ? response(null, status) : undefined,
    );
    mount();
    await draft();
    const form = screen.getByRole('form', { name: 'Yeni iletişim kaydı' });
    fireEvent.submit(form);
    fireEvent.submit(form);
    await screen.findByRole('button', { name: 'Aynı iletişim isteğini yeniden dene' });
    expect(writes).toBe(1);
    expect(
      screen.getByRole('button', { name: 'İletişim kaydını kaydet' }).hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Aynı iletişim isteğini yeniden dene' }));
    await screen.findByText('İletişim kaydı kaydedildi ve geçmiş güncellendi.');
    const attempts = f.mock.calls.filter(([, i]) => i?.method === 'POST');
    expect(attempts).toHaveLength(2);
    expect(attempts[0]![0] === attempts[1]![0]).toBe(true);
    expect(attempts[0]![1]!.body === attempts[1]![1]!.body).toBe(true);
    expect(
      JSON.stringify(attempts[0]![1]!.headers) === JSON.stringify(attempts[1]![1]!.headers),
    ).toBe(true);
  },
);
it('retries GET only when a successful write has failed authorized readback', async () => {
  let reads = 0;
  const f = fixture((url, i) =>
    url.endsWith('/interactions') && !i?.method && ++reads === 2 ? response(null, 503) : undefined,
  );
  mount();
  await draft();
  fireEvent.click(screen.getByRole('button', { name: 'İletişim kaydını kaydet' }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Kaydedilen iletişim geçmişini yeniden oku' }),
  );
  await screen.findByText('İletişim kaydı kaydedildi ve geçmiş güncellendi.');
  expect(f.mock.calls.filter(([, i]) => i?.method === 'POST')).toHaveLength(1);
});
it.each(['id', 'note'])(
  'does not confirm a successful GET without matching %s proof and retries GET only',
  async (field) => {
    let reads = 0;
    const f = fixture((url, i) =>
      url.endsWith('/interactions') && !i?.method && ++reads === 2
        ? response({
            ...empty,
            interactions: [
              {
                id: field === 'id' ? 'unrelated' : 'saved',
                outcome: 'NOTE',
                channel: 'OTHER',
                occurred_at: '2026-10-17T21:30:00.000Z',
                note: field === 'note' ? 'Different' : 'Taslak not',
                company_contact_id: null,
                author_name: null,
              },
            ],
          })
        : undefined,
    );
    mount();
    await draft();
    fireEvent.click(screen.getByRole('button', { name: 'İletişim kaydını kaydet' }));
    const retry = await screen.findByRole('button', {
      name: 'Kaydedilen iletişim geçmişini yeniden oku',
    });
    expect(screen.queryByText('İletişim kaydı kaydedildi ve geçmiş güncellendi.')).toBeNull();
    fireEvent.click(retry);
    await screen.findByText('İletişim kaydı kaydedildi ve geçmiş güncellendi.');
    expect(f.mock.calls.filter(([, i]) => i?.method === 'POST')).toHaveLength(1);
  },
);
it('preserves a conflicting draft, refreshes authorized history and requires a new explicit confirmation', async () => {
  let writes = 0;
  const f = fixture((_u, i) =>
    i?.method === 'POST' && ++writes === 1 ? response(null, 409) : undefined,
  );
  mount();
  await draft();
  fireEvent.click(screen.getByRole('button', { name: 'İletişim kaydını kaydet' }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Güncel iletişim bilgilerini karşılaştır' }),
  );
  await screen.findByLabelText('Güncel bilgileri inceledim, taslağı yeniden göndermek istiyorum');
  expect((screen.getByLabelText('İç not') as HTMLTextAreaElement).value).toBe('Taslak not');
  fireEvent.click(screen.getByRole('button', { name: 'İletişim kaydını kaydet' }));
  expect(writes).toBe(1);
  fireEvent.click(
    screen.getByLabelText('Güncel bilgileri inceledim, taslağı yeniden göndermek istiyorum'),
  );
  fireEvent.click(screen.getByRole('button', { name: 'İletişim kaydını kaydet' }));
  await screen.findByText('İletişim kaydı kaydedildi ve geçmiş güncellendi.');
  const attempts = f.mock.calls.filter(([, i]) => i?.method);
  expect(attempts[0]![1]!.body === attempts[1]![1]!.body).toBe(true);
  expect(
    JSON.stringify(attempts[0]![1]!.headers) === JSON.stringify(attempts[1]![1]!.headers),
  ).toBe(false);
});
it('does not replace a company contact removed by the authorized conflict refresh', async () => {
  let conflict = false;
  const company = {
    ...empty,
    customerType: 'COMPANY' as const,
    companyContacts: [{ id: 'old', displayName: 'Eski Yetkili', role: null }],
  };
  const f = fixture((u, i) => {
    if (i?.method) {
      conflict = true;
      return response(null, 409);
    }
    if (u.endsWith('/interactions') && conflict)
      return response({
        ...company,
        companyContacts: [{ id: 'new', displayName: 'Yeni Yetkili', role: null }],
      });
    return undefined;
  }, company);
  mount();
  await draft();
  fireEvent.change(screen.getByLabelText('Şirket yetkilisi'), { target: { value: 'old' } });
  fireEvent.click(screen.getByRole('button', { name: 'İletişim kaydını kaydet' }));
  fireEvent.click(
    await screen.findByRole('button', { name: 'Güncel iletişim bilgilerini karşılaştır' }),
  );
  await screen.findByLabelText('Güncel bilgileri inceledim, taslağı yeniden göndermek istiyorum');
  expect((screen.getByLabelText('Şirket yetkilisi') as unknown as HTMLSelectElement).value).toBe(
    'old',
  );
  fireEvent.click(
    screen.getByLabelText('Güncel bilgileri inceledim, taslağı yeniden göndermek istiyorum'),
  );
  fireEvent.click(screen.getByRole('button', { name: 'İletişim kaydını kaydet' }));
  expect(f.mock.calls.filter(([, i]) => i?.method)).toHaveLength(1);
});
it.each([403, 404])(
  'hides denied history/contact fields while preserving the draft for authorized recovery after %i',
  async (status) => {
    let writes = 0;
    const f = fixture((_u, i) =>
      i?.method && ++writes === 1 ? response(null, status) : undefined,
    );
    mount();
    await draft();
    fireEvent.click(screen.getByRole('button', { name: 'İletişim kaydını kaydet' }));
    await screen.findByRole('alert');
    expect(screen.queryByLabelText('İç not')).toBeNull();
    expect(document.body.textContent).not.toContain('unsafe SQL');
    fireEvent.click(
      screen.getByRole('button', { name: 'Güncel iletişim bilgilerini karşılaştır' }),
    );
    await screen.findByLabelText('İç not');
    expect((screen.getByLabelText('İç not') as HTMLTextAreaElement).value).toBe('Taslak not');
    expect(f.mock.calls.filter(([, i]) => i?.method)).toHaveLength(1);
  },
);
it('denies interaction access separately without touching quotes or the personnel directory', async () => {
  const f = fixture((url) => (url.endsWith('/interactions') ? response(null, 403) : undefined));
  mount();
  await screen.findByRole('alert');
  expect(screen.queryByRole('button', { name: 'İletişim kaydı ekle' })).toBeNull();
  expect(f.mock.calls.map(([u]) => u)).toEqual(['/api/renewals/r/interactions']);
});
it.each(['initial401', 'csrf401', 'write401', 'readback401'])(
  'ignores late %s after switching interaction context',
  async (stage) => {
    let release!: (r: Response) => void;
    const deferred = new Promise<Response>((resolve) => {
      release = resolve;
    });
    let waiting = false,
      writes = 0;
    const ended = vi.fn();
    document.addEventListener('mayi-session-ended', ended);
    try {
      fixture((u, i) => {
        if (i?.method === 'POST') writes++;
        if (
          (stage === 'initial401' && u === '/api/renewals/r/interactions') ||
          (stage === 'csrf401' && u.endsWith('csrf-token')) ||
          (stage === 'write401' && i?.method === 'POST') ||
          (stage === 'readback401' && u === '/api/renewals/r/interactions' && !i?.method && writes)
        ) {
          waiting = true;
          return deferred;
        }
        return undefined;
      });
      const view = mount();
      if (stage !== 'initial401') {
        await draft();
        fireEvent.click(screen.getByRole('button', { name: 'İletişim kaydını kaydet' }));
      }
      await waitFor(() => expect(waiting).toBe(true));
      view.rerender(<RenewalInteractionsSection key="b" renewalId="b" onRiskChange={() => {}} />);
      await screen.findByRole('button', { name: 'İletişim kaydı ekle' });
      await act(async () => release(response(null, 401)));
      expect(ended).not.toHaveBeenCalled();
      expect(screen.queryByText('Taslak not')).toBeNull();
      expect(screen.queryByRole('alert')).toBeNull();
    } finally {
      document.removeEventListener('mayi-session-ended', ended);
    }
  },
);
const queueTask = (id: string): TodayTaskDto => ({
  // Queue DTOs are the sole modern entry authority; endpoint authority is still checked independently.
  taskId: id,
  renewalId: id === 'a' ? 'r' : 'other',
  customerId: 'c',
  customerDisplayName: 'Kuyruk ' + id,
  customerEmail: null,
  customerPhone: null,
  policyId: null,
  policyNumber: null,
  policyEndDate: null,
  title: 'Takip',
  dueAt: '2026-10-17T21:30:00.000Z',
  assigneeMembershipId: 'member',
  taskVersion: 1,
  renewalAssigneeMembershipId: 'member',
  renewalState: 'CONTACT_PENDING',
  renewalVersion: 1,
  bucket: 'OVERDUE',
  isUnassigned: false,
});
const queue: TodayTasksResponseData = {
  items: [queueTask('a'), queueTask('b')],
  unassignedItems: [],
  hasMore: false,
  nextCursor: null,
  unassignedHasMore: false,
  unassignedNextCursor: null,
  canSeeUnassigned: true,
  canSeeReassignment: true,
  canAssign: true,
  timezone: 'Europe/Istanbul',
  now: '2026-10-18T00:00:00.000Z',
  todayLocalDate: '2026-10-18',
};
it('guards dirty navigation, retains submitted interaction attempts and ignores POST401 after unmount', async () => {
  let release!: (r: Response) => void;
  const deferred = new Promise<Response>((resolve) => {
    release = resolve;
  });
  let posted = false;
  const ended = vi.fn();
  document.addEventListener('mayi-session-ended', ended);
  try {
    fixture((u, i) => {
      if (u.startsWith('/api/tasks/today')) return response(queue);
      if (i?.method === 'POST') {
        posted = true;
        return deferred;
      }
      return undefined;
    });
    const mounted = render(
      <MemoryRouter>
        <TodayWorkPage owner />
      </MemoryRouter>,
    );
    fireEvent.click(await screen.findByRole('button', { name: /Kuyruk a/ }));
    await draft();
    fireEvent.click(screen.getByRole('button', { name: /Kuyruk b/ }));
    await screen.findByText('Hedefi değiştirmeden önce');
    expect((screen.getByLabelText('İç not') as HTMLTextAreaElement).value).toBe('Taslak not');
    fireEvent.click(screen.getByRole('button', { name: 'Bu ekranda kal' }));
    fireEvent.click(screen.getByRole('button', { name: 'İletişim kaydını kaydet' }));
    await waitFor(() => expect(posted).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: /Kuyruk b/ }));
    expect(screen.getByText(/Sonuçlandırma\/iletişim işleminin sonucu doğrulanmadan/)).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Ayrılmayı onayla' })).toBeNull();
    expect(
      within(screen.getByRole('region', { name: 'Seçili görev özeti' })).getByText('Kuyruk a'),
    ).toBeTruthy();
    expect((screen.getByLabelText('İç not') as HTMLTextAreaElement).value).toBe('Taslak not');
    fireEvent.click(screen.getByRole('button', { name: 'Atanmamış işler' }));
    expect(screen.getByRole('region', { name: 'Yenileme iletişim geçmişi ve kaydı' })).toBeTruthy();
    mounted.unmount();
    await act(async () => release(response(null, 401)));
    expect(ended).not.toHaveBeenCalled();
  } finally {
    document.removeEventListener('mayi-session-ended', ended);
  }
});
