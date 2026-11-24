import { createContext, useContext, useRef, type ReactNode } from 'react';
import { Link, useLocation } from 'react-router';
import type { WorkQueue } from './use-task-queue';
export interface WorkBookmark {
  taskId: string;
  queue: WorkQueue;
  pageUrls: string[];
  pageScroll: number;
  queueScroll: number;
  returnFocus?: 'customer' | 'policy';
  operationScroll?: number;
  queueSearch?: string;
  appliedSearch?: string;
  queueBucket?: string;
  sections: Record<string, boolean>;
}
interface Store {
  entries: Map<string, WorkBookmark>;
  listPositions: Map<
    string,
    {
      url: string;
      target: string;
      pageScroll: number;
      tableScroll: number;
      tableScrollTop: number;
      advancedOpen: boolean;
    }
  >;
}
const Context = createContext<Store | null>(null);
export const workSectionLabels = {
  communication: 'İletişim',
  task: 'Görev işlemleri',
  quotes: 'Teklifler',
  outcomes: 'Yenileme sonucu',
} as const;
/** Authenticated lifetime only. No DTOs, drafts, bodies, keys or browser storage. */
export function WorkNavigationProvider({ children }: { children: ReactNode }) {
  const store = useRef<Store>({ entries: new Map(), listPositions: new Map() });
  return <Context.Provider value={store.current}>{children}</Context.Provider>;
}
export function useWorkNavigation() {
  return useContext(Context);
}
export function workUrl(taskId: string, queue: WorkQueue) {
  return '/today-work?' + new URLSearchParams({ task: taskId, queue });
}
export function ReturnToWork({ fallback = false }: { fallback?: boolean } = {}) {
  const route = useLocation();
  const store = useWorkNavigation();
  const key: unknown = route.state?.workReturn;
  const bookmark = typeof key === 'string' ? store?.entries.get(key) : undefined;
  if (!bookmark)
    return fallback ? (
      <Link className="customer-back-link" to="/today-work">
        ← Bugünkü İşler
      </Link>
    ) : null;
  const section = (Object.keys(workSectionLabels) as Array<keyof typeof workSectionLabels>)
    .reverse()
    .find((id) => bookmark.sections[workSectionLabels[id]]);
  return (
    <Link
      className="customer-back"
      to={workUrl(bookmark.taskId, bookmark.queue) + (section ? `&work=${section}` : '')}
      state={{ workContext: key }}
    >
      Seçili takibe dön
    </Link>
  );
}
