import { useEffect, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router';
import { CustomerNotesSection } from '../../components/CustomerNotesSection';
import { NavigationDecision } from '../../components/layout/NavigationDecision';
import { getCsrfToken, invalidateCsrfToken } from '../../csrf';
import { registerQuotePopGuard } from '../today-work/quote-navigation';
import { customerListReturnState } from './customer-list-context';

/** Profile-local guard. Same-customer sections may hide, never unmount, this owner. */
export function CustomerNoteWorkspace({
  customerId,
  archived,
  visible,
}: {
  customerId: string;
  archived: boolean;
  visible: boolean;
}) {
  const navigate = useNavigate();
  const route = useLocation();
  const listKey: unknown = route.state?.listPositionKey;
  const risk = useRef({ dirty: false, unresolved: false });
  const [leave, setLeave] = useState<(() => void) | null>(null);
  const [message, setMessage] = useState('');
  const notice = useRef<HTMLParagraphElement>(null);
  const stay = () => setLeave(null);
  useEffect(() => {
    const index: unknown = history.state?.idx;
    let restoring = false,
      confirmed = false;
    const atRisk = () => risk.current.dirty || risk.current.unresolved;
    const hold = () => {
      setLeave(null);
      setMessage(
        'Not isteğinin sonucu henüz doğrulanmadı. Aynı müşteri kaydında kalın; yalnız özgün isteği veya not geçmişini yeniden kontrol edin.',
      );
      document.dispatchEvent(new Event('mayi-navigation-attention'));
    };
    const click = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (
        !atRisk() ||
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
      if (url.origin === location.origin && url.pathname === route.pathname) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      document.dispatchEvent(new Event('mayi-navigation-attention'));
      if (risk.current.unresolved) return hold();
      setLeave(() => () => {
        if (url.origin === location.origin) {
          const target = url.pathname + url.search + url.hash;
          void navigate(target, {
            state: target === '/customers' ? customerListReturnState(listKey) : undefined,
          });
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
        !atRisk() ||
        location.pathname === route.pathname ||
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
      if (atRisk()) {
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
  }, [navigate, route.key, route.pathname, listKey]);
  useEffect(() => {
    if (message) notice.current?.focus();
  }, [message]);
  return (
    <>
      {message && (
        <p role="alert" ref={notice} tabIndex={-1}>
          {message}
        </p>
      )}
      {leave && (
        <NavigationDecision onStay={stay}>
          <h3 id="navigation-decision-title">Müşteri notunu bırakmadan önce</h3>
          <p>
            Kaydedilmemiş not bu müşteriye aittir. Ayrılırsanız taslak bırakılır; başka müşteriye
            taşınmaz.
          </p>
          <button type="button" onClick={stay}>
            Bu ekranda kal
          </button>
          <button
            type="button"
            onClick={() => {
              if (risk.current.unresolved) {
                setLeave(null);
                setMessage('Önce not isteğinin sonucunu kontrol edin.');
                return;
              }
              const action = leave;
              setLeave(null);
              action();
            }}
          >
            Taslağı bırak ve ayrıl
          </button>
        </NavigationDecision>
      )}
      <div hidden={!visible}>
        <CustomerNotesSection
          customerId={customerId}
          archived={archived}
          presentation="page"
          getCsrfToken={getCsrfToken}
          invalidateCsrfToken={invalidateCsrfToken}
          onRiskChange={(value) => {
            risk.current = value;
          }}
        />
      </div>
    </>
  );
}
