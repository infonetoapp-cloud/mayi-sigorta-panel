import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { AuthShell } from '../src/app/AuthShell';
import { PersonnelPanel } from '../src/app/components/PersonnelPanel';
import { invalidateCsrfToken } from '../src/app/csrf';
vi.mock('../src/app/App', () => ({
  App: () => <div>CRM workspace</div>,
  invalidateCsrfToken: vi.fn(),
}));
const response = (data: unknown) =>
  new Response(JSON.stringify({ success: true, data }), {
    headers: { 'content-type': 'application/json' },
  });
afterEach(() => {
  cleanup();
  invalidateCsrfToken();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
it('opens standalone NORMAL reauth without additional business requests or secret persistence', async () => {
  const log = vi.spyOn(console, 'log');
  const storage = vi.spyOn(Storage.prototype, 'setItem');
  const fetcher = vi.fn(async (path: string) => {
    if (path === '/api/auth/session')
      return response({ state: 'NORMAL', email: 'owner@example.invalid', isOwner: true });
    if (path === '/api/auth/csrf-token' || path === '/api/csrf-token')
      return response({ token: crypto.randomUUID() });
    if (path === '/api/auth/reauth') return response({ state: 'NORMAL' });
    if (path === '/api/tasks/today?limit=20&unified=true') return response({});
    throw new Error('Unexpected endpoint');
  });
  vi.stubGlobal('fetch', fetcher);
  render(<AuthShell />);
  await screen.findByRole('heading', { name: 'Genel Bakış' });
  fireEvent.click(await screen.findByRole('button', { name: 'Hesap menüsü' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Şifremi doğrula' }));
  expect(screen.getByRole('dialog')).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Şifre'), { target: { value: crypto.randomUUID() } });
  fireEvent.click(screen.getByRole('button', { name: 'Doğrula' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.getByRole('heading', { name: 'Genel Bakış' })).toBeTruthy();
  expect(fetcher.mock.calls.filter(([path]) => path === '/api/auth/reauth')).toHaveLength(1);
  expect(
    fetcher.mock.calls.every(([path]) =>
      [
        '/api/auth/session',
        '/api/auth/csrf-token',
        '/api/auth/reauth',
        '/api/tasks/today?limit=20&unified=true',
      ].includes(path),
    ),
  ).toBe(true);
  expect(
    fetcher.mock.calls.filter(([path]) => path.startsWith('/api/tasks/today')).length,
  ).toBeLessThanOrEqual(1);
  expect(log).not.toHaveBeenCalled();
  expect(storage).not.toHaveBeenCalled();
});
it('cancels standalone reauth without a mutation and discards the entered value', async () => {
  const fetcher = vi.fn(async (_path: string) =>
    response({ state: 'NORMAL', email: 'owner@example.invalid', isOwner: true }),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<AuthShell />);
  fireEvent.click(await screen.findByRole('button', { name: 'Hesap menüsü' }));
  fireEvent.click(await screen.findByRole('menuitem', { name: 'Şifremi doğrula' }));
  fireEvent.change(screen.getByLabelText('Şifre'), { target: { value: crypto.randomUUID() } });
  fireEvent.click(screen.getByRole('button', { name: 'Vazgeç' }));
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(
    fetcher.mock.calls.every(
      ([path]) => path === '/api/auth/session' || path === '/api/tasks/today?limit=20&unified=true',
    ),
  ).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'Hesap menüsü' }));
  fireEvent.click(screen.getByRole('menuitem', { name: 'Şifremi doğrula' }));
  expect((screen.getByLabelText('Şifre') as HTMLInputElement).value).toBe('');
});
it('does not offer standalone reauth in ACTIVATION', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      response({ state: 'ACTIVATION', email: 'owner@example.invalid', isOwner: true }),
    ),
  );
  render(<AuthShell />);
  await screen.findByText('Yeni şifrenizi belirleyin');
  expect(screen.queryByRole('button', { name: 'Şifremi doğrula' })).toBeNull();
});
it('preserves personnel pending-command continuation after its own reauth', async () => {
  let verified = false;
  let commandCount = 0;
  const fetcher = vi.fn(async (path: string) => {
    if (path.startsWith('/api/personnel'))
      return response({
        personnel: [
          {
            id: 'member',
            user_id: 'user',
            display_name: 'Test employee',
            login_email: 'staff@example.invalid',
            type: 'MEMBER',
            status: 'INACTIVE',
            version: 7,
            grants: [],
          },
        ],
        nextCursor: null,
      });
    if (path === '/api/auth/csrf-token' || path === '/api/csrf-token')
      return response({ token: crypto.randomUUID() });
    if (path === '/api/auth/reauth') {
      verified = true;
      return response({});
    }
    if (path.endsWith('/grants'))
      return verified
        ? response({ grantEvidenceToken: crypto.randomUUID() })
        : new Response(JSON.stringify({ error: { code: 'REAUTH_REQUIRED' } }), { status: 401 });
    if (path.endsWith('/commands')) {
      commandCount++;
      return response({});
    }
    throw new Error('Unexpected endpoint');
  });
  vi.stubGlobal('fetch', fetcher);
  render(<PersonnelPanel />);
  await screen.findByText('Test employee');
  fireEvent.click(screen.getByRole('button', { name: 'Şifre sıfırla' }));
  fireEvent.change(screen.getByLabelText('Gerekçe'), { target: { value: 'Test recovery reason' } });
  fireEvent.click(screen.getByRole('button', { name: 'İşlemi onayla' }));
  await screen.findByText('Devam etmek için şifrenizi tekrar girin');
  expect(commandCount).toBe(0);
  fireEvent.change(screen.getByLabelText('Şifre'), { target: { value: crypto.randomUUID() } });
  fireEvent.click(screen.getByRole('button', { name: 'Doğrula' }));
  await waitFor(() => expect(commandCount).toBe(1));
  await waitFor(() =>
    expect(screen.queryByText('Devam etmek için şifrenizi tekrar girin')).toBeNull(),
  );
});
