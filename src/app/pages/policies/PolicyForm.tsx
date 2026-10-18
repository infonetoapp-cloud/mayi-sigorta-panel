import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router';
import type {
  ApiResponse,
  PolicyDetailDto,
  PolicyDto,
  SelectableCatalogsDto,
} from '../../../shared/types';
import { getCsrfToken, invalidateCsrfToken } from '../../csrf';
import { parseAppError } from '../../App';
import { readCustomerResource } from '../customers/customer-resource';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { Card, CardContent, CardHeader, CardTitle } from '../../components/ui/card';
import { policyMoney, policyStatusLabel } from './policy-display';
import {
  blankPolicyDraft,
  contractValues,
  policyChanges,
  policyDraft,
  premiumMinor,
  validatePolicy,
  type PolicyDraft,
} from './policy-form-model';
interface Attempt {
  url: string;
  method: 'POST' | 'PATCH';
  body: string;
  key: string;
}
export function PolicyForm({
  customer,
  policy,
  catalogs: initialCatalogs,
  onLockChange,
}: {
  customer: { id: string; displayName: string };
  policy?: PolicyDetailDto;
  catalogs: SelectableCatalogsDto;
  onLockChange?: (locked: boolean) => void;
}) {
  const navigate = useNavigate();
  const [draft, setDraft] = useState<PolicyDraft>(() =>
    policy ? policyDraft(policy) : { ...blankPolicyDraft },
  );
  const [catalogs, setCatalogs] = useState(initialCatalogs);
  const [errors, setErrors] = useState<Partial<Record<keyof PolicyDraft, string>>>({});
  const [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [blocked, setBlocked] = useState(false);
  const [pending, setPending] = useState<Attempt | null>(null),
    [needsRead, setNeedsRead] = useState(false),
    [needsComparison, setNeedsComparison] = useState(false);
  const [comparison, setComparison] = useState<PolicyDetailDto | null>(null);
  const generation = useRef(0),
    saving = useRef(false),
    confirmed = useRef<{ id: string; version: number } | null>(null);
  const readers = useRef(new Set<AbortController>());
  const locked = busy || blocked || !!pending || needsRead || needsComparison;
  useEffect(() => {
    onLockChange?.(locked);
  }, [locked, onLockChange]);
  useEffect(
    () => () => {
      generation.current++;
      for (const reader of readers.current) reader.abort();
      readers.current.clear();
    },
    [],
  );
  const method = catalogs.paymentMethods.find((item) => item.id === draft.paymentMethodId);
  const changed = policy ? policyChanges(draft, policy) : {};
  const catalogChanged = [
    'insurerId',
    'branchId',
    'productId',
    'paymentMethodId',
    'installmentCount',
  ].some((key) => key in changed);
  async function scopedRead<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const controller = new AbortController();
    readers.current.add(controller);
    try {
      return await operation(controller.signal);
    } finally {
      readers.current.delete(controller);
    }
  }
  function read<T>(url: string): Promise<T> {
    return scopedRead((signal) => readCustomerResource<T>(url, signal));
  }
  async function readback() {
    const target = confirmed.current;
    if (!target) return;
    const epoch = generation.current;
    setBusy(true);
    try {
      const current = await read<PolicyDetailDto>(`/api/policies/${encodeURIComponent(target.id)}`);
      if (epoch !== generation.current) return;
      if (
        current.id !== target.id ||
        current.customerId !== customer.id ||
        current.version < target.version
      )
        throw new Error('INVALID_READBACK');
      void navigate(`/policies/${encodeURIComponent(current.id)}`, {
        replace: true,
        state: { policySaved: current.id },
      });
    } catch (cause) {
      if (epoch !== generation.current) return;
      const status =
        cause && typeof cause === 'object' && 'status' in cause ? cause.status : undefined;
      if (status === 401 || status === 403 || status === 404) setBlocked(true);
      setNeedsRead(true);
      setError(
        'Poliçe kaydedildi, ancak yetkili detay okunamadı. Yalnız okuma yeniden denenecek; kayıt tekrar gönderilmeyecek.',
      );
    } finally {
      if (epoch === generation.current) setBusy(false);
    }
  }
  async function send(attempt: Attempt) {
    if (saving.current || blocked || needsRead) return;
    saving.current = true;
    setBusy(true);
    setError('');
    const epoch = generation.current;
    try {
      const csrf = await scopedRead((signal) => getCsrfToken(signal));
      if (epoch !== generation.current) return;
      const result = await fetch(attempt.url, {
        method: attempt.method,
        cache: 'no-store',
        headers: {
          'Content-Type': 'application/json',
          'X-CSRF-Token': csrf,
          'Idempotency-Key': attempt.key,
        },
        body: attempt.body,
      });
      if (epoch !== generation.current) return;
      if (result.status === 401) {
        parseAppError(401);
        setBlocked(true);
        setError('Oturum sona erdi. Yeniden giriş yapın.');
        return;
      }
      const envelope = (await result.json().catch(() => null)) as ApiResponse<PolicyDto> | null;
      if (epoch !== generation.current) return;
      if (!result.ok) {
        if (result.status === 403) invalidateCsrfToken();
        const info = parseAppError(
          result.status,
          envelope && !envelope.success ? envelope.error : null,
        );
        if (info.isRetryable || result.status === 429) throw new Error('UNCERTAIN');
        setPending(null);
        if (result.status === 409) {
          if (policy) {
            setNeedsComparison(true);
            setComparison(null);
            setError(
              'Poliçe değişti. Taslağınız korundu; güncel sözleşmeyi yükleyip karşılaştırın ve yeniden onaylayın.',
            );
          } else {
            setBlocked(true);
            setError(
              'Aynı sözleşme mevcut olabilir. Yeni kayıt gönderimi durduruldu; poliçe listesini kontrol edin.',
            );
          }
        } else {
          setError(info.message);
          if ([403, 404].includes(result.status)) setBlocked(true);
        }
        return;
      }
      if (
        !envelope?.success ||
        !envelope.data?.id ||
        !Number.isSafeInteger(envelope.data.version) ||
        (policy && envelope.data.id !== policy.id) ||
        envelope.data.customerId !== customer.id
      )
        throw new Error('UNCERTAIN');
      setPending(null);
      confirmed.current = { id: envelope.data.id, version: envelope.data.version };
      setNeedsRead(true);
      await readback();
    } catch {
      if (epoch === generation.current) {
        setPending(attempt);
        setError(
          'İşlemin sonucu belirsiz. Form kilitlendi; aynı body ve işlem anahtarıyla yeniden deneyin. Sayfayı yenilemeyin.',
        );
      }
    } finally {
      saving.current = false;
      if (epoch === generation.current) setBusy(false);
    }
  }
  async function compare() {
    if (!policy || busy) return;
    const epoch = generation.current;
    setBusy(true);
    try {
      const [fresh, choices] = await Promise.all([
        read<PolicyDetailDto>(`/api/policies/${encodeURIComponent(policy.id)}`),
        read<SelectableCatalogsDto>('/api/catalogs/selectable'),
      ]);
      if (epoch !== generation.current) return;
      if (fresh.id !== policy.id || fresh.customerId !== customer.id)
        throw new Error('INVALID_COMPARISON');
      if (fresh.archivedAt) {
        setBlocked(true);
        setError('Arşivlenmiş poliçe düzenlenemez.');
        return;
      }
      setComparison(fresh);
      setCatalogs(choices);
      setNeedsComparison(false);
      setErrors({});
      setError('');
    } catch (cause) {
      if (epoch === generation.current) {
        setError('Güncel sözleşme okunamadı veya erişim izniniz değişti. Yeni yazım yapılmadı.');
        const status =
          cause && typeof cause === 'object' && 'status' in cause ? cause.status : undefined;
        if ([401, 403, 404].includes(Number(status))) setBlocked(true);
      }
    } finally {
      if (epoch === generation.current) setBusy(false);
    }
  }
  const effective =
    policy && comparison
      ? ({
          ...policyDraft(comparison),
          ...Object.fromEntries(
            Object.entries(changed).map(([key, value]) => [
              key,
              key === 'installmentCount' ? (value?.toString() ?? '') : value,
            ]),
          ),
        } as PolicyDraft)
      : draft;
  function submit(event: FormEvent) {
    event.preventDefault();
    if (locked || saving.current) return;
    const invalid = validatePolicy(effective, catalogs, !policy || catalogChanged);
    setErrors(invalid);
    setError('');
    if (Object.keys(invalid).length) return;
    if (policy && !Object.keys(changed).length) {
      setError('En az bir sözleşme bilgisini değiştirin.');
      return;
    }
    const body = policy
      ? { ...changed, expectedVersion: (comparison ?? policy).version }
      : { ...contractValues(draft), customerId: customer.id };
    void send({
      url: policy ? `/api/policies/${encodeURIComponent(policy.id)}` : '/api/policies',
      method: policy ? 'PATCH' : 'POST',
      key: crypto.randomUUID(),
      body: JSON.stringify(body),
    });
  }
  function change(key: keyof PolicyDraft, value: string) {
    setDraft((previous) => ({
      ...previous,
      [key]: value,
      ...(key === 'insurerId' || key === 'branchId' ? { productId: '' } : {}),
      ...(key === 'paymentMethodId' &&
      catalogs.paymentMethods.find((x) => x.id === value)?.supportsInstallments === false
        ? { installmentCount: '' }
        : {}),
    }));
  }
  const field = (key: keyof PolicyDraft, label: string, type = 'text', maxLength?: number) => (
    <div>
      <label htmlFor={`contract-${key}`}>{label}</label>
      <Input
        id={`contract-${key}`}
        type={type}
        value={draft[key]}
        maxLength={maxLength}
        aria-invalid={!!errors[key]}
        aria-describedby={
          errors[key]
            ? `contract-error-${key}`
            : key === 'grossPremium'
              ? 'contract-premium-help'
              : undefined
        }
        onChange={(event) => change(key, event.target.value)}
      />
      {errors[key] && (
        <p id={`contract-error-${key}`} className="customer-field-error">
          {errors[key]}
        </p>
      )}
    </div>
  );
  function select(
    key: 'insurerId' | 'branchId' | 'productId' | 'paymentMethodId',
    label: string,
    options: ReadonlyArray<{ id: string; name: string }>,
  ) {
    const previous =
      key === 'insurerId'
        ? policy?.insurer
        : key === 'branchId'
          ? policy?.branch
          : key === 'productId'
            ? policy?.product
            : policy?.paymentMethod;
    const remembered = initialCatalogs[
      key === 'insurerId'
        ? 'insurers'
        : key === 'branchId'
          ? 'branches'
          : key === 'productId'
            ? 'products'
            : 'paymentMethods'
    ].find((x) => x.id === draft[key]);
    return (
      <div>
        <label htmlFor={`contract-${key}`}>{label}</label>
        <select
          id={`contract-${key}`}
          value={draft[key]}
          aria-invalid={!!errors[key]}
          aria-describedby={errors[key] ? `contract-error-${key}` : undefined}
          onChange={(event) => change(key, event.target.value)}
        >
          <option value="">Seçin</option>
          {draft[key] && !options.some((x) => x.id === draft[key]) && (
            <option value={draft[key]}>
              {previous?.id === draft[key]
                ? `${previous.name} (Mevcut; seçilemez)`
                : remembered
                  ? `${remembered.name} (Artık seçilemez)`
                  : 'Seçim artık kullanılamıyor'}
            </option>
          )}
          {options.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name}
            </option>
          ))}
        </select>
        {errors[key] && (
          <p id={`contract-error-${key}`} className="customer-field-error">
            {errors[key]}
          </p>
        )}
      </div>
    );
  }
  const minor = premiumMinor(effective.grossPremium.trim());
  return (
    <>
      {error && <p role="alert">{error}</p>}
      {busy && <p role="status">İşlem sürüyor…</p>}
      {pending && (
        <Button disabled={busy || blocked} variant="outline" onClick={() => void send(pending)}>
          Aynı işlemi yeniden dene
        </Button>
      )}
      {needsRead && (
        <Button disabled={busy} variant="outline" onClick={() => void readback()}>
          Kaydedilen poliçeyi yeniden oku
        </Button>
      )}
      {needsComparison && !blocked && (
        <Button disabled={busy} variant="outline" onClick={() => void compare()}>
          Güncel poliçeyi karşılaştır
        </Button>
      )}
      {!blocked && (
        <form
          className="customer-edit-form policy-contract-form"
          aria-label="Poliçe sözleşme formu"
          noValidate
          onSubmit={submit}
        >
          <p>
            <strong>{customer.displayName}</strong> ·{' '}
            {policy
              ? 'Müşteri bağlantısı değiştirilemez.'
              : 'Seçili müşteri için yeni sözleşme dönemi.'}
          </p>
          <fieldset disabled={locked}>
            <Card>
              <CardHeader>
                <CardTitle>Sigorta ve ödeme</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="customer-form-grid">
                  {select(
                    'insurerId',
                    'Sigorta şirketi',
                    catalogs.insurers.filter((x) => x.status === 'ACTIVE'),
                  )}
                  {select(
                    'branchId',
                    'Branş',
                    catalogs.branches.filter((x) => x.status === 'ACTIVE'),
                  )}
                  {select(
                    'productId',
                    'Ürün',
                    catalogs.products.filter(
                      (x) =>
                        x.status === 'ACTIVE' &&
                        x.insurerId === draft.insurerId &&
                        x.branchId === draft.branchId,
                    ),
                  )}
                  {select(
                    'paymentMethodId',
                    'Ödeme yöntemi',
                    catalogs.paymentMethods.filter((x) => x.status === 'ACTIVE'),
                  )}
                  {method?.supportsInstallments ? (
                    field('installmentCount', 'Taksit sayısı', 'number')
                  ) : !method && policy?.installmentCount != null ? (
                    <p>
                      Mevcut taksit sayısı: {policy.installmentCount}. Yöntem katalogda seçilebilir
                      olmadığı için taksit bilgisi korunur.
                    </p>
                  ) : null}
                </div>
                {policy && (
                  <p className="customer-legacy-hint">
                    Seçilemeyen mevcut katalog değerleri kendiliğinden değiştirilmez. Katalog/taksit
                    seçimi değişirse bütün yeni kombinasyon seçilebilir olmalıdır.
                  </p>
                )}
              </CardContent>
            </Card>
            <Card>
              <CardHeader>
                <CardTitle>Sözleşme dönemi ve prim</CardTitle>
              </CardHeader>
              <CardContent>
                <p>
                  Her poliçe tek bir sözleşme dönemidir. Yenileme için eski dönemin üzerine
                  yazmayın; yeni poliçe oluşturun.
                </p>
                <div className="customer-form-grid">
                  {field('policyNumber', 'Poliçe numarası', 'text', 200)}
                  {field('startDate', 'Başlangıç tarihi', 'date')}
                  {field('endDate', 'Bitiş tarihi', 'date')}
                  {field('grossPremium', 'Brüt prim')}
                  {field('currency', 'ISO para birimi', 'text', 3)}
                  <div>
                    <label htmlFor="contract-status">Poliçe durumu</label>
                    <select
                      id="contract-status"
                      value={draft.status}
                      onChange={(event) => change('status', event.target.value)}
                    >
                      {Object.entries(policyStatusLabel).map(([value, label]) => (
                        <option key={value} value={value}>
                          {label}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <p id="contract-premium-help" className="customer-legacy-hint">
                  Ondalık ayırıcı nokta: 1234.56. Binlik ayırıcı kullanmayın; en fazla iki ondalık
                  basamak. Para birimi üç büyük harfli ISO kodudur.
                </p>
              </CardContent>
            </Card>
          </fieldset>
          {comparison && (
            <aside className="company-contact-comparison" role="status">
              <strong>Sunucudan alınan karşılaştırma kaydı · sürüm {comparison.version}</strong>
              <dl className="customer-info-grid">
                {Object.entries(contractValues(policyDraft(comparison))).map(([key, value]) => (
                  <div key={key}>
                    <dt>
                      {
                        (
                          {
                            insurerId: 'Sigortacı kaydı',
                            branchId: 'Branş kaydı',
                            productId: 'Ürün kaydı',
                            paymentMethodId: 'Ödeme yöntemi kaydı',
                            policyNumber: 'Poliçe numarası',
                            startDate: 'Başlangıç',
                            endDate: 'Bitiş',
                            grossPremium: 'Brüt prim',
                            currency: 'Para birimi',
                            installmentCount: 'Taksit',
                            status: 'Durum',
                          } as Record<string, string>
                        )[key]
                      }
                    </dt>
                    <dd>
                      {key === 'insurerId'
                        ? comparison.insurer.name
                        : key === 'branchId'
                          ? comparison.branch.name
                          : key === 'productId'
                            ? comparison.product.name
                            : key === 'paymentMethodId'
                              ? comparison.paymentMethod.name
                              : (value ?? 'Belirtilmedi')}
                    </dd>
                  </div>
                ))}
              </dl>
              <p>
                Taslağınız korundu. Yalnız orijinal taslakta değiştirdiğiniz alanlar, bu
                karşılaştırma sürümüyle gönderilecek. Farkları inceleyerek yeniden onaylayın.
              </p>
            </aside>
          )}
          <aside className="company-contact-comparison" aria-label="Sözleşme özeti">
            <strong>Sözleşme özeti</strong>
            <p>
              {effective.policyNumber || 'Numara girilmedi'} ·{' '}
              {effective.startDate || 'Başlangıç girilmedi'} –{' '}
              {effective.endDate || 'Bitiş girilmedi'} ·{' '}
              {minor === null
                ? 'Prim girilmedi/geçersiz'
                : policyMoney(Number(minor), effective.currency)}
            </p>
          </aside>
          <div className="customer-form-actions">
            <Button type="submit" disabled={locked}>
              {policy
                ? comparison
                  ? 'Karşılaştırdım, değişiklikleri kaydet'
                  : 'Değişiklikleri kaydet'
                : 'Poliçeyi oluştur'}
            </Button>
            <Button asChild variant="outline">
              <Link to={policy ? `/policies/${encodeURIComponent(policy.id)}` : '/policies'}>
                Poliçelere dön
              </Link>
            </Button>
          </div>
        </form>
      )}
    </>
  );
}
