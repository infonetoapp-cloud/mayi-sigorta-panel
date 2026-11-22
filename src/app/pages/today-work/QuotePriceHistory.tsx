import { useState } from 'react';
import { z } from 'zod';
import { Button } from '../../components/ui/button';
import { useCustomerResource } from '../customers/customer-resource';
import { RecordDetails } from '../../components/workspace/RecordDetails';
import { policyDate, policyMoney } from '../policies/policy-display';
import { interactionTime } from './interaction-model';
import { quoteStatuses, type QuoteRecord } from './quote-model';

export function QuotePriceHistory({
  quote,
  names,
  renewalId,
  bounded = false,
}: {
  quote: QuoteRecord;
  names: Record<string, string>;
  renewalId?: string;
  bounded?: boolean;
}) {
  const current = quote.versions.find((v) => v.id === quote.current_version_id);
  const company = current
    ? (names[current.insurer_id] ?? 'Şirket adı belirtilmemiş')
    : 'Şirket bilgisi bulunmayan teklif';
  return (
    <RecordDetails title={`${company} · Fiyat geçmişi`} triggerLabel="Fiyat geçmişi" lazy>
      {bounded && renewalId ? (
        <BoundedPriceHistory renewalId={renewalId} quote={quote} names={names} />
      ) : (
        <PriceHistoryContent quote={quote} names={names} />
      )}
    </RecordDetails>
  );
}

