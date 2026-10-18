import { Link, useLocation, useParams, useSearchParams } from 'react-router';
import type {
  PolicyDetailDto,
  PolicyPartyDto,
  PolicyAmendmentDto,
  PolicyExternalReferenceDto,
} from '../../../shared/types';
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
] as const;
type Related = 'parties' | 'amendments' | 'external-references';
function RelatedSection({ id, section }: { id: string; section: Related }) {
  const state = useCustomerResource<
    Array<PolicyPartyDto | PolicyAmendmentDto | PolicyExternalReferenceDto>
  >(`/api/policies/${encodeURIComponent(id)}/${section}`);
  return (
    <Card>
      <CardHeader>
        <CardTitle>{sections.find(([key]) => key === section)![1]}</CardTitle>
      </CardHeader>
      <CardContent>
        <PolicyReadNotice {...state} />
        {state.data && !state.data.length && <p>Bu bölümde kayıt bulunmuyor.</p>}
        {state.data && (
          <ul className="customer-related-list">
            {state.data.map((item) => (
              <li key={item.id}>
                {'customerDisplayName' in item ? (
                  <>
                    <strong>{item.customerDisplayName}</strong>
                    <span>
                      {item.role === 'INSURED' ? 'Sigortalı' : 'Lehtar'} ·{' '}
                      {item.status === 'ACTIVE' ? 'Aktif' : 'Pasif'}
                    </span>
                  </>
                ) : 'effectiveDate' in item ? (
                  <>
                    <strong>{item.externalReference}</strong>
                    <span>{policyDate(item.effectiveDate)}</span>
                    <p className="policy-history-text">{item.description}</p>
                    <span>
                      {item.premiumDifferenceMinor == null
                        ? 'Prim farkı belirtilmedi'
                        : item.currency
                          ? policyMoney(item.premiumDifferenceMinor, item.currency)
                          : 'Prim farkının para birimi belirtilmedi'}
                    </span>
                  </>
                ) : (
                  <>
                    <strong>{item.sourceNamespace}</strong>
                    <span>{item.externalKey}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        )}
      </CardContent>
    </Card>
  );
}
function PolicyPage({ id }: { id: string }) {
  const location = useLocation();
  const [params] = useSearchParams();
  const section = sections.some(([key]) => key === params.get('section'))
    ? params.get('section')!
    : 'general';
  const state = useCustomerResource<PolicyDetailDto>(`/api/policies/${encodeURIComponent(id)}`);
  const policy = state.data;
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
          ) : (
            <RelatedSection key={`${id}:${section}`} id={id} section={section as Related} />
          )}
          <p className="customer-legacy-hint">
            Oluşturma, düzenleme, atama, sigortalı/lehtar, zeyil, referans, arşivleme ve güvenli
            onay işlemleri klasik çalışma alanında korunur.
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
