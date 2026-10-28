import { useState, useEffect } from 'react';
import { invalidateCsrfToken } from './csrf';
import { BrowserRouter } from 'react-router';
import { AuthenticatedApp } from './AuthenticatedApp';
import { Input } from './components/ui/input';
import { ArrowRight, Eye, EyeOff, ShieldCheck } from 'lucide-react';

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
}: {
  onSuccess: () => void;
  onCancel: () => void;
}) {
  const [password, setPassword] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  return (
    <div className="auth-backdrop">
      <section className="auth-card" role="dialog" aria-modal="true" aria-labelledby="reauth-title">
        <h2 id="reauth-title">Devam etmek için şifrenizi tekrar girin</h2>
        <p>Kendi kalıcı şifrenizle bu işlemi doğrulayın.</p>
        <form
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
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              autoFocus
            />
          </label>
          {error && <p role="alert">{error}</p>}
          <div className="auth-actions">
            <button disabled={busy} type="submit">
              Doğrula
            </button>
            <button
              type="button"
              onClick={() => {
                setPassword('');
                onCancel();
              }}
            >
              Vazgeç
            </button>
          </div>
        </form>
      </section>
    </div>
  );
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
            autoComplete="new-password"
            value={confirmation}
            onChange={(e) => setConfirmation(e.target.value)}
            required
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <div className="auth-actions">
          <button type="submit" disabled={busy}>
            Şifreyi kaydet
          </button>
          {onCancel && (
            <button type="button" onClick={onCancel}>
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
    [showPassword, setShowPassword] = useState(false),
    [standaloneReauth, setStandaloneReauth] = useState(false);
  async function refresh() {
    try {
      const response = await fetch('/api/auth/session', { cache: 'no-store' });
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
      setShowPassword(false);
    };
    document.addEventListener('mayi-session-ended', ended);
    return () => {
      document.removeEventListener('mayi-session-ended', ended);
      removeQuotePopBoundary();
    };
  }, []);
  const performLogout = async () => {
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
  const logout = () => {
    // Only voluntary logout is deferrable. Server-driven session-ended stays authoritative.
    const request = new CustomEvent('mayi-logout-requested', {
      cancelable: true,
      detail: { proceed: () => void performLogout() },
    });
    if (document.dispatchEvent(request)) void performLogout();
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
        <section className="auth-card auth-login" aria-labelledby="login-title">
          <div className="auth-brand">
            <span className="auth-brand-mark" aria-hidden="true">
              m
            </span>
            <span>
              mayı<small>SİGORTA</small>
            </span>
          </div>
          <div className="auth-eyebrow">ACENTE ÇALIŞMA ALANI</div>
          <h1 id="login-title">Giriş Yap</h1>
          <p>Müşterileriniz, poliçeleriniz ve günlük işleriniz bir arada.</p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              if (busy) return;
              setShowPassword(false);
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
                  body: JSON.stringify({ email, password }),
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
                autoCapitalize="none"
                spellCheck={false}
                onChange={(e) => setEmail(e.target.value)}
                required
              />
            </label>
            <label htmlFor="login-password">Şifre</label>
            <div className="auth-password-field">
              <Input
                id="login-password"
                type={showPassword ? 'text' : 'password'}
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
              <button
                type="button"
                className="auth-password-toggle"
                aria-label={showPassword ? 'Şifreyi gizle' : 'Şifreyi göster'}
                aria-pressed={showPassword}
                onClick={() => setShowPassword((value) => !value)}
              >
                {showPassword ? (
                  <EyeOff size={18} aria-hidden="true" />
                ) : (
                  <Eye size={18} aria-hidden="true" />
                )}
              </button>
            </div>
            {error && <p role="alert">{error}</p>}
            <button type="submit" disabled={busy} className="auth-primary" aria-busy={busy}>
              {busy ? 'Giriş yapılıyor…' : 'Giriş Yap'}
              <ArrowRight size={18} aria-hidden="true" />
            </button>
          </form>
          <p className="auth-help">Şifrenizi unuttuysanız acente sahibinizle iletişime geçin.</p>
          <div className="auth-access-note">
            <ShieldCheck size={16} aria-hidden="true" />
            <span>Yalnız yetkili acente çalışanları içindir.</span>
          </div>
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
