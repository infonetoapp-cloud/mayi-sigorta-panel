import { Link, useLocation, useParams, useSearchParams } from 'react-router';
import { customerListReturnState } from './customer-list-context';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';

import { ArrowLeft, Settings2 } from 'lucide-react';
import type { CustomerDetailDto, RenewalStateCode } from '../../../shared/types';
import { Button } from '../../components/ui/button';
import { Card, CardHeader, CardTitle, CardContent } from '../../components/ui/card';
import { CustomerNoteWorkspace } from './CustomerNoteWorkspace';
import { CustomerContactSection } from '../../components/CustomerContactSection';
import { CustomerEditDialog } from '../../components/CustomerEditDialog';
import { CompanyContactsSection } from '../../components/CompanyContactsSection';
import { CustomerArchiveSection } from '../../components/CustomerArchiveSection';
import { CustomerIdentitySection } from '../../components/CustomerIdentitySection';
import { CustomerExternalReferencesSection } from '../../components/CustomerExternalReferencesSection';

import { readCustomerResource, useCustomerResource } from './customer-resource';
import {
  customerDetailFor,
  relatedPoliciesFor,
  relatedRenewalsSchema,
} from './customer-read-schemas';
import { storedPolicyDate } from '../policies/policy-display';
import { ReturnToWork } from '../today-work/work-navigation';
import { CustomerCoverage } from './CustomerCoverage';
import { CustomerInsurerNumbers } from './CustomerInsurerNumbers';
import { CustomerVehicles } from './CustomerVehicles';
import { SalesCasesSection } from '../sales/SalesCases';
const sections = [
  ['general', 'Genel bilgiler', 'Genel'],
  ['contact', 'İletişim'],
  ['policies', 'Poliçeler ve yenilemeler', 'Poliçeler'],
  ['vehicles', 'Araçlar'],
  ['sales', 'Teklif çalışmaları', 'Teklif'],
  ['notes', 'Müşteri notları', 'Notlar'],
] as const;
function relatedPageParams(
  current: URLSearchParams,
  key: 'after' | 'renewalsAfter',
  cursor: string | null,
) {
  const next = new URLSearchParams(current);
  next.set('section', 'policies');
  if (cursor === null) next.delete(key);
  else next.set(key, cursor);
  return next;
}

