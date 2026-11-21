import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { NavigationDecision } from '../../components/layout/NavigationDecision';
import { Button } from '../../components/ui/button';
import { registerQuotePopGuard } from '../today-work/quote-navigation';
import { customerListReturnState } from './customer-list-context';

/** Keeps a number draft and its uncertain write bound to this customer. */
export function CustomerNumberGuard({
  dirty,
  unresolved,
  label = 'Müşteri numarası',
  protectSearch = false,
  listReturn,
}: {
  dirty: boolean;
  unresolved: boolean;
  label?: string;
  protectSearch?: boolean;
  listReturn?: { to: string; listPositionKey: string };
}) {
  const route = useLocation(),
    navigate = useNavigate();
  const risk = useRef({ dirty, unresolved });
  risk.current = { dirty, unresolved };
  const [leave, setLeave] = useState<(() => void) | null>(null),
    [message, setMessage] = useState('');
  const listPath = listReturn?.to;
  const listPositionKey = listReturn?.listPositionKey;
  const customerListKey: unknown = route.state?.listPositionKey;
  useEffect(() => {
    const index: unknown = history.state?.idx;
    let restoring = false,
      confirmed = false;
    const hold = () => {
      setLeave(null);
      setMessage(
        `${label} kaydı henüz doğrulanmadı. Önce aynı işlemi veya kayıtlı bilgileri yeniden kontrol edin.`,
      );
      document.dispatchEvent(new Event('mayi-navigation-attention'));
    };
    const click = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (
        !(risk.current.dirty || risk.current.unresolved) ||
        !(link instanceof HTMLAnchorElement) ||
        event.button !== 0 ||
        event.ctrlKey ||
        event.metaKey ||
        event.shiftKey ||
        event.altKey ||
        link.hasAttribute('download') ||
        (link.target && link.target !== '_self')
      )
        return;
      const url = new URL(link.href);
      if (
        url.origin === location.origin &&
        url.pathname === route.pathname &&
        (!protectSearch || url.search === route.search)
      )
        return;
      event.preventDefault();
      event.stopImmediatePropagation();
      document.dispatchEvent(new Event('mayi-navigation-attention'));
      if (risk.current.unresolved) return hold();
      setLeave(() => () => {
        if (url.origin === location.origin) {
          const target = url.pathname + url.search + url.hash;
          const state =
            target === listPath
              ? { listPositionKey }
              : target === '/customers' && route.pathname.startsWith('/customers/')
                ? customerListReturnState(customerListKey)
                : undefined;
          void navigate(target, { state });
        } else location.assign(url.href);
      });
    };
    const pop = (event: PopStateEvent) => {
      if (confirmed) {
        confirmed = false;
        return;
      }
      if (restoring) {
        restoring = false;
        event.stopImmediatePropagation();
        return;
      }
      const next: unknown = event.state?.idx;
      if (
        !(risk.current.dirty || risk.current.unresolved) ||
        (location.pathname === route.pathname &&
          (!protectSearch || location.search === route.search)) ||
        !Number.isSafeInteger(index) ||
        !Number.isSafeInteger(next) ||
        index === next
      )
        return;
      event.stopImmediatePropagation();
      restoring = true;
      history.go((index as number) - (next as number));
      if (risk.current.unresolved) return hold();
      setLeave(() => () => {
        confirmed = true;
        history.go((next as number) - (index as number));
      });
    };
    const unload = (event: BeforeUnloadEvent) => {
      if (risk.current.dirty || risk.current.unresolved) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    document.addEventListener('click', click, true);
    addEventListener('beforeunload', unload);
    const remove = registerQuotePopGuard(pop);
    return () => {
      document.removeEventListener('click', click, true);
      removeEventListener('beforeunload', unload);
      remove();
    };
  }, [
    navigate,
    route.key,
    route.pathname,
    route.search,
    label,
    protectSearch,
    listPath,
    listPositionKey,
    customerListKey,
  ]);
  return (
    <>
      {message && unresolved && <p role="alert">{message}</p>}
      {leave && (
        <NavigationDecision onStay={() => setLeave(null)}>
          <h3 id="navigation-decision-title">{label} taslağını bırakmadan önce</h3>
          <p>Kaydedilmemiş bilgiler bu kayda aittir. Ayrılırsanız taslak bırakılır.</p>
          <Button variant="outline" onClick={() => setLeave(null)}>
            Bu ekranda kal
          </Button>
          <Button
            onClick={() => {
              if (risk.current.unresolved) {
                setLeave(null);
                setMessage('Önce kaydı doğrulayın.');
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
