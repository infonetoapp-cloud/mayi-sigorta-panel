type QuotePopGuard = (event: PopStateEvent) => void;
let activeGuard: QuotePopGuard | null = null;

/** AuthShell installs this before mounting BrowserRouter. On a Window popstate,
 * native Edge invokes target listeners in registration order, even with capture.
 * The selected workspace supplies only a live guard; no draft/key is persisted. */
export function installQuotePopBoundary() {
  const handle = (event: PopStateEvent) => activeGuard?.(event);
  addEventListener('popstate', handle);
  return () => {
    removeEventListener('popstate', handle);
    activeGuard = null;
  };
}

export function registerQuotePopGuard(guard: QuotePopGuard) {
  activeGuard = guard;
  return () => {
    if (activeGuard === guard) activeGuard = null;
  };
}
