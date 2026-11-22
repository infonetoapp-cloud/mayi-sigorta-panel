import { useEffect, useRef, useState } from 'react';
import type { SelectableCatalogsDto, TodayTaskDto } from '../../../shared/types';
import { Button } from '../../components/ui/button';
import { parseMoneyInput, MONEY_INPUT_HELP } from '../../lib/monetary';
import { readCustomerResource } from '../customers/customer-resource';
import {
  blankPolicyDraft,
  premiumInput,
  premiumMinor,
  validatePolicy,
  type PolicyDraft,
} from '../policies/policy-form-model';
import { policyMoney, policyDate } from '../policies/policy-display';
import { exactQuoteUrl } from './quote-model';
import type { QuoteRecord } from './quote-model';
import { eligibleWonQuote, type SelectedWonQuote } from './won-quote';
import type { WonPriceOption } from '../../../shared/renewal-won-price';
import {
  priceDifferences,
  priceOptionKey,
  useWonPriceOptions,
  WonPriceChoices,
  WonPriceOptionStatus,
} from './won-price-options';
export interface CreatePolicySnapshot {
  customerId: string;
  insurerId: string;
  branchId: string;
  productId: string;
  paymentMethodId: string;
  assigneeMembershipId?: string;
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
  quote?: SelectedWonQuote;
  price?: WonPriceOption;
  noQuoteReason?: string;
  differenceReasonCode?: string;
}
const reasons = {
  PREMIUM_CHANGED: 'Düzenlenen poliçenin primi farklı',
  CURRENCY_CHANGED: 'Poliçenin para birimi farklı',
  PRODUCT_CHANGED: 'Ürün veya teminat değişti',
  PERIOD_CHANGED: 'Poliçe dönemi değişti',
  FINAL_POLICY_CHANGED: 'Düzenlenen poliçede birden fazla bilgi değişti',
};
export function WonCreatePolicyForm({
  task,
  disabled,
  masked,
  onBusy,
  onSubmit,
  rejectedPrice,
  newBusiness,
}: {
  task: Pick<TodayTaskDto, 'customerId' | 'customerDisplayName' | 'assigneeMembershipId'> & {
    renewalId?: string;
  };
  disabled: boolean;
  masked: boolean;
  onBusy: (busy: boolean) => void;
  onSubmit: (review: CreateReview) => void;
  rejectedPrice: number;
  newBusiness?: { caseId: string; branchId: string };
}) {
  const prices = useWonPriceOptions(
    masked ? undefined : task.renewalId,
    masked ? undefined : newBusiness?.caseId,
  );
  const [draft, setDraft] = useState<PolicyDraft>({
      ...blankPolicyDraft,
      branchId: newBusiness?.branchId ?? '',
    }),
    [catalogs, setCatalogs] = useState<SelectableCatalogsDto | null>(null),
    [quoteCursor, setQuoteCursor] = useState<string | null>(null),
    [quoteNext, setQuoteNext] = useState<string | null>(null),
    [quotes, setQuotes] = useState<QuoteRecord[]>([]),
    [selected, setSelected] = useState(''),
    [noQuoteReason, setNoQuoteReason] = useState(''),
    [quote, setQuote] = useState<SelectedWonQuote | null>(null),
    [price, setPrice] = useState<WonPriceOption | null>(null),
    [reason, setReason] = useState(''),
    [step, setStep] = useState(0),
    [review, setReview] = useState<CreateReview | null>(null),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [confirmed, setConfirmed] = useState(false);
  const epoch = useRef(0),
    lock = useRef(false),
    controllers = useRef(new Set<AbortController>()),
    heading = useRef<HTMLHeadingElement>(null),
    errorBox = useRef<HTMLParagraphElement>(null);
  useEffect(() => {
    if (!rejectedPrice) return;
    setSelected('');
    setReview(null);
    setConfirmed(false);
    setStep(0);
    prices.reload();
  }, [rejectedPrice]);
  useEffect(
    () => () => {
      epoch.current++;
      lock.current = false;
      for (const c of controllers.current) c.abort();
    },
    [],
  );
  useEffect(() => onBusy(busy), [busy, onBusy]);
  useEffect(() => {
    heading.current?.focus();
  }, [step]);
  useEffect(() => {
    if (error) errorBox.current?.focus();
  }, [error]);
  useEffect(() => {
    if (disabled) {
      setConfirmed(false);
      setReview(null);
      setStep((previous) => (previous === 2 ? 1 : previous));
    }
  }, [disabled]);
  async function work(fn: (signal: AbortSignal) => Promise<void>) {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError('');
    const c = new AbortController(),
      e = epoch.current;
    controllers.current.add(c);
    try {
      await fn(c.signal);
    } catch {
      if (e === epoch.current && !c.signal.aborted) {
        setStep((previous) => (previous === 2 ? 1 : previous));
        setError('Bilgiler doğrulanamadı. Taslağınız korundu; yeniden deneyin.');
      }
    } finally {
      controllers.current.delete(c);
      if (e === epoch.current) {
        lock.current = false;
        setBusy(false);
      }
    }
  }
  async function readCatalogs(signal: AbortSignal) {
    const c = await readCustomerResource<SelectableCatalogsDto>('/api/catalogs/selectable', signal);
    if (
      !['insurers', 'branches', 'products', 'paymentMethods'].every((k) =>
        Array.isArray(c[k as keyof SelectableCatalogsDto]),
      )
    )
      throw Error('INVALID_CATALOG');
    return c;
  }
  async function readQuotes(
    signal: AbortSignal,
    selection?: SelectedWonQuote,
    cursor?: string | null,
  ) {
    if (!task.renewalId) throw Error('MISSING_RENEWAL');
    const root = `/api/renewals/${encodeURIComponent(task.renewalId)}/quotes`;
    const h = await readCustomerResource<{ quotes: QuoteRecord[]; nextCursor?: string | null }>(
      selection
        ? exactQuoteUrl(root, selection.quoteId, selection.version.id)
        : cursor
          ? `${root}?cursor=${encodeURIComponent(cursor)}`
          : root,
      signal,
    );
    if (!Array.isArray(h.quotes) || new Set(h.quotes.map((q) => q.id)).size !== h.quotes.length)
      throw Error('INVALID_QUOTES');
    return h;
  }
  useEffect(() => {
    void work(async (signal) => {
      const c = await readCatalogs(signal);
      if (signal.aborted) return;
      setCatalogs(c);
      if (newBusiness) return;
      try {
        const rows = await readQuotes(signal);
        if (!signal.aborted) {
          setQuotes(rows.quotes);
          setQuoteCursor(null);
          setQuoteNext(rows.nextCursor ?? null);
        }
      } catch {
        if (!signal.aborted)
          setError(
            'Kayıtlı teklifler okunamadı. Teklif seçimini tekrar yükleyebilir veya teklif kaydı olmadan devam edebilirsiniz.',
          );
      }
    });
  }, []);
  function change(key: keyof PolicyDraft, value: string) {
    setDraft((d) => ({
      ...d,
      [key]: value,
      ...(key === 'insurerId' || key === 'branchId' ? { productId: '' } : {}),
      ...(key === 'paymentMethodId' ? { installmentCount: '' } : {}),
    }));
    setReview(null);
    setConfirmed(false);
    setError('');
  }
  function differences() {
    if (price)
      return priceDifferences(price, {
        premium: premiumMinor(draft.grossPremium),
        currency: draft.currency,
        startDate: draft.startDate,
        endDate: draft.endDate,
      });
    if (!quote) return [];
    const v = quote.version;
    return [
      draft.productId !== v.product_id ? 'Ürün' : null,
      premiumMinor(draft.grossPremium) !== BigInt(v.gross_premium_minor) ? 'Prim' : null,
      draft.currency !== v.currency ? 'Para birimi' : null,
      draft.startDate !== v.start_date || draft.endDate !== v.end_date ? 'Poliçe dönemi' : null,
    ].filter(Boolean);
  }
  function snapshot(c: SelectableCatalogsDto): CreateReview | null {
    if (draft.installmentCount && Number(draft.installmentCount) > 9) {
      setError('Taksit sayısını 2–9 aralığından seçin.');
      return null;
    }
    const errors = validatePolicy(draft, c, true);
    if (Object.keys(errors).length) {
      setError(Object.values(errors).join(' '));
      return null;
    }
    if (differences().length && !reason) {
      setError('Teklif ile poliçe arasındaki farkın nedenini seçin.');
      return null;
    }
    const rows = [
      c.insurers.find((r) => r.id === draft.insurerId)!,
      c.branches.find((r) => r.id === draft.branchId)!,
      c.products.find((r) => r.id === draft.productId)!,
      c.paymentMethods.find((r) => r.id === draft.paymentMethodId)!,
    ];
    if (new Set(rows.map((r) => r.agencyId)).size !== 1) throw Error('CATALOG_MISMATCH');
    return {
      agencyId: rows[0]!.agencyId,
      policy: {
        customerId: task.customerId,
        insurerId: draft.insurerId,
        branchId: draft.branchId,
        productId: draft.productId,
        paymentMethodId: draft.paymentMethodId,
        ...(task.assigneeMembershipId ? { assigneeMembershipId: task.assigneeMembershipId } : {}),
        policyNumber: draft.policyNumber.trim(),
        startDate: draft.startDate,
        endDate: draft.endDate,
        grossPremium: parseMoneyInput(draft.grossPremium)!.canonical,
        currency: draft.currency,
        installmentCount: draft.installmentCount ? Number(draft.installmentCount) : null,
        status: 'ACTIVE',
      },
      ...(quote ? { quote: structuredClone(quote) } : {}),
      ...(price ? { price: structuredClone(price) } : {}),
      ...(newBusiness && selected === 'NONE' ? { noQuoteReason: noQuoteReason.trim() } : {}),
      ...(differences().length ? { differenceReasonCode: reason } : {}),
    };
  }
  function signature(c: SelectableCatalogsDto) {
    return JSON.stringify([
      c.insurers.find((r) => r.id === draft.insurerId),
      c.branches.find((r) => r.id === draft.branchId),
      c.products.find((r) => r.id === draft.productId),
      c.paymentMethods.find((r) => r.id === draft.paymentMethodId),
    ]);
  }
  const [reviewSignature, setReviewSignature] = useState('');
  const method = catalogs?.paymentMethods.find((r) => r.id === draft.paymentMethodId),
    blocked = disabled || busy;
  const options = quotes.map(eligibleWonQuote).filter((q) => q !== null);
  function next() {
    if (!catalogs) {
      setError(
        'Şirket ve ödeme seçenekleri yüklenemedi. Kayıtlı teklifleri yenileyip tekrar deneyin.',
      );
      return;
    }
    if (!selected) {
      setError('Kullanılacak teklifi veya teklif kaydı olmadan devam seçeneğini seçin.');
      return;
    }
    if (newBusiness && selected === 'NONE' && !noQuoteReason.trim()) {
      setError('Teklif kaydı olmadan devam etme nedeninizi yazın.');
      return;
    }
    const q = options.find((q) => q.version.id === selected) ?? null;
    const chosenPrice =
      prices.options.find((candidate) => priceOptionKey(candidate) === selected) ?? null;
    if (selected !== 'NONE' && !q && !chosenPrice) {
      setError('Bu teklif artık geçerli değil. Kayıtlı teklifleri yenileyin.');
      return;
    }
    setQuote(q);
    setPrice(chosenPrice);
    setReason('');
    setConfirmed(false);
    setError('');
    if (q && q.version.id !== quote?.version.id) {
      const v = q.version;
      setDraft((d) => ({
        ...d,
        insurerId: v.insurer_id,
        branchId: v.branch_id,
        productId: v.product_id,
        paymentMethodId: v.payment_method_id,
        startDate: v.start_date,
        endDate: v.end_date,
        grossPremium: premiumInput(v.gross_premium_minor),
        currency: v.currency,
        installmentCount: v.installment_count === null ? '' : String(v.installment_count),
      }));
    }
    if (chosenPrice && priceOptionKey(chosenPrice) !== (price && priceOptionKey(price))) {
      setDraft((d) => ({
        ...d,
        insurerId: chosenPrice.insurerId,
        branchId: chosenPrice.branchId,
        productId:
          d.insurerId === chosenPrice.insurerId && d.branchId === chosenPrice.branchId
            ? d.productId
            : '',
        grossPremium: premiumInput(chosenPrice.amountMinor),
        currency: chosenPrice.currency,
        startDate: chosenPrice.startDate ?? d.startDate,
        endDate: chosenPrice.endDate ?? d.endDate,
      }));
    }
    setStep(1);
  }
  const field = (key: keyof PolicyDraft, label: string, type = 'text') => (
    <div>
      <label htmlFor={'issue-' + key}>{label} *</label>
      <input
        id={'issue-' + key}
        name={key}
        required
        type={type}
        value={draft[key]}
        maxLength={key === 'policyNumber' ? 200 : 100}
        inputMode={key === 'grossPremium' ? 'decimal' : undefined}
        autoCorrect="off"
        autoCapitalize="none"
        spellCheck={false}
        onInput={type === 'date' ? (e) => change(key, e.currentTarget.value) : undefined}
        onChange={(e) => change(key, e.target.value)}
      />
    </div>
  );
  const select = (
    key: 'insurerId' | 'branchId' | 'productId' | 'paymentMethodId',
    label: string,
    rows: readonly { id: string; name: string; status: string }[],
  ) => (
    <div>
      <label htmlFor={'issue-' + key}>{label} *</label>
      <select
        id={'issue-' + key}
        name={key}
        required
        value={draft[key]}
        disabled={
          (key === 'branchId' && (!!price || !!newBusiness)) || (key === 'insurerId' && !!price)
        }
        onChange={(e) => change(key, e.target.value)}
      >
        <option value="">Seçin</option>
        {rows
          .filter((r) => r.status === 'ACTIVE')
          .map((r) => (
            <option key={r.id} value={r.id}>
              {r.name}
            </option>
          ))}
      </select>
    </div>
  );
  if (masked) return null;
  return (
    <form
      className="issue-policy-form"
      aria-label="Poliçelendirme adımları"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        if (blocked) return;
        if (step === 0) return next();
        if (step === 1) {
          if (!catalogs) return;
          const s = snapshot(catalogs);
          if (s) {
            setReview(s);
            setReviewSignature(signature(catalogs));
            setConfirmed(false);
            setError('');
            setStep(2);
          }
          return;
        }
        if (!review || !confirmed) {
          setError('Poliçe bilgilerini kontrol edip onaylayın.');
          return;
        }
        void work(async (signal) => {
          const c = await readCatalogs(signal);
          if (signal.aborted) return;
          setCatalogs(c);
          const s = snapshot(c);
          if (
            !s ||
            JSON.stringify(s) !== JSON.stringify(review) ||
            signature(c) !== reviewSignature
          ) {
            setStep(1);
            setConfirmed(false);
            setError('Seçimler değişti. Bilgileri yeniden kontrol edin.');
            return;
          }
          if (review.quote) {
            const rows = await readQuotes(signal, review.quote);
            if (signal.aborted) return;
            const fresh = rows.quotes.find((q) => q.id === review.quote!.quoteId);
            const chosen = fresh ? eligibleWonQuote(fresh) : null;
            if (!chosen || JSON.stringify(chosen) !== JSON.stringify(review.quote)) {
              setConfirmed(false);
              setError(
                'Seçilen teklif değişti veya süresi doldu. Teklifleri yeniden okuyup seçim yapın.',
              );
              return;
            }
          }
          onSubmit(structuredClone(review));
        });
      }}
    >
      <ol className="issue-progress" aria-label="Poliçelendirme adımları">
        {['Teklif seç', 'Poliçe ve ödeme', 'Kontrol ve kaydet'].map((title, i) => (
          <li key={title} aria-current={step === i ? 'step' : undefined}>
            {i + 1}. {title}
          </li>
        ))}
      </ol>
      <h4 ref={heading} tabIndex={-1}>
        {['Kullanılacak teklif', 'Düzenlenen poliçenin bilgileri', 'Poliçeyi kontrol edin'][step]}
      </h4>
      <p className="issue-help">
        Sigorta şirketinde düzenlenen poliçeyi CRM'e kaydediyorsunuz. Bu işlem ödeme çekmez veya
        tahsilat kaydetmez.
      </p>
      <fieldset disabled={blocked}>
        <legend className="sr-only">
          {['Teklif seçimi', 'Poliçe bilgileri', 'Son kontrol'][step]}
        </legend>
        {step === 0 && (
          <>
            <label htmlFor="issue-quote">Kayıtlı teklif *</label>
            <select
              id="issue-quote"
              name="quoteVersion"
              required
              value={selected}
              onChange={(e) => {
                setSelected(e.target.value);
                setError('');
              }}
            >
              <option value="" disabled>
                Teklif seçin
              </option>
              <WonPriceChoices options={prices.options} />
              {options.map((q) => (
                <option key={q.version.id} value={q.version.id}>
                  {catalogs?.insurers.find((i) => i.id === q.version.insurer_id)?.name ??
                    'Sigorta şirketi'}{' '}
                  ·{' '}
                  {q.version.product_name ??
                    catalogs?.products.find((p) => p.id === q.version.product_id)?.name}{' '}
                  · {policyMoney(q.version.gross_premium_minor, q.version.currency)}
                </option>
              ))}
              <option value="NONE">
                {newBusiness ? 'Teklifsiz devam et' : 'Teklif kaydı olmadan devam et'}
              </option>
            </select>
            {newBusiness && selected === 'NONE' && (
              <>
                <label htmlFor="issue-no-quote">Teklif kaydı olmadan devam etme nedeni *</label>
                <textarea
                  id="issue-no-quote"
                  name="noQuoteReason"
                  rows={2}
                  required
                  maxLength={500}
                  value={noQuoteReason}
                  onChange={(e) => {
                    setNoQuoteReason(e.target.value);
                    setError('');
                  }}
                />
              </>
            )}
            <WonPriceOptionStatus
              prices={prices}
              reload={() => {
                if (selected.startsWith('price:')) setSelected('');
                prices.reload();
              }}
            />
            <p className="issue-help">
              {newBusiness
                ? 'Poliçeye bağlanacak kabul edilmiş fiyatı seçin.'
                : 'Müşterinin kabul ettiği fiyatlar ve geçerli gönderilmiş teklifler listelenir.'}
            </p>
            {(!newBusiness || !catalogs) && (
              <Button
                variant="outline"
                disabled={blocked}
                onClick={() =>
                  void work(async (signal) => {
                    const c = await readCatalogs(signal);
                    if (signal.aborted) return;
                    setCatalogs(c);
                    if (newBusiness) return;
                    const rows = await readQuotes(signal);
                    if (!signal.aborted) {
                      setQuotes(rows.quotes);
                      setQuoteCursor(null);
                      setQuoteNext(rows.nextCursor ?? null);
                    }
                  })
                }
              >
                {newBusiness ? 'Poliçe seçeneklerini yenile' : 'Kayıtlı teklifleri yenile'}
              </Button>
            )}
            {(quoteCursor || quoteNext) && (
              <div className="customer-form-actions">
                <Button
                  type="button"
                  variant="outline"
                  disabled={blocked}
                  onClick={() =>
                    void work(async (signal) => {
                      const h = await readQuotes(signal);
                      if (!signal.aborted) {
                        setQuotes(h.quotes);
                        setQuoteCursor(null);
                        setQuoteNext(h.nextCursor ?? null);
                        setSelected('');
                      }
                    })
                  }
                >
                  İlk teklif sayfası
                </Button>
                {quoteNext && (
                  <Button
                    type="button"
                    variant="outline"
                    disabled={blocked}
                    onClick={() =>
                      void work(async (signal) => {
                        const next = quoteNext,
                          h = await readQuotes(signal, undefined, next);
                        if (!signal.aborted) {
                          setQuotes(h.quotes);
                          setQuoteCursor(next);
                          setQuoteNext(h.nextCursor ?? null);
                          setSelected('');
                        }
                      })
                    }
                  >
                    Diğer teklifler
                  </Button>
                )}
              </div>
            )}
          </>
        )}
        {step === 1 && catalogs && (
          <>
            <div className="issue-fields">
              {select('insurerId', 'Sigorta şirketi', catalogs.insurers)}
              {select('branchId', 'Branş', catalogs.branches)}
              {select(
                'productId',
                'Ürün',
                catalogs.products.filter(
                  (p) => p.insurerId === draft.insurerId && p.branchId === draft.branchId,
                ),
              )}
              {field('policyNumber', 'Yeni poliçe numarası')}
              {field('startDate', 'Başlangıç tarihi', 'date')}
              {field('endDate', 'Bitiş tarihi', 'date')}
              {field('grossPremium', 'Brüt prim')}
              <p className="issue-help">{MONEY_INPUT_HELP}</p>
              {field('currency', 'Para birimi')}
              {select('paymentMethodId', 'Ödeme yöntemi', catalogs.paymentMethods)}
              {method?.supportsInstallments && (
                <div>
                  <label htmlFor="issue-installments">Taksit sayısı *</label>
                  <select
                    id="issue-installments"
                    name="installmentCount"
                    value={draft.installmentCount}
                    onChange={(e) => change('installmentCount', e.target.value)}
                    required
                  >
                    <option value="">Seçin</option>
                    {Array.from(
                      { length: Math.max(0, Math.min(9, method.maxInstallments) - 1) },
                      (_, i) => i + 2,
                    ).map((n) => (
                      <option key={n} value={n}>
                        {n} taksit
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
            <p className="issue-help">
              Başlangıç ve bitişi gerçek poliçeye göre girin; bir yıllık dönem zorunlu değildir.
              Prim örneği: 1250.50. Tek çekimde taksit kaydı oluşturulmaz.
            </p>
            {(quote || price) && differences().length > 0 && (
              <div className="issue-difference">
                <p>Seçilen tekliften farklı: {differences().join(', ')}.</p>
                <label htmlFor="issue-difference">Farkın nedeni *</label>
                <select
                  id="issue-difference"
                  name="differenceReason"
                  value={reason}
                  onChange={(e) => {
                    setReason(e.target.value);
                    setError('');
                  }}
                  required
                >
                  <option value="">Neden seçin</option>
                  {Object.entries(reasons).map(([code, label]) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
                </select>
              </div>
            )}
          </>
        )}
        {step === 2 && review && (
          <>
            <dl className="issue-summary">
              <div>
                <dt>Müşteri</dt>
                <dd>{task.customerDisplayName}</dd>
              </div>
              <div>
                <dt>Şirket / ürün</dt>
                <dd>
                  {catalogs?.insurers.find((i) => i.id === review.policy.insurerId)?.name} ·{' '}
                  {catalogs?.products.find((p) => p.id === review.policy.productId)?.name}
                </dd>
              </div>
              <div>
                <dt>Poliçe numarası</dt>
                <dd>{review.policy.policyNumber}</dd>
              </div>
              <div>
                <dt>Poliçe dönemi</dt>
                <dd>
                  {policyDate(review.policy.startDate)} – {policyDate(review.policy.endDate)}
                </dd>
              </div>
              <div>
                <dt>Brüt prim</dt>
                <dd>
                  {policyMoney(
                    Number(premiumMinor(review.policy.grossPremium)),
                    review.policy.currency,
                  )}
                </dd>
              </div>
              {review.price && (
                <div>
                  <dt>Müşterinin kabul ettiği fiyat</dt>
                  <dd>
                    {review.price.insurerName} ·{' '}
                    {policyMoney(review.price.amountMinor, review.price.currency)}
                  </dd>
                </div>
              )}
              {review.noQuoteReason && (
                <div>
                  <dt>Teklif kaydı olmadan devam etme nedeni</dt>
                  <dd>{review.noQuoteReason}</dd>
                </div>
              )}
              <div>
                <dt>Ödeme yöntemi</dt>
                <dd>
                  {
                    catalogs?.paymentMethods.find((m) => m.id === review.policy.paymentMethodId)
                      ?.name
                  }
                  {review.policy.installmentCount
                    ? ` · ${review.policy.installmentCount} taksit`
                    : ' · Tek çekim / taksitsiz'}
                </dd>
              </div>
              {review.differenceReasonCode && (
                <div>
                  <dt>Teklif farkı</dt>
                  <dd>{reasons[review.differenceReasonCode as keyof typeof reasons]}</dd>
                </div>
              )}
            </dl>
            <p>
              {newBusiness
                ? 'Kaydettiğinizde yeni poliçe oluşturulur, teklif çalışması poliçelendirildi olarak kapanır ve ilgili takip tamamlanır.'
                : 'Kaydettiğinizde yeni poliçe oluşturulur, yenileme poliçelendirildi olarak kapanır ve ilgili takip tamamlanır.'}
            </p>
            <label className="issue-confirm">
              <input
                type="checkbox"
                name="confirmed"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              Poliçe ve ödeme bilgilerini kontrol ettim
            </label>
          </>
        )}
        <div className="customer-form-actions">
          {step > 0 && (
            <Button
              variant="outline"
              onClick={() => {
                setStep(step - 1);
                setConfirmed(false);
                setError('');
              }}
            >
              Geri
            </Button>
          )}
          <Button type="submit">{step === 2 ? 'Poliçeyi kaydet' : 'Devam et'}</Button>
        </div>
      </fieldset>
      {busy && <p role="status">Bilgiler doğrulanıyor…</p>}
      {error && (
        <p ref={errorBox} tabIndex={-1} role="alert">
          {error}
        </p>
      )}
    </form>
  );
}
