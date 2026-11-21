import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { Link, useLocation } from 'react-router';
import { ChevronUp, KeyRound, LogOut, ShieldCheck, UserRound } from 'lucide-react';
import type { AuthSessionDto } from '../../AuthShell';
import { Button } from '../ui/button';

export function MobileAccountActions({
  busy,
  onReauth,
  onLogout,
  onClose,
}: {
  busy: boolean;
  onReauth: () => void;
  onLogout: () => void;
  onClose: () => void;
}) {
  return (
    <section className="sidebar-account" aria-label="Hesap işlemleri">
      <p className="sidebar-section-label">HESAP</p>
      <Link className="sidebar-link" to="/account/password" onClick={onClose}>
        <KeyRound size={19} aria-hidden="true" /> Şifremi değiştir
      </Link>
      <Button
        variant="ghost"
        className="sidebar-link"
        onClick={() => {
          onReauth();
          onClose();
        }}
      >
        <ShieldCheck size={19} aria-hidden="true" /> Şifremi doğrula
      </Button>
      <Button
        variant="ghost"
        className="sidebar-link sidebar-account-logout"
        disabled={busy}
        onClick={onLogout}
      >
        <LogOut size={19} aria-hidden="true" /> Çıkış Yap
      </Button>
    </section>
  );
}

export function AccountMenu({
  session,
  busy,
  onReauth,
  onLogout,
}: {
  session: AuthSessionDto;
  busy: boolean;
  onReauth: () => void;
  onLogout: () => void;
}) {
  const id = useId();
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const keyboardOpen = useRef(false);
  const [open, setOpen] = useState(false);
  const [nativePopover] = useState(
    () => typeof HTMLElement !== 'undefined' && Object.hasOwn(HTMLElement.prototype, 'popover'),
  );
  const [nativeInvoker] = useState(
    () =>
      typeof HTMLButtonElement !== 'undefined' &&
      'commandForElement' in HTMLButtonElement.prototype,
  );
  const [nativeFocusgroup] = useState(
    () => typeof HTMLElement !== 'undefined' && 'focusGroup' in HTMLElement.prototype,
  );
  const route = useLocation();
  function close(restore = true) {
    if (restore) trigger.current?.focus();
    if (nativePopover && panel.current?.matches(':popover-open')) panel.current.hidePopover();
    setOpen(false);
  }
  useEffect(() => {
    close(false);
  }, [route.key]);
  useEffect(() => {
    const attention = () => close(false);
    document.addEventListener('mayi-navigation-attention', attention);
    return () => document.removeEventListener('mayi-navigation-attention', attention);
  }, []);
  useEffect(() => {
    if (!open) return;
    if (keyboardOpen.current)
      panel.current?.querySelector<HTMLElement>('a,button:not(:disabled)')?.focus();
    const outside = (event: PointerEvent) => {
      if (
        !nativePopover &&
        event.target instanceof Node &&
        !panel.current?.contains(event.target) &&
        !trigger.current?.contains(event.target)
      )
        close(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  function keys(event: KeyboardEvent) {
    if (event.key === 'Escape' || event.key === 'Tab') {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
      }
      close();
      return;
    }
    if (!nativeFocusgroup && ['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      const items = Array.from(
        panel.current?.querySelectorAll<HTMLElement>('a,button:not(:disabled)') ?? [],
      );
      const index = items.indexOf(document.activeElement as HTMLElement);
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : (index + (event.key === 'ArrowUp' ? -1 : 1) + items.length) % items.length;
      event.preventDefault();
      items[next]?.focus();
    }
  }
  return (
    <div className="account-menu">
      <Button
        ref={trigger}
        id={id + '-trigger'}
        type="button"
        variant="ghost"
        className="account-menu-trigger"
        aria-label="Hesap menüsü"
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={id}
        {...(nativeInvoker && nativePopover ? { commandfor: id, command: 'toggle-popover' } : {})}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown') {
            event.preventDefault();
            keyboardOpen.current = true;
            if (!open) trigger.current?.click();
            else panel.current?.querySelector<HTMLElement>('a,button:not(:disabled)')?.focus();
          }
        }}
        onClick={(event) => {
          keyboardOpen.current = event.detail === 0;
          if (nativePopover && nativeInvoker) return;
          if (open) close();
          else if (nativePopover) panel.current?.showPopover();
          else setOpen(true);
        }}
      >
        <span className="account-avatar">
          <UserRound size={19} aria-hidden="true" />
        </span>
        <span className="account-menu-label">
          <strong>Hesabım</strong>
          <small>{session.isOwner ? 'Acente sahibi' : 'Çalışan'}</small>
        </span>
        <ChevronUp className="account-menu-chevron" size={16} aria-hidden="true" />
      </Button>
      <div
        ref={panel}
        id={id}
        className="account-menu-panel"
        popover={nativePopover ? 'auto' : undefined}
        hidden={!nativePopover && !open}
        onToggle={(event) => {
          const next = (event.nativeEvent as ToggleEvent).newState === 'open';
          setOpen(next);
        }}
      >
        <p className="account-menu-email" title={session.email}>
          {session.email}
        </p>
        <div
          {...{ focusgroup: 'menu nomemory' }}
          role={nativeFocusgroup ? undefined : 'menu'}
          aria-labelledby={id + '-trigger'}
          onKeyDown={keys}
          onClick={(event) => {
            if ((event.target as Element).closest('a,button')) close();
          }}
        >
          <Link to="/account/password" role={nativeFocusgroup ? undefined : 'menuitem'}>
            <KeyRound size={16} aria-hidden="true" />
            Şifremi değiştir
          </Link>
          <button type="button" role={nativeFocusgroup ? undefined : 'menuitem'} onClick={onReauth}>
            <ShieldCheck size={16} aria-hidden="true" />
            Şifremi doğrula
          </button>
          <hr />
          <button
            type="button"
            role={nativeFocusgroup ? undefined : 'menuitem'}
            className="account-menu-logout"
            disabled={busy}
            onClick={onLogout}
          >
            <LogOut size={16} aria-hidden="true" />
            Çıkış Yap
          </button>
        </div>
      </div>
    </div>
  );
}
