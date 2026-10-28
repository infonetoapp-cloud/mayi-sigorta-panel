import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useSettingsNavigation } from './settings-navigation';
import { NavigationDecision } from './layout/NavigationDecision';
import { Button } from './ui/button';
import './legacy-customer-boundary.css';
type Risk = { dirty: boolean; unresolved: boolean };
const Context = createContext<{ update: (id: string, risk: Risk | null) => void } | null>(null);
export function useLegacyCustomerRisk(dirty: boolean, unresolved: boolean) {
  const parent = useContext(Context),
    id = useId();
  useEffect(() => {
    parent?.update(id, { dirty, unresolved });
  }, [parent, id, dirty, unresolved]);
  useEffect(() => () => parent?.update(id, null), [parent, id]);
  return parent !== null;
}
export function requestLegacyCustomerClose() {
  document.dispatchEvent(new Event('mayi-legacy-customer-close'));
}
/** Keep the existing advanced commands mounted until every nested draft/write is safe. */
export function LegacyCustomerBoundary({
  children,
  title,
  onClose,
  externalRisk,
  presentation = 'dialog',
}: {
  children: ReactNode;
  title: string;
  onClose: () => void;
  externalRisk?: Risk;
  presentation?: 'dialog' | 'page';
}) {
  const ref = useRef<HTMLDivElement>(null),
    latestClose = useRef(onClose);
  latestClose.current = onClose;
  const [risks, setRisks] = useState<Record<string, Risk>>({}),
    [message, setMessage] = useState('');
  const update = useCallback(
    (id: string, risk: Risk | null) =>
      setRisks((prev) => {
        if (risk && prev[id]?.dirty === risk.dirty && prev[id]?.unresolved === risk.unresolved)
          return prev;
        const next = { ...prev };
        if (risk) next[id] = risk;
        else delete next[id];
        return next;
      }),
    [],
  );
  const context = useMemo(() => ({ update }), [update]);
  const all = [...Object.values(risks), ...(externalRisk ? [externalRisk] : [])];
  const dirty = all.some((r) => r.dirty),
    hold = all.some((r) => r.unresolved);
  const navigation = useSettingsNavigation(dirty, hold, () =>
    setMessage(
      'İşlemin sonucu henüz kesinleşmedi. Bu müşteride kalın ve aynı isteği yeniden kontrol edin.',
    ),
  );
  const guard = useRef(navigation.guard);
  guard.current = navigation.guard;
  useEffect(() => {
    const before = document.activeElement;
    ref.current?.focus();
    const close = () => guard.current(() => latestClose.current());
    document.addEventListener('mayi-legacy-customer-close', close);
    return () => {
      document.removeEventListener('mayi-legacy-customer-close', close);
      if (before instanceof HTMLElement && before.isConnected) before.focus();
    };
  }, []);
  useEffect(() => {
    if (!hold) {
      setMessage('');
      // A successful retry removes its focused button. Keep the modal keyboard boundary.
      if (document.activeElement === document.body) ref.current?.focus();
    }
  }, [hold]);
  return (
    <Context.Provider value={context}>
      <div
        ref={ref}
        role={presentation === 'dialog' ? 'dialog' : 'region'}
        aria-modal={presentation === 'dialog' ? true : undefined}
        aria-label={title}
        tabIndex={-1}
        className="legacy-customer-boundary"
        onKeyDown={(event) => {
          if (event.target instanceof Element && event.target.closest('dialog')) return;
          if (event.key === 'Escape' && presentation === 'dialog') {
            event.preventDefault();
            event.stopPropagation();
            guard.current(() => latestClose.current());
          }
          if (event.key === 'Tab' && presentation === 'dialog') {
            const focusable = Array.from(
              ref.current?.querySelectorAll<HTMLElement>(
                'a[href],button,input,select,textarea,[tabindex]',
              ) ?? [],
            ).filter(
              (el) =>
                el.tabIndex >= 0 &&
                !el.matches(':disabled') &&
                !el.closest('[hidden]') &&
                getComputedStyle(el).display !== 'none',
            );
            const first = focusable[0],
              last = focusable.at(-1);
            if (!first) {
              event.preventDefault();
              return;
            }
            if (
              event.shiftKey &&
              (document.activeElement === first || document.activeElement === ref.current)
            ) {
              event.preventDefault();
              last?.focus();
            } else if (
              !event.shiftKey &&
              (document.activeElement === last || document.activeElement === ref.current)
            ) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        {children}
        {message && (
          <p className="legacy-customer-close-notice" role="alert">
            {message}
          </p>
        )}
        {navigation.leave && (
          <NavigationDecision onStay={navigation.stay}>
            <h3 id="navigation-decision-title">Müşteri taslaklarını bırakmadan önce</h3>
            <p>
              Kaydedilmemiş bilgiler bu müşteriye aittir. Kaydedilmeyen taslakları bırakmak istiyor
              musunuz?
            </p>
            <Button onClick={navigation.stay}>Bu ekranda kal</Button>
            <Button
              variant="outline"
              onClick={() => {
                const go = navigation.leave;
                navigation.stay();
                if (hold) setMessage('İşlemin sonucu henüz kesinleşmedi.');
                else go?.();
              }}
            >
              Taslakları bırak ve ayrıl
            </Button>
          </NavigationDecision>
        )}
      </div>
    </Context.Provider>
  );
}
