import { useEffect, useId, useState } from 'react';
import type { IssuePolicyContext } from '../../../shared/sales-issued-policy';
import type { WonPriceOption } from '../../../shared/renewal-won-price';
import type { PolicyListResponseData } from '../../../shared/types';
import { Button } from '../../components/ui/button';
import { useCustomerResource } from '../customers/customer-resource';
import { policyDate, policyMoney } from '../policies/policy-display';
import {
  priceDifferences,
  priceOptionKey,
  useWonPriceOptions,
  WonPriceChoices,
  WonPriceOptionStatus,
} from '../today-work/won-price-options';

export interface LinkReview {
  policyId: string;
  policyVersion: number;
  price?: WonPriceOption;
  noQuoteReason?: string;
  differenceReasonCode?: string;
}

export function SalesLinkPolicyForm({
  context,
  disabled,
  revision,
  onSubmit,
}: {
  context: IssuePolicyContext;
  disabled: boolean;
  revision: number;
  onSubmit: (review: LinkReview) => void;
}) {
  const id = useId();
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [cursor, setCursor] = useState<string | null>(null);
  const [policyId, setPolicyId] = useState('');
  const [selection, setSelection] = useState('');
  const [noQuoteReason, setNoQuoteReason] = useState('');
  const [difference, setDifference] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [error, setError] = useState('');
  const prices = useWonPriceOptions(undefined, context.caseId);
  const searchParams = new URLSearchParams({
    customerId: context.customerId,
    status: 'ACTIVE',
    pageSize: '20',
  });
  if (query) searchParams.set('search', query);
  if (cursor) searchParams.set('cursor', cursor);
  const policies = useCustomerResource<PolicyListResponseData>('/api/policies?' + searchParams);
  const eligible = (policies.data?.items ?? []).filter(
    (p) =>
      p.customerId === context.customerId &&
      p.branchId === context.branchId &&
      p.status === 'ACTIVE' &&
      p.archivedAt === null,
  );
  const policy = eligible.find((p) => p.id === policyId);
  const options = prices.options.filter(
    (p) => p.insurerId === policy?.insurerId && p.branchId === context.branchId,
  );
  const price = options.find((p) => priceOptionKey(p) === selection);
  const changes =
    policy && price
      ? priceDifferences(price, {
          premium: BigInt(policy.grossPremiumMinor),
          currency: policy.currency,
          startDate: policy.startDate,
          endDate: policy.endDate,
        })
      : [];
  useEffect(() => {
    if (!revision) return;
    setSelection('');
    setConfirmed(false);
    prices.reload();
    policies.reload();
  }, [revision]);
  useEffect(() => {
    if (disabled) setConfirmed(false);
  }, [disabled]);

  return (
    <form
      className="issue-policy-form"
      aria-label="Mevcut poliçeyi bağla"
      onSubmit={(e) => {
        e.preventDefault();
        if (disabled) return;
        if (
          !policy ||
          (!price && (selection !== 'NONE' || !noQuoteReason.trim())) ||
          (changes.length && !difference) ||
          !confirmed
        ) {
          setError(
            'Poliçeyi ve teklif kaynağını seçin, gerekli nedenleri yazıp bilgileri onaylayın.',
          );
          return;
        }
        setError('');
        onSubmit({
          policyId: policy.id,
          policyVersion: policy.version,
          ...(price ? { price } : { noQuoteReason: noQuoteReason.trim() }),
          ...(changes.length ? { differenceReasonCode: difference } : {}),
        });
      }}
    >
      <fieldset disabled={disabled}>
        <legend>Bağlanacak poliçe</legend>
        <label htmlFor={id + '-search'}>Poliçe numarasıyla ara</label>
        <input
          id={id + '-search'}
          value={search}
          maxLength={100}
          onChange={(e) => setSearch(e.target.value)}
        />
        <div className="customer-form-actions">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              setQuery(search.trim());
              setCursor(null);
              setPolicyId('');
              setSelection('');
              setConfirmed(false);
            }}
          >
            Poliçeleri ara
          </Button>
          {cursor && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setCursor(null);
                setPolicyId('');
                setSelection('');
                setConfirmed(false);
              }}
            >
              İlk sayfa
            </Button>
          )}
          {policies.data?.nextCursor && (
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                setCursor(policies.data?.nextCursor ?? null);
                setPolicyId('');
                setSelection('');
                setConfirmed(false);
              }}
            >
              Diğer poliçeler
            </Button>
          )}
        </div>
        {policies.loading && <p role="status">Poliçeler yükleniyor…</p>}
        {policies.error && (
          <Button type="button" variant="outline" onClick={policies.reload}>
            Poliçe listesini yeniden yükle
          </Button>
        )}
        {policies.data && !eligible.length && (
          <p>Bu sayfada müşterinin aynı branşta aktif poliçesi bulunamadı.</p>
        )}
        <label htmlFor={id + '-policy'}>Mevcut poliçe *</label>
        <select
          id={id + '-policy'}
          required
          value={policyId}
          onChange={(e) => {
            setPolicyId(e.target.value);
            setSelection('');
            setDifference('');
            setConfirmed(false);
            setError('');
          }}
        >
          <option value="" disabled>
            Poliçe seçin
          </option>
          {eligible.map((p) => (
            <option value={p.id} key={p.id}>
              {p.policyNumber} · {policyDate(p.endDate)}
            </option>
          ))}
        </select>
        {policy && (
          <>
            <p className="issue-help">
              {policyDate(policy.startDate)} – {policyDate(policy.endDate)} ·{' '}
              {policyMoney(policy.grossPremiumMinor, policy.currency)}
            </p>
            <label htmlFor={id + '-source'}>Kayıtlı teklif *</label>
            <select
              id={id + '-source'}
              required
              value={selection}
              onChange={(e) => {
                setSelection(e.target.value);
                setDifference('');
                setConfirmed(false);
                setError('');
              }}
            >
              <option value="" disabled>
                Teklif seçin
              </option>
              <WonPriceChoices options={options} />
              <option value="NONE">Teklifsiz devam et</option>
            </select>
            <WonPriceOptionStatus
              prices={prices}
              reload={() => {
                setSelection('');
                setConfirmed(false);
                prices.reload();
              }}
            />
            {selection === 'NONE' && (
              <>
                <label htmlFor={id + '-no-price'}>Teklif kaydı olmadan devam etme nedeni *</label>
                <textarea
                  id={id + '-no-price'}
                  required
                  maxLength={500}
                  rows={2}
                  value={noQuoteReason}
                  onChange={(e) => {
                    setNoQuoteReason(e.target.value);
                    setConfirmed(false);
                    setError('');
                  }}
                />
              </>
            )}
            {changes.length > 0 && (
              <div className="issue-difference">
                <p>Seçilen tekliften farklı olan bilgiler {changes.join(', ')}.</p>
                <label htmlFor={id + '-difference'}>Farkın nedeni *</label>
                <select
                  id={id + '-difference'}
                  required
                  value={difference}
                  onChange={(e) => {
                    setDifference(e.target.value);
                    setConfirmed(false);
                    setError('');
                  }}
                >
                  <option value="" disabled>
                    Neden seçin
                  </option>
                  <option value="PREMIUM_CHANGED">Prim değişti</option>
                  <option value="CURRENCY_CHANGED">Para birimi değişti</option>
                  <option value="PERIOD_CHANGED">Poliçe dönemi değişti</option>
                  <option value="FINAL_POLICY_CHANGED">Birden fazla bilgi değişti</option>
                </select>
              </div>
            )}
            <label className="issue-confirm">
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              Poliçeyi kontrol ettim, takibi kapat
            </label>
            <Button type="submit" disabled={!confirmed}>
              Poliçeyi bağla
            </Button>
          </>
        )}
      </fieldset>
      {error && (
        <p role="alert" className="customer-error">
          {error}
        </p>
      )}
    </form>
  );
}
