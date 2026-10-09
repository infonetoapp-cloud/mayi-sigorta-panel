import { useState, useEffect } from 'react';
import { App, invalidateCsrfToken } from './App';
import { PersonnelPanel } from './components/PersonnelPanel';

import { authErrorMessage } from './auth-errors';
import { normalizeBoundedPassword, PASSWORD_INPUT_MESSAGE } from '../shared/password-input';

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
    [view, setView] = useState<'crm' | 'personnel' | 'password'>('crm'),
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
    void refresh();
    const ended = () => {
      setSession(null);
      setView('crm');
      invalidateCsrfToken();
    };
    document.addEventListener('mayi-session-ended', ended);
    return () => document.removeEventListener('mayi-session-ended', ended);
  }, []);
  const logout = async () => {
    setBusy(true);
    try {
      await authMutation('/api/auth/logout', {});
      setSession(null);
      setView('crm');
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
          <div className="auth-brand">Mayı Sigorta</div>
          <h1>Giriş Yap</h1>
          <p>Yalnız acente sahibinizin oluşturduğu çalışan hesabıyla giriş yapabilirsiniz.</p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
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
              <input
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
              <input
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
              />
            </label>
            {error && <p role="alert">{error}</p>}
            <button type="submit" disabled={busy}>
              Giriş Yap
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
    <>
      <nav className="auth-toolbar" aria-label="Hesap işlemleri">
        <span>{session.email}</span>
        <div>
          <button onClick={() => setView('crm')}>Çalışma alanı</button>
          {session.isOwner && (
            <button onClick={() => setView('personnel')}>Personel ve İzinler</button>
          )}
          <button onClick={() => setView('password')}>Şifremi değiştir</button>
          <button onClick={() => setStandaloneReauth(true)}>Şifremi doğrula</button>
          <button onClick={() => void logout()} disabled={busy}>
            Çıkış Yap
          </button>
        </div>
      </nav>
      {error && <p role="alert">{error}</p>}
      {standaloneReauth && (
        <ReauthForm
          onCancel={() => setStandaloneReauth(false)}
          onSuccess={() => {
            setStandaloneReauth(false);
            void refresh();
          }}
        />
      )}
      {view === 'password' ? (
        <main className="auth-page">
          <PasswordForm
            activation={false}
            onSuccess={() => {
              setView('crm');
              void refresh();
            }}
            onCancel={() => setView('crm')}
          />
        </main>
      ) : view === 'personnel' ? (
        <PersonnelPanel />
      ) : (
        <App />
      )}
    </>
  );
}