const versionSchema = z.object({
  id: z.string().min(1),
  version_number: z.number().int().positive().safe(),
  insurer_id: z.string(),
  insurer_name: z.string().optional(),
  product_id: z.string(),
  product_name: z.string().optional(),
  branch_id: z.string(),
  payment_method_id: z.string(),
  start_date: z.iso.date(),
  end_date: z.iso.date(),
  valid_until: z.iso.datetime(),
  gross_premium_minor: z.number().int().nonnegative().safe(),
  currency: z.string().length(3),
  installment_count: z.number().int().nullable(),
  terms_summary: z.string().nullable(),
  created_at: z.iso.datetime().optional(),
});
const eventSchema = z.object({
  id: z.string().min(1),
  quote_version_id: z.string().nullable(),
  event: z.string().min(1),
  occurred_at: z.iso.datetime(),
  operation_receipt_id: z.string().nullable().optional(),
});
function BoundedPriceHistory({
  renewalId,
  quote,
  names,
}: {
  renewalId: string;
  quote: QuoteRecord;
  names: Record<string, string>;
}) {
  const [versionCursor, setVersionCursor] = useState<string | null>(null),
    [eventCursor, setEventCursor] = useState<string | null>(null);
  const root = `/api/renewals/${encodeURIComponent(renewalId)}/quotes/${encodeURIComponent(quote.id)}/history`;
  const versions = useCustomerResource<unknown>(
      `${root}?kind=versions&limit=20${versionCursor ? '&cursor=' + encodeURIComponent(versionCursor) : ''}`,
    ),
    events = useCustomerResource<unknown>(
      `${root}?kind=events&limit=20${eventCursor ? '&cursor=' + encodeURIComponent(eventCursor) : ''}`,
    );
  const page = (kind: 'versions' | 'events') =>
    z.object({
      quoteId: z.literal(quote.id),
      kind: z.literal(kind),
      items: z.array(kind === 'versions' ? versionSchema : eventSchema).max(50),
      hasMore: z.boolean(),
      nextCursor: z.string().max(1800).nullable(),
    });
  const vs = page('versions').safeParse(versions.data),
    es = page('events').safeParse(events.data);
  if (versions.loading || events.loading)
    return <p role="status">Fiyat ve işlem geçmişi yükleniyor…</p>;
  if (versions.error || events.error || !vs.success || !es.success)
    return (
      <div role="alert">
        <p>Geçmiş okunamadı. Kayıtlar değiştirilmedi.</p>
        <Button
          variant="outline"
          onClick={() => {
            versions.reload();
            events.reload();
          }}
        >
          Geçmişi yeniden yükle
        </Button>
        {(versionCursor || eventCursor) && (
          <Button
            variant="outline"
            onClick={() => {
              setVersionCursor(null);
              setEventCursor(null);
            }}
          >
            Geçmişin ilk sayfası
          </Button>
        )}
      </div>
    );
  const loaded = {
    ...quote,
    versions: vs.data.items as QuoteRecord['versions'],
    events: es.data.items as QuoteRecord['events'],
  };
  const labels = { ...names };
  for (const v of loaded.versions) if (v.insurer_name) labels[v.insurer_id] = v.insurer_name;
  return (
    <>
      <PriceHistoryContent
        quote={loaded}
        names={labels}
        summaryCurrent={quote.versions.find((v) => v.id === quote.current_version_id)}
      />
      <div className="customer-form-actions">
        <Button
          variant="outline"
          disabled={!versionCursor && !eventCursor}
          onClick={() => {
            setVersionCursor(null);
            setEventCursor(null);
          }}
        >
          Geçmişin ilk sayfası
        </Button>
        {vs.data.nextCursor && (
          <Button variant="outline" onClick={() => setVersionCursor(vs.data.nextCursor)}>
            Önceki fiyatlar
          </Button>
        )}
        {es.data.nextCursor && (
          <Button variant="outline" onClick={() => setEventCursor(es.data.nextCursor)}>
            Önceki işlemler
          </Button>
        )}
      </div>
    </>
  );
}
function PriceHistoryContent({
  quote,
  names,
  summaryCurrent,
}: {
  quote: QuoteRecord;
  names: Record<string, string>;
  summaryCurrent?: QuoteRecord['versions'][number];
}) {
  const current = quote.versions.find((v) => v.id === quote.current_version_id) ?? summaryCurrent;
  return (
    <>
      <p>
        {current?.product_name ?? 'Ürün bilgisi belirtilmemiş'} ·{' '}
        {quoteStatuses[quote.status] ?? 'Durum belirtilmemiş'}
      </p>
      <p>
        Bu teklif için {quote.versionCount ?? quote.versions.length} fiyat kaydı var. Fiyat
        güncellendiğinde önceki kayıt korunur.
      </p>
      <div className="quote-price-history">
        {[...quote.versions]
          .sort((a, b) => b.version_number - a.version_number)
          .map((version) => (
            <details key={version.id}>
              <summary>
                <strong>{policyMoney(version.gross_premium_minor, version.currency)}</strong>
                <span>{interactionTime(version.created_at) ?? 'Kayıt tarihi belirtilmemiş'}</span>
                <span className="quote-price-label">
                  {version.id === quote.accepted_version_id
                    ? 'Kabul edilen fiyat'
                    : version.id === quote.current_version_id
                      ? 'Güncel fiyat'
                      : 'Önceki fiyat'}
                </span>
              </summary>
              <dl className="today-task-facts">
                <div>
                  <dt>Şirket / ürün</dt>
                  <dd>
                    {names[version.insurer_id] ?? 'Şirket adı belirtilmemiş'} /{' '}
                    {version.product_name ?? 'Ürün adı belirtilmemiş'}
                  </dd>
                </div>
                <div>
                  <dt>Poliçe dönemi</dt>
                  <dd>
                    {policyDate(version.start_date)} — {policyDate(version.end_date)}
                  </dd>
                </div>
                <div>
                  <dt>Fiyatın geçerlilik sonu</dt>
                  <dd>{interactionTime(version.valid_until) ?? 'Belirtilmemiş'}</dd>
                </div>
                <div>
                  <dt>Ödeme</dt>
                  <dd>
                    {version.installment_count
                      ? `${version.installment_count} taksit`
                      : 'Taksit belirtilmemiş'}
                  </dd>
                </div>
              </dl>
              {version.terms_summary && <p className="interaction-note">{version.terms_summary}</p>}
            </details>
          ))}
      </div>
      {!!quote.events.length && (
        <>
          <h3>İşlem geçmişi</h3>
          <ul className="interaction-timeline">
            {quote.events.map((event) => {
              const price = quote.versions.find((version) => version.id === event.quote_version_id);
              return (
                <li key={event.id}>
                  {(
                    {
                      SENT: 'Gönderildi olarak kaydedildi',
                      ACCEPTED: 'Teklif kabul edildi',
                      REJECTED: 'Teklif reddedildi',
                      EXPIRED: 'Geçerlilik süresi doldu',
                    } as Record<string, string>
                  )[event.event] ?? 'Teklif durumu güncellendi'}{' '}
                  {price ? ` · ${policyMoney(price.gross_premium_minor, price.currency)}` : ''} ·{' '}
                  {interactionTime(event.occurred_at) ?? 'İşlem tarihi belirtilmemiş'}
                </li>
              );
            })}
          </ul>
        </>
      )}
    </>
  );
}
