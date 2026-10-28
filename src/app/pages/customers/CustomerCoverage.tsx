import { Link, useLocation } from 'react-router';
import type { CustomerCoverageSummary } from '../../../shared/customer-coverage';
import { useCustomerResource } from './customer-resource';
import { Button } from '../../components/ui/button';

const date = (value: string) =>
  new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', dateStyle: 'medium' }).format(
    new Date(value + 'T00:00:00Z'),
  );
export function CoverageBrief({ summary }: { summary?: CustomerCoverageSummary }) {
  if (!summary || typeof summary.available !== 'boolean')
    return <span className="text-muted-foreground">Poliçe özeti alınamadı.</span>;
  if (!summary.available)
    return (
      <span className="text-muted-foreground">
        Poliçe bilgisi için görüntüleme yetkisi gerekli.
      </span>
    );
  return (
    <div className="coverage-brief">
      <strong>{summary.activePolicyCount} yürürlükte poliçe</strong>
      <div className="coverage-types">
        {summary.types.map((type, index) => (
          <span className="customer-badge" key={`${index}-${type.label}`}>
            {type.label}
          </span>
        ))}
        {summary.additionalTypeCount > 0 && (
          <span aria-label={`${summary.additionalTypeCount} diğer sigorta türü`}>
            +{summary.additionalTypeCount}
          </span>
        )}
      </div>
      {summary.nearestExpiry && (
        <span className="text-muted-foreground">
          En yakın vade: {date(summary.nearestExpiry.endDate)}
        </span>
      )}
    </div>
  );
}
export function CustomerCoverage({ customerId }: { customerId: string }) {
  const route = useLocation();
  const state = useCustomerResource<CustomerCoverageSummary>(
    `/api/customers/${encodeURIComponent(customerId)}/coverage`,
  );
  const summary = state.data;
  const valid =
    summary &&
    typeof summary.available === 'boolean' &&
    Array.isArray(summary.types) &&
    Array.isArray(summary.policies);
  return (
    <section className="coverage-summary" aria-label="Sigorta özeti">
      <h2>Sigorta özeti</h2>
      {state.loading && <p role="status">Poliçe özeti yükleniyor…</p>}
      {(state.error || (!state.loading && !valid)) && (
        <div role="alert">
          <p>Poliçe özeti alınamadı. Bu durum poliçe bulunmadığı anlamına gelmez.</p>
          {state.error?.status !== 401 &&
            state.error?.status !== 403 &&
            state.error?.status !== 404 && (
              <Button variant="outline" onClick={state.reload}>
                Poliçe özetini yeniden dene
              </Button>
            )}
        </div>
      )}
      {valid && (
        <>
          <CoverageBrief summary={summary} />
          {summary.available && (
            <>
              {summary.activePolicyCount === 0 && (
                <p>Görüntüleyebildiğiniz kayıtlarda bugün yürürlükte poliçe yok.</p>
              )}
              {!!summary.expiredPolicyCount && <p>Süresi dolmuş: {summary.expiredPolicyCount}</p>}
              {!!summary.scheduledPolicyCount && (
                <p>Başlangıcı beklenen: {summary.scheduledPolicyCount}</p>
              )}
              {!!summary.invalidPeriodPolicyCount && (
                <p role="alert">Tarih kontrolü gereken: {summary.invalidPeriodPolicyCount}</p>
              )}
              <ul className="coverage-policies">
                {summary.policies.map((policy, index) => (
                  <li key={policy.policyId}>
                    <Link
                      className="customer-name"
                      to={`/policies/${encodeURIComponent(policy.policyId)}`}
                      state={route.state}
                    >
                      {policy.productName} · {policy.insurerName} · {policy.policyNumber}
                    </Link>
                    <span>
                      {index === 0 ? 'En yakın vade' : 'Bitiş'}: {date(policy.endDate)}
                    </span>
                  </li>
                ))}
              </ul>
              <Link to="?section=policies" state={route.state}>
                Tüm poliçeleri ve yenilemeleri görüntüle
              </Link>
              <p className="coverage-scope">
                Yalnız görüntüleme yetkiniz olan poliçeler · {date(summary.asOfDate)}. Yürürlükte:
                aktif kayıt, arşivlenmemiş ve sözleşme dönemi bugün devam ediyor.
              </p>
            </>
          )}
        </>
      )}
    </section>
  );
}
