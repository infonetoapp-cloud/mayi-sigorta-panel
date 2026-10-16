import { useCallback, useEffect, useRef, useState } from 'react';
import type { PolicyDetailDto, PolicyDto, PolicyListResponseData } from '../../shared/types';

export type RenewalResultPolicy = Pick<
  PolicyDetailDto,
  'id' | 'version' | 'policyNumber' | 'grossPremiumMinor' | 'currency' | 'product'
>;

export function completionMoney(minor: number, currency: string): string {
  const value = BigInt(minor);
  return `${value / 100n},${String(value % 100n).padStart(2, '0')} ${currency}`;
}

export function RenewalPolicySelector({
  customerId,
  customerName,
  selected,
  onSelect,
  disabled,
  refreshKey = 0,
}: {
  readonly customerId?: string;
  readonly customerName: string;
  readonly selected: RenewalResultPolicy | null;
  readonly onSelect: (policy: RenewalResultPolicy | null) => void;
  readonly disabled: boolean;
  readonly refreshKey?: number;
}) {
  const [search, setSearch] = useState('');
  const [appliedSearch, setAppliedSearch] = useState('');
  const [items, setItems] = useState<readonly PolicyDto[]>([]);
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [failedCursor, setFailedCursor] = useState<string | null | undefined>();
  const listGeneration = useRef(0);
  const detailGeneration = useRef(0);
  const load = useCallback(
    async (cursor: string | null = null) => {
      const generation = ++listGeneration.current;
      setBusy(true);
      setError('');
      setFailedCursor(undefined);
      try {
        const query = new URLSearchParams({
          status: 'ACTIVE',
          pageSize: '25',
          sort: 'end_date_desc',
        });
        if (customerId) query.set('customerId', customerId);
        if (appliedSearch) {
          query.set('search', appliedSearch);
          query.set('searchMode', 'prefix');
        }
        if (cursor) query.set('cursor', cursor);
        const response = await fetch(`/api/policies?${query}`, { cache: 'no-store' });
        if (!response.ok) throw new Error();
        const envelope = (await response.json()) as {
          success: boolean;
          data: PolicyListResponseData;
        };
        if (!envelope.success || !Array.isArray(envelope.data?.items)) throw new Error();
        if (generation !== listGeneration.current) return;
        setItems((previous) =>
          cursor
            ? [
                ...previous,
                ...envelope.data.items.filter((item) => !previous.some((p) => p.id === item.id)),
              ]
            : envelope.data.items,
        );
        setNextCursor(envelope.data.nextCursor);
      } catch {
        if (generation !== listGeneration.current) return;
        setError('Poliçeler yüklenemedi veya erişim izniniz yok.');
        setFailedCursor(cursor);
        if (!cursor) {
          setItems([]);
          setNextCursor(null);
        }
      } finally {
        if (generation === listGeneration.current) setBusy(false);
      }
    },
    [appliedSearch, customerId],
  );
  useEffect(() => {
    void load();
    return () => {
      listGeneration.current++;
      detailGeneration.current++;
    };
  }, [load, refreshKey]);

  async function select(id: string) {
    const generation = ++detailGeneration.current;
    onSelect(null);
    if (!id) return;
    setBusy(true);
    setError('');
    try {
      const response = await fetch(`/api/policies/${encodeURIComponent(id)}`, {
        cache: 'no-store',
      });
      if (!response.ok) throw new Error();
      const envelope = (await response.json()) as { success: boolean; data: RenewalResultPolicy };
      const policy = envelope.data;
      if (
        !envelope.success ||
        policy?.id !== id ||
        !Number.isSafeInteger(policy.version) ||
        policy.version < 1 ||
        !Number.isSafeInteger(policy.grossPremiumMinor) ||
        policy.grossPremiumMinor < 0 ||
        !/^[A-Z]{3}$/.test(policy.currency) ||
        !policy.product?.id
      )
        throw new Error();
      if (generation === detailGeneration.current) onSelect(policy);
    } catch {
      if (generation === detailGeneration.current)
        setError('Seçilen poliçeye erişilemiyor. Listeyi yenileyip başka poliçe seçin.');
    } finally {
      if (generation === detailGeneration.current) setBusy(false);
    }
  }

  function searchPolicies() {
    if (busy || disabled) return;
    detailGeneration.current++;
    onSelect(null);
    setItems([]);
    setNextCursor(null);
    if (search.trim() === appliedSearch) void load();
    else setAppliedSearch(search.trim());
  }

  return (
    <fieldset disabled={disabled}>
      <legend>Yeni dönem poliçesi</legend>
      <label>
        Poliçe numarasıyla ara: {customerName}
        <input
          value={search}
          maxLength={100}
          onChange={(event) => setSearch(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              searchPolicies();
            }
          }}
        />
      </label>
      <button type="button" disabled={busy} onClick={searchPolicies}>
        Poliçeleri ara
      </button>
      <label>
        Bağlanacak poliçe: {customerName}
        <select
          value={selected?.id ?? ''}
          disabled={busy}
          onChange={(event) => void select(event.target.value)}
          required
        >
          <option value="">Poliçe seçin</option>
          {selected && !items.some((item) => item.id === selected.id) && (
            <option value={selected.id}>{selected.policyNumber}</option>
          )}
          {items.map((item) => (
            <option key={item.id} value={item.id}>
              {item.policyNumber} — {item.endDate}
            </option>
          ))}
        </select>
      </label>
      {selected && (
        <p>
          Seçilen poliçe: {selected.policyNumber} ·{' '}
          {completionMoney(selected.grossPremiumMinor, selected.currency)}
        </p>
      )}
      {busy && <p role="status">Poliçe bilgileri yükleniyor…</p>}
      {error && <p role="alert">{error}</p>}
      {!busy && !error && items.length === 0 && <p>Bu aramada seçilebilir poliçe bulunamadı.</p>}
      <button
        type="button"
        disabled={busy}
        onClick={() => {
          detailGeneration.current++;
          onSelect(null);
          void load();
        }}
      >
        Poliçe listesini yenile / yeniden seç
      </button>
      {failedCursor !== undefined && (
        <button type="button" disabled={busy} onClick={() => void load(failedCursor)}>
          Poliçe listesini yeniden dene
        </button>
      )}
      {nextCursor && (
        <button type="button" disabled={busy} onClick={() => void load(nextCursor)}>
          Daha fazla poliçe
        </button>
      )}
    </fieldset>
  );
}
