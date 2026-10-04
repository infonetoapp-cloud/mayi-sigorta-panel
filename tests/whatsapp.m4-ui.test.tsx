// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WhatsAppPreviewPanel } from '../src/app/components/WhatsAppPreviewPanel';

const preview = {
  phone: '905321234567',
  message: 'Merhaba',
  companyContactId: null,
  expectedRenewalVersion: 1,
  url: 'https://wa.me/905321234567?text=Merhaba',
};
function response(data: unknown, status = 200) {
  return new Response(
    JSON.stringify({ success: status < 400, data, error: status >= 400 ? data : undefined }),
    { status },
  );
}
const props = {
  renewalId: 'renewal-a',
  companyContactId: null,
  contactRequired: false,
  getCsrfToken: async () => 'csrf',
  invalidateCsrfToken: () => undefined,
  onOpened: () => undefined,
};
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('WhatsApp preview UI', () => {
  it('rejects an unsafe external response target without navigating', async () => {
    const replace = vi.fn();
    const close = vi.fn();
    vi.spyOn(window, 'open').mockReturnValue({
      opener: window,
      location: { replace },
      close,
    } as unknown as Window);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) =>
        init.method === 'GET'
          ? response(preview)
          : response({
              outcome: 'WHATSAPP_OPENED',
              url: 'https://evil.test/905321234567?text=Merhaba',
            }),
      ),
    );
    render(<WhatsAppPreviewPanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'WhatsApp önizle' }));
    await screen.findByLabelText('WhatsApp taslağı');
    fireEvent.click(screen.getByRole('button', { name: 'WhatsApp aç' }));
    await screen.findByText('WhatsApp bağlantısı doğrulanamadı.');
    expect(close).toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
  it('does not record an open when popup is blocked', async () => {
    const fetcher = vi.fn(async () => response(preview));
    vi.stubGlobal('fetch', fetcher);
    vi.spyOn(window, 'open').mockReturnValue(null);
    render(<WhatsAppPreviewPanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'WhatsApp önizle' }));
    await screen.findByLabelText('WhatsApp taslağı');
    fireEvent.click(screen.getByRole('button', { name: 'WhatsApp aç' }));
    expect(await screen.findByText(/açılır pencereye izin verin/)).toBeTruthy();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it('retries ambiguous open with the exact original body and key', async () => {
    const posts: RequestInit[] = [];
    const replace = vi.fn();
    vi.spyOn(window, 'open').mockImplementation(
      () => ({ opener: window, location: { replace }, close: vi.fn() }) as unknown as Window,
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        if (init.method === 'GET') return response(preview);
        posts.push(init);
        if (posts.length === 1) throw new Error('Network unavailable');
        return response({ outcome: 'WHATSAPP_OPENED', url: preview.url });
      }),
    );
    render(<WhatsAppPreviewPanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'WhatsApp önizle' }));
    await screen.findByLabelText('WhatsApp taslağı');
    fireEvent.click(screen.getByRole('button', { name: 'WhatsApp aç' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'WhatsApp aç' }));
    await waitFor(() => expect(replace).toHaveBeenCalledTimes(1));
    expect(posts[0]?.body).toBe(posts[1]?.body);
    expect(posts[0]?.headers).toEqual(posts[1]?.headers);
  });
  it('provides a safe contact-completion path without echoing unsafe server text', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response({ code: 'WHATSAPP_PHONE_REQUIRED', message: 'SECRET_PRIVATE_KEY' }, 409),
      ),
    );
    render(<WhatsAppPreviewPanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'WhatsApp önizle' }));
    expect(await screen.findByText(/iletişim bilgisini tamamlayın/)).toBeTruthy();
    expect(screen.queryByText('SECRET_PRIVATE_KEY')).toBeNull();
    expect(screen.queryByRole('button', { name: 'WhatsApp aç' })).toBeNull();
  });
  it('closes reserved tab and never navigates on a later authorization denial', async () => {
    const replace = vi.fn();
    const close = vi.fn();
    vi.spyOn(window, 'open').mockReturnValue({
      opener: window,
      location: { replace },
      close,
    } as unknown as Window);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) =>
        init.method === 'GET'
          ? response(preview)
          : response({ code: 'FORBIDDEN', message: 'SECRET' }, 403),
      ),
    );
    render(<WhatsAppPreviewPanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'WhatsApp önizle' }));
    await screen.findByLabelText('WhatsApp taslağı');
    fireEvent.click(screen.getByRole('button', { name: 'WhatsApp aç' }));
    await screen.findByText('Bu yenileme kaydına erişilemiyor.');
    expect(close).toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
  it('ignores an old open response after navigation and closes its tab', async () => {
    let resolveOpen!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      resolveOpen = resolve;
    });
    const replace = vi.fn();
    const close = vi.fn();
    vi.spyOn(window, 'open').mockReturnValue({
      opener: window,
      location: { replace },
      close,
    } as unknown as Window);
    const fetcher = vi.fn(async (_url: string, init: RequestInit) =>
      init.method === 'GET' ? response(preview) : pending,
    );
    vi.stubGlobal('fetch', fetcher);
    const { rerender } = render(<WhatsAppPreviewPanel key="a" {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'WhatsApp önizle' }));
    await screen.findByLabelText('WhatsApp taslağı');
    fireEvent.click(screen.getByRole('button', { name: 'WhatsApp aç' }));
    await waitFor(() => expect(fetcher).toHaveBeenCalledTimes(2));
    rerender(<WhatsAppPreviewPanel key="b" {...props} renewalId="renewal-b" />);
    resolveOpen(response({ outcome: 'WHATSAPP_OPENED', url: preview.url }));
    await waitFor(() => expect(close).toHaveBeenCalled());
    expect(replace).not.toHaveBeenCalled();
    expect(screen.queryByText(/aksiyonu kaydedildi/)).toBeNull();
  });
  it('previews without mutation, edits draft, opens external target only after guarded open and keeps contact confirmation separate', async () => {
    const calls: RequestInit[] = [];
    const replace = vi.fn();
    const popup = { opener: window, location: { replace }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(popup as unknown as Window);
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: RequestInit) => {
        calls.push(init);
        return response(
          init.method === 'GET'
            ? preview
            : {
                outcome: 'WHATSAPP_OPENED',
                url: 'https://wa.me/905321234567?text=Edited+%26x%3D1',
              },
        );
      }),
    );
    render(<WhatsAppPreviewPanel {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'WhatsApp önizle' }));
    const draft = await screen.findByLabelText('WhatsApp taslağı');
    expect(calls.map((call) => call.method)).toEqual(['GET']);
    expect(replace).not.toHaveBeenCalled();
    expect(screen.getByText(/Gerçek teması ayrı iletişim kaydıyla doğrulayın/)).toBeTruthy();
    fireEvent.change(draft, { target: { value: 'Edited &x=1' } });
    fireEvent.click(screen.getByRole('button', { name: 'WhatsApp aç' }));
    await waitFor(() =>
      expect(replace).toHaveBeenCalledWith('https://wa.me/905321234567?text=Edited+%26x%3D1'),
    );
    expect(popup.opener).toBeNull();
    expect(calls[1]?.headers).toMatchObject({ 'X-CSRF-Token': 'csrf' });
    expect(calls[1]?.headers).toHaveProperty('Idempotency-Key');
    expect(JSON.parse(String(calls[1]?.body))).toEqual({
      companyContactId: null,
      expectedPhone: preview.phone,
      expectedRenewalVersion: 1,
      message: 'Edited &x=1',
    });
    expect(await screen.findByText(/gönderildi veya gerçek temas sayılmaz/)).toBeTruthy();
  });
});
