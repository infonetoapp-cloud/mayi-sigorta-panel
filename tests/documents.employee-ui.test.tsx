import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render, screen, fireEvent, waitFor } from '@testing-library/react';
import { DocumentSection } from '../src/app/components/DocumentSection';
vi.mock('../src/app/App', () => ({ invalidateCsrfToken: vi.fn() }));
const reply = (data: unknown, status = 200) =>
  new Response(
    JSON.stringify(
      status === 200 || status === 202
        ? { success: true, data }
        : {
            success: false,
            error: { code: 'SERVICE_UNAVAILABLE', message: 'R2 private hash provider secret' },
          },
    ),
    { status, headers: { 'content-type': 'application/json' } },
  );
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('hides the closed feature and discards stale parent-list results', async () => {
  let finish: ((r: Response) => void) | undefined;
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) =>
      path.includes('ownerId=parent-a')
        ? new Promise<Response>((resolve) => {
            finish = resolve;
          })
        : Promise.resolve(reply({ documents: [], nextCursor: null })),
    ),
  );
  const view = render(<DocumentSection ownerType="CUSTOMER" ownerId="parent-a" />);
  view.rerender(<DocumentSection ownerType="CUSTOMER" ownerId="parent-b" />);
  await screen.findByText('Bu kayıtta görünür belge yok.');
  finish?.(
    reply({
      documents: [
        {
          documentId: 'old',
          fileName: 'old-private.pdf',
          classification: 'GENERAL',
          status: 'READY',
          createdAt: '2026-10-13T18:00:00.000Z',
          sizeBytes: 4,
          downloadMode: 'NORMAL',
        },
      ],
      nextCursor: null,
    }),
  );
  await waitFor(() => expect(screen.queryByText('old-private.pdf')).toBeNull());
  view.unmount();
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => reply(null, 404)),
  );
  const closed = render(<DocumentSection ownerType="CUSTOMER" ownerId="closed" />);
  await waitFor(() => expect(closed.container.textContent).toBe(''));
  expect(screen.queryByLabelText('Dosya')).toBeNull();
});
it('uses product states and preserves upload File/key on retry without leaking technical diagnostics', async () => {
  let ready = false,
    uploads = 0;
  const keys: string[] = [],
    files: unknown[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, init?: RequestInit) => {
      if (path === '/api/auth/csrf-token') return reply({ token: 'synthetic-token' });
      if (path.startsWith('/api/documents?'))
        return reply({
          documents: [
            {
              documentId: 'synthetic-document',
              fileName: 'test.pdf',
              classification: 'GENERAL',
              status: ready ? 'READY' : 'PROCESSING',
              createdAt: '2026-10-13T18:00:00.000Z',
              sizeBytes: 4,
              downloadMode: 'NORMAL',
            },
          ],
          nextCursor: null,
        });
      if (path === '/api/documents') {
        keys.push((init?.headers as Record<string, string>)['Idempotency-Key']!);
        files.push((init?.body as FormData).get('file'));
        return reply(
          { documentId: 'synthetic-document', classification: 'GENERAL', status: 'PROCESSING' },
          ++uploads === 1 ? 503 : 202,
        );
      }
      throw Error('Unexpected');
    }),
  );
  render(<DocumentSection ownerType="CUSTOMER" ownerId="customer-a" />);
  await screen.findByText('İşleniyor');
  expect((screen.getByRole('button', { name: 'İndir' }) as HTMLButtonElement).disabled).toBe(true);
  const file = new File(['%PDF'], 'test.pdf', { type: 'application/pdf' });
  fireEvent.change(screen.getByLabelText('Dosya'), { target: { files: [file] } });
  fireEvent.click(screen.getByRole('button', { name: 'Belge yükle' }));
  await screen.findByRole('alert');
  expect(screen.queryByText(/R2 private/)).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Yüklemeyi tekrar dene' }));
  await waitFor(() => expect(uploads).toBe(2));
  expect(keys[0]).toBe(keys[1]);
  expect(files[0]).toEqual(files[1]);
  ready = true;
  fireEvent.click(screen.getByRole('button', { name: 'Listeyi yenile' }));
  await screen.findByText('İndirmeye hazır');
});
it.each([401, 403, 404])(
  'clears previously visible metadata and controls after access loss %s',
  async (status) => {
    let lost = false;
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        lost
          ? reply(null, status)
          : reply({
              documents: [
                {
                  documentId: 'private',
                  fileName: 'sensitive-private.pdf',
                  classification: 'IDENTITY',
                  status: 'READY',
                  createdAt: '2026-10-13T18:00:00.000Z',
                  sizeBytes: 4,
                  downloadMode: 'SENSITIVE',
                },
              ],
              nextCursor: null,
            }),
      ),
    );
    render(<DocumentSection ownerType="CUSTOMER" ownerId="same-parent" />);
    await screen.findByText('sensitive-private.pdf');
    lost = true;
    fireEvent.click(screen.getByRole('button', { name: 'Listeyi yenile' }));
    await waitFor(() => expect(screen.queryByText('sensitive-private.pdf')).toBeNull());
    expect(screen.queryByLabelText('Dosya')).toBeNull();
    expect(screen.queryByRole('button', { name: 'İndir' })).toBeNull();
  },
);
