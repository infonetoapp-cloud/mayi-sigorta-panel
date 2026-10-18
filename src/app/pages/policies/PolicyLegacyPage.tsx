import { Link, useSearchParams } from 'react-router';
import type { CustomerDetailDto } from '../../../shared/types';
import { PageHeader } from '../../components/layout/PageContainer';
import { PolicyPanel } from '../../components/PolicyPanel';
import { useCustomerResource } from '../customers/customer-resource';
import { PolicyReadNotice } from './policy-display';
function CustomerHandoff({ id }: { id: string }) {
  const state = useCustomerResource<CustomerDetailDto>(`/api/customers/${encodeURIComponent(id)}`);
  return (
    <>
      <PolicyReadNotice {...state} />
      {state.data &&
        (state.data.archivedAt ? (
          <p role="alert">Arşivlenmiş müşteri için yeni poliçe oluşturulamaz.</p>
        ) : (
          <PolicyPanel initialCustomer={state.data} />
        ))}
    </>
  );
}
export default function PolicyLegacyPage() {
  const [params] = useSearchParams();
  const customerId = params.get('customerId');
  return (
    <div className="customer-modern">
      <PageHeader title="Poliçe işlemleri — klasik çalışma alanı" />
      <div className="customer-legacy-notice">
        <strong>Mevcut güvenli poliçe işlem formları</strong>
        <p>
          Oluşturma, düzenleme, atama, sigortalılar, zeyiller, referanslar, arşivleme ve güvenli
          onay akışları değiştirilmedi.
        </p>
        <Link to="/policies">Modern poliçe listesine dön</Link>
      </div>
      {customerId ? <CustomerHandoff key={customerId} id={customerId} /> : <PolicyPanel />}
    </div>
  );
}
