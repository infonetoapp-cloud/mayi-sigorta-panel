import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router';
import {
  ArrowLeft,
  ArrowUpRight,
  Building2,
  Mail,
  MapPin,
  Phone,
  Plus,
  Settings2,
  StickyNote,
  UserRound,
} from 'lucide-react';
import type { CustomerDetailDto } from '../../../shared/types';
import { Button } from '../../components/ui/button';
import { CustomerContactSection } from '../../components/CustomerContactSection';
import { CompanyContactsSection } from '../../components/CompanyContactsSection';
import { DocumentSection } from '../../components/DocumentSection';
import { ReturnToWork } from '../today-work/work-navigation';
import { CustomerNoteWorkspace } from './CustomerNoteWorkspace';
import { CustomerCoverage } from './CustomerCoverage';
import { CustomerPolicies, CustomerRenewals } from './CustomerRelationships';
import { useCustomerResource } from './customer-resource';
import './customer360.css';
const sections = [
  ['general', 'Genel bakış'],
  ['contact', 'İletişim'],
  ['policies', 'Poliçeler ve yenilemeler'],
  ['renewals', 'Görüşmeler'],
  ['notes', 'Müşteri notları'],
  ['documents', 'Belgeler'],
] as const;
type Risk = { dirty: boolean; unresolved: boolean };
export const customerDate = (value: string) => {
  const parsed = new Date(value.length === 10 ? value + 'T12:00:00Z' : value);
  return Number.isFinite(parsed.getTime())
    ? new Intl.DateTimeFormat('tr-TR', { timeZone: 'Europe/Istanbul', dateStyle: 'medium' }).format(
        parsed,
      )
    : 'Tarih belirtilmedi';
};
function ProfileWorkspace({ customer: initial }: { customer: CustomerDetailDto }) {
  const route = useLocation();
  const [params] = useSearchParams();
  const [customer, setCustomer] = useState(initial);
  const section = sections.some(([key]) => key === params.get('section'))
    ? params.get('section')!
    : 'general';
  const [visited, setVisited] = useState<string[]>([section]);
  useEffect(() => {
    setVisited((previous) => (previous.includes(section) ? previous : [...previous, section]));
  }, [section]);
  const seen = (key: string) => section === key || visited.includes(key);
  const risks = useRef<Record<string, Risk>>({});
  const [riskRevision, setRiskRevision] = useState(0);
  const recordRisk = useCallback((key: string, next: Risk) => {
    const previous = risks.current[key];
    if (previous?.dirty === next.dirty && previous.unresolved === next.unresolved) return;
    risks.current[key] = next;
    setRiskRevision((value) => value + 1);
  }, []);
  const contactRisk = useCallback(
    (r: Risk) => {
      recordRisk('contact', r);
    },
    [recordRisk],
  );
  const companyRisk = useCallback(
    (r: Risk) => {
      recordRisk('company', r);
    },
    [recordRisk],
  );
  const renewalRisk = useCallback(
    (r: Risk) => {
      recordRisk('renewal', r);
    },
    [recordRisk],
  );
  const update = useCallback(
    (current: CustomerDetailDto) =>
      setCustomer((previous) => (previous.id === current.id ? current : previous)),
    [],
  );
  const href = (key: string) => {
    const next = new URLSearchParams(params);
    next.set('section', key);
    return '?' + next;
  };
  const contact = customer.contacts?.find((c) => c.status === 'ACTIVE' && c.isPrimary);
  const Icon = customer.type === 'COMPANY' ? Building2 : UserRound;
  return (
    <div className="customer-modern customer360">
      <ReturnToWork />
      <div className="c360-breadcrumb">
        <Link className="customer-back" to="/customers">
          <ArrowLeft size={16} aria-hidden="true" />
          Müşteri listesine dön
        </Link>
        <span>Müşteri 360°</span>
      </div>
      <header className="c360-identity">
        <div className="c360-avatar">
          <Icon size={26} aria-hidden="true" />
        </div>
        <div className="c360-title">
          <div className="c360-eyebrow">
            {customer.type === 'COMPANY' ? 'KURUMSAL MÜŞTERİ' : 'BİREYSEL MÜŞTERİ'}
            <span className={'c360-status ' + (customer.archivedAt ? 'is-muted' : 'is-active')}>
              {customer.archivedAt ? 'Arşivlenmiş' : 'Aktif müşteri'}
            </span>
          </div>
          <h1>{customer.displayName}</h1>
          <div className="c360-header-contact">
            <span>
              <Mail size={14} aria-hidden="true" />
              {customer.email || 'E-posta belirtilmedi'}
            </span>
            <span>
              <Phone size={14} aria-hidden="true" />
              {customer.phone || 'Telefon belirtilmedi'}
            </span>
          </div>
        </div>
        <div className="c360-header-actions">
          {!customer.archivedAt && (
            <>
              <Button asChild variant="outline">
                <Link to={href('notes')} state={route.state}>
                  <StickyNote size={16} aria-hidden="true" />
                  Not ekle
                </Link>
              </Button>
              <Button asChild>
                <Link
                  to={`/policies/new?customerId=${encodeURIComponent(customer.id)}`}
                  state={route.state}
                >
                  <Plus size={16} aria-hidden="true" />
                  Poliçe ekle
                </Link>
              </Button>
            </>
          )}
          <Button asChild variant="ghost">
            <Link
              aria-label="İleri müşteri işlemleri"
              to={`/customers/${encodeURIComponent(customer.id)}/manage`}
              state={route.state}
            >
              <Settings2 size={16} aria-hidden="true" /> İleri işlemler
            </Link>
          </Button>
        </div>
      </header>
      <div className="c360-layout">
        <aside className="c360-sidebar" aria-label="Müşteri özeti">
          <section className="c360-panel">
            <div className="c360-panel-heading">
              <h2>Müşteri kartı</h2>
              <Link
                to={href('contact')}
                state={route.state}
                aria-label="Müşteri iletişim bilgilerini aç"
              >
                <ArrowUpRight size={17} aria-hidden="true" />
              </Link>
            </div>
            <dl className="c360-facts">
              <div>
                <dt>
                  <MapPin size={14} aria-hidden="true" />
                  Adres
                </dt>
                <dd>{customer.address || 'Adres belirtilmedi'}</dd>
              </div>
              {contact && (
                <div>
                  <dt>Birincil şirket yetkilisi</dt>
                  <dd>
                    {contact.firstName} {contact.lastName}
                    <small>{contact.role || 'Unvan belirtilmedi'}</small>
                  </dd>
                </div>
              )}
              <div>
                <dt>Kayıt tarihi</dt>
                <dd>{customerDate(customer.createdAt)}</dd>
              </div>
              <div>
                <dt>Kayıt sorumluluğu</dt>
                <dd>
                  {customer.assigneeMembershipId ? 'Sorumlu atanmış' : 'Sorumlu bilgisi sağlanmadı'}
                  <small>Ad bu görünümde sağlanmıyor.</small>
                </dd>
              </div>
            </dl>
          </section>
        </aside>
        <div className="c360-main">
          <nav className="customer-section-nav" aria-label="Müşteri bölümleri">
            {sections.map(([key, label]) => (
              <Link
                key={key}
                to={href(key)}
                state={route.state}
                aria-current={key === section ? 'page' : undefined}
              >
                {label}
              </Link>
            ))}
          </nav>
          {section === 'general' && (
            <div className="c360-overview">
              <CustomerCoverage customerId={customer.id} />
            </div>
          )}
          {seen('contact') && (
            <div hidden={section !== 'contact'}>
              <section className="c360-panel">
                <div className="c360-panel-heading">
                  <div>
                    <h2>İletişim bilgileri</h2>
                    <p>Güncel ulaşım bilgileri ve şirket ilişkileri.</p>
                  </div>
                </div>
                <dl className="customer-info-grid c360-contact-grid">
                  <div>
                    <dt>E-posta</dt>
                    <dd>{customer.email || 'Belirtilmedi'}</dd>
                  </div>
                  <div>
                    <dt>Telefon</dt>
                    <dd>{customer.phone || 'Belirtilmedi'}</dd>
                  </div>
                  <div>
                    <dt>Adres</dt>
                    <dd>{customer.address || 'Belirtilmedi'}</dd>
                  </div>
                </dl>
                <CustomerContactSection
                  customer={customer}
                  presentation="page"
                  onUpdated={update}
                  onRiskChange={contactRisk}
                />
                {customer.archivedAt && (
                  <p>Arşivlenmiş müşterinin iletişim bilgileri düzenlenemez.</p>
                )}
                {customer.type === 'COMPANY' && (
                  <CompanyContactsSection
                    customer={customer}
                    onUpdated={update}
                    onRiskChange={companyRisk}
                  />
                )}
              </section>
            </div>
          )}
          {seen('policies') && (
            <div hidden={section !== 'policies'}>
              <CustomerPolicies customerId={customer.id} />
            </div>
          )}
          {(seen('policies') || seen('renewals')) && (
            <div hidden={section !== 'policies' && section !== 'renewals'}>
              <CustomerRenewals customer={customer} onRiskChange={renewalRisk} />
            </div>
          )}
          {seen('documents') && (
            <section className="c360-panel modern-operation" hidden={section !== 'documents'}>
              <h2>Müşteri belgeleri</h2>
              {customer.archivedAt ? (
                <p>Arşivlenmiş müşteri için belge işlemi yapılamaz.</p>
              ) : (
                <DocumentSection
                  ownerType="CUSTOMER"
                  ownerId={customer.id}
                  onRiskChange={(risk) => recordRisk('documents', risk)}
                />
              )}
            </section>
          )}
          <CustomerNoteWorkspace
            customerId={customer.id}
            archived={customer.archivedAt != null}
            visible={section === 'notes'}
            loadNotes={seen('notes')}
            externalRisk={risks}
            externalRevision={riskRevision}
          />
        </div>
      </div>
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
      <div className="customer360 c360-loading" role="status">
        <div className="c360-loading-line" />
        <h1>Müşteri profili yükleniyor…</h1>
        <p>İletişim ve yetkili kayıtlar hazırlanıyor.</p>
      </div>
    );
  if (error || !data || data.id !== customerId)
    return (
      <div role="alert" className="customer360 customer-state">
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
