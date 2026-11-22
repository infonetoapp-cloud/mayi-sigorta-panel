import { Link, useLocation } from 'react-router';
import type { CustomerCoverageSummary } from '../../../shared/customer-coverage';
import { useCustomerResource } from './customer-resource';
import { customerCoverageSchema } from './customer-read-schemas';
import { Button } from '../../components/ui/button';
import { ArrowRight } from 'lucide-react';
import { policyDate } from '../policies/policy-display';

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
          En yakın vade: {policyDate(summary.nearestExpiry.endDate)}
        </span>
      )}
    </div>
  );
}
export function CustomerCoverage({
  customerId,
  showAllLink,
}: {
  customerId: string;
  showAllLink: boolean;
}) {
  const route = useLocation();
  const state = useCustomerResource(
    `/api/customers/${encodeURIComponent(customerId)}/coverage`,
    customerCoverageSchema,
  );
  const summary = state.data;
  return (
    <section className="coverage-summary" aria-label="Sigorta özeti">
      <h2>Sigorta özeti</h2>
      {state.loading && <p role="status">Poliçe özeti yükleniyor…</p>}
      {state.error && (
        <div role="alert">
          <p>Poliçe özeti alınamadı. Bu durum poliçe bulunmadığı anlamına gelmez.</p>
          {state.error.status >= 500 && (
            <Button variant="outline" onClick={state.reload}>
              Poliçe özetini yeniden dene
            </Button>
          )}
        </div>
      )}
      {summary && (
        <>
          {!summary.available ? (
            <CoverageBrief summary={summary} />
          ) : (
            <>
              <div className="customer-coverage-key-facts">
                <strong>{summary.activePolicyCount} yürürlükte poliçe</strong>
                {summary.nearestExpiry && (
                  <span>En yakın vade: {policyDate(summary.nearestExpiry.endDate)}</span>
                )}
              </div>
              {summary.activePolicyCount === 0 && (
                <p>Görüntüleyebildiğiniz kayıtlarda bugün yürürlükte poliçe yok.</p>
              )}
              <div className="customer-coverage-status">
                {!!summary.expiredPolicyCount && (
                  <span>Süresi dolmuş: {summary.expiredPolicyCount}</span>
                )}
                {!!summary.scheduledPolicyCount && (
                  <span>Başlangıcı beklenen: {summary.scheduledPolicyCount}</span>
                )}
                {!!summary.invalidPeriodPolicyCount && (
                  <span role="alert">
                    Tarih kontrolü gereken: {summary.invalidPeriodPolicyCount}
                  </span>
                )}
              </div>
              {summary.policies.length > 0 && (
                <ul className="coverage-policies">
                  {summary.policies.map((policy) => (
                    <li key={policy.policyId}>
                      <Link
                        className="customer-name"
                        to={`/policies/${encodeURIComponent(policy.policyId)}`}
                        state={route.state}
                      >
                        <strong>{policy.productName}</strong>
                        <span>
                          {policy.insurerName} · {policy.policyNumber}
                        </span>
                      </Link>
                      <time dateTime={policy.endDate}>{policyDate(policy.endDate)}</time>
                    </li>
                  ))}
                </ul>
              )}
              {showAllLink && (
                <Link
                  className="customer-profile-text-link"
                  to="?section=policies"
                  state={route.state}
                >
                  Tüm poliçeleri ve yenilemeleri görüntüle{' '}
                  <ArrowRight size={16} aria-hidden="true" />
                </Link>
              )}
              <p className="coverage-scope">
                Görüntüleme yetkiniz olan kayıtlar · {policyDate(summary.asOfDate)}
              </p>
            </>
          )}
        </>
      )}
    </section>
  );
}
