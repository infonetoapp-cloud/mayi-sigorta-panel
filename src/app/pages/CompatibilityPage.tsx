import { Link, useNavigate, useParams } from 'react-router';
import { App, type TabType } from '../App';

/** Temporary adapter: keep domain forms, mutation protocols and task privacy
 * intact. Only replace tab navigation and the redundant legacy header. */
export default function CompatibilityPage({
  page,
  customerMode,
}: {
  page: TabType;
  customerMode?: 'advanced' | 'new' | 'legacy';
}) {
  const navigate = useNavigate();
  const { customerId } = useParams();
  return (
    <>
      {customerMode && (
        <div className="customer-legacy-notice">
          <strong>Geçici klasik müşteri çalışma alanı</strong>
          <p>
            Oluşturma, düzenleme, atama, arşivleme, kimlik işlemleri ve poliçe ekleme mevcut güvenli
            arayüzle sürer.
          </p>
          <Link to={customerId ? `/customers/${encodeURIComponent(customerId)}` : '/customers'}>
            {customerId ? 'Modern müşteri profiline dön' : 'Modern müşteri listesine dön'}
          </Link>
        </div>
      )}
      <App
        page={page}
        initialCustomerId={customerMode === 'advanced' ? customerId : undefined}
        createCustomer={customerMode === 'new'}
        onPolicyCreate={(customer) => {
          void navigate(`/policies/legacy?customerId=${encodeURIComponent(customer.id)}`);
        }}
        onNavigate={(tab) => {
          void navigate(
            tab === 'overview' ? '/' : tab === 'policies' ? '/policies/legacy' : `/${tab}`,
          );
        }}
      />
    </>
  );
}
