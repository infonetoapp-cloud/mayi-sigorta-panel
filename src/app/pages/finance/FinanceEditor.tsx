import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { PolicyDetailDto } from '../../../shared/types';
import {
  financeCommandSchema,
  financeMethodLabels,
  financeReasons,
  type FinanceCommand,
  type FinanceDetail,
  type FinanceEntry,
} from '../../../shared/finance';
import { Button } from '../../components/ui/button';
import {
  compareEdits,
  FieldConflictChoices,
  type ConflictChoices,
} from '../../components/ui/field-conflicts';
import { readCustomerResource } from '../customers/customer-resource';
import { financeDetailFor } from './finance-read-schemas';
import { readPolicyDetail } from '../policies/policy-read-schemas';
import { premiumInput } from '../policies/policy-form-model';
import { MONEY_INPUT_HELP, parseMoneyInput } from '../../lib/monetary';
import { policyMoney, storedPolicyDate } from '../policies/policy-display';
import { useFinanceWrite } from './use-finance-write';
import type { TaskOperationRisk } from '../today-work/TaskOperationsSection';
type Kind = FinanceCommand['kind'];
const financeLabels = { amount: 'Tutar', dueDate: 'Vade' };

export function FinanceEditor({
  kind,
  policy,
  detail,
  entry,
  onRisk,
  onClose,
  onDone,
}: {
  kind: Kind;
  policy?: PolicyDetailDto;
  detail?: FinanceDetail;
  entry?: FinanceEntry;
  onRisk: (risk: TaskOperationRisk) => void;
  onClose: () => void;
  onDone: (d: FinanceDetail) => void;
}) {
  const headingId = useId();
  const Heading = kind === 'CREATE' ? 'h2' : 'h3';
  const original = detail?.receivable,
    [remaining, setRemaining] = useState(original?.remainingMinor ?? 0),
    [version, setVersion] = useState(original?.version ?? policy?.version ?? 1),
    [amount, setAmount] = useState(
      kind === 'ADJUST' && original ? premiumInput(original.amountMinor) : '',
    ),
    [date, setDate] = useState(kind === 'ADJUST' ? (original?.dueDate ?? '') : ''),
    [adjustBase, setAdjustBase] = useState(() => ({
      amount: original ? premiumInput(original.amountMinor) : '',
      dueDate: original?.dueDate ?? '',
    })),
    [choices, setChoices] = useState<ConflictChoices>({}),
    [method, setMethod] = useState<keyof typeof financeMethodLabels>(
      kind === 'CREATE' ? 'DEFERRED' : 'BANK',
    ),
    [reason, setReason] = useState(''),
    [confirmed, setConfirmed] = useState(false),
    [error, setError] = useState(''),
    [comparing, setComparing] = useState(false),
    [fresh, setFresh] = useState<{
      version: number;
      amountMinor: number;
      remainingMinor: number;
      dueDate?: string;
    } | null>(null);
  const writer = useFinanceWrite(onDone),
    titleRef = useRef<HTMLHeadingElement>(null),
    errorRef = useRef<HTMLParagraphElement>(null),
    controller = useRef<AbortController | null>(null);
  useEffect(() => {
    titleRef.current?.focus();
    return () => controller.current?.abort();
  }, []);
  useEffect(() => {
    onRisk({ dirty: true, unresolved: writer.unresolved || comparing });
  }, [writer.unresolved, comparing, onRisk]);
  useEffect(() => {
    if (error || writer.error) errorRef.current?.focus();
  }, [error, writer.error]);
  const currency = original?.currency ?? policy?.currency ?? 'TRY',
    titles = {
      CREATE: 'Acente alacağı oluştur',
      COLLECT: 'Tahsilat kaydet',
      REVERSE: 'Hatalı tahsilatı ters kaydet',
      ADJUST: 'Alacak / vade düzelt',
      VOID: 'Alacak kaydını iptal et',
    };
  const compare = useCallback(async () => {
    if (writer.unresolved || comparing) return;
    setComparing(true);
    setFresh(null);
    setChoices({});
    setConfirmed(false);
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    try {
      if (original) {
        const d = await readCustomerResource(
          '/api/finance/receivables/' + encodeURIComponent(original.id),
          c.signal,
          financeDetailFor(original.id),
        );
        if (!d.canManage || d.receivable.version < version) throw Error('COMPARISON_FAILED');
        if (!c.signal.aborted) setFresh(d.receivable);
      } else if (policy) {
        const p = await readPolicyDetail(policy.id, c.signal);
        if (
          p.currency !== currency ||
          p.archivedAt ||
          p.status !== 'ACTIVE' ||
          p.version < policy.version
        )
          throw Error('COMPARISON_FAILED');
        if (!c.signal.aborted)
          setFresh({ version: p.version, amountMinor: p.grossPremiumMinor, remainingMinor: 0 });
      }
    } catch {
      if (!c.signal.aborted) setError('Güncel kayıt veya yetki doğrulanamadı. Taslağınız korundu.');
    } finally {
      if (!c.signal.aborted) setComparing(false);
    }
  }, [writer.unresolved, comparing, original, policy, currency, version]);
  const currentAdjustment =
    kind === 'ADJUST' && fresh?.dueDate !== undefined
      ? { amount: premiumInput(fresh.amountMinor), dueDate: fresh.dueDate }
      : null;
  const parsedAmount = parseMoneyInput(amount);
  const comparison =
    currentAdjustment &&
    compareEdits(
      adjustBase,
      { amount: parsedAmount?.canonical ?? amount, dueDate: date },
      currentAdjustment,
      choices,
    );
  const paymentAmount = parsedAmount?.minor ?? null;
  return (
    <section className="finance-editor">
      <Heading id={headingId} ref={titleRef} tabIndex={-1}>
        {titles[kind]}
      </Heading>
      <p>
        {original?.customerName ?? policy?.customer.displayName} ·{' '}
        {original?.policyNumber ?? policy?.policyNumber}
      </p>
      {kind === 'CREATE' && (
        <p>
          Yalnız acentenin müşteriden alacağını kaydedin. Poliçe primi otomatik borç veya tahsilat
          değildir.
        </p>
      )}
      {original && (
        <p>
          Görüntülenen kalan: <strong>{policyMoney(remaining, currency)}</strong>
        </p>
      )}
      {kind === 'REVERSE' && entry && (
        <p>
          {policyMoney(entry.amountMinor, currency)} tutarındaki kayıt korunacak; tamamı için ters
          kayıt eklenecek. Bu işlem gerçek para iadesi yapmaz.
        </p>
      )}
      <form
        aria-labelledby={headingId}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (writer.locked || comparing) return;
          setError('');
          if (!confirmed) {
            setError('Bilgileri kontrol edip onay kutusunu işaretleyin.');
            return;
          }
          let input: unknown;
          const enteredAmount = parsedAmount?.canonical;
          if (['CREATE', 'COLLECT', 'ADJUST'].includes(kind) && (paymentAmount ?? 0n) <= 0n) {
            setError(`Sıfırdan büyük bir tutar girin. ${MONEY_INPUT_HELP}`);
            return;
          }
          if (kind === 'CREATE' && policy)
            input = {
              kind,
              policyId: policy.id,
              expectedPolicyVersion: version,
              amount: enteredAmount,
              dueDate: date,
              method,
            };
          else if (original) {
            const base = { kind, receivableId: original.id, expectedVersion: version };
            input =
              kind === 'COLLECT'
                ? { ...base, amount: enteredAmount, receivedDate: date, method }
                : kind === 'REVERSE'
                  ? { ...base, entryId: entry?.id, reasonCode: reason }
                  : kind === 'ADJUST'
                    ? { ...base, amount: enteredAmount, dueDate: date, reasonCode: reason }
                    : { ...base, reasonCode: reason };
          }
          const parsed = financeCommandSchema.safeParse(input);
          if (!parsed.success) {
            setError('Geçerli tutar, tarih ve gerekli seçimleri girin. Tutar örneği: 1250.50.');
            return;
          }
          writer.submit(parsed.data);
        }}
      >
        <fieldset disabled={writer.locked || comparing}>
          <legend className="sr-only">{titles[kind]}</legend>
          <div className="finance-fields">
            {['CREATE', 'COLLECT', 'ADJUST'].includes(kind) && (
              <>
                <label>
                  Tutar ({currency}) *
                  <input
                    name="amount"
                    required
                    maxLength={24}
                    inputMode="decimal"
                    value={amount}
                    placeholder="1.250,50"
                    onChange={(e) => {
                      setAmount(e.target.value);
                      setConfirmed(false);
                      setError('');
                    }}
                  />
                </label>
                <label>
                  {kind === 'COLLECT' ? 'Tahsilat tarihi' : 'Ödeme vadesi'} *
                  <input
                    name="date"
                    type="date"
                    required
                    value={date}
                    max={kind === 'COLLECT' ? detail?.today : undefined}
                    onInput={(e) => {
                      setDate(e.currentTarget.value);
                      setConfirmed(false);
                    }}
                    onChange={(e) => {
                      setDate(e.target.value);
                      setConfirmed(false);
                    }}
                  />
                </label>
              </>
            )}
            {kind === 'COLLECT' && detail && (
              <div className="customer-form-actions">
                <Button
                  variant="outline"
                  disabled={remaining <= 0}
                  onClick={() => {
                    setAmount(premiumInput(remaining).replace('.', ','));
                    setConfirmed(false);
                    setError('');
                  }}
                >
                  Kalan tutarı kullan
                </Button>
                <Button
                  variant="outline"
                  onClick={() => {
                    setDate(detail.today);
                    setConfirmed(false);
                    setError('');
                  }}
                >
                  Bugün
                </Button>
              </div>
            )}
            {['CREATE', 'COLLECT'].includes(kind) && (
              <label>
                {kind === 'CREATE' ? 'Beklenen ödeme yöntemi' : 'Acentenin aldığı ödeme'} *
                <select
                  name="method"
                  value={method}
                  onChange={(e) => {
                    setMethod(e.target.value as keyof typeof financeMethodLabels);
                    setConfirmed(false);
                  }}
                >
                  {Object.entries(financeMethodLabels)
                    .filter(([code]) => kind === 'CREATE' || code !== 'DEFERRED')
                    .map(([code, label]) => (
                      <option value={code} key={code}>
                        {label}
                      </option>
                    ))}
                </select>
              </label>
            )}
            {['REVERSE', 'ADJUST', 'VOID'].includes(kind) && (
              <label>
                Düzeltme nedeni *
                <select
                  name="reason"
                  required
                  value={reason}
                  onChange={(e) => {
                    setReason(e.target.value);
                    setConfirmed(false);
                  }}
                >
                  <option value="">Neden seçin</option>
                  {Object.entries(financeReasons).map(([code, label]) => (
                    <option key={code} value={code}>
                      {label}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </div>
          {kind === 'COLLECT' && paymentAmount !== null && paymentAmount > 0n && date && (
            <p>
              {policyMoney(Number(paymentAmount), currency)} · {storedPolicyDate(date)} ·{' '}
              {financeMethodLabels[method]}
            </p>
          )}
          <label className="finance-confirm">
            <input
              name="confirmed"
              type="checkbox"
              checked={confirmed}
              onChange={(e) => setConfirmed(e.target.checked)}
            />
            {kind === 'COLLECT'
              ? 'Bu tutarı acentenin aldığını onaylıyorum'
              : kind === 'CREATE'
                ? 'Acentenin bu müşteriden alacağı olduğunu onaylıyorum'
                : 'Düzeltmeyi ve nedenini onaylıyorum'}
          </label>
        </fieldset>
        <div className="customer-form-actions">
          <Button
            type="submit"
            disabled={writer.locked || comparing}
            variant={kind === 'VOID' ? 'danger' : 'default'}
          >
            {kind === 'CREATE'
              ? 'Alacağı kaydet'
              : kind === 'COLLECT'
                ? 'Tahsilatı kaydet'
                : kind === 'REVERSE'
                  ? 'Ters kaydı oluştur'
                  : kind === 'VOID'
                    ? 'Alacağı iptal et'
                    : 'Düzeltmeyi kaydet'}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={writer.unresolved || comparing}
            onClick={onClose}
          >
            Vazgeç
          </Button>
        </div>
      </form>
      {writer.busy && <p role="status">Kayıt ve güncel bakiye kontrol ediliyor…</p>}
      {(error || writer.error) && (
        <p ref={errorRef} tabIndex={-1} role="alert">
          {error || writer.error}
        </p>
      )}
      <div className="customer-form-actions">
        {writer.pending && (
          <Button disabled={writer.busy} onClick={writer.retry}>
            Aynı kaydı güvenle yeniden dene
          </Button>
        )}
        {writer.accepted && (
          <Button disabled={writer.busy} onClick={writer.retryRead}>
            Yalnız kaydı ve bakiyeyi kontrol et
          </Button>
        )}
        {writer.needsRefresh && (
          <Button disabled={comparing} variant="outline" onClick={() => void compare()}>
            Güncel bilgileri karşılaştır
          </Button>
        )}
        {fresh && (
          <div>
            <p role="status">
              Güncel tutar {policyMoney(fresh.amountMinor, currency)} · Kalan{' '}
              {policyMoney(fresh.remainingMinor, currency)}
              {fresh.dueDate && ` · Vade ${storedPolicyDate(fresh.dueDate)}`}.
            </p>
            {comparison && (
              <FieldConflictChoices
                conflicts={comparison.conflicts}
                choices={choices}
                labels={financeLabels}
                format={(name, value) => {
                  if (name === 'dueDate') return storedPolicyDate(value);
                  const parsed = parseMoneyInput(value);
                  return parsed ? policyMoney(Number(parsed.minor), currency) : value;
                }}
                onChange={(name, choice) => setChoices((prev) => ({ ...prev, [name]: choice }))}
              />
            )}
            <Button
              disabled={kind === 'ADJUST' && !comparison?.resolved}
              onClick={() => {
                if (kind === 'ADJUST' && !comparison?.resolved) return;
                if (currentAdjustment && comparison?.resolved) {
                  setAdjustBase(currentAdjustment);
                  setAmount(comparison.merged.amount);
                  setDate(comparison.merged.dueDate);
                }
                setVersion(fresh.version);
                setRemaining(fresh.remainingMinor);
                setFresh(null);
                setConfirmed(false);
                writer.acceptFresh();
              }}
            >
              Güncel bilgilerle devam et
            </Button>
          </div>
        )}
      </div>
    </section>
  );
}
