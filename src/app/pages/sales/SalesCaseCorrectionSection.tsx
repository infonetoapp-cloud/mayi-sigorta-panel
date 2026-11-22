import { useEffect, useId, useRef, useState } from 'react';
import {
  salesVoidCommandSchema,
  salesVoidContextSchema,
  salesVoidReasons,
  salesVoidResultSchema,
  type SalesVoidContext,
} from '../../../shared/sales-void';
import type { ApiResponse } from '../../../shared/types';
import {
  salesReopenContextSchema,
  salesReopenResultSchema,
  salesReopenSchema,
  type SalesReopenContext,
} from '../../../shared/sales-reopen';
import { Button } from '../../components/ui/button';
import { getCsrfToken, invalidateCsrfToken } from '../../csrf';
import { CustomerReadError, readCustomerResource } from '../customers/customer-resource';
import { canonicalOccurrence, interactionTime } from '../today-work/interaction-model';

type CorrectionContext = SalesVoidContext | SalesReopenContext;
function isReopenContext(value: CorrectionContext): value is SalesReopenContext {
  return 'resultRevisionId' in value;
}
type Attempt = {
  body: string;
  key: string;
  accepted: boolean;
  context: CorrectionContext;
  dueAt: string | null;
};
type Risk = { dirty: boolean; unresolved: boolean };
export function SalesCaseCorrectionSection({
  caseId,
  operation,
  taskId,
  canOperate,
  onRisk,
  onChanged,
}: {
  caseId: string;
  operation: 'void' | 'reopen';
  taskId?: string;
  canOperate: () => boolean;
  onRisk: (risk: Risk) => void;
  onChanged: (taskId: string) => void;
}) {
  const id = useId();
  const path = `/api/sales-cases/${encodeURIComponent(caseId)}/${operation}`;
  const reopening = operation === 'reopen';
  const title = reopening ? 'Çalışmayı yeniden aç' : 'Çalışmayı geçersiz kıl';
  const [context, setContext] = useState<CorrectionContext | null>(null);
  const [due, setDue] = useState('');
  const [reason, setReason] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Attempt | null>(null);
  const [stale, setStale] = useState(false);
  const [masked, setMasked] = useState(false);
  const [error, setError] = useState('');
  const live = useRef(false),
    working = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null),
    alert = useRef<HTMLParagraphElement>(null);
  const locked = busy || !!pending;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => onRisk({ dirty: !!context, unresolved: locked }), [context, locked, onRisk]);
  useEffect(() => {
    if (context) heading.current?.focus();
  }, [context]);
  useEffect(() => {
    if (error) alert.current?.focus();
  }, [error]);

  async function load() {
    if (working.current || pending || !canOperate()) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      const raw = await readCustomerResource(path + '-context');
      const data = reopening
        ? salesReopenContextSchema.parse(raw)
        : salesVoidContextSchema.parse(raw);
      if (!live.current) return;
      if (
        data.caseId !== caseId ||
        (taskId && data.taskId !== taskId) ||
        (context && context.taskId !== data.taskId) ||
        (context &&
          isReopenContext(context) &&
          isReopenContext(data) &&
          (context.resultRevisionId !== data.resultRevisionId ||
            context.successor?.caseId !== data.successor?.caseId ||
            context.successor?.taskId !== data.successor?.taskId))
      ) {
        setMasked(true);
        setError('Bağlı takip değişti. Güncel işi yeniden açın.');
        return;
      }
      setContext(data);
      setMasked(false);
      setStale(false);
    } catch (cause) {
      if (live.current) {
        if (cause instanceof CustomerReadError && [401, 403, 404].includes(cause.status))
          setMasked(true);
        setError(
          cause instanceof CustomerReadError
            ? reopening && cause.status === 409
              ? 'Sonraki dönem ilerletilmiş veya geri alınamıyor. Çalışma yeniden açılmadı.'
              : cause.message
            : 'Çalışma bilgileri doğrulanamadı.',
        );
      }
    } finally {
      working.current = false;
      if (live.current) setBusy(false);
    }
  }

  function sessionStatus(status: number) {
    if (status === 401 || status === 403) invalidateCsrfToken();
    if (status === 401) document.dispatchEvent(new Event('mayi-session-ended'));
  }

  async function send(attempt: Attempt) {
    if (working.current || masked || !canOperate()) return;
    working.current = true;
    setBusy(true);
    setError('');
    let accepted = attempt.accepted;
    try {
      if (!accepted) {
        const token = await getCsrfToken();
        const reply = await fetch(path, {
          method: 'POST',
          body: attempt.body,
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': token,
            'idempotency-key': attempt.key,
          },
        });
        if (!live.current) return;
        if (!reply.ok) {
          if (reply.status >= 500 || [408, 429].includes(reply.status)) throw Error('UNCERTAIN');
          const body = (await reply.json().catch(() => null)) as ApiResponse<unknown> | null;
          if (!live.current) return;
          if (body && !body.success && body.error.code === 'IDEMPOTENCY_CONFLICT')
            throw Error('UNCERTAIN');
          sessionStatus(reply.status);
          setPending(null);
          if ([401, 403, 404].includes(reply.status)) setMasked(true);
          setStale(true);
          setError(
            reopening
              ? 'Çalışma yeniden açılamadı. Güncel bilgileri yükleyip tekrar kontrol edin.'
              : 'Çalışma kapatılamadı. Güncel bilgileri yükleyip tekrar kontrol edin.',
          );
          return;
        }
        accepted = true;
        setPending({ ...attempt, accepted: true });
      }
      const proof = await fetch(path + '-operation', {
        cache: 'no-store',
        headers: { 'idempotency-key': attempt.key },
      });
      if (!live.current) return;
      sessionStatus(proof.status);
      if (!proof.ok) throw Error('UNVERIFIED');
      const body = (await proof.json()) as ApiResponse<unknown>;
      if (!live.current) return;
      const current = attempt.context;
      const raw = body.success ? body.data : null;
      const outcome =
        'resultRevisionId' in current
          ? salesReopenResultSchema.parse(raw)
          : salesVoidResultSchema.parse(raw);
      if (outcome.caseId !== current.caseId || outcome.caseVersion !== current.caseVersion + 1)
        throw Error('UNVERIFIED');
      if ('previousTaskId' in outcome && 'resultRevisionId' in current) {
        if (
          outcome.resultRevisionId !== current.resultRevisionId ||
          outcome.previousTaskId !== current.taskId ||
          outcome.previousTaskVersion !== current.taskVersion ||
          outcome.taskId === current.taskId ||
          outcome.dueAt !== attempt.dueAt ||
          (current.successor
            ? outcome.successor?.caseId !== current.successor.caseId ||
              outcome.successor?.taskId !== current.successor.taskId ||
              outcome.successor.caseVersion !== current.successor.caseVersion + 1 ||
              outcome.successor.taskVersion !== current.successor.taskVersion + 1
            : outcome.successor !== null)
        )
          throw Error('UNVERIFIED');
      } else if (
        outcome.taskId !== current.taskId ||
        outcome.taskVersion !== current.taskVersion + 1
      ) {
        throw Error('UNVERIFIED');
      }
      setPending(null);
      setContext(null);
      onChanged(outcome.taskId);
    } catch {
      if (live.current)
        setError(
          accepted
            ? reopening
              ? 'Kayıt alındı. Yeniden açma sonucu henüz doğrulanamadı.'
              : 'Kayıt alındı. Kapanış sonucu henüz doğrulanamadı.'
            : 'İşlem sonucu belirsiz. Aynı isteği tekrar kontrol edebilirsiniz.',
        );
    } finally {
      working.current = false;
      if (live.current) setBusy(false);
    }
  }

  return (
    <section aria-label={title}>
      {!context && (
        <Button
          type="button"
          variant="outline"
          disabled={locked || !canOperate()}
          onClick={() => void load()}
        >
          {title}
        </Button>
      )}
      {context && (
        <form
          className="issue-policy-form"
          aria-labelledby={id + '-heading'}
          onSubmit={(event) => {
            event.preventDefault();
            if (locked || working.current || stale || masked || !canOperate()) return;
            const common = {
              expectedCaseVersion: context.caseVersion,
              expectedTaskId: context.taskId,
              expectedTaskVersion: context.taskVersion,
              reasonCode: reason,
              notes,
            };
            const dueAt = reopening ? canonicalOccurrence(due) : null;
            if (reopening && (!dueAt || dueAt <= new Date().toISOString())) {
              setError('Yeni takip için ileri bir tarih ve saat seçin.');
              return;
            }
            const command =
              'resultRevisionId' in context
                ? salesReopenSchema.safeParse({
                    ...common,
                    expectedResultRevisionId: context.resultRevisionId,
                    replacementDueAt: dueAt,
                    expectedSuccessor: context.successor
                      ? {
                          caseId: context.successor.caseId,
                          caseVersion: context.successor.caseVersion,
                          taskId: context.successor.taskId,
                          taskVersion: context.successor.taskVersion,
                        }
                      : null,
                  })
                : salesVoidCommandSchema.safeParse(common);
            if (!command.success) {
              setError(
                reopening
                  ? 'Yeniden açma nedenini seçin ve kısa bir açıklama yazın.'
                  : 'Kapatma nedenini seçin ve kısa bir açıklama yazın.',
              );
              return;
            }
            const attempt = {
              body: JSON.stringify(command.data),
              key: crypto.randomUUID(),
              accepted: false,
              context,
              dueAt,
            };
            setPending(attempt);
            void send(attempt);
          }}
        >
          <h3 ref={heading} tabIndex={-1} id={id + '-heading'}>
            {title}
          </h3>
          {!masked && (
            <>
              <p className="issue-help">
                {reopening
                  ? 'Yeni bir takip açılır. Eski kayıp kaydı, fiyatlar ve görüşme geçmişi saklanır.'
                  : 'Çalışma ve bağlı takip kapanır. Kayıtlı fiyatlar ve görüşme geçmişi saklanır.'}
              </p>
              {'successor' in context && context.successor && (
                <p className="issue-difference">
                  Sonraki dönem takibi geri alınacak. Planlanan zaman{' '}
                  {interactionTime(context.successor.dueAt)}.
                </p>
              )}
              <fieldset disabled={locked || stale}>
                <legend className="sr-only">
                  {reopening ? 'Yeniden açma bilgileri' : 'Kapatma bilgileri'}
                </legend>
                {reopening && (
                  <>
                    <label htmlFor={id + '-due'}>Yeni takip zamanı (İstanbul) *</label>
                    <input
                      id={id + '-due'}
                      type="datetime-local"
                      required
                      value={due}
                      onInput={(e) => setDue(e.currentTarget.value)}
                      onChange={(e) => {
                        setDue(e.target.value);
                        setError('');
                      }}
                    />
                  </>
                )}
                <label htmlFor={id + '-reason'}>
                  {reopening ? 'Yeniden açma nedeni *' : 'Kapatma nedeni *'}
                </label>
                <select
                  id={id + '-reason'}
                  value={reason}
                  required
                  onChange={(e) => {
                    setReason(e.target.value);
                    setError('');
                  }}
                >
                  <option value="" disabled>
                    Neden seçin
                  </option>
                  {Object.entries(
                    reopening
                      ? { WRONG_OUTCOME: 'Kayıp sonucu yanlış seçildi', OTHER: 'Diğer' }
                      : salesVoidReasons,
                  ).map(([code, label]) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
                </select>
                <label htmlFor={id + '-notes'}>Kısa açıklama * (3–500 karakter)</label>
                <textarea
                  id={id + '-notes'}
                  value={notes}
                  rows={3}
                  required
                  minLength={3}
                  maxLength={500}
                  onChange={(e) => {
                    setNotes(e.target.value);
                    setError('');
                  }}
                />
              </fieldset>
            </>
          )}
          <div className="customer-form-actions">
            {!masked && (
              <Button
                type="submit"
                variant={reopening ? 'default' : 'danger'}
                disabled={locked || stale}
              >
                {reopening ? 'Yeniden aç ve takip oluştur' : 'Çalışmayı kapat'}
              </Button>
            )}
            {stale && (
              <Button type="button" variant="outline" disabled={locked} onClick={() => void load()}>
                Güncel bilgileri yükle
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={locked}
              onClick={() => {
                setContext(null);
                setReason('');
                setNotes('');
                setDue('');
                setError('');
                setStale(false);
                setMasked(false);
              }}
            >
              Vazgeç
            </Button>
          </div>
        </form>
      )}
      {pending && (
        <Button type="button" variant="outline" disabled={busy} onClick={() => void send(pending)}>
          {pending.accepted ? 'Kayıtlı sonucu doğrula' : 'Aynı işlemi tekrar kontrol et'}
        </Button>
      )}
      {busy && <p role="status">Çalışma kontrol ediliyor…</p>}
      {error && (
        <p className="customer-error" ref={alert} tabIndex={-1} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
