import { createContext, useContext, useRef, type ReactNode } from 'react';
interface CustomerListContext {
  search: string;
  type: string;
  filter: { search: string; type: string };
  cursors: Array<string | null>;
  scroll: number;
  restoreScroll: boolean;
}
const Context = createContext<{ current: CustomerListContext | null } | null>(null);
/** Lives under the authenticated provider; no DTO cache, URL or browser storage. */
export function CustomerListContextProvider({ children }: { children: ReactNode }) {
  const memory = useRef<CustomerListContext | null>(null);
  return <Context.Provider value={memory}>{children}</Context.Provider>;
}
export function useCustomerListContext() {
  return useContext(Context);
}
