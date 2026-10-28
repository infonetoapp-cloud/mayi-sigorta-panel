import { useEffect, useRef, useState } from 'react';
import type {
  CustomerAssignmentOptionDto,
  SelectableCatalogsDto,
  TodayTaskDto,
} from '../../../shared/types';
import { Button } from '../../components/ui/button';
import { parseMoneyInput, formatMoneyMinor, MONEY_INPUT_HELP } from '../../lib/monetary';
import { readCustomerResource } from '../customers/customer-resource';
import {
  blankPolicyDraft,
  premiumMinor,
  validatePolicy,
  type PolicyDraft,
} from '../policies/policy-form-model';
export interface CreatePolicySnapshot {
  customerId: string;
  insurerId: string;
  branchId: string;
  productId: string;
  paymentMethodId: string;
  assigneeMembershipId: string;
  policyNumber: string;
  startDate: string;
  endDate: string;
  grossPremium: string;
  currency: string;
  installmentCount: number | null;
  status: 'ACTIVE';
}
export interface CreateReview {
  policy: CreatePolicySnapshot;
  agencyId: string;
}
export function WonCreatePolicyForm({
  task,
  disabled,
  masked,
  onBusy,
  onSubmit,
}: {
  task: TodayTaskDto;
  disabled: boolean;
  masked: boolean;
  onBusy: (busy: boolean) => void;
  onSubmit: (review: CreateReview) => void;
}) {
  const [draft, setDraft] = useState<PolicyDraft>({ ...blankPolicyDraft }),
    [assignee, setAssignee] = useState(''),
    [catalogs, setCatalogs] = useState<SelectableCatalogsDto | null>(null),
    [options, setOptions] = useState<readonly CustomerAssignmentOptionDto[]>([]),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [review, setReview] = useState<(CreateReview & { signature: string }) | null>(null),
    [confirmed, setConfirmed] = useState(false);
  const controllers = useRef(new Set<AbortController>()),
    epoch = useRef(0),
    lock = useRef(false);
  useEffect(
    () => () => {
      epoch.current++;
      for (const c of controllers.current) c.abort();
      lock.current = false;
    },
    [],
  );
  useEffect(() => onBusy(busy), [busy, onBusy]);
  useEffect(() => {
    if (disabled) {
      setConfirmed(false);
      setReview(null);
    }
  }, [disabled]);
  async function catalogsRead(signal: AbortSignal) {
    const d = await readCustomerResource<SelectableCatalogsDto>('/api/catalogs/selectable', signal);
    if (
      !['insurers', 'branches', 'products', 'paymentMethods'].every((k) =>
        Array.isArray(d[k as keyof SelectableCatalogsDto]),
      )
    )
      throw Error('INVALID_CATALOG');
    return d;
  }
  async function work(fn: (signal: AbortSignal, e: number) => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    const c = new AbortController(),
      e = epoch.current;
    controllers.current.add(c);
    try {
      await fn(c.signal, e);
    } catch {
      if (e === epoch.current && !c.signal.aborted) {
        setCatalogs(null);
        setConfirmed(false);
        setReview(null);
        setError(
          'Katalog veya yetkili seçenek okunamadı. Taslak korunur; yeni gönderim kapalıdır.',
        );
      }
    } finally {
      controllers.current.delete(c);
      if (e === epoch.current) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  function signature(c: SelectableCatalogsDto, d: PolicyDraft) {
    return JSON.stringify([
      c.insurers.find((r) => r.id === d.insurerId),
      c.branches.find((r) => r.id === d.branchId),
      c.products.find((r) => r.id === d.productId),
      c.paymentMethods.find((r) => r.id === d.paymentMethodId),
    ]);
  }
  function snapshot(c: SelectableCatalogsDto): CreateReview | null {
    const errors = validatePolicy(draft, c, true);
    if (Object.keys(errors).length || !assignee) {
      setError(Object.values(errors).join(' ') || 'Poliçe sorumlusunu açıkça seçin.');
      return null;
    }
    const rows = [
      c.insurers.find((r) => r.id === draft.insurerId)!,
      c.branches.find((r) => r.id === draft.branchId)!,
      c.products.find((r) => r.id === draft.productId)!,
      c.paymentMethods.find((r) => r.id === draft.paymentMethodId)!,
    ];
    if (new Set(rows.map((r) => r.agencyId)).size !== 1) {
      setError('Katalog acente kimlikleri uyuşmuyor.');
      return null;
    }
    return {
      agencyId: rows[0]!.agencyId,
      policy: {
        customerId: task.customerId,
        insurerId: draft.insurerId,
        branchId: draft.branchId,
        productId: draft.productId,
        paymentMethodId: draft.paymentMethodId,
        assigneeMembershipId: assignee,
        policyNumber: draft.policyNumber.trim(),
        startDate: draft.startDate,
        endDate: draft.endDate,
        grossPremium: parseMoneyInput(draft.grossPremium)!.canonical,
        currency: draft.currency,
        installmentCount: draft.installmentCount ? Number(draft.installmentCount) : null,
        status: 'ACTIVE',
      },
    };
  }
  useEffect(() => {
    void work(async (signal, e) => {
      const c = await catalogsRead(signal);
      if (e === epoch.current) {
        setCatalogs(c);
        setError('');
      }
    });
  }, []);
  function change(key: keyof PolicyDraft, value: string) {
    setDraft((d) => ({ ...d, [key]: value }));
    setReview(null);
    setConfirmed(false);
  }
  const method = catalogs?.paymentMethods.find((r) => r.id === draft.paymentMethodId),
    blocked = disabled || busy;
  if (masked) return null;
  return (
    <div className="today-outcome-form">
      <h4>Yeni ACTIVE poliçe bilgileri</h4>
      <p>
        Müşteri sabit: {task.customerDisplayName}. Bu CRM kayıt işlemidir; sigortacıdan gerçek
        poliçe düzenlemez veya müşteriye mesaj göndermez. Tek işlem poliçeyi oluşturur, priminin
        tamamını bağlar ve özgün takibi kapatır.
      </p>
      <p>
        Bu dalda isteğe bağlı teklif kabulü desteklenmez. Teklif seçilmez ve kabul edilmiş sayılmaz.
      </p>
      <fieldset disabled={blocked}>
        <legend>Yeni poliçe alanları</legend>
        {(['insurerId', 'branchId', 'productId', 'paymentMethodId'] as const).map((key) => {
          const label = {
            insurerId: 'Sigorta şirketi',
            branchId: 'Branş',
            productId: 'Ürün',
            paymentMethodId: 'Ödeme yöntemi',
          }[key];
          const rows =
            key === 'insurerId'
              ? catalogs?.insurers
              : key === 'branchId'
                ? catalogs?.branches
                : key === 'paymentMethodId'
                  ? catalogs?.paymentMethods
                  : catalogs?.products.filter(
                      (r) => r.insurerId === draft.insurerId && r.branchId === draft.branchId,
                    );
          return (
            <label key={key}>
              {label}
              <select value={draft[key]} onChange={(e) => change(key, e.target.value)}>
                <option value="">Açık seçim yapın</option>
                {rows
                  ?.filter((r) => r.status === 'ACTIVE')
                  .map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.name}
                    </option>
                  ))}
                {draft[key] && !rows?.some((r) => r.id === draft[key] && r.status === 'ACTIVE') && (
                  <option value={draft[key]} disabled>
                    Önceki seçim artık uygun değil
                  </option>
                )}
              </select>
            </label>
          );
        })}
        <label>
          Poliçe sorumlusu
          <select
            value={assignee}
            onChange={(e) => {
              setAssignee(e.target.value);
              setReview(null);
              setConfirmed(false);
            }}
          >
            <option value="">Sorumluyu açıkça seçin</option>
            {task.assigneeMembershipId && (
              <option value={task.assigneeMembershipId}>Seçili görevin sorumlusu</option>
            )}
            {options
              .filter((r) => r.membershipId !== task.assigneeMembershipId)
              .map((r) => (
                <option key={r.membershipId} value={r.membershipId}>
                  {r.label}
                </option>
              ))}
          </select>
        </label>
        <p>
          Poliçe sorumlusunu açıkça seçin. Başka bir çalışanı atamak için ayrıca yetkiniz gerekir.
        </p>
        <Button
          type="button"
          onClick={() =>
            void work(async (signal, e) => {
              try {
                const rows = await readCustomerResource<readonly CustomerAssignmentOptionDto[]>(
                  `/api/policies/${encodeURIComponent(task.policyId ?? '')}/assignment-options`,
                  signal,
                );
                if (e !== epoch.current) return;
                if (
                  !Array.isArray(rows) ||
                  rows.some((r) => !r.membershipId || typeof r.label !== 'string')
                )
                  throw Error('INVALID_OPTIONS');
                setOptions(rows);
                setError('');
              } catch {
                if (e === epoch.current)
                  setError(
                    'Diğer poliçe sorumlularını okuma izni doğrulanamadı. Mevcut açık seçim korunur.',
                  );
              }
            })
          }
        >
          Diğer yetkili poliçe sorumlularını oku
        </Button>
        {(['policyNumber', 'startDate', 'endDate', 'grossPremium', 'currency'] as const).map(
          (key) => (
            <label key={key}>
              {
                {
                  policyNumber: 'Yeni poliçe numarası',
                  startDate: 'Başlangıç tarihi',
                  endDate: 'Bitiş tarihi',
                  grossPremium: 'Brüt prim',
                  currency: 'Para birimi',
                }[key]
              }
              <input
                type={key === 'startDate' || key === 'endDate' ? 'date' : 'text'}
                inputMode={key === 'grossPremium' ? 'decimal' : undefined}
                value={draft[key]}
                maxLength={key === 'policyNumber' ? 200 : 100}
                onChange={(e) => change(key, e.target.value)}
              />
            </label>
          ),
        )}
        {method?.supportsInstallments && (
          <label>
            Taksit sayısı
            <input
              value={draft.installmentCount}
              onChange={(e) => change('installmentCount', e.target.value)}
              inputMode="numeric"
            />
          </label>
        )}
        {!method?.supportsInstallments && draft.installmentCount && (
          <Button type="button" onClick={() => change('installmentCount', '')}>
            Taksit seçimini açıkça temizle
          </Button>
        )}
        <p>Durum: ACTIVE. {MONEY_INPUT_HELP}</p>
        <Button
          type="button"
          disabled={!catalogs}
          onClick={() => {
            if (!catalogs) return;
            const s = snapshot(catalogs);
            if (s) {
              setReview({ ...s, signature: signature(catalogs, draft) });
              setConfirmed(false);
              setError('');
            }
          }}
        >
          Yeni poliçeyi gözden geçir
        </Button>
        {review && (
          <>
            <p>
              İncelenen yeni poliçe: {review.policy.policyNumber}; sigortacı{' '}
              {catalogs?.insurers.find((r) => r.id === review.policy.insurerId)?.name}; ürün{' '}
              {catalogs?.products.find((r) => r.id === review.policy.productId)?.name}; branş{' '}
              {catalogs?.branches.find((r) => r.id === review.policy.branchId)?.name}; ödeme{' '}
              {catalogs?.paymentMethods.find((r) => r.id === review.policy.paymentMethodId)?.name};{' '}
              {review.policy.startDate} → {review.policy.endDate}; prim{' '}
              {formatMoneyMinor(
                Number(premiumMinor(review.policy.grossPremium)),
                review.policy.currency,
              )}
              ; taksit {review.policy.installmentCount ?? 'yok'}; sorumlu{' '}
              {options.find((row) => row.membershipId === review.policy.assigneeMembershipId)
                ?.label || 'Seçili görevin sorumlusu'}
              .
            </p>
            <details>
              <summary>Destek ayrıntıları</summary>
              <p>
                {task.customerDisplayName} · Önceki poliçe: {task.policyNumber}. Oluşturma yalnız
                seçili yenilemeye uygulanır; mevcut dönem korunur.
              </p>
            </details>
            <label>
              <input
                type="checkbox"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              Yeni poliçe oluşturulmasını ve kazanıldı sonucunu onaylıyorum
            </label>
            <Button
              type="button"
              disabled={!confirmed || !catalogs}
              onClick={() => {
                if (!review || !confirmed) return;
                void work(async (signal, e) => {
                  const c = await catalogsRead(signal);
                  if (e !== epoch.current) return;
                  setCatalogs(c);
                  const current = snapshot(c);
                  if (
                    !current ||
                    signature(c, draft) !== review.signature ||
                    JSON.stringify(current.policy) !== JSON.stringify(review.policy)
                  ) {
                    setReview(null);
                    setConfirmed(false);
                    setError(
                      'Katalog veya seçim değişti. Taslak korundu; alanları yeniden inceleyip onaylayın.',
                    );
                    return;
                  }
                  onSubmit(structuredClone(review));
                });
              }}
            >
              Yeni poliçe oluştur ve kazanıldı kaydet
            </Button>
          </>
        )}
      </fieldset>
      <Button
        type="button"
        disabled={blocked}
        onClick={() => {
          setConfirmed(false);
          setReview(null);
          void work(async (signal, e) => {
            const c = await catalogsRead(signal);
            if (e === epoch.current) {
              setCatalogs(c);
              setError('');
            }
          });
        }}
      >
        Poliçe kataloglarını yeniden oku
      </Button>
      {busy && <p role="status">Poliçe katalogları doğrulanıyor…</p>}
      {error && <p role="alert">{error}</p>}
    </div>
  );
}
