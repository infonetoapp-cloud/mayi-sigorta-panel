// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, act, waitFor } from '@testing-library/react';
vi.mock('../src/app/App', () => ({ invalidateCsrfToken: vi.fn() }));
import { PersonnelPanel } from '../src/app/components/PersonnelPanel';
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function list() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ data: { personnel: [], nextCursor: null } }))),
  );
}
it('reopening create resets the template selector together with its explicit grant snapshot', async () => {
  list();
  await act(async () => {
    render(<PersonnelPanel />);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Personel oluştur' }));
  fireEvent.change(screen.getByLabelText('Başlangıç şablonu'), {
    target: { value: 'yetkili_personel' },
  });
  expect(
    (screen.getByRole('checkbox', { name: /^Müşteri Arşivleme/ }) as HTMLInputElement).checked,
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Vazgeç' }));
  if (screen.queryByRole('button', { name: 'Ayrılmayı onayla' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ayrılmayı onayla' }));
  fireEvent.click(screen.getByRole('button', { name: 'Personel oluştur' }));
  expect((screen.getByLabelText('Başlangıç şablonu') as unknown as HTMLSelectElement).value).toBe(
    'personel',
  );
  expect(
    (screen.getByRole('checkbox', { name: /^Müşteri Arşivleme/ }) as HTMLInputElement).checked,
  ).toBe(false);
  await screen.findByRole('button', { name: 'Listeyi yenile' });
});

it('keeps an invalid explicit permission draft on safe server rejection without creating a credential', async () => {
  const fetcher = vi.fn(async (path: string) => {
    if (path.startsWith('/api/personnel'))
      return new Response(JSON.stringify({ data: { personnel: [], nextCursor: null } }));
    if (path.endsWith('csrf-token'))
      return new Response(JSON.stringify({ data: { token: 'fixture-csrf' } }));
    return new Response(
      JSON.stringify({ error: { code: 'INVALID_GRANTS', message: 'unsafe diagnostic' } }),
      { status: 400 },
    );
  });
  vi.stubGlobal('fetch', fetcher);
  await act(async () => {
    render(<PersonnelPanel />);
  });
  fireEvent.click(screen.getByRole('button', { name: 'Personel oluştur' }));
  fireEvent.change(screen.getByLabelText('Ad soyad'), { target: { value: 'Sentetik Personel' } });
  fireEvent.change(screen.getByLabelText('Giriş e-postası'), {
    target: { value: 'synthetic@example.invalid' },
  });
  fireEvent.click(screen.getByRole('checkbox', { name: /^Müşteri Görüntüleme/ }));
  fireEvent.click(screen.getByRole('button', { name: 'Onayla ve oluştur' }));
  await screen.findByRole('alert');
  expect(screen.getByRole('alert').textContent).toContain(
    'Seçili izinler birbiriyle uyumlu değil.',
  );
  expect(screen.queryByText('unsafe diagnostic')).toBeNull();
  expect((screen.getByLabelText('Ad soyad') as HTMLInputElement).value).toBe('Sentetik Personel');
  expect(fetcher.mock.calls.some(([path]) => path.endsWith('/commands'))).toBe(false);
});

it('keeps stale permission version until explicit list refresh and reselection', async () => {
  let version = 1;
  const requests: Record<string, unknown>[] = [];
  const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
    if (path.startsWith('/api/personnel'))
      return new Response(
        JSON.stringify({
          data: {
            personnel: [
              {
                id: 'member',
                user_id: 'user',
                display_name: 'Sentetik',
                login_email: 'fixture@example.invalid',
                type: 'MEMBER',
                status: 'ACTIVE',
                version,
                grants: [],
              },
            ],
            nextCursor: null,
          },
        }),
      );
    if (path.endsWith('csrf-token'))
      return new Response(JSON.stringify({ data: { token: 'fixture-csrf' } }));
    if (path.endsWith('/grants'))
      return new Response(JSON.stringify({ data: { grantEvidenceToken: 'fixture-evidence' } }));
    requests.push(JSON.parse(options!.body as string).command);
    return new Response(JSON.stringify({ error: { code: 'CONFLICT' } }), { status: 409 });
  });
  vi.stubGlobal('fetch', fetcher);
  await act(async () => {
    render(<PersonnelPanel />);
  });
  fireEvent.click(await screen.findByRole('button', { name: 'İzinleri düzenle' }));
  fireEvent.change(screen.getByLabelText('Gerekçe'), { target: { value: 'Sentetik gerekçe' } });
  version = 2;
  fireEvent.click(screen.getByRole('button', { name: 'Kaydet' }));
  await screen.findByRole('alert');
  expect(requests[0]?.expectedVersion).toBe(1);
  expect((screen.getByLabelText('Gerekçe') as HTMLTextAreaElement).value).toBe('Sentetik gerekçe');
  expect(requests).toHaveLength(1);
  fireEvent.click(screen.getByRole('button', { name: 'Vazgeç' }));
  if (screen.queryByRole('button', { name: 'Ayrılmayı onayla' }))
    fireEvent.click(screen.getByRole('button', { name: 'Ayrılmayı onayla' }));
  fireEvent.click(screen.getByRole('button', { name: 'Listeyi yenile' }));
  fireEvent.click(await screen.findByRole('button', { name: 'İzinleri düzenle' }));
  fireEvent.change(screen.getByLabelText('Gerekçe'), { target: { value: 'Yeni açık onay' } });
  fireEvent.click(screen.getByRole('button', { name: 'Kaydet' }));
  await waitFor(() => expect(requests).toHaveLength(2));
  expect(requests[1]?.expectedVersion).toBe(2);
  await screen.findByRole('alert');
});
