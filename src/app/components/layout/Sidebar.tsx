import { NavLink } from 'react-router';
import { PanelLeftClose, PanelLeftOpen, X } from 'lucide-react';
import type { RefObject } from 'react';
import { Button } from '../ui/button';
import { navigation } from './navigation';

export function Sidebar({
  owner,
  collapsed,
  mobileOpen,
  onCollapse,
  onClose,
  sidebarRef,
}: {
  owner: boolean;
  collapsed: boolean;
  mobileOpen: boolean;
  onCollapse: () => void;
  onClose: () => void;
  sidebarRef: RefObject<HTMLElement | null>;
}) {
  const link = (item: (typeof navigation)[number]) => (
    <NavLink
      key={item.path}
      to={item.path}
      end
      aria-label={item.label}
      title={collapsed ? item.label : undefined}
      onClick={onClose}
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
        <div>
          <strong className="sidebar-wordmark">
            Mayı <span>Sigorta</span>
          </strong>
          <span className="sidebar-caption">Acente çalışma alanı</span>
        </div>
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
