import { Link, useLocation } from 'react-router';
import { Menu, LogOut, KeyRound, ShieldCheck } from 'lucide-react';
import type { RefObject } from 'react';
import type { AuthSessionDto } from '../../AuthShell';
import { Button } from '../ui/button';
import { navigation } from './navigation';
export function Header({
  session,
  busy,
  mobileOpen,
  toggleRef,
  onToggle,
  onReauth,
  onLogout,
}: {
  session: AuthSessionDto;
  busy: boolean;
  mobileOpen: boolean;
  toggleRef: RefObject<HTMLButtonElement | null>;
  onToggle: () => void;
  onReauth: () => void;
  onLogout: () => void;
}) {
  const { pathname } = useLocation();
  const context =
    navigation.find((item) => item.path === pathname)?.label ??
    (pathname.startsWith('/today-work/')
      ? 'Bugünkü İşler'
      : pathname.startsWith('/customers/')
        ? 'Müşteri çalışma alanı'
        : pathname.startsWith('/policies/')
          ? 'Poliçe işlemleri'
          : 'Hesabım');
  return (
    <header className="app-header">
      <div className="header-context">
        <Button
          ref={toggleRef}
          variant="ghost"
          size="icon"
          className="mobile-only"
          aria-label={mobileOpen ? 'Menüyü kapat' : 'Menüyü aç'}
          aria-controls="app-sidebar"
          aria-expanded={mobileOpen}
          onClick={onToggle}
        >
          <Menu />
        </Button>
        <nav className="header-workspace" aria-label="Bulunduğunuz alan">
          <span>Mayı Sigorta / </span>
          <strong>{context}</strong>
        </nav>
      </div>
      <div className="header-account">
        <div className="account-identity">
          <span className="account-email">{session.email}</span>
          <span className="account-role">{session.isOwner ? 'Acente sahibi' : 'Çalışan'}</span>
        </div>
        <nav aria-label="Hesap işlemleri" className="account-actions">
          <Button asChild variant="ghost" size="icon">
            <Link to="/account/password" aria-label="Şifremi değiştir" title="Şifremi değiştir">
              <KeyRound />
            </Link>
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label="Şifremi doğrula"
            title="Şifremi doğrula"
            onClick={onReauth}
          >
            <ShieldCheck />
          </Button>
          <Button variant="outline" size="sm" onClick={onLogout} disabled={busy}>
            <LogOut aria-hidden="true" />
            <span>Çıkış Yap</span>
          </Button>
        </nav>
      </div>
    </header>
  );
}
