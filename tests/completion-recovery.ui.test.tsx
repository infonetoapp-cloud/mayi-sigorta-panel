import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { WhatsAppPreviewPanel } from '../src/app/components/WhatsAppPreviewPanel';
import { DocumentSection } from '../src/app/components/DocumentSection';
import { invalidateCsrfToken } from '../src/app/csrf';
const response = (data: unknown, status = 200) =>
  new Response(
    JSON.stringify(
      status < 400
        ? { success: true, data }
        : {
            success: false,
            error: {
              code: status === 409 ? 'VERSION_CONFLICT' : 'FORBIDDEN',
              message: 'unsafe diagnostic',
            },
          },
    ),
    { status },
  );
const preview = {
  phone: '905550000123',
  message: 'Sentetik taslak',
  companyContactId: null,
  expectedRenewalVersion: 1,
};
const props = {
  renewalId: 'r',
  companyContactId: null,
  contactRequired: false,
  getCsrfToken: async () => 'synthetic-csrf',
  invalidateCsrfToken: vi.fn(),
  onOpened: vi.fn(),
};
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  invalidateCsrfToken();
});
it('unlocks a first definite WhatsApp conflict for an explicit fresh preview without discarding an earlier ambiguous attempt', async () => {
  const risk = vi.fn();
  let reads = 0;
  vi.stubGlobal(
    'open',
    vi.fn(() => ({ opener: null, location: { replace: vi.fn() }, close: vi.fn() })),
  );
  vi.stubGlobal(
    'fetch',
    vi.fn(async (_url: string, init?: RequestInit) =>
      init?.method === 'GET'
        ? (reads++, response({ ...preview, expectedRenewalVersion: reads }))
        : response(null, 409),
    ),
  );
  render(<WhatsAppPreviewPanel {...props} onRiskChange={risk} />);
  fireEvent.click(screen.getByRole('button', { name: 'WhatsApp önizle' }));
  await screen.findByLabelText('WhatsApp taslağı');
  fireEvent.click(screen.getByRole('button', { name: 'WhatsApp aç' }));
  await screen.findByRole('alert');
  expect(
    (screen.getByRole('button', { name: 'WhatsApp önizle' }) as HTMLButtonElement).disabled,
  ).toBe(false);
  expect(
    (screen.getByRole('button', { name: 'Taslağı kapat' }) as HTMLButtonElement).disabled,
  ).toBe(false);
  expect(risk).toHaveBeenLastCalledWith('draft');
  fireEvent.click(screen.getByRole('button', { name: 'WhatsApp önizle' }));
  await waitFor(() => expect(reads).toBe(2));
});
it.each([403, 409])(
  'keeps ambiguous WhatsApp identity after later %s and only recovers through the exact same request',
  async (status) => {
    const posts: RequestInit[] = [],
      risk = vi.fn();
    vi.stubGlobal(
      'open',
      vi.fn(() => ({ opener: null, location: { replace: vi.fn() }, close: vi.fn() })),
    );
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) => {
        if (init?.method === 'GET') return response(preview);
        posts.push(init!);
        if (posts.length === 1) throw new Error('synthetic response lost');
        if (posts.length === 2) return response(null, status);
        return response({
          outcome: 'WHATSAPP_OPENED',
          url: 'https://wa.me/905550000123?text=Sentetik%20taslak',
        });
      }),
    );
    render(<WhatsAppPreviewPanel {...props} onRiskChange={risk} />);
    fireEvent.click(screen.getByRole('button', { name: 'WhatsApp önizle' }));
    await screen.findByLabelText('WhatsApp taslağı');
    fireEvent.click(screen.getByRole('button', { name: 'WhatsApp aç' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'WhatsApp aç' }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(
      (screen.getByRole('button', { name: 'Taslağı kapat' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(risk).toHaveBeenLastCalledWith('uncertain');
    fireEvent.click(screen.getByRole('button', { name: 'WhatsApp aç' }));
    await screen.findByText(/aksiyonu kaydedildi/);
    expect(posts[0]?.body).toBe(posts[1]?.body);
    expect(posts[1]?.body).toBe(posts[2]?.body);
    expect((posts[0]?.headers as Record<string, string>)['Idempotency-Key']).toBe(
      (posts[2]?.headers as Record<string, string>)['Idempotency-Key'],
    );
  },
);
it.each([401, 403, 404])(
  'keeps ambiguous upload File/key through a denied retry and list refresh %s, blocking cancellation or a new upload',
  async (listStatus) => {
    const posts: RequestInit[] = [],
      risk = vi.fn();
    let denied = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init?: RequestInit) => {
        if (url.endsWith('csrf-token')) return response({ token: 'synthetic-csrf' });
        if (url.startsWith('/api/documents?'))
          return denied
            ? response(null, listStatus)
            : response({ documents: [], nextCursor: null });
        posts.push(init!);
        if (posts.length === 1) throw new Error('synthetic lost response');
        if (posts.length === 2) {
          denied = true;
          return response(null, 403);
        }
        denied = false;
        return response(
          { documentId: 'doc', classification: 'GENERAL', status: 'PROCESSING' },
          202,
        );
      }),
    );
    render(<DocumentSection ownerType="CUSTOMER" ownerId="c" onRiskChange={risk} />);
    await screen.findByLabelText('Dosya');
    const file = new File(['%PDF'], 'synthetic.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText('Dosya'), { target: { files: [file] } });
    fireEvent.click(screen.getByRole('button', { name: 'Belge yükle' }));
    await screen.findByRole('alert');
    fireEvent.click(screen.getByRole('button', { name: 'Yüklemeyi tekrar dene' }));
    await waitFor(() => expect(posts).toHaveLength(2));
    expect(screen.getByRole('button', { name: 'Yüklemeyi tekrar dene' })).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'Belge yükle' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'Yüklemeyi iptal et' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(risk).toHaveBeenLastCalledWith({ dirty: true, unresolved: true });
    fireEvent.click(screen.getByRole('button', { name: 'Listeyi yenile' }));
    await waitFor(() => expect(screen.queryByLabelText('Dosya')).toBeNull());
    fireEvent.click(screen.getByRole('button', { name: 'Yüklemeyi tekrar dene' }));
    await screen.findByText('Yükleme alındı; belge işleniyor.');
    expect(posts).toHaveLength(3);
    expect((posts[0]?.headers as Record<string, string>)['Idempotency-Key']).toBe(
      (posts[2]?.headers as Record<string, string>)['Idempotency-Key'],
    );
    expect((posts[0]?.body as FormData).get('file')).toEqual(
      (posts[2]?.body as FormData).get('file'),
    );
  },
);
