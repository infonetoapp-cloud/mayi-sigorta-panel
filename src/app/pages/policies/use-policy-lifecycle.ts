import { useEffect, useRef, useState } from 'react';
import type {
  ApiResponse,
  CustomerAssignmentOptionDto,
  PolicyDetailDto,
  PolicyDto,
} from '../../../shared/types';
import { getCsrfToken, invalidateCsrfToken } from '../../csrf';
import { parseAppError } from '../../App';
import { readCustomerResource } from '../customers/customer-resource';
interface Attempt {
  url: string;
  method: 'POST';
  body: string;
  key: string;
}
interface Snapshot {
  policy: PolicyDetailDto;
  options?: CustomerAssignmentOptionDto[];
}
/** Each caller owns its own open confirmation, CAS and immutable pending request. */
export function usePolicyLifecycle(
  kind: 'assign' | 'archive',
  policy: PolicyDetailDto,
  onUpdated: (fresh: PolicyDetailDto) => void,
) {
  const base = `/api/policies/${encodeURIComponent(policy.id)}`;
  const [opened, setOpened] = useState<PolicyDetailDto | null>(null),
    [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [comparison, setComparison] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false),
    [blocked, setBlocked] = useState(false),
    [needsRead, setNeedsRead] = useState(false),
    [needsComparison, setNeedsComparison] = useState(false),
    [dependencies, setDependencies] = useState(false);
  const [pending, setPending] = useState<Attempt | null>(null),
    [error, setError] = useState(''),
    [success, setSuccess] = useState('');
  const epoch = useRef(0),
    saving = useRef(false),
    readers = useRef(new Set<AbortController>()),
    completed = useRef<PolicyDto | null>(null);
  useEffect(
    () => () => {
      epoch.current++;
      for (const r of readers.current) r.abort();
      readers.current.clear();
    },
    [],
  );
  const current = snapshot && snapshot.policy.version > policy.version ? snapshot.policy : policy,
    archived = policy.archivedAt != null || current.archivedAt != null;
  const locked = busy || blocked || !!pending || needsRead || needsComparison || archived;
  async function scoped<T>(operation: (signal: AbortSignal) => Promise<T>) {
    const c = new AbortController();
    readers.current.add(c);
    try {
      return await operation(c.signal);
    } finally {
      readers.current.delete(c);
    }
  }
  function get<T>(url: string) {
    return scoped((signal) => readCustomerResource<T>(url, signal));
  }
  async function load() {
    const view = epoch.current;
    setBusy(true);
    try {
      const [fresh, options] = await Promise.all([
        get<PolicyDetailDto>(base),
        kind === 'assign'
          ? get<CustomerAssignmentOptionDto[]>(base + '/assignment-options')
          : Promise.resolve(undefined),
      ]);
      if (view !== epoch.current) return;
      if (
        fresh.id !== policy.id ||
        !Number.isSafeInteger(fresh.version) ||
        (completed.current && fresh.version < completed.current.version) ||
        (completed.current && kind === 'archive' && !fresh.archivedAt)
      )
        throw new Error('INVALID_READBACK');
      const next = { policy: fresh, options };
      setSnapshot(next);
      onUpdated(fresh);
      if (completed.current) {
        completed.current = null;
        setNeedsRead(false);
        setOpened(null);
        setComparison(null);
        setDependencies(false);
        setError('');
        setSuccess(kind === 'assign' ? 'Poliçe sorumlusu güncellendi.' : 'Poliçe arşivlendi.');
      } else {
        setComparison(next);
        setNeedsComparison(false);
        setError(fresh.archivedAt ? 'Arşivlenmiş poliçe salt okunurdur.' : '');
      }
    } catch (cause) {
      if (view !== epoch.current) return;
      const status =
        cause && typeof cause === 'object' && 'status' in cause ? Number(cause.status) : 0;
      if ([401, 403, 404].includes(status)) setBlocked(true);
      setError(
        completed.current
          ? 'İşlem kaydedildi; yetkili detay okunamadı. Yalnız GET yeniden denenecek.'
          : 'Güncel poliçe veya atama seçenekleri okunamadı. Yeni yazım yapılmadı; taslağınız korundu.',
      );
    } finally {
      if (view === epoch.current) setBusy(false);
    }
  }
  async function send(attempt: Attempt) {
    if (saving.current || blocked || needsRead || (archived && pending !== attempt)) return;
    saving.current = true;
    setBusy(true);
    setError('');
    setSuccess('');
    const view = epoch.current;
    try {
      const csrf = await scoped((signal) => getCsrfToken(signal));
      if (view !== epoch.current) return;
      const result = await fetch(attempt.url, {
        method: attempt.method,
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': attempt.key,
        },
        body: attempt.body,
      });
      if (view !== epoch.current) return;
      if (result.status === 401) {
        parseAppError(401);
        setBlocked(true);
        setError('Oturum sona erdi. Yeniden giriş yapın.');
        return;
      }
      const envelope = (await result.json().catch(() => null)) as ApiResponse<PolicyDto> | null;
      if (view !== epoch.current) return;
      if (!result.ok) {
        if (result.status === 403) invalidateCsrfToken();
        const apiError = envelope && !envelope.success ? envelope.error : null;
        const info = parseAppError(result.status, apiError);
        if (info.isRetryable || result.status === 429) throw new Error('UNCERTAIN');
        setPending(null);
        if (result.status === 409) {
          setNeedsComparison(true);
          setComparison(null);
          setDependencies(apiError?.code === 'OPEN_DEPENDENCIES');
          setError(
            apiError?.code === 'OPEN_DEPENDENCIES'
              ? 'Açık yenileme veya takip görevi bulundu. Poliçe arşivlenmedi. İlgili işleri yetkili iş akışından inceleyin; bu ekran görevleri kapatmaz.'
              : 'Poliçe sürümü veya seçim değişti. Güncel kayıtları karşılaştırıp açıkça yeniden onaylayın.',
          );
        } else {
          setError(info.message);
          if ([403, 404].includes(result.status)) setBlocked(true);
        }
        return;
      }
      if (
        !envelope?.success ||
        envelope.data?.id !== policy.id ||
        !Number.isSafeInteger(envelope.data.version)
      )
        throw new Error('UNCERTAIN');
      completed.current = envelope.data;
      setPending(null);
      setNeedsRead(true);
      await load();
    } catch {
      if (view === epoch.current) {
        setPending(attempt);
        setError(
          'Sonuç belirsiz. Form kilitlendi; yalnız aynı isteği aynı anahtarla yeniden deneyin. Sayfayı yenilemeyin.',
        );
      }
    } finally {
      saving.current = false;
      if (view === epoch.current) setBusy(false);
    }
  }
  return {
    current,
    opened,
    comparison,
    snapshot,
    busy,
    blocked,
    locked,
    archived,
    pending,
    needsRead,
    needsComparison,
    dependencies,
    error,
    success,
    open() {
      if (locked) return false;
      setOpened(current);
      setComparison(null);
      setError('');
      setSuccess('');
      setDependencies(false);
      return true;
    },
    cancel() {
      if (busy || pending || needsRead) return;
      setOpened(null);
      setComparison(null);
      setNeedsComparison(false);
      setError('');
      setDependencies(false);
    },
    refresh() {
      if (!busy) void load();
    },
    retry() {
      if (pending) void send(pending);
    },
    submit(fields: Record<string, unknown>) {
      if (locked || !opened || saving.current) return;
      void send({
        url: base + '/' + kind,
        method: 'POST',
        body: JSON.stringify({
          ...fields,
          expectedVersion: (comparison?.policy ?? opened).version,
        }),
        key: crypto.randomUUID(),
      });
    },
  };
}
