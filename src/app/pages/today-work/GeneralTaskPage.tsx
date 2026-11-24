import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router';
import {
  generalTaskContextSchema,
  generalTaskCommandResultSchema,
  type GeneralTaskCommandResult,
} from '../../../shared/task-general';
import type { ApiResponse } from '../../../shared/types';
import { Button } from '../../components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '../../components/ui/card';
import { PageHeader } from '../../components/layout/PageContainer';
import { CustomerNumberGuard } from '../customers/CustomerNumberGuard';
import { readCustomerResource, useCustomerResource } from '../customers/customer-resource';
import { getCsrfToken, invalidateCsrfToken } from '../../csrf';
import { canonicalOccurrence } from './interaction-model';
import { ReturnToWork } from './work-navigation';
import { SalesIssueSection } from '../sales/SalesIssueSection';

type Kind = 'reschedule' | 'complete';
type Attempt = { kind: Kind; body: string; key: string; result?: GeneralTaskCommandResult };
const labels = {
  reschedule: 'Takip zamanını değiştir',
  complete: 'İşi tamamla',
};
const reasons = {
  reschedule: [
    ['CALL_AGAIN', 'Tekrar aranacak'],
    ['CUSTOMER_RESPONSE_PENDING', 'Müşterinin yanıtı bekleniyor'],
    ['DOCUMENTS_PENDING', 'Evrak bekleniyor'],
    ['PRICE_REVISION_PENDING', 'Fiyat güncellenecek'],
  ],
  complete: [
    ['COMPLETED', 'Takip tamamlandı'],
    ['DUPLICATE', 'Mükerrer takip'],
    ['NO_FURTHER_CONTACT', 'Tekrar iletişim kurulmayacak'],
  ],
};
const date = (value: string) =>
  new Intl.DateTimeFormat('tr-TR', {
    timeZone: 'Europe/Istanbul',
    dateStyle: 'long',
    timeStyle: 'short',
  }).format(new Date(value));
