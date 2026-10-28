import { useEffect, useRef, useState } from 'react';
import { registerQuotePopGuard } from '../pages/today-work/quote-navigation';

/** Same native POP/link/logout protocol as the completed V4 catalog workspace. */
export function useSettingsNavigation(dirty: boolean, hold: boolean, onHeld: () => void) {
  const [leave, setLeave] = useState<(() => void) | null>(null);
  const risk = useRef({ dirty, hold, onHeld });
  const approved = useRef<HTMLAnchorElement | null>(null);
  const allowPop = useRef(false);
  risk.current = { dirty, hold, onHeld };
  function guard(go: () => void) {
    if (risk.current.hold) risk.current.onHeld();
    else if (risk.current.dirty) setLeave(() => go);
    else go();
  }
  useEffect(() => {
    if (!dirty && !hold) return;
    const stable = { state: history.state, url: location.href };
    const unload = (e: BeforeUnloadEvent) => {
      e.preventDefault();
      e.returnValue = '';
    };
    const click = (e: MouseEvent) => {
      if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
      const a = e.target instanceof Element ? e.target.closest<HTMLAnchorElement>('a[href]') : null;
      if (
        !a ||
        a === approved.current ||
        a.target === '_blank' ||
        new URL(a.href).origin !== location.origin
      )
        return;
      e.preventDefault();
      e.stopPropagation();
      guard(() => {
        approved.current = a;
        try {
          a.click();
        } finally {
          approved.current = null;
        }
      });
    };
    const logout = (e: Event) => {
      e.preventDefault();
      const go = (e as CustomEvent<{ proceed?: () => void }>).detail?.proceed;
      if (go) guard(go);
    };
    document.addEventListener('click', click, true);
    document.addEventListener('mayi-logout-requested', logout);
    addEventListener('beforeunload', unload);
    const off = registerQuotePopGuard((e) => {
      if (allowPop.current) {
        allowPop.current = false;
        return;
      }
      e.stopImmediatePropagation();
      const dest = { state: history.state, url: location.href };
      history.replaceState(stable.state, '', stable.url);
      guard(() => {
        allowPop.current = true;
        history.replaceState(dest.state, '', dest.url);
        dispatchEvent(new PopStateEvent('popstate', { state: dest.state }));
      });
    });
    return () => {
      document.removeEventListener('click', click, true);
      document.removeEventListener('mayi-logout-requested', logout);
      removeEventListener('beforeunload', unload);
      off();
    };
  }, [dirty, hold]);
  return { leave, stay: () => setLeave(null), guard };
}
