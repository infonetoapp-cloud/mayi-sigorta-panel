import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router';
import {
  issuePolicyContextSchema,
  issuePolicyResultSchema,
  issuePolicySchema,
  type IssuePolicyCommand,
  type IssuePolicyContext,
  type IssuePolicyResult,
} from '../../../shared/sales-issued-policy';
import type { ApiResponse } from '../../../shared/types';
import { Button } from '../../components/ui/button';
import { getCsrfToken, invalidateCsrfToken } from '../../csrf';
import { CustomerReadError, readCustomerResource } from '../customers/customer-resource';
import { WonCreatePolicyForm, type CreateReview } from '../today-work/WonCreatePolicyForm';
import { SalesLinkPolicyForm, type LinkReview } from './SalesLinkPolicyForm';

type Risk = { dirty: boolean; unresolved: boolean };
type Attempt = { command: IssuePolicyCommand; body: string; key: string; accepted: boolean };
type Mode = IssuePolicyCommand['result']['kind'];
const rejectionText: Record<string, string> = {
  PRICE_ACCEPTANCE_INVALID:
    'Fiyat değişmiş veya müşteri kabulü geri alınmış olabilir. Güncel fiyatı yeniden seçin.',
  PRICE_POLICY_MISMATCH: 'Kabul edilen fiyatın şirketi ile poliçenin şirketi eşleşmiyor.',
  POLICY_DIFFERENCE_REASON_REQUIRED: 'Teklif ile poliçe arasındaki farkın nedenini seçin.',
  POLICY_TARGET_INVALID: 'Seçtiğiniz poliçe artık bu çalışma için uygun değil.',
  CONFLICT: 'Takip, fiyat veya poliçe değişti. Güncel bilgileri yükleyip taslağınızı kontrol edin.',
};
const endSession = () => {
  invalidateCsrfToken();
  document.dispatchEvent(new Event('mayi-session-ended'));
};

