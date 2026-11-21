import { useEffect, useId, useRef, useState } from 'react';
import {
  salesWonCorrectionContextSchema,
  salesWonCorrectionGrantSchema,
  salesWonCorrectionResultSchema,
  salesWonCorrectionSchema,
  type SalesWonCorrection,
} from '../../../shared/sales-won-correction';
import type { ApiResponse } from '../../../shared/types';
import { ReauthForm } from '../../AuthShell';
import { Button } from '../../components/ui/button';
import { getCsrfToken, invalidateCsrfToken } from '../../csrf';
import { useCustomerResource } from '../customers/customer-resource';
import { canonicalOccurrence } from '../today-work/interaction-model';

type Grant = ReturnType<typeof salesWonCorrectionGrantSchema.parse>;
type Attempt = {
  command: SalesWonCorrection;
  key: string;
  grantKey?: string;
  grant?: Grant;
  accepted?: boolean;
};

async function postSecure(path: string, key: string, body: unknown) {
  const token = await getCsrfToken();
  return fetch(path, {
    method: 'POST',
    cache: 'no-store',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json', 'x-csrf-token': token, 'idempotency-key': key },
  });
}

export function SalesWonCorrectionSection({
  caseId,
  canOperate,
  onRisk,
  onChanged,
}: {
  caseId: string;
  canOperate: () => boolean;
  onRisk: (risk: { dirty: boolean; unresolved: boolean }) => void;
  onChanged: (taskId: string) => void;
}) {
  const id = useId();
  const path = `/api/sales-cases/${encodeURIComponent(caseId)}`;
  const source = useCustomerResource<unknown>(path + '/won-correction-context');
  const parsed = salesWonCorrectionContextSchema.safeParse(source.data);
  const context = parsed.success ? parsed.data : null;
  const [open, setOpen] = useState(false);
  const [due, setDue] = useState('');
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [reauth, setReauth] = useState<Attempt | null>(null);
  const [pending, setPending] = useState<Attempt | null>(null);
  const [refresh, setRefresh] = useState(false);
  const [error, setError] = useState('');
  const live = useRef(false);
  const working = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const alert = useRef<HTMLParagraphElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const locked = busy || !!pending;
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  useEffect(() => onRisk({ dirty: open, unresolved: locked }), [open, locked, onRisk]);
  useEffect(() => {
    if (open && !reauth) heading.current?.focus();
  }, [open, reauth]);
  useEffect(() => {
    if (error) alert.current?.focus();
  }, [error]);

  async function verify(attempt: Attempt) {
    const response = await fetch(path + '/won-correction-operation', {
      cache: 'no-store',
      headers: { 'idempotency-key': attempt.key },
    });
    if (response.status === 404) return false;
    if (!response.ok) throw Error('PROOF_UNAVAILABLE');
    const body = (await response.json()) as ApiResponse<unknown>;
    const outcome = salesWonCorrectionResultSchema.parse(body.success ? body.data : null);
    if (
      outcome.caseId !== caseId ||
      outcome.caseVersion !== attempt.command.expectedCaseVersion + 1 ||
      outcome.taskId === attempt.command.expectedTaskId ||
      outcome.dueAt !== attempt.command.replacementDueAt
    )
      throw Error('PROOF_MISMATCH');
    if (live.current) {
      setPending(null);
      setOpen(false);
      onChanged(outcome.taskId);
    }
    return true;
  }

  async function run(attempt: Attempt, checking = false) {
    if (working.current || !canOperate()) return;
    working.current = true;
    setBusy(true);
    setError('');
    let sent = checking;
    try {
      if (checking && (await verify(attempt))) return;
      if (!live.current) return;
      if (attempt.accepted) throw Error('PROOF_UNAVAILABLE');
      const renewGrant = () => {
        setReauth({ ...attempt, grant: undefined, grantKey: crypto.randomUUID() });
      };
      let grant = attempt.grant;
      if (grant && grant.expiresAt <= new Date().toISOString()) {
        renewGrant();
        return;
      }
      if (!grant) {
        const response = await postSecure(
          '/secure' + path + '/won-correction-grants',
          attempt.grantKey ?? attempt.key,
          attempt.command,
        );
        if (!live.current) return;
        if (response.status === 401) {
          invalidateCsrfToken();
          setReauth(attempt);
          return;
        }
        if (response.status === 409) {
          if (checking) throw Error('PROOF_UNAVAILABLE');
          setRefresh(true);
          setError('Poliçe veya çalışma değişti. Güncel bilgileri kontrol edin.');
          return;
        }
        if (!response.ok) throw Error('GRANT_UNAVAILABLE');
        const body = (await response.json()) as ApiResponse<unknown>;
        grant = salesWonCorrectionGrantSchema.parse(body.success ? body.data : null);
      }
      if (!live.current) return;
      if (grant.expiresAt <= new Date().toISOString()) {
        renewGrant();
        return;
      }
      const { expiresAt: _expiresAt, ...evidence } = grant;
      const exact = { ...attempt, grant };
      setPending(exact);
      sent = true;
      const response = await postSecure('/secure' + path + '/correct-won', exact.key, {
        command: exact.command,
        ...evidence,
      });
      if (!live.current) return;
      if (response.status === 401) {
        invalidateCsrfToken();
        if (!checking) setPending(null);
        setReauth(exact);
        return;
      }
      if (!response.ok) {
        if (response.status >= 500 || [408, 429].includes(response.status))
          throw Error('WRITE_UNCERTAIN');
        const body = (await response.json().catch(() => null)) as ApiResponse<unknown> | null;
        if (!live.current) return;
        if (checking || (body && !body.success && body.error.code === 'IDEMPOTENCY_CONFLICT'))
          throw Error('WRITE_UNCERTAIN');
        setPending(null);
        setRefresh(true);
        setError('Düzeltme kaydedilemedi. Güncel bilgileri kontrol edin.');
        return;
      }
      setPending({ command: exact.command, key: exact.key, accepted: true });
      if (!(await verify(exact))) throw Error('PROOF_UNAVAILABLE');
    } catch {
      if (live.current)
        setError(
          sent
            ? 'İşlem sonucu henüz doğrulanamadı. Aynı işlemin sonucunu kontrol edebilirsiniz.'
            : 'Doğrulama başlatılamadı. Taslağınızı koruyarak yeniden deneyebilirsiniz.',
        );
    } finally {
      working.current = false;
      if (live.current) setBusy(false);
    }
  }

  return (
    <section aria-label="Poliçelendirmeyi düzelt">
      {!open && context && (
        <Button
          ref={trigger}
          type="button"
          variant="outline"
          disabled={!canOperate()}
          onClick={() => setOpen(true)}
        >
          Poliçelendirmeyi düzelt
        </Button>
      )}
      {!open && source.error && source.error.status >= 500 && (
        <div className="customer-form-actions">
          <p role="alert">Düzeltme bilgileri yüklenemedi.</p>
          <Button type="button" variant="outline" onClick={source.reload}>
            Düzeltme bilgilerini yeniden yükle
          </Button>
        </div>
      )}
      {open && !reauth && (
        <form
          className="issue-policy-form"
          method="post"
          action={`/secure${path}/correct-won`}
          aria-labelledby={id + '-heading'}
          onSubmit={(event) => {
            event.preventDefault();
            if (!context || refresh || locked || working.current || !canOperate()) return;
            const replacementDueAt = canonicalOccurrence(due);
            if (!replacementDueAt || replacementDueAt <= new Date().toISOString()) {
              setError('Yeni takip için ileri bir tarih ve saat seçin.');
              return;
            }
            const { policyNumber: _policy, ...expected } = context;
            const checked = salesWonCorrectionSchema.safeParse({
              ...expected,
              replacementDueAt,
              notes,
            });
            if (!checked.success) {
              setError('En az 3 karakterlik bir gerekçe yazın.');
              return;
            }
            setError('');
            setReauth({ command: checked.data, key: crypto.randomUUID() });
          }}
        >
          <h3 ref={heading} tabIndex={-1} id={id + '-heading'}>
            Poliçelendirmeyi düzelt
          </h3>
          {context && (
            <p className="issue-help">
              Poliçe no <strong>{context.policyNumber}</strong>
            </p>
          )}
          <p className="issue-help">
            Çalışma yeniden açılır ve yeni bir takip oluşturulur. Poliçe kaydı ve önceki işlemler
            korunur.
          </p>
          <fieldset disabled={locked || refresh || !context}>
            <legend className="sr-only">Düzeltme bilgileri</legend>
            <label htmlFor={id + '-due'}>Yeni takip zamanı (İstanbul) *</label>
            <input
              id={id + '-due'}
              name="replacementDueAt"
              type="datetime-local"
              required
              value={due}
              onInput={(e) => {
                setDue(e.currentTarget.value);
                setError('');
              }}
            />
            <label htmlFor={id + '-notes'}>Düzeltme gerekçesi * (3–500 karakter)</label>
            <textarea
              id={id + '-notes'}
              name="notes"
              required
              minLength={3}
              maxLength={500}
              rows={3}
              value={notes}
              onChange={(e) => {
                setNotes(e.target.value);
                setError('');
              }}
            />
          </fieldset>
          <div className="customer-form-actions">
            {pending ? (
              <Button type="button" disabled={busy} onClick={() => void run(pending, true)}>
                İşlem sonucunu kontrol et
              </Button>
            ) : (
              <Button type="submit" disabled={busy || refresh || !context || !canOperate()}>
                Doğrula ve yeni takip aç
              </Button>
            )}
            {refresh && (
              <Button
                type="button"
                variant="outline"
                disabled={locked || source.loading}
                onClick={() => {
                  source.reload();
                  setError('');
                  setRefresh(false);
                }}
              >
                Güncel bilgileri yükle
              </Button>
            )}
            <Button
              type="button"
              variant="outline"
              disabled={locked}
              onClick={() => {
                setOpen(false);
                setDue('');
                setNotes('');
                setError('');
                setRefresh(false);
                requestAnimationFrame(() => trigger.current?.focus());
              }}
            >
              Vazgeç
            </Button>
          </div>
        </form>
      )}
      {reauth && (
        <ReauthForm
          inline
          onSuccess={() => {
            setReauth(null);
            void run(reauth, !!pending);
          }}
          onCancel={() => setReauth(null)}
        />
      )}
      {busy && <p role="status">Düzeltme kontrol ediliyor…</p>}
      {(error || (open && source.error)) && (
        <p ref={alert} tabIndex={-1} role="alert" className="customer-error">
          {error || source.error?.message}
        </p>
      )}
    </section>
  );
}
