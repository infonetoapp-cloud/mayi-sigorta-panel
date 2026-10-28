import { Link, useLocation, useNavigate, useParams } from 'react-router';
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
  const location = useLocation();
  const { customerId } = useParams();
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
          <Link
            to={customerId ? `/customers/${encodeURIComponent(customerId)}` : '/customers'}
            state={location.state}
          >
            {customerId ? 'Modern müşteri profiline dön' : 'Modern müşteri listesine dön'}
          </Link>
          {customerMode === 'advanced' && customerId && (
            <>
              <p>
                Günlük iletişim ve poliçe işlemleri müşteri profilindedir. Burada sorumlu
                değişikliği, arşiv ve yetki gerektiren kimlik işlemleri bulunur. Her işlem kendi
                izin ve onaylarını korur.
              </p>
              <Link
                to={`/customers/${encodeURIComponent(customerId)}?section=contact`}
                state={location.state}
              >
                İletişim bilgilerine git
              </Link>
            </>
          )}
        </div>
      )}
      <App
        page={page}
        initialCustomerId={customerMode === 'advanced' ? customerId : undefined}
        onCustomerDetailClose={
          customerMode === 'advanced' && customerId
            ? () => {
                void navigate(`/customers/${encodeURIComponent(customerId)}`, {
                  state: location.state,
                });
              }
            : undefined
        }
        createCustomer={customerMode === 'new'}
        onPolicyCreate={(customer) => {
          void navigate(`/policies/legacy?customerId=${encodeURIComponent(customer.id)}`, {
            state: location.state,
          });
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
