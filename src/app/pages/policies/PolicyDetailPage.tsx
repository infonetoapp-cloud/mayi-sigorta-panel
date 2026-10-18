import { Link, useLocation, useParams, useSearchParams } from 'react-router';
import { useState } from 'react';
import { PolicyPartiesSection } from './PolicyPartiesSection';
import { PolicyAppendSection } from './PolicyAppendSection';
import { PolicyManagementSection } from './PolicyManagementSection';
import type { PolicyDetailDto } from '../../../shared/types';
import { PageHeader } from '../../components/layout/PageContainer';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { useCustomerResource } from '../customers/customer-resource';
import { policyDate, policyMoney, policyStatusLabel, PolicyReadNotice } from './policy-display';
const sections = [
  ['general', 'Poliçe bilgileri'],
  ['parties', 'Sigortalılar ve lehtarlar'],
  ['amendments', 'Zeyiller'],
  ['external-references', 'Dış referanslar'],
  ['management', 'Sorumlu ve arşiv'],
] as const;

function PolicyPage({ id }: { id: string }) {
  const location = useLocation();
  const [params] = useSearchParams();
  const section = sections.some(([key]) => key === params.get('section'))
    ? params.get('section')!
    : 'general';
  const state = useCustomerResource<PolicyDetailDto>(`/api/policies/${encodeURIComponent(id)}`);
  const [refreshed, setRefreshed] = useState<PolicyDetailDto | null>(null);
  const policy = state.data
    ? refreshed && refreshed.version >= state.data.version
      ? refreshed
      : state.data
    : undefined;
  function acceptUpdated(fresh: PolicyDetailDto) {
    if (fresh.id !== id) return;
    setRefreshed((previous) => (previous && previous.version > fresh.version ? previous : fresh));
  }
  return (
    <div className="customer-modern policy-modern">
      <Link className="customer-back-link" to="/policies">
        ← Poliçe listesine dön
      </Link>
      <PolicyReadNotice {...state} />
      {policy && (
        <>
          <PageHeader
            title={policy.policyNumber}
            description="Poliçe ayrıntıları ve tarihsel kayıtlar"
            action={
              <div className="customer-form-actions">
                {!policy.archivedAt && (
                  <Button asChild>
                    <Link to={`/policies/${encodeURIComponent(policy.id)}/edit`}>
                      Poliçeyi düzenle
                    </Link>
                  </Button>
                )}
                <Button asChild variant="outline">
                  <Link to="/policies/legacy">Poliçe işlemleri (klasik)</Link>
                </Button>
              </div>
            }
          />
          {location.state?.policySaved === policy.id && (
            <p role="status">Poliçe kaydedildi ve güncel detay doğrulandı.</p>
          )}
          <div className="company-contact-badges">
            <span className="customer-badge">{policyStatusLabel[policy.status]}</span>
            <span className="customer-badge">
              {policy.archivedAt ? 'Arşivlenmiş' : 'Arşivlenmemiş'}
            </span>
          </div>
          {policy.archivedAt && (
            <p className="customer-legacy-hint">
              Arşiv tarihi: {policyDate(policy.archivedAt)}
              {policy.archiveReason ? ` · ${policy.archiveReason}` : ''}
            </p>
          )}
          <nav className="customer-section-nav" aria-label="Poliçe bölümleri">
            {sections.map(([key, label]) => (
              <Link
                key={key}
                to={key === 'general' ? `/policies/${encodeURIComponent(id)}` : `?section=${key}`}
                aria-current={section === key ? 'page' : undefined}
              >
                {label}
              </Link>
            ))}
          </nav>
          {section === 'general' ? (
            <Card>
              <CardHeader>
                <CardTitle>Sözleşme bilgileri</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="customer-info-grid">
                  <div>
                    <dt>Müşteri</dt>
                    <dd>
                      <Link
                        className="customer-name"
                        to={`/customers/${encodeURIComponent(policy.customer.id)}`}
                      >
                        {policy.customer.displayName}
                      </Link>
                    </dd>
                  </div>
                  <div>
                    <dt>Sigortacı</dt>
                    <dd>
                      {policy.insurer.name}
                      {policy.insurer.status === 'INACTIVE' ? ' (Pasif katalog kaydı)' : ''}
                    </dd>
                  </div>
                  <div>
                    <dt>Ürün</dt>
                    <dd>
                      {policy.product.name}
                      {policy.product.status === 'INACTIVE' ? ' (Pasif katalog kaydı)' : ''}
                    </dd>
                  </div>
                  <div>
                    <dt>Branş</dt>
                    <dd>
                      {policy.branch.name}
                      {policy.branch.status === 'INACTIVE' ? ' (Pasif katalog kaydı)' : ''}
                    </dd>
                  </div>
                  <div>
                    <dt>Ödeme yöntemi</dt>
                    <dd>
                      {policy.paymentMethod.name}
                      {policy.paymentMethod.status === 'INACTIVE' ? ' (Pasif katalog kaydı)' : ''}
                    </dd>
                  </div>
                  <div>
                    <dt>Başlangıç tarihi</dt>
                    <dd>{policyDate(policy.startDate)}</dd>
                  </div>
                  <div>
                    <dt>Bitiş tarihi</dt>
                    <dd>{policyDate(policy.endDate)}</dd>
                  </div>
                  <div>
                    <dt>Brüt prim</dt>
                    <dd>{policyMoney(policy.grossPremiumMinor, policy.currency)}</dd>
                  </div>
                  <div>
                    <dt>Para birimi</dt>
                    <dd>{policy.currency}</dd>
                  </div>
                  <div>
                    <dt>Taksit sayısı</dt>
                    <dd>{policy.installmentCount ?? 'Belirtilmedi'}</dd>
                  </div>
                </dl>
              </CardContent>
            </Card>
          ) : section === 'parties' ? (
            <PolicyPartiesSection key={id} policy={policy} onUpdated={acceptUpdated} />
          ) : section === 'management' ? (
            <PolicyManagementSection key={id} policy={policy} onUpdated={acceptUpdated} />
          ) : (
            <PolicyAppendSection
              key={`${id}:${section}`}
              kind={section as 'amendments' | 'external-references'}
              policy={policy}
              onUpdated={acceptUpdated}
            />
          )}
          <p className="customer-legacy-hint">
            Hassas kimlik-varyant onayı ve klasik ileri işlemler ayrı güvenli akışta korunur.
          </p>
        </>
      )}
    </div>
  );
}
export default function PolicyDetailPage() {
  const { policyId = '' } = useParams();
  return <PolicyPage key={policyId} id={policyId} />;
}
