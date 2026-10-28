import { useEffect, useRef, useState } from 'react';
import type { CustomerDetailDto, CustomerListResponseData } from '../../../shared/types';
import { useCustomerResource, readCustomerResource } from '../customers/customer-resource';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { PolicyReadNotice } from './policy-display';
export interface PartyCustomer {
  id: string;
  displayName: string;
}
export function PartyCustomerPicker({
  disabled,
  onSelected,
}: {
  disabled: boolean;
  onSelected: (customer: PartyCustomer | null) => void;
}) {
  const [search, setSearch] = useState(''),
    [query, setQuery] = useState(''),
    [id, setId] = useState(''),
    [name, setName] = useState(''),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false);
  const request = useRef<AbortController | null>(null),
    sequence = useRef(0);
  useEffect(
    () => () => {
      sequence.current++;
      request.current?.abort();
    },
    [],
  );
  const params = new URLSearchParams({ limit: '20' });
  if (query) params.set('search', query);
  const state = useCustomerResource<CustomerListResponseData>(`/api/customers?${params}`);
  function clear() {
    sequence.current++;
    request.current?.abort();
    setId('');
    setName('');
    setError('');
    setBusy(false);
    onSelected(null);
  }
  async function select(next: string) {
    clear();
    setId(next);
    if (!next) return;
    const epoch = sequence.current,
      controller = new AbortController();
    request.current = controller;
    setBusy(true);
    try {
      const c = await readCustomerResource<CustomerDetailDto>(
        `/api/customers/${encodeURIComponent(next)}`,
        controller.signal,
      );
      if (epoch !== sequence.current) return;
      if (c.id !== next || c.archivedAt) throw new Error('UNAVAILABLE');
      setName(c.displayName);
      onSelected({ id: c.id, displayName: c.displayName });
    } catch {
      if (epoch === sequence.current) {
        setError(
          'Seçilen müşteri kullanılamıyor veya bu müşteriye erişiminiz yok. Başka müşteri otomatik seçilmedi.',
        );
        onSelected(null);
      }
    } finally {
      if (epoch === sequence.current) setBusy(false);
    }
  }
  return (
    <fieldset disabled={disabled}>
      <div className="customer-form-grid">
        <div>
          <label htmlFor="party-search">Müşteri ara</label>
          <Input
            id="party-search"
            value={search}
            maxLength={200}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <Button
          variant="outline"
          onClick={() => {
            clear();
            setQuery(search.trim());
            state.reload();
          }}
        >
          Müşterileri ara
        </Button>
        <div>
          <label htmlFor="party-customer">Müşteri seçimi</label>
          <select
            id="party-customer"
            value={id}
            disabled={busy}
            onChange={(event) => void select(event.target.value)}
          >
            <option value="">Açıkça müşteri seçin</option>
            {state.data?.items.map((c) => (
              <option key={c.id} value={c.id} disabled={!!c.archivedAt}>
                {c.displayName}
                {c.archivedAt ? ' (Arşivlenmiş)' : ''}
              </option>
            ))}
          </select>
        </div>
      </div>
      <PolicyReadNotice {...state} />
      {busy && <p role="status">Müşteri erişimi doğrulanıyor…</p>}
      {name && <p>Doğrulanan müşteri: {name}</p>}
      {error && <p role="alert">{error}</p>}
      <p className="customer-legacy-hint">
        En fazla 20 sonuç gösterilir; daha dar arayın. Bağlantı, kişinin müşteri profiline veya
        diğer poliçelerine erişim hakkı vermez.
      </p>
    </fieldset>
  );
}
