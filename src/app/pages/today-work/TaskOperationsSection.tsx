import { useEffect, useRef, useState } from 'react';
import type {
  TodayTaskDto,
  CustomerAssignmentOptionDto,
  RenewalTaskAssignmentDto,
  RenewalTaskReplacementCompletionDto,
  ApiResponse,
} from '../../../shared/types';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { getCsrfToken, invalidateCsrfToken } from '../../csrf';
import { parseAppError } from '../../App';
import { readCustomerResource, CustomerReadError } from '../customers/customer-resource';
import { canonicalOccurrence, interactionTime } from './interaction-model';
import { followupReasons, type FollowupReason } from '../../../shared/followup-reasons';
export interface TaskReadback {
  current: TodayTaskDto | undefined;
  apply: () => void;
}
export interface TaskOperationRisk {
  dirty: boolean;
  unresolved: boolean;
}
interface Props {
  followupOnly?: boolean;
  task: TodayTaskDto;
  read: (signal: AbortSignal) => Promise<TaskReadback>;
  canOperate: () => boolean;
  onRisk: (risk: TaskOperationRisk) => void;
  onApplied: (message: string) => void;
}
type Kind = 'complete' | 'assign';
interface Attempt {
  url: string;
  method: 'POST';
  body: string;
  key: string;
  snapshot: TodayTaskDto;
}
function version(n: unknown): n is number {
  return Number.isSafeInteger(n) && Number(n) > 0;
}
function validResult(kind: Kind, value: unknown, a: Attempt) {
  if (!value || typeof value !== 'object') return false;
  const b = JSON.parse(a.body),
    r = value as RenewalTaskAssignmentDto & RenewalTaskReplacementCompletionDto;
  if (
    r.renewalId !== a.snapshot.renewalId ||
    r.renewalVersion !== a.snapshot.renewalVersion + (kind === 'assign' ? 1 : 0)
  )
    return false;
  if (kind === 'assign')
    return (
      r.taskId === a.snapshot.taskId &&
      r.taskVersion === a.snapshot.taskVersion + 1 &&
      r.assigneeMembershipId === b.assigneeMembershipId &&
      !!canonicalDate(r.updatedAt)
    );
  return (
    r.completedTaskId === a.snapshot.taskId &&
    typeof r.replacementTaskId === 'string' &&
    r.replacementTaskId.length > 0 &&
    r.replacementTaskId !== r.completedTaskId &&
    r.completedTaskVersion === a.snapshot.taskVersion + 1 &&
    r.replacementTaskVersion === 1 &&
    r.replacementDueAt === b.replacementDueAt &&
    !!canonicalDate(r.completedAt)
  );
}
function canonicalDate(s: unknown) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(s))
    return false;
  const d = new Date(s);
  return Number.isFinite(d.getTime()) && d.toISOString() === s;
}
function useOperation(kind: Kind, props: Props, blocked: () => boolean) {
  const [opened, setOpened] = useState(false),
    [snapshot, setSnapshot] = useState<TodayTaskDto | null>(null),
    [due, setDue] = useState(''),
    [followupReason, setFollowupReason] = useState<FollowupReason | ''>(''),
    [assignee, setAssignee] = useState(''),
    [confirm, setConfirm] = useState(false),
    [compared, setCompared] = useState(false),
    [comparison, setComparison] = useState<TodayTaskDto | null>(null),
    [mustCompare, setMustCompare] = useState(false),
    [busy, setBusy] = useState(false),
    [pending, setPending] = useState<Attempt | null>(null),
    [saved, setSaved] = useState<Attempt | null>(null),
    [error, setError] = useState(''),
    [options, setOptions] = useState<readonly CustomerAssignmentOptionDto[] | null>(null),
    [denied, setDenied] = useState(false);
  const lock = useRef(false),
    epoch = useRef(0),
    controllers = useRef(new Set<AbortController>()),
    heading = useRef<HTMLHeadingElement>(null);
  useEffect(
    () => () => {
      epoch.current++;
      for (const c of controllers.current) c.abort();
    },
    [],
  );
  useEffect(() => {
    if (opened) heading.current?.focus();
  }, [opened]);
  const root = `/api/renewals/${encodeURIComponent(props.task.renewalId)}/tasks/${encodeURIComponent(props.task.taskId)}`;
  async function directory(signal: AbortSignal) {
    const rows = await readCustomerResource<readonly CustomerAssignmentOptionDto[]>(
      root + '/assignment-options',
      signal,
    );
    if (
      !Array.isArray(rows) ||
      rows.some(
        (r) => typeof r.membershipId !== 'string' || !r.membershipId || typeof r.label !== 'string',
      )
    )
      throw new Error('INVALID_DIRECTORY');
    return rows;
  }
  async function open() {
    if (lock.current || pending || saved || blocked()) return;
    setSnapshot({ ...props.task });
    setComparison(null);
    setCompared(false);
    setMustCompare(false);
    setConfirm(false);
    setError('');
    setDue('');
    setAssignee('');
    setOpened(true);
    if (kind === 'assign') {
      const e = epoch.current,
        c = new AbortController();
      controllers.current.add(c);
      lock.current = true;
      setBusy(true);
      try {
        const rows = await directory(c.signal);
        if (e === epoch.current && !c.signal.aborted) {
          setOptions(rows);
          setDenied(false);
        }
      } catch (cause) {
        if (e === epoch.current && !c.signal.aborted) {
          setOptions(null);
          setDenied(true);
          setError(
            cause instanceof CustomerReadError && [401, 403, 404].includes(cause.status)
              ? 'Bu görev için atama dizini yetkili olarak açılamadı.'
              : 'Atama seçenekleri yüklenemedi. Yeniden açmayı deneyin.',
          );
        }
      } finally {
        controllers.current.delete(c);
        lock.current = false;
        if (e === epoch.current) setBusy(false);
      }
    }
  }
  async function compare() {
    if (lock.current || pending || saved || !props.canOperate() || blocked()) return;
    const e = epoch.current,
      c = new AbortController();
    controllers.current.add(c);
    lock.current = true;
    setBusy(true);
    setError('');
    setConfirm(false);
    try {
      const current = await props.read(c.signal);
      const rows = kind === 'assign' ? await directory(c.signal) : null;
      if (e !== epoch.current || c.signal.aborted) return;
      setComparison(current.current ?? null);
      setOptions(rows ?? options);
      setDenied(false);
      setCompared(true);
      setMustCompare(!current.current);
      if (!current.current)
        setError(
          'Seçtiğiniz takip güncel iş listenizde bulunamadı. Başka bir takip otomatik seçilmez. Yeni kayıt gönderilmez; listeyi yenileyin.',
        );
    } catch {
      if (e === epoch.current && !c.signal.aborted) {
        setOptions(null);
        setDenied(true);
        setError('Güncel yetkili durum okunamadı. Taslağınız korundu; yeniden karşılaştırın.');
      }
    } finally {
      controllers.current.delete(c);
      lock.current = false;
      if (e === epoch.current) setBusy(false);
    }
  }
  async function readback(attempt: Attempt) {
    const e = epoch.current,
      c = new AbortController();
    controllers.current.add(c);
    setBusy(true);
    setError('');
    try {
      const fresh = await props.read(c.signal);
      if (e !== epoch.current || c.signal.aborted) return;
      // A validated successful server receipt proves the write. Queue absence alone never does.
      if (
        fresh.current &&
        (!version(fresh.current.taskVersion) ||
          !version(fresh.current.renewalVersion) ||
          fresh.current.renewalId !== attempt.snapshot.renewalId ||
          fresh.current.taskVersion < attempt.snapshot.taskVersion + 1 ||
          fresh.current.renewalVersion < attempt.snapshot.renewalVersion + 1 ||
          kind === 'complete')
      )
        throw new Error('INCONSISTENT_READBACK');
      props.onApplied(
        kind === 'complete'
          ? 'Takip tamamlandı ve yeni takip oluşturuldu. İş listeniz güncellendi. Yenileme henüz sonuçlandırılmadı.'
          : 'Görev ve yenileme sorumlusu değiştirildi. İş listeniz güncellendi.',
      );
      fresh.apply();
    } catch {
      if (e === epoch.current && !c.signal.aborted)
        setError(
          'Kayıt kabul edildi; iş listeniz henüz güncellenemedi. Yalnız listeyi yeniden kontrol edin; kayıt tekrar gönderilmeyecek.',
        );
    } finally {
      controllers.current.delete(c);
      if (e === epoch.current) setBusy(false);
    }
  }
  async function send(attempt: Attempt) {
    if (lock.current || saved || !props.canOperate() || blocked()) return;
    lock.current = true;
    setBusy(true);
    setError('');
    setPending(attempt);
    const e = epoch.current,
      c = new AbortController();
    controllers.current.add(c);
    try {
      const csrf = await getCsrfToken(c.signal);
      if (e !== epoch.current || c.signal.aborted) return;
      const r = await fetch(attempt.url, {
        method: attempt.method,
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': attempt.key,
        },
        body: attempt.body,
      });
      if (e !== epoch.current) return;
      if (r.status === 401) {
        parseAppError(401);
        return;
      }
      const result = (await r.json().catch(() => null)) as ApiResponse<unknown> | null;
      if (e !== epoch.current) return;
      if (!r.ok) {
        if (r.status >= 500 || [408, 429].includes(r.status)) throw new Error('UNCERTAIN');
        setPending(null);
        setConfirm(false);
        if (r.status === 403) invalidateCsrfToken();
        if ([403, 404, 409].includes(r.status)) {
          setMustCompare(true);
          setCompared(false);
          if (kind === 'assign') setOptions(null);
        }
        setError(
          r.status === 409
            ? 'Takip bilgileri değişti. Taslağınız korundu. Güncel takibi karşılaştırıp yeniden onaylayın.'
            : parseAppError(r.status, result && !result.success ? result.error : undefined).message,
        );
        return;
      }
      if (!result?.success || !validResult(kind, result.data, attempt))
        throw new Error('UNCERTAIN');
      setPending(null);
      setSaved(attempt);
      await readback(attempt);
    } catch {
      if (e === epoch.current && !c.signal.aborted)
        setError(
          'Yazım sonucu belirsiz. Özgün URL/body/tarih/anahtar donduruldu; yalnız aynı isteği yeniden deneyin. Listeyi yenilemek veya ayrılmak işlemi iptal etmez.',
        );
    } finally {
      controllers.current.delete(c);
      lock.current = false;
      if (e === epoch.current) setBusy(false);
    }
  }
  function submit() {
    if (
      !snapshot ||
      busy ||
      lock.current ||
      pending ||
      saved ||
      mustCompare ||
      denied ||
      !props.canOperate() ||
      blocked()
    )
      return;
    if (!confirm) {
      setError('İşlemi açıkça onaylayın.');
      return;
    }
    const chosen = compared ? comparison : snapshot;
    if (!chosen) {
      setError('Güncel takip bilgileri bulunamadı.');
      return;
    }
    const base = {
      expectedRenewalVersion: chosen.renewalVersion,
      expectedTaskVersion: chosen.taskVersion,
    };
    let payload: object;
    if (kind === 'complete') {
      const timestamp = canonicalOccurrence(due);
      if (!timestamp) {
        setError('Yeni takip için geçerli ve tek anlamlı İstanbul tarih/saatini açıkça seçin.');
        return;
      }
      payload = {
        ...base,
        replacementDueAt: timestamp,
        ...(followupReason ? { followupReason } : {}),
      };
    } else {
      const target = assignee === '__unassigned__' ? null : assignee;
      if (
        !options ||
        (!target && (chosen.needsReassignment || assignee !== '__unassigned__')) ||
        (target && !options.some((r) => r.membershipId === target))
      ) {
        setError(
          'Yetkili seçeneklerden uygun aktif sorumluyu açıkça seçin. Pasif sorumlu otomatik değiştirilemez.',
        );
        return;
      }
      payload = { ...base, assigneeMembershipId: target };
    }
    void send({
      url: root + '/' + kind,
      method: 'POST',
      body: JSON.stringify(payload),
      key: crypto.randomUUID(),
      snapshot: { ...chosen },
    });
  }
  return {
    opened,
    open,
    close() {
      if (pending || saved || busy) return;
      setOpened(false);
      setError('');
      setOptions(null);
      setDenied(false);
    },
    snapshot,
    due,
    setDue(value: string) {
      setDue(value);
      setConfirm(false);
    },
    assignee,
    followupReason,
    setFollowupReason(value: FollowupReason | '') {
      setFollowupReason(value);
      setConfirm(false);
    },
    setAssignee(value: string) {
      setAssignee(value);
      setConfirm(false);
    },
    confirm,
    setConfirm,
    compared,
    comparison,
    mustCompare,
    compare,
    busy,
    pending,
    saved,
    error,
    options,
    denied,
    submit,
    retry() {
      if (pending) void send(pending);
    },
    recover() {
      if (saved && !lock.current) {
        lock.current = true;
        void readback(saved).finally(() => {
          lock.current = false;
        });
      }
    },
    heading,
    dirty: opened,
    unresolved: !!pending || !!saved || busy,
  };
}
export function TaskOperationsSection(props: Props) {
  const sibling = useRef<{
    complete?: ReturnType<typeof useOperation>;
    assign?: ReturnType<typeof useOperation>;
  }>({});
  const [notice, setNotice] = useState('');
  function blocked(kind: Kind) {
    const other = kind === 'assign' ? sibling.current.complete : sibling.current.assign;
    if (other?.dirty || other?.unresolved) {
      setNotice(
        'Diğer görev işleminin açık taslağını kapatın veya belirsiz sonucunu doğrulayın. İki işlem birbirinin taslağını/sürümlerini değiştirmez.',
      );
      return true;
    }
    return false;
  }
  const complete = useOperation('complete', props, () => blocked('complete')),
    assign = useOperation('assign', props, () => blocked('assign'));
  sibling.current = { complete, assign };
  useEffect(() => {
    props.onRisk({
      dirty: complete.dirty || assign.dirty,
      unresolved: complete.unresolved || assign.unresolved,
    });
  }, [complete.dirty, assign.dirty, complete.unresolved, assign.unresolved, props.onRisk]);
  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (complete.dirty || assign.dirty || complete.unresolved || assign.unresolved) {
        event.preventDefault();
        event.returnValue = '';
      }
    };
    addEventListener('beforeunload', warn);
    return () => removeEventListener('beforeunload', warn);
  }, [complete.dirty, assign.dirty, complete.unresolved, assign.unresolved]);
  return (
    <section aria-label="Görev işlemleri" className="renewal-interactions">
      {notice && <p role="alert">{notice}</p>}
      {(props.followupOnly ? (['complete'] as const) : (['complete', 'assign'] as const)).map(
        (kind) => {
          const op = kind === 'complete' ? complete : assign,
            disabled = op.busy || !!op.pending || !!op.saved || op.mustCompare || op.denied;
          return (
            <section
              key={kind}
              aria-label={
                kind === 'complete' ? 'Takibi tamamla ve yenisini planla' : 'Görev sorumlusu'
              }
              className="interaction-form"
            >
              <h3 ref={op.heading} tabIndex={-1}>
                {kind === 'complete' ? 'Takibi tamamla ve yenisini planla' : 'Görev sorumlusu'}
              </h3>
              <p>
                {kind === 'complete'
                  ? 'Mevcut takip tamamlanır ve yerine seçtiğiniz tarihte yeni takip açılır. Yenileme takipte kalır.'
                  : 'Atama yetkiniz ayrıca kontrol edilir. Müşteri ve poliçe sorumlusu ile not yazarı değişmez.'}
              </p>
              <p>
                Mevcut takip: {interactionTime(props.task.dueAt) ?? 'Tarih bilgisi yok'} ·{' '}
                {props.followupOnly
                  ? 'Yenileme takipte kalır.'
                  : props.task.needsReassignment
                    ? 'Tarihsel pasif/askıdaki sorumlu korunuyor; uygun aktif çalışan açıkça seçilmelidir.'
                    : props.task.assigneeMembershipId
                      ? 'Görev atanmış durumda.'
                      : 'Görev atanmamış durumda.'}
              </p>
              {op.error && <p role="alert">{op.error}</p>}
              {op.busy && <p role="status">Yetkili işlem sürüyor…</p>}
              {!op.opened && (
                <Button variant="outline" onClick={() => void op.open()}>
                  {kind === 'complete' ? 'Yeni takip planını aç' : 'Görev atama seçeneklerini aç'}
                </Button>
              )}
              {op.pending && (
                <Button disabled={op.busy} onClick={op.retry}>
                  Aynı {kind === 'complete' ? 'tamamlama' : 'atama'} isteğini yeniden dene
                </Button>
              )}
              {op.saved && (
                <Button disabled={op.busy} onClick={op.recover}>
                  Yalnız {kind === 'complete' ? 'tamamlama' : 'atama'} kuyruğunu yeniden oku
                </Button>
              )}
              {op.opened && (
                <>
                  {!props.followupOnly && (
                    <p>
                      İlk kayıt: yenileme v{op.snapshot?.renewalVersion} / görev v
                      {op.snapshot?.taskVersion}. Yeni sürümler taslağa sessizce geçirilmez.
                    </p>
                  )}
                  {(op.mustCompare || op.compared) && (
                    <>
                      <Button
                        variant="outline"
                        disabled={op.busy || !!op.pending || !!op.saved}
                        onClick={() => void op.compare()}
                      >
                        Güncel {kind === 'complete' ? 'tamamlama' : 'atama'} durumunu karşılaştır
                      </Button>
                      {op.comparison && (
                        <p role="status">
                          Karşılaştırılan: yenileme v{op.comparison.renewalVersion} / görev v
                          {op.comparison.taskVersion}, takip {interactionTime(op.comparison.dueAt)}.
                          Aşağıdaki onay bu güncel bilgilerle yeni istek içindir.
                        </p>
                      )}
                    </>
                  )}
                  {!op.denied && (kind === 'complete' || op.options) && (
                    <form
                      className="interaction-form"
                      aria-label={
                        kind === 'complete' ? 'Takip tamamlama formu' : 'Görev atama formu'
                      }
                      onSubmit={(event) => {
                        event.preventDefault();
                        op.submit();
                      }}
                    >
                      <fieldset disabled={disabled}>
                        {kind === 'complete' ? (
                          <>
                            <label htmlFor="followup-reason">Poliçelendirme neden bekliyor?</label>
                            <select
                              id="followup-reason"
                              value={op.followupReason}
                              onChange={(e) =>
                                op.setFollowupReason(e.target.value as FollowupReason | '')
                              }
                            >
                              <option value="">Genel takip</option>
                              {Object.entries(followupReasons).map(([code, label]) => (
                                <option key={code} value={code}>
                                  {label}
                                </option>
                              ))}
                            </select>
                            <label htmlFor="replacement-time">Yeni takip zamanı (İstanbul)</label>
                            <Input
                              id="replacement-time"
                              type="datetime-local"
                              step="1"
                              value={op.due}
                              onChange={(event) => op.setDue(event.target.value)}
                            />
                          </>
                        ) : (
                          <>
                            <label htmlFor="task-assignee">Yeni görev sorumlusu</label>
                            <select
                              id="task-assignee"
                              value={op.assignee}
                              onChange={(event) => op.setAssignee(event.target.value)}
                            >
                              <option value="">Sorumluyu açıkça seçin</option>
                              {!(op.comparison ?? op.snapshot)?.needsReassignment && (
                                <option value="__unassigned__">
                                  Atanmamış bırak (sunucu kurallarına tabi)
                                </option>
                              )}
                              {op.assignee &&
                                op.assignee !== '__unassigned__' &&
                                !op.options?.some((r) => r.membershipId === op.assignee) && (
                                  <option value={op.assignee} disabled>
                                    Önceki seçim artık uygun değil
                                  </option>
                                )}
                              {op.options?.map((row) => (
                                <option key={row.membershipId} value={row.membershipId}>
                                  {row.label}
                                </option>
                              ))}
                            </select>
                          </>
                        )}
                        <label className="interaction-confirm">
                          <input
                            type="checkbox"
                            checked={op.confirm}
                            onChange={(event) => op.setConfirm(event.target.checked)}
                          />
                          {kind === 'complete'
                            ? 'Mevcut takibi tamamlayıp yenisini planlamayı onaylıyorum'
                            : 'Görev ve yenileme sorumlusunu değiştirmeyi onaylıyorum'}
                        </label>
                      </fieldset>
                      <Button type="submit" disabled={disabled}>
                        {kind === 'complete'
                          ? 'Takibi tamamla ve planla'
                          : 'Görev sorumlusunu kaydet'}
                      </Button>
                    </form>
                  )}
                  <Button
                    variant="outline"
                    disabled={op.busy || !!op.pending || !!op.saved}
                    onClick={op.close}
                  >
                    {kind === 'complete' ? 'Plan taslağını kapat' : 'Atama taslağını kapat'}
                  </Button>
                </>
              )}
            </section>
          );
        },
      )}
    </section>
  );
}
