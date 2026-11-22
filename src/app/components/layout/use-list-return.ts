import { useEffect, useRef, type MouseEvent } from 'react';
import { useLocation } from 'react-router';
import { useWorkNavigation } from '../../pages/today-work/work-navigation';

/** Restore the original list position after its current authorized page is rendered. */
export function useListReturn(ready: boolean, requestIdentity?: string) {
  const location = useLocation();
  const positions = useWorkNavigation()?.listPositions;
  const listUrl = location.pathname + location.search;
  const identity = requestIdentity ?? listUrl;
  const from: unknown = location.state?.listPositionKey;
  const position =
    positions?.get(location.key) ?? (typeof from === 'string' ? positions?.get(from) : undefined);
  const restored = useRef<string>(undefined);
  const page = useRef<HTMLDivElement>(null);
  const tableRegion = useRef<HTMLDivElement>(null);
  const advanced = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (!ready || position?.url !== identity || restored.current === location.key) return;
    const frame = requestAnimationFrame(() => {
      restored.current = location.key;
      if (advanced.current) advanced.current.open = position.advancedOpen;
      const region = tableRegion.current;
      const link = Array.from(
        region?.querySelectorAll<HTMLAnchorElement>('a[data-list-return-target]') ?? [],
      ).find((element) => element.dataset.listReturnTarget === position.target);
      if (!region || !link) {
        page.current?.querySelector<HTMLElement>('[data-page-title]')?.focus();
        return;
      }
      link.focus({ preventScroll: true });
      region.scrollLeft = position.tableScroll;
      region.scrollTop = position.tableScrollTop;
      if (scrollY !== position.pageScroll) scrollTo(0, position.pageScroll);
      const bounds = link.getBoundingClientRect();
      const viewport = region.getBoundingClientRect();
      if (
        bounds.top < Math.max(0, viewport.top) ||
        bounds.bottom > Math.min(innerHeight, viewport.bottom) ||
        bounds.left < Math.max(0, viewport.left) ||
        bounds.right > Math.min(innerWidth, viewport.right)
      )
        link.scrollIntoView({ block: 'center', inline: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [identity, location.key, position, ready]);
  function rememberPosition(event: MouseEvent<HTMLAnchorElement>) {
    const target = event.currentTarget.dataset.listReturnTarget;
    if (
      !target ||
      !positions ||
      event.defaultPrevented ||
      event.button !== 0 ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      event.shiftKey
    )
      return false;
    positions.set(location.key, {
      url: identity,
      target,
      pageScroll: scrollY,
      tableScroll: tableRegion.current?.scrollLeft ?? 0,
      tableScrollTop: tableRegion.current?.scrollTop ?? 0,
      advancedOpen: advanced.current?.open ?? false,
    });
    if (positions.size > 10) positions.delete(positions.keys().next().value!);
    return true;
  }
  return { page, tableRegion, advanced, rememberPosition, listUrl, listPositionKey: location.key };
}
