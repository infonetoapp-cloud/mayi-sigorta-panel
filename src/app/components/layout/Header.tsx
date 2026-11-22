import { Menu } from 'lucide-react';
import type { RefObject } from 'react';
import { Button } from '../ui/button';
export function Header({
  mobileOpen,
  toggleRef,
  onToggle,
}: {
  mobileOpen: boolean;
  toggleRef: RefObject<HTMLButtonElement | null>;
  onToggle: () => void;
}) {
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
        <span className="header-workspace">
          Mayı Sigorta <span>/ Çalışma alanı</span>
        </span>
      </div>
    </header>
  );
}
