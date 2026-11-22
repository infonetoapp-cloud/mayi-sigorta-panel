import { createContext, useContext, useRef, type ReactNode } from 'react';
interface CustomerListContext {
  search: string;
  type: string;
  reference: string;
  referenceMembershipId: string;
  filter: { search: string; type: string; reference: string; referenceMembershipId: string };
  cursors: Array<string | null>;
}
type Memory = { current: CustomerListContext | null; entries: Map<string, CustomerListContext> };
const Context = createContext<Memory | null>(null);
/** Lives under the authenticated provider; no DTO cache, URL or browser storage. */
export function CustomerListContextProvider({ children }: { children: ReactNode }) {
  const memory = useRef<Memory>({ current: null, entries: new Map() });
  return <Context.Provider value={memory.current}>{children}</Context.Provider>;
}
export function useCustomerListContext() {
  return useContext(Context);
}

export function customerListReturnState(key: unknown) {
  return typeof key === 'string' ? { listPositionKey: key } : undefined;
}
