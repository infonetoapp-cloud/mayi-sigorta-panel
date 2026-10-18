import { useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import type {
  CustomerDetailDto,
  CustomerListResponseData,
  PolicyDetailDto,
  SelectableCatalogsDto,
} from '../../../shared/types';
import { PageHeader } from '../../components/layout/PageContainer';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { useCustomerResource } from '../customers/customer-resource';
import { PolicyReadNotice } from './policy-display';
import { PolicyForm } from './PolicyForm';
function ReadyForm({
  customer,
  policy,
  onLockChange,
}: {
  customer: { id: string; displayName: string };
  policy?: PolicyDetailDto;
  onLockChange?: (locked: boolean) => void;
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
        />
      )}
    </>
  );
}
function CustomerOrigin({
  id,
  onLockChange,
}: {
  id: string;
  onLockChange: (locked: boolean) => void;
}) {
  const state = useCustomerResource<CustomerDetailDto>(`/api/customers/${encodeURIComponent(id)}`);
  return (
    <>
      <PolicyReadNotice {...state} />
      {state.data &&
        (state.data.archivedAt || state.data.id !== id ? (
          <p role="alert">Kaynak müşteri kullanılamıyor; yeni poliçe oluşturulamaz.</p>
        ) : (
          <ReadyForm customer={state.data} onLockChange={onLockChange} />
        ))}
    </>
  );
}
function NewPolicy({ origin }: { origin: string | null }) {
  const [selected, setSelected] = useState(origin),
    [search, setSearch] = useState(''),
    [query, setQuery] = useState(''),
    [locked, setLocked] = useState(false);
  const params = new URLSearchParams({ limit: '20' });
  if (query) params.set('search', query);
  const choices = useCustomerResource<CustomerListResponseData>(`/api/customers?${params}`);
  return (
    <>
      <form
        className="policy-filters customer-form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          if (!locked) {
            setQuery(search.trim());
            choices.reload();
          }
        }}
      >
        <div>
          <label htmlFor="policy-customer-search">Müşteri ara</label>
          <Input
            id="policy-customer-search"
            value={search}
            maxLength={200}
            disabled={locked}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <Button type="submit" disabled={locked}>
          Müşterileri ara
        </Button>
        <div>
          <label htmlFor="policy-customer">Müşteri</label>
          <select
            id="policy-customer"
            value={selected ?? ''}
            disabled={locked}
            onChange={(event) => {
              setSelected(event.target.value || null);
              setLocked(false);
            }}
          >
            <option value="">Müşteri seçin</option>
            {selected && !choices.data?.items.some((x) => x.id === selected) && (
              <option value={selected}>Seçili kaynak müşteri</option>
            )}
            {choices.data?.items.map((item) => (
              <option key={item.id} value={item.id} disabled={!!item.archivedAt}>
                {item.displayName}
                {item.archivedAt ? ' (Arşivlenmiş)' : ''}
              </option>
            ))}
          </select>
        </div>
        <p className="customer-legacy-hint">
          Arama sunucuda en fazla 20 müşteri getirir; tüm portföy yüklenmez. Müşteriyi açıkça
          değiştirmek sözleşme taslağını sıfırlar.
        </p>
      </form>
      <PolicyReadNotice {...choices} />
      {selected === '' ? (
        <p role="alert">Kaynak müşteri kullanılamıyor.</p>
      ) : selected ? (
        <CustomerOrigin key={selected} id={selected} onLockChange={setLocked} />
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
  const [params] = useSearchParams();
  const origin = params.get('customerId');
  return (
    <div className="customer-modern policy-modern">
      <PageHeader
        title={policyId ? 'Poliçeyi düzenle' : 'Yeni poliçe'}
        description="Mevcut güvenli poliçe API'siyle tek sözleşme dönemini kaydedin."
      />
      <Link
        className="customer-back-link"
        to={policyId ? `/policies/${encodeURIComponent(policyId)}` : '/policies'}
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
