import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { Link } from 'react-router';
import { z } from 'zod';
import {
  salesLossCommandSchema,
  salesLossContextSchema,
  salesLossResultSchema,
  type SalesLossResult,
} from '../../../shared/sales-loss';
import { validBirthDate } from '../../../shared/customer-profile';
import type { ApiResponse } from '../../../shared/types';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { getCsrfToken, invalidateCsrfToken } from '../../csrf';
import {
  CustomerReadError,
  readCustomerResource,
  useCustomerResource,
} from '../customers/customer-resource';
import { canonicalOccurrence, interactionTime } from '../today-work/interaction-model';
type Risk = { dirty: boolean; unresolved: boolean };
type Attempt = { body: string; key: string; serverAccepted?: boolean; result?: SalesLossResult };
type LossContext = z.infer<typeof salesLossContextSchema>;
const outcomeSchema = z.strictObject({
  resultRevisionId: z.string(),
  reason: z.string(),
  reasonCode: z.string(),
  notes: z.string().nullable(),
  closedAt: z.string(),
  followupCaseId: z.string().nullable(),
  exceptionCode: z.string().nullable(),
});
export function SalesLossSection({
  caseId,
  result,
  canOperate,
  onRisk,
  onChanged,
}: {
  caseId: string;
  result: string;
  canOperate: () => boolean;
  onRisk: (risk: Risk) => void;
  onChanged: () => void;
}) {
  const id = useId(),
    base = `/api/sales-cases/${encodeURIComponent(caseId)}`;
  const summary = useCustomerResource<unknown>(result === 'LOST' ? `${base}/loss-result` : null);
  const outcome = outcomeSchema.safeParse(summary.data);
  const [editing, setEditing] = useState(false),
    [context, setContext] = useState<LossContext | null>(null),
    [reason, setReason] = useState(''),
    [notes, setNotes] = useState(''),
    [mode, setMode] = useState<'FOLLOW_UP' | 'NO_FOLLOW_UP'>('FOLLOW_UP'),
    [cycle, setCycle] = useState(''),
    [known, setKnown] = useState(false),
    [due, setDue] = useState(''),
    [exception, setException] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [busy, setBusy] = useState(false),
    [conflict, setConflict] = useState(false),
    [denied, setDenied] = useState(false),
    [error, setError] = useState(''),
    [pending, setPending] = useState<Attempt | null>(null);
  const live = useRef(true),
    saving = useRef(false),
    errorRef = useRef<HTMLParagraphElement>(null),
    heading = useRef<HTMLHeadingElement>(null);
  const locked = busy || !!pending;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    onRisk({ dirty: editing, unresolved: locked });
  }, [editing, locked, onRisk]);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  useEffect(() => {
    if (editing) heading.current?.focus();
  }, [editing]);
  function failure(e: unknown) {
    if (e instanceof CustomerReadError && [401, 403, 404].includes(e.status)) setDenied(true);
    setError(e instanceof Error ? e.message : 'Kayıt doğrulanamadı.');
  }
  async function load() {
    if (locked || !canOperate()) return;
    setBusy(true);
    setError('');
    try {
      const c = salesLossContextSchema.parse(await readCustomerResource(`${base}/loss-context`));
      if (c.caseId !== caseId) throw Error('Çalışma bilgisi eşleşmedi.');
      if (live.current) {
        setContext(c);
        setEditing(true);
        setConflict(false);
        setDenied(false);
        setConfirmed(false);
      }
    } catch (e) {
      if (live.current) failure(e);
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function send(a: Attempt) {
    if (saving.current || denied) return;
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      let accepted = a;
      if (!a.serverAccepted) {
        const csrf = await getCsrfToken();
        const response = await fetch(`${base}/close-lost`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': csrf,
            'idempotency-key': a.key,
          },
          body: a.body,
        });
        if (!live.current) return;
        if (response.ok) {
          accepted = { ...a, serverAccepted: true };
          setPending(accepted);
        }
        const data = (await response.json()) as ApiResponse<unknown>;
        if (!response.ok || !data.success) {
          if ([401, 403].includes(response.status)) {
            invalidateCsrfToken();
            setDenied(true);
            if (response.status === 401) document.dispatchEvent(new Event('mayi-session-ended'));
          }
          if ([400, 409, 413, 415].includes(response.status)) {
            if (!data.success && data.error.code !== 'IDEMPOTENCY_CONFLICT') {
              setPending(null);
              setConflict(true);
            }
          }
          throw Error(!data.success ? data.error.message : 'Kayıt doğrulanamadı.');
        }
        const r = salesLossResultSchema.parse(data.data),
          c = salesLossCommandSchema.parse(JSON.parse(a.body));
        // A success response is never POSTed again, even if its body is malformed.
        if (
          r.caseId !== caseId ||
          r.caseVersion !== c.expectedCaseVersion + 1 ||
          r.taskId !== c.expectedTaskId ||
          r.taskVersion !== c.expectedTaskVersion + 1 ||
          (c.nextCycle.mode === 'FOLLOW_UP'
            ? !r.followup ||
              r.followup.dueAt !== c.nextCycle.dueAt ||
              r.followup.cycleDate !== c.nextCycle.cycleDate ||
              r.followup.dateBasis !== c.nextCycle.dateBasis ||
              r.followup.caseId === caseId ||
              r.followup.taskId === r.taskId
            : r.followup !== null)
        )
          throw Error('Kayıt yanıtı gönderilen bilgilerle eşleşmedi. Yeniden kayıt gönderilmedi.');
        accepted = { ...accepted, result: r };
        setPending(accepted);
      }
      if (!accepted.result)
        throw Error(
          'Sunucu kaydı kabul etti ancak yanıt doğrulanamadı. Yeni kayıt göndermeden işlem kaydının kontrol edilmesi gerekiyor.',
        );
      const proof = salesLossResultSchema.parse(
        await readCustomerResource(
          `${base}/loss-operations/${encodeURIComponent(accepted.result.operationId)}`,
        ),
      );
      if (JSON.stringify(proof) !== JSON.stringify(accepted.result))
        throw Error('Kayıtlı sonuç eşleşmedi.');
      if (live.current) {
        setPending(null);
        setEditing(false);
        setNotes('');
        onRisk({ dirty: false, unresolved: false });
        onChanged();
      }
    } catch (e) {
      if (live.current) failure(e);
    } finally {
      saving.current = false;
      if (live.current) setBusy(false);
    }
  }
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (locked || conflict || denied || !context || !canOperate()) return;
    const when = canonicalOccurrence(due);
    if (!confirmed) {
      setError('Kapanış özetini onaylayın.');
      return;
    }
    if (
      mode === 'FOLLOW_UP' &&
      (!context.canCreateFollowup || !when || when <= new Date().toISOString())
    ) {
      setError('Yeni takip için yetki ve gelecekte bir takip zamanı gerekiyor.');
      return;
    }
    const parsed = salesLossCommandSchema.safeParse({
      expectedCaseVersion: context.caseVersion,
      expectedTaskId: context.taskId,
      expectedTaskVersion: context.taskVersion,
      lossReasonId: reason,
      notes: notes.trim() || null,
      nextCycle:
        mode === 'FOLLOW_UP'
          ? {
              mode,
              cycleDate: cycle || null,
              dateBasis: known ? 'KNOWN_END_DATE' : 'MANUAL',
              dueAt: when,
            }
          : { mode, exceptionCode: exception },
    });
    if (!parsed.success) {
      setError(
        'Nedeni ve takip bilgilerini kontrol edin. Takip açılmayacaksa istisna nedeni ve not zorunludur.',
      );
      return;
    }
    const a = { body: JSON.stringify(parsed.data), key: crypto.randomUUID() };
    setPending(a);
    void send(a);
  }
  function suggest() {
    if (!context || !validBirthDate(cycle)) {
      setError('Önce geçerli bir sonraki dönem tarihi girin.');
      return;
    }
    const date = new Date(cycle + 'T12:00:00Z');
    date.setUTCDate(date.getUTCDate() - context.renewalWindowDays);
    setDue(date.toISOString().slice(0, 10) + 'T09:00');
    setConfirmed(false);
    setError('');
  }
  return (
    <Card className="sales-loss">
      <CardHeader>
        <CardTitle>{result === 'LOST' ? 'Poliçelendirilmedi' : 'Çalışma sonucu'}</CardTitle>
      </CardHeader>
      <CardContent>
        {result === 'LOST' ? (
          <>
            {summary.loading && <p role="status">Sonuç yükleniyor…</p>}
            {(summary.error || (!summary.loading && !outcome.success)) && (
              <p role="alert">
                Kapanış bilgisi okunamadı.{' '}
                <Button type="button" variant="outline" onClick={summary.reload}>
                  Tekrar kontrol et
                </Button>
              </p>
            )}
            {outcome.success && (
              <div className="sales-loss-result">
                <strong>{outcome.data.reason}</strong>
                {outcome.data.notes && <p>{outcome.data.notes}</p>}
                <p>Kapanış: {interactionTime(outcome.data.closedAt)}</p>
                {outcome.data.followupCaseId ? (
                  <Button asChild variant="outline">
                    <Link to={`/sales-cases/${encodeURIComponent(outcome.data.followupCaseId)}`}>
                      Sonraki dönem takibini aç
                    </Link>
                  </Button>
                ) : (
                  <p>Gerekçeli istisna: bu çalışma için yeni takip açılmadı.</p>
                )}
              </div>
            )}
          </>
        ) : result === 'OPEN' ? (
          <>
            {!editing && (
              <>
                <p>
                  Müşteri hâlâ karar veriyorsa takip zamanını güncelleyin. Kesin olarak
                  yaptırmadıysa gerekçesiyle kapatın.
                </p>
                <Button
                  type="button"
                  variant="outline"
                  disabled={locked || !canOperate()}
                  aria-expanded={editing}
                  aria-controls={`${id}-form`}
                  onClick={() => void load()}
                >
                  Poliçelendirilmedi
                </Button>
              </>
            )}
            {editing && context && !denied && (
              <form
                id={`${id}-form`}
                aria-labelledby={`${id}-heading`}
                className="customer-edit-form sales-case-form"
                method="post"
                action={`${base}/close-lost`}
                onSubmit={submit}
                onChange={() => {
                  setConfirmed(false);
                  setError('');
                }}
              >
                <h3 id={`${id}-heading`} ref={heading} tabIndex={-1}>
                  Poliçelendirilmedi
                </h3>
                <fieldset disabled={locked || conflict || denied}>
                  <legend>Kapanış ve sonraki takip</legend>
                  <label htmlFor={`${id}-reason`}>Poliçelendirilmedi nedeni (zorunlu)</label>
                  <select
                    id={`${id}-reason`}
                    name="lossReasonId"
                    required
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                  >
                    <option value="">Neden seçin</option>
                    {context.lossReasons.map((r) => (
                      <option key={r.id} value={r.id}>
                        {r.name}
                      </option>
                    ))}
                  </select>
                  <label htmlFor={`${id}-notes`}>
                    Kısa not {mode === 'NO_FOLLOW_UP' ? '(zorunlu)' : '(isteğe bağlı)'}
                  </label>
                  <textarea
                    id={`${id}-notes`}
                    name="notes"
                    rows={3}
                    maxLength={500}
                    required={mode === 'NO_FOLLOW_UP'}
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                  />
                  <div className="sales-loss-choice">
                    <input
                      id={`${id}-yes`}
                      name="mode"
                      type="radio"
                      value="FOLLOW_UP"
                      checked={mode === 'FOLLOW_UP'}
                      onChange={() => setMode('FOLLOW_UP')}
                    />
                    <label htmlFor={`${id}-yes`}>Sonraki dönem tekrar takip et</label>
                  </div>
                  <div className="sales-loss-choice">
                    <input
                      id={`${id}-no`}
                      name="mode"
                      type="radio"
                      value="NO_FOLLOW_UP"
                      checked={mode === 'NO_FOLLOW_UP'}
                      onChange={() => setMode('NO_FOLLOW_UP')}
                    />
                    <label htmlFor={`${id}-no`}>Gerekçeli istisna: yeni takip açma</label>
                  </div>
                  {mode === 'FOLLOW_UP' ? (
                    <>
                      {!context.canCreateFollowup && (
                        <p role="note">
                          Yeni takip oluşturma yetkiniz yok veya branş aktif değil. Yetkili çalışan
                          bu işlemi tamamlayabilir.
                        </p>
                      )}
                      <label htmlFor={`${id}-cycle`}>Sonraki dönem tarihi (biliniyorsa)</label>
                      <input
                        id={`${id}-cycle`}
                        name="cycleDate"
                        type="date"
                        value={cycle}
                        onChange={(e) => setCycle(e.target.value)}
                      />
                      <div className="sales-loss-choice">
                        <input
                          id={`${id}-known`}
                          name="knownEnd"
                          type="checkbox"
                          checked={known}
                          onChange={(e) => setKnown(e.target.checked)}
                        />
                        <label htmlFor={`${id}-known`}>
                          Bu tarih müşterinin bilinen poliçe bitişidir
                        </label>
                      </div>
                      <Button type="button" variant="outline" onClick={suggest}>
                        Tarihe göre takip öner
                      </Button>
                      <label htmlFor={`${id}-due`}>
                        Tekrar aranacak zaman · İstanbul (zorunlu)
                      </label>
                      <input
                        id={`${id}-due`}
                        name="dueAt"
                        type="datetime-local"
                        required
                        value={due}
                        onChange={(e) => setDue(e.target.value)}
                        aria-describedby={`${id}-help`}
                      />
                      <p id={`${id}-help`}>
                        Yeni takip sizin iş listenize eklenir. Eski fiyatlar geçmişte kalır; yeni
                        döneme kopyalanmaz.
                      </p>
                    </>
                  ) : (
                    <>
                      <label htmlFor={`${id}-exception`}>Yeni takip açmama nedeni (zorunlu)</label>
                      <select
                        id={`${id}-exception`}
                        name="exceptionCode"
                        required
                        value={exception}
                        onChange={(e) => setException(e.target.value)}
                      >
                        <option value="">İstisna seçin</option>
                        <option value="NO_FURTHER_CONTACT">
                          Müşteri tekrar iletişim istemiyor
                        </option>
                        <option value="DUPLICATE">Mükerrer çalışma</option>
                        <option value="TECHNICAL_ERROR">Yanlış açılmış çalışma</option>
                      </select>
                      <p>
                        Bu seçim yalnız bu çalışmayı kapatır; diğer müşteri kayıtlarını değiştirmez.
                      </p>
                    </>
                  )}
                </fieldset>
                <div className="sales-loss-summary">
                  <strong>Kapanış özeti</strong>
                  <p>
                    Mevcut çalışma ve takip işi kapanacak.{' '}
                    {mode === 'FOLLOW_UP'
                      ? `Yeni takip: ${canonicalOccurrence(due) ? interactionTime(canonicalOccurrence(due)!) : 'Henüz seçilmedi'}.`
                      : 'Yeni takip oluşturulmayacak; gerekçeniz kaydedilecek.'}
                  </p>
                  <div className="sales-loss-choice">
                    <input
                      id={`${id}-confirm`}
                      name="confirm"
                      type="checkbox"
                      required
                      checked={confirmed}
                      disabled={locked || conflict || denied}
                      onChange={(e) => {
                        e.stopPropagation();
                        setConfirmed(e.target.checked);
                      }}
                    />
                    <label htmlFor={`${id}-confirm`}>Özeti kontrol ettim, kaydet</label>
                  </div>
                </div>
                <div className="customer-form-actions">
                  <Button type="submit" disabled={locked || conflict || denied}>
                    Sonucu ve takibi kaydet
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    disabled={locked}
                    onClick={() => {
                      setEditing(false);
                      setError('');
                    }}
                  >
                    Vazgeç
                  </Button>
                </div>
              </form>
            )}
          </>
        ) : null}
        {error && (
          <p ref={errorRef} tabIndex={-1} role="alert" className="customer-error">
            {error}
          </p>
        )}
        {busy && <p role="status">Kayıt kontrol ediliyor…</p>}
        {conflict && !pending && (
          <Button type="button" variant="outline" disabled={busy} onClick={() => void load()}>
            Taslağı koru, güncel kaydı kontrol et
          </Button>
        )}
        {denied && (
          <p>
            İşlem erişimi doğrulanamadı. Taslağınız korunuyor; yetkili oturumla yeniden kontrol
            edin.
          </p>
        )}
        {pending && (
          <Button
            type="button"
            variant="outline"
            disabled={busy || denied}
            onClick={() => void send(pending)}
          >
            {pending.serverAccepted ? 'Kayıtlı sonucu doğrula' : 'Aynı işlemi tekrar kontrol et'}
          </Button>
        )}
      </CardContent>
    </Card>
  );
}
