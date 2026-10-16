import { useEffect, useRef, useState } from 'react';
import type { ApiResponse } from '../../shared/types';
import { RenewalWorkspacePanel } from './RenewalWorkspacePanel';

interface RenewalSummary {
  id: string;
  state: string;
  version: number;
  policyNumber: string;
  policyEndDate: string;
}
interface Props {
  customerId: string;
  customerDisplayName: string;
  getCsrfToken: () => Promise<string>;
  invalidateCsrfToken: () => void;
}

// Mounted with a customer key: private task state is never fetched or forwarded here.
export function CustomerRenewalsSection(props: Props) {
  const [items, setItems] = useState<RenewalSummary[]>([]);
  const [opened, setOpened] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [cursor, setCursor] = useState<string | null>(null);
  const [failedCursor, setFailedCursor] = useState<string | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  async function load(after: string | null) {
    const request = ++generation.current;
    setLoading(true);
    setError(false);
    setOpened(true);
    try {
      const query = after ? `?cursor=${encodeURIComponent(after)}` : '';
      const response = await fetch(
        `/api/customers/${encodeURIComponent(props.customerId)}/renewals${query}`,
        { cache: 'no-store' },
      );
      if (!response.ok) throw new Error('READ_FAILED');
      const result = (await response.json()) as ApiResponse<{
        items: RenewalSummary[];
        nextCursor: string | null;
      }>;
      if (!result.success) throw new Error('READ_FAILED');
      if (generation.current !== request) return;
      setItems((previous) => (after ? [...previous, ...result.data.items] : result.data.items));
      setCursor(result.data.nextCursor);
    } catch {
      if (generation.current !== request) return;
      setError(true);
      setFailedCursor(after);
    } finally {
      if (generation.current === request) setLoading(false);
    }
  }
  return (
    <section aria-label="Müşteri yenileme görüşmeleri">
      <h3>Yenileme görüşmeleri ve teklifler</h3>
      <p>
        Bu kayıtlar ilgili poliçenin yenilemesine aittir; genel müşteri notu değildir. Çalışanların
        özel görev listeleri burada gösterilmez.
      </p>
      {!opened && (
        <button type="button" onClick={() => void load(null)}>
          Yenileme kayıtlarını aç
        </button>
      )}
      {loading && <p role="status">Yenilemeler yükleniyor…</p>}
      {error && (
        <div role="alert">
          Yenileme kayıtları okunamadı.{' '}
          <button type="button" disabled={loading} onClick={() => void load(failedCursor)}>
            Aynı sayfayı yeniden dene
          </button>
        </div>
      )}
      {opened && !loading && !error && !items.length && <p>Görüntülenebilir yenileme kaydı yok.</p>}
      {items.map((item) => (
        <article key={item.id}>
          <button
            type="button"
            aria-expanded={selectedId === item.id}
            onClick={() => setSelectedId((previous) => (previous === item.id ? null : item.id))}
          >
            {item.policyNumber} — yenileme görüşmelerini ve teklifleri{' '}
            {selectedId === item.id ? 'kapat' : 'aç'}
          </button>
          {selectedId === item.id && (
            <RenewalWorkspacePanel
              key={item.id}
              renewalId={item.id}
              customerId={props.customerId}
              customerDisplayName={props.customerDisplayName}
              renewalVersion={item.version}
              renewalState={item.state}
              getCsrfToken={props.getCsrfToken}
              invalidateCsrfToken={props.invalidateCsrfToken}
            />
          )}
        </article>
      ))}
      {cursor && !error && (
        <button type="button" disabled={loading} onClick={() => void load(cursor)}>
          Daha fazla yenileme
        </button>
      )}
    </section>
  );
}