function GeneralTask({ id }: { id: string }) {
  const record = useCustomerResource<unknown>(
    `/api/tasks/${encodeURIComponent(id)}/general-context`,
  );
  const decoded = generalTaskContextSchema.safeParse(record.data);
  const current = decoded.success && decoded.data.taskId === id ? decoded.data : null;
  const [mode, setMode] = useState<Kind | null>(null),
    [due, setDue] = useState(''),
    [reason, setReason] = useState('CALL_AGAIN'),
    [notes, setNotes] = useState('');
  const [pending, setPending] = useState<Attempt | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [conflict, setConflict] = useState(false),
    [message, setMessage] = useState('');
  const [issueRisk, setIssueRisk] = useState({ dirty: false, unresolved: false });
  const [issuedPolicyId, setIssuedPolicyId] = useState<string | null>(null);
  const issueActive = issueRisk.dirty || issueRisk.unresolved;
  const writing = useRef(false),
    live = useRef(true),
    errorRef = useRef<HTMLParagraphElement>(null),
    formHeading = useRef<HTMLHeadingElement>(null);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  useEffect(() => {
    if (mode) formHeading.current?.focus();
  }, [mode]);
  const locked = busy || !!pending;
  async function send(attempt: Attempt) {
    if (writing.current) return;
    writing.current = true;
    setBusy(true);
    setError('');
    try {
      let accepted = attempt;
      if (!attempt.result) {
        const token = await getCsrfToken();
        const response = await fetch(`/api/tasks/${encodeURIComponent(id)}/${attempt.kind}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': token,
            'idempotency-key': attempt.key,
          },
          body: attempt.body,
        });
        if (!live.current) return;
        const json = (await response.json()) as ApiResponse<unknown>;
        if (!response.ok || !json.success) {
          if (response.status === 401) {
            invalidateCsrfToken();
            document.dispatchEvent(new Event('mayi-session-ended'));
          }
          if (response.status === 403) invalidateCsrfToken();
          const code = !json.success ? json.error.code : 'UNKNOWN';
          if (
            [400, 413, 415].includes(response.status) ||
            (response.status === 409 && code !== 'IDEMPOTENCY_CONFLICT')
          )
            setPending(null);
          if (response.status === 409 && code !== 'IDEMPOTENCY_CONFLICT') setConflict(true);
          throw Error(!json.success ? json.error.message : 'Takip yanıtı doğrulanamadı.');
        }
        const result = generalTaskCommandResultSchema.parse(json.data);
        const command = JSON.parse(attempt.body) as {
          expectedTaskVersion: number;
          dueAt?: string;
        };
        if (
          result.taskId !== id ||
          result.taskVersion !== command.expectedTaskVersion + 1 ||
          result.status !== (attempt.kind === 'complete' ? 'COMPLETED' : 'OPEN') ||
          (attempt.kind === 'reschedule' && result.dueAt !== command.dueAt)
        )
          throw Error('İşlem yanıtı gönderilen takiple eşleşmedi.');
        accepted = { ...attempt, result };
        setPending(accepted);
      }
      const result = accepted.result!;
      const proof = generalTaskCommandResultSchema.parse(
        await readCustomerResource(
          `/api/tasks/${encodeURIComponent(id)}/operations/${encodeURIComponent(result.operationId)}`,
        ),
      );
      if (JSON.stringify(proof) !== JSON.stringify(result))
        throw Error('Kayıtlı işlem sonucu eşleşmedi.');
      record.reload();
      if (live.current) {
        setPending(null);
        setMode(null);
        setDue('');
        setNotes('');
        setConflict(false);
        setMessage(
          attempt.kind === 'complete' ? 'Müşteri takibi tamamlandı.' : 'Takip zamanı güncellendi.',
        );
      }
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : 'Takip doğrulanamadı.');
    } finally {
      writing.current = false;
      if (live.current) setBusy(false);
    }
  }
  function open(kind: Kind) {
    setMode(kind);
    setError('');
    setConflict(false);
    setReason(kind === 'complete' ? 'COMPLETED' : 'CALL_AGAIN');
    setDue('');
    setNotes('');
  }
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!current || !mode || locked || conflict) return;
    const when = mode === 'reschedule' ? canonicalOccurrence(due) : null;
    if (mode === 'reschedule' && !when) {
      setError('Geçerli takip zamanı seçin.');
      return;
    }
    const command = {
      expectedTaskVersion: current.taskVersion,
      notes: notes.trim() || null,
      reasonCode: reason,
      ...(mode === 'reschedule' ? { dueAt: when } : {}),
    };
    const attempt = { kind: mode, body: JSON.stringify(command), key: crypto.randomUUID() };
    setPending(attempt);
    void send(attempt);
  }
  return (
    <div className="customer-modern crm-workspace general-task-page">
      <CustomerNumberGuard
        protectSearch
        dirty={mode !== null || issueRisk.dirty}
        unresolved={locked || issueRisk.unresolved}
        label="Müşteri takibi"
      />
      <ReturnToWork fallback />
      <PageHeader
        title="Müşteri takibi"
        description="Görüşmeyi planlayın veya tamamlanan takibi kapatın"
      />
      {message && (
        <p role="status" className="policy-lifecycle-summary">
          {message}
        </p>
      )}
      {issuedPolicyId && (
        <p role="status">
          Poliçe kaydı doğrulandı ve takip kapatıldı.{' '}
          <Link to={`/policies/${encodeURIComponent(issuedPolicyId)}`}>Poliçeyi aç</Link>
        </p>
      )}
      {record.loading && <p role="status">Takip yükleniyor…</p>}
      {(record.error || (!record.loading && !current)) && (
        <div role="alert">
          <p>{record.error?.message ?? 'Takip bilgisi doğrulanamadı. Yeniden yükleyin.'}</p>
          <Button variant="outline" disabled={locked} onClick={record.reload}>
            Takibi yeniden yükle
          </Button>
        </div>
      )}
      {error && (
        <p className="customer-error" role="alert" ref={errorRef} tabIndex={-1}>
          {error}
        </p>
      )}
      {pending && (
        <div className="policy-lifecycle-summary">
          <p>Sonuç doğrulanana kadar bilgiler korunuyor.</p>
          <Button disabled={busy} onClick={() => void send(pending)}>
            {pending.result ? 'Kayıtlı sonucu doğrula' : 'Aynı işlemi tekrar kontrol et'}
          </Button>
        </div>
      )}
      {busy && <p role="status">Takip kaydı doğrulanıyor…</p>}
      {current && (
        <Card>
          <CardHeader>
            <CardTitle>{current.customerName}</CardTitle>
          </CardHeader>
          <CardContent>
            <h2>{current.title}</h2>
            <dl className="customer-info-grid">
              <div>
                <dt>Takip zamanı · İstanbul</dt>
                <dd>{date(current.dueAt)}</dd>
              </div>
              <div>
                <dt>Durum</dt>
                <dd>{current.status === 'COMPLETED' ? 'Tamamlandı' : 'Takipte'}</dd>
              </div>
            </dl>
            <div className="customer-form-actions">
              <Button asChild variant="outline">
                <Link to={`/customers/${encodeURIComponent(current.customerId)}`}>
                  Müşteri kartı
                </Link>
              </Button>
              {current.caseId && (
                <Button asChild variant="outline">
                  <Link to={`/sales-cases/${encodeURIComponent(current.caseId)}`}>
                    Teklif çalışmasını aç
                  </Link>
                </Button>
              )}
            </div>
            {current.caseId && current.status === 'OPEN' && (
              <SalesIssueSection
                caseId={current.caseId}
                expectedTaskId={current.taskId}
                canOperate={() => !mode && !locked}
                onRisk={setIssueRisk}
                onChanged={(result) => {
                  setIssueRisk({ dirty: false, unresolved: false });
                  setIssuedPolicyId(result.policyId);
                  record.reload();
                }}
              />
            )}
            {!mode && !issueActive && (
              <div className="customer-form-actions">
                {current.canReschedule && (
                  <Button onClick={() => open('reschedule')}>{labels.reschedule}</Button>
                )}
                {current.canComplete && (
                  <Button variant="outline" onClick={() => open('complete')}>
                    {labels.complete}
                  </Button>
                )}
              </div>
            )}
            {mode && (
              <form
                className="customer-edit-form sales-case-form"
                aria-label={labels[mode]}
                method="post"
                action={`/api/tasks/${encodeURIComponent(id)}/${mode}`}
                onSubmit={submit}
              >
                <h2 tabIndex={-1} ref={formHeading}>
                  {labels[mode]}
                </h2>
                {conflict && (
                  <div className="policy-lifecycle-summary">
                    <p>Taslağınız korundu. Kaydetmeden önce güncel takibi kontrol edin.</p>
                    <Button
                      variant="outline"
                      disabled={locked}
                      onClick={() => {
                        record.reload();
                        setConflict(false);
                      }}
                    >
                      Güncel takibi kontrol et
                    </Button>
                  </div>
                )}
                <fieldset disabled={locked || conflict}>
                  <legend>Takip bilgileri</legend>
                  {mode === 'reschedule' && (
                    <>
                      <label htmlFor="general-due">Yeni takip zamanı · İstanbul (zorunlu)</label>
                      <input
                        id="general-due"
                        name="dueAt"
                        type="datetime-local"
                        required
                        value={due}
                        onChange={(e) => {
                          setDue(e.target.value);
                          setError('');
                        }}
                      />
                    </>
                  )}
                  <fieldset className="general-task-options">
                    <legend>{mode === 'complete' ? 'Tamamlama nedeni' : 'Takip nedeni'}</legend>
                    {reasons[mode].map(([value, label]) => (
                      <label key={value}>
                        <input
                          type="radio"
                          name="reasonCode"
                          value={value}
                          required
                          checked={reason === value}
                          onChange={() => setReason(value!)}
                        />
                        <span>{label}</span>
                      </label>
                    ))}
                  </fieldset>
                  <label htmlFor="general-notes">Kısa not (isteğe bağlı)</label>
                  <textarea
                    id="general-notes"
                    name="notes"
                    maxLength={500}
                    rows={3}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                  />
                  <div className="policy-lifecycle-summary">
                    <strong>{current.customerName}</strong>
                    <p>
                      {mode === 'complete'
                        ? 'Bu müşteri takibi tamamlandı olarak kaydedilecek.'
                        : canonicalOccurrence(due)
                          ? 'Yeni takip: ' + date(canonicalOccurrence(due)!)
                          : 'Yeni takip zamanını seçin.'}
                    </p>
                  </div>
                </fieldset>
                <div className="customer-form-actions">
                  <Button type="submit" disabled={locked || conflict}>
                    {mode === 'complete' ? 'Tamamlandığını kaydet' : 'Takip zamanını kaydet'}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={locked}
                    onClick={() => {
                      setMode(null);
                      setError('');
                    }}
                  >
                    Vazgeç
                  </Button>
                </div>
              </form>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
export default function GeneralTaskPage() {
  const { taskId } = useParams();
  return taskId ? <GeneralTask key={taskId} id={taskId} /> : null;
}
