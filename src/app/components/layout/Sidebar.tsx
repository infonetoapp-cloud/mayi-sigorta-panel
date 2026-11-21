import { NavLink } from 'react-router';
import { PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import type { RefObject, ReactNode } from 'react';
import { Button } from '../ui/button';
import { warmWorkspacePage } from '../../workspace-page-imports';
import { navigation } from './navigation';

export function Sidebar({
  owner,
  collapsed,
  mobileOpen,
  onCollapse,
  onClose,
  sidebarRef,
  mobileAccountActions,
}: {
  owner: boolean;
  collapsed: boolean;
  mobileOpen: boolean;
  onCollapse: () => void;
  onClose: () => void;
  sidebarRef: RefObject<HTMLElement | null>;
  mobileAccountActions?: ReactNode;
}) {
  const link = (item: (typeof navigation)[number]) => (
    <NavLink
      key={item.path}
      to={item.path}
      end={!['/customers', '/policies', '/today-work', '/renewals'].includes(item.path)}
      aria-label={item.label}
      title={collapsed ? item.label : undefined}
      onClick={onClose}
      onPointerEnter={(event) => {
        if (event.pointerType === 'mouse') warmWorkspacePage(item.path);
      }}
      onFocus={() => warmWorkspacePage(item.path)}
      className={({ isActive }) => `sidebar-link${isActive ? ' sidebar-link-active' : ''}`}
    >
      <item.icon size={19} aria-hidden="true" />
      <span className="sidebar-label">{item.label}</span>
    </NavLink>
  );
  return (
    <aside
      id="app-sidebar"
      ref={sidebarRef}
      className="app-sidebar"
      data-collapsed={collapsed}
      data-mobile-open={mobileOpen}
      aria-label="Çalışma alanı menüsü"
    >
      <div className="sidebar-brand">
        <img
          className="sidebar-brand-wordmark"
          src="/brand/mayi-logo-footer-white.png"
          alt="Mayı Sigorta"
          width={420}
          height={175}
        />
        <img
          className="sidebar-brand-mark"
          src="/brand/favicon-32x32.png"
          alt="Mayı Sigorta"
          width={32}
          height={32}
        />
        <Button
          className="mobile-only"
          variant="ghost"
          size="icon"
          aria-label="Menüyü kapat"
          onClick={onClose}
        >
          <X />
        </Button>
      </div>
      <nav aria-label="Ana menü">
        <p className="sidebar-section-label">ÇALIŞMA ALANI</p>
        {navigation.filter((item) => !item.ownerOnly).map(link)}
        {owner && (
          <>
            <p className="sidebar-section-label sidebar-management">YÖNETİM</p>
            {navigation.filter((item) => item.ownerOnly).map(link)}
          </>
        )}
      </nav>
      {mobileOpen && mobileAccountActions}
      <div className="sidebar-footer">
        <Button
          variant="ghost"
          className="sidebar-collapse"
          aria-controls="app-sidebar"
          aria-expanded={!collapsed}
          aria-label={collapsed ? 'Menüyü genişlet' : 'Menüyü daralt'}
          onClick={onCollapse}
        >
          {collapsed ? <PanelLeftOpen /> : <PanelLeftClose />}
          <span className="sidebar-label">Menüyü daralt</span>
        </Button>
      </div>
    </aside>
  );
}
