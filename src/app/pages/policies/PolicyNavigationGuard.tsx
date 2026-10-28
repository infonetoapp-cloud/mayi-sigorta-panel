import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { NavigationDecision } from '../../components/layout/NavigationDecision';
import { Button } from '../../components/ui/button';
import { registerQuotePopGuard } from '../today-work/quote-navigation';
export interface PortfolioRisk {
  dirty: boolean;
  unresolved: boolean;
}
/** Active selected-policy renewal owns its guards. No DTO, key, or draft is persisted. */
export function PolicyNavigationGuard({
  risks,
  revision,
}: {
  risks: { current: Record<string, PortfolioRisk> };
  revision: number;
}) {
  const route = useLocation();
  const [leave, setLeave] = useState<(() => void) | null>(null);
  const [message, setMessage] = useState('');
  const notice = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (!Object.values(risks.current).some((r) => r.unresolved)) setMessage('');
  }, [revision, risks]);
  useEffect(() => {
    if (message) notice.current?.focus();
  }, [message]);
  useEffect(() => {
    const index: unknown = history.state?.idx;
    let restoring = false,
      confirmed = false;
    let approved: HTMLAnchorElement | null = null;
    const frozen = () => Object.values(risks.current).some((r) => r.unresolved);
    const dirty = () => Object.values(risks.current).some((r) => r.dirty || r.unresolved);
    const hold = (
      text = 'İşlemin sonucu henüz kesinleşmedi. Seçili poliçede kalın; yalnız özgün isteği veya kayıt geçmişini yeniden kontrol edin.',
    ) => {
      setLeave(null);
      setMessage(text);
      document.dispatchEvent(new Event('mayi-navigation-attention'));
    };
    const click = (e: MouseEvent) => {
      const a = e.target instanceof Element ? e.target.closest('a[href]') : null;
      if (
        a === approved ||
        !dirty() ||
        !(a instanceof HTMLAnchorElement) ||
        e.button !== 0 ||
        e.ctrlKey ||
        e.metaKey ||
        e.altKey ||
        e.shiftKey ||
        a.hasAttribute('download') ||
        (a.target && a.target !== '_self')
      )
        return;
      const target = new URL(a.href);
      const samePolicy = target.origin === location.origin && target.pathname === route.pathname;
      if (
        samePolicy &&
        ['general', 'renewal'].includes(target.searchParams.get('section') ?? 'general')
      )
        return;
      e.preventDefault();
      e.stopImmediatePropagation();
      document.dispatchEvent(new Event('mayi-navigation-attention'));
      if (frozen()) return hold();
      if (samePolicy)
        return hold(
          'Önce açık yenileme taslağını kaydedin veya formdan açıkça vazgeçin. Aynı anda başka bir poliçe düzenleme işlemi başlatılmaz.',
        );
      setLeave(() => () => {
        if (!a.isConnected) return;
        approved = a;
        a.click();
        approved = null;
      });
    };
    const logout = (e: Event) => {
      if (!dirty()) return;
      e.preventDefault();
      if (frozen()) return hold();
      const proceed = (e as CustomEvent<{ proceed?: () => void }>).detail?.proceed;
      if (typeof proceed === 'function') setLeave(() => proceed);
    };
    const pop = (e: PopStateEvent) => {
      if (confirmed) {
        confirmed = false;
        return;
      }
      if (restoring) {
        restoring = false;
        e.stopImmediatePropagation();
        return;
      }
      const next: unknown = e.state?.idx;
      if (
        !dirty() ||
        (location.pathname === route.pathname &&
          ['general', 'renewal'].includes(
            new URLSearchParams(location.search).get('section') ?? 'general',
          )) ||
        !Number.isSafeInteger(index) ||
        !Number.isSafeInteger(next) ||
        index === next
      )
        return;
      e.stopImmediatePropagation();
      restoring = true;
      history.go((index as number) - (next as number));
      if (frozen()) return hold();
      if (location.pathname === route.pathname)
        return hold('Önce açık yenileme taslağını kaydedin veya formdan açıkça vazgeçin.');
      setLeave(() => () => {
        confirmed = true;
        history.go((next as number) - (index as number));
      });
    };
    const unload = (e: BeforeUnloadEvent) => {
      if (dirty()) {
        e.preventDefault();
        e.returnValue = '';
      }
    };
    document.addEventListener('click', click, true);
    document.addEventListener('mayi-logout-requested', logout);
    addEventListener('beforeunload', unload);
    const remove = dirty() ? registerQuotePopGuard(pop) : () => {};
    return () => {
      document.removeEventListener('click', click, true);
      document.removeEventListener('mayi-logout-requested', logout);
      removeEventListener('beforeunload', unload);
      remove();
    };
  }, [route.key, route.pathname, risks, revision]);
  return (
    <>
      {message && (
        <p role="alert" ref={notice} tabIndex={-1}>
          {message}
        </p>
      )}
      {leave && (
        <NavigationDecision onStay={() => setLeave(null)}>
          <h2 id="navigation-decision-title">Kaydedilmemiş poliçe işlemi var</h2>
          <p>
            Seçili poliçenin taslağı bu ekranda korunur. Ayrılmak taslağı bırakır; başka kayda
            taşımaz.
          </p>
          <Button onClick={() => setLeave(null)}>Bu ekranda kal</Button>
          <Button
            variant="outline"
            onClick={() => {
              if (Object.values(risks.current).some((r) => r.unresolved)) {
                setLeave(null);
                setMessage('Önce işlemin sonucunu kontrol edin.');
                return;
              }
              const action = leave;
              setLeave(null);
              action();
            }}
          >
            Taslağı bırak ve ayrıl
          </Button>
        </NavigationDecision>
      )}
    </>
  );
}