function RelatedPolicies({ customerId }: { customerId: string }) {
  const route = useLocation();
  const [params, setParams] = useSearchParams();
  const cursor = params.get('after');
  const query = new URLSearchParams({ customerId, pageSize: '20', includeLabels: 'true' });
  if (cursor) query.set('cursor', cursor);
  const decoder = useMemo(() => relatedPoliciesFor(customerId), [customerId]);
  const { data, error, loading, reload } = useCustomerResource(`/api/policies?${query}`, decoder);
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
            {error.status >= 500 && (
              <Button variant="outline" onClick={reload}>
                Poliçeleri yeniden dene
              </Button>
            )}
          </div>
        )}
        {data && !data.items.length && <p>Görüntülenebilir poliçe bulunamadı.</p>}
        {data && (
          <ul className="customer-related-list">
            {data.items.map((policy) => (
              <li key={policy.id}>
                <Link
                  className="customer-name"
                  to={`/policies/${encodeURIComponent(policy.id)}`}
                  state={route.state}
                >
                  {policy.policyNumber}
                </Link>
                {policy.labels && (
                  <span>
                    {policy.labels.productName} · {policy.labels.insurerName} ·{' '}
                    {policy.labels.branchName}
                  </span>
                )}
                <span>
                  {policy.startDate ? storedPolicyDate(policy.startDate) : 'Başlangıç belirtilmedi'}{' '}
                  – {storedPolicyDate(policy.endDate)}
                </span>
                <span>
                  Kayıt durumu:{' '}
                  {policy.status === 'ACTIVE'
                    ? 'Aktif'
                    : policy.status === 'CANCELLED'
                      ? 'İptal'
                      : 'Geçersiz'}
                  {policy.archivedAt ? ' · Arşivlenmiş' : ''}
                </span>
              </li>
            ))}
          </ul>
        )}
        {(cursor || data?.hasMore) && (
          <div className="customer-pagination">
            <Button
              variant="outline"
              disabled={!cursor || loading}
              onClick={() =>
                setParams(relatedPageParams(params, 'after', null), { state: route.state })
              }
            >
              İlk sayfa
            </Button>
            <Button
              variant="outline"
              disabled={loading || !data?.hasMore || !data.nextCursor}
              onClick={() => {
                if (data?.nextCursor)
                  setParams(relatedPageParams(params, 'after', data.nextCursor), {
                    state: route.state,
                  });
              }}
            >
              Sonraki poliçeler
            </Button>
          </div>
        )}
        <p className="customer-legacy-hint">İncelemek veya düzenlemek için poliçeyi açın.</p>
      </CardContent>
    </Card>
  );
}
function RelatedRenewals({ customerId }: { customerId: string }) {
  const route = useLocation();
  const [params, setParams] = useSearchParams();
  const cursor = params.get('renewalsAfter');
  const { data, error, loading, reload } = useCustomerResource(
    `/api/customers/${encodeURIComponent(customerId)}/renewals${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    relatedRenewalsSchema,
  );
  const labels: Record<RenewalStateCode, string> = {
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
    <Card>
      <CardHeader>
        <CardTitle>Yenilemeler</CardTitle>
      </CardHeader>
      <CardContent>
        {loading && <p role="status">Yenilemeler yükleniyor…</p>}
        {error && (
          <div role="alert">
            <p>{error.message}</p>
            {error.status >= 500 && (
              <Button variant="outline" onClick={reload}>
                Yenilemeleri yeniden dene
              </Button>
            )}
          </div>
        )}
        {data && !data.items.length && <p>Görüntülenebilir yenileme bulunamadı.</p>}
        {data && (
          <ul className="customer-related-list">
            {data.items.map((item) => (
              <li key={item.id}>
                <Link className="customer-name" to={'/renewals/' + encodeURIComponent(item.id)}>
                  {item.policyNumber}
                </Link>
                <span>Vade: {storedPolicyDate(item.policyEndDate)}</span>
                <span>{labels[item.state]}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="customer-pagination">
          <Button
            variant="outline"
            disabled={!cursor || loading}
            onClick={() =>
              setParams(relatedPageParams(params, 'renewalsAfter', null), { state: route.state })
            }
          >
            İlk yenilemeler
          </Button>
          <Button
            variant="outline"
            disabled={loading || !data?.nextCursor}
            onClick={() => {
              if (data?.nextCursor)
                setParams(relatedPageParams(params, 'renewalsAfter', data.nextCursor), {
                  state: route.state,
                });
            }}
          >
            Sonraki yenilemeler
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
function ManagementOption({ title, children }: { title: string; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [visited, setVisited] = useState(false);
  return (
    <>
      <Button
        variant="outline"
        onClick={() => {
          setVisited(true);
          setOpen(true);
        }}
      >
        {title}
      </Button>
      {visited && (
        <CustomerEditDialog title={title} open={open} onDismiss={() => setOpen(false)}>
          <Button variant="outline" onClick={() => setOpen(false)}>
            Kapat
          </Button>
          {children}
        </CustomerEditDialog>
      )}
    </>
  );
}
function ProfileWorkspace({ customer: initialCustomer }: { customer: CustomerDetailDto }) {
  const route = useLocation();
  const [customer, setCustomer] = useState(initialCustomer);
  const reloadReader = useRef<AbortController | null>(null);
  useEffect(() => () => reloadReader.current?.abort(), []);
  const [params] = useSearchParams();
  const section = route.pathname.endsWith('/advanced')
    ? 'management'
    : sections.some(([key]) => key === params.get('section'))
      ? params.get('section')!
      : 'general';
  async function reloadCustomer() {
    reloadReader.current?.abort();
    const controller = new AbortController();
    reloadReader.current = controller;
    const fresh = await readCustomerResource(
      `/api/customers/${encodeURIComponent(customer.id)}`,
      controller.signal,
      customerDetailFor(customer.id),
    );
    controller.signal.throwIfAborted();
    setCustomer((previous) => (fresh.version >= previous.version ? fresh : previous));
  }
  const [notesVisited, setNotesVisited] = useState(section === 'notes');
  const [numbersVisited, setNumbersVisited] = useState(section === 'general');
  const [vehiclesVisited, setVehiclesVisited] = useState(section === 'vehicles');
  const navigation = useRef<HTMLElement>(null);
  useEffect(() => {
    if (section === 'notes') setNotesVisited(true);
    if (section === 'general') setNumbersVisited(true);
    if (section === 'vehicles') setVehiclesVisited(true);
  }, [section]);
  useEffect(() => {
    const nav = navigation.current;
    const current = nav?.querySelector('[aria-current="page"]');
    if (!nav || !current) return;
    const track = nav.getBoundingClientRect();
    const link = current.getBoundingClientRect();
    if (link.left < track.left) nav.scrollLeft -= track.left - link.left;
    if (link.right > track.right) nav.scrollLeft += link.right - track.right;
  }, [section]);
  const initials = customer.displayName
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((word) => Array.from(word)[0] ?? '')
    .join('')
    .toLocaleUpperCase('tr-TR');
  const customerType = customer.type === 'COMPANY' ? 'Kurumsal müşteri' : 'Bireysel müşteri';
  return (
    <div className="customer-modern customer-profile">
      <ReturnToWork />
      <Link
        className="customer-back"
        to="/customers"
        state={customerListReturnState(route.state?.listPositionKey)}
      >
        <ArrowLeft size={17} aria-hidden="true" />
        Müşteri listesine dön
      </Link>
      <div className="customer-profile-top">
        <header className="customer-profile-header">
          <div className="customer-profile-identity">
            <span className="customer-profile-initials" aria-hidden="true">
              {initials}
            </span>
            <div>
              <h1>{customer.displayName}</h1>
              <p>
                {customerType}
                {customer.archivedAt && <span> · Arşivlenmiş</span>}
              </p>
            </div>
          </div>
          <div className="customer-profile-actions">
            <Button asChild variant="outline">
              <Link
                to={`/claims?customerId=${encodeURIComponent(customer.id)}`}
                aria-label="Hasar dosyaları"
              >
                <span className="customer-profile-action-full">Hasar dosyaları</span>
                <span className="customer-profile-action-short">Hasar</span>
              </Link>
            </Button>
            <Button asChild variant="outline">
              <Link
                to={`/customers/${encodeURIComponent(customer.id)}/advanced`}
                state={route.state}
                aria-label="Diğer müşteri işlemleri"
              >
                <Settings2 aria-hidden="true" />
                İşlemler
              </Link>
            </Button>
            {!customer.archivedAt && (
              <Button asChild>
                <Link to={`/policies/new?customerId=${encodeURIComponent(customer.id)}`}>
                  Poliçe ekle
                </Link>
              </Button>
            )}
          </div>
        </header>
        <nav ref={navigation} className="customer-profile-nav" aria-label="Müşteri bölümleri">
          {sections.map(([key, label, short]) => (
            <Link
              key={key}
              to={`/customers/${encodeURIComponent(customer.id)}?section=${key}`}
              state={route.state}
              aria-label={short ? label : undefined}
              aria-current={key === section ? 'page' : undefined}
            >
              {short ?? label}
            </Link>
          ))}
        </nav>
      </div>
      <div className="customer-profile-content">
        {section === 'management' && (
          <Card>
            <CardHeader>
              <CardTitle>Müşteri işlemleri</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="customer-profile-management-actions">
                <Link to={`/customers/${encodeURIComponent(customer.id)}`} state={route.state}>
                  Müşteri kartına dön
                </Link>
                {!customer.archivedAt && (
                  <>
                    <ManagementOption
                      title={
                        customer.type === 'COMPANY'
                          ? customer.hasIdentity
                            ? 'Vergi numarası'
                            : 'Vergi numarası eksik'
                          : 'Kimlik bilgileri'
                      }
                    >
                      <CustomerIdentitySection
                        customer={customer}
                        styles={{}}
                        onCustomerReload={reloadCustomer}
                      />
                    </ManagementOption>
                    <ManagementOption title="Kaynak müşteri numaraları">
                      <CustomerExternalReferencesSection
                        customer={customer}
                        onCustomerReload={reloadCustomer}
                      />
                    </ManagementOption>
                  </>
                )}
              </div>
              <CustomerArchiveSection customer={customer} onCustomerReload={reloadCustomer} />
            </CardContent>
          </Card>
        )}
        <div
          className={section === 'general' ? 'customer-profile-overview' : undefined}
          hidden={section !== 'general' && section !== 'contact' && section !== 'policies'}
        >
          {(section === 'general' || section === 'policies') && (
            <CustomerCoverage customerId={customer.id} showAllLink={section === 'general'} />
          )}
          {(section === 'general' || section === 'contact') && (
            <Card
              className={section === 'general' ? 'customer-profile-contact-summary' : undefined}
            >
              <CardHeader>
                <CardTitle>{section === 'general' ? 'İletişim' : 'İletişim bilgileri'}</CardTitle>
              </CardHeader>
              <CardContent>
                <dl className="customer-profile-facts">
                  <div>
                    <dt>Telefon</dt>
                    <dd>
                      {customer.phone ? (
                        <a href={`tel:${customer.phone}`}>{customer.phone}</a>
                      ) : (
                        'Belirtilmedi'
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>E-posta</dt>
                    <dd>
                      {customer.email ? (
                        <a href={`mailto:${customer.email}`}>{customer.email}</a>
                      ) : (
                        'Belirtilmedi'
                      )}
                    </dd>
                  </div>
                  <div>
                    <dt>Referans kişi</dt>
                    <dd>{customer.referenceName || 'Belirtilmedi'}</dd>
                  </div>
                  {section === 'contact' && customer.type === 'INDIVIDUAL' && (
                    <div>
                      <dt>Doğum tarihi</dt>
                      <dd>
                        {customer.birthDate
                          ? customer.birthDate.split('-').reverse().join('.')
                          : 'Belirtilmedi'}
                      </dd>
                    </div>
                  )}
                  {section === 'contact' && (
                    <div>
                      <dt>Adres</dt>
                      <dd>{customer.address || 'Belirtilmedi'}</dd>
                    </div>
                  )}
                </dl>
                <div className="customer-inline-edit">
                  <CustomerContactSection
                    key={customer.id}
                    customer={customer}
                    presentation="page"
                    onUpdated={(current) =>
                      setCustomer((previous) => (previous.id === current.id ? current : previous))
                    }
                  />
                  {customer.archivedAt && (
                    <p>Arşivlenmiş müşterinin iletişim bilgileri düzenlenemez.</p>
                  )}
                </div>
              </CardContent>
            </Card>
          )}
        </div>
        {customer.type === 'COMPANY' && section === 'contact' && (
          <CompanyContactsSection
            key={customer.id}
            customer={customer}
            onUpdated={(current) =>
              setCustomer((previous) => (previous.id === current.id ? current : previous))
            }
          />
        )}
        {(numbersVisited || section === 'general') && (
          <CustomerInsurerNumbers
            key={'insurer-numbers:' + customer.id}
            customer={customer}
            onCustomerReload={reloadCustomer}
            visible={section === 'general'}
          />
        )}
        {section === 'sales' && (
          <SalesCasesSection key={`sales:${customer.id}`} customer={customer} />
        )}
        {(vehiclesVisited || section === 'vehicles') && (
          <CustomerVehicles
            key={'vehicles:' + customer.id}
            customer={customer}
            onReload={reloadCustomer}
            visible={section === 'vehicles'}
          />
        )}
        {(notesVisited || section === 'notes') && (
          <CustomerNoteWorkspace
            key={customer.id}
            customerId={customer.id}
            archived={customer.archivedAt != null}
            visible={section === 'notes'}
          />
        )}
        {section === 'policies' && (
          <>
            <RelatedPolicies customerId={customer.id} />
            <RelatedRenewals customerId={customer.id} />
          </>
        )}
      </div>
    </div>
  );
}
export default function CustomerProfilePage() {
  const route = useLocation();
  const { customerId = '' } = useParams();
  const decoder = useMemo(() => customerDetailFor(customerId), [customerId]);
  const { data, error, loading, reload } = useCustomerResource(
    `/api/customers/${encodeURIComponent(customerId)}`,
    decoder,
  );
  if (loading)
    return (
      <p role="status" className="customer-state">
        Müşteri profili yükleniyor…
      </p>
    );
  if (error || !data)
    return (
      <div role="alert" className="customer-state">
        <h1>Müşteri profili açılamadı</h1>
        <p>{error?.message ?? 'Kayıt kullanılamıyor.'}</p>
        <Button asChild variant="outline">
          <Link to="/customers" state={customerListReturnState(route.state?.listPositionKey)}>
            Müşteri listesine dön
          </Link>
        </Button>
        {error && error.status >= 500 && <Button onClick={reload}>Yeniden dene</Button>}
      </div>
    );
  return <ProfileWorkspace key={customerId} customer={data} />;
}
