import { Link, useParams, useSearchParams } from 'react-router';

import { ArrowLeft, Settings2, Mail, Phone, MapPin } from 'lucide-react';
import type { CustomerDetailDto, PolicyListResponseData } from '../../../shared/types';
import { PageHeader } from '../../components/layout/PageContainer';
import { Button } from '../../components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '../../components/ui/card';
import { CustomerNotesSection } from '../../components/CustomerNotesSection';
import { getCsrfToken, invalidateCsrfToken } from '../../csrf';
import { useCustomerResource } from './customer-resource';
const sections = [
  ['general', 'Genel bilgiler'],
  ['contact', 'İletişim'],
  ['notes', 'Müşteri notları'],
  ['policies', 'Poliçeler ve yenilemeler'],
] as const;
const date = (value: string) =>
  new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', dateStyle: 'medium' }).format(
    new Date(value),
  );

function RelatedPolicies({ customerId }: { customerId: string }) {
  const [params, setParams] = useSearchParams();
  const cursor = params.get('after');
  const query = new URLSearchParams({ customerId, limit: '20' });
  if (cursor) query.set('cursor', cursor);
  const { data, error, loading, reload } = useCustomerResource<PolicyListResponseData>(
    `/api/policies?${query}`,
  );
  return (
    <Card>
      <CardHeader>
        <CardTitle>Mevcut poliçeler</CardTitle>
      </CardHeader>
      <CardContent>
        {loading && <p role="status">Poliçeler yükleniyor…</p>}
        {error && (
          <div role="alert">
            <p>{error.message}</p>
            <Button variant="outline" onClick={reload}>
              Yeniden dene
            </Button>
          </div>
        )}
        {data && !data.items.length && <p>Görüntülenebilir poliçe bulunamadı.</p>}
        {data && (
          <ul className="customer-related-list">
            {data.items.map((policy) => (
              <li key={policy.id}>
                <strong>{policy.policyNumber}</strong>
                <span>
                  {policy.startDate ? date(policy.startDate) : 'Başlangıç belirtilmedi'} –{' '}
                  {date(policy.endDate)}
                </span>
                <span>
                  {policy.status === 'ACTIVE'
                    ? 'Aktif'
                    : policy.status === 'CANCELLED'
                      ? 'İptal'
                      : 'Geçersiz'}
                </span>
              </li>
            ))}
          </ul>
        )}
        <div className="customer-pagination">
          <Button
            variant="outline"
            disabled={!cursor || loading}
            onClick={() => setParams({ section: 'policies' })}
          >
            İlk sayfa
          </Button>
          <Button
            variant="outline"
            disabled={loading || !data?.hasMore || !data.nextCursor}
            onClick={() => {
              if (data?.nextCursor) setParams({ section: 'policies', after: data.nextCursor });
            }}
          >
            Sonraki poliçeler
          </Button>
        </div>
        <p className="customer-legacy-hint">
          Poliçe ekleme ve yenileme görüşmeleri, teklif ve sonuç işlemleri henüz klasik çalışma
          alanındadır.
        </p>
      </CardContent>
    </Card>
  );
}
interface RenewalPage {
  items: Array<{ id: string; policyNumber: string; policyEndDate: string; state: string }>;
  nextCursor: string | null;
}
function RelatedRenewals({ customerId }: { customerId: string }) {
  const [params, setParams] = useSearchParams();
  const cursor = params.get('renewalsAfter');
  const { data, error, loading, reload } = useCustomerResource<RenewalPage>(
    `/api/customers/${encodeURIComponent(customerId)}/renewals${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
  );
  const labels: Record<string, string> = {
    CONTACT_PENDING: 'İletişim bekleniyor',
    CONTACTED: 'Görüşüldü',
    QUOTE_PREPARING: 'Teklif hazırlanıyor',
    QUOTE_SENT: 'Teklif gönderildi',
    AWAITING_RESPONSE: 'Yanıt bekleniyor',
    WON: 'Yenilendi',
    LOST: 'Yenilenmedi',
    VOIDED: 'Geçersiz',
  };
  return (
    <Card className="mt-6">
      <CardHeader>
        <CardTitle>Yenilemeler</CardTitle>
      </CardHeader>
      <CardContent>
        {loading && <p role="status">Yenilemeler yükleniyor…</p>}
        {error && (
          <div role="alert">
            <p>{error.message}</p>
            <Button variant="outline" onClick={reload}>
              Yeniden dene
            </Button>
          </div>
        )}
        {data && !data.items.length && <p>Görüntülenebilir yenileme bulunamadı.</p>}
        {data && (
          <ul className="customer-related-list">
            {data.items.map((item) => (
              <li key={item.id}>
                <strong>{item.policyNumber}</strong>
                <span>Vade: {date(item.policyEndDate)}</span>
                <span>{labels[item.state] ?? 'Devam ediyor'}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="customer-pagination">
          <Button
            variant="outline"
            disabled={!cursor || loading}
            onClick={() => setParams({ section: 'policies' })}
          >
            İlk yenilemeler
          </Button>
          <Button
            variant="outline"
            disabled={loading || !data?.nextCursor}
            onClick={() => {
              if (data?.nextCursor)
                setParams({ section: 'policies', renewalsAfter: data.nextCursor });
            }}
          >
            Sonraki yenilemeler
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
function ProfileWorkspace({ customer }: { customer: CustomerDetailDto }) {
  const [params] = useSearchParams();
  const section = sections.some(([key]) => key === params.get('section'))
    ? params.get('section')!
    : 'general';
  return (
    <div className="customer-modern">
      <Link className="customer-back" to="/customers">
        <ArrowLeft size={17} aria-hidden="true" />
        Müşteri listesine dön
      </Link>
      <PageHeader
        title={customer.displayName}
        description={customer.type === 'COMPANY' ? 'Kurumsal müşteri' : 'Bireysel müşteri'}
        action={
          <Button asChild variant="outline">
            <Link to={`/customers/${encodeURIComponent(customer.id)}/advanced`}>
              <Settings2 aria-hidden="true" />
              İleri müşteri işlemleri
            </Link>
          </Button>
        }
      />
      <div className="customer-profile-summary">
        <span className={`customer-badge ${customer.archivedAt ? '' : 'customer-badge-active'}`}>
          {customer.archivedAt ? 'Arşivlenmiş müşteri' : 'Aktif müşteri'}
        </span>
        <span>
          <Mail size={15} aria-hidden="true" />
          {customer.email || 'E-posta belirtilmedi'}
        </span>
        <span>
          <Phone size={15} aria-hidden="true" />
          {customer.phone || 'Telefon belirtilmedi'}
        </span>
      </div>
      <nav className="customer-section-nav" aria-label="Müşteri bölümleri">
        {sections.map(([key, label]) => (
          <Link
            key={key}
            to={`?section=${key}`}
            aria-current={key === section ? 'page' : undefined}
          >
            {label}
          </Link>
        ))}
      </nav>
      {section === 'general' && (
        <Card>
          <CardHeader>
            <CardTitle>Genel bilgiler</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="customer-info-grid">
              <div>
                <dt>Ad / unvan</dt>
                <dd>{customer.displayName}</dd>
              </div>
              <div>
                <dt>Müşteri türü</dt>
                <dd>{customer.type === 'COMPANY' ? 'Kurumsal' : 'Bireysel'}</dd>
              </div>
              <div>
                <dt>Kayıt tarihi</dt>
                <dd>{date(customer.createdAt)}</dd>
              </div>
              <div>
                <dt>Durum</dt>
                <dd>{customer.archivedAt ? 'Arşivlenmiş' : 'Aktif'}</dd>
              </div>
            </dl>
            <p className="customer-legacy-hint">
              Düzenleme, atama, arşivleme, şirket yetkilileri ve yetkili kimlik işlemleri “İleri
              müşteri işlemleri” bağlantısında geçici klasik arayüzle kullanılabilir.
            </p>
          </CardContent>
        </Card>
      )}
      {section === 'contact' && (
        <Card>
          <CardHeader>
            <CardTitle>İletişim bilgileri</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="customer-info-grid">
              <div>
                <dt>
                  <Mail size={16} aria-hidden="true" />
                  E-posta
                </dt>
                <dd>{customer.email || 'Belirtilmedi'}</dd>
              </div>
              <div>
                <dt>
                  <Phone size={16} aria-hidden="true" />
                  Telefon
                </dt>
                <dd>{customer.phone || 'Belirtilmedi'}</dd>
              </div>
              <div>
                <dt>
                  <MapPin size={16} aria-hidden="true" />
                  Adres
                </dt>
                <dd>{customer.address || 'Belirtilmedi'}</dd>
              </div>
            </dl>
            {customer.contacts && (
              <>
                <h3>Şirket yetkilileri</h3>
                <ul className="customer-related-list">
                  {customer.contacts.map((contact) => (
                    <li key={contact.id}>
                      <strong>
                        {contact.firstName} {contact.lastName}
                      </strong>
                      <span>
                        {contact.isPrimary ? 'Birincil yetkili · ' : ''}
                        {contact.status === 'ACTIVE' ? 'Aktif' : 'Pasif'}
                      </span>
                      <span>
                        {contact.email || 'E-posta belirtilmedi'} ·{' '}
                        {contact.phone || 'Telefon belirtilmedi'}
                      </span>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </CardContent>
        </Card>
      )}
      {section === 'notes' && (
        <CustomerNotesSection
          key={customer.id}
          customerId={customer.id}
          archived={customer.archivedAt != null}
          presentation="page"
          getCsrfToken={getCsrfToken}
          invalidateCsrfToken={invalidateCsrfToken}
        />
      )}
      {section === 'policies' && (
        <>
          <RelatedPolicies customerId={customer.id} />
          <RelatedRenewals customerId={customer.id} />
        </>
      )}
    </div>
  );
}
export default function CustomerProfilePage() {
  const { customerId = '' } = useParams();
  const { data, error, loading, reload } = useCustomerResource<CustomerDetailDto>(
    `/api/customers/${encodeURIComponent(customerId)}`,
  );
  if (loading)
    return (
      <p role="status" className="customer-state">
        Müşteri profili yükleniyor…
      </p>
    );
  if (error || !data || data.id !== customerId)
    return (
      <div role="alert" className="customer-state">
        <h1>Müşteri profili açılamadı</h1>
        <p>{error?.message ?? 'Kayıt kullanılamıyor.'}</p>
        <Button asChild variant="outline">
          <Link to="/customers">Müşteri listesine dön</Link>
        </Button>
        {error && error.status >= 500 && <Button onClick={reload}>Yeniden dene</Button>}
      </div>
    );
  return <ProfileWorkspace key={customerId} customer={data} />;
}
