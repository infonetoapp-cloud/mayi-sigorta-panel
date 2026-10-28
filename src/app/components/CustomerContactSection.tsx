import { useEffect, useId, useRef, useState } from 'react';
import { z } from 'zod';
import type { ApiResponse, CustomerDetailDto, CustomerDto } from '../../shared/types';
import { getCsrfToken, parseAppError } from '../App';
import { useLegacyCustomerRisk } from './LegacyCustomerBoundary';

const fields = ['email', 'phone', 'address'] as const;
type ContactFields = { -readonly [Field in (typeof fields)[number]]: CustomerDto[Field] };
interface Attempt {
  readonly body: string;
  readonly key: string;
}
const nullable = (value: string) => value.trim() || null;
const fieldStyle = {
  width: '100%',
  boxSizing: 'border-box' as const,
  padding: '0.5rem 0.75rem',
  border: '1px solid #cbd5e1',
  borderRadius: '0.375rem',
  font: 'inherit',
};

export function CustomerContactSection({
  customer,
  onUpdated,
  presentation,
  onRiskChange,
}: {
  readonly customer: CustomerDetailDto;
  readonly onUpdated: (current: CustomerDetailDto) => void;
  readonly presentation?: 'page';
  readonly onRiskChange?: (risk: { dirty: boolean; unresolved: boolean }) => void;
}) {
  const formId = useId();
  const [editing, setEditing] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [base, setBase] = useState(customer);
  const [draft, setDraft] = useState({ email: '', phone: '', address: '' });
  const [latest, setLatest] = useState<CustomerDetailDto | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [needsRefresh, setNeedsRefresh] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [saved, setSaved] = useState(false);
  const [retry, setRetry] = useState<Attempt | null>(null);
  const attempt = useRef<Attempt | null>(null);
  const generation = useRef(0);
  useEffect(
    () => () => {
      generation.current++;
    },
    [],
  );
  const archived = customer.archivedAt !== null || latest?.archivedAt != null;
  const changes: Partial<ContactFields> = {};
  for (const field of fields) {
    const value = nullable(draft[field]);
    if (value !== (base[field] ?? null)) changes[field] = value;
  }
  const body = JSON.stringify({ expectedVersion: latest?.version ?? base.version, ...changes });
  const dirty = Object.keys(changes).length > 0;
  useLegacyCustomerRisk(editing && dirty, busy || !!retry || saved);
  const frozen = presentation === 'page' && (!!retry || saved);
  useEffect(() => {
    onRiskChange?.({ dirty: editing && dirty, unresolved: busy || !!retry || saved });
  }, [onRiskChange, editing, dirty, busy, retry, saved]);
  useEffect(() => () => onRiskChange?.({ dirty: false, unresolved: false }), [onRiskChange]);

  async function readCurrent(): Promise<CustomerDetailDto> {
    const response = await fetch(`/api/customers/${encodeURIComponent(customer.id)}`, {
      cache: 'no-store',
    });
    const envelope = (await response.json()) as ApiResponse<CustomerDetailDto>;
    if (!response.ok || !envelope.success) {
      parseAppError(response.status, !envelope.success ? envelope.error : null);
      throw new Error('REFRESH_FAILED');
    }
    if (envelope.data.id !== customer.id || !Number.isSafeInteger(envelope.data.version))
      throw new Error('INVALID_RESPONSE');
    return envelope.data;
  }

  async function refresh() {
    const currentGeneration = generation.current;
    setBusy(true);
    setError('');
    try {
      const current = await readCurrent();
      if (currentGeneration !== generation.current) return;
      if (saved) {
        onUpdated(current);
        setEditing(false);
        setSaved(false);
        setConfirmed(true);
      } else {
        setLatest(current);
        setNeedsRefresh(false);
        setBlocked(false);
        setRetry(null);
      }
    } catch {
      if (currentGeneration === generation.current) {
        setNeedsRefresh(true);
        setError('Güncel bilgiler yüklenemedi veya kayda erişilemiyor. Taslağınız korundu.');
      }
    } finally {
      if (currentGeneration === generation.current) setBusy(false);
    }
  }

  async function save(snapshot: Attempt) {
    if (busy || archived || blocked || needsRefresh || saved) return;
    const currentGeneration = generation.current;
    setBusy(true);
    setError('');
    setRetry(null);
    try {
      const csrf = await getCsrfToken();
      if (currentGeneration !== generation.current) return;
      const response = await fetch(`/api/customers/${encodeURIComponent(customer.id)}`, {
        method: 'PATCH',
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': snapshot.key,
        },
        body: snapshot.body,
      });
      const envelope = (await response.json()) as ApiResponse<CustomerDto>;
      if (currentGeneration !== generation.current) return;
      if (!response.ok || !envelope.success) {
        const info = parseAppError(response.status, !envelope.success ? envelope.error : null);
        setError(
          response.status === 409
            ? 'Kayıt başka bir işlemde değişti. Taslağınız korundu; güncel bilgileri yükleyip karşılaştırın.'
            : info.message,
        );
        if (response.status === 409) setNeedsRefresh(true);
        if ([401, 403, 404].includes(response.status) && !info.isRetryable) setBlocked(true);
        if (info.isRetryable) setRetry(snapshot);
        return;
      }
      setSaved(true);
      attempt.current = null;
      try {
        const current = await readCurrent();
        if (currentGeneration !== generation.current) return;
        onUpdated(current);
        setEditing(false);
        setSaved(false);
        setConfirmed(true);
      } catch {
        if (currentGeneration === generation.current)
          setError(
            'Değişiklikler kaydedildi, ancak güncel detaylar yüklenemedi. Bilgileri yeniden yükleyin; tekrar kayıt gönderilmeyecek.',
          );
      }
    } catch {
      if (currentGeneration === generation.current) {
        setError(
          'Yanıt alınamadı. Taslağınız korundu; aynı isteği güvenli biçimde tekrar deneyebilirsiniz.',
        );
        setRetry(snapshot);
      }
    } finally {
      if (currentGeneration === generation.current) setBusy(false);
    }
  }

  if (!editing)
    return (
      <>
        {confirmed && <p role="status">İletişim bilgileri kaydedildi.</p>}
        {customer.archivedAt === null ? (
          <button
            type="button"
            onClick={() => {
              setBase(customer);
              setDraft({
                email: customer.email ?? '',
                phone: customer.phone ?? '',
                address: customer.address ?? '',
              });
              setLatest(null);
              setError('');
              setNeedsRefresh(false);
              setBlocked(false);
              setSaved(false);
              setRetry(null);
              attempt.current = null;
              setConfirmed(false);
              setEditing(true);
            }}
          >
            {presentation === 'page' ? 'Düzenle' : 'İletişim bilgilerini düzenle'}
          </button>
        ) : null}
      </>
    );

  return (
    <section
      aria-label="İletişim bilgilerini düzenleme"
      className={presentation === 'page' ? 'customer-edit-form' : undefined}
      style={{
        padding: '1rem',
        border: '1px solid #e2e8f0',
        borderRadius: '0.5rem',
        background: '#f8fafc',
      }}
    >
      <h3>İletişim bilgileri</h3>
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (archived || blocked || needsRefresh || saved || busy || frozen || !dirty) return;
          if (nullable(draft.email) && !z.email().safeParse(draft.email.trim()).success) {
            setError('Geçerli bir e-posta adresi girin.');
            return;
          }
          if (draft.phone.trim().length > 50 || draft.address.trim().length > 1000) {
            setError('Telefon en fazla 50, adres en fazla 1000 karakter olabilir.');
            return;
          }
          const snapshot =
            attempt.current?.body === body ? attempt.current : { body, key: crypto.randomUUID() };
          attempt.current = snapshot;
          void save(snapshot);
        }}
      >
        <fieldset
          disabled={busy || archived || blocked || saved || frozen}
          style={{ border: 0, padding: 0, display: 'grid', gap: '0.75rem' }}
        >
          <div>
            <label htmlFor={`${formId}-email`}>E-posta</label>
            <input
              id={`${formId}-email`}
              style={fieldStyle}
              type="email"
              autoComplete="email"
              value={draft.email}
              onChange={(event) =>
                setDraft((previous) => ({ ...previous, email: event.target.value }))
              }
            />
          </div>
          <div>
            <label htmlFor={`${formId}-phone`}>Telefon</label>
            <input
              id={`${formId}-phone`}
              style={fieldStyle}
              type="tel"
              autoComplete="tel"
              maxLength={50}
              value={draft.phone}
              onChange={(event) =>
                setDraft((previous) => ({ ...previous, phone: event.target.value }))
              }
            />
          </div>
          <div>
            <label htmlFor={`${formId}-address`}>Adres</label>
            <textarea
              id={`${formId}-address`}
              style={fieldStyle}
              rows={3}
              autoComplete="street-address"
              maxLength={1000}
              value={draft.address}
              onChange={(event) =>
                setDraft((previous) => ({ ...previous, address: event.target.value }))
              }
            />
          </div>
        </fieldset>
        <p>Boş bıraktığınız alan temizlenir. Yalnız değiştirdiğiniz alanlar kaydedilir.</p>
        {latest && (
          <div role="status">
            <p>Sunucudaki güncel bilgiler (taslağınız değiştirilmedi):</p>
            <dl>
              {fields.map((field) => (
                <div key={field}>
                  <dt>
                    {field === 'email'
                      ? 'Güncel e-posta'
                      : field === 'phone'
                        ? 'Güncel telefon'
                        : 'Güncel adres'}
                  </dt>
                  <dd>{latest[field] || 'Belirtilmemiş'}</dd>
                </div>
              ))}
            </dl>
            <p>
              Farkları kontrol edin. Kaydetmeniz, yalnız değiştirdiğiniz alanlar için açık
              onayınızdır.
            </p>
          </div>
        )}
        {archived && <p role="alert">Bu müşteri arşivlenmiş; iletişim bilgileri düzenlenemez.</p>}
        {error && <p role="alert">{error}</p>}
        {busy && <p role="status">İşlem sürüyor…</p>}
        <div style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}>
          {!saved && (
            <button
              type="submit"
              disabled={busy || archived || blocked || needsRefresh || frozen || !dirty}
            >
              {latest
                ? 'Karşılaştırdım, iletişim bilgilerini kaydet'
                : 'İletişim bilgilerini kaydet'}
            </button>
          )}
          {(needsRefresh || blocked || saved) && (
            <button type="button" disabled={busy} onClick={() => void refresh()}>
              Güncel bilgileri yükle
            </button>
          )}
          {retry && retry.body === body && !needsRefresh && !blocked && !saved && (
            <button type="button" disabled={busy || archived} onClick={() => void save(retry)}>
              Aynı isteği tekrar dene
            </button>
          )}
          <button
            type="button"
            disabled={busy || frozen}
            onClick={() => {
              generation.current++;
              setEditing(false);
            }}
          >
            Vazgeç
          </button>
        </div>
      </form>
    </section>
  );
}
