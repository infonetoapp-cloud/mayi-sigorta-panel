import { Link, useLocation, useParams, useSearchParams } from 'react-router';
import { useEffect, useRef, useState } from 'react';
import { PolicyPartiesSection } from './PolicyPartiesSection';
import { PolicyAppendSection } from './PolicyAppendSection';
import { PolicyManagementSection } from './PolicyManagementSection';
import { DocumentSection } from '../../components/DocumentSection';
import { PolicyNavigationGuard, type PortfolioRisk } from './PolicyNavigationGuard';
import type { PolicyDetailDto } from '../../../shared/types';
import { PageHeader } from '../../components/layout/PageContainer';
import { Button } from '../../components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { useCustomerResource } from '../customers/customer-resource';
import { ReturnToWork } from '../today-work/work-navigation';
import { policyDate, policyMoney, policyStatusLabel, PolicyReadNotice } from './policy-display';
import { portfolioReturn } from './policy-portfolio';
import { PolicyRenewalWorkspace } from './PolicyRenewalWorkspace';
import './portfolio-v4.css';
const sections = [
  ['general', 'Poliçe bilgileri'],
  ['renewal', 'Yenileme ve teklifler'],
  ['parties', 'Sigortalılar ve lehtarlar'],
  ['amendments', 'Zeyiller'],
  ['external-references', 'Dış referanslar'],
  ['management', 'Sorumlu ve arşiv'],
  ['documents', 'Belgeler'],
] as const;

function PolicyPage({ id }: { id: string }) {
  const location = useLocation();
  const [params] = useSearchParams();
  const [renewalVisited, setRenewalVisited] = useState(params.get('section') === 'renewal');
  const [documentsVisited, setDocumentsVisited] = useState(params.get('section') === 'documents');
  const documentRisks = useRef<Record<string, PortfolioRisk>>({});
  const [documentRevision, setDocumentRevision] = useState(0);
  const section = sections.some(([key]) => key === params.get('section'))
    ? params.get('section')!
    : 'general';
  const state = useCustomerResource<PolicyDetailDto>(`/api/policies/${encodeURIComponent(id)}`);
  useEffect(() => {
    if (section === 'renewal') setRenewalVisited(true);
    if (section === 'documents') setDocumentsVisited(true);
  }, [section]);
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
    <div className="customer-modern policy-modern portfolio-v4 pv4-detail">
      <ReturnToWork />
      <PolicyNavigationGuard risks={documentRisks} revision={documentRevision} />
      <Link
        className="customer-back-link"
        to={portfolioReturn(location.state)}
        state={location.state}
      >
        ← Poliçe listesine dön
      </Link>
      <PolicyReadNotice {...state} />
      {policy && (
        <>
          {typeof location.state?.customerPolicyReturn === 'string' &&
            location.state.customerPolicyReturn.startsWith(
              `/customers/${encodeURIComponent(policy.customerId)}?`,
            ) && (
              <Link
                className="customer-back-link"
                to={location.state.customerPolicyReturn}
                state={location.state}
              >
                ← Müşterinin poliçe aramasına dön
              </Link>
            )}
          <PageHeader
            title={policy.policyNumber}
            description="Poliçe ayrıntıları ve tarihsel kayıtlar"
            action={
              <div className="customer-form-actions">
                {!policy.archivedAt && (
                  <Button asChild>
                    <Link
                      to={`/policies/${encodeURIComponent(policy.id)}/edit`}
                      state={location.state}
                    >
                      Poliçeyi düzenle
                    </Link>
                  </Button>
                )}
                {!policy.archivedAt && (
                  <Button asChild variant="outline">
                    <a
                      href={`/secure/confirm/policies/${encodeURIComponent(policy.id)}/identity-variant`}
                    >
                      Aynı numarayla farklı sözleşme kaydet
                    </a>
                  </Button>
                )}
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
                to={(() => {
                  const next = new URLSearchParams(params);
                  next.set('section', key);
                  return key === 'general' && next.size === 1
                    ? `/policies/${encodeURIComponent(id)}`
                    : '?' + next;
                })()}
                state={location.state}
                aria-current={section === key ? 'page' : undefined}
                onClick={() => {
                  if (key === 'renewal') setRenewalVisited(true);
                }}
              >
                {label}
              </Link>
            ))}
          </nav>
          {(renewalVisited || section === 'renewal') && (
            <div hidden={section !== 'renewal'}>
              <PolicyRenewalWorkspace key={id} policy={policy} />
            </div>
          )}
          {(documentsVisited || section === 'documents') && (
            <section className="modern-operation pv4-surface" hidden={section !== 'documents'}>
              <h2>Poliçe belgeleri</h2>
              {policy.archivedAt ? (
                <p>Arşivlenmiş poliçe için belge işlemi yapılamaz.</p>
              ) : (
                <DocumentSection
                  ownerType="POLICY"
                  ownerId={policy.id}
                  onRiskChange={(risk) => {
                    const previous = documentRisks.current.documents;
                    if (previous?.dirty === risk.dirty && previous.unresolved === risk.unresolved)
                      return;
                    documentRisks.current.documents = risk;
                    setDocumentRevision((r) => r + 1);
                  }}
                />
              )}
            </section>
          )}
          {section === 'renewal' || section === 'documents' ? null : section === 'general' ? (
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
        </>
      )}
    </div>
  );
}
export default function PolicyDetailPage() {
  const { policyId = '' } = useParams();
  return <PolicyPage key={policyId} id={policyId} />;
}
