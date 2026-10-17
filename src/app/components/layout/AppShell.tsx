import { useEffect, useRef, useState, type ReactNode } from 'react';
import { useLocation } from 'react-router';
import type { AuthSessionDto } from '../../AuthShell';
import { Sidebar } from './Sidebar';
import { Header } from './Header';
import { PageContainer } from './PageContainer';
import { navigation } from './navigation';
export function AppShell({
  session,
  busy,
  onReauth,
  onLogout,
  children,
}: {
  session: AuthSessionDto;
  busy: boolean;
  onReauth: () => void;
  onLogout: () => void;
  children: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(false);
  const [mobileOpen, setMobileOpen] = useState(false);
  const sidebarRef = useRef<HTMLElement>(null);
  const toggleRef = useRef<HTMLButtonElement>(null);
  const mainRef = useRef<HTMLElement>(null);
  const location = useLocation();
  useEffect(() => {
    document.title = `${navigation.find((item) => item.path === location.pathname)?.label ?? (location.pathname === '/account/password' ? 'Şifremi değiştir' : 'Sayfa bulunamadı')} · Mayı Sigorta`;
    mainRef.current?.focus();
  }, [location.pathname]);
  useEffect(() => {
    if (!mobileOpen) return;
    sidebarRef.current?.querySelector('a')?.focus();
    const close = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMobileOpen(false);
        toggleRef.current?.focus();
      }
    };
    document.addEventListener('keydown', close);
    return () => document.removeEventListener('keydown', close);
  }, [mobileOpen]);
  return (
    <div className="app-shell" data-collapsed={collapsed}>
      <a href="#main-content" className="skip-link">
        İçeriğe geç
      </a>
      <Sidebar
        owner={session.isOwner}
        collapsed={collapsed}
        mobileOpen={mobileOpen}
        sidebarRef={sidebarRef}
        onCollapse={() => setCollapsed((value) => !value)}
        onClose={() => setMobileOpen(false)}
      />
      <div className="app-body">
        <Header
          session={session}
          busy={busy}
          mobileOpen={mobileOpen}
          toggleRef={toggleRef}
          onToggle={() => setMobileOpen((value) => !value)}
          onReauth={onReauth}
          onLogout={onLogout}
        />
        <main id="main-content" ref={mainRef} tabIndex={-1} className="app-main">
          <PageContainer>{children}</PageContainer>
        </main>
        <footer className="app-footer">Mayı Sigorta · Birlikte, güvenle.</footer>
      </div>
    </div>
  );
}
