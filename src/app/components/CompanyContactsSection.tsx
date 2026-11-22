import { useEffect, useRef, useState, type FormEvent } from 'react';
import { z } from 'zod';
import type { ApiResponse, CompanyContactDto, CustomerDetailDto } from '../../shared/types';
import { getCsrfToken, invalidateCsrfToken } from '../csrf';
import { parseAppError } from '../App';
import { readCustomerResource } from '../pages/customers/customer-resource';
import { Button } from './ui/button';
import { Input } from './ui/input';
import { CustomerEditDialog } from './CustomerEditDialog';

const empty = { firstName: '', lastName: '', role: '', email: '', phone: '' };
type Draft = typeof empty;
type Kind = 'create' | 'edit' | 'primary' | 'deactivate';
type Mode = { kind: 'create' } | { kind: Exclude<Kind, 'create'>; target: CompanyContactDto };
interface Attempt {
  url: string;
  method: 'POST' | 'PATCH';
  body: string;
  key: string;
  kind: Kind;
}
const messages: Record<Kind, string> = {
  create: 'Yetkili eklendi.',
  edit: 'Yetkili bilgileri güncellendi.',
  primary: 'Birincil yetkili değiştirildi.',
  deactivate: 'Yetkili pasifleştirildi.',
};

/** Source-owned API snapshots, not a second business-rule/permission engine.
 * Key this component by customer ID. No draft/body is put in browser storage. */
