import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import {
  salesPriceEventCommandSchema,
  salesPriceEventContextSchema,
  salesPriceEventLabels,
  salesPriceEventPageSchema,
  salesPriceEventResultSchema,
  type SalesPriceEventCode,
  type SalesPriceEventResult,
} from '../../../shared/sales-price-events';
import type { SalesPriceRevision } from '../../../shared/sales-prices';
import type { ApiResponse } from '../../../shared/types';
import { Button } from '../../components/ui/button';
import { getCsrfToken, invalidateCsrfToken } from '../../csrf';
import {
  CustomerReadError,
  readCustomerResource,
  useCustomerResource,
} from '../customers/customer-resource';
import {
  canonicalOccurrence,
  interactionTime,
  localOccurrence,
} from '../today-work/interaction-model';

type Risk = { dirty: boolean; unresolved: boolean };
type Attempt = { body: string; key: string; result?: SalesPriceEventResult };
type EventContext = z.infer<typeof salesPriceEventContextSchema>;
export function SalesPriceEventsPanel({
  caseId,
  price,
  canWrite,
  canOperate,
  onRisk,
  onChanged,
  onClose,
}: {
  caseId: string;
  price: SalesPriceRevision;
  canWrite: boolean;
  canOperate: () => boolean;
  onRisk: (risk: Risk) => void;
  onChanged: () => void;
  onClose: () => void;
}) {
  const id = useId(),
    base = `/api/sales-cases/${encodeURIComponent(caseId)}`;
  const [cursor, setCursor] = useState<string | null>(null);
  const history = useCustomerResource<unknown>(
    `${base}/prices/${encodeURIComponent(price.priceId)}/revisions/${encodeURIComponent(price.revisionId)}/events?limit=20${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
  );
  const page = salesPriceEventPageSchema
    .refine((p) => p.events.every((e) => e.revisionId === price.revisionId))
    .safeParse(history.data);
  const [context, setContext] = useState<EventContext | null>(null),
    [editing, setEditing] = useState(false),
    [event, setEvent] = useState<SalesPriceEventCode>('SHARED');
  const [occurred, setOccurred] = useState(() => localOccurrence(new Date().toISOString())),
    [pending, setPending] = useState<Attempt | null>(null),
    [busy, setBusy] = useState(false),
    [conflict, setConflict] = useState(false),
    [error, setError] = useState(''),
    [message, setMessage] = useState('');
  const saving = useRef(false),
    live = useRef(true),
    errorRef = useRef<HTMLParagraphElement>(null),
    heading = useRef<HTMLHeadingElement>(null);
  const locked = busy || !!pending;
  useEffect(() => {
    live.current = true;
    heading.current?.focus();
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
  async function loadContext() {
    if (locked || !canOperate() || !canWrite) return;
    setBusy(true);
    setError('');
    try {
      const c = salesPriceEventContextSchema.parse(
        await readCustomerResource(
          `${base}/price-event-context/${encodeURIComponent(price.revisionId)}`,
        ),
      );
      if (c.revisionId !== price.revisionId) throw Error('Seçilen fiyat doğrulanamadı.');
      if (live.current) {
        setContext(c);
        setEditing(true);
        setConflict(false);
        setMessage('');
        if (!c.allowedEvents.includes(event)) setEvent(c.allowedEvents[0] ?? 'SHARED');
      }
    } catch (e) {
      if (live.current)
        setError(
          e instanceof CustomerReadError && [403, 404].includes(e.status)
            ? 'Durumu kaydetmek için bu çalışmanın gerçek takip görevine erişiminiz ve ilgili işlem yetkiniz gerekiyor.'
            : e instanceof Error
              ? e.message
              : 'Takip erişimi doğrulanamadı.',
        );
    } finally {
      if (live.current) setBusy(false);
    }
  }
  async function verify(a: Attempt) {
    if (saving.current) return;
    saving.current = true;
    setBusy(true);
    setError('');
    try {
      let accepted = a;
      if (!a.result) {
        const csrf = await getCsrfToken();
        const response = await fetch(`${base}/price-events`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': csrf,
            'idempotency-key': a.key,
          },
          body: a.body,
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
          ) {
            setPending(null);
            setConflict(true);
          }
          throw Error(!json.success ? json.error.message : 'Kayıt doğrulanamadı.');
        }
        const result = salesPriceEventResultSchema.parse(json.data),
          command = salesPriceEventCommandSchema.parse(JSON.parse(a.body));
        if (
          result.caseId !== caseId ||
          result.revisionId !== price.revisionId ||
          result.caseVersion !== command.expectedCaseVersion + 1 ||
          result.event !== command.event ||
          result.occurredAt !== command.occurredAt
        )
          throw Error('Kayıt sonucu seçilen fiyatla eşleşmedi.');
        accepted = { ...a, result };
        setPending(accepted);
      }
      const proof = salesPriceEventResultSchema.parse(
        await readCustomerResource(
          `${base}/price-event-operations/${encodeURIComponent(accepted.result!.operationId)}`,
        ),
      );
      if (JSON.stringify(proof) !== JSON.stringify(accepted.result))
        throw Error('Kayıtlı paylaşım / onay işlemi doğrulanamadı.');
      if (live.current) {
        setPending(null);
        setEditing(false);
        setContext(null);
        setConflict(false);
        setCursor(null);
        setMessage(`${salesPriceEventLabels[proof.event]} kaydı doğrulandı.`);
        history.reload();
        onChanged();
      }
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : 'Kayıt sonucu doğrulanamadı.');
    } finally {
      saving.current = false;
      if (live.current) setBusy(false);
    }
  }
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (locked || conflict || !context || !canOperate()) return;
    const occurredAt = canonicalOccurrence(occurred);
    if (!occurredAt || occurredAt > new Date().toISOString()) {
      setError('İşlem zamanını İstanbul saatine göre, gelecekte olmayacak şekilde girin.');
      return;
    }
    if (!context.allowedEvents.includes(event)) {
      setError('Güncel kayıtta yapılabilecek işlemi kontrol edin.');
      return;
    }
    const command = salesPriceEventCommandSchema.parse({
      expectedCaseVersion: context.caseVersion,
      revisionId: price.revisionId,
      event,
      occurredAt,
      expectedTaskId: context.taskId,
      expectedTaskVersion: context.taskVersion,
    });
    const a = { body: JSON.stringify(command), key: crypto.randomUUID() };
    setPending(a);
    void verify(a);
  }
  return (
    <section className="sales-price-history sales-price-events" aria-labelledby={id + '-title'}>
      <div className="customer-form-actions">
        <h3 id={id + '-title'} tabIndex={-1} ref={heading}>
          {price.insurerName} · Paylaşım / onay
        </h3>
        <Button variant="outline" disabled={locked || editing} onClick={onClose}>
          Paylaşımı kapat
        </Button>
      </div>
      <p>
        <strong>
          {new Intl.NumberFormat('tr-TR', { style: 'currency', currency: price.currency }).format(
            price.amountMinor / 100,
          )}
        </strong>{' '}
        · Bu fiyatın paylaşım ve müşteri onayı kayıtları
      </p>
      <p>
        Burada yalnız CRM kaydı tutulur. Müşteriye mesaj gönderilmez; poliçe veya tahsilat
        oluşturulmaz.
      </p>
      {message && <p role="status">{message}</p>}
      {error && (
        <p role="alert" tabIndex={-1} ref={errorRef}>
          {error}
        </p>
      )}
      {busy && <p role="status">Kayıt kontrol ediliyor…</p>}
      {pending && !busy && (
        <div className="policy-lifecycle-summary">
          <p>Sonuç kesinleşene kadar taslağı ve işlem anahtarını koruyoruz.</p>
          <Button onClick={() => void verify(pending)}>
            {pending.result ? 'Kaydı yeniden doğrula' : 'Aynı işlemi yeniden dene'}
          </Button>
        </div>
      )}
      {history.loading && <p role="status">Paylaşım geçmişi yükleniyor…</p>}
      {(history.error || (!history.loading && !page.success)) && (
        <Button variant="outline" disabled={locked} onClick={history.reload}>
          Paylaşım geçmişini yeniden yükle
        </Button>
      )}
      {page.success && (
        <>
          <ol className="sales-price-revisions">
            {page.data.events.map((e) => (
              <li key={e.eventId}>
                <strong>{salesPriceEventLabels[e.event]}</strong>
                <span>{interactionTime(e.occurredAt)}</span>
                <small>Kayıt zamanı: {interactionTime(e.createdAt)}</small>
              </li>
            ))}
          </ol>
          {!page.data.events.length && <p>Bu fiyat için henüz paylaşım veya onay kaydı yok.</p>}
          {(cursor || page.data.hasMore) && (
            <div className="customer-form-actions">
              <Button
                variant="outline"
                disabled={!cursor || locked}
                onClick={() => setCursor(null)}
              >
                İlk kayıtlar
              </Button>
              <Button
                variant="outline"
                disabled={!page.data.nextCursor || locked}
                onClick={() => setCursor(page.data.nextCursor)}
              >
                Önceki kayıtlar
              </Button>
            </div>
          )}
        </>
      )}
      {canWrite && !editing && (
        <Button disabled={locked || !canOperate()} onClick={() => void loadContext()}>
          Durumu kaydet
        </Button>
      )}
      {editing && context && (
        <form
          aria-labelledby={id + '-form'}
          action={`${base}/price-events`}
          method="post"
          onSubmit={submit}
          className="customer-edit-form sales-price-form"
        >
          <h4 id={id + '-form'}>Paylaşım / onay kaydı</h4>
          {conflict && (
            <div className="policy-lifecycle-summary">
              <p>
                Çalışma veya takip değişmiş. Girdiğiniz zaman korunuyor; kaydetmeden önce güncel
                durumu kontrol edin.
              </p>
              <Button variant="outline" disabled={locked} onClick={() => void loadContext()}>
                Taslağı koru, güncel durumu kontrol et
              </Button>
            </div>
          )}
          {!context.allowedEvents.length && (
            <p>
              Bu takipte şu an ekleyebileceğiniz bir onay işlemi yok. Takip erişiminizi ve görüşme
              kaydı yetkinizi kontrol edin.
            </p>
          )}
          <fieldset disabled={locked || conflict}>
            <legend>Gerçekleşen işlem</legend>
            {context.allowedEvents.map((code) => (
              <div className="sales-price-event-choice" key={code}>
                <input
                  id={id + code}
                  type="radio"
                  name="event"
                  value={code}
                  required
                  checked={event === code}
                  onChange={() => setEvent(code)}
                />
                <label htmlFor={id + code}>{salesPriceEventLabels[code]}</label>
              </div>
            ))}
            <label htmlFor={id + '-time'}>İşlem zamanı · İstanbul (zorunlu)</label>
            <input
              id={id + '-time'}
              type="datetime-local"
              name="occurredAt"
              step="1"
              required
              value={occurred}
              onChange={(e) => {
                setOccurred(e.target.value);
                setError('');
              }}
            />
          </fieldset>
          <div className="customer-form-actions">
            <Button type="submit" disabled={locked || conflict || !context.allowedEvents.length}>
              Kaydı onayla
            </Button>
            <Button
              variant="outline"
              disabled={locked}
              onClick={() => {
                setEditing(false);
                setContext(null);
                setError('');
                setConflict(false);
              }}
            >
              Vazgeç
            </Button>
          </div>
        </form>
      )}
    </section>
  );
}
