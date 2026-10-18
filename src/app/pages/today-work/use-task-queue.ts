import { useCallback, useEffect, useRef, useState } from 'react';
import type { TodayTasksResponseData } from '../../../shared/types';
import { CustomerReadError, readCustomerResource } from '../customers/customer-resource';
export type WorkQueue = 'WORK' | 'UNASSIGNED' | 'REASSIGNMENT';
interface Failure {
  url: string;
  queue: WorkQueue;
  append: boolean;
  message: string;
}
interface State {
  data: TodayTasksResponseData | null;
  failures: Partial<Record<WorkQueue, Failure>>;
  loading: WorkQueue | null;
  authority: number;
}
const initial: State = { data: null, failures: {}, loading: null, authority: 0 };
export function useTaskQueue(owner: boolean) {
  const [view, setView] = useState<WorkQueue>('WORK'),
    [state, setState] = useState(initial),
    [capabilities, setCapabilities] = useState({ unassigned: false, reassignment: false });
  const generation = useRef(0),
    controller = useRef<AbortController | null>(null),
    busy = useRef(false);
  const reassignment = view === 'REASSIGNMENT';
  const cancel = useCallback(() => {
    generation.current++;
    controller.current?.abort();
    busy.current = false;
  }, []);
  const load = useCallback(
    async (url: string, queue: WorkQueue, append: boolean) => {
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
      try {
        const raw = await readCustomerResource<TodayTasksResponseData>(url, c.signal);
        if (c.signal.aborted || request !== generation.current) return;
        if (
          (queue === 'UNASSIGNED' && (!owner || !raw.canSeeUnassigned)) ||
          (queue === 'REASSIGNMENT' && (!owner || !raw.canSeeReassignment))
        )
          throw new CustomerReadError(403);
        const fresh = {
          ...raw,
          canSeeUnassigned: owner && raw.canSeeUnassigned,
          canSeeReassignment: owner && !!raw.canSeeReassignment,
          unassignedItems: owner && raw.canSeeUnassigned ? raw.unassignedItems : [],
        };
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
          return { ...old, data, authority: old.authority + (revoked ? 1 : 0) };
        });
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
    void load(base, reassignment ? 'REASSIGNMENT' : 'WORK', false);
    return cancel;
  }, [base, reassignment, load, cancel]);
  const failure =
    state.failures[view] ?? (!state.data ? Object.values(state.failures).find(Boolean) : undefined);
  return {
    ...state,
    view,
    failure,
    canSeeUnassigned: owner && capabilities.unassigned,
    canSeeReassignment: owner && capabilities.reassignment,
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
      if (failure) void load(failure.url, failure.queue, failure.append);
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