export function SalesIssueSection({
  caseId,
  expectedTaskId,
  canOperate,
  onRisk,
  onChanged,
}: {
  caseId: string;
  expectedTaskId: string;
  canOperate: () => boolean;
  onRisk: (risk: Risk) => void;
  onChanged: (result: IssuePolicyResult) => void;
}) {
  const root = `/api/sales-cases/${encodeURIComponent(caseId)}`;
  const [context, setContext] = useState<IssuePolicyContext | null>(null);
  const [mode, setMode] = useState<Mode | null>(null);
  const [pending, setPending] = useState<Attempt | null>(null);
  const [completed, setCompleted] = useState<IssuePolicyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [formBusy, setFormBusy] = useState(false);
  const [refreshRequired, setRefreshRequired] = useState(false);
  const [masked, setMasked] = useState(false);
  const [revision, setRevision] = useState(0);
  const [error, setError] = useState('');
  const active = useRef(false),
    working = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null),
    alert = useRef<HTMLParagraphElement>(null);
  const unresolved = busy || formBusy || !!pending;

  useEffect(() => {
    active.current = true;
    return () => {
      active.current = false;
    };
  }, []);
  useEffect(() => onRisk({ dirty: !!context, unresolved }), [context, unresolved, onRisk]);
  useEffect(() => {
    if (context && !mode) heading.current?.focus();
  }, [context, mode]);
  useEffect(() => {
    if (error) alert.current?.focus();
  }, [error]);

  async function load() {
    if (working.current || pending || !canOperate()) return;
    working.current = true;
    setBusy(true);
    setError('');
    try {
      const fresh = issuePolicyContextSchema.parse(
        await readCustomerResource(root + '/issue-context'),
      );
      if (!active.current) return;
      if (
        fresh.caseId !== caseId ||
        fresh.taskId !== expectedTaskId ||
        (context &&
          (fresh.customerId !== context.customerId || fresh.branchId !== context.branchId))
      ) {
        setMasked(true);
        throw Error('Takip değişti. Açık taslağı kapatıp güncel işi açın.');
      }
      setContext(fresh);
      setMasked(mode === 'CREATE_POLICY' && !fresh.canCreate);
      setRefreshRequired(false);
      if (context) setRevision((value) => value + 1);
    } catch (cause) {
      if (!active.current) return;
      if (cause instanceof CustomerReadError && [401, 403, 404].includes(cause.status))
        setMasked(true);
      setError(cause instanceof Error ? cause.message : 'Poliçelendirme bilgileri okunamadı.');
    } finally {
      working.current = false;
      if (active.current) setBusy(false);
    }
  }

  async function send(attempt: Attempt) {
    if (working.current || masked || !canOperate()) return;
    working.current = true;
    setBusy(true);
    setError('');
    let accepted = attempt.accepted;
    try {
      if (!accepted) {
        const csrf = await getCsrfToken();
        const reply = await fetch(root + '/issue-policy', {
          method: 'POST',
          body: attempt.body,
          headers: {
            'content-type': 'application/json',
            'x-csrf-token': csrf,
            'idempotency-key': attempt.key,
          },
        });
        if (!active.current) return;
        if (!reply.ok) {
          if ([408, 429].includes(reply.status) || reply.status >= 500) throw Error('UNCERTAIN');
          const envelope = (await reply.json().catch(() => null)) as ApiResponse<unknown> | null;
          if (!active.current) return;
          const code = envelope && !envelope.success ? envelope.error.code : '';
          if (code === 'IDEMPOTENCY_CONFLICT') throw Error('UNCERTAIN');
          setPending(null);
          if (reply.status === 401) endSession();
          if (reply.status === 403) invalidateCsrfToken();
          if ([401, 403, 404].includes(reply.status)) setMasked(true);
          setRefreshRequired(true);
          setError(
            rejectionText[code] ??
              'Poliçelendirme tamamlanamadı. Güncel takip ve poliçe bilgilerini kontrol edin.',
          );
          return;
        }
        accepted = true;
        setPending({ ...attempt, accepted: true });
      }
      const verified = await fetch(root + '/issue-operation', {
        cache: 'no-store',
        headers: { 'idempotency-key': attempt.key },
      });
      if (!active.current) return;
      if (verified.status === 401) endSession();
      if (!verified.ok) throw Error('UNVERIFIED');
      const response = (await verified.json()) as ApiResponse<unknown>;
      const result = issuePolicyResultSchema.parse(response.success ? response.data : null);
      const command = attempt.command;
      if (
        result.caseId !== caseId ||
        result.caseVersion !== command.expectedCaseVersion + 1 ||
        result.taskId !== command.expectedTaskId ||
        result.taskVersion !== command.expectedTaskVersion + 1 ||
        (command.result.kind === 'LINK_POLICY'
          ? result.createdPolicy ||
            result.policyId !== command.result.policyId ||
            result.policyVersion !== command.result.expectedPolicyVersion
          : !result.createdPolicy || result.policyVersion !== 1)
      )
        throw Error('UNVERIFIED');
      if (!active.current) return;
      setPending(null);
      setContext(null);
      setMode(null);
      setCompleted(result);
      onChanged(result);
    } catch {
      if (active.current)
        setError(
          accepted
            ? 'Kayıt alındı. Sonuç henüz doğrulanamadı. Kayıtlı sonucu tekrar kontrol edin.'
            : 'Kayıt sonucu belirsiz. Aynı işlem bilgileriyle tekrar kontrol edebilirsiniz.',
        );
    } finally {
      working.current = false;
      if (active.current) setBusy(false);
    }
  }

  function submit(review: CreateReview | LinkReview, result: IssuePolicyCommand['result']) {
    if (!context || pending || working.current || refreshRequired || masked || !canOperate())
      return;
    const price = review.price?.source;
    if (
      price &&
      (price.caseId !== context.caseId || price.expectedCaseVersion !== context.caseVersion)
    ) {
      setRefreshRequired(true);
      setError('Fiyat kaydı güncellendi. Güncel bilgileri yükleyip seçimi yeniden kontrol edin.');
      return;
    }
    const command = issuePolicySchema.safeParse({
      expectedCaseVersion: context.caseVersion,
      expectedTaskId: context.taskId,
      expectedTaskVersion: context.taskVersion,
      source: price
        ? {
            kind: price.kind,
            revisionId: price.revisionId,
            acceptanceEventId: price.acceptanceEventId,
          }
        : { kind: 'NO_QUOTE', reason: review.noQuoteReason },
      result,
      ...(review.differenceReasonCode ? { differenceReasonCode: review.differenceReasonCode } : {}),
    });
    if (!command.success) {
      setError('Poliçe ve teklif seçimini kontrol edin.');
      return;
    }
    const attempt = {
      command: command.data,
      body: JSON.stringify(command.data),
      key: crypto.randomUUID(),
      accepted: false,
    };
    setPending(attempt);
    void send(attempt);
  }

  if (completed)
    return (
      <p role="status">
        {completed.createdPolicy
          ? 'Yeni poliçe kaydedildi ve takip kapatıldı.'
          : 'Mevcut poliçe bağlandı ve takip kapatıldı.'}{' '}
        <Link to={`/policies/${encodeURIComponent(completed.policyId)}`}>Poliçeyi aç</Link>
      </p>
    );

  return (
    <section className="today-outcome-form" aria-label="Yeni iş poliçelendirme">
      {!context && (
        <Button type="button" disabled={unresolved || !canOperate()} onClick={() => void load()}>
          Poliçelendir
        </Button>
      )}
      {context && (
        <>
          <h3 ref={heading} tabIndex={-1}>
            Poliçelendir
          </h3>
          {!masked && !mode && (
            <div className="customer-form-actions">
              {context.canCreate && (
                <Button disabled={unresolved} onClick={() => setMode('CREATE_POLICY')}>
                  Yeni poliçe kaydet
                </Button>
              )}
              <Button
                variant="outline"
                disabled={unresolved}
                onClick={() => setMode('LINK_POLICY')}
              >
                Mevcut poliçeyi bağla
              </Button>
            </div>
          )}
          {mode === 'CREATE_POLICY' && (
            <WonCreatePolicyForm
              task={{
                customerId: context.customerId,
                customerDisplayName: context.customerName,
                assigneeMembershipId: null,
              }}
              newBusiness={{ caseId, branchId: context.branchId }}
              disabled={busy || !!pending || refreshRequired}
              masked={masked}
              onBusy={setFormBusy}
              rejectedPrice={revision}
              onSubmit={(review) =>
                submit(review, { kind: 'CREATE_POLICY', policy: { ...review.policy } })
              }
            />
          )}
          {!masked && mode === 'LINK_POLICY' && (
            <SalesLinkPolicyForm
              context={context}
              disabled={busy || !!pending || refreshRequired}
              revision={revision}
              onSubmit={(review) =>
                submit(review, {
                  kind: 'LINK_POLICY',
                  policyId: review.policyId,
                  expectedPolicyVersion: review.policyVersion,
                })
              }
            />
          )}
          {masked && <p>Bu takip için işlem yetkisi doğrulanamadı.</p>}
          {!pending && refreshRequired && (
            <Button variant="outline" disabled={busy} onClick={() => void load()}>
              Güncel bilgileri yükle
            </Button>
          )}
          {!pending && (
            <Button
              variant="outline"
              disabled={unresolved}
              onClick={() => {
                setContext(null);
                setMode(null);
                setError('');
                setMasked(false);
                setRefreshRequired(false);
                setRevision(0);
              }}
            >
              Poliçelendirmeden vazgeç
            </Button>
          )}
        </>
      )}
      {pending && (
        <Button variant="outline" disabled={busy || masked} onClick={() => void send(pending)}>
          {pending.accepted ? 'Kayıtlı sonucu doğrula' : 'Aynı işlemi tekrar kontrol et'}
        </Button>
      )}
      {busy && <p role="status">Poliçelendirme bilgileri kontrol ediliyor…</p>}
      {error && (
        <p className="customer-error" ref={alert} tabIndex={-1} role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
