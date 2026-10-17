import { it, expect, vi, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup, waitFor } from '@testing-library/react';
import { AuthShell, ReauthForm } from '../src/app/AuthShell';
import { REAUTH_PAGE, REAUTH_SCRIPT } from '../src/server/auth/reauth-page';
vi.mock('../src/app/App', () => ({
  App: () => <div>Sentetik CRM</div>,
  invalidateCsrfToken: vi.fn(),
}));
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify({ data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
afterEach(() => {
  cleanup();
  document.body.innerHTML = '';
  vi.unstubAllGlobals();
});
it.each([
  ['login', 'Şifre', 'Giriş Yap'],
  ['activation', 'Yeni şifre', 'Şifreyi kaydet'],
  ['activation', 'Yeni şifre tekrar', 'Şifreyi kaydet'],
  ['normal', 'Mevcut şifre', 'Şifreyi kaydet'],
  ['normal', 'Yeni şifre', 'Şifreyi kaydet'],
  ['normal', 'Yeni şifre tekrar', 'Şifreyi kaydet'],
  ['reauth', 'Şifre', 'Doğrula'],
] as const)(
  '%s %s rejects oversized supplementary input without browser clipping or a request',
  async (view, label, submit) => {
    const fetcher = vi.fn(async (path: string) =>
      path === '/api/auth/session'
        ? view === 'login'
          ? response({}, 401)
          : response({
              state: view === 'activation' ? 'ACTIVATION' : 'NORMAL',
              email: 'synthetic@example.invalid',
              isOwner: false,
            })
        : response({ token: 'synthetic-csrf' }),
    );
    vi.stubGlobal('fetch', fetcher);
    if (view === 'reauth') render(<ReauthForm onSuccess={vi.fn()} onCancel={vi.fn()} />);
    else render(<AuthShell />);
    if (view === 'normal')
      fireEvent.click(await screen.findByRole('link', { name: 'Şifremi değiştir' }));
    const input = (await screen.findByLabelText(label)) as HTMLInputElement;
    for (const element of document.querySelectorAll('input[type=password]'))
      expect(element.hasAttribute('maxlength')).toBe(false);
    if (view === 'login')
      fireEvent.change(screen.getByLabelText('E-posta'), {
        target: { value: 'synthetic@example.invalid' },
      });
    for (const element of document.querySelectorAll('input[type=password]'))
      fireEvent.change(element, { target: { value: 'synthetic safe winter phrase' } });
    const oversized = '🧪'.repeat(129);
    fireEvent.change(input, { target: { value: oversized } });
    expect(input.value === oversized).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: submit }));
    await screen.findByRole('alert');
    expect(screen.getByRole('alert').textContent).toMatch(/15.*128/);
    expect(fetcher.mock.calls.every((c) => c[0] === '/api/auth/session')).toBe(true);
  },
);
it('allows a full 128-codepoint manager/paste value unchanged in the request', async () => {
  const password = '🧪🦊'.repeat(64);
  let submitted = false;
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string, options?: RequestInit) => {
      if (path === '/api/auth/session')
        return response({
          state: 'ACTIVATION',
          email: 'synthetic@example.invalid',
          isOwner: false,
        });
      if (path === '/api/auth/csrf-token') return response({ token: 'synthetic-csrf' });
      if (path === '/api/auth/password') {
        submitted = true;
        const body = JSON.parse(options!.body as string);
        expect(body.newPassword === password && body.confirmation === password).toBe(true);
        return response({}, 400);
      }
      return response({});
    }),
  );
  render(<AuthShell />);
  fireEvent.change(await screen.findByLabelText('Yeni şifre'), { target: { value: password } });
  fireEvent.change(screen.getByLabelText('Yeni şifre tekrar'), { target: { value: password } });
  fireEvent.click(screen.getByRole('button', { name: 'Şifreyi kaydet' }));
  await waitFor(() => expect(submitted).toBe(true));
  await screen.findByRole('alert');
});
it('standalone secure HTML reauth also rejects oversized passwords without truncation or network calls', async () => {
  document.body.innerHTML = REAUTH_PAGE;
  const fetcher = vi.fn();
  vi.stubGlobal('fetch', fetcher);
  const input = document.getElementById('reauth-password') as HTMLInputElement;
  expect(input.hasAttribute('maxlength')).toBe(false);
  new Function(REAUTH_SCRIPT)();
  fireEvent.change(input, { target: { value: '🧪'.repeat(129) } });
  fireEvent.submit(document.getElementById('reauth-form')!);
  await waitFor(() =>
    expect(document.getElementById('reauth-result')!.textContent).toMatch(/15.*128/),
  );
  expect(fetcher).not.toHaveBeenCalled();
});
