import { useEffect, useState } from 'react';
import type { WonPriceOption, WonPriceOptions } from '../../../shared/renewal-won-price';
import { Button } from '../../components/ui/button';
import { readCustomerResource } from '../customers/customer-resource';
import { policyMoney } from '../policies/policy-display';

export function priceOptionKey(price: WonPriceOption) {
  return 'price:' + price.source.revisionId;
}

export function useWonPriceOptions(renewalId: string | undefined, salesCaseId?: string) {
  const [options, setOptions] = useState<WonPriceOption[]>([]);
  const [next, setNext] = useState<string | null>(null);
  const [page, setPage] = useState({ after: '' });
  const [failed, setFailed] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!renewalId && !salesCaseId) return;
    const controller = new AbortController();
    setFailed(false);
    setLoading(true);
    if (!page.after) {
      setOptions([]);
      setNext(null);
    }
    const root = salesCaseId
      ? `/api/sales-cases/${encodeURIComponent(salesCaseId)}/issue-price-options`
      : `/api/renewals/${encodeURIComponent(renewalId!)}/won-price-options`;
    void readCustomerResource<WonPriceOptions>(
      page.after ? root + '?after=' + encodeURIComponent(page.after) : root,
      controller.signal,
    )
      .then((data) => {
        if (controller.signal.aborted) return;
        if (!Array.isArray(data?.options)) throw Error('INVALID_PRICE_OPTIONS');
        setOptions((current) => (page.after ? [...current, ...data.options] : data.options));
        setNext(data.nextAfter);
      })
      .catch(() => {
        if (!controller.signal.aborted) setFailed(true);
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [renewalId, salesCaseId, page]);

  return {
    options,
    failed,
    loading,
    more: next ? () => setPage({ after: next }) : null,
    reload: () => setPage({ after: '' }),
  };
}

export function WonPriceChoices({ options }: { options: readonly WonPriceOption[] }) {
  if (!options.length) return null;
  return (
    <optgroup label="Müşterinin kabul ettiği fiyatlar">
      {options.map((price) => (
        <option key={priceOptionKey(price)} value={priceOptionKey(price)}>
          {price.insurerName} · {policyMoney(price.amountMinor, price.currency)}
        </option>
      ))}
    </optgroup>
  );
}

export function WonPriceOptionStatus({
  prices,
  reload,
}: {
  prices: ReturnType<typeof useWonPriceOptions>;
  reload: () => void;
}) {
  return (
    <>
      {prices.loading && <p role="status">Kabul edilen fiyatlar yükleniyor…</p>}
      {prices.failed && (
        <>
          <p role="alert">Kabul edilen fiyatlar okunamadı.</p>
          <Button type="button" variant="outline" onClick={reload}>
            Kabul edilen fiyatları yeniden oku
          </Button>
        </>
      )}
      {!prices.loading && !prices.failed && prices.more && (
        <Button type="button" variant="outline" onClick={prices.more}>
          Diğer kabul edilen fiyatlar
        </Button>
      )}
    </>
  );
}

export function priceDifferences(
  price: WonPriceOption,
  policy: { premium: bigint | null; currency: string; startDate: string; endDate: string },
) {
  return [
    policy.premium !== BigInt(price.amountMinor) ? 'Prim' : null,
    policy.currency !== price.currency ? 'Para birimi' : null,
    price.startDate && (policy.startDate !== price.startDate || policy.endDate !== price.endDate)
      ? 'Poliçe dönemi'
      : null,
  ].filter(Boolean);
}
