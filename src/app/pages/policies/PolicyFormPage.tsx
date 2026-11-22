import { useMemo, useState } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import type { PolicyDetailDto } from '../../../shared/types';
import { PageHeader } from '../../components/layout/PageContainer';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { useCustomerResource } from '../customers/customer-resource';
import { PolicyReadNotice } from './policy-display';
import { PolicyForm } from './PolicyForm';
import {
  policyDetailFor,
  policyFormCatalogsSchema,
  policyFormCustomerFor,
  policyFormCustomersSchema,
} from './policy-read-schemas';
function ReadyForm({
  customer,
  policy,
  onLockChange,
}: {
  customer: { id: string; displayName: string };
  policy?: PolicyDetailDto;
  onLockChange?: (locked: boolean) => void;
}) {
  const state = useCustomerResource('/api/catalogs/selectable', policyFormCatalogsSchema);
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
  const decoder = useMemo(() => policyFormCustomerFor(id), [id]);
  const state = useCustomerResource(`/api/customers/${encodeURIComponent(id)}`, decoder);
  return (
    <>
      <PolicyReadNotice {...state} />
      {state.data &&
        (state.data.archivedAt ? (
          <p role="alert">Kaynak müşteri kullanılamıyor; yeni poliçe oluşturulamaz.</p>
        ) : (
          <ReadyForm customer={state.data} onLockChange={onLockChange} />
        ))}
    </>
  );
}
function NewPolicy({ origin }: { origin: string | null }) {
  const [, setLocked] = useState(false);
  return origin !== null ? (
    <CustomerOrigin id={origin} onLockChange={setLocked} />
  ) : (
    <CustomerPicker />
  );
}
function CustomerPicker() {
  const [selected, setSelected] = useState<string | null>(null),
    [search, setSearch] = useState(''),
    [query, setQuery] = useState(''),
    [locked, setLocked] = useState(false);
  const params = new URLSearchParams({ limit: '20' });
  if (query) params.set('search', query);
  const choices = useCustomerResource(`/api/customers?${params}`, policyFormCustomersSchema);
  return (
    <>
      <form
        className="policy-filters customer-form-grid"
        onSubmit={(event) => {
          event.preventDefault();
          if (!locked) {
            const next = search.trim();
            if (next === query) choices.reload();
            else setQuery(next);
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
        <p className="customer-legacy-hint">Poliçenin düzenleneceği müşteriyi seçin.</p>
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
  const decoder = useMemo(() => policyDetailFor(id), [id]);
  const state = useCustomerResource(`/api/policies/${encodeURIComponent(id)}`, decoder);
  return (
    <>
      <PolicyReadNotice {...state} />
      {state.data &&
        (state.data.archivedAt || state.data.status !== 'ACTIVE' ? (
          <p role="alert">
            Arşivlenmiş, iptal edilmiş veya geçersiz poliçe sözleşmesi düzenlenemez.
          </p>
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
        description="Poliçe bilgilerini, dönemini ve ödeme yöntemini girin."
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
