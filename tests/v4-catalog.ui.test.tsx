import { afterEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { CatalogsPanel } from '../src/app/components/CatalogsPanel';
vi.mock('../src/app/App', () => ({
  getCsrfToken: async () => 'synthetic-csrf',
  parseAppError: () => ({
    message: 'İşlem tamamlanamadı.',
    isRetryable: true,
    category: 'SERVER_OR_NETWORK',
  }),
}));
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const row = { id: 'i', code: 'SYNTHETIC', name: 'Sentetik Sigorta', status: 'ACTIVE', version: 1 };
function mock(canManage = true) {
  return vi.fn(
    async (path: string) =>
      new Response(
        JSON.stringify({
          success: true,
          data: path.endsWith('/capabilities')
            ? { canManage }
            : path.endsWith('/selectable')
              ? { insurers: [row], branches: [], products: [], paymentMethods: [], lossReasons: [] }
              : [row],
        }),
      ),
  );
}
it('uses authoritative capabilities to make ordinary MEMBER catalog read-only', async () => {
  vi.stubGlobal('fetch', mock(false));
  render(<CatalogsPanel />);
  await screen.findByText('Sentetik Sigorta');
  await screen.findByText(/Salt okunur/);
  expect(screen.queryByRole('button', { name: 'Yeni kayıt' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'Düzenle' })).toBeNull();
});
it('filters the loaded catalog truthfully and protects an edit draft from tab switching', async () => {
  vi.stubGlobal('fetch', mock());
  render(<CatalogsPanel />);
  await screen.findByText('Sentetik Sigorta');
  fireEvent.change(screen.getByLabelText('Katalogda ara'), { target: { value: 'bulunamaz' } });
  await screen.findByText('Aramanızla eşleşen kayıt yok');
  fireEvent.change(screen.getByLabelText('Katalogda ara'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('button', { name: 'Düzenle' }));
  fireEvent.change(screen.getByLabelText('Ad'), { target: { value: 'Korunan taslak' } });
  fireEvent.click(screen.getByRole('button', { name: 'Branşlar' }));
  await screen.findByRole('dialog');
  fireEvent.click(screen.getByRole('button', { name: 'Bu ekranda kal' }));
  expect((screen.getByLabelText('Ad') as HTMLInputElement).value).toBe('Korunan taslak');
});
it('retries uncertain create with the original immutable body/key and disables editing', async () => {
  const requests: RequestInit[] = [];
  let fail = true;
  const base = mock();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, o?: RequestInit) => {
      if (o?.method === 'POST') {
        requests.push(o);
        if (fail) {
          fail = false;
          throw new TypeError('lost');
        }
        return new Response(JSON.stringify({ success: true, data: row }));
      }
      return base(path);
    }),
  );
  render(<CatalogsPanel />);
  await screen.findByText('Sentetik Sigorta');
  fireEvent.click(screen.getByRole('button', { name: 'Yeni kayıt' }));
  fireEvent.change(screen.getByLabelText('Kod'), { target: { value: 'NEW' } });
  fireEvent.change(screen.getByLabelText('Ad'), { target: { value: 'Sentetik Yeni' } });
  fireEvent.click(screen.getByRole('button', { name: 'Kaydet' }));
  fireEvent.click(await screen.findByRole('button', { name: 'Aynı isteği yeniden dene' }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[0]!.body).toBe(requests[1]!.body);
  expect((requests[0]!.headers as Record<string, string>)['Idempotency-Key']).toBe(
    (requests[1]!.headers as Record<string, string>)['Idempotency-Key'],
  );
});

it('does not apply a late record comparison after the editor closes', async () => {
  let resolve!: (r: Response) => void;
  const deferred = new Promise<Response>((r) => {
    resolve = r;
  });
  const base = mock();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) => (path === '/api/catalogs/insurers/i' ? deferred : base(path))),
  );
  render(<CatalogsPanel />);
  await screen.findByText('Sentetik Sigorta');
  fireEvent.click(screen.getByRole('button', { name: 'Düzenle' }));
  fireEvent.click(screen.getByRole('button', { name: 'Güncel kaydı karşılaştır' }));
  fireEvent.click(screen.getByRole('button', { name: 'Vazgeç' }));
  fireEvent.click(screen.getByRole('button', { name: 'Yeni kayıt' }));
  resolve(
    new Response(JSON.stringify({ success: true, data: { ...row, name: 'Late wrong record' } })),
  );
  await waitFor(() =>
    expect(screen.getByRole('heading', { name: 'Yeni kayıt oluştur' })).toBeTruthy(),
  );
  expect(screen.queryByText(/Late wrong record/)).toBeNull();
});

it('keeps a failed read distinct from an empty catalog or an uncertain write', async () => {
  const base = mock();
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) =>
      path === '/api/catalogs/insurers'
        ? new Response(JSON.stringify({ success: false, error: { code: 'SERVICE_UNAVAILABLE' } }), {
            status: 503,
          })
        : base(path),
    ),
  );
  render(<CatalogsPanel />);
  await screen.findByText(/Katalog yüklenemedi/);
  expect(screen.queryByText('Bu katalogda kayıt yok')).toBeNull();
  expect(screen.queryByText(/Yanıt kesinleşmedi/)).toBeNull();
});
