import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { Button } from '../../components/ui/button';
import { getCsrfToken, invalidateCsrfToken } from '../../csrf';
import type { ApiResponse, TodayTaskDto } from '../../../shared/types';
import {
  CustomerReadError,
  readCustomerResource,
  useCustomerResource,
} from '../customers/customer-resource';
import { canonicalOccurrence, interactionTime } from '../today-work/interaction-model';
import {
  reopenContextSchema,
  renewalReopenResultSchema,
} from '../today-work/renewal-cycle-context';
import type { TaskOperationRisk } from '../today-work/TaskOperationsSection';

interface Attempt {
  key: string;
  body: string;
  accepted?: boolean;
  result?: ReturnType<typeof renewalReopenResultSchema.parse>;
}

export function RenewalReopenForm({
  renewalId,
  canOperate,
  onRisk,
  onApplied,
}: {
  renewalId: string;
  canOperate: () => boolean;
  onRisk: (risk: TaskOperationRisk) => void;
  onApplied: (message: string) => void;
}) {
  const root = `/api/renewals/${encodeURIComponent(renewalId)}`,
    id = useId();
  const [open, setOpen] = useState(false),
    [due, setDue] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [reason, setReason] = useState('CUSTOMER_RETURNED');
  const [busy, setBusy] = useState(false),
    [pending, setPending] = useState<Attempt | null>(null);
  const [error, setError] = useState(''),
    [stale, setStale] = useState(false),
    [denied, setDenied] = useState(false);
  const active = useRef<AbortController | null>(null),
    heading = useRef<HTMLHeadingElement>(null),
    alert = useRef<HTMLParagraphElement>(null);
  const resource = useCustomerResource<unknown>(open ? root + '/cycle-context?mode=reopen' : null);
  const parsed = reopenContextSchema.safeParse(resource.data);
  const context = parsed.success && parsed.data.renewalId === renewalId ? parsed.data : null;
  const cycle = context?.salesCycle;
  useEffect(() => () => active.current?.abort(), []);
  useEffect(
    () => onRisk({ dirty: open, unresolved: busy || !!pending }),
    [open, busy, pending, onRisk],
  );
  useEffect(() => {
    if (open) heading.current?.focus();
  }, [open]);
  useEffect(() => {
    if (error) alert.current?.focus();
  }, [error]);
  async function send(attempt: Attempt) {
    if (active.current || !canOperate() || denied) return;
    const controller = new AbortController(),
      signal = controller.signal;
    active.current = controller;
    setBusy(true);
    setError('');
    setPending(attempt);
    try {
      let saved = attempt;
      if (!saved.accepted) {
        const csrf = await getCsrfToken();
        if (signal.aborted) return;
        const res = await fetch(root + '/reopen', {
          method: 'POST',
          signal,
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': csrf,
            'idempotency-key': attempt.key,
          },
          body: attempt.body,
        });
        if (signal.aborted) return;
        if (res.ok) {
          saved = { ...saved, accepted: true };
          setPending(saved);
        }
        const json = (await res.json().catch(() => null)) as ApiResponse<unknown> | null;
        if (signal.aborted) return;
        if (!res.ok) {
          if (res.status >= 500 || [408, 429].includes(res.status)) throw Error('UNKNOWN');
          if ([401, 403].includes(res.status)) invalidateCsrfToken();
          if (res.status === 401) document.dispatchEvent(new Event('mayi-session-ended'));
          setDenied([401, 403, 404].includes(res.status));
          if (json?.success === false && json.error.code === 'IDEMPOTENCY_CONFLICT') {
            setError('İşlem anahtarı çakıştı. Sonucu doğrulamak için kayıtları kontrol edin.');
            return;
          }
          setPending(null);
          setConfirmed(false);
          setStale(true);
          setError(json?.success === false ? json.error.message : 'Yenileme yeniden açılamadı.');
          return;
        }
        const result = renewalReopenResultSchema.safeParse(json?.success ? json.data : null);
        const command = JSON.parse(attempt.body);
        if (
          !result.success ||
          result.data.renewalId !== renewalId ||
          result.data.renewalVersion !== command.expectedRenewalVersion + 1 ||
          result.data.closedTaskVersion !== command.expectedTaskVersion ||
          result.data.closedTaskId !== context?.taskId ||
          result.data.primaryTaskId === result.data.closedTaskId ||
          JSON.stringify(
            result.data.salesCycle && {
              caseId: result.data.salesCycle.caseId,
              expectedCaseVersion: result.data.salesCycle.expectedCaseVersion,
              resultRevisionId: result.data.salesCycle.resultRevisionId,
              successorCaseId: result.data.salesCycle.successorCaseId,
            },
          ) !== JSON.stringify(command.salesCycle) ||
          (result.data.salesCycle &&
            (result.data.salesCycle.successorTaskId === null) !==
              (result.data.salesCycle.successorCaseId === null))
        )
          throw Error('INVALID_RESPONSE');
        saved = { ...saved, result: result.data };
        setPending(saved);
      }
      if (!saved.result) throw Error('INVALID_RESPONSE');
      const task = await readCustomerResource<TodayTaskDto | null>(
        root + '/operation-context',
        signal,
      );
      if (
        task?.renewalId !== renewalId ||
        task.renewalVersion !== saved.result.renewalVersion ||
        task.taskVersion !== saved.result.taskVersion ||
        task.taskId !== saved.result.primaryTaskId ||
        task.dueAt !== JSON.parse(saved.body).replacementDueAt
      )
        throw Error('INVALID_READBACK');
      if (signal.aborted) return;
      setPending(null);
      setOpen(false);
      onApplied(
        saved.result.salesCycle?.successorCaseId
          ? 'Yenileme yeniden açıldı. Sonraki dönem takibi geri alındı.'
          : 'Yenileme yeniden açıldı ve takip oluşturuldu.',
      );
    } catch (cause) {
      if (signal.aborted) return;
      if (cause instanceof CustomerReadError && [401, 403, 404].includes(cause.status))
        setDenied(true);
      setError(
        'İşlem henüz doğrulanamadı. Aynı işlemi kontrol edin. Kabul edilen kayıt tekrar gönderilmez.',
      );
    } finally {
      active.current = null;
      if (!signal.aborted) setBusy(false);
    }
  }
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!context || !confirmed || pending || stale || denied || cycle?.canRecall === false) return;
    const when = canonicalOccurrence(due);
    if (!when) {
      setError('Geçerli bir takip zamanı girin.');
      return;
    }
    const salesCycle = cycle && {
      caseId: cycle.caseId,
      expectedCaseVersion: cycle.expectedCaseVersion,
      resultRevisionId: cycle.resultRevisionId,
      successorCaseId: cycle.successorCaseId,
    };
    void send({
      key: crypto.randomUUID(),
      body: JSON.stringify({
        expectedRenewalVersion: context.renewalVersion,
        expectedTaskVersion: context.taskVersion,
        replacementDueAt: when,
        reopenReasonCode: reason,
        ...(salesCycle ? { salesCycle } : {}),
      }),
    });
  }
  if (!open)
    return (
      <Button
        variant="outline"
        disabled={!canOperate()}
        onClick={() => {
          if (canOperate()) {
            setOpen(true);
            setConfirmed(false);
            setDenied(false);
            setStale(false);
            setError('');
          }
        }}
      >
        Yenilemeyi yeniden aç
      </Button>
    );
  return (
    <section className="renewal-record-card" aria-labelledby={id}>
      <h3 id={id} ref={heading} tabIndex={-1}>
        Yenilemeyi yeniden aç
      </h3>
      {resource.loading && <p role="status">Takip bilgisi yükleniyor…</p>}
      {!resource.loading && !context && (
        <p role="alert">Yeniden açma bilgisi okunamadı veya yetkiniz yok.</p>
      )}
      {context && !denied && (
        <form
          className="issue-policy-form renewal-reopen-form"
          aria-labelledby={id}
          onSubmit={submit}
        >
          {cycle &&
            (cycle.canRecall && cycle.successorCaseId && cycle.successorDueAt ? (
              <p>
                <Link to={`/sales-cases/${encodeURIComponent(cycle.successorCaseId)}`}>
                  {interactionTime(cycle.successorDueAt)} tarihli sonraki dönem takibi
                </Link>{' '}
                geri alınacak.
              </p>
            ) : !cycle.canRecall ? (
              <p role="alert">
                Sonraki dönem takibi ilerlemiş veya başka bir çalışana ait. Bu yenileme yeniden
                açılamaz.
              </p>
            ) : null)}
          <fieldset disabled={busy || !!pending || stale || cycle?.canRecall === false}>
            <legend>Yeni takip</legend>
            <label>
              Yeniden açma nedeni
              <select
                value={reason}
                onChange={(event) => {
                  setReason(event.target.value);
                  setConfirmed(false);
                }}
              >
                <option value="CUSTOMER_RETURNED">Müşteri geri döndü</option>
                <option value="TECHNICAL_ERROR">Kapanış kaydını düzelt</option>
              </select>
            </label>
            <label>
              Takip zamanı · İstanbul
              <input
                type="datetime-local"
                required
                value={due}
                onChange={(e) => {
                  setDue(e.target.value);
                  setConfirmed(false);
                }}
              />
            </label>
            <label className="issue-confirm">
              <input
                type="checkbox"
                required
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              {cycle?.successorCaseId
                ? 'Sonraki dönem takibinin geri alınmasını ve yenilemenin yeniden açılmasını onaylıyorum.'
                : 'Yenilemenin yeniden açılmasını onaylıyorum.'}
            </label>
            <Button type="submit">Yeni takip oluştur ve yeniden aç</Button>
          </fieldset>
        </form>
      )}
      {error && (
        <p role="alert" ref={alert} tabIndex={-1}>
          {error}
        </p>
      )}
      {pending && (
        <Button
          type="button"
          variant="outline"
          disabled={busy || denied || !!(pending.accepted && !pending.result)}
          onClick={() => void send(pending)}
        >
          {pending.accepted ? 'Kayıtlı sonucu doğrula' : 'Aynı işlemi tekrar kontrol et'}
        </Button>
      )}
      {!pending && !busy && (stale || resource.error || cycle?.canRecall === false) && (
        <Button
          type="button"
          variant="outline"
          onClick={() => {
            setStale(false);
            setDenied(false);
            setConfirmed(false);
            setError('');
            resource.reload();
          }}
        >
          Güncel takibi kontrol et
        </Button>
      )}
      {!pending && !busy && (
        <Button type="button" variant="outline" onClick={() => setOpen(false)}>
          Vazgeç
        </Button>
      )}
    </section>
  );
}
