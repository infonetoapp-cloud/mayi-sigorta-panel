import { useCallback } from 'react';
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
  const onCustomerCreate = useCallback(() => {
    void navigate('/customers/new');
  }, [navigate]);
  return (
    <>
      {customerMode && (
        <div className="customer-legacy-notice">
          {customerMode === 'advanced' ? (
            <h2>Atama, arşiv ve kimlik işlemleri</h2>
          ) : (
            <strong>Geçici klasik müşteri çalışma alanı</strong>
          )}
          <p>
            Oluşturma, düzenleme, atama, arşivleme, kimlik işlemleri ve poliçe ekleme mevcut güvenli
            arayüzle sürer.
          </p>
          <Link to={customerId ? `/customers/${encodeURIComponent(customerId)}` : '/customers'}>
            {customerId ? 'Modern müşteri profiline dön' : 'Modern müşteri listesine dön'}
          </Link>
          {customerMode === 'advanced' && customerId && (
            <>
              <p>
                Günlük iletişim ve poliçe işlemleri müşteri profilindedir. Burada sorumlu
                değişikliği, arşiv ve yetki gerektiren kimlik işlemleri bulunur. Her işlem kendi
                izin ve onaylarını korur.
              </p>
              <Link to={`/customers/${encodeURIComponent(customerId)}?section=contact`}>
                İletişim bilgilerine git
              </Link>
            </>
          )}
        </div>
      )}
      <App
        page={page}
        initialCustomerId={customerMode === 'advanced' ? customerId : undefined}
        onCustomerCreate={onCustomerCreate}
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
