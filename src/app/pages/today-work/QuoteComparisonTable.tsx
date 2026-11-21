import type { QuoteHistory, QuoteRecord } from './quote-model';
import { quoteStatuses } from './quote-model';
import { policyDate, policyMoney } from '../policies/policy-display';
import { Button } from '../../components/ui/button';
import { QuotePriceHistory } from './QuotePriceHistory';

export function QuoteComparisonTable({
  data,
  renewalId,
  names,
  disabled,
  canRevise,
  onRevise,
}: {
  data: QuoteHistory;
  renewalId?: string;
  names: Record<string, string>;
  disabled: boolean;
  canRevise: boolean;
  onRevise: (quote: QuoteRecord) => void;
}) {
  return (
    <div className="quote-comparison-scroll">
      <table className="quote-comparison">
        <caption className="sr-only">Sigorta şirketlerinin güncel yenileme teklifleri</caption>
        <thead>
          <tr>
            <th>Sigorta şirketi / Ürün</th>
            <th>Dönem</th>
            <th>Prim</th>
            <th>Durum</th>
            <th>İşlem</th>
          </tr>
        </thead>
        <tbody>
          {data.quotes.map((quote, index) => {
            const current = quote.versions.find(
              (version) => version.id === quote.current_version_id,
            );
            const expired = current && Date.parse(current.valid_until) <= Date.now();
            return (
              <tr key={quote.id} aria-label={`Teklif ${index + 1} güncel özet`}>
                <td data-label="Şirket / Ürün">
                  <strong>
                    {current
                      ? (names[current.insurer_id] ?? 'Şirket adı mevcut değil')
                      : 'Güncel sürüm bilgisi bulunamadı'}
                  </strong>
                  <small>{current?.product_name ?? 'Ürün adı mevcut değil'}</small>
                </td>
                <td data-label="Dönem">
                  {current ? (
                    <>
                      {policyDate(current.start_date)}
                      <small>{policyDate(current.end_date)}</small>
                    </>
                  ) : (
                    '—'
                  )}
                </td>
                <td data-label="Prim" className="quote-comparison-price">
                  {current ? policyMoney(current.gross_premium_minor, current.currency) : '—'}
                </td>
                <td data-label="Durum">
                  <span
                    className="work-quote-status"
                    data-status={quote.status}
                    data-expired={!!expired}
                  >
                    {quoteStatuses[quote.status] ?? quote.status}
                  </span>
                  {quote.status === 'ACCEPTED' && <small>Kabul edilmiş teklif salt okunur.</small>}
                  {expired && <small>Bu sürümün geçerliliği sona erdi.</small>}
                </td>
                <td data-label="İşlem">
                  <div
                    className="quote-row-actions"
                    role="group"
                    aria-label={`${current ? (names[current.insurer_id] ?? 'Şirket') : 'Teklif'} işlemleri`}
                  >
                    {canRevise && quote.status !== 'ACCEPTED' && (
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={disabled || !current}
                        onClick={() => onRevise(quote)}
                        aria-label={`Teklif ${index + 1} için revizyon`}
                      >
                        Fiyatı güncelle
                      </Button>
                    )}
                    <QuotePriceHistory
                      quote={quote}
                      names={names}
                      renewalId={renewalId}
                      bounded={data.historyMode === 'SUMMARY'}
                    />
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
