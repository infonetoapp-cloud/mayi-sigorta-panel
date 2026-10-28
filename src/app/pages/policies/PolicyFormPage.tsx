import { useState } from 'react';
import { Link, useLocation, useParams, useSearchParams } from 'react-router';
import type {
  CustomerDetailDto,
  PolicyDetailDto,
  SelectableCatalogsDto,
} from '../../../shared/types';
import { PageHeader } from '../../components/layout/PageContainer';
import { Button } from '../../components/ui/button';
import { NavigationDecision } from '../../components/layout/NavigationDecision';
import { useCustomerResource } from '../customers/customer-resource';
import { PolicyReadNotice } from './policy-display';
import { PolicyForm } from './PolicyForm';
import { PolicyCustomerPicker } from './PolicyCustomerPicker';
import { portfolioReturn } from './policy-portfolio';

function ReadyForm({
  customer,
  policy,
  onLockChange,
  onDirtyChange,
}: {
  customer: { id: string; displayName: string };
  policy?: PolicyDetailDto;
  onLockChange?: (locked: boolean) => void;
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const state = useCustomerResource<SelectableCatalogsDto>('/api/catalogs/selectable');
  return (
    <>
      <PolicyReadNotice {...state} />
      {state.data && (
        <PolicyForm
          customer={customer}
          policy={policy}
          catalogs={state.data}
          onLockChange={onLockChange}
          onDirtyChange={onDirtyChange}
        />
      )}
    </>
  );
}
function CustomerOrigin({
  id,
  onLockChange,
  onDirtyChange,
}: {
  id: string;
  onLockChange: (locked: boolean) => void;
  onDirtyChange: (dirty: boolean) => void;
}) {
  const state = useCustomerResource<CustomerDetailDto>(`/api/customers/${encodeURIComponent(id)}`);
  return (
    <>
      <PolicyReadNotice {...state} />
      {state.data &&
        (state.data.archivedAt || state.data.id !== id ? (
          <p role="alert">Kaynak müşteri kullanılamıyor; yeni poliçe oluşturulamaz.</p>
        ) : (
          <ReadyForm
            customer={state.data}
            onLockChange={onLockChange}
            onDirtyChange={onDirtyChange}
          />
        ))}
    </>
  );
}
function NewPolicy({ origin }: { origin: string | null }) {
  const [selected, setSelected] = useState(origin),
    [locked, setLocked] = useState(false),
    [dirty, setDirty] = useState(false),
    [proposed, setProposed] = useState<{ id: string | null } | null>(null);
  function choose(id: string | null) {
    if (locked || proposed || id === selected) return;
    if (dirty) setProposed({ id });
    else {
      setSelected(id);
      setDirty(false);
    }
  }
  return (
    <>
      <PolicyCustomerPicker selected={selected} locked={locked || !!proposed} onSelect={choose} />
      {proposed && (
        <NavigationDecision onStay={() => setProposed(null)}>
          <h3 id="navigation-decision-title">Müşteriyi değiştirmeden önce</h3>
          <p>
            Kaydedilmemiş poliçe taslağınız var. Müşteriyi değiştirmek bu taslağı bırakır; yeni
            müşteri ayrıca yetkili kayıttan doğrulanır.
          </p>
          <Button variant="outline" onClick={() => setProposed(null)}>
            Taslağı koru
          </Button>
          <Button
            disabled={locked}
            onClick={() => {
              if (locked) return;
              setSelected(proposed.id);
              setDirty(false);
              setProposed(null);
            }}
          >
            Taslağı bırak ve müşteriyi değiştir
          </Button>
        </NavigationDecision>
      )}
      {selected === '' ? (
        <p role="alert">Kaynak müşteri kullanılamıyor.</p>
      ) : selected ? (
        <CustomerOrigin
          key={selected}
          id={selected}
          onLockChange={setLocked}
          onDirtyChange={setDirty}
        />
      ) : (
        <p>Devam etmek için müşteriyi seçin.</p>
      )}
    </>
  );
}
function EditPolicy({ id }: { id: string }) {
  const state = useCustomerResource<PolicyDetailDto>(`/api/policies/${encodeURIComponent(id)}`);
  return (
    <>
      <PolicyReadNotice {...state} />
      {state.data &&
        (state.data.archivedAt || state.data.id !== id ? (
          <p role="alert">Arşivlenmiş veya kullanılamayan poliçe düzenlenemez.</p>
        ) : (
          <ReadyForm policy={state.data} customer={state.data.customer} />
        ))}
    </>
  );
}
export default function PolicyFormPage() {
  const { policyId } = useParams();
  const location = useLocation();
  const [params] = useSearchParams();
  const origin = params.get('customerId');
  return (
    <div
      className={`customer-modern policy-modern${policyId ? '' : ' premium-pilot pilot-policy'}`}
    >
      <PageHeader
        title={policyId ? 'Poliçeyi düzenle' : 'Yeni poliçe'}
        description="Poliçenin müşteri, dönem ve prim bilgilerini kaydedin."
      />
      <Link
        className="customer-back-link"
        to={
          policyId ? `/policies/${encodeURIComponent(policyId)}` : portfolioReturn(location.state)
        }
        state={location.state}
      >
        ← Poliçelere dön
      </Link>
      {policyId ? (
        <EditPolicy key={policyId} id={policyId} />
      ) : (
        <NewPolicy key={origin ?? 'no-origin'} origin={origin} />
      )}
    </div>
  );
}
