import { afterEach, expect, it, vi } from 'vitest';
import {
  installQuotePopBoundary,
  registerQuotePopGuard,
} from '../src/app/pages/today-work/quote-navigation';
const cleanups: (() => void)[] = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});
it('runs a quote POP guard before the later Router listener and releases it on cleanup', () => {
  cleanups.push(installQuotePopBoundary());
  const router = vi.fn();
  addEventListener('popstate', router);
  cleanups.push(() => removeEventListener('popstate', router));
  const guard = vi.fn((event: PopStateEvent) => event.stopImmediatePropagation());
  const release = registerQuotePopGuard(guard);
  cleanups.push(release);
  dispatchEvent(new PopStateEvent('popstate'));
  expect(guard).toHaveBeenCalledOnce();
  expect(router).not.toHaveBeenCalled();
  release();
  dispatchEvent(new PopStateEvent('popstate'));
  expect(router).toHaveBeenCalledOnce();
});
it('does not let an old workspace cleanup clear the new workspace guard', () => {
  cleanups.push(installQuotePopBoundary());
  const old = vi.fn(),
    current = vi.fn();
  const releaseOld = registerQuotePopGuard(old);
  cleanups.push(registerQuotePopGuard(current));
  releaseOld();
  dispatchEvent(new PopStateEvent('popstate'));
  expect(old).not.toHaveBeenCalled();
  expect(current).toHaveBeenCalledOnce();
});
