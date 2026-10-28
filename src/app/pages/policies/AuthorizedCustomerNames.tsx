import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { Link } from 'react-router';
import { readCustomerResource, useCustomerResource } from '../customers/customer-resource';
interface CustomerName {
  id: string;
  displayName: string;
}
interface NameState {
  name?: string;
  error?: boolean;
}
const Context = createContext<Record<string, NameState> | null>(null);
/** One authorized GET per distinct customer on the current bounded policy page.
 * URL-tagged memory is discarded with the authenticated route; no agency download/cache. */
export function AuthorizedCustomerNames({
  ids,
  children,
}: {
  ids: readonly string[];
  children: ReactNode;
}) {
  const signature = JSON.stringify([...new Set(ids)].sort());
  const [snapshot, setSnapshot] = useState<{
    signature: string;
    values: Record<string, NameState>;
  }>();
  useEffect(() => {
    let live = true;
    const controller = new AbortController();
    const targets = JSON.parse(signature) as string[];
    setSnapshot({ signature, values: {} });
    for (const id of targets)
      void readCustomerResource<CustomerName>(
        '/api/customers/' + encodeURIComponent(id),
        controller.signal,
      )
        .then((c) => {
          if (!live) return;
          const value: NameState =
            c.id === id && typeof c.displayName === 'string'
              ? { name: c.displayName }
              : { error: true };
          setSnapshot((previous) => ({
            signature,
            values: { ...(previous?.signature === signature ? previous.values : {}), [id]: value },
          }));
        })
        .catch(() => {
          if (live)
            setSnapshot((previous) => ({
              signature,
              values: {
                ...(previous?.signature === signature ? previous.values : {}),
                [id]: { error: true },
              },
            }));
        });
    return () => {
      live = false;
      controller.abort();
    };
  }, [signature]);
  return (
    <Context.Provider value={snapshot?.signature === signature ? snapshot.values : {}}>
      {children}
    </Context.Provider>
  );
}
function Name({ id, state, value }: { id: string; state: unknown; value: NameState | undefined }) {
  if (!value) return <span className="pv4-muted">Müşteri yükleniyor…</span>;
  if (!value.name || value.error)
    return <span className="pv4-muted">Müşteri bilgisine erişilemiyor</span>;
  return (
    <Link className="pv4-customer" to={'/customers/' + encodeURIComponent(id)} state={state}>
      {value.name}
    </Link>
  );
}
function Lookup({ id, state }: { id: string; state: unknown }) {
  const r = useCustomerResource<CustomerName>('/api/customers/' + encodeURIComponent(id));
  return (
    <Name
      id={id}
      state={state}
      value={
        r.loading
          ? undefined
          : r.data?.id === id && typeof r.data.displayName === 'string'
            ? { name: r.data.displayName }
            : { error: true }
      }
    />
  );
}
export function AuthorizedCustomerName({ id, state }: { id: string; state: unknown }) {
  const names = useContext(Context);
  return names === null ? (
    <Lookup key={id} id={id} state={state} />
  ) : (
    <Name id={id} state={state} value={names[id]} />
  );
}
