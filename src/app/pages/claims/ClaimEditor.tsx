import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { PolicyDetailDto } from '../../../shared/types';
import {
  claimCommandSchema,
  claimStatuses,
  type ClaimDetail,
  type ClaimFields,
  type ClaimRecord,
} from '../../../shared/claims';
import { Button } from '../../components/ui/button';
import {
  compareEdits,
  FieldConflictChoices,
  type ConflictChoices,
} from '../../components/ui/field-conflicts';
import { readCustomerResource } from '../customers/customer-resource';
import type { TaskOperationRisk } from '../today-work/TaskOperationsSection';
import { policyDate } from '../policies/policy-display';
import { useClaimWrite } from './use-claim-write';
import { claimDetailFor } from './claim-read-schemas';
import { readPolicyDetail } from '../policies/policy-read-schemas';

function editableClaim(claim?: ClaimRecord) {
  return {
    lossDate: claim?.lossDate ?? '',
    fileNumber: claim?.fileNumber ?? '',
    expertName: claim?.expertName ?? '',
    expertContact: claim?.expertContact ?? '',
    status: claim?.status ?? ('WAITING' as const),
  };
}
const claimLabels = {
  lossDate: 'Hasar tarihi',
  fileNumber: 'Dosya numarası',
  expertName: 'Eksper adı',
  expertContact: 'Eksper iletişimi',
  status: 'Durum',
};
export function ClaimEditor({
  policy,
  detail,
  onRisk,
  onClose,
  onDone,
}: {
  policy?: PolicyDetailDto;
  detail?: ClaimDetail;
  onRisk: (r: TaskOperationRisk) => void;
  onClose: () => void;
  onDone: (d: ClaimDetail) => void;
}) {
  const original = detail?.claim,
    id = useId(),
    titleRef = useRef<HTMLHeadingElement>(null),
    errorRef = useRef<HTMLParagraphElement>(null),
    controller = useRef<AbortController | null>(null);
  const [version, setVersion] = useState(original?.version ?? policy?.version ?? 1),
    [lossDate, setLossDate] = useState(original?.lossDate ?? ''),
    [fileNumber, setFileNumber] = useState(original?.fileNumber ?? ''),
    [expertName, setExpertName] = useState(original?.expertName ?? ''),
    [expertContact, setExpertContact] = useState(original?.expertContact ?? ''),
    [status, setStatus] = useState<ClaimFields['status']>(original?.status ?? 'WAITING'),
    [note, setNote] = useState(''),
    [error, setError] = useState(''),
    [comparing, setComparing] = useState(false),
    [fresh, setFresh] = useState<ClaimDetail | PolicyDetailDto | null>(null),
    [claimBase, setClaimBase] = useState(() => editableClaim(original)),
    [choices, setChoices] = useState<ConflictChoices>({}),
    [period, setPeriod] = useState({
      from: detail?.policyStartDate ?? policy?.startDate ?? '',
      to: detail?.policyEndDate ?? policy?.endDate ?? '',
    });
  const writer = useClaimWrite(onDone, original),
    title = original ? 'Hasar kaydını güncelle' : 'Yeni hasar kaydı',
    today =
      detail?.today ??
      new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Istanbul',
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
      }).format(new Date());
  useEffect(() => {
    titleRef.current?.focus();
    return () => controller.current?.abort();
  }, []);
  useEffect(() => {
    onRisk({ dirty: true, unresolved: writer.unresolved || comparing });
  }, [onRisk, writer.unresolved, comparing]);
  useEffect(() => {
    if (error || writer.error) errorRef.current?.focus();
  }, [error, writer.error]);
  const compare = useCallback(async () => {
    if (writer.unresolved || comparing) return;
    setComparing(true);
    setFresh(null);
    setChoices({});
    setError('');
    controller.current?.abort();
    const c = new AbortController();
    controller.current = c;
    try {
      if (original) {
        const d = await readCustomerResource(
          '/api/claims/' + encodeURIComponent(original.id),
          c.signal,
          claimDetailFor(original.id, original),
        );
        if (!c.signal.aborted && d.claim.version >= version && d.canManage) setFresh(d);
        else if (!c.signal.aborted)
          setError('Bu kayıt şu anda düzenlenemiyor. Taslağınız korundu.');
      } else if (policy) {
        const p = await readPolicyDetail(policy.id, c.signal);
        if (
          !c.signal.aborted &&
          p.version >= policy.version &&
          p.customerId === policy.customerId &&
          !p.archivedAt &&
          p.status !== 'VOIDED'
        )
          setFresh(p);
        else if (!c.signal.aborted) setError('Poliçe şu anda kullanılamıyor. Taslağınız korundu.');
      }
    } catch {
      if (!c.signal.aborted) setError('Güncel bilgi ve yetki doğrulanamadı. Taslağınız korundu.');
    } finally {
      if (!c.signal.aborted) setComparing(false);
    }
  }, [writer.unresolved, comparing, original, policy, version]);
  const currentClaim = fresh && 'claim' in fresh ? editableClaim(fresh.claim) : null;
  const comparison =
    currentClaim &&
    compareEdits(
      claimBase,
      { lossDate, fileNumber, expertName, expertContact, status },
      currentClaim,
      choices,
    );
  return (
    <section className="finance-editor claim-editor">
      <h2 ref={titleRef} tabIndex={-1}>
        {title}
      </h2>
      <p>
        <strong>{original?.customerName ?? policy?.customer.displayName}</strong> ·{' '}
        {original?.policyNumber ?? policy?.policyNumber}
        <br />
        {original?.insurerName ?? policy?.insurer.name} ·{' '}
        {original?.branchName ?? policy?.branch.name}
      </p>
      <p>
        Poliçe dönemi: {policyDate(period.from)} – {policyDate(period.to)}
      </p>
      <form
        aria-label={title}
        noValidate
        onSubmit={(e) => {
          e.preventDefault();
          if (writer.locked || comparing) return;
          setError('');
          const fields = {
            lossDate,
            fileNumber: fileNumber || null,
            expertName: expertName || null,
            expertContact: expertContact || null,
            status,
            note: note || null,
          };
          const cmd = claimCommandSchema.safeParse(
            original
              ? { kind: 'UPDATE', claimId: original.id, expectedVersion: version, fields }
              : {
                  kind: 'CREATE',
                  policyId: policy?.id,
                  customerId: policy?.customerId,
                  expectedPolicyVersion: version,
                  fields,
                },
          );
          if (
            !cmd.success ||
            lossDate > today ||
            ((!original || lossDate !== claimBase.lossDate) &&
              (lossDate < period.from || lossDate > period.to))
          ) {
            setError(
              original
                ? 'Geçerli hasar tarihi ve güncelleme notu girin. Tarih poliçe döneminde olmalı; gelecekte olamaz.'
                : 'Hasar tarihini kontrol edin. Tarih poliçe döneminde olmalı; gelecekte olamaz.',
            );
            return;
          }
          writer.submit(cmd.data);
        }}
      >
        <fieldset disabled={writer.locked || comparing}>
          <legend className="sr-only">{title}</legend>
          <div className="finance-fields">
            <div className="claim-field">
              <label htmlFor={id + 'date'}>Hasar tarihi *</label>
              <input
                id={id + 'date'}
                name="lossDate"
                type="date"
                required
                value={lossDate}
                max={today < period.to ? today : period.to}
                onInput={(e) => {
                  setLossDate(e.currentTarget.value);
                  setError('');
                }}
                onChange={(e) => {
                  setLossDate(e.target.value);
                  setError('');
                }}
              />
            </div>
            <div className="claim-field">
              <label htmlFor={id + 'number'}>Şirket dosya no (isteğe bağlı)</label>
              <input
                id={id + 'number'}
                name="fileNumber"
                type="text"
                maxLength={80}
                value={fileNumber}
                autoCorrect="off"
                autoCapitalize="none"
                spellCheck={false}
                onChange={(e) => {
                  setFileNumber(e.target.value);
                  setError('');
                }}
              />
              <small>Numara henüz verilmediyse boş bırakın.</small>
            </div>
            <div className="claim-field">
              <label htmlFor={id + 'expert'}>Eksper adı (isteğe bağlı)</label>
              <input
                id={id + 'expert'}
                name="expertName"
                maxLength={120}
                value={expertName}
                onChange={(e) => setExpertName(e.target.value)}
              />
            </div>
            <div className="claim-field">
              <label htmlFor={id + 'contact'}>Eksper iletişimi (isteğe bağlı)</label>
              <input
                id={id + 'contact'}
                name="expertContact"
                maxLength={160}
                value={expertContact}
                onChange={(e) => setExpertContact(e.target.value)}
              />
            </div>
          </div>
          <fieldset className="claim-status-options">
            <legend>Dosya durumu</legend>
            {Object.entries(claimStatuses).map(([code, label]) => (
              <label key={code} htmlFor={id + code}>
                <input
                  type="radio"
                  id={id + code}
                  name="status"
                  value={code}
                  checked={status === code}
                  onChange={() => setStatus(code as ClaimFields['status'])}
                />
                {label}
              </label>
            ))}
          </fieldset>
          <div className="claim-field">
            <label htmlFor={id + 'note'}>
              {original ? 'Güncelleme / durum notu *' : 'Kısa durum notu (isteğe bağlı)'}
            </label>
            <textarea
              id={id + 'note'}
              name="note"
              rows={3}
              maxLength={1000}
              required={!!original}
              value={note}
              onChange={(e) => {
                setNote(e.target.value);
                setError('');
              }}
              aria-describedby={id + 'hint'}
            />
            <small id={id + 'hint'}>
              Örn. Eksper raporu bekleniyor. Kimlik numarası veya klinik sağlık bilgisi yazmayın.
            </small>
          </div>
          <Button type="submit">
            {original ? 'Güncellemeyi kaydet' : 'Hasar kaydını oluştur'}
          </Button>
        </fieldset>
      </form>
      {(error || writer.error) && (
        <p ref={errorRef} tabIndex={-1} role="alert">
          {error || writer.error}
        </p>
      )}
      {writer.busy && <p role="status">Kayıt ve geçmiş kontrol ediliyor…</p>}
      <div className="customer-form-actions">
        {writer.pending && (
          <Button disabled={writer.busy} onClick={writer.retry}>
            Aynı kaydı güvenle yeniden dene
          </Button>
        )}
        {writer.accepted && (
          <Button disabled={writer.busy} onClick={writer.retryRead}>
            Yalnız kaydı ve geçmişi kontrol et
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
              {'claim' in fresh
                ? `Güncel durum: ${claimStatuses[fresh.claim.status]}. Son not: ${fresh.claim.note ?? 'Yok'}`
                : `Güncel poliçe: ${fresh.policyNumber}`}
              . Girdiğiniz bilgiler korunuyor.
            </p>
            {comparison && (
              <FieldConflictChoices
                conflicts={comparison.conflicts}
                choices={choices}
                labels={claimLabels}
                format={(name, value) =>
                  name === 'status' ? claimStatuses[value as ClaimFields['status']] : value || 'Boş'
                }
                onChange={(name, choice) => setChoices((prev) => ({ ...prev, [name]: choice }))}
              />
            )}
            <Button
              disabled={comparison !== null && !comparison.resolved}
              onClick={() => {
                if ('claim' in fresh) {
                  if (!currentClaim || !comparison?.resolved) return;
                  setClaimBase(currentClaim);
                  setLossDate(comparison.merged.lossDate);
                  setFileNumber(comparison.merged.fileNumber);
                  setExpertName(comparison.merged.expertName);
                  setExpertContact(comparison.merged.expertContact);
                  setStatus(comparison.merged.status);
                  setVersion(fresh.claim.version);
                  setPeriod({ from: fresh.policyStartDate, to: fresh.policyEndDate });
                } else {
                  setVersion(fresh.version);
                  setPeriod({ from: fresh.startDate, to: fresh.endDate });
                }
                setFresh(null);
                writer.acceptFresh();
              }}
            >
              Güncel bilgilerle devam et
            </Button>
          </div>
        )}
        <Button variant="outline" disabled={writer.unresolved || comparing} onClick={onClose}>
          Vazgeç
        </Button>
      </div>
    </section>
  );
}
