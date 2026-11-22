import { useEffect, useRef, type MouseEvent } from 'react';

/** An inline detail moves focus away from its row without navigating to a new page. */
export function usePanelReturn(selected: string | null, listUrl: string, ready: boolean) {
  const page = useRef<HTMLDivElement>(null);
  const table = useRef<HTMLDivElement>(null);
  const origin = useRef<{
    target: string;
    listUrl: string;
    scroll: number;
    left: number;
    top: number;
  }>(null);
  function remember(event: MouseEvent<HTMLButtonElement>) {
    const target = event.currentTarget.dataset.panelTrigger;
    if (!target) return;
    origin.current = {
      target,
      listUrl,
      scroll: scrollY,
      left: table.current?.scrollLeft ?? 0,
      top: table.current?.scrollTop ?? 0,
    };
  }
  useEffect(() => {
    const saved = origin.current;
    if (!saved) return;
    if (saved.listUrl !== listUrl) {
      origin.current = null;
      return;
    }
    if (selected || !ready) return;
    const frame = requestAnimationFrame(() => {
      origin.current = null;
      const region = table.current;
      const target = Array.from(
        region?.querySelectorAll<HTMLButtonElement>('button[data-panel-trigger]') ?? [],
      ).find((button) => button.dataset.panelTrigger === saved.target && !button.disabled);
      if (!target || !region) {
        page.current?.querySelector<HTMLElement>('[data-page-title]')?.focus();
        return;
      }
      target.focus({ preventScroll: true });
      region.scrollLeft = saved.left;
      region.scrollTop = saved.top;
      if (scrollY !== saved.scroll) scrollTo(0, saved.scroll);
      const bounds = target.getBoundingClientRect();
      const container = region.getBoundingClientRect();
      if (
        bounds.top < Math.max(0, container.top) ||
        bounds.bottom > Math.min(innerHeight, container.bottom) ||
        bounds.left < Math.max(0, container.left) ||
        bounds.right > Math.min(innerWidth, container.right)
      )
        target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    });
    return () => cancelAnimationFrame(frame);
  }, [selected, listUrl, ready]);
  return { page, table, remember };
}
