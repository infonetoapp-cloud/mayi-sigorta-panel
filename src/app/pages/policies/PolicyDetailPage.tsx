import { Link, useLocation, useParams, useSearchParams } from 'react-router';
import { useEffect, useMemo, useState } from 'react';
import { PolicyVehicleSection } from './PolicyVehicleSection';
import { PolicyPartiesSection } from './PolicyPartiesSection';
import { PolicyAppendSection } from './PolicyAppendSection';
import { PolicyManagementSection } from './PolicyManagementSection';
import { PolicyLifecycleSection } from './PolicyLifecycleSection';
import type { PolicyDetailDto } from '../../../shared/types';
import { PageHeader } from '../../components/layout/PageContainer';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { useCustomerResource } from '../customers/customer-resource';
import { policyDetailFor } from './policy-read-schemas';
import { ReturnToWork } from '../today-work/work-navigation';
import {
  policyDate,
  storedPolicyDate,
  policyMoney,
  policyStatusLabel,
  PolicyPeriodBadge,
  PolicyReadNotice,
} from './policy-display';
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
  const [vehicleVisited, setVehicleVisited] = useState(section === 'general');
  useEffect(() => {
    if (section === 'general') setVehicleVisited(true);
  }, [section]);
  const decoder = useMemo(() => policyDetailFor(id), [id]);
  const state = useCustomerResource(`/api/policies/${encodeURIComponent(id)}`, decoder);
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
  const back: unknown = location.state?.policyList;
  const returnTo =
    typeof back === 'string' && (back === '/policies' || back.startsWith('/policies?'))
      ? back
      : '/policies';
  const listKey: unknown = location.state?.listPositionKey;
  return (
    <div className="customer-modern policy-modern">
      <ReturnToWork />
      <Link
        className="customer-back-link"
        to={returnTo}
        state={
          returnTo === back && typeof listKey === 'string'
            ? { listPositionKey: listKey }
            : undefined
        }
      >
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
                {!policy.archivedAt && policy.status === 'ACTIVE' && (
                  <Button asChild>
                    <Link to={`/policies/${encodeURIComponent(policy.id)}/edit`}>
                      Poliçeyi düzenle
                    </Link>
                  </Button>
                )}
                <Button asChild variant="outline">
                  <Link to={`/claims?policyId=${encodeURIComponent(policy.id)}`}>
                    Hasar dosyaları
                  </Link>
                </Button>
                <Button asChild variant="outline">
                  <Link to={`/finance?policyId=${encodeURIComponent(policy.id)}`}>
                    Alacak ve tahsilatlar
                  </Link>
                </Button>
              </div>
            }
          />
          {location.state?.policySaved === policy.id && (
            <p role="status">Poliçe kaydedildi ve güncel detay doğrulandı.</p>
          )}
          <div className="company-contact-badges">
            <PolicyPeriodBadge policy={policy} />
            <span className="catalog-row-detail">
              Kayıt: <span>{policyStatusLabel[policy.status]}</span>
            </span>
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
                state={location.state}
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
                        state={location.state}
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
                    <dd>{storedPolicyDate(policy.startDate)}</dd>
                  </div>
                  <div>
                    <dt>Bitiş tarihi</dt>
                    <dd>{storedPolicyDate(policy.endDate)}</dd>
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
            <PolicyPartiesSection key={`parties:${id}`} policy={policy} onUpdated={acceptUpdated} />
          ) : section === 'management' ? (
            <PolicyManagementSection
              key={`management:${id}`}
              policy={policy}
              onUpdated={acceptUpdated}
            />
          ) : (
            <PolicyAppendSection
              key={`${id}:${section}`}
              kind={section as 'amendments' | 'external-references'}
              policy={policy}
              onUpdated={acceptUpdated}
            />
          )}
          {vehicleVisited && (
            <PolicyVehicleSection
              key={`vehicle:${id}`}
              policy={policy}
              onUpdated={acceptUpdated}
              visible={section === 'general'}
            />
          )}
          <PolicyLifecycleSection
            key={`lifecycle:${id}`}
            policy={policy}
            onUpdated={acceptUpdated}
          />
        </>
      )}
    </div>
  );
}
export default function PolicyDetailPage() {
  const { policyId = '' } = useParams();
  return <PolicyPage key={policyId} id={policyId} />;
}
