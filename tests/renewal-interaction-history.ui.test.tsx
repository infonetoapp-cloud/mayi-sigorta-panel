// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { RenewalWorkspacePanel } from '../src/app/components/RenewalWorkspacePanel';

function response(data: unknown, status = 200) {
  return new Response(JSON.stringify({ success: status < 400, data }), { status });
}
async function open(interactions: unknown[]) {
  const fetcher = vi.fn(async (input: RequestInfo | URL) => {
    if (String(input).endsWith('/interactions'))
      return response({
        interactions,
        lastContactAt: null,
        lastAttemptAt: null,
        customerType: 'INDIVIDUAL',
        companyContacts: [],
      });
    // History must not depend on Quote or OWNER personnel read permission.
    if (String(input).endsWith('/quotes')) return response(null, 403);
    throw new Error('Unexpected endpoint');
  });
  vi.stubGlobal('fetch', fetcher);
  render(
    <RenewalWorkspacePanel
      renewalId="renewal"
      customerDisplayName="Deneme"
      getCsrfToken={async () => 'csrf'}
      invalidateCsrfToken={() => undefined}
    />,
  );
  fireEvent.click(screen.getByRole('button', { name: 'İletişim, teklif ve sonuçları aç: Deneme' }));
  return {
    fetcher,
    history: await screen.findByRole('list', { name: 'İletişim geçmişi: Deneme' }),
  };
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('Readable renewal interaction history', () => {
  it('shows outcome, Turkish channel, Istanbul date and recorded multiline note without leaking actor IDs', async () => {
    const { history, fetcher } = await open([
      {
        id: 'interaction',
        outcome: 'CONTACT_CONFIRMED',
        channel: 'PHONE',
        occurred_at: '2026-10-14T21:30:00.000Z',
        note: 'Müşteri teklif bekliyor.\nYarın tekrar aranacak.',
        actor_membership_id: 'internal-membership-do-not-display',
      },
    ]);
    const row = within(history).getByRole('listitem');
    expect(within(row).getByText('Gerçek temas doğrulandı — Telefon')).toBeTruthy();
    expect(within(row).getByText('15 Eki 2026 00:30')).toBeTruthy();
    expect(row.querySelector('time')?.getAttribute('datetime')).toBe('2026-10-14T21:30:00.000Z');
    expect(within(row).getByText(/Müşteri teklif bekliyor/).textContent).toBe(
      'Müşteri teklif bekliyor.\nYarın tekrar aranacak.',
    );
    expect(within(row).getByText('Kaydeden: Çalışan adı mevcut değil')).toBeTruthy();
    expect(document.body.textContent).not.toContain('internal-membership-do-not-display');
    expect(
      fetcher.mock.calls.every(
        ([url]) =>
          !String(url).includes('personnel') && !String(url).includes('assignment-options'),
      ),
    ).toBe(true);
  });

  it('labels supported outcomes and channels without confusing attempts or WhatsApp opens with actual contact', async () => {
    const { history } = await open([
      { id: 'email', outcome: 'ATTEMPT_NO_RESPONSE', channel: 'EMAIL' },
      { id: 'wa', outcome: 'WHATSAPP_OPENED', channel: 'WHATSAPP' },
      { id: 'person', outcome: 'NOTE', channel: 'IN_PERSON' },
      { id: 'other', outcome: 'NOTE', channel: 'OTHER' },
    ]);
    expect(within(history).getByText('Temas denemesi — yanıt yok — E-posta')).toBeTruthy();
    expect(
      within(history).getByText('WhatsApp açıldı; gerçek temas değildir. — WhatsApp'),
    ).toBeTruthy();
    expect(within(history).getByText('Not — Yüz yüze')).toBeTruthy();
    expect(within(history).getByText('Not — Diğer')).toBeTruthy();
  });

  it('handles missing historical fields and unknown codes without showing technical identifiers', async () => {
    const { history } = await open([
      {
        id: 'missing',
        outcome: 'NOTE',
        channel: null,
        occurred_at: null,
        note: null,
        actor_membership_id: null,
      },
      {
        id: 'legacy',
        outcome: 'LEGACY_CODE',
        channel: 'LEGACY_CHANNEL',
        occurred_at: 'not-a-date',
        note: '   ',
        actor_membership_id: 'retired-membership',
      },
    ]);
    expect(
      within(history).getByText('Sonuç bilgisi bulunmuyor — Kanal bilgisi bulunmuyor'),
    ).toBeTruthy();
    expect(within(history).getAllByText('Tarih bilgisi bulunmuyor')).toHaveLength(2);
    expect(within(history).getAllByText('Kaydeden: Çalışan adı mevcut değil')).toHaveLength(2);
    expect(history.querySelector('time')).toBeNull();
    expect(history.textContent).not.toMatch(/LEGACY|retired-membership|Invalid Date|null/);
  });

  it('renders notes as text, never executable HTML', async () => {
    const malicious = '<img src=x onerror="alert(1)"><script>alert(2)</script>';
    const { history } = await open([
      { id: 'note', outcome: 'NOTE', channel: 'OTHER', note: malicious },
    ]);
    expect(within(history).getByText(malicious)).toBeTruthy();
    expect(history.querySelector('script,img')).toBeNull();
  });

  it('accepts explicit offsets but does not guess the timezone of incomplete historical dates', async () => {
    const { history } = await open([
      { id: 'offset', outcome: 'NOTE', channel: 'OTHER', occurred_at: '2026-10-15T00:30:00+03:00' },
      { id: 'no-zone', outcome: 'NOTE', channel: 'OTHER', occurred_at: '2026-10-15T00:30:00' },
    ]);
    expect(within(history).getByText('15 Eki 2026 00:30')).toBeTruthy();
    expect(within(history).getByText('Tarih bilgisi bulunmuyor')).toBeTruthy();
    expect(history.querySelectorAll('time')).toHaveLength(1);
  });

  it('shows a clear empty history', async () => {
    await open([]);
    expect(screen.getByText('Henüz iletişim kaydı yok.')).toBeTruthy();
  });
});
