import { afterEach, beforeEach, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, waitFor, cleanup, act } from '@testing-library/react';
import { AuthShell, ReauthForm } from '../src/app/AuthShell';
import { PersonnelPanel } from '../src/app/components/PersonnelPanel';
vi.mock('../src/app/App', () => ({
  App: () => <div>Sentetik CRM alanı</div>,
  invalidateCsrfToken: vi.fn(),
}));
const response = (data: unknown, status = 200) =>
  new Response(JSON.stringify(status >= 400 ? { error: data } : { success: true, data }), {
    status,
    headers: { 'content-type': 'application/json' },
  });
it('OWNER reset submits the reasoned exact target/version without authority claims', async () => {
  const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
    if (path.startsWith('/api/personnel'))
      return response({
        personnel: [
          {
            id: 'synthetic-member',
            user_id: 'synthetic-user',
            display_name: 'Sentetik personel',
            login_email: 'staff@example.invalid',
            type: 'MEMBER',
            status: 'INACTIVE',
            version: 7,
            grants: [],
          },
        ],
        nextCursor: null,
      });
    if (path.endsWith('csrf-token')) return response({ token: 'synthetic-csrf' });
    if (path.endsWith('/grants')) return response({ grantEvidenceToken: 'synthetic-grant' });
    if (path.endsWith('/commands')) {
      const body = JSON.parse(options!.body as string);
      expect(body.command).toEqual({
        kind: 'reset',
        targetId: 'synthetic-member',
        expectedVersion: 7,
        reason: 'Sentetik kurtarma gerekçesi',
      });
      expect(body.grantEvidenceToken).toBe('synthetic-grant');
      return response({ temporaryPassword: 'synthetic-reset-display' });
    }
    return response({});
  });
  vi.stubGlobal('fetch', fetcher);
  render(<PersonnelPanel />);
  await screen.findByText('Sentetik personel');
  fireEvent.click(screen.getByRole('button', { name: 'Şifre sıfırla' }));
  expect(
    screen.getByText(/Şifre sıfırlama izinleri veya pasif üyeliği yeniden etkinleştirmez/),
  ).toBeTruthy();
  fireEvent.change(screen.getByLabelText('Gerekçe'), {
    target: { value: 'Sentetik kurtarma gerekçesi' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'İşlemi onayla' }));
  await screen.findByText('synthetic-reset-display');
  fireEvent.click(screen.getByRole('button', { name: 'Güvenli biçimde kapat' }));
  expect(screen.queryByText('synthetic-reset-display')).toBeNull();
});
beforeEach(() => {
  vi.restoreAllMocks();
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it('closed login uses password-manager fields, generic failure and clears password without CRM loading', async () => {
  const fetcher = vi.fn(async (path: string) =>
    path === '/api/auth/session'
      ? response({}, 401)
      : response({ message: 'E-posta veya şifre hatalı.' }, 401),
  );
  vi.stubGlobal('fetch', fetcher);
  render(<AuthShell />);
  const email = await screen.findByLabelText('E-posta');
  const password = screen.getByLabelText('Şifre') as HTMLInputElement;
  expect(email.getAttribute('autocomplete')).toBe('username');
  expect(password.getAttribute('autocomplete')).toBe('current-password');
  expect(
    screen.getByText('Şifrenizi unuttuysanız acente sahibinizle iletişime geçin.'),
  ).toBeTruthy();
  fireEvent.change(email, { target: { value: 'synthetic@example.invalid' } });
  fireEvent.change(password, { target: { value: 'synthetic secret phrase' } });
  fireEvent.click(screen.getByRole('button', { name: 'Giriş Yap' }));
  await screen.findByRole('alert');
  expect(password.value).toBe('');
  expect(screen.queryByText('Sentetik CRM alanı')).toBeNull();
  expect(
    fetcher.mock.calls
      .map((c) => c[0])
      .every((p) => p === '/api/auth/session' || p === '/api/auth/login'),
  ).toBe(true);
});
it('requires a fresh Turnstile token for each login attempt when configured', async () => {
  let complete: ((token: string) => void) | undefined;
  const remove = vi.fn();
  const widget = vi.fn((_node: HTMLElement, options: { callback: (token: string) => void }) => {
    complete = options.callback;
    return 'synthetic-widget';
  });
  vi.stubGlobal('turnstile', { render: widget, remove });
  const fetcher = vi.fn(async (path: string, _options?: RequestInit) => {
    if (path === '/api/auth/session') {
      const initial = response({}, 401);
      initial.headers.set('X-Turnstile-Site-Key', 'synthetic-site-key');
      return initial;
    }
    return response({ code: 'LOGIN_FAILED' }, 401);
  });
  vi.stubGlobal('fetch', fetcher);
  render(<AuthShell />);
  const submit = (await screen.findByRole('button', { name: 'Giriş Yap' })) as HTMLButtonElement;
  await waitFor(() => expect(widget).toHaveBeenCalledOnce());
  fireEvent.change(screen.getByLabelText('E-posta'), {
    target: { value: 'synthetic@example.invalid' },
  });
  fireEvent.change(screen.getByLabelText('Şifre'), { target: { value: 'synthetic passphrase' } });
  expect(submit.disabled).toBe(true);
  expect(fetcher).toHaveBeenCalledTimes(1);
  act(() => complete?.('synthetic-turnstile-token'));
  expect(submit.disabled).toBe(false);
  fireEvent.click(submit);
  await screen.findByRole('alert');
  expect(JSON.parse(String(fetcher.mock.calls[1]?.[1]?.body))).toMatchObject({
    turnstileToken: 'synthetic-turnstile-token',
  });
  expect(submit.disabled).toBe(true);
  expect(remove).toHaveBeenCalledWith('synthetic-widget');
  await waitFor(() => expect(widget).toHaveBeenCalledTimes(2));
});
it('restricted loader renders only forced password replacement and logout then reloads normal state', async () => {
  let activated = false;
  const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
    if (path === '/api/auth/session')
      return response({
        state: activated ? 'NORMAL' : 'ACTIVATION',
        email: 'synthetic@example.invalid',
        isOwner: false,
      });
    if (path === '/api/auth/csrf-token') return response({ token: 'synthetic-csrf' });
    if (path === '/api/auth/password') {
      activated = true;
      expect(JSON.parse(options!.body as string)).toEqual({
        newPassword: 'synthetic replacement phrase',
        confirmation: 'synthetic replacement phrase',
      });
      return response({ state: 'NORMAL' });
    }
    return response({});
  });
  vi.stubGlobal('fetch', fetcher);
  render(<AuthShell />);
  await screen.findByText('Yeni şifrenizi belirleyin');
  expect(screen.queryByText('Sentetik CRM alanı')).toBeNull();
  expect(screen.queryByRole('button', { name: 'Personel ve İzinler' })).toBeNull();
  fireEvent.change(screen.getByLabelText('Yeni şifre'), {
    target: { value: 'synthetic replacement phrase' },
  });
  fireEvent.change(screen.getByLabelText('Yeni şifre tekrar'), {
    target: { value: 'synthetic replacement phrase' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Şifreyi kaydet' }));
  await screen.findByRole('heading', { name: 'Genel Bakış' });
  expect(screen.queryByRole('menuitem', { name: 'Çıkış Yap' })).toBeNull();
  expect(screen.getByRole('button', { name: 'Hesap menüsü' })).toBeTruthy();
});
it('own-password reauth uses session CSRF and clears secret on failure and cancellation', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) =>
      path.endsWith('csrf-token')
        ? response({ token: 'synthetic-csrf' })
        : response({ message: 'Şifre doğrulaması başarısız.' }, 403),
    ),
  );
  const cancel = vi.fn();
  render(<ReauthForm onSuccess={vi.fn()} onCancel={cancel} />);
  const password = screen.getByLabelText('Şifre') as HTMLInputElement;
  fireEvent.change(password, { target: { value: 'synthetic wrong phrase' } });
  fireEvent.click(screen.getByRole('button', { name: 'Doğrula' }));
  await screen.findByRole('alert');
  expect(password.value).toBe('');
  fireEvent.click(screen.getByRole('button', { name: 'Vazgeç' }));
  expect(cancel).toHaveBeenCalledOnce();
});
it('never reflects unsafe raw auth error text', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) =>
      path.endsWith('csrf-token')
        ? response({ token: 'synthetic-csrf' })
        : response({ code: 'REAUTH_FAILED', message: 'unsafe SQL synthetic diagnostic' }, 403),
    ),
  );
  render(<ReauthForm onSuccess={vi.fn()} onCancel={vi.fn()} />);
  fireEvent.change(screen.getByLabelText('Şifre'), { target: { value: 'synthetic own password' } });
  fireEvent.click(screen.getByRole('button', { name: 'Doğrula' }));
  await screen.findByRole('alert');
  expect(screen.queryByText('unsafe SQL synthetic diagnostic')).toBeNull();
  expect(screen.getByRole('alert').textContent).toBe('Şifre doğrulaması başarısız.');
});
it('personnel pages beyond the first page remain reachable', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (path: string) =>
      response({
        personnel: [
          {
            id: path.includes('cursor=') ? 'second' : 'first',
            user_id: 'synthetic',
            display_name: path.includes('cursor=')
              ? 'İkinci sayfa personeli'
              : 'İlk sayfa personeli',
            login_email: 'synthetic@example.invalid',
            type: 'MEMBER',
            status: 'ACTIVE',
            version: 1,
            grants: [],
          },
        ],
        nextCursor: path.includes('cursor=') ? null : 'first',
      }),
    ),
  );
  render(<PersonnelPanel />);
  await screen.findByText('İlk sayfa personeli');
  fireEvent.click(screen.getByRole('button', { name: 'Sonraki sayfa' }));
  await screen.findByText('İkinci sayfa personeli');
});
it('personnel ignores an older list response after refresh', async () => {
  const pending: ((r: Response) => void)[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(() => new Promise<Response>((resolve) => pending.push(resolve))),
  );
  render(<PersonnelPanel />);
  await waitFor(() => expect(pending.length).toBe(1));
  fireEvent.click(screen.getByRole('button', { name: 'Listeyi yenile' }));
  await waitFor(() => expect(pending.length).toBe(2));
  const data = (name: string) => ({
    personnel: [
      {
        id: name,
        display_name: name,
        login_email: 'synthetic@example.invalid',
        type: 'MEMBER',
        status: 'ACTIVE',
        grants: [],
      },
    ],
    nextCursor: null,
  });
  await act(async () => {
    pending[1]!(response(data('Güncel personel')));
  });
  await screen.findByText('Güncel personel');
  await act(async () => {
    pending[0]!(response(data('Eski personel')));
  });
  expect(screen.queryByText('Eski personel')).toBeNull();
  expect(screen.getByText('Güncel personel')).toBeTruthy();
});
it('personnel create reauths then uses grant and command protocol with one-time display cleared on close', async () => {
  let assured = false;
  const fetcher = vi.fn(async (path: string, options?: RequestInit) => {
    if (path.startsWith('/api/personnel')) return response({ personnel: [], nextCursor: null });
    if (path.endsWith('csrf-token')) return response({ token: 'synthetic-csrf' });
    if (path === '/api/auth/reauth') {
      assured = true;
      return response({ reauthenticated: true });
    }
    if (path.endsWith('/grants'))
      return assured ? response({ grantEvidenceToken: 'synthetic-grant' }) : response({}, 401);
    if (path.endsWith('/commands')) {
      const body = JSON.parse(options!.body as string);
      expect(body.command.kind).toBe('create');
      expect(body.command.email).toBe('new@example.invalid');
      expect(body.grantEvidenceToken).toBe('synthetic-grant');
      expect((options!.headers as Record<string, string>)['x-csrf-token']).toBe('synthetic-csrf');
      return response({ temporaryPassword: 'synthetic-one-time-display' }, 201);
    }
    return response({});
  });
  vi.stubGlobal('fetch', fetcher);
  render(<PersonnelPanel />);
  await waitFor(() => expect(fetcher).toHaveBeenCalled());
  fireEvent.click(screen.getByRole('button', { name: 'Personel oluştur' }));
  fireEvent.change(screen.getByLabelText('Ad soyad'), { target: { value: 'Sentetik Çalışan' } });
  fireEvent.change(screen.getByLabelText('Giriş e-postası'), {
    target: { value: 'new@example.invalid' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'Onayla ve oluştur' }));
  await screen.findByText('Devam etmek için şifrenizi tekrar girin');
  fireEvent.change(screen.getByLabelText('Şifre'), { target: { value: 'synthetic own phrase' } });
  fireEvent.click(screen.getByRole('button', { name: 'Doğrula' }));
  await screen.findByText('synthetic-one-time-display');
  fireEvent.click(screen.getByRole('button', { name: 'Güvenli biçimde kapat' }));
  expect(screen.queryByText('synthetic-one-time-display')).toBeNull();
  expect(localStorage.length).toBe(0);
  expect(sessionStorage.length).toBe(0);
});
