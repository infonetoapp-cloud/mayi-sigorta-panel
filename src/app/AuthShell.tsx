import { useId, useState, useEffect } from 'react';
import { invalidateCsrfToken } from './csrf';
import { BrowserRouter } from 'react-router';
import { AuthenticatedApp } from './AuthenticatedApp';
import { Button } from './components/ui/button';
import { Input } from './components/ui/input';
import { LoginChallenge } from './LoginChallenge';

import { authErrorMessage } from './auth-errors';
import { normalizeBoundedPassword, PASSWORD_INPUT_MESSAGE } from '../shared/password-input';
import { installQuotePopBoundary } from './pages/today-work/quote-navigation';

export interface AuthSessionDto {
  state: 'NORMAL' | 'ACTIVATION';
  email: string;
  isOwner: boolean;
}
export async function authMutation(path: string, body: unknown): Promise<Record<string, unknown>> {
  const csrfResponse = await fetch('/api/auth/csrf-token', { cache: 'no-store' });
  const csrf = (await csrfResponse.json()) as { data?: { token: string } };
  if (!csrfResponse.ok || !csrf.data?.token) throw new Error('Oturum yenilenmeli.');
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-csrf-token': csrf.data.token },
    body: JSON.stringify(body),
    cache: 'no-store',
  });
  const result = (await response.json()) as {
    data?: Record<string, unknown>;
    error?: { code?: string };
  };
  if (!response.ok) throw new Error(authErrorMessage(result.error?.code, response.status));
  invalidateCsrfToken();
  return result.data ?? {};
}
export function ReauthForm({
  onSuccess,
  onCancel,
  inline = false,
}: {
  onSuccess: () => void;
  onCancel: () => void;
  inline?: boolean;
}) {
  const [password, setPassword] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const headingId = useId();
  const Heading = inline ? 'h3' : 'h2';
  const content = (
    <section
      className={inline ? undefined : 'auth-card'}
      role={inline ? undefined : 'dialog'}
      aria-modal={inline ? undefined : true}
      aria-labelledby={headingId}
    >
      <Heading id={headingId}>Devam etmek için şifrenizi tekrar girin</Heading>
      <p>Kendi kalıcı şifrenizle bu işlemi doğrulayın.</p>
      <form
        action="/api/auth/reauth"
        method="post"
        aria-labelledby={headingId}
        className={inline ? 'issue-policy-form' : undefined}
        onSubmit={async (e) => {
          e.preventDefault();
          if (normalizeBoundedPassword(password) === null) {
            setError(PASSWORD_INPUT_MESSAGE);
            setPassword('');
            return;
          }
          setBusy(true);
          setError('');
          try {
            await authMutation('/api/auth/reauth', { password });
            setPassword('');
            onSuccess();
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Doğrulama başarısız.');
            setPassword('');
          } finally {
            setBusy(false);
          }
        }}
      >
        <label>
          Şifre
          <input
            type="password"
            name="password"
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            autoFocus
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <div className={inline ? 'customer-form-actions' : 'auth-actions'}>
          <Button disabled={busy} aria-busy={busy} type="submit">
            {busy ? 'Doğrulanıyor…' : 'Doğrula'}
          </Button>
          <Button
            variant="outline"
            disabled={busy}
            type="button"
            onClick={() => {
              setPassword('');
              onCancel();
            }}
          >
            Vazgeç
          </Button>
        </div>
      </form>
    </section>
  );
  return inline ? content : <div className="auth-backdrop">{content}</div>;
}
function PasswordForm({
  activation,
  onSuccess,
  onCancel,
}: {
  activation: boolean;
  onSuccess: () => void;
  onCancel?: () => void;
}) {
  const [current, setCurrent] = useState(''),
    [password, setPassword] = useState(''),
    [confirmation, setConfirmation] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <section className="auth-card">
      <h1>{activation ? 'Yeni şifrenizi belirleyin' : 'Şifremi değiştir'}</h1>
      <p>
        15–128 karakter kullanın. Boşluk, emoji ve parola yöneticileri desteklenir. Kolay tahmin
        edilen şifrelerden kaçının.
      </p>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          setError('');
          if (
            normalizeBoundedPassword(password) === null ||
            normalizeBoundedPassword(confirmation) === null ||
            (!activation && normalizeBoundedPassword(current) === null)
          ) {
            setError(PASSWORD_INPUT_MESSAGE);
            return;
          }
          if (password !== confirmation) {
            setError('Yeni şifreler eşleşmiyor.');
            return;
          }
          setBusy(true);
          try {
            await authMutation('/api/auth/password', {
              newPassword: password,
              confirmation,
              ...(activation ? {} : { currentPassword: current }),
            });
            setCurrent('');
            setPassword('');
            setConfirmation('');
            onSuccess();
          } catch (err) {
            setError(err instanceof Error ? err.message : 'Şifre değiştirilemedi.');
          } finally {
            setBusy(false);
          }
        }}
      >
        {!activation && (
          <label>
            Mevcut şifre
            <input
              type="password"
              name="currentPassword"
              autoComplete="current-password"
              value={current}
              onChange={(e) => setCurrent(e.target.value)}
              required
            />
          </label>
        )}
        <label>
          Yeni şifre
          <input
            type="password"
            name="newPassword"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
          />
        </label>
        <label>
          Yeni şifre tekrar
          <input
            type="password"
            name="confirmation"
            autoComplete="new-password"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            required
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <div className="auth-actions">
          <button type="submit" disabled={busy} aria-busy={busy}>
            {busy ? 'Kaydediliyor…' : 'Şifreyi kaydet'}
          </button>
          {onCancel && (
            <button type="button" onClick={onCancel} disabled={busy}>
              Vazgeç
            </button>
          )}
        </div>
      </form>
    </section>
  );
}
export function AuthShell() {
  const [session, setSession] = useState<AuthSessionDto | null | undefined>(undefined),
    [error, setError] = useState(''),
    [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [busy, setBusy] = useState(false),
    [turnstileSiteKey, setTurnstileSiteKey] = useState<string | null>(null),
    [turnstileToken, setTurnstileToken] = useState<string | null>(null),
    [challengeAttempt, setChallengeAttempt] = useState(0),
    [standaloneReauth, setStandaloneReauth] = useState(false);
  async function refresh() {
    try {
      const response = await fetch('/api/auth/session', { cache: 'no-store' });
      setTurnstileSiteKey(response.headers.get('X-Turnstile-Site-Key'));
      if (!response.ok) {
        setSession(null);
        return;
      }
      const result = (await response.json()) as { data: AuthSessionDto };
      setSession(result.data);
      invalidateCsrfToken();
    } catch {
      setError('Sunucuya bağlanılamadı.');
      setSession(null);
    }
  }
  useEffect(() => {
    const removeQuotePopBoundary = installQuotePopBoundary();
    void refresh();
    const ended = () => {
      setSession(null);
      invalidateCsrfToken();
      setStandaloneReauth(false);
    };
    document.addEventListener('mayi-session-ended', ended);
    return () => {
      document.removeEventListener('mayi-session-ended', ended);
      removeQuotePopBoundary();
    };
  }, []);
  const logout = async () => {
    setBusy(true);
    try {
      await authMutation('/api/auth/logout', {});
      setSession(null);
      setStandaloneReauth(false);
      setPassword('');
      invalidateCsrfToken();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Çıkış yapılamadı.');
    } finally {
      setBusy(false);
    }
  };
  if (session === undefined)
    return (
      <main className="auth-page">
        <p role="status">Oturum kontrol ediliyor…</p>
      </main>
    );
  if (session === null)
    return (
      <main className="auth-page">
        <section className="auth-card">
          <img
            className="auth-brand"
            src="/brand/mayi-logo-header.png"
            alt="Mayı Sigorta"
            width={420}
            height={175}
          />
          <h1>Giriş Yap</h1>
          <p>Yalnız acente sahibinizin oluşturduğu çalışan hesabıyla giriş yapabilirsiniz.</p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (busy || (turnstileSiteKey && !turnstileToken)) return;
              setError('');
              if (normalizeBoundedPassword(password) === null) {
                setError(PASSWORD_INPUT_MESSAGE);
                setPassword('');
                return;
              }
              setBusy(true);
              try {
                const response = await fetch('/api/auth/login', {
                  method: 'POST',
                  headers: { 'content-type': 'application/json' },
                  body: JSON.stringify({
                    email,
                    password,
                    ...(turnstileToken ? { turnstileToken } : {}),
                  }),
                  cache: 'no-store',
                });
                const result = (await response.json()) as { error?: { code?: string } };
                setPassword('');
                if (!response.ok) {
                  setError(
                    response.status === 401
                      ? 'E-posta veya şifre hatalı.'
                      : authErrorMessage(result.error?.code, response.status),
                  );
                  return;
                }
                await refresh();
              } catch {
                setPassword('');
                setError('Giriş tamamlanamadı.');
              } finally {
                setBusy(false);
                setTurnstileToken(null);
                setChallengeAttempt((value) => value + 1);
              }
            }}
          >
            <label>
              E-posta
              <Input
                type="email"
                autoComplete="username"
                value={email}
                maxLength={254}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
            <label>
              Şifre
              <Input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            {turnstileSiteKey && (
              <LoginChallenge
                key={challengeAttempt}
                siteKey={turnstileSiteKey}
                onToken={setTurnstileToken}
              />
            )}
            {error && <p role="alert">{error}</p>}
            <button
              type="submit"
              className="auth-login-button"
              aria-busy={busy}
              disabled={busy || (!!turnstileSiteKey && !turnstileToken)}
            >
              {busy ? 'Giriş yapılıyor…' : 'Giriş Yap'}
            </button>
          </form>
          <p className="auth-help">Şifrenizi unuttuysanız acente sahibinizle iletişime geçin.</p>
        </section>
      </main>
    );
  if (session.state === 'ACTIVATION')
    return (
      <main className="auth-page">
        <div>
          <PasswordForm activation onSuccess={() => void refresh()} />
          <button type="button" onClick={() => void logout()} disabled={busy}>
            Çıkış Yap
          </button>
          {error && <p role="alert">{error}</p>}
        </div>
      </main>
    );
  return (
    <BrowserRouter>
      <AuthenticatedApp
        session={session}
        busy={busy}
        error={error}
        onReauth={() => setStandaloneReauth(true)}
        onLogout={() => void logout()}
        reauth={
          standaloneReauth && (
            <ReauthForm
              onCancel={() => setStandaloneReauth(false)}
              onSuccess={() => {
                setStandaloneReauth(false);
                void refresh();
              }}
            />
          )
        }
        renderPassword={(done) => (
          <PasswordForm
            activation={false}
            onSuccess={() => {
              done();
              void refresh();
            }}
            onCancel={done}
          />
        )}
      />
    </BrowserRouter>
  );
}