export function CompanyContactsSection({
  customer,
  onUpdated,
}: {
  customer: CustomerDetailDto;
  onUpdated: (current: CustomerDetailDto) => void;
}) {
  const [mode, setMode] = useState<Mode | null>(null);
  const [draft, setDraft] = useState<Draft>(empty);
  const [primary, setPrimary] = useState(false);
  const [fieldErrors, setFieldErrors] = useState<Partial<Draft>>({});
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [success, setSuccess] = useState('');
  const [pending, setPending] = useState<Attempt | null>(null);
  const [needsRefresh, setNeedsRefresh] = useState(false),
    [compared, setCompared] = useState(false);
  const [comparison, setComparison] = useState<CompanyContactDto | null>(null);
  const [unavailable, setUnavailable] = useState(false),
    [blocked, setBlocked] = useState(false);
  const [awaitingRead, setAwaitingRead] = useState(false);
  const [refreshed, setRefreshed] = useState<{
    source: CustomerDetailDto;
    data: CustomerDetailDto;
  }>();
  const generation = useRef(0),
    readSequence = useRef(0),
    saving = useRef(false);
  const completed = useRef<Kind | null>(null);
  useEffect(
    () => () => {
      generation.current++;
      readSequence.current++;
    },
    [],
  );
  const current = refreshed?.source === customer ? refreshed.data : customer;
  const archived = customer.archivedAt != null || current.archivedAt != null;
  const locked = busy || !!pending || awaitingRead || needsRefresh || blocked || archived;
  const target =
    mode && mode.kind !== 'create'
      ? current.contacts?.find((contact) => contact.id === mode.target.id)
      : undefined;
  const targetMissing = !!mode && mode.kind !== 'create' && (!target || (compared && !comparison));
  const url = `/api/customers/${encodeURIComponent(customer.id)}`;

  async function refresh() {
    const view = generation.current,
      request = ++readSequence.current;
    setBusy(true);
    try {
      const fresh = await readCustomerResource<CustomerDetailDto>(url);
      if (view !== generation.current || request !== readSequence.current) return;
      if (fresh.id !== customer.id || fresh.type !== 'COMPANY' || !Array.isArray(fresh.contacts))
        throw new Error('INVALID_DETAIL');
      setRefreshed({ source: customer, data: fresh });
      onUpdated(fresh);
      setUnavailable(false);
      setBlocked(false);
      setNeedsRefresh(false);
      setError('');
      if (completed.current) {
        setSuccess(messages[completed.current]);
        completed.current = null;
        setAwaitingRead(false);
        setMode(null);
        setDraft(empty);
        setCompared(false);
        setPending(null);
      } else {
        // Pin CAS to this explicit comparison, not unrelated later parent reads.
        setComparison(
          mode && mode.kind !== 'create'
            ? (fresh.contacts.find((c) => c.id === mode.target.id) ?? null)
            : null,
        );
        setCompared(true);
      }
    } catch (cause) {
      if (view !== generation.current || request !== readSequence.current) return;
      const status =
        cause && typeof cause === 'object' && 'status' in cause ? cause.status : undefined;
      if (status === 401 || status === 403 || status === 404) {
        setUnavailable(true);
        setBlocked(true);
      }
      setNeedsRefresh(true);
      setError(
        completed.current
          ? 'İşlem kaydedildi, ancak güncel yetkililer yüklenemedi. Yalnız okuma yeniden denenecek; tekrar kayıt gönderilmeyecek.'
          : 'Güncel yetkililer yüklenemedi veya erişim izniniz değişti. Taslağınız korundu.',
      );
    } finally {
      if (view === generation.current && request === readSequence.current) setBusy(false);
    }
  }
  async function send(attempt: Attempt) {
    // An already pending immutable request may reconcile a historical receipt
    // after archive. New actions stay disabled; the server rejects fresh writes.
    if (saving.current || (archived && pending !== attempt) || blocked || awaitingRead) return;
    saving.current = true;
    setBusy(true);
    setError('');
    setSuccess('');
    const view = generation.current;
    try {
      const csrf = await getCsrfToken();
      if (view !== generation.current) return;
      const response = await fetch(attempt.url, {
        method: attempt.method,
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': attempt.key,
        },
        body: attempt.body,
      });
      if (view !== generation.current) return;
      if (response.status === 401) {
        parseAppError(401);
        setUnavailable(true);
        setBlocked(true);
        setError('Oturum sona erdi. Yeniden giriş yapın.');
        return;
      }
      const envelope = (await response
        .json()
        .catch(() => null)) as ApiResponse<CompanyContactDto> | null;
      if (view !== generation.current) return;
      if (!response.ok) {
        if (response.status === 403) invalidateCsrfToken();
        const info = parseAppError(
          response.status,
          envelope && !envelope.success ? envelope.error : null,
        );
        if (info.isRetryable || response.status === 429) throw new Error('UNCERTAIN');
        setPending(null);
        if (response.status === 409) {
          setNeedsRefresh(true);
          setCompared(false);
          setError(
            'Kayıt veya müşteri durumu değişti. Taslağınız korundu; güncel yetkilileri yükleyip karşılaştırın.',
          );
        } else {
          setError(info.message);
          if (response.status === 403 || response.status === 404) {
            setBlocked(true);
            setUnavailable(true);
            setNeedsRefresh(true);
          }
        }
        return;
      }
      if (!envelope?.success) throw new Error('UNCERTAIN');
      setPending(null);
      completed.current = attempt.kind;
      setAwaitingRead(true);
      await refresh();
    } catch {
      if (view !== generation.current) return;
      setPending(attempt);
      setError(
        'İşlemin sonucu doğrulanamadı. Çift işlem oluşturmamak için form kilitlendi; aynı işlemi yeniden deneyin.',
      );
    } finally {
      saving.current = false;
      if (view === generation.current) setBusy(false);
    }
  }
  function open(next: Mode) {
    if (locked) return;
    setMode(next);
    setError('');
    setSuccess('');
    setFieldErrors({});
    setCompared(false);
    setComparison(null);
    setPrimary(false);
    setDraft(
      next.kind === 'edit'
        ? {
            firstName: next.target.firstName,
            lastName: next.target.lastName,
            role: next.target.role ?? '',
            email: next.target.email ?? '',
            phone: next.target.phone ?? '',
          }
        : empty,
    );
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (!mode || locked || targetMissing) return;
    const values = Object.fromEntries(
      Object.entries(draft).map(([key, value]) => [key, value.trim()]),
    ) as Draft;
    let payload: Record<string, unknown>;
    if (mode.kind === 'create' || mode.kind === 'edit') {
      const invalid: Partial<Draft> = {};
      if (!values.firstName || values.firstName.length > 100)
        invalid.firstName = 'Yetkili adı zorunludur; en fazla 100 karakter olabilir.';
      if (!values.lastName || values.lastName.length > 100)
        invalid.lastName = 'Yetkili soyadı zorunludur; en fazla 100 karakter olabilir.';
      if (values.role.length > 100) invalid.role = 'Görev / unvan en fazla 100 karakter olabilir.';
      if (values.email && !z.email().safeParse(values.email).success)
        invalid.email = 'Geçerli bir e-posta girin.';
      if (values.phone.length > 50) invalid.phone = 'Telefon en fazla 50 karakter olabilir.';
      setFieldErrors(invalid);
      if (Object.keys(invalid).length) return;
      if (mode.kind === 'create')
        payload = {
          firstName: values.firstName,
          lastName: values.lastName,
          role: values.role || null,
          email: values.email || null,
          phone: values.phone || null,
          isPrimary: primary,
        };
      else {
        payload = { expectedVersion: compared ? comparison!.version : mode.target.version };
        for (const name of Object.keys(values) as Array<keyof Draft>) {
          const value =
            name === 'firstName' || name === 'lastName' ? values[name] : values[name] || null;
          if (value !== mode.target[name]) payload[name] = value;
        }
        if (Object.keys(payload).length === 1) {
          setError('Kaydetmek için en az bir bilgiyi değiştirin.');
          return;
        }
      }
    } else {
      if (target?.status !== 'ACTIVE') {
        setError('Bu işlem yalnız aktif yetkililer için kullanılabilir.');
        return;
      }
      payload = { expectedVersion: compared ? comparison!.version : mode.target.version };
    }
    const endpoint =
      mode.kind === 'create'
        ? `${url}/contacts`
        : `${url}/contacts/${encodeURIComponent(mode.target.id)}${mode.kind === 'primary' ? '/set-primary' : mode.kind === 'deactivate' ? '/deactivate' : ''}`;
    void send({
      url: endpoint,
      method: mode.kind === 'edit' ? 'PATCH' : 'POST',
      body: JSON.stringify(payload),
      key: crypto.randomUUID(),
      kind: mode.kind,
    });
  }
  if (customer.type !== 'COMPANY') return null;
  const field = (name: keyof Draft, label: string, maximum?: number, type = 'text') => (
    <div>
      <label htmlFor={`company-contact-${name}`}>{label}</label>
      <Input
        id={`company-contact-${name}`}
        type={type}
        value={draft[name]}
        maxLength={maximum}
        aria-invalid={!!fieldErrors[name]}
        aria-describedby={fieldErrors[name] ? `company-error-${name}` : undefined}
        onChange={(event) => setDraft((previous) => ({ ...previous, [name]: event.target.value }))}
      />
      {fieldErrors[name] && (
        <p id={`company-error-${name}`} className="customer-field-error">
          {fieldErrors[name]}
        </p>
      )}
    </div>
  );
  const feedback = (
    <>
      {error && <p role="alert">{error}</p>}
      {success && <p role="status">{success}</p>}
      {busy && <p role="status">İşlem sürüyor…</p>}
      {needsRefresh && (
        <Button variant="outline" disabled={busy || !!pending} onClick={() => void refresh()}>
          Güncel yetkilileri yükle
        </Button>
      )}
      {pending && (
        <Button
          variant="outline"
          disabled={busy || blocked || awaitingRead}
          onClick={() => void send(pending)}
        >
          Aynı işlemi yeniden dene
        </Button>
      )}
    </>
  );
  const editorTitle =
    mode?.kind === 'create'
      ? 'Yeni şirket yetkilisi'
      : mode?.kind === 'edit'
        ? 'Yetkili bilgilerini düzenle'
        : mode?.kind === 'primary'
          ? 'Birincil yetkili onayı'
          : 'Yetkili pasifleştirme onayı';
  return (
    <section className="company-contacts" aria-label="Şirket yetkilisi yönetimi">
      <div className="company-contacts-heading">
        <h2>Şirket yetkilileri</h2>
        {!archived && !unavailable && (
          <Button
            variant="outline"
            disabled={locked && !mode}
            onClick={() => open({ kind: 'create' })}
          >
            Yetkili ekle
          </Button>
        )}
      </div>
      {archived && <p>Arşivlenmiş müşterinin yetkili geçmişi salt okunurdur.</p>}
      {!mode && feedback}
      {mode && (
        <CustomerEditDialog title={editorTitle}>
          {feedback}
          <form
            className="customer-edit-dialog-form"
            onSubmit={submit}
            noValidate
            aria-label="Şirket yetkilisi işlemi"
          >
            {mode.kind === 'create' || mode.kind === 'edit' ? (
              <fieldset disabled={locked || targetMissing}>
                <div className="customer-form-grid">
                  {field('firstName', 'Yetkili adı', 100)}
                  {field('lastName', 'Yetkili soyadı', 100)}
                  {field('role', 'Görev / unvan', 100)}
                  {field('email', 'Yetkili e-postası', undefined, 'email')}
                  {field('phone', 'Yetkili telefonu', 50, 'tel')}
                </div>
                {mode.kind === 'create' && (
                  <label className="company-primary-choice">
                    <input
                      type="checkbox"
                      checked={primary}
                      onChange={(event) => setPrimary(event.target.checked)}
                    />
                    Birincil yetkili olarak ata
                  </label>
                )}
              </fieldset>
            ) : (
              <p>
                {mode.target.firstName} {mode.target.lastName}
                {mode.kind === 'primary'
                  ? ' birincil yetkili yapılacak; önceki birincil seçimi kaldırılacak.'
                  : ' pasifleştirilecek. Geçmiş bilgiler silinmez; birincil ise birincil seçimi kaldırılır.'}
              </p>
            )}
            {compared && mode.kind !== 'create' && comparison && (
              <div className="company-contact-comparison" role="status">
                <strong>Sunucudan alınan karşılaştırma kaydı</strong>
                <p>
                  {comparison.firstName} {comparison.lastName} ·{' '}
                  {comparison.role || 'Görev belirtilmedi'} ·{' '}
                  {comparison.email || 'E-posta belirtilmedi'} ·{' '}
                  {comparison.phone || 'Telefon belirtilmedi'} ·{' '}
                  {comparison.status === 'ACTIVE' ? 'Aktif' : 'Pasif'}
                </p>
                <p>
                  Taslağınız korundu. Farkları kontrol ederek işlemi yeniden onaylayın; yalnız
                  değiştirdiğiniz alanlar gönderilir.
                </p>
              </div>
            )}
            {targetMissing && (
              <p role="alert">Seçilen yetkili artık kullanılamıyor. Yeni bir işlem seçin.</p>
            )}
            <div className="customer-edit-actions">
              <Button
                type="submit"
                disabled={
                  locked ||
                  targetMissing ||
                  ((mode.kind === 'primary' || mode.kind === 'deactivate') &&
                    target?.status !== 'ACTIVE')
                }
              >
                {mode.kind === 'create'
                  ? 'Yetkiliyi kaydet'
                  : mode.kind === 'edit'
                    ? compared
                      ? 'Karşılaştırdım, değişiklikleri kaydet'
                      : 'Değişiklikleri kaydet'
                    : mode.kind === 'primary'
                      ? 'Birincil yapmayı onayla'
                      : 'Pasifleştirmeyi onayla'}
              </Button>
              <Button
                variant="outline"
                disabled={busy || !!pending || awaitingRead}
                onClick={() => {
                  setMode(null);
                  setDraft(empty);
                  setFieldErrors({});
                }}
              >
                Vazgeç
              </Button>
            </div>
          </form>
        </CustomerEditDialog>
      )}
      {!unavailable && (
        <div className="company-contacts-list">
          {!current.contacts?.length && <p>Henüz şirket yetkilisi yok.</p>}
          {current.contacts?.map((contact) => (
            <section
              key={contact.id}
              aria-label={`${contact.firstName} ${contact.lastName}`}
              className="company-contact-row"
            >
              <div>
                <h4>
                  {contact.firstName} {contact.lastName}
                </h4>
                <p>{contact.role || 'Görev / unvan belirtilmedi'}</p>
                <p>
                  {contact.email || 'E-posta belirtilmedi'} ·{' '}
                  {contact.phone || 'Telefon belirtilmedi'}
                </p>
                <div className="company-contact-badges">
                  <span className="customer-badge">
                    {contact.status === 'ACTIVE' ? 'Aktif' : 'Pasif'}
                  </span>
                  {contact.isPrimary && (
                    <span className="customer-badge customer-badge-active">Birincil yetkili</span>
                  )}
                </div>
              </div>
              {!archived && (
                <div className="company-contact-actions">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={locked && !mode}
                    onClick={() => open({ kind: 'edit', target: contact })}
                  >
                    Yetkiliyi düzenle
                  </Button>
                  {contact.status === 'ACTIVE' && (
                    <>
                      {!contact.isPrimary && (
                        <Button
                          variant="outline"
                          size="sm"
                          disabled={locked && !mode}
                          onClick={() => open({ kind: 'primary', target: contact })}
                        >
                          Birincil yap
                        </Button>
                      )}
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={locked && !mode}
                        onClick={() => open({ kind: 'deactivate', target: contact })}
                      >
                        Pasifleştir
                      </Button>
                    </>
                  )}
                </div>
              )}
            </section>
          ))}
        </div>
      )}
    </section>
  );
}
