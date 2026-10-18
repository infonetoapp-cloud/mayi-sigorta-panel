import { useEffect, useRef, useState, type FormEvent } from 'react';
import type {
  ApiResponse,
  PolicyDetailDto,
  PolicyAmendmentDto,
  PolicyExternalReferenceDto,
} from '../../../shared/types';
import { getCsrfToken, invalidateCsrfToken } from '../../csrf';
import { parseAppError } from '../../App';
import { readCustomerResource, useCustomerResource } from '../customers/customer-resource';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { policyDate, policyMoney, PolicyReadNotice } from './policy-display';
import { premiumMinor } from './policy-form-model';
type Kind = 'amendments' | 'external-references';
type Row = PolicyAmendmentDto | PolicyExternalReferenceDto;
const empty = {
  externalReference: '',
  effectiveDate: '',
  description: '',
  premiumDifference: '',
  currency: '',
  sourceNamespace: '',
  externalKey: '',
};
type Draft = typeof empty;
interface Attempt {
  url: string;
  method: 'POST';
  body: string;
  key: string;
}
interface Snapshot {
  policy: PolicyDetailDto;
  rows: Row[];
}
function signedMinor(value: string): bigint | null {
  const negative = value.startsWith('-');
  const result = premiumMinor(negative ? value.slice(1) : value);
  return result === null ? null : negative ? -result : result;
}
function validDate(value: string) {
  const date = new Date(value + 'T00:00:00Z');
  return (
    /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    Number.isFinite(date.getTime()) &&
    date.toISOString().slice(0, 10) === value
  );
}
/** Separate keyed mounts keep each append-only section's draft/attempt independent. */
export function PolicyAppendSection({
  kind,
  policy,
  onUpdated,
}: {
  kind: Kind;
  policy: PolicyDetailDto;
  onUpdated: (policy: PolicyDetailDto) => void;
}) {
  const url = `/api/policies/${encodeURIComponent(policy.id)}/${kind}`,
    base = `/api/policies/${encodeURIComponent(policy.id)}`;
  const initial = useCustomerResource<Row[]>(url),
    isAmendment = kind === 'amendments';
  const title = isAmendment ? 'Zeyiller' : 'Dış referanslar',
    addLabel = isAmendment ? 'Zeyil ekle' : 'Dış referans ekle',
    saveLabel = isAmendment ? 'Zeyili kaydet' : 'Referansı kaydet',
    successLabel = isAmendment ? 'Zeyil eklendi.' : 'Dış referans eklendi.';
  const [draft, setDraft] = useState<Draft>(empty),
    [errors, setErrors] = useState<Partial<Draft>>({}),
    [open, setOpen] = useState(false),
    [draftVersion, setDraftVersion] = useState(policy.version);
  const [snapshot, setSnapshot] = useState<Snapshot | null>(null),
    [comparison, setComparison] = useState<Snapshot | null>(null);
  const [busy, setBusy] = useState(false),
    [blocked, setBlocked] = useState(false),
    [needsRead, setNeedsRead] = useState(false),
    [needsComparison, setNeedsComparison] = useState(false);
  const [pending, setPending] = useState<Attempt | null>(null),
    [error, setError] = useState(''),
    [success, setSuccess] = useState('');
  const epoch = useRef(0),
    saving = useRef(false),
    readers = useRef(new Set<AbortController>()),
    completed = useRef(false),
    heading = useRef<HTMLHeadingElement>(null);
  useEffect(
    () => () => {
      epoch.current++;
      for (const c of readers.current) c.abort();
      readers.current.clear();
    },
    [],
  );
  useEffect(() => {
    if (open) heading.current?.focus();
  }, [open]);
  const rows = snapshot?.rows ?? initial.data,
    current = snapshot?.policy ?? policy,
    archived = policy.archivedAt != null || current.archivedAt != null;
  const hidden = blocked || !!initial.error,
    locked =
      busy ||
      blocked ||
      !!pending ||
      needsRead ||
      needsComparison ||
      archived ||
      !rows ||
      !!initial.error;
  async function scoped<T>(operation: (signal: AbortSignal) => Promise<T>) {
    const c = new AbortController();
    readers.current.add(c);
    try {
      return await operation(c.signal);
    } finally {
      readers.current.delete(c);
    }
  }
  function get<T>(target: string) {
    return scoped((signal) => readCustomerResource<T>(target, signal));
  }
  async function refresh() {
    if (busy) return;
    await load();
  }
  async function load() {
    const view = epoch.current;
    setBusy(true);
    try {
      const [fresh, list] = await Promise.all([get<PolicyDetailDto>(base), get<Row[]>(url)]);
      if (view !== epoch.current) return;
      if (
        fresh.id !== policy.id ||
        !Array.isArray(list) ||
        list.some((row) => row.policyId !== policy.id)
      )
        throw new Error('INVALID_READBACK');
      setSnapshot({ policy: fresh, rows: list });
      onUpdated(fresh);
      if (completed.current) {
        completed.current = false;
        setSuccess(successLabel);
        setOpen(false);
        setDraft(empty);
        setErrors({});
        setComparison(null);
        setNeedsRead(false);
        setError('');
      } else if (fresh.archivedAt) {
        setNeedsComparison(true);
        setError('Arşivlenmiş poliçe salt okunurdur.');
      } else {
        setComparison({ policy: fresh, rows: list });
        setNeedsComparison(false);
        setError('');
      }
    } catch (cause) {
      if (view !== epoch.current) return;
      const status =
        cause && typeof cause === 'object' && 'status' in cause ? Number(cause.status) : 0;
      if ([401, 403, 404].includes(status)) setBlocked(true);
      setError(
        completed.current
          ? 'Kayıt başarılı, yetkili poliçe ve liste okunamadı. Yalnız GET yeniden denenecek.'
          : 'Güncel poliçe ve liste okunamadı veya erişiminiz değişti. Taslağınız korundu; yeniden karşılaştırın.',
      );
    } finally {
      if (view === epoch.current) setBusy(false);
    }
  }
  async function send(attempt: Attempt) {
    if (saving.current || blocked || needsRead) return;
    saving.current = true;
    setBusy(true);
    setError('');
    setSuccess('');
    const view = epoch.current;
    try {
      const csrf = await scoped((signal) => getCsrfToken(signal));
      if (view !== epoch.current) return;
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
      if (view !== epoch.current) return;
      if (response.status === 401) {
        parseAppError(401);
        setBlocked(true);
        setError('Oturum sona erdi. Yeniden giriş yapın.');
        return;
      }
      const envelope = (await response.json().catch(() => null)) as ApiResponse<Row> | null;
      if (view !== epoch.current) return;
      if (!response.ok) {
        if (response.status === 403) invalidateCsrfToken();
        const info = parseAppError(
          response.status,
          envelope && !envelope.success ? envelope.error : null,
        );
        if (info.isRetryable || response.status === 429) throw new Error('UNCERTAIN');
        setPending(null);
        if (response.status === 409) {
          setNeedsComparison(true);
          setComparison(null);
          setError(
            'Poliçe sürümü değişmiş veya aynı dış referans zaten kaydedilmiş olabilir. Taslağınız korundu; güncel listeyi karşılaştırıp yeniden onaylayın.',
          );
        } else {
          setError(info.message);
          if ([403, 404].includes(response.status)) setBlocked(true);
        }
        return;
      }
      if (!envelope?.success || envelope.data?.policyId !== policy.id || !envelope.data.id)
        throw new Error('UNCERTAIN');
      setPending(null);
      completed.current = true;
      setNeedsRead(true);
      await load();
    } catch {
      if (view === epoch.current) {
        setPending(attempt);
        setError(
          'İşlemin sonucu belirsiz. Form kilitlendi; aynı isteği aynı anahtarla yeniden deneyin. Sayfayı yenilemeyin.',
        );
      }
    } finally {
      saving.current = false;
      if (view === epoch.current) setBusy(false);
    }
  }
  function submit(event: FormEvent) {
    event.preventDefault();
    if (locked || saving.current) return;
    const v = Object.fromEntries(
        Object.entries(draft).map(([key, value]) => [key, value.trim()]),
      ) as Draft,
      invalid: Partial<Draft> = {};
    let payload: Record<string, unknown>;
    if (isAmendment) {
      if (!v.externalReference || v.externalReference.length > 200)
        invalid.externalReference = 'Dış zeyil referansı zorunludur; en fazla 200 karakter.';
      if (!validDate(v.effectiveDate)) invalid.effectiveDate = 'Geçerli YYYY-MM-DD tarihi girin.';
      if (!v.description || v.description.length > 2000)
        invalid.description = 'Açıklama zorunludur; en fazla 2000 karakter.';
      if (!!v.premiumDifference !== !!v.currency) {
        invalid.premiumDifference =
          'Prim farkı ve para birimini birlikte girin veya ikisini de boş bırakın.';
        invalid.currency = invalid.premiumDifference;
      }
      if (v.premiumDifference && signedMinor(v.premiumDifference) === null)
        invalid.premiumDifference =
          'İşaretli noktalı ondalık girin (12.34, -0.50 veya 0); en fazla iki ondalık ve güvenli minor-unit sınırı.';
      if (
        v.currency &&
        (!/^[A-Z]{3}$/.test(v.currency) ||
          !new Set(Intl.supportedValuesOf('currency')).has(v.currency))
      )
        invalid.currency = 'Geçerli üç büyük harfli ISO para birimi girin.';
      payload = {
        externalReference: v.externalReference,
        effectiveDate: v.effectiveDate,
        description: v.description,
        premiumDifference: v.premiumDifference || null,
        currency: v.currency || null,
      };
    } else {
      if (!v.sourceNamespace || v.sourceNamespace.length > 100)
        invalid.sourceNamespace = 'Kaynak ad alanı zorunludur; en fazla 100 karakter.';
      if (!v.externalKey || v.externalKey.length > 200)
        invalid.externalKey = 'Dış anahtar zorunludur; en fazla 200 karakter.';
      payload = { sourceNamespace: v.sourceNamespace, externalKey: v.externalKey };
    }
    setErrors(invalid);
    if (Object.keys(invalid).length) return;
    if (
      !isAmendment &&
      comparison?.rows.some(
        (row) =>
          'sourceNamespace' in row &&
          row.sourceNamespace === v.sourceNamespace &&
          row.externalKey === v.externalKey,
      )
    ) {
      setError(
        'Bu kaynak ve dış anahtar güncel listede zaten mevcut. İkinci kayıt gönderilmedi; taslağı düzeltin veya vazgeçin.',
      );
      return;
    }
    void send({
      url,
      method: 'POST',
      body: JSON.stringify({
        ...payload,
        expectedVersion: comparison?.policy.version ?? draftVersion,
      }),
      key: crypto.randomUUID(),
    });
  }
  function field(key: keyof Draft, label: string, type = 'text', maximum?: number) {
    return (
      <div>
        <label htmlFor={`append-${kind}-${key}`}>{label}</label>
        {key === 'description' ? (
          <textarea
            id={`append-${kind}-${key}`}
            value={draft[key]}
            maxLength={maximum}
            aria-invalid={!!errors[key]}
            aria-describedby={errors[key] ? `append-error-${kind}-${key}` : undefined}
            onChange={(e) => setDraft((previous) => ({ ...previous, [key]: e.target.value }))}
          />
        ) : (
          <Input
            id={`append-${kind}-${key}`}
            type={type}
            value={draft[key]}
            maxLength={maximum}
            aria-invalid={!!errors[key]}
            aria-describedby={errors[key] ? `append-error-${kind}-${key}` : undefined}
            onChange={(e) => setDraft((previous) => ({ ...previous, [key]: e.target.value }))}
          />
        )}{' '}
        {errors[key] && (
          <p className="customer-field-error" id={`append-error-${kind}-${key}`}>
            {errors[key]}
          </p>
        )}
      </div>
    );
  }
  const preview = draft.premiumDifference.trim()
    ? signedMinor(draft.premiumDifference.trim())
    : null;
  return (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
      </CardHeader>
      <CardContent>
        <PolicyReadNotice
          loading={!snapshot && initial.loading}
          error={initial.error}
          reload={initial.reload}
        />
        {archived && <p>Arşivlenmiş poliçenin geçmişi salt okunurdur.</p>}
        {error && <p role="alert">{error}</p>}
        {success && <p role="status">{success}</p>}
        {busy && <p role="status">İşlem sürüyor…</p>}
        {pending && (
          <Button disabled={busy || blocked} variant="outline" onClick={() => void send(pending)}>
            Aynı işlemi yeniden dene
          </Button>
        )}
        {needsRead && (
          <Button disabled={busy} variant="outline" onClick={() => void refresh()}>
            Kaydedilen listeyi yeniden oku
          </Button>
        )}
        {needsComparison && !blocked && (
          <Button disabled={busy} variant="outline" onClick={() => void refresh()}>
            Güncel kayıtları karşılaştır
          </Button>
        )}
        {!hidden && (
          <>
            {!archived && !open && (
              <Button
                disabled={locked}
                onClick={() => {
                  setOpen(true);
                  setDraft(empty);
                  setErrors({});
                  setDraftVersion(current.version);
                  setComparison(null);
                  setError('');
                  setSuccess('');
                }}
              >
                {addLabel}
              </Button>
            )}
            {open && (
              <form
                className="policy-contract-form customer-edit-form"
                aria-label={isAmendment ? 'Yeni zeyil formu' : 'Yeni dış referans formu'}
                noValidate
                onSubmit={submit}
              >
                <h3 ref={heading} tabIndex={-1}>
                  {addLabel}
                </h3>
                <fieldset disabled={locked}>
                  <div className="customer-form-grid">
                    {isAmendment ? (
                      <>
                        {field('externalReference', 'Dış zeyil referansı', 'text', 200)}
                        {field('effectiveDate', 'Geçerlilik tarihi', 'date')}
                        {field('description', 'Açıklama', 'text', 2000)}
                        {field('premiumDifference', 'Prim farkı')}
                        {field('currency', 'ISO para birimi', 'text', 3)}
                      </>
                    ) : (
                      <>
                        {field('sourceNamespace', 'Kaynak ad alanı', 'text', 100)}
                        {field('externalKey', 'Dış anahtar', 'text', 200)}
                      </>
                    )}
                  </div>
                </fieldset>
                {isAmendment ? (
                  <p className="customer-legacy-hint">
                    Prim farkı isteğe bağlıdır; para birimiyle birlikte girin. Noktalı ondalık
                    kullanın: 12.34, -0.50 veya 0; binlik ayırıcı/başta + işareti yok. Bu kayıt yeni
                    dönem, yenileme veya iptal değildir; poliçenin özgün brüt primini değiştirmez.{' '}
                    {preview !== null && draft.currency
                      ? `Önizleme: ${policyMoney(Number(preview), draft.currency)}`
                      : ''}
                  </p>
                ) : (
                  <p className="customer-legacy-hint">
                    Yalnız dış kaynak kimliği kaydedilir; dış sistemlerle otomatik senkronizasyon
                    yapılmaz.
                  </p>
                )}
                {comparison && (
                  <aside className="company-contact-comparison" role="status">
                    <strong>Karşılaştırılan poliçe sürümü: {comparison.policy.version}</strong>
                    <p>
                      Güncel listedeki kayıtları taslağınızla karşılaştırın. Aynı referans varsa
                      yeniden eklemeyin; yeni işlem için açıkça onaylayın.
                    </p>
                    <p>
                      {isAmendment
                        ? `${draft.externalReference} · ${draft.effectiveDate} · ${draft.description}`
                        : `${draft.sourceNamespace} · ${draft.externalKey}`}
                    </p>
                  </aside>
                )}
                <div className="customer-form-actions">
                  <Button type="submit" disabled={locked}>
                    {comparison ? 'Karşılaştırdım, kaydet' : saveLabel}
                  </Button>
                  <Button
                    variant="outline"
                    disabled={busy || !!pending || needsRead}
                    onClick={() => {
                      setOpen(false);
                      setDraft(empty);
                      setComparison(null);
                      setNeedsComparison(false);
                      setError('');
                    }}
                  >
                    Vazgeç
                  </Button>
                </div>
              </form>
            )}
            {rows && !rows.length && <p>Bu bölümde kayıt bulunmuyor.</p>}
            <ul className="customer-related-list">
              {rows?.map((row) => (
                <li key={row.id}>
                  {'effectiveDate' in row ? (
                    <>
                      <strong>{row.externalReference}</strong>
                      <span>{policyDate(row.effectiveDate)}</span>
                      <p className="policy-history-text">{row.description}</p>
                      <span>
                        {row.premiumDifferenceMinor == null
                          ? 'Prim farkı belirtilmedi'
                          : row.currency
                            ? policyMoney(row.premiumDifferenceMinor, row.currency)
                            : 'Prim farkının para birimi belirtilmedi'}
                      </span>
                    </>
                  ) : (
                    <>
                      <strong>{row.sourceNamespace}</strong>
                      <span>{row.externalKey}</span>
                    </>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </CardContent>
    </Card>
  );
}
