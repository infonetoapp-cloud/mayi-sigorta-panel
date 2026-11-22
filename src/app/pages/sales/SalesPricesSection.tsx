import { SalesPriceEventsPanel } from './SalesPriceEventsPanel';
import { salesPriceEventLabels } from '../../../shared/sales-price-events';
import { useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import {
  salesPricePageSchema,
  salesPriceHistorySchema,
  salesPriceRevisionSchema,
  salesPriceResultSchema,
  salesPriceCreateSchema,
  salesPriceReviseSchema,
  type SalesPriceRevision,
  type SalesPriceCommandResult,
} from '../../../shared/sales-prices';
import type { ApiResponse } from '../../../shared/types';
import type { SalesCaseDto } from '../../../shared/sales';
import { Button } from '../../components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '../../components/ui/card';
import { CustomerNumberGuard } from '../customers/CustomerNumberGuard';
import { useCustomerResource, readCustomerResource } from '../customers/customer-resource';
import { getCsrfToken, invalidateCsrfToken } from '../../csrf';
export type PriceRisk = { dirty: boolean; unresolved: boolean };
type Draft = { price: SalesPriceRevision | null; caseVersion: number };
type Attempt = {
  body: string;
  key: string;
  priceId: string | null;
  result?: SalesPriceCommandResult;
};
const insurerSchema = z
  .array(
    z
      .object({
        id: z.string().min(1),
        name: z.string().min(1),
        status: z.enum(['ACTIVE', 'INACTIVE']),
      })
      .passthrough(),
  )
  .max(1000);
const formatAmount = (minor: number) => {
  const value = BigInt(minor);
  return `${value / 100n},${String(value % 100n).padStart(2, '0')}`;
};
export function priceMinor(value: string): number | null {
  let amount = value.trim();
  if (amount.length > 24) return null;
  if (amount.includes(',')) {
    if (!/^(?:\d+|\d{1,3}(?:\.\d{3})+),\d{1,2}$/.test(amount)) return null;
    amount = amount.replaceAll('.', '').replace(',', '.');
  } else if (/^\d{1,3}(?:\.\d{3})+$/.test(amount)) amount = amount.replaceAll('.', '');
  if (!/^\d+(?:\.\d{1,2})?$/.test(amount)) return null;
  const [whole, decimal = ''] = amount.split('.');
  const minor = BigInt(whole!) * 100n + BigInt(decimal.padEnd(2, '0'));
  return minor <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(minor) : null;
}
const money = (value: number, currency: string) =>
  new Intl.NumberFormat('tr-TR', { style: 'currency', currency }).format(value / 100);
const when = (value: string) =>
  new Intl.DateTimeFormat('tr-TR', {
    timeZone: 'Europe/Istanbul',
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(value));
const date = (value: string) =>
  new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', dateStyle: 'medium' }).format(
    new Date(value + 'T12:00:00Z'),
  );
const ignoreEventRisk = () => {};
const quoteStatus = {
  DRAFT: 'Taslak',
  READY: 'Hazır',
  SENT: 'İletildi',
  ACCEPTED: 'Kabul edildi',
  REJECTED: 'Reddedildi',
  EXPIRED: 'Geçerliliği doldu',
};
function History({
  caseId,
  price,
  onClose,
}: {
  caseId: string;
  price: SalesPriceRevision;
  onClose: () => void;
}) {
  const [cursor, setCursor] = useState<string | null>(null);
  const [eventRevision, setEventRevision] = useState<SalesPriceRevision | null>(null);
  const read = useCustomerResource<unknown>(
    `/api/sales-cases/${encodeURIComponent(caseId)}/prices/${encodeURIComponent(price.priceId)}/history?limit=20${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`,
  );
  const decoded = salesPriceHistorySchema.safeParse(read.data);
  return (
    <section className="sales-price-history" aria-label={`${price.insurerName} fiyat geçmişi`}>
      <div className="customer-form-actions">
        <h3>{price.insurerName} · Fiyat geçmişi</h3>
        <Button variant="outline" onClick={onClose}>
          Geçmişi kapat
        </Button>
      </div>
      {read.loading && <p role="status">Fiyat geçmişi yükleniyor…</p>}
      {(read.error || (!read.loading && !decoded.success)) && (
        <div role="alert">
          <p>Geçmiş okunamadı. Kayıtlar değiştirilmedi.</p>
          <Button onClick={read.reload} variant="outline">
            Geçmişi yeniden yükle
          </Button>
          {cursor && (
            <Button variant="outline" onClick={() => setCursor(null)}>
              Geçmişin ilk sayfası
            </Button>
          )}
        </div>
      )}
      {eventRevision && (
        <SalesPriceEventsPanel
          key={eventRevision.revisionId}
          caseId={caseId}
          price={eventRevision}
          canWrite={false}
          canOperate={() => false}
          onRisk={ignoreEventRisk}
          onChanged={ignoreEventRisk}
          onClose={() => setEventRevision(null)}
        />
      )}
      {decoded.success && (
        <>
          <ol className="sales-price-revisions">
            {decoded.data.revisions.map((v) => (
              <li key={v.revisionId}>
                <strong>{money(v.amountMinor, v.currency)}</strong>
                <span>{when(v.createdAt)}</span>
                <Button variant="outline" onClick={() => setEventRevision(v)}>
                  Bu fiyatın paylaşım geçmişi
                </Button>
                {v.termsNote && <p>{v.termsNote}</p>}
                {v.offeredPeriod && (
                  <p>
                    Teklif dönemi: {date(v.offeredPeriod.startDate)} –{' '}
                    {date(v.offeredPeriod.endDate)}
                  </p>
                )}
              </li>
            ))}
          </ol>
          <div className="customer-form-actions">
            <Button variant="outline" disabled={!cursor} onClick={() => setCursor(null)}>
              Geçmişin ilk sayfası
            </Button>
            <Button
              variant="outline"
              disabled={!decoded.data.nextCursor}
              onClick={() => setCursor(decoded.data.nextCursor)}
            >
              Önceki fiyatlar
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
export function SalesPricesSection({
  caseId,
  caseVersion,
  active = true,
  canOperate = () => true,
  onRisk,
  onChanged,
}: {
  caseId: string;
  caseVersion: number;
  active?: boolean;
  canOperate?: () => boolean;
  onRisk?: (r: PriceRisk) => void;
  onChanged?: () => void;
}) {
  const base = `/api/sales-cases/${encodeURIComponent(caseId)}`;
  const tableId = useId(),
    formId = useId();
  const [cursor, setCursor] = useState<string | null>(null),
    [draft, setDraft] = useState<Draft | null>(null),
    [history, setHistory] = useState<SalesPriceRevision | null>(null);
  const [eventPrice, setEventPrice] = useState<SalesPriceRevision | null>(null);
  const [eventRisk, setEventRisk] = useState<PriceRisk>({ dirty: false, unresolved: false });
  const eventBlocked = eventRisk.dirty || eventRisk.unresolved;
  const [insurer, setInsurer] = useState(''),
    [amount, setAmount] = useState(''),
    [currency, setCurrency] = useState('TRY'),
    [terms, setTerms] = useState(''),
    [start, setStart] = useState(''),
    [end, setEnd] = useState('');
  const [pending, setPending] = useState<Attempt | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [conflict, setConflict] = useState(false),
    [message, setMessage] = useState('');
  const read = useCustomerResource<unknown>(
      active
        ? `${base}/prices?limit=20${cursor ? '&cursor=' + encodeURIComponent(cursor) : ''}`
        : null,
    ),
    page = salesPricePageSchema.safeParse(read.data);
  const catalogs = useCustomerResource<unknown>(
      draft && !draft.price ? '/api/catalogs/insurers' : null,
    ),
    insurers = insurerSchema.safeParse(catalogs.data);
  const saving = useRef(false),
    live = useRef(true),
    errorRef = useRef<HTMLParagraphElement>(null),
    formHeading = useRef<HTMLHeadingElement>(null);
  const locked = busy || !!pending;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => {
    onRisk?.({ dirty: !!draft || eventRisk.dirty, unresolved: locked || eventRisk.unresolved });
  }, [draft, locked, eventRisk, onRisk]);
  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);
  useEffect(() => {
    if (draft) formHeading.current?.focus();
  }, [draft]);
  function open(price: SalesPriceRevision | null) {
    if (locked || eventBlocked || !canOperate() || !page.success || !page.data.canManage) return;
    setDraft({ price, caseVersion });
    setInsurer(price?.insurerId ?? '');
    setAmount(price ? formatAmount(price.amountMinor) : '');
    setCurrency(price?.currency ?? 'TRY');
    setTerms(price?.termsNote ?? '');
    setStart(price?.offeredPeriod?.startDate ?? '');
    setEnd(price?.offeredPeriod?.endDate ?? '');
    setError('');
    setMessage('');
    setConflict(false);
    setHistory(null);
    setEventPrice(null);
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
        const response = await fetch(
          a.priceId
            ? `${base}/prices/${encodeURIComponent(a.priceId)}/revisions`
            : `${base}/prices`,
          {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'x-csrf-token': csrf,
              'idempotency-key': a.key,
            },
            body: a.body,
          },
        );
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
          throw Error(!json.success ? json.error.message : 'Fiyat kaydı doğrulanamadı.');
        }
        const result = salesPriceResultSchema.parse(json.data),
          command = JSON.parse(a.body) as {
            expectedCaseVersion: number;
            expectedPriceVersion?: number;
          };
        if (
          result.caseId !== caseId ||
          result.caseVersion !== command.expectedCaseVersion + 1 ||
          result.priceVersion !== (command.expectedPriceVersion ?? 0) + 1 ||
          result.revisionNumber !== result.priceVersion ||
          (a.priceId && result.priceId !== a.priceId)
        )
          throw Error('Kayıt sonucu seçilen fiyatla eşleşmedi.');
        accepted = { ...a, result };
        setPending(accepted);
      }
      const result = accepted.result!;
      const proof = salesPriceResultSchema.parse(
        await readCustomerResource(
          `${base}/price-operations/${encodeURIComponent(result.operationId)}`,
        ),
      );
      if (JSON.stringify(proof) !== JSON.stringify(result))
        throw Error('Kayıtlı fiyat işlemi doğrulanamadı.');
      const revision = salesPriceRevisionSchema.parse(
        await readCustomerResource(
          `${base}/prices/${encodeURIComponent(result.priceId)}/revisions/${encodeURIComponent(result.revisionId)}`,
        ),
      );
      const command = JSON.parse(a.body) as {
        amountMinor: number;
        currency: string;
        termsNote: string | null;
        offeredPeriod: unknown;
        insurerId?: string;
      };
      if (
        revision.priceId !== result.priceId ||
        revision.revisionId !== result.revisionId ||
        revision.priceVersion !== result.priceVersion ||
        revision.revisionNumber !== result.revisionNumber ||
        revision.amountMinor !== command.amountMinor ||
        revision.currency !== command.currency ||
        revision.termsNote !== command.termsNote ||
        JSON.stringify(revision.offeredPeriod) !== JSON.stringify(command.offeredPeriod) ||
        (command.insurerId && revision.insurerId !== command.insurerId)
      )
        throw Error('Kaydedilen fiyat bilgileri eşleşmedi.');
      if (live.current) {
        setPending(null);
        setDraft(null);
        setCursor(null);
        setConflict(false);
        setMessage('Şirket fiyatı kaydedildi.');
        read.reload();
        onChanged?.();
      }
    } catch (e) {
      if (live.current) setError(e instanceof Error ? e.message : 'Fiyat doğrulanamadı.');
    } finally {
      saving.current = false;
      if (live.current) setBusy(false);
    }
  }
  function submit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!draft || locked || conflict || !canOperate()) return;
    const minor = priceMinor(amount);
    if (minor === null) {
      setError('Tutarı örneğin 12.500,50 biçiminde, en fazla iki ondalıkla girin.');
      return;
    }
    const common = {
      expectedCaseVersion: draft.caseVersion,
      amountMinor: minor,
      currency,
      termsNote: terms.trim() || null,
      offeredPeriod: start || end ? { startDate: start, endDate: end } : null,
    };
    const command = draft.price
      ? { ...common, expectedPriceVersion: draft.price.priceVersion }
      : { ...common, insurerId: insurer };
    const checked = (draft.price ? salesPriceReviseSchema : salesPriceCreateSchema).safeParse(
      command,
    );
    if (!checked.success) {
      setError('Şirketi, para birimini ve varsa teklif döneminin iki tarihini kontrol edin.');
      return;
    }
    const a = {
      body: JSON.stringify(checked.data),
      key: crypto.randomUUID(),
      priceId: draft.price?.priceId ?? null,
    };
    setPending(a);
    void verify(a);
  }
  async function refreshDraft() {
    if (!draft || locked) return;
    setError('');
    setBusy(true);
    try {
      const fresh = await readCustomerResource<SalesCaseDto>(base);
      const latest = salesPricePageSchema.parse(
        await readCustomerResource(`${base}/prices?limit=20`),
      );
      if (fresh.id !== caseId || !Number.isSafeInteger(fresh.version) || !latest.canManage)
        throw Error('Fiyat güncelleme erişimi doğrulanamadı.');
      let price = draft.price;
      if (price) {
        const found = latest.items.find(
          (v) => v.source === 'PRICE_REVISION' && v.priceId === price!.priceId,
        );
        if (!found || found.source !== 'PRICE_REVISION')
          throw Error(
            'Fiyat bu sayfada bulunamadı. Formu kapatıp fiyatı güncel listeden yeniden seçin.',
          );
        price = found;
      }
      setDraft({ price, caseVersion: fresh.version });
      setConflict(false);
      read.reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Güncel fiyat okunamadı.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card className="sales-prices">
      <CardHeader>
        <CardTitle>
          <span id={tableId}>Şirket fiyatları</span>
        </CardTitle>
      </CardHeader>
      <CardContent>
        <CustomerNumberGuard
          protectSearch
          dirty={!!draft || eventRisk.dirty}
          unresolved={locked || eventRisk.unresolved}
          label="Şirket fiyatı"
        />
        <p>Şirketi seçin, fiyatı girin. Fiyat güncellemeleri geçmişte saklanır.</p>
        {message && (
          <p role="status" className="sales-price-success">
            {message}
          </p>
        )}
        {read.loading && <p role="status">Şirket fiyatları yükleniyor…</p>}
        {(read.error || (!read.loading && active && !page.success)) && (
          <div role="alert">
            <p>Şirket fiyatları okunamadı. Kayıtlar değiştirilmedi.</p>
            <Button variant="outline" disabled={locked || eventBlocked} onClick={read.reload}>
              Fiyatları yeniden yükle
            </Button>
            {cursor && (
              <Button
                variant="outline"
                disabled={locked || eventBlocked}
                onClick={() => setCursor(null)}
              >
                İlk sayfaya dön
              </Button>
            )}
          </div>
        )}
        {error && (
          <p role="alert" tabIndex={-1} ref={errorRef} className="customer-error">
            {error}
          </p>
        )}
        {pending && (
          <div className="policy-lifecycle-summary">
            <p>Fiyat kaydı doğrulanana kadar bilgiler korunuyor.</p>
            <Button disabled={busy} onClick={() => void verify(pending)}>
              {pending.result ? 'Kayıtlı fiyatı doğrula' : 'Aynı fiyat kaydını tekrar kontrol et'}
            </Button>
          </div>
        )}
        {busy && <p role="status">Fiyat kaydı kontrol ediliyor…</p>}
        {page.success && (
          <>
            <div className="customer-form-actions">
              {!draft && page.data.canManage && (
                <Button
                  disabled={locked || eventBlocked || !canOperate()}
                  onClick={() => open(null)}
                >
                  Şirket fiyatı ekle
                </Button>
              )}
              <Button
                variant="outline"
                disabled={!!draft || locked || eventBlocked}
                onClick={read.reload}
              >
                Fiyatları yenile
              </Button>
            </div>
            {!page.data.items.length && <p>Henüz şirket fiyatı girilmedi.</p>}
            {!!page.data.items.length && (
              <div
                className="sales-price-table-wrap"
                role="region"
                aria-labelledby={tableId}
                tabIndex={0}
              >
                <table className="sales-price-table">
                  <caption className="sr-only">Sigorta şirketlerinin kayıtlı fiyatları</caption>
                  <thead>
                    <tr>
                      <th scope="col">Sigorta şirketi</th>
                      <th scope="col">Fiyat</th>
                      <th scope="col">Bilgi</th>
                      <th scope="col">İşlem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {page.data.items.map((row) => (
                      <tr
                        key={
                          row.source === 'PRICE_REVISION'
                            ? `price:${row.priceId}`
                            : `quote:${row.quoteId}`
                        }
                      >
                        <th scope="row">
                          <strong>{row.insurerName}</strong>
                          <span className="sales-price-source">
                            {row.source === 'PRICE_REVISION' ? 'Fiyat kaydı' : 'Kayıtlı teklif'}
                          </span>
                        </th>
                        <td data-label="Fiyat">
                          <strong className="sales-price-amount">
                            {money(row.amountMinor, row.currency)}
                          </strong>
                        </td>
                        <td data-label="Bilgi">
                          {row.source === 'QUOTE_VERSION' ? (
                            <span className="sales-price-badge">
                              {quoteStatus[row.quoteStatus]}
                            </span>
                          ) : (
                            <>
                              <span
                                className={
                                  'sales-price-badge sales-price-state-' +
                                  (row.eventState ?? 'NOT_SHARED').toLowerCase()
                                }
                              >
                                {row.eventState && row.eventState !== 'NOT_SHARED'
                                  ? salesPriceEventLabels[row.eventState]
                                  : 'Henüz iletilmedi'}
                              </span>
                              <small className="sales-price-source">
                                Fiyat kaydı: {when(row.createdAt)}
                              </small>
                            </>
                          )}
                          {row.termsNote && <p>{row.termsNote}</p>}
                          {row.source === 'PRICE_REVISION' && row.offeredPeriod && (
                            <p>
                              {date(row.offeredPeriod.startDate)} –{' '}
                              {date(row.offeredPeriod.endDate)}
                            </p>
                          )}
                        </td>
                        <td data-label="İşlem">
                          <div className="sales-price-actions">
                            {row.source === 'PRICE_REVISION' ? (
                              <>
                                {page.data.canManage && (
                                  <Button
                                    variant="outline"
                                    disabled={!!draft || locked || eventBlocked || !canOperate()}
                                    onClick={() => open(row)}
                                  >
                                    Fiyatı güncelle
                                  </Button>
                                )}
                                <Button
                                  variant="outline"
                                  disabled={locked || eventBlocked}
                                  onClick={() => setHistory(row)}
                                >
                                  Fiyat geçmişi
                                </Button>
                                <Button
                                  variant="outline"
                                  disabled={!!draft || locked || eventBlocked}
                                  onClick={() => {
                                    setEventPrice(row);
                                    setHistory(null);
                                  }}
                                >
                                  Paylaşım / onay
                                </Button>
                              </>
                            ) : (
                              <span>Kayıtlı teklifin onay ve poliçe bağlantısı korunur.</span>
                            )}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
            {(cursor || page.data.hasMore) && (
              <div className="customer-form-actions">
                <Button
                  variant="outline"
                  disabled={!cursor || !!draft || locked || eventBlocked}
                  onClick={() => setCursor(null)}
                >
                  Fiyatların ilk sayfası
                </Button>
                <Button
                  variant="outline"
                  disabled={!page.data.nextCursor || !!draft || locked || eventBlocked}
                  onClick={() => setCursor(page.data.nextCursor)}
                >
                  Diğer şirket fiyatları
                </Button>
              </div>
            )}
          </>
        )}
        {draft && (
          <form
            className="customer-edit-form sales-case-form sales-price-form"
            aria-label={draft.price ? 'Şirket fiyatını güncelle' : 'Şirket fiyatı ekle'}
            action={
              draft.price
                ? `${base}/prices/${encodeURIComponent(draft.price.priceId)}/revisions`
                : `${base}/prices`
            }
            method="post"
            onSubmit={submit}
          >
            <h3 tabIndex={-1} ref={formHeading}>
              {draft.price ? `${draft.price.insurerName} · Fiyatı güncelle` : 'Şirket fiyatı ekle'}
            </h3>
            {conflict && (
              <div className="policy-lifecycle-summary">
                <p>Başka bir işlem çalışma veya fiyatı değiştirmiş. Girdiğiniz tutar korunuyor.</p>
                <Button
                  variant="outline"
                  disabled={locked || eventBlocked}
                  onClick={() => void refreshDraft()}
                >
                  Taslağı koru, güncel fiyatı kontrol et
                </Button>
              </div>
            )}
            <fieldset disabled={locked || conflict}>
              <legend>Fiyat bilgileri</legend>
              {!draft.price && (
                <>
                  {catalogs.loading && <p role="status">Sigorta şirketleri yükleniyor…</p>}
                  {catalogs.error && (
                    <p role="alert">
                      Şirketler okunamadı.{' '}
                      <Button variant="outline" onClick={catalogs.reload}>
                        Şirketleri yeniden yükle
                      </Button>
                    </p>
                  )}
                  <label htmlFor={formId + '-insurer'}>Sigorta şirketi (zorunlu)</label>
                  <select
                    id={formId + '-insurer'}
                    name="insurerId"
                    required
                    value={insurer}
                    onChange={(e) => setInsurer(e.target.value)}
                  >
                    <option value="">Şirket seçin</option>
                    {insurers.success &&
                      insurers.data
                        .filter((i) => i.status === 'ACTIVE')
                        .map((i) => (
                          <option key={i.id} value={i.id}>
                            {i.name}
                          </option>
                        ))}
                  </select>
                </>
              )}
              <div className="sales-price-money-fields">
                <div>
                  <label htmlFor={formId + '-amount'}>Fiyat (zorunlu)</label>
                  <input
                    id={formId + '-amount'}
                    name="amount"
                    type="text"
                    inputMode="decimal"
                    required
                    maxLength={24}
                    value={amount}
                    aria-describedby={formId + '-hint'}
                    onChange={(e) => {
                      setAmount(e.target.value);
                      setError('');
                    }}
                  />
                  <small id={formId + '-hint'}>Örnek: 12.500,50</small>
                </div>
                <div>
                  <label htmlFor={formId + '-currency'}>Para birimi</label>
                  <select
                    id={formId + '-currency'}
                    name="currency"
                    required
                    value={currency}
                    onChange={(e) => setCurrency(e.target.value)}
                  >
                    {[...new Set(['TRY', 'USD', 'EUR', currency])].map((c) => (
                      <option key={c} value={c}>
                        {c === 'TRY' ? 'TL' : c}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <details>
                <summary>Koşul veya farklı teklif dönemi ekle (isteğe bağlı)</summary>
                <label htmlFor={formId + '-terms'}>Kısa koşul notu</label>
                <textarea
                  id={formId + '-terms'}
                  name="termsNote"
                  maxLength={1000}
                  rows={3}
                  value={terms}
                  onChange={(e) => setTerms(e.target.value)}
                />
                <div className="sales-price-money-fields">
                  <div>
                    <label htmlFor={formId + '-start'}>Teklif dönemi başlangıcı</label>
                    <input
                      id={formId + '-start'}
                      name="startDate"
                      type="date"
                      value={start}
                      onChange={(e) => setStart(e.target.value)}
                    />
                  </div>
                  <div>
                    <label htmlFor={formId + '-end'}>Teklif dönemi bitişi</label>
                    <input
                      id={formId + '-end'}
                      name="endDate"
                      type="date"
                      value={end}
                      onChange={(e) => setEnd(e.target.value)}
                    />
                  </div>
                </div>
                <small>
                  Yalnız şirket teklifinde farklı bir dönem belirtilmişse iki tarihi birlikte girin.
                </small>
              </details>
            </fieldset>
            <div className="customer-form-actions">
              <Button type="submit" disabled={locked || conflict}>
                Fiyatı kaydet
              </Button>
              <Button
                variant="outline"
                disabled={locked || eventBlocked}
                onClick={() => {
                  setDraft(null);
                  setError('');
                  setConflict(false);
                }}
              >
                Vazgeç
              </Button>
            </div>
          </form>
        )}
        {eventPrice && (
          <SalesPriceEventsPanel
            key={eventPrice.revisionId}
            caseId={caseId}
            price={eventPrice}
            canWrite={page.success && page.data.canManage}
            canOperate={() => !draft && !locked && canOperate()}
            onRisk={setEventRisk}
            onChanged={() => {
              onRisk?.({ dirty: false, unresolved: false });
              read.reload();
              onChanged?.();
            }}
            onClose={() => setEventPrice(null)}
          />
        )}
        {history && (
          <History
            key={history.priceId}
            caseId={caseId}
            price={history}
            onClose={() => setHistory(null)}
          />
        )}
      </CardContent>
    </Card>
  );
}
