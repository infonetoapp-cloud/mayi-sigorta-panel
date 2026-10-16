// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { CustomerNotesSection } from '../src/app/components/CustomerNotesSection';
const props = {
  customerId: 'customer',
  archived: false,
  getCsrfToken: async () => 'csrf',
  invalidateCsrfToken: vi.fn(),
};
const note = {
  id: 'note',
  content: 'Ortak müşteri notu.',
  authorName: 'Ayşe Yılmaz',
  createdAt: '2026-10-14T21:30:00.000Z',
};
function response(data: unknown, status = 200) {
  return new Response(JSON.stringify({ success: status < 400, data }), { status });
}
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});
describe('Customer-wide notes UI', () => {
  it('shows readable historical author, Istanbul time and safe text independent of renewal records', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        response({
          items: [{ ...note, content: '<script>not</script>' }],
          nextCursor: null,
          canCreate: false,
        }),
      ),
    );
    render(<CustomerNotesSection {...props} archived />);
    fireEvent.click(screen.getByRole('button', { name: 'Notları göster' }));
    await screen.findByText('Kaydeden: Ayşe Yılmaz');
    expect(screen.getByText('15 Eki 2026 00:30')).toBeTruthy();
    expect(screen.getByText('<script>not</script>')).toBeTruthy();
    expect(document.querySelector('script')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Notu kaydet' })).toBeNull();
  });
  it('preserves a draft and reuses exact body/key after an uncertain write', async () => {
    let posts = 0;
    const fetcher = vi.fn(async (_url: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'POST'
        ? ++posts === 1
          ? response(null, 503)
          : response(note, 201)
        : response({ items: posts > 1 ? [note] : [], nextCursor: null, canCreate: true }),
    );
    vi.stubGlobal('fetch', fetcher);
    render(<CustomerNotesSection {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Notları göster' }));
    fireEvent.change(await screen.findByLabelText('Yeni müşteri notu'), {
      target: { value: '  Ortak müşteri notu.  ' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Notu kaydet' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Aynı notu yeniden dene' }));
    await screen.findByText('Not kaydedildi.');
    expect(
      (screen.getByLabelText('Yeni müşteri notu') as unknown as HTMLTextAreaElement).value,
    ).toBe('');
    const attempts = fetcher.mock.calls.filter(([, init]) => init?.method === 'POST');
    expect(attempts).toHaveLength(2);
    expect(attempts[0]![0]).toBe('/api/customers/customer/notes');
    expect(attempts[0]![1]!.body).toBe(JSON.stringify({ content: 'Ortak müşteri notu.' }));
    expect(attempts[1]![1]!.body).toBe(attempts[0]![1]!.body);
    expect(attempts[1]![1]!.headers).toEqual(attempts[0]![1]!.headers);
    expect(attempts[0]![1]!.headers).toMatchObject({
      'X-CSRF-Token': 'csrf',
      'Idempotency-Key': expect.any(String),
    });
  });
  it('retries the exact failed history page without discarding earlier notes or drafts', async () => {
    let pages = 0;
    const fetcher = vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes('cursor=older')
        ? ++pages === 1
          ? response(null, 503)
          : response({
              items: [{ ...note, id: 'older', content: 'Eski not' }],
              nextCursor: null,
              canCreate: true,
            })
        : response({ items: [note], nextCursor: 'older', canCreate: true }),
    );
    vi.stubGlobal('fetch', fetcher);
    render(<CustomerNotesSection {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Notları göster' }));
    fireEvent.change(await screen.findByLabelText('Yeni müşteri notu'), {
      target: { value: 'Taslak' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'Daha eski notlar' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Aynı not sayfasını yeniden dene' }));
    await screen.findByText('Eski not');
    expect(screen.getByText(note.content)).toBeTruthy();
    expect(
      (screen.getByLabelText('Yeni müşteri notu') as unknown as HTMLTextAreaElement).value,
    ).toBe('Taslak');
    expect(fetcher.mock.calls.map(([url]) => String(url)).slice(1)).toEqual([
      '/api/customers/customer/notes?cursor=older',
      '/api/customers/customer/notes?cursor=older',
    ]);
  });
  it('suppresses stale customer responses after profile navigation', async () => {
    let release!: (response: Response) => void;
    const pending = new Promise<Response>((resolve) => {
      release = resolve;
    });
    vi.stubGlobal(
      'fetch',
      vi.fn((url: RequestInfo | URL) =>
        String(url).includes('/customer/notes')
          ? pending
          : Promise.resolve(response({ items: [], nextCursor: null, canCreate: false })),
      ),
    );
    const view = render(<CustomerNotesSection key="customer" {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'Notları göster' }));
    view.rerender(<CustomerNotesSection key="other" {...props} customerId="other" />);
    fireEvent.click(screen.getByRole('button', { name: 'Notları göster' }));
    await screen.findByText('Henüz müşteri notu yok.');
    await act(async () => {
      release(response({ items: [note], nextCursor: null, canCreate: true }));
      await Promise.resolve();
    });
    await waitFor(() => expect(screen.queryByText(note.content)).toBeNull());
  });
});
