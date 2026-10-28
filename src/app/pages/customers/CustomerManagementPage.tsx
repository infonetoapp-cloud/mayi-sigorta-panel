import { useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router';
import { Archive, ArrowLeft, Fingerprint, Link2, UserRoundCog } from 'lucide-react';
import type { CustomerDetailDto } from '../../../shared/types';
import { CustomerAssignmentSection } from '../../components/CustomerAssignmentSection';
import { CustomerIdentitySection } from '../../components/CustomerIdentitySection';
import { CustomerExternalReferencesSection } from '../../components/CustomerExternalReferencesSection';
import { CustomerArchiveSection } from '../../components/CustomerArchiveSection';
import { LegacyCustomerBoundary } from '../../components/LegacyCustomerBoundary';
import { Button } from '../../components/ui/button';
import { readCustomerResource, useCustomerResource } from './customer-resource';
import { PolicyReadNotice } from '../policies/policy-display';
import './customer-management.css';
const sections = [
  ['assignment', 'Kayıt sorumlusu', UserRoundCog],
  ['identity', 'Kimlik bilgileri', Fingerprint],
  ['references', 'Dış sistem kayıtları', Link2],
  ['archive', 'Arşivleme', Archive],
] as const;
function Workspace({ customer: initial }: { customer: CustomerDetailDto }) {
  const navigate = useNavigate(),
    location = useLocation();
  const [customer, setCustomer] = useState(initial);
  const [section, setSection] = useState('assignment');
  const [visited, setVisited] = useState<string[]>(['assignment']);
  const reload = async () => {
    const fresh = await readCustomerResource<CustomerDetailDto>(
      `/api/customers/${encodeURIComponent(initial.id)}`,
    );
    if (fresh.id !== initial.id) throw new Error('Müşteri bilgileri doğrulanamadı.');
    setCustomer(fresh);
  };
  const seen = (id: string) => visited.includes(id);
  return (
    <LegacyCustomerBoundary
      title={`${customer.displayName} müşteri işlemleri`}
      presentation="page"
      onClose={() =>
        void navigate(`/customers/${encodeURIComponent(customer.id)}`, { state: location.state })
      }
    >
      <div className="customer-modern customer-management">
        <Link
          className="customer-back-link"
          to={`/customers/${encodeURIComponent(customer.id)}`}
          state={location.state}
        >
          <ArrowLeft size={16} aria-hidden="true" /> Müşteri profiline dön
        </Link>
        <header>
          <div>
            <p className="management-eyebrow">MÜŞTERİ İŞLEMLERİ</p>
            <h1>{customer.displayName}</h1>
            <p>Kayıt sorumlusu, kimlik bilgileri ve arşiv yönetimi.</p>
          </div>
        </header>
        <nav aria-label="Müşteri işlem bölümleri" className="management-tabs">
          {sections.map(([key, label, Icon]) => (
            <Button
              key={key}
              variant={key === section ? 'default' : 'outline'}
              aria-pressed={key === section}
              onClick={() => {
                setSection(key);
                setVisited((old) => (old.includes(key) ? old : [...old, key]));
              }}
            >
              <Icon size={16} aria-hidden="true" />
              {label}
            </Button>
          ))}
        </nav>
        {customer.archivedAt && (
          <p role="status">
            Bu müşteri arşivlenmiş. Geçmiş bilgiler korunur; yeni işlem yapılamaz.
          </p>
        )}
        {seen('assignment') && (
          <section className="management-surface" hidden={section !== 'assignment'}>
            <h2>Kayıt sorumlusu</h2>
            <p>Müşteri kaydının sorumlusu değişir; görev atamaları değişmez.</p>
            {!customer.archivedAt && (
              <CustomerAssignmentSection customer={customer} onCustomerReload={reload} />
            )}
          </section>
        )}
        {seen('identity') && (
          <section className="management-surface" hidden={section !== 'identity'}>
            <h2>Kimlik bilgileri</h2>
            <p>TCKN/VKN bilgileri yalnız ayrıca yetkilendirilmiş çalışanlara açılır.</p>
            {!customer.archivedAt && (
              <CustomerIdentitySection customer={customer} onCustomerReload={reload} styles={{}} />
            )}
          </section>
        )}
        {seen('references') && (
          <section className="management-surface" hidden={section !== 'references'}>
            <h2>Dış sistem kayıtları</h2>
            <p>
              Başka bir sistemdeki müşteri numarasını kaydedin. Otomatik veri aktarımı yapılmaz.
            </p>
            {!customer.archivedAt && (
              <CustomerExternalReferencesSection customer={customer} onCustomerReload={reload} />
            )}
          </section>
        )}
        {seen('archive') && (
          <section className="management-surface" hidden={section !== 'archive'}>
            <h2>Müşteriyi arşivle</h2>
            <p>
              Arşivleme silme veya poliçe iptali değildir. Açık işler önce sonuçlandırılmalıdır.
            </p>
            <CustomerArchiveSection customer={customer} onCustomerReload={reload} />
          </section>
        )}
      </div>
    </LegacyCustomerBoundary>
  );
}
export default function CustomerManagementPage() {
  const { customerId = '' } = useParams();
  const resource = useCustomerResource<CustomerDetailDto>(
    `/api/customers/${encodeURIComponent(customerId)}`,
  );
  return resource.data ? (
    <Workspace key={resource.data.id} customer={resource.data} />
  ) : (
    <PolicyReadNotice {...resource} />
  );
}
