import { useEffect, useRef, useState } from 'react';
import { z } from 'zod';
import { istanbulToday, validBirthDate } from '../../shared/customer-profile';
import { CustomerReferenceField } from '../pages/customers/CustomerReferenceField';
import { Button } from './ui/button';
import { CustomerEditDialog } from './CustomerEditDialog';
import type { ApiResponse, CustomerDetailDto, CustomerDto } from '../../shared/types';
import { getCsrfToken, parseAppError } from '../App';

const fields = [
  'email',
  'phone',
  'address',
  'birthDate',
  'referenceMembershipId',
  'referenceName',
] as const;
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
}: {
  readonly customer: CustomerDetailDto;
  readonly onUpdated: (current: CustomerDetailDto) => void;
  readonly presentation?: 'page';
}) {
  const [editing, setEditing] = useState(false);
  const [confirmed, setConfirmed] = useState(false);
  const [base, setBase] = useState(customer);
  const [draft, setDraft] = useState({
    email: '',
    phone: '',
    address: '',
    birthDate: '',
    referenceMembershipId: '',
    referenceName: '',
  });
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

  const trigger = (
    <>
      {confirmed && <p role="status">İletişim bilgileri kaydedildi.</p>}
      {customer.archivedAt === null ? (
        <Button
          variant="outline"
          type="button"
          onClick={() => {
            setBase(customer);
            setDraft({
              email: customer.email ?? '',
              phone: customer.phone ?? '',
              address: customer.address ?? '',
              birthDate: customer.birthDate ?? '',
              referenceMembershipId: customer.referenceMembershipId ?? '',
              referenceName: customer.referenceName ?? '',
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
        </Button>
      ) : null}
    </>
  );
  function cancel() {
    generation.current++;
    setEditing(false);
  }

  const editor = editing && (
    <section
      aria-label="İletişim bilgilerini düzenleme"
      className={presentation === 'page' ? 'customer-edit-dialog-form' : undefined}
      style={
        presentation
          ? undefined
          : {
              padding: '1rem',
              border: '1px solid #e2e8f0',
              borderRadius: '0.5rem',
              background: '#f8fafc',
            }
      }
    >
      {!presentation && <h3>İletişim bilgileri</h3>}
      <form
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          if (archived || blocked || needsRefresh || saved || busy || !dirty) return;
          if (nullable(draft.email) && !z.email().safeParse(draft.email.trim()).success) {
            setError('Geçerli bir e-posta adresi girin.');
            return;
          }
          if (draft.phone.trim().length > 50 || draft.address.trim().length > 1000) {
            setError('Telefon en fazla 50, adres en fazla 1000 karakter olabilir.');
            return;
          }
          if (
            customer.type === 'INDIVIDUAL' &&
            draft.birthDate &&
            (!validBirthDate(draft.birthDate) || draft.birthDate > istanbulToday())
          ) {
            setError('Geçerli, gelecekte olmayan bir doğum tarihi girin.');
            return;
          }
          const snapshot =
            attempt.current?.body === body ? attempt.current : { body, key: crypto.randomUUID() };
          attempt.current = snapshot;
          void save(snapshot);
        }}
      >
        <fieldset
          disabled={busy || archived || blocked || saved}
          style={{ border: 0, padding: 0, display: 'grid', gap: '0.75rem' }}
        >
          <legend className="sr-only">İletişim ve müşteri bilgileri</legend>
          <CustomerReferenceField
            membershipId={draft.referenceMembershipId}
            name={draft.referenceName}
            onChange={(referenceMembershipId, referenceName) =>
              setDraft((old) => ({ ...old, referenceMembershipId, referenceName }))
            }
          />
          {customer.type === 'INDIVIDUAL' && (
            <label>
              Doğum tarihi
              <input
                name="birthDate"
                type="date"
                autoComplete="bday"
                max={istanbulToday()}
                style={fieldStyle}
                value={draft.birthDate}
                onInput={(event) => {
                  const birthDate = event.currentTarget.value;
                  setDraft((old) => ({ ...old, birthDate }));
                }}
                onChange={(event) => setDraft((old) => ({ ...old, birthDate: event.target.value }))}
              />
            </label>
          )}
          <label>
            E-posta
            <input
              style={fieldStyle}
              type="email"
              autoComplete="email"
              value={draft.email}
              onChange={(event) =>
                setDraft((previous) => ({ ...previous, email: event.target.value }))
              }
            />
          </label>
          <label>
            Telefon
            <input
              style={fieldStyle}
              type="tel"
              autoComplete="tel"
              maxLength={50}
              value={draft.phone}
              onChange={(event) =>
                setDraft((previous) => ({ ...previous, phone: event.target.value }))
              }
            />
          </label>
          <label>
            Adres
            <textarea
              style={fieldStyle}
              rows={3}
              autoComplete="street-address"
              maxLength={1000}
              value={draft.address}
              onChange={(event) =>
                setDraft((previous) => ({ ...previous, address: event.target.value }))
              }
            />
          </label>
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
                        : field === 'address'
                          ? 'Güncel adres'
                          : field === 'birthDate'
                            ? 'Güncel doğum tarihi'
                            : field === 'referenceName'
                              ? 'Güncel referans kişi'
                              : 'Kayıtlı çalışan referansı'}
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
        <div
          className="customer-edit-actions"
          style={{ display: 'flex', gap: '0.5rem', flexWrap: 'wrap' }}
        >
          {!saved && (
            <Button type="submit" disabled={busy || archived || blocked || needsRefresh || !dirty}>
              {latest
                ? 'Karşılaştırdım, iletişim bilgilerini kaydet'
                : 'İletişim bilgilerini kaydet'}
            </Button>
          )}
          {(needsRefresh || blocked || saved) && (
            <Button type="button" disabled={busy} onClick={() => void refresh()}>
              Güncel bilgileri yükle
            </Button>
          )}
          {retry && retry.body === body && !needsRefresh && !blocked && !saved && (
            <Button type="button" disabled={busy || archived} onClick={() => void save(retry)}>
              Aynı isteği tekrar dene
            </Button>
          )}
          <Button
            type="button"
            variant={presentation ? 'outline' : 'default'}
            disabled={busy}
            onClick={cancel}
          >
            Vazgeç
          </Button>
        </div>
      </form>
    </section>
  );
  if (!presentation) return editing ? editor : trigger;
  return (
    <>
      {trigger}
      {editing && (
        <CustomerEditDialog
          title="İletişim bilgilerini düzenle"
          onDismiss={!busy && !dirty && !retry && !saved ? cancel : undefined}
        >
          {editor}
        </CustomerEditDialog>
      )}
    </>
  );
}
