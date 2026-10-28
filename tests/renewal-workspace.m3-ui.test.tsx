// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { RenewalWorkspacePanel } from '../src/app/components/RenewalWorkspacePanel';

const defaultVersion = {
  insurerId: 'insurer-a',
  productId: 'product-a',
  branchId: 'branch-a',
  paymentMethodId: 'payment-a',
  startDate: '2026-10-25',
  endDate: '2027-10-24',
  validUntil: '2026-09-30T00:00:00.000Z',
  grossPremiumMinor: 10000,
  currency: 'TRY',
  installmentCount: null,
  termsSummary: null,
};

function response(data: unknown, status = 200): Response {
  return new Response(
    JSON.stringify({ success: true, data, timestamp: '2026-09-24T06:00:00.000Z' }),
    {
      status,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('M3 Renewal workspace UI', () => {
  it.each(['DENIED', 'NETWORK_FAILURE'])(
    'keeps authorized WhatsApp available when unrelated Quote read fails: %s',
    async (quoteFailure) => {
      const replace = vi.fn();
      vi.spyOn(window, 'open').mockReturnValue({
        opener: window,
        location: { replace },
        close: vi.fn(),
      } as unknown as Window);
      vi.stubGlobal(
        'fetch',
        vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
          const url = String(input);
          if (url.endsWith('/quotes')) {
            if (quoteFailure === 'NETWORK_FAILURE') throw new Error('Quote network failed');
            return new Response(JSON.stringify({ success: false, error: { code: 'FORBIDDEN' } }), {
              status: 403,
            });
          }
          if (url.endsWith('/interactions'))
            return response({
              interactions: [],
              lastContactAt: null,
              lastAttemptAt: null,
              customerType: 'INDIVIDUAL',
              companyContacts: [],
            });
          if (url.endsWith('/whatsapp-preview'))
            return response({
              phone: '905321234567',
              message: 'Merhaba',
              expectedRenewalVersion: 1,
              companyContactId: null,
            });
          if (url.endsWith('/whatsapp-open') && init?.method === 'POST')
            return response(
              { outcome: 'WHATSAPP_OPENED', url: 'https://wa.me/905321234567?text=Merhaba' },
              201,
            );
          return response({});
        }),
      );
      render(
        <RenewalWorkspacePanel
          renewalId="renewal-a"
          customerDisplayName="Individual A"
          getCsrfToken={async () => 'csrf-token'}
          invalidateCsrfToken={() => undefined}
        />,
      );
      fireEvent.click(
        screen.getByRole('button', { name: 'İletişim, teklif ve sonuçları aç: Individual A' }),
      );
      fireEvent.click(await screen.findByRole('button', { name: 'WhatsApp önizle' }));
      await screen.findByLabelText('WhatsApp taslağı');
      expect(screen.queryByRole('button', { name: 'Teklif oluştur: Individual A' })).toBeNull();
      expect(screen.getByRole('option', { name: 'Gerçek temas doğrulandı' })).toBeTruthy();
      fireEvent.click(screen.getByRole('button', { name: 'WhatsApp aç' }));
      await waitFor(() =>
        expect(replace).toHaveBeenCalledWith('https://wa.me/905321234567?text=Merhaba'),
      );
      expect(screen.getByText('Başarılı temas: henüz kaydedilmedi')).toBeTruthy();
    },
  );
  it('labels successful contact separately from attempts and sends the selected exact interaction outcome', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (init?.method === 'POST' && url.endsWith('/interactions')) {
          const body = JSON.parse(String(init.body)) as { outcome: string; occurredAt: string };
          return response(
            {
              data: {
                operationId: `op-${body.outcome}`,
                interactionId: `i-${body.outcome}`,
                renewalId: 'renewal-a',
                ...body,
              },
              replayed: false,
            },
            201,
          );
        }
        if (url.endsWith('/interactions')) {
          return response({
            interactions: [],
            lastContactAt: null,
            lastAttemptAt: null,
            customerType: 'INDIVIDUAL',
            companyContacts: [],
          });
        }
        if (url.endsWith('/quotes')) return response({ quotes: [], defaultVersion });
        return response({});
      }),
    );
    render(
      <RenewalWorkspacePanel
        renewalId="renewal-a"
        customerDisplayName="Individual A"
        getCsrfToken={async () => 'csrf-token'}
        invalidateCsrfToken={() => undefined}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'İletişim, teklif ve sonuçları aç: Individual A' }),
    );
    expect(await screen.findByText('Başarılı temas: henüz kaydedilmedi')).toBeTruthy();
    expect(await screen.findByText('Son deneme: henüz kaydedilmedi')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Görüşme sonucu: Individual A'), {
      target: { value: 'CONTACT_CONFIRMED' },
    });
    fireEvent.change(screen.getByLabelText('İletişim kanalı: Individual A'), {
      target: { value: 'PHONE' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Görüşmeyi kaydet: Individual A' }));
    await screen.findByText('Gerçek temas kaydedildi.');
    fireEvent.change(screen.getByLabelText('Görüşme sonucu: Individual A'), {
      target: { value: 'ATTEMPT_NO_RESPONSE' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Görüşmeyi kaydet: Individual A' }));
    await screen.findByText('Deneme kaydedildi; bu gerçek temas sayılmaz.');
    const posts = calls.filter(
      (call) => call.init?.method === 'POST' && call.url.endsWith('/interactions'),
    );
    expect(posts.map((call) => JSON.parse(String(call.init?.body)).outcome)).toEqual([
      'CONTACT_CONFIRMED',
      'ATTEMPT_NO_RESPONSE',
    ]);
    expect(posts[0]?.init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-token' });
    expect(posts[0]?.init?.headers).toHaveProperty('Idempotency-Key');
  });

  it('creates and sends a QuoteVersion without treating a WhatsApp open as contact', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith('/interactions')) {
          return response({
            interactions: [
              {
                id: 'i-1',
                outcome: 'WHATSAPP_OPENED',
                channel: 'WHATSAPP',
                occurred_at: '2026-09-24T05:00:00.000Z',
              },
            ],
            lastContactAt: null,
            lastAttemptAt: '2026-09-24T05:00:00.000Z',
            customerType: 'INDIVIDUAL',
            companyContacts: [],
          });
        }
        if (url.endsWith('/quotes') && init?.method === 'POST') {
          return response(
            {
              operationId: 'quote-create-op',
              quoteId: 'quote-a',
              quoteVersionId: 'quote-version-a1',
              versionNumber: 1,
              status: 'DRAFT',
            },
            201,
          );
        }
        if (url.endsWith('/send') && init?.method === 'POST') {
          return response(
            {
              operationId: 'quote-send-op',
              quoteId: 'quote-a',
              quoteVersionId: 'quote-version-a1',
              versionNumber: 1,
              status: 'SENT',
            },
            201,
          );
        }
        if (url.endsWith('/quotes')) {
          return response({ quotes: [], defaultVersion });
        }
        if (url === '/api/catalogs/selectable')
          return response({
            insurers: [
              {
                id: 'insurer-a',
                code: 'ANADOLU',
                name: 'Anadolu Sigorta',
                status: 'ACTIVE',
                agencyId: 'agency',
              },
            ],
            products: [
              {
                id: 'product-a',
                insurerId: 'insurer-a',
                branchId: 'branch-a',
                name: 'Kasko',
                status: 'ACTIVE',
                agencyId: 'agency',
              },
            ],
            branches: [{ id: 'branch-a', status: 'ACTIVE', agencyId: 'agency' }],
            paymentMethods: [
              {
                id: 'payment-a',
                status: 'ACTIVE',
                supportsInstallments: false,
                maxInstallments: 1,
              },
            ],
          });
        return response({});
      }),
    );
    render(
      <RenewalWorkspacePanel
        renewalId="renewal-a"
        customerDisplayName="Individual A"
        getCsrfToken={async () => 'csrf-token'}
        invalidateCsrfToken={() => undefined}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'İletişim, teklif ve sonuçları aç: Individual A' }),
    );
    expect(await screen.findByText(/WhatsApp açıldı; gerçek temas değildir\./)).toBeTruthy();
    expect(await screen.findByText(/^Son deneme:/)).toBeTruthy();
    const create = await screen.findByRole('button', { name: 'Teklif oluştur: Individual A' });
    await waitFor(() => expect((create as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(create);
    await waitFor(() =>
      expect(
        calls.some((call) => call.init?.method === 'POST' && call.url.endsWith('/quotes')),
      ).toBe(true),
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'Teklif sürümü 1’i gönder: Individual A' }),
    );
    await waitFor(() =>
      expect(calls.some((call) => call.init?.method === 'POST' && call.url.endsWith('/send'))).toBe(
        true,
      ),
    );
    const createCall = calls.find(
      (call) => call.init?.method === 'POST' && call.url.endsWith('/quotes'),
    );
    expect(createCall?.init?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf-token' });
    expect(createCall?.init?.headers).toHaveProperty('Idempotency-Key');
    expect(JSON.parse(String(createCall?.init?.body))).toMatchObject({
      expectedRenewalVersion: 1,
      version: { grossPremiumMinor: 10000, currency: 'TRY' },
    });
  });

  it('requires CompanyContact context when recording a company interaction', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith('/interactions') && init?.method === 'POST') {
          return response(
            {
              data: {
                operationId: 'contact-op',
                interactionId: 'contact-id',
                outcome: 'CONTACT_CONFIRMED',
              },
              replayed: false,
            },
            201,
          );
        }
        if (url.endsWith('/interactions')) {
          return response({
            interactions: [],
            lastContactAt: null,
            lastAttemptAt: null,
            customerType: 'COMPANY',
            companyContacts: [
              { id: 'company-contact-a', displayName: 'Deniz Kaya', role: 'Mali İşler' },
            ],
          });
        }
        if (url.endsWith('/quotes')) return response({ quotes: [], defaultVersion });
        return response({});
      }),
    );
    render(
      <RenewalWorkspacePanel
        renewalId="renewal-company"
        customerDisplayName="Mavi Ltd."
        getCsrfToken={async () => 'csrf-token'}
        invalidateCsrfToken={() => undefined}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'İletişim, teklif ve sonuçları aç: Mavi Ltd.' }),
    );
    const contact = await screen.findByLabelText('Şirket yetkilisi: Mavi Ltd.');
    await waitFor(() =>
      expect((contact as unknown as HTMLSelectElement).value).toBe('company-contact-a'),
    );
    fireEvent.click(screen.getByRole('button', { name: 'Görüşmeyi kaydet: Mavi Ltd.' }));
    await screen.findByText('Gerçek temas kaydedildi.');
    const call = calls.find(
      (item) => item.init?.method === 'POST' && item.url.endsWith('/interactions'),
    );
    expect(JSON.parse(String(call?.init?.body))).toMatchObject({
      outcome: 'CONTACT_CONFIRMED',
      companyContactId: 'company-contact-a',
    });
  });

  it('exposes terminal WON action and binds the selected sent QuoteVersion', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const sentQuote = {
      id: 'quote-a',
      status: 'SENT',
      version: 2,
      current_version_id: 'quote-version-a1',
      accepted_version_id: null,
      versions: [
        {
          id: 'quote-version-a1',
          version_number: 1,
          product_id: 'quoted-product',
          product_name: 'Quoted Product',
          gross_premium_minor: 10000,
          currency: 'TRY',
        },
      ],
      events: [
        {
          event: 'SENT',
          quote_version_id: 'quote-version-a1',
          occurred_at: '2026-09-24T06:00:00.000Z',
        },
      ],
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input);
        calls.push({ url, init });
        if (url.endsWith('/close-won') && init?.method === 'POST') {
          return response({ data: { operationId: 'won-op' }, replayed: false }, 201);
        }
        if (url.endsWith('/api/policies/policy-new')) {
          return response({
            id: 'policy-new',
            version: 7,
            policyNumber: 'YENI-2026',
            grossPremiumMinor: 12000,
            currency: 'TRY',
            product: { id: 'result-product', name: 'Result Product' },
          });
        }
        if (url.includes('/api/policies?'))
          return response({
            items: [{ id: 'policy-new', policyNumber: 'YENI-2026', endDate: '2027-10-24' }],
            nextCursor: null,
          });
        if (url.endsWith('/interactions')) {
          return response({
            interactions: [],
            lastContactAt: null,
            lastAttemptAt: null,
            customerType: 'INDIVIDUAL',
            companyContacts: [],
          });
        }
        if (url.endsWith('/quotes')) return response({ quotes: [sentQuote], defaultVersion });
        return response({});
      }),
    );
    const onTerminalOutcome = vi.fn();
    render(
      <RenewalWorkspacePanel
        renewalId="renewal-a"
        customerDisplayName="Individual A"
        renewalVersion={4}
        taskId="task-a"
        taskVersion={3}
        renewalState="QUOTE_SENT"
        getCsrfToken={async () => 'csrf-token'}
        invalidateCsrfToken={() => undefined}
        onTerminalOutcome={onTerminalOutcome}
      />,
    );
    fireEvent.click(
      screen.getByRole('button', { name: 'İletişim, teklif ve sonuçları aç: Individual A' }),
    );
    fireEvent.change(await screen.findByLabelText('Sonuç türü: Individual A'), {
      target: { value: 'WON' },
    });
    fireEvent.change(await screen.findByLabelText('Bağlanacak poliçe: Individual A'), {
      target: { value: 'policy-new' },
    });
    await screen.findByText(/Seçilen poliçe: YENI-2026/);
    fireEvent.change(screen.getByLabelText('Kabul edilen teklif sürümü: Individual A'), {
      target: { value: 'quote-version-a1' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Kazanıldı sonucunu kaydet: Individual A' }),
    );
    await screen.findByText(/Teklif ve poliçe arasında ürün\/prim farkı var/);
    expect(screen.getByText(/Teklif: Quoted Product/)).toBeTruthy();
    expect(screen.getByText(/Teklif: Quoted Product/).textContent).toContain('100,00 ₺');
    expect(screen.getByText(/Poliçe: Result Product/)).toBeTruthy();
    expect(screen.getByText(/Poliçe: Result Product/).textContent).toContain('120,00 ₺');
    expect(calls.some((item) => item.url.endsWith('/close-won'))).toBe(false);
    fireEvent.change(screen.getByLabelText('Ürün/prim farkı nedeni: Individual A'), {
      target: { value: 'INSURER_REQUOTE' },
    });
    fireEvent.click(
      screen.getByRole('button', { name: 'Kazanıldı sonucunu kaydet: Individual A' }),
    );
    await waitFor(() => expect(onTerminalOutcome).toHaveBeenCalledOnce());
    const call = calls.find((item) => item.url.endsWith('/close-won'));
    expect(JSON.parse(String(call?.init?.body))).toMatchObject({
      expectedRenewalVersion: 4,
      expectedTaskVersion: 3,
      acceptedQuoteVersionId: 'quote-version-a1',
      quoteDifferenceReasonCode: 'INSURER_REQUOTE',
      result: {
        kind: 'LINK_POLICY',
        newPolicyId: 'policy-new',
        expectedPolicyVersion: 7,
        allocatedNewPremiumMinor: 12000,
        currency: 'TRY',
      },
    });
  });
});
