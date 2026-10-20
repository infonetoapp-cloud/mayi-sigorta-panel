import { useCallback, useEffect, useRef, useState } from 'react';
import type { TodayTasksResponseData } from '../../../shared/types';
import type { TaskReadback } from './TaskOperationsSection';
import { CustomerReadError, readCustomerResource } from '../customers/customer-resource';
import type { WorkBookmark } from './work-navigation';
export type WorkQueue = 'WORK' | 'UNASSIGNED' | 'REASSIGNMENT';
interface Failure {
  restoreId?: string;
  url: string;
  queue: WorkQueue;
  append: boolean;
  message: string;
}
interface State {
  restoredSelection?: { id: string; authority: number };
  unavailable?: string;
  data: TodayTasksResponseData | null;
  failures: Partial<Record<WorkQueue, Failure>>;
  loading: WorkQueue | null;
  authority: number;
}
const initial: State = { data: null, failures: {}, loading: null, authority: 0 };
export function useTaskQueue(owner: boolean, bookmark?: WorkBookmark) {
  const boot = useRef(bookmark);
  const [view, setView] = useState<WorkQueue>(bookmark?.queue ?? 'WORK'),
    [state, setState] = useState(initial),
    [capabilities, setCapabilities] = useState({ unassigned: false, reassignment: false });
  const generation = useRef(0),
    pages = useRef(new Map<string, string>()),
    controller = useRef<AbortController | null>(null),
    busy = useRef(false);
  const reassignment = view === 'REASSIGNMENT';
  const cancel = useCallback(() => {
    generation.current++;
    controller.current?.abort();
    busy.current = false;
  }, []);
  const load = useCallback(
    async (url: string, queue: WorkQueue, append: boolean, restoreId?: string) => {
      if (busy.current) return;
      busy.current = true;
      const request = ++generation.current,
        c = new AbortController();
      controller.current = c;
      setState((old) => ({
        ...old,
        loading: queue,
        failures: { ...old.failures, [queue]: undefined },
        ...(!append ? { data: null, authority: old.authority + 1 } : {}),
      }));
      if (!append) pages.current.clear();
      try {
        const raw = await readCustomerResource<TodayTasksResponseData>(url, c.signal);
        if (c.signal.aborted || request !== generation.current) return;
        if (
          (queue === 'UNASSIGNED' && (!owner || !raw.canSeeUnassigned)) ||
          (queue === 'REASSIGNMENT' && (!owner || !raw.canSeeReassignment))
        )
          throw new CustomerReadError(403);
        let restoreTask: string | undefined;
        let unavailable: string | undefined;
        let contextUrl: string | undefined;
        let restored = raw;
        if (restoreId) {
          contextUrl = `/api/tasks/${encodeURIComponent(restoreId)}/context?queue=${queue}`;
          try {
            const context = await readCustomerResource<TodayTasksResponseData>(
              contextUrl,
              c.signal,
            );
            if (c.signal.aborted || request !== generation.current) return;
            const rows = queue === 'UNASSIGNED' ? context.unassignedItems : context.items;
            const exact = rows.find((item) => item.taskId === restoreId);
            if (!exact) throw new CustomerReadError(404);
            restoreTask = exact.taskId;
            restored = {
              ...raw,
              ...(queue === 'UNASSIGNED'
                ? {
                    unassignedItems: [
                      ...raw.unassignedItems.filter((item) => item.taskId !== restoreId),
                      exact,
                    ],
                  }
                : { items: [...raw.items.filter((item) => item.taskId !== restoreId), exact] }),
            };
          } catch (error) {
            if (c.signal.aborted || request !== generation.current) return;
            if (!(error instanceof CustomerReadError) || error.status !== 404) throw error;
            unavailable =
              'Önceki takip kullanılamıyor veya bu takibe erişiminiz yok. Başka bir takip otomatik seçilmedi.';
            restored = {
              ...raw,
              items: raw.items.filter((item) => item.taskId !== restoreId),
              unassignedItems: raw.unassignedItems.filter((item) => item.taskId !== restoreId),
            };
          }
        }
        const fresh = {
          ...restored,
          canSeeUnassigned: owner && raw.canSeeUnassigned,
          canSeeReassignment: owner && !!raw.canSeeReassignment,
          unassignedItems: owner && raw.canSeeUnassigned ? restored.unassignedItems : [],
        };
        for (const item of [...fresh.items, ...fresh.unassignedItems])
          if (!pages.current.has(item.taskId)) pages.current.set(item.taskId, url);
        if (restoreTask && contextUrl) pages.current.set(restoreTask, contextUrl);
        setCapabilities({
          unassigned: fresh.canSeeUnassigned,
          reassignment: fresh.canSeeReassignment,
        });
        setState((old) => {
          const revoked =
            !!old.data &&
            (old.data.canSeeUnassigned !== fresh.canSeeUnassigned ||
              !!old.data.canSeeReassignment !== fresh.canSeeReassignment ||
              old.data.canAssign !== fresh.canAssign);
          let data = fresh;
          if (append && old.data && !revoked) {
            const prior = old.data;
            if (queue === 'UNASSIGNED')
              data = {
                ...fresh,
                items: prior.items,
                hasMore: prior.hasMore,
                nextCursor: prior.nextCursor,
                unassignedItems: [
                  ...prior.unassignedItems,
                  ...fresh.unassignedItems.filter(
                    (item) =>
                      !prior.unassignedItems.some((previous) => previous.taskId === item.taskId),
                  ),
                ],
              };
            else
              data = {
                ...fresh,
                items: [
                  ...prior.items,
                  ...fresh.items.filter(
                    (item) => !prior.items.some((previous) => previous.taskId === item.taskId),
                  ),
                ],
                unassignedItems: prior.unassignedItems,
                unassignedHasMore: prior.unassignedHasMore,
                unassignedNextCursor: prior.unassignedNextCursor,
              };
          }
          if (restoreId)
            data = {
              ...data,
              items: data.items.filter((item) => item.taskId !== restoreId || !!restoreTask),
              unassignedItems: data.unassignedItems.filter(
                (item) => item.taskId !== restoreId || !!restoreTask,
              ),
            };
          const authority = old.authority + (revoked ? 1 : 0);
          return {
            ...old,
            data,
            authority,
            unavailable,
            ...(restoreTask ? { restoredSelection: { id: restoreTask, authority } } : {}),
          };
        });
        return true;
      } catch (error) {
        if (c.signal.aborted || request !== generation.current) return;
        const denied =
          error instanceof CustomerReadError && [400, 401, 403, 404, 409].includes(error.status);
        if (denied) setCapabilities({ unassigned: false, reassignment: false });
        setState((old) => ({
          ...old,
          ...(denied ? { data: null, authority: old.authority + 1, failures: {} } : {}),
          failures: {
            ...(denied ? {} : old.failures),
            [queue]: {
              restoreId,
              url,
              queue,
              append: append && !denied,
              message:
                error instanceof CustomerReadError && [400, 409].includes(error.status)
                  ? 'Liste bağlamı değişti. Listeyi yenile ile baştan yetkili yükleme yapın.'
                  : error instanceof CustomerReadError
                    ? error.message
                    : 'Görevler yüklenemedi. Bağlantınızı kontrol edip yeniden deneyin.',
            },
          },
        }));
        return false;
      } finally {
        if (request === generation.current) {
          busy.current = false;
          setState((old) => ({ ...old, loading: null }));
        }
      }
    },
    [owner],
  );
  const base = '/api/tasks/today?limit=20' + (reassignment ? '&needsReassignment=true' : '');
  useEffect(() => {
    let active = true;
    const saved = boot.current;
    boot.current = undefined;
    const urls = saved?.pageUrls.length ? saved.pageUrls.slice(0, 10) : [base];
    void (async () => {
      for (let index = 0; index < urls.length && active; index++) {
        const loaded = await load(
          urls[index]!,
          saved?.queue ?? (reassignment ? 'REASSIGNMENT' : 'WORK'),
          index > 0,
          index === urls.length - 1 ? saved?.taskId : undefined,
        );
        if (loaded === false) break;
      }
    })();
    return () => {
      active = false;
      cancel();
    };
  }, [base, reassignment, load, cancel]);
  const failure =
    state.failures[view] ?? (!state.data ? Object.values(state.failures).find(Boolean) : undefined);
  return {
    ...state,
    view,
    failure,
    canSeeUnassigned: owner && capabilities.unassigned,
    canSeeReassignment: owner && capabilities.reassignment,
    pageUrls: () =>
      [...new Set(pages.current.values())]
        .filter((url) => url.startsWith('/api/tasks/today?'))
        .slice(0, 10),
    async readOperation(taskId: string, signal: AbortSignal): Promise<TaskReadback> {
      const original = pages.current.get(taskId),
        request = generation.current,
        authority = state.authority,
        mode = view;
      if (!original) throw new Error('PROVENANCE_MISSING');
      let readUrl = original;
      const currentPage = await readCustomerResource<TodayTasksResponseData>(original, signal)
        .catch(async (error) => {
          if (
            !signal.aborted &&
            request === generation.current &&
            original.startsWith('/api/tasks/') &&
            original.includes('/context?') &&
            error instanceof CustomerReadError &&
            error.status === 404
          ) {
            // An open-only exact context can disappear after an accepted completion.
            // A fresh authorized queue read is only display/readback; controllers still
            // require their original validated receipt and never infer write success here.
            readUrl = base;
            return readCustomerResource<TodayTasksResponseData>(readUrl, signal);
          }
          throw error;
        })
        .catch((error) => {
          if (
            !signal.aborted &&
            request === generation.current &&
            error instanceof CustomerReadError &&
            [400, 401, 403, 404, 409].includes(error.status)
          ) {
            cancel();
            pages.current.clear();
            setState((old) => ({
              ...old,
              data: null,
              authority: old.authority + 1,
              failures: {},
              loading: null,
            }));
            setCapabilities({ unassigned: false, reassignment: false });
          }
          throw error;
        });
      if (signal.aborted || request !== generation.current) throw new Error('STALE_CONTEXT');
      if (
        (mode === 'UNASSIGNED' && (!owner || !currentPage.canSeeUnassigned)) ||
        (mode === 'REASSIGNMENT' && (!owner || !currentPage.canSeeReassignment))
      ) {
        cancel();
        pages.current.clear();
        setState((old) => ({
          ...old,
          data: null,
          authority: old.authority + 1,
          failures: {},
          loading: null,
        }));
        setCapabilities({ unassigned: false, reassignment: false });
        throw new CustomerReadError(403);
      }
      const list = mode === 'UNASSIGNED' ? currentPage.unassignedItems : currentPage.items;
      return {
        current: list.find((item) => item.taskId === taskId),
        apply() {
          if (signal.aborted || request !== generation.current) return;
          cancel();
          pages.current.clear();
          for (const item of [...currentPage.items, ...currentPage.unassignedItems])
            pages.current.set(item.taskId, readUrl);
          setState({
            data: {
              ...currentPage,
              canSeeUnassigned: owner && currentPage.canSeeUnassigned,
              canSeeReassignment: owner && !!currentPage.canSeeReassignment,
              unassignedItems:
                owner && currentPage.canSeeUnassigned ? currentPage.unassignedItems : [],
            },
            authority: authority + 1,
            failures: {},
            loading: null,
          });
          setCapabilities({
            unassigned: owner && currentPage.canSeeUnassigned,
            reassignment: owner && !!currentPage.canSeeReassignment,
          });
        },
      };
    },
    change(next: WorkQueue) {
      if (next === view) return;
      if (
        (next === 'UNASSIGNED' && !capabilities.unassigned) ||
        (next === 'REASSIGNMENT' && !capabilities.reassignment)
      )
        return;
      cancel();
      setState((old) => ({
        ...old,
        loading: null,
        ...((next === 'REASSIGNMENT') !== reassignment
          ? { data: null, failures: {}, authority: old.authority + 1 }
          : {}),
      }));
      setView(next);
    },
    refresh() {
      cancel();
      void load(base, view, false);
    },
    retry() {
      if (failure) void load(failure.url, failure.queue, failure.append, failure.restoreId);
    },
    more() {
      if (!state.data) return;
      const cursor =
        view === 'UNASSIGNED' ? state.data.unassignedNextCursor : state.data.nextCursor;
      if (!cursor) return;
      const parameter = view === 'UNASSIGNED' ? 'unassignedCursor' : 'cursor';
      void load(base + '&' + parameter + '=' + encodeURIComponent(cursor), view, true);
    },
  };
}
