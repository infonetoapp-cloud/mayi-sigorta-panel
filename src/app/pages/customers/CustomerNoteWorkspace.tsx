import { useEffect, useRef, useState } from 'react';
import { useLocation } from 'react-router';
import { CustomerNotesSection } from '../../components/CustomerNotesSection';
import { NavigationDecision } from '../../components/layout/NavigationDecision';
import { getCsrfToken, invalidateCsrfToken } from '../../csrf';
import { registerQuotePopGuard } from '../today-work/quote-navigation';

/** Profile-local guard. Same-customer sections may hide, never unmount, this owner. */
export function CustomerNoteWorkspace({
  customerId,
  archived,
  visible,
  externalRisk,
  externalRevision = 0,
  loadNotes = true,
}: {
  customerId: string;
  archived: boolean;
  visible: boolean;
  externalRisk?: { current: Record<string, { dirty: boolean; unresolved: boolean }> };
  externalRevision?: number;
  loadNotes?: boolean;
}) {
  const route = useLocation();
  const risk = useRef({ dirty: false, unresolved: false });
  const [leave, setLeave] = useState<(() => void) | null>(null);
  const [message, setMessage] = useState('');
  const notice = useRef<HTMLParagraphElement>(null);
  const stay = () => setLeave(null);
  useEffect(() => {
    if (
      !risk.current.unresolved &&
      !Object.values(externalRisk?.current ?? {}).some((r) => r.unresolved)
    )
      setMessage('');
  }, [externalRevision, externalRisk]);
  useEffect(() => {
    const index: unknown = history.state?.idx;
    let restoring = false,
      confirmed = false;
    let approvedLink: HTMLAnchorElement | null = null;
    const unresolved = () =>
      risk.current.unresolved ||
      Object.values(externalRisk?.current ?? {}).some((r) => r.unresolved);
    const atRisk = () =>
      risk.current.dirty ||
      unresolved() ||
      Object.values(externalRisk?.current ?? {}).some((r) => r.dirty);
    const hold = () => {
      setLeave(null);
      setMessage(
        'İşlemin sonucu henüz kesinleşmedi. Aynı müşteri kaydında kalın; yalnız özgün isteği veya güncel kayıtları yeniden kontrol edin.',
      );
      document.dispatchEvent(new Event('mayi-navigation-attention'));
    };
    const click = (event: MouseEvent) => {
      const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
      if (link && link === approvedLink) return;
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
      if (unresolved()) return hold();
      setLeave(() => () => {
        // Replay the actual Link, including its state/options and contextual onClick.
        if (!link.isConnected) return;
        approvedLink = link;
        link.click();
        approvedLink = null;
      });
    };
    const logout = (event: Event) => {
      if (!atRisk()) return;
      event.preventDefault();
      document.dispatchEvent(new Event('mayi-navigation-attention'));
      if (unresolved()) return hold();
      const proceed = (event as CustomEvent<{ proceed?: () => void }>).detail?.proceed;
      if (typeof proceed === 'function') setLeave(() => proceed);
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
      if (unresolved()) return hold();
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
    document.addEventListener('mayi-logout-requested', logout);
    addEventListener('beforeunload', unload);
    const remove = registerQuotePopGuard(pop);
    return () => {
      document.removeEventListener('click', click, true);
      document.removeEventListener('mayi-logout-requested', logout);
      removeEventListener('beforeunload', unload);
      remove();
    };
  }, [route.key, route.pathname, externalRisk]);
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
          <h3 id="navigation-decision-title">Müşteri taslaklarını bırakmadan önce</h3>
          <p>
            Kaydedilmemiş bilgiler bu müşteriye aittir. Ayrılırsanız taslaklar bırakılır; başka
            müşteriye taşınmaz.
          </p>
          <button type="button" onClick={stay}>
            Bu ekranda kal
          </button>
          <button
            type="button"
            onClick={() => {
              if (
                risk.current.unresolved ||
                Object.values(externalRisk?.current ?? {}).some((r) => r.unresolved)
              ) {
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
      {loadNotes && (
        <div hidden={!visible}>
          <CustomerNotesSection
            customerId={customerId}
            archived={archived}
            presentation="page"
            getCsrfToken={getCsrfToken}
            invalidateCsrfToken={invalidateCsrfToken}
            onRiskChange={(value) => {
              risk.current = value;
              if (
                !value.unresolved &&
                !Object.values(externalRisk?.current ?? {}).some((r) => r.unresolved)
              )
                setMessage('');
            }}
          />
        </div>
      )}
    </>
  );
}
