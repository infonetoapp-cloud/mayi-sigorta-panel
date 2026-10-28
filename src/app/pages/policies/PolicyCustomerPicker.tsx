import { useEffect, useState } from 'react';
import { ChevronDown, Search, UserRound } from 'lucide-react';
import type { CustomerListResponseData } from '../../../shared/types';
import { Input } from '../../components/ui/input';
import { useCustomerResource } from '../customers/customer-resource';
import { PolicyReadNotice } from './policy-display';

/** Search is read-only and bounded. A result never selects itself or changes the contract target. */
export function PolicyCustomerPicker({
  selected,
  locked,
  onSelect,
}: {
  selected: string | null;
  locked: boolean;
  onSelect: (id: string | null) => void;
}) {
  const [search, setSearch] = useState('');
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState(!selected);
  useEffect(() => {
    if (locked) return;
    const timer = setTimeout(() => setQuery(search.trim()), 300);
    return () => clearTimeout(timer);
  }, [search, locked]);
  useEffect(() => {
    setExpanded(!selected);
  }, [selected]);
  const params = new URLSearchParams({ limit: '20' });
  if (query) params.set('search', query);
  const choices = useCustomerResource<CustomerListResponseData>(`/api/customers?${params}`);
  return (
    <details className="pilot-customer-picker" open={expanded || !selected}>
      <summary
        onClick={(event) => {
          event.preventDefault();
          if (!locked) setExpanded((value) => !value);
        }}
        aria-disabled={locked || undefined}
      >
        <span>
          <UserRound size={16} aria-hidden="true" />
          {selected ? 'Müşteriyi değiştir' : 'Müşteri seçimi'}
        </span>
        <ChevronDown size={16} aria-hidden="true" />
      </summary>
      <form
        className="policy-filters pilot-picker-fields"
        aria-label="Poliçe müşterisi seçimi"
        onSubmit={(event) => {
          event.preventDefault();
          if (!locked) setQuery(search.trim());
        }}
      >
        <div>
          <label htmlFor="policy-customer-search">Müşteri ara</label>
          <div className="pilot-search-input">
            <Search size={16} aria-hidden="true" />
            <Input
              id="policy-customer-search"
              value={search}
              maxLength={200}
              placeholder="Ad veya unvan yazın"
              disabled={locked}
              onChange={(event) => setSearch(event.target.value)}
            />
          </div>
        </div>
        <div>
          <label htmlFor="policy-customer">Müşteri</label>
          <select
            id="policy-customer"
            value={selected ?? ''}
            disabled={locked || choices.loading}
            onChange={(event) => {
              if (!locked) onSelect(event.target.value || null);
            }}
          >
            <option value="">Müşteriyi açıkça seçin</option>
            {selected && !choices.data?.items.some((item) => item.id === selected) && (
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
        <p className="pilot-picker-hint">
          Arama en fazla 20 yetkili kayıt getirir. Sonuçlardan müşteriyi açıkça seçin; seçim taslağı
          kendiliğinden değiştirmez.
        </p>
        <PolicyReadNotice {...choices} />
      </form>
    </details>
  );
}
